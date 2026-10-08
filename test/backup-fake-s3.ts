import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// An in-memory S3 for the backup tests: path-style PUT, GET, HEAD, DELETE and ListObjectsV2 on a local port. It
// refuses every request whose SigV4 signature it cannot recompute with its own, deliberately separate, small verifier
// (written byte by byte instead of with the helpers of server/backup.mjs), so a signing bug fails loudly here.

export type Stored = { body: Buffer; lastModified: number };
export type Rule = { method?: string; key?: RegExp; status?: number; times: number; hang?: boolean; destroy?: boolean; skip?: number };
export type FakeS3 = {
  url: string;
  bucket: string;
  objects: Map<string, Stored>;
  log: { method: string; key: string }[];
  rules: Rule[];
  badSignatures: string[];
  count: (method: string, key?: RegExp) => number;
  keys: (re?: RegExp) => string[];
  put: (key: string, body: Buffer) => void;
  close: () => Promise<void>;
};

const unreserved = /[A-Za-z0-9\-_.~]/;

function encodeStrict(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const c = String.fromCharCode(byte);
    out += byte < 128 && unreserved.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const hmac = (key: string | Buffer, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

export type Credentials = { accessKey: string; secretKey: string; region: string; bucket: string };

/** Why a request's signature is wrong, or null when it is right. */
export function verifySignature(req: http.IncomingMessage, body: Buffer, creds: Credentials): string | null {
  const auth = String(req.headers.authorization ?? '');
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return 'no AWS4-HMAC-SHA256 authorization';
  const [, accessKey, day, region, signedHeaders, signature] = m;
  if (accessKey !== creds.accessKey) return 'unknown access key';
  if (region !== creds.region) return 'wrong region';
  const date = String(req.headers['x-amz-date'] ?? '');
  if (!/^\d{8}T\d{6}Z$/.test(date) || !date.startsWith(day)) return 'bad x-amz-date';
  const declared = String(req.headers['x-amz-content-sha256'] ?? '');
  if (!/^[0-9a-f]{64}$/.test(declared)) return 'the payload is not signed (x-amz-content-sha256)';
  if (declared !== sha(body)) return 'x-amz-content-sha256 does not match the body';
  const names = signedHeaders.split(';');
  for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) if (!names.includes(required)) return `${required} is not signed`;

  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const rawPath = q === -1 ? raw : raw.slice(0, q);
  const rawQuery = q === -1 ? '' : raw.slice(q + 1);
  const path = rawPath.split('/').map((seg) => encodeStrict(decodeURIComponent(seg))).join('/');
  const query = rawQuery === '' ? [] : rawQuery.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const name = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const value = decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1));
    return [encodeStrict(name), encodeStrict(value)];
  }).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonical = [
    req.method,
    path,
    query.map(([n, v]) => `${n}=${v}`).join('&'),
    names.map((n) => `${n}:${String(req.headers[n] ?? '').trim()}\n`).join(''),
    signedHeaders,
    declared,
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  let k = hmac(`AWS4${creds.secretKey}`, day);
  for (const part of [region, 's3', 'aws4_request']) k = hmac(k, part);
  const expected = hmac(k, ['AWS4-HMAC-SHA256', date, scope, sha(canonical)].join('\n')).toString('hex');
  return expected === signature ? null : 'signature mismatch';
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const errorXml = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>fake</Message><RequestId>1</RequestId></Error>`;

export async function startFakeS3(options: { creds: Credentials; clock?: () => number; pageSize?: number }): Promise<FakeS3> {
  const { creds, clock = Date.now, pageSize = 1000 } = options;
  const objects = new Map<string, Stored>();
  const log: { method: string; key: string }[] = [];
  const rules: Rule[] = [];
  const badSignatures: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status: number, payload: string | Buffer = '', headers: Record<string, string | number> = {}) => {
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        res.writeHead(status, { 'content-length': data.length, ...headers });
        res.end(req.method === 'HEAD' ? undefined : data);
      };
      try {
        const bad = verifySignature(req, body, creds);
        if (bad) {
          badSignatures.push(bad);
          return send(403, errorXml('SignatureDoesNotMatch'));
        }
        const url = new URL(req.url ?? '/', 'http://x');
        const parts = decodeURIComponent(url.pathname).split('/');
        if (parts[1] !== creds.bucket) return send(404, errorXml('NoSuchBucket'));
        const key = parts.slice(2).join('/');
        const method = String(req.method);
        log.push({ method, key });

        for (const rule of rules) {
          if (rule.times <= 0) continue;
          if (rule.method && rule.method !== method) continue;
          if (rule.key && !rule.key.test(key)) continue;
          if (rule.skip && rule.skip > 0) {
            rule.skip--;
            continue;
          }
          rule.times--;
          if (rule.destroy) return req.socket.destroy();
          if (rule.hang) return;
          return send(rule.status ?? 500, errorXml(rule.status === 403 ? 'AccessDenied' : 'InternalError'));
        }

        if (method === 'PUT') {
          objects.set(key, { body, lastModified: clock() });
          return send(200, '', { etag: `"${sha(body).slice(0, 32)}"` });
        }
        if (method === 'DELETE') {
          objects.delete(key);
          return send(204);
        }
        if (method === 'GET' && key === '' && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const after = url.searchParams.get('continuation-token');
          const startAfter = after ? Buffer.from(after, 'base64').toString('utf8') : '';
          const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > startAfter).sort();
          const page = all.slice(0, pageSize);
          const truncated = all.length > page.length;
          const items = page.map((k) => {
            const o = objects.get(k)!;
            return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>&quot;x&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
          });
          const next = truncated ? `<NextContinuationToken>${Buffer.from(page[page.length - 1]).toString('base64')}</NextContinuationToken>` : '';
          return send(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${creds.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${items.join('')}${next}</ListBucketResult>`, { 'content-type': 'application/xml' });
        }
        if (method === 'GET' || method === 'HEAD') {
          const o = objects.get(key);
          if (!o) return send(404, method === 'GET' ? errorXml('NoSuchKey') : '');
          return method === 'HEAD'
            ? (res.writeHead(200, { 'content-length': o.body.length }), res.end())
            : send(200, o.body, { 'content-type': 'application/octet-stream' });
        }
        return send(405, errorXml('MethodNotAllowed'));
      } catch {
        send(500, errorXml('InternalError'));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    bucket: creds.bucket,
    objects,
    log,
    rules,
    badSignatures,
    count: (method, key) => log.filter((l) => l.method === method && (!key || key.test(l.key))).length,
    keys: (re) => [...objects.keys()].filter((k) => !re || re.test(k)).sort(),
    put: (key, body) => void objects.set(key, { body, lastModified: clock() }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
