import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';
import { createOpenRun } from '../server/ai/run.mjs';
import { KEY, canary, deferred, fenced, parseEvents, sticky, until, type Script } from './ai-run-harness';

// docs/ai.md, "Where calls run" and "Limits": POST /api/ai/run in open mode. No accounts: the operator's key pays
// (TABULA_AI_API_KEY with TABULA_AI_OPEN=1), runs are counted per client address, and one global count stands for the
// workspace. A fake provider takes the place of the network.

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => (s.closeAllConnections(), s.close(r)))));
});

function world(env: Record<string, string> = { TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1' }, options: { timeoutMs?: number } = {}) {
  const config = loadConfig({ ...env }, () => {});
  const docs = new Map<string, Y.Doc>([['board1', new Y.Doc()]]);
  const state: { script: Script | null; answer: unknown } = { script: null, answer: { objects: [{ text: 'A risk' }] } };
  const calls: any[] = [];
  const made: { kind: string; apiKey: string }[] = [];
  const lines: unknown[][] = [];
  const open = createOpenRun({
    config,
    canWriteRoom: (role: string, kind: string) => kind === 'board' && role === 'owner',
    readRoom: (name: string, fn: (doc: Y.Doc) => unknown) => fn(docs.get(name) ?? new Y.Doc()),
    roomExists: (name: string) => docs.has(name),
    createProvider: ({ kind, apiKey }: { kind: string; apiKey: string }) => {
      made.push({ kind, apiKey });
      return {
        run: (req: any) => {
          calls.push(req);
          if (state.script) return state.script(req);
          return (async function* () {
            yield { type: 'progress' };
            yield { type: 'result', value: state.answer, usage: { model: req.model, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
          })();
        },
      };
    },
    log: (...args: unknown[]) => lines.push(args),
    timeoutMs: options.timeoutMs,
  });
  return { config, docs, state, calls, made, lines, open };
}

async function serve(w: ReturnType<typeof world>, trustProxy = true) {
  (w.config as any).trustProxy = trustProxy;
  const server = http.createServer((req, res) => {
    void w.open.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => {
    const res = await fetch(`${base}/api/ai/run`, {
      method: 'POST',
      headers: { 'x-tabula': '1', 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    const stream = (res.headers.get('content-type') ?? '').startsWith('text/event-stream');
    return { status: res.status, headers: res.headers, text, json: stream || !text ? undefined : JSON.parse(text), events: stream ? parseEvents(text) : [] };
  };
}

const generate = (extra: Record<string, unknown> = {}) => ({ feature: 'generate', boardId: 'board1', input: { prompt: 'ten risks' }, ...extra });
const ip = (n: number) => ({ 'x-forwarded-for': `203.0.113.${n}` });

describe('when AI is off', () => {
  it.each([
    ['no key and no switch', { }],
    ['a key without TABULA_AI_OPEN=1', { TABULA_AI_API_KEY: KEY }],
    ['the switch without a key', { TABULA_AI_OPEN: '1' }],
    ['TABULA_AI_OPEN=0', { TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '0' }],
  ])('answers 403 ai_disabled with %s, and calls nothing', async (_name, env) => {
    const w = world(env);
    const post = await serve(w);
    const res = await post(generate());
    expect([res.status, res.json.error]).toEqual([403, 'ai_disabled']);
    expect(w.calls).toHaveLength(0);
    expect(w.made).toHaveLength(0);
  });
});

describe('when AI is on', () => {
  it('needs the CSRF header', async () => {
    const w = world();
    const post = await serve(w);
    const res = await post(generate(), { 'x-tabula': '0' });
    expect([res.status, res.json.error]).toEqual([403, 'csrf']);
    expect(w.calls).toHaveLength(0);
  });

  it('streams a result, with the operator key and the configured model, and logs one line with no text', async () => {
    const w = world({ TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1', TABULA_AI_MODEL: 'claude-haiku-5-5' });
    const post = await serve(w);
    const note = canary('note');
    const prompt = canary('prompt');
    sticky(w.docs.get('board1')!, 'a', note);
    w.state.answer = { objects: [{ text: 'idea one', color: 'Pink' }] };
    const res = await post({ feature: 'generate', boardId: 'board1', input: { prompt } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.events.at(-1)).toEqual({
      event: 'result',
      data: {
        proposal: { kind: 'create', objects: [{ text: 'idea one', color: 'Pink' }] },
        cut: false,
        usage: { model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    expect(w.made).toEqual([{ kind: 'anthropic', apiKey: KEY }]);
    expect(w.calls[0].model).toBe('claude-haiku-5-5');
    expect(w.calls[0].content).toContain(note);
    expect(w.calls[0].content).toContain(prompt);
    expect(w.lines).toHaveLength(1);
    expect(String(w.lines[0][0])).toMatch(/^ai\.generate \{.*"keySource":"workspace".*"outcome":"ok"/);
    const logged = JSON.stringify(w.lines);
    for (const secret of [note, prompt, KEY, 'idea one']) expect(logged).not.toContain(secret);
    expect(JSON.stringify(res.headers)).not.toContain(KEY);
  });

  it('refuses a board that does not exist, a body that is not valid, and a body that is too large', async () => {
    const w = world();
    const post = await serve(w);
    expect((await post(generate({ boardId: 'nosuchboard' }))).json.error).toBe('not_found');
    expect((await post('{nope')).json.error).toBe('bad_request');
    expect((await post({ feature: 'generate', boardId: 'board1', input: {} })).json.error).toBe('bad_request');
    expect((await post({ feature: 'cluster', boardId: 'board1', input: { selection: ['a'] } })).json.error).toBe('bad_request');
    expect((await post({ feature: 'generate', boardId: 'a/b', input: { prompt: 'x' } })).json.error).toBe('bad_request');
    const big = await post(JSON.stringify({ feature: 'generate', boardId: 'board1', input: { prompt: 'x'.repeat(100_000) } }));
    expect(big.status).toBe(413);
    expect(w.calls).toHaveLength(0);
  });

  it('withholds private notes and fences the board, as in accounts mode', async () => {
    const w = world();
    const post = await serve(w);
    const doc = w.docs.get('board1')!;
    const secret = canary('private');
    sticky(doc, 'a', 'public');
    sticky(doc, 'p', secret, { privateStep: 's' });
    await post({ feature: 'summarise', boardId: 'board1', input: {} });
    expect(JSON.stringify(w.calls[0])).not.toContain(secret);
    expect(fenced(w.calls[0].content).payload.objects.map((o: any) => o.id)).toEqual(['a']);
  });

  it('counts runs per client address, 20 an hour, and says when to come back', async () => {
    const w = world();
    const post = await serve(w);
    for (let i = 0; i < 20; i++) expect((await post(generate(), ip(1))).status).toBe(200);
    const limited = await post(generate(), ip(1));
    expect([limited.status, limited.json.error]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3500);
    expect((await post(generate(), ip(2))).status).toBe(200);
  });

  it('keeps one global count for the whole instance, 200 an hour', async () => {
    const w = world();
    const post = await serve(w);
    for (let n = 1; n <= 10; n++) {
      for (let i = 0; i < 20; i++) expect((await post(generate(), ip(n))).status).toBe(200);
    }
    const limited = await post(generate(), ip(99));
    expect([limited.status, limited.json.error]).toEqual([429, 'rate_limited']);
    expect(limited.json.message).toContain('200');
  });

  it('allows one run at a time per address and one on the operator key', async () => {
    const w = world();
    const post = await serve(w);
    const started = deferred();
    const release = deferred();
    w.state.script = async function* () {
      started.resolve();
      await release.promise;
      yield { type: 'result', value: { objects: [{ text: 'held' }] }, usage: {} };
    };
    const first = post(generate(), ip(1));
    await started.promise;
    const sameAddress = await post(generate(), ip(1));
    expect([sameAddress.status, sameAddress.json.error]).toEqual([429, 'rate_limited']);
    expect(sameAddress.json.message).toContain('in progress');
    const otherAddress = await post(generate(), ip(2));
    expect([otherAddress.status, otherAddress.json.error]).toEqual([429, 'rate_limited']);
    expect(otherAddress.json.message).toContain('key is busy');
    release.resolve();
    expect((await first).events.at(-1)!.event).toBe('result');
    w.state.script = null;
    expect((await post(generate(), ip(2))).status).toBe(200);
  });

  it('uses the socket address when the relay is not behind a proxy, so a header cannot buy a fresh allowance', async () => {
    const w = world();
    const post = await serve(w, false);
    for (let i = 0; i < 20; i++) expect((await post(generate(), ip(i + 1))).status).toBe(200);
    expect((await post(generate(), ip(77))).status).toBe(429);
  });

  it('aborts the provider call when the client closes the request, and stops one that takes too long', async () => {
    const w = world(undefined, { timeoutMs: 80 });
    const post = await serve(w);
    const seen: { signal?: AbortSignal } = {};
    w.state.script = async function* (req) {
      seen.signal = req.signal;
      yield { type: 'progress' };
      await new Promise(() => {});
    };
    const controller = new AbortController();
    const pending = post(generate(), ip(1), controller.signal).catch(() => null);
    await until(() => seen.signal !== undefined);
    controller.abort();
    await pending;
    await until(() => seen.signal!.aborted);
    expect((seen.signal!.reason as any).code).toBe('ai_aborted');
    await until(() => w.lines.length === 1);
    expect(String(w.lines[0][0])).toContain('"outcome":"ai_aborted"');

    const slow = await post(generate(), ip(2));
    expect(slow.events.at(-1)).toEqual({ event: 'error', data: { error: 'ai_timeout', message: 'The AI took too long and was stopped. Nothing was changed.' } });
    expect(w.lines).toHaveLength(2);
  });

  it('answers a refusal from the provider with an ai_refused event', async () => {
    const w = world();
    const post = await serve(w);
    w.state.script = async function* () {
      yield { type: 'refused', category: 'policy' };
    };
    const res = await post(generate());
    expect(res.events.at(-1)).toEqual({ event: 'error', data: { error: 'ai_refused', message: 'The AI declined this request. Nothing was changed.' } });
  });
});
