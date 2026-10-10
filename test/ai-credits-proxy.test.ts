import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY, closeWorlds, newKey, setup, type World } from './ai-run-harness';

const HOSTED = {
  TABULA_CLOUD_TOKEN: 'c'.repeat(32),
  TABULA_CLOUD_URL: 'https://cloud.example.test',
  TABULA_CLOUD_WORKSPACE_ID: 'workspace-1',
  TABULA_AI_MODEL: 'claude-haiku-5-5',
};
const PROXY_TOKEN = 'proxy-token-canary-which-must-not-escape';
const upstreams: http.Server[] = [];

type ProxyReply = { status: 429 | 403 | 400 | 413 | 503; code: string; message: string } | { status: 200 };

async function startUpstream(reply: () => ProxyReply = () => ({ status: 200 })) {
  const requests: { path: string; apiKey: string | undefined; body: any }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const header = req.headers['x-api-key'];
      requests.push({ path: req.url ?? '', apiKey: Array.isArray(header) ? header[0] : header, body: raw ? JSON.parse(raw) : null });
      const answer = reply();
      if (answer.status !== 200) {
        res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.code === 'rate_limited' ? { 'retry-after': '17' } : {}) });
        res.end(JSON.stringify({ type: 'error', error: { type: answer.code, message: answer.message } }));
        return;
      }
      const events = [
        { type: 'message_start', message: { id: 'msg_proxy', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify({ objects: [{ text: 'Created through credits' }] }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 21 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  upstreams.push(server);
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/ai/v1/workspace-1`;
  return { url, requests };
}

afterEach(async () => {
  await closeWorlds();
  for (const server of upstreams.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const proxyEnv = (url: string) => ({ ...HOSTED, TABULA_AI_PROXY_URL: url, TABULA_AI_PROXY_TOKEN: PROXY_TOKEN });

async function keylessWorld(options: { env?: Record<string, string>; aiCredits?: boolean; useRealProvider?: boolean } = {}) {
  const w = await setup({ env: options.env ?? HOSTED, aiCredits: options.aiCredits ?? true, useRealProvider: options.useRealProvider });
  w.directory.setSetting('ai.enabled', '1');
  const owner = w.person('owner');
  const boardId = w.board(owner);
  return { w, owner, boardId };
}

async function run(w: World, owner: ReturnType<World['person']>, boardId: string, extra: Record<string, unknown> = {}) {
  return w.run(owner, { feature: 'generate', boardId, input: { prompt: 'make one note' }, ...extra });
}

describe('the hosted AI credits proxy', () => {
  it('uses the configured Anthropic proxy when no key is saved and the workspace has credits', async () => {
    const upstream = await startUpstream();
    const { w, owner, boardId } = await keylessWorld({ env: proxyEnv(upstream.url), aiCredits: true, useRealProvider: true });

    const res = await run(w, owner, boardId);
    expect(res.status).toBe(200);
    expect(res.events.find((event) => event.event === 'result')?.data.proposal.objects).toEqual([{ text: 'Created through credits' }]);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      path: '/ai/v1/workspace-1/v1/messages',
      apiKey: PROXY_TOKEN,
      body: { model: 'claude-haiku-5-5', stream: true },
    });
    expect(w.audits()[0].detail.keySource).toBe('credits');

    const config = await w.call(owner, 'GET', '/api/ai/config');
    const admin = await w.call(owner, 'GET', '/api/admin/ai');
    expect(config.body).toMatchObject({ credits: true, keySource: null });
    expect(admin.body.creditsActive).toBe(true);
    expect(JSON.stringify([w.config, res.text, config.body, admin.body, w.audits(), w.logged])).not.toContain(PROXY_TOKEN);
  });

  it('uses the workspace key ahead of credits and makes no proxy call', async () => {
    const upstream = await startUpstream();
    const { w, owner, boardId } = await keylessWorld({ env: proxyEnv(upstream.url), aiCredits: true });
    w.enable();

    const res = await run(w, owner, boardId);
    expect(res.status).toBe(200);
    expect(w.made.at(-1)).toEqual({ kind: 'anthropic', apiKey: KEY });
    expect(upstream.requests).toHaveLength(0);
    expect(w.audits()[0].detail.keySource).toBe('workspace');
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body.creditsActive).toBe(false);
  });

  it('uses an allowed personal key ahead of credits', async () => {
    const upstream = await startUpstream();
    const { w, owner, boardId } = await keylessWorld({ env: proxyEnv(upstream.url), aiCredits: true });
    const personalKey = newKey();
    w.directory.setSetting('ai.personalKeys', '1');
    w.directory.saveAiKey({ ring: w.ring, scope: 'user', userId: owner.user.id, provider: 'anthropic', apiKey: personalKey });

    const res = await run(w, owner, boardId);
    expect(res.status).toBe(200);
    expect(w.made.at(-1)).toEqual({ kind: 'anthropic', apiKey: personalKey });
    expect(upstream.requests).toHaveLength(0);
    expect(w.audits()[0].detail.keySource).toBe('user');
  });

  it('returns ai_no_key without entitlement, even when the proxy is configured', async () => {
    const upstream = await startUpstream();
    const { w, owner, boardId } = await keylessWorld({ env: proxyEnv(upstream.url), aiCredits: false });
    const res = await run(w, owner, boardId);
    expect([res.status, res.json.error]).toEqual([409, 'ai_no_key']);
    expect(upstream.requests).toHaveLength(0);
    expect(w.made).toHaveLength(0);
  });

  it('returns ai_no_key when credits are advertised but the proxy is not configured', async () => {
    const { w, owner, boardId } = await keylessWorld({ env: HOSTED, aiCredits: true });
    const res = await run(w, owner, boardId);
    expect([res.status, res.json.error]).toEqual([409, 'ai_no_key']);
    expect((await w.call(owner, 'GET', '/api/ai/config')).body.credits).toBe(true);
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body.creditsActive).toBe(false);
    expect(w.made).toHaveLength(0);
  });

  it('refuses a private run on credits before creating a provider', async () => {
    const upstream = await startUpstream();
    const { w, owner, boardId } = await keylessWorld({ env: proxyEnv(upstream.url), aiCredits: true });
    const res = await run(w, owner, boardId, { private: true });
    expect([res.status, res.json.error]).toEqual([400, 'bad_request']);
    expect(upstream.requests).toHaveLength(0);
    expect(w.made).toHaveLength(0);
  });

  it.each([
    ['credits_exhausted', 429],
    ['credits_not_included', 403],
    ['rate_limited', 429],
    ['model_not_allowed', 400],
    ['max_tokens_too_large', 400],
    ['request_too_large', 413],
    ['ai_unavailable', 503],
  ] as const)('passes the %s message and status through without the proxy token', async (code, status) => {
    const message = `Proxy says ${code} and names the safe reset guidance.`;
    const upstream = await startUpstream(() => ({ status, code, message }));
    const { w, owner, boardId } = await keylessWorld({ env: proxyEnv(upstream.url), aiCredits: true, useRealProvider: true });

    const res = await run(w, owner, boardId);
    expect([res.status, res.json.error, res.json.message]).toEqual([status, code, message]);
    expect(upstream.requests).toHaveLength(1);
    expect(res.headers.get('retry-after')).toBe(code === 'rate_limited' ? '17' : null);
    expect(w.audits()).toHaveLength(1);
    expect(w.audits()[0].detail).toMatchObject({ keySource: 'credits', outcome: code });
    expect(JSON.stringify([res.json, w.audits(), w.logged])).not.toContain(PROXY_TOKEN);
  });
});
