import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type ControlPlaneSeen = { method: string; url: string; authorization: string | undefined; body: string };

/** Shared relay-test fake for the hosted instance calls, including tracker key floors. */
export function createFakeCloudControlPlane(portalUrl = 'https://billing.example.com/p/abc') {
  const seen: ControlPlaneSeen[] = [];
  const floors = new Map<string, { scope: string; prefix: string; floor: number }>();
  let reply: { status: number; body: unknown } = { status: 200, body: { url: portalUrl } };
  let server: http.Server | null = null;
  let url = '';

  const start = async () => {
    if (server) return url;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: text });
        let body: any = {};
        try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
        let response = reply;
        if ((req.url ?? '').endsWith('/key-floor/read')) {
          response = { status: 200, body: { counters: [...floors.values()] } };
        } else if ((req.url ?? '').endsWith('/key-floor')) {
          for (const counter of Array.isArray(body?.counters) ? body.counters : []) {
            if (!counter || typeof counter.scope !== 'string' || typeof counter.prefix !== 'string' || !Number.isSafeInteger(counter.floor) || counter.floor <= 0) continue;
            const key = JSON.stringify([counter.scope, counter.prefix]);
            const prior = floors.get(key);
            floors.set(key, { scope: counter.scope, prefix: counter.prefix, floor: Math.max(prior?.floor ?? 0, counter.floor) });
          }
          response = { status: 200, body: { ok: true } };
        }
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response.body));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return url;
  };

  const close = async () => {
    const current = server;
    if (!current) return;
    server = null;
    await new Promise<void>((resolve) => current.close(() => resolve()));
  };

  return {
    seen,
    start,
    close,
    get url() { return url; },
    setReply(value: { status: number; body: unknown }) { reply = value; },
    reset() {
      seen.length = 0;
      floors.clear();
      reply = { status: 200, body: { url: portalUrl } };
    },
    portalCalls() { return seen.filter((call) => call.url.endsWith('/portal')); },
  };
}
