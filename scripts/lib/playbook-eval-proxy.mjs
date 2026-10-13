// Recording proxy for the playbook evaluation (TAB-171, scripts/playbook-eval.mjs). It sits between the throwaway relay and the
// model API. The relay sends a local token where the provider key goes; the proxy checks that token, swaps in the real key and
// forwards the request. Every request body and response is kept IN MEMORY in this process, so no prompt, board text or model
// output reaches disk or a report. The runner reads them only through recordedSince(), to grade one run, and never prints them.
// Loopback only: the listener is on 127.0.0.1.
import http from 'node:http';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FORWARD_TIMEOUT_MS = 170_000;
// hop-by-hop headers, the host, and the length and encoding fetch decides for itself once it has decoded the body
const DROP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length', 'content-encoding', 'accept-encoding',
]);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The text the model wrote in one recorded response, read the way the provider kind sends it. Anthropic streams text deltas as
 * server-sent events (or answers with one JSON message); an OpenAI-compatible server answers with one JSON envelope.
 * @param {'anthropic' | 'openai-compatible'} kind
 * @param {string} responseText
 * @param {string} [contentType]
 * @returns {string}
 */
export function assistantText(kind, responseText, contentType = '') {
  if (kind === 'anthropic') {
    if (/event-stream/i.test(contentType)) {
      return responseText
        .split(/\r?\n\r?\n/)
        .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => parseJson(line.slice(5).trim())))
        .filter((event) => event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string')
        .map((event) => event.delta.text)
        .join('');
    }
    const message = parseJson(responseText);
    return Array.isArray(message?.content) ? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('') : '';
  }
  const content = parseJson(responseText)?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Starts the recording proxy. `authName` is the lower-case header the relay sends its key in (x-api-key or authorization);
 * `localAuth` is the value the relay sends, and a request without it is refused and not forwarded; `authValue` is the real
 * header value sent upstream. The returned object has no field that holds the recorded bodies: they are reached only through
 * recordedSince(), which the runner calls to grade one run.
 * @param {{ upstream: string, kind: 'anthropic' | 'openai-compatible', authName: string, authValue: string, localAuth: string }} options
 */
export async function startRecordingProxy({ upstream, kind, authName, authValue, localAuth }) {
  // one entry per forwarded request, kept in this closure only
  const records = [];
  const base = upstream.replace(/\/+$/, '');

  const server = http.createServer(async (request, response) => {
    let body;
    try {
      body = await readBody(request);
    } catch {
      response.writeHead(413, { 'content-type': 'application/json' }).end('{"error":{"message":"request too large"}}');
      return;
    }
    if (request.headers[authName] !== localAuth) {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"local token refused"}}');
      return;
    }

    const target = base + request.url;
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!DROP.has(name) && name !== authName) headers[name] = value;
    }
    headers[authName] = authValue;
    const record = {
      method: request.method ?? '',
      host: new URL(target).hostname.toLowerCase(),
      requestText: body.toString('utf8'),
      status: 0,
      contentType: '',
      responseText: '',
    };
    records.push(record);

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body: body.length > 0 ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
    } catch {
      record.status = 502;
      response.writeHead(502, { 'content-type': 'application/json' }).end('{"error":{"message":"upstream unreachable"}}');
      return;
    }
    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    record.status = upstreamResponse.status;
    record.contentType = upstreamResponse.headers.get('content-type') ?? '';
    record.responseText = buffer.toString('utf8');
    const out = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!DROP.has(name) && name !== 'content-encoding') out[name] = value;
    });
    response.writeHead(upstreamResponse.status, { ...out, 'content-length': buffer.length });
    response.end(buffer);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    /** A position in the record list; pass it to recordedSince() after a run. */
    mark: () => records.length,
    /**
     * What the proxy saw from a position on: the POST bodies sent upstream, the model text of each answer, and the hostnames it
     * contacted. The runner builds one Run record from this and never writes it anywhere.
     */
    recordedSince(mark) {
      const slice = records.slice(mark);
      const posts = slice.filter((record) => record.method === 'POST');
      return {
        requests: posts.map((record) => record.requestText),
        texts: posts.filter((record) => record.status === 200).map((record) => assistantText(kind, record.responseText, record.contentType)),
        hosts: [...new Set(slice.map((record) => record.host))],
      };
    },
    close() {
      records.length = 0;
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
