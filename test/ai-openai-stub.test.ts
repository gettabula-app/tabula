import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startOpenAiStub } from '../scripts/lib/openai-stub.mjs';

const KEY = 'sk-test-' + crypto.randomBytes(12).toString('hex');
const MODEL = 'gpt-stub';
const FENCE = String.fromCharCode(96).repeat(3);
const ANSWERS = { generate: { text: 'generated' }, cluster: { groups: [{ title: 'Theme', ids: ['a', 'b'] }] } };
const stubs: Array<{ server: Server; base: string; calls: any[]; setMode(mode: string): void }> = [];

afterEach(async () => {
  for (const stub of stubs.splice(0).reverse()) {
    stub.server.closeAllConnections();
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  }
});

async function launch(mode = 'json_object') {
  const stub = await startOpenAiStub({ apiKey: KEY, model: MODEL, answers: ANSWERS, mode });
  stubs.push(stub);
  return stub;
}

function requestBody({ groups = false, responseFormat = true, model = MODEL, messages }: {
  groups?: boolean;
  responseFormat?: boolean;
  model?: string;
  messages?: unknown[];
} = {}) {
  const schema = groups ? { properties: { groups: { type: 'array' } } } : { properties: { text: { type: 'string' } } };
  return {
    model,
    messages: messages ?? [
      { role: 'system', content: 'Return JSON matching schema: ' + JSON.stringify(schema) },
      { role: 'user', content: 'hello' },
    ],
    max_tokens: 100,
    ...(responseFormat ? { response_format: { type: 'json_object' } } : {}),
  };
}

async function post(stub: Awaited<ReturnType<typeof launch>>, body: unknown, key = KEY) {
  return fetch(stub.base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('OpenAI-compatible stub', () => {
  it('serves the models list, routes generate and groups answers, and logs metadata only', async () => {
    const stub = await launch();
    const models = await fetch(stub.base + '/models', { headers: { authorization: 'Bearer ' + KEY } });
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ object: 'list', data: [{ id: MODEL, object: 'model' }] });

    const generate = await post(stub, requestBody());
    expect(generate.status).toBe(200);
    const generated = await generate.json();
    expect(generated).toMatchObject({
      object: 'chat.completion',
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(ANSWERS.generate) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 64, completion_tokens: 45, total_tokens: 109 },
    });
    const cluster = await post(stub, requestBody({ groups: true }));
    expect((await cluster.json()).choices[0].message.content).toBe(JSON.stringify(ANSWERS.cluster));

    expect(stub.calls).toEqual([
      { method: 'GET', path: '/v1/models', model: null, keyMatched: true, hasResponseFormat: false, format: null, feature: null },
      { method: 'POST', path: '/v1/chat/completions', model: MODEL, keyMatched: true, hasResponseFormat: true, format: 'json_object', feature: 'generate' },
      { method: 'POST', path: '/v1/chat/completions', model: MODEL, keyMatched: true, hasResponseFormat: true, format: 'json_object', feature: 'cluster' },
    ]);
    expect(JSON.stringify(stub.calls)).not.toContain(KEY);
  });

  it('rejects wrong keys and wrong models', async () => {
    const stub = await launch();
    const badKey = await fetch(stub.base + '/models', { headers: { authorization: 'Bearer wrong-key' } });
    expect(badKey.status).toBe(401);
    const wrongModel = await post(stub, requestBody({ model: 'missing-model' }));
    expect(wrongModel.status).toBe(404);
    expect(stub.calls.map((call) => [call.keyMatched, call.model])).toEqual([[false, null], [true, 'missing-model']]);
  });

  it('rejects response_format in its configured mode, then answers a format-free retry with a fence', async () => {
    const stub = await launch('reject_json_object');
    const rejected = await post(stub, requestBody());
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.message).toBe('response_format is not supported');
    const accepted = await post(stub, requestBody({ responseFormat: false }));
    const content = (await accepted.json()).choices[0].message.content;
    expect(content.startsWith(FENCE + 'json\n')).toBe(true);
    expect(content.endsWith('\n' + FENCE)).toBe(true);
    expect(stub.calls.map((call) => call.hasResponseFormat)).toEqual([true, false]);
  });

  it('can fence all answers and switch modes while running', async () => {
    const stub = await launch('fenced');
    const first = await post(stub, requestBody());
    expect((await first.json()).choices[0].message.content.startsWith(FENCE + 'json\n')).toBe(true);
    stub.setMode('json_object');
    const second = await post(stub, requestBody());
    expect((await second.json()).choices[0].message.content).toBe(JSON.stringify(ANSWERS.generate));
  });

  it('returns prose before a repair and keeps always_prose invalid', async () => {
    const stub = await launch('prose');
    const first = await post(stub, requestBody());
    expect((await first.json()).choices[0].message.content).toBe('Here is the result in prose.');
    const retry = await post(stub, requestBody({
      messages: [
        { role: 'system', content: 'schema' },
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'Your previous reply was not valid JSON. Reply again with only the JSON object.' },
      ],
    }));
    expect((await retry.json()).choices[0].message.content).toBe(JSON.stringify(ANSWERS.generate));
    stub.setMode('always_prose');
    const always = await post(stub, requestBody());
    expect((await always.json()).choices[0].message.content).toBe('Here is the result in prose.');
    expect(stub.calls).toHaveLength(3);
  });

  it('keeps chat working when /models is missing', async () => {
    const stub = await launch('no_models');
    expect((await fetch(stub.base + '/models', { headers: { authorization: 'Bearer ' + KEY } })).status).toBe(404);
    expect((await post(stub, requestBody())).status).toBe(200);
    expect(stub.calls.map((call) => call.path)).toEqual(['/v1/models', '/v1/chat/completions']);
  });

  it.each([
    ['rate_limit', 429],
    ['unauthorized', 401],
    ['server_error', 500],
  ])('supports %s mode and its status metadata', async (mode, status) => {
    const stub = await launch(mode);
    const response = await fetch(stub.base + '/models', { headers: { authorization: 'Bearer ' + KEY } });
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe(mode === 'rate_limit' ? '7' : null);
    expect(stub.calls).toHaveLength(1);
  });

  it('returns a content-filter refusal', async () => {
    const stub = await launch('refusal');
    const response = await post(stub, requestBody());
    expect((await response.json()).choices[0]).toMatchObject({
      finish_reason: 'content_filter',
      message: { role: 'assistant', refusal: 'The request was declined.' },
    });
  });

  it('leaves slow requests pending until the caller closes the socket', async () => {
    const stub = await launch('slow');
    const controller = new AbortController();
    const pending = fetch(stub.base + '/models', {
      headers: { authorization: 'Bearer ' + KEY },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(stub.calls).toHaveLength(1);
  });
});
