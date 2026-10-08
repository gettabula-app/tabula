import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { AiError } from '../server/ai/errors.mjs';
import { DEFAULT_MODEL, MODELS, createAnthropicProvider } from '../server/ai/anthropic.mjs';
import { PROVIDERS, createProvider } from '../server/ai/providers.mjs';

// docs/ai.md, "Provider layer" and "Anthropic (v1)". A fake client stands in for the SDK, and a loopback server for the
// wire: no test here leaves the machine or holds a real key.

const KEY = `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;
const SCHEMA = { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' } } }, required: ['texts'], additionalProperties: false };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const request = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  system: 'You write sticky notes.',
  content: 'BOARD TEXT: ten risks',
  schema: SCHEMA,
  effort: 'medium',
  maxTokens: 4000,
  signal: new AbortController().signal,
  ...extra,
});

type Final = Record<string, unknown>;
const message = (extra: Final = {}): Final => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  stop_details: null,
  content: [{ type: 'text', text: JSON.stringify({ texts: ['a', 'b'] }) }],
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  ...extra,
});

/** A client shaped like the SDK's, recording what it was asked and answering with scripted streams. */
function fakeClient(script: { final?: Final; error?: unknown; deltas?: number; hang?: boolean } = {}) {
  const calls: { client: 'plain' | 'beta'; params: any; options: any }[] = [];
  const aborted: number[] = [];
  const lists: { params: any; options: any }[] = [];
  const open = (client: 'plain' | 'beta') => (params: any, options: any) => {
    calls.push({ client, params, options });
    return {
      abort: () => aborted.push(1),
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < (script.deltas ?? 0); i++) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } };
        yield { type: 'message_delta' };
        if (script.hang) await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError())));
        if (script.error) throw script.error;
      },
      finalMessage: async () => {
        if (script.error) throw script.error;
        return script.final ?? message();
      },
    };
  };
  const client = {
    messages: { stream: open('plain') },
    beta: { messages: { stream: open('beta') } },
    models: {
      list: (params: any, options: any) => {
        lists.push({ params, options });
        if (script.hang) return new Promise(() => {});
        return script.error ? Promise.reject(script.error) : Promise.resolve({ data: [] });
      },
    },
  };
  return { client, calls, aborted, lists };
}

async function collect(provider: any, req: any) {
  const events: any[] = [];
  for await (const e of provider.run(req)) events.push(e);
  return events;
}

const failureOf = async (promise: Promise<unknown>): Promise<AiError> => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return err as AiError;
  }
  throw new Error('expected a failure');
};

describe('createProvider', () => {
  it('knows anthropic only, and says so for anything else', () => {
    expect(PROVIDERS).toEqual(['anthropic']);
    expect(() => createProvider({ kind: 'openai-compatible', apiKey: KEY })).toThrow('Unknown AI provider');
    expect(() => createProvider({ kind: '', apiKey: KEY })).toThrow('Unknown AI provider');
    expect(() => createProvider({ kind: 'anthropic', apiKey: '' })).toThrow('needs an API key');
  });

  it('lists the models, the default first', () => {
    const provider = createProvider({ kind: 'anthropic', apiKey: KEY, client: fakeClient().client });
    expect(provider.kind).toBe('anthropic');
    expect(provider.models()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(MODELS[0]).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
  });

  it('accepts only an https base URL without credentials, and never echoes it', () => {
    for (const baseUrl of ['http://example.com', 'ftp://example.com', 'not a url', 'https://user:pw@example.com']) {
      expect(() => createProvider({ kind: 'anthropic', apiKey: KEY, baseUrl })).toThrow(/baseUrl/);
    }
    expect(() => createProvider({ kind: 'anthropic', apiKey: KEY, baseUrl: 'https://llm.example.com' })).not.toThrow();
  });
});

describe('the request', () => {
  it('asks Claude Opus 5.5 for structured output with an explicit effort, a cached system prompt first, and server-side fallbacks', async () => {
    const fake = fakeClient();
    const req = request();
    await collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), req);
    expect(fake.calls).toHaveLength(1);
    const [{ client, params, options }] = fake.calls;
    expect(client).toBe('beta');
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.max_tokens).toBe(4000);
    expect(params.system).toEqual([{ type: 'text', text: 'You write sticky notes.', cache_control: { type: 'ephemeral' } }]);
    expect(params.messages).toEqual([{ role: 'user', content: 'BOARD TEXT: ten risks' }]);
    expect(params.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA }, effort: 'medium' });
    expect(params.betas).toEqual([FALLBACK_BETA]);
    expect(params.fallbacks).toBe('default');
    expect('thinking' in params).toBe(false);
    expect('tools' in params).toBe(false);
    expect('tool_choice' in params).toBe(false);
    expect(options.signal).toBe(req.signal);
  });

  it('opts Claude Sonnet 5.5 into fallbacks the same way', async () => {
    const fake = fakeClient({ final: message({ model: 'claude-sonnet-5-5' }) });
    await collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request({ model: 'claude-sonnet-5-5', effort: 'low' }));
    expect(fake.calls[0].client).toBe('beta');
    expect(fake.calls[0].params).toMatchObject({ model: 'claude-sonnet-5-5', betas: [FALLBACK_BETA], fallbacks: 'default' });
    expect(fake.calls[0].params.output_config.effort).toBe('low');
  });

  it('keeps Claude Haiku 5.5 off the beta client: it has no fallback', async () => {
    const fake = fakeClient({ final: message({ model: 'claude-haiku-5-5' }) });
    await collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request({ model: 'claude-haiku-5-5', effort: 'high' }));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].client).toBe('plain');
    expect('fallbacks' in fake.calls[0].params).toBe(false);
    expect('betas' in fake.calls[0].params).toBe(false);
    expect(fake.calls[0].params.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA }, effort: 'high' });
  });

  it.each([
    ['an unknown model', { model: 'claude-opus-5' }],
    ['a dated model id', { model: 'claude-opus-5-5-20260401' }],
    ['no system prompt', { system: '' }],
    ['a non-string content', { content: { a: 1 } }],
    ['no schema', { schema: null }],
    ['an unknown effort', { effort: 'max' }],
    ['no output budget', { maxTokens: 0 }],
    ['a fractional output budget', { maxTokens: 10.5 }],
    ['an output budget past the cap', { maxTokens: 1_000_000 }],
  ])('refuses %s before any request is made', async (_name, extra) => {
    const fake = fakeClient();
    const failure = await failureOf(collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request(extra)));
    expect(failure.code).toBe('internal');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('the answer', () => {
  it('streams progress, then one result with the usage of the model that answered', async () => {
    const fake = fakeClient({ deltas: 45, final: message({ model: 'claude-opus-4-8' }) });
    const events = await collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request());
    expect(events.map((e) => e.type)).toEqual(['progress', 'progress', 'progress', 'result']);
    expect(events[3]).toEqual({
      type: 'result',
      value: { texts: ['a', 'b'] },
      usage: { model: 'claude-opus-4-8', inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 20 },
    });
  });

  it('counts missing cache figures as zero and falls back to the requested model', async () => {
    const fake = fakeClient({ final: message({ model: undefined, usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: null, cache_creation_input_tokens: null } }) });
    const [result] = await collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request());
    expect(result).toMatchObject({ type: 'result', usage: { model: 'claude-opus-5-5', inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  });

  it('turns a refusal into { type: refused } and reads nothing else of the message', async () => {
    const refused = message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, content: [{ type: 'text', text: 'not json {' }] });
    const events = await collect(createAnthropicProvider({ apiKey: KEY, client: fakeClient({ final: refused }).client }), request());
    expect(events).toEqual([{ type: 'refused', category: 'cyber' }]);
    const bare = message({ stop_reason: 'refusal', stop_details: null, content: [] });
    expect(await collect(createAnthropicProvider({ apiKey: KEY, client: fakeClient({ final: bare }).client }), request())).toEqual([{ type: 'refused', category: null }]);
  });

  it.each([
    ['an answer cut off at the output limit', message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"texts": ["a"' }] })],
    ['text that is not JSON', message({ content: [{ type: 'text', text: 'Sure! Here are ten risks' }] })],
    ['no text at all', message({ content: [] })],
  ])('reports %s as an internal error without quoting it', async (_name, final) => {
    const failure = await failureOf(collect(createAnthropicProvider({ apiKey: KEY, client: fakeClient({ final }).client }), request()));
    expect(failure.code).toBe('internal');
    expect(failure.message).not.toContain('Sure');
    expect(failure.message).not.toContain('texts');
  });
});

describe('errors', () => {
  const headers = () => new Headers({ 'x-api-key': KEY, authorization: `Bearer ${KEY}`, 'retry-after': '7' });
  const sdkError = (status: number, text = `request failed with ${KEY} for BOARD TEXT`) =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: text } }, text, headers());

  it.each([
    ['a bad key', sdkError(401), 'ai_key_invalid', 400],
    ['a key without permission', sdkError(403), 'ai_key_invalid', 400],
    ['a rate limit', sdkError(429), 'ai_rate_limited', 429],
    ['an overloaded provider', sdkError(529), 'ai_unavailable', 502],
    ['a server error', sdkError(500), 'ai_unavailable', 502],
    ['a gateway error', sdkError(503), 'ai_unavailable', 502],
    ['a request timeout', sdkError(408), 'ai_unavailable', 502],
    ['a timeout', new Anthropic.APIConnectionTimeoutError(), 'ai_unavailable', 502],
    ['a dropped connection', new Anthropic.APIConnectionError({ message: `fetch failed ${KEY}`, cause: new Error(KEY) }), 'ai_unavailable', 502],
    ['a rejected request', sdkError(400), 'internal', 500],
    ['an unknown model', sdkError(404), 'internal', 500],
    ['anything else', new TypeError(`boom ${KEY}`), 'internal', 500],
  ])('maps %s to a fresh error that holds no key, header or board text', async (_name, thrown, code, status) => {
    for (const fake of [fakeClient({ error: thrown }), fakeClient({ error: thrown, deltas: 3 })]) {
      const failure = await failureOf(collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request()));
      expect(failure).not.toBe(thrown);
      expect(failure.code).toBe(code);
      expect(failure.status).toBe(status);
      const everything = [failure.message, failure.stack, JSON.stringify(failure), String(failure.cause), Object.getOwnPropertyNames(failure).join()].join('\n');
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain('sk-ant');
      expect(everything).not.toContain('BOARD TEXT');
      expect(Object.getOwnPropertyNames(failure)).not.toContain('headers');
      expect(failure.cause).toBeUndefined();
    }
  });

  it('carries the retry-after of a rate limit, in whole seconds and capped', async () => {
    const limited = (value: string) => Anthropic.APIError.generate(429, {}, 'slow down', new Headers({ 'retry-after': value }));
    const retryAfter = async (value: string) =>
      (await failureOf(collect(createAnthropicProvider({ apiKey: KEY, client: fakeClient({ error: limited(value) }).client }), request()))).retryAfter;
    expect(await retryAfter('7')).toBe(7);
    expect(await retryAfter('1.2')).toBe(2);
    expect(await retryAfter('999999')).toBe(3600);
    expect(await retryAfter('tomorrow')).toBeNull();
    expect(await retryAfter('0')).toBeNull();
  });

  it('keeps an error that is already an AiError', async () => {
    const own = new AiError('ai_unconfigured');
    const failure = await failureOf(collect(createAnthropicProvider({ apiKey: KEY, client: fakeClient({ error: own }).client }), request()));
    expect(failure).toBe(own);
  });
});

describe('abort', () => {
  it('does not start when the signal is already aborted', async () => {
    const fake = fakeClient();
    const ctl = new AbortController();
    ctl.abort();
    const failure = await failureOf(collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request({ signal: ctl.signal })));
    expect(failure.code).toBe('ai_aborted');
    expect(fake.calls).toHaveLength(0);
  });

  it('passes the signal on and reports an abort in flight as ai_aborted', async () => {
    const fake = fakeClient({ hang: true });
    const ctl = new AbortController();
    const running = collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request({ signal: ctl.signal }));
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    const failure = await failureOf(running);
    expect(failure.code).toBe('ai_aborted');
    expect(fake.calls[0].options.signal).toBe(ctl.signal);
  });

  it('stops the stream when the caller stops listening', async () => {
    const fake = fakeClient({ deltas: 100 });
    const run = createAnthropicProvider({ apiKey: KEY, client: fake.client }).run(request());
    expect((await run.next()).value).toEqual({ type: 'progress' });
    await run.return(undefined);
    expect(fake.aborted).toHaveLength(1);
  });

  it('does not abort a stream that finished', async () => {
    const fake = fakeClient();
    await collect(createAnthropicProvider({ apiKey: KEY, client: fake.client }), request());
    expect(fake.aborted).toHaveLength(0);
  });
});

describe('verify', () => {
  it('lists one model with a short timeout and no retries', async () => {
    const fake = fakeClient();
    await createAnthropicProvider({ apiKey: KEY, client: fake.client }).verify();
    expect(fake.lists).toHaveLength(1);
    expect(fake.lists[0].params).toEqual({ limit: 1 });
    expect(fake.lists[0].options).toMatchObject({ timeout: 5000, maxRetries: 0 });
    expect(fake.lists[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a rejected key and the other failures like a run does', async () => {
    const reject = async (error: unknown) => failureOf(createAnthropicProvider({ apiKey: KEY, client: fakeClient({ error }).client }).verify());
    expect((await reject(Anthropic.APIError.generate(401, {}, `bad ${KEY}`, new Headers({ 'x-api-key': KEY })))).code).toBe('ai_key_invalid');
    expect((await reject(Anthropic.APIError.generate(429, {}, 'slow', new Headers({ 'retry-after': '3' })))).retryAfter).toBe(3);
    expect((await reject(new Anthropic.APIConnectionError({ message: 'down' }))).code).toBe('ai_unavailable');
    const odd = await reject(new Error(KEY));
    expect(odd.code).toBe('internal');
    expect(odd.message).not.toContain(KEY);
  });

  it('gives up after the timeout even when the client ignores its signal', async () => {
    const fake = fakeClient({ hang: true });
    const started = Date.now();
    const failure = await failureOf(createAnthropicProvider({ apiKey: KEY, client: fake.client, verifyTimeoutMs: 30 }).verify());
    expect(failure.code).toBe('ai_unavailable');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops when the caller aborts', async () => {
    const ctl = new AbortController();
    const waiting = failureOf(createAnthropicProvider({ apiKey: KEY, client: fakeClient({ hang: true }).client, verifyTimeoutMs: 5000 }).verify(ctl.signal));
    setTimeout(() => ctl.abort(), 10);
    expect((await waiting).code).toBe('ai_aborted');
  });
});

// The real SDK against a loopback server: the stream and the error classes behave as the fake assumes.
describe('with the real SDK on a loopback server', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  });

  type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: any };
  async function serve(respond: (seen: Seen, res: http.ServerResponse) => void) {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const entry = { method: String(req.method), url: String(req.url), headers: req.headers, body: text ? JSON.parse(text) : null };
        seen.push(entry);
        respond(entry, res);
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  const sse = (res: http.ServerResponse, events: [string, unknown][]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  };

  const answer = (model: string, text: string, stop = 'end_turn', details: unknown = null): [string, unknown][] => [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_details: null, usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_details: details, stop_sequence: null }, usage: { output_tokens: 22 } }],
    ['message_stop', { type: 'message_stop' }],
  ];

  it('streams a Claude Opus 5.5 answer through the beta endpoint with the fallback header and the key', async () => {
    const { seen, baseUrl } = await serve((_seen, res) => sse(res, answer('claude-opus-4-8', JSON.stringify({ texts: ['x'] }))));
    const provider = createAnthropicProvider({ apiKey: KEY, baseUrl });
    const events = await collect(provider, request());
    expect(events.at(-1)).toEqual({
      type: 'result',
      value: { texts: ['x'] },
      usage: { model: 'claude-opus-4-8', inputTokens: 40, outputTokens: 22, cacheReadTokens: 10, cacheWriteTokens: 5 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toContain('/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe(KEY);
    expect(String(seen[0].headers['anthropic-beta'])).toContain(FALLBACK_BETA);
    expect(seen[0].body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      fallbacks: 'default',
      system: [{ type: 'text', text: 'You write sticky notes.', cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'medium' },
    });
  });

  it('sends Claude Haiku 5.5 without the beta header or fallbacks', async () => {
    const { seen, baseUrl } = await serve((_seen, res) => sse(res, answer('claude-haiku-5-5', JSON.stringify({ texts: [] }))));
    await collect(createAnthropicProvider({ apiKey: KEY, baseUrl }), request({ model: 'claude-haiku-5-5' }));
    expect(String(seen[0].headers['anthropic-beta'] ?? '')).not.toContain('server-side-fallback');
    expect('fallbacks' in seen[0].body).toBe(false);
  });

  it('reads a refusal from the stop reason', async () => {
    const { baseUrl } = await serve((_seen, res) => sse(res, answer('claude-opus-5-5', '', 'refusal', { type: 'refusal', category: 'bio', explanation: null })));
    const events = await collect(createAnthropicProvider({ apiKey: KEY, baseUrl }), request());
    expect(events.at(-1)).toEqual({ type: 'refused', category: 'bio' });
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  it('maps real error responses, with the key and the board text nowhere in the result', async () => {
    const reply = (status: number, extra: Record<string, string> = {}) =>
      serve((_seen, res) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false', ...extra });
        res.end(JSON.stringify({ type: 'error', error: { type: 'x', message: `rejected ${KEY} BOARD TEXT` } }));
      });
    for (const [status, code, extra] of [[401, 'ai_key_invalid', {}], [429, 'ai_rate_limited', { 'retry-after': '9' }], [529, 'ai_unavailable', {}], [500, 'ai_unavailable', {}], [400, 'internal', {}]] as const) {
      const { baseUrl } = await reply(status, extra);
      const failure = await failureOf(collect(createAnthropicProvider({ apiKey: KEY, baseUrl }), request()));
      expect(failure.code).toBe(code);
      expect(`${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`).not.toMatch(/sk-ant|BOARD TEXT/);
      expect(failure.retryAfter).toBe(status === 429 ? 9 : null);
    }
  });

  it('verifies a key with one models call and rejects a bad one', async () => {
    const ok = await serve((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'x', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'a', last_id: 'a' }));
    });
    await createAnthropicProvider({ apiKey: KEY, baseUrl: ok.baseUrl }).verify();
    expect(ok.seen).toHaveLength(1);
    expect(ok.seen[0].url).toContain('/v1/models');
    expect(ok.seen[0].url).toContain('limit=1');
    expect(ok.seen[0].headers['x-api-key']).toBe(KEY);

    const bad = await serve((_seen, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    });
    expect((await failureOf(createAnthropicProvider({ apiKey: KEY, baseUrl: bad.baseUrl }).verify())).code).toBe('ai_key_invalid');
    expect(bad.seen).toHaveLength(1);
  });
});
