import { describe, expect, it } from 'vitest';
import { createApi, type AdminAi } from '../src/api';
import { ADMIN_TABS } from '../src/route';
import {
  DATA_NOTICE, FEATURE_OPTIONS, KEY_MAX, KEY_MIN, LIMIT_CAPS, MODEL_OPTIONS, OPENAI_COMPATIBLE_PROVIDER, PROVIDER, PROVIDER_OPTIONS, UNCONFIGURED_TEXT,
  draftOf, draftProblem, hostOf, keyDates, keyLine, keyProblem, keyTestErrorMessage, limitProblem, modelLabel, patchOf, sourceLabel,
} from '../src/ui/ai-logic';
import { MODELS } from '../server/ai/anthropic.mjs';
import { PROVIDERS } from '../server/ai/providers.mjs';
import { API_KEY_MAX, API_KEY_MIN, FEATURES, LIMIT_CAPS as SERVER_CAPS } from '../server/ai/settings.mjs';

// docs/ai.md. The pure rules and text behind the "Your AI key" dialog and the AI tab, and the calls they make.

const saved = (extra: Partial<AdminAi> = {}): AdminAi => ({
  enabled: false,
  features: ['generate', 'summarise', 'cluster'],
  model: 'claude-opus-5-5',
  personalKeys: false,
  membersOnly: false,
  limits: { perPersonHour: 20, perWorkspaceHour: 200 },
  hasSecret: true,
  key: null,
  ...extra,
});

describe('the shared lists', () => {
  it('offer what the server accepts, in its order', () => {
    expect(MODEL_OPTIONS.map((o) => o.value)).toEqual(MODELS);
    expect(FEATURE_OPTIONS.map((o) => o.id)).toEqual(FEATURES);
    expect(PROVIDER_OPTIONS.map((o) => o.value)).toEqual(PROVIDERS);
    expect([PROVIDER]).toEqual([PROVIDERS[0]]);
    expect(LIMIT_CAPS).toEqual(SERVER_CAPS);
    expect([KEY_MIN, KEY_MAX]).toEqual([API_KEY_MIN, API_KEY_MAX]);
  });

  it('puts an AI tab in the admin dashboard, before the audit log', () => {
    expect(ADMIN_TABS).toContain('ai');
    expect(ADMIN_TABS.indexOf('ai')).toBeLessThan(ADMIN_TABS.indexOf('audit'));
  });

  it('tells the person that board content leaves the instance', () => {
    expect(DATA_NOTICE).toContain('Board content is sent to the chosen provider and processed under its API terms');
    expect(UNCONFIGURED_TEXT).toContain('TABULA_AI_SECRET');
  });

  it('names the models by their product name', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelLabel('something-new')).toBe('something-new');
  });
});

describe('keyProblem', () => {
  it.each([
    ['', 'Paste the API key.'],
    ['   ', 'Paste the API key.'],
    ['sk-ant 12345678', 'A key has no spaces.'],
    ['short', 'A key has at least 8 characters.'],
    ['k'.repeat(513), 'A key has at most 512 characters.'],
  ])('rejects %j', (value, why) => {
    expect(keyProblem(value)).toBe(why);
  });

  it('accepts a key of 8 to 512 characters, trimmed', () => {
    expect(keyProblem('12345678')).toBeNull();
    expect(keyProblem('  sk-ant-api03-abcdefgh  ')).toBeNull();
    expect(keyProblem('k'.repeat(512))).toBeNull();
  });

  it('checks the compatible provider endpoint and model before saving', () => {
    const key = 'sk-test-1234abcd';
    expect(keyProblem(key, OPENAI_COMPATIBLE_PROVIDER, 'https://example.com/v1/', 'moonshotai/kimi-k3')).toBeNull();
    expect(keyProblem(key, OPENAI_COMPATIBLE_PROVIDER, '', 'moonshotai/kimi-k3')).toBe('Enter a base URL.');
    expect(keyProblem(key, OPENAI_COMPATIBLE_PROVIDER, 'https://example.com/v1', '')).toBe('Enter a model id.');
    expect(keyProblem(key, OPENAI_COMPATIBLE_PROVIDER, 'https://example.com/v1', 'a'.repeat(101))).toBe('A model id has at most 100 characters.');
    expect(keyProblem(key, OPENAI_COMPATIBLE_PROVIDER, 'https://example.com/v1', '_bad')).toBe('A model id starts with a letter or digit.');
    expect(keyProblem(key, OPENAI_COMPATIBLE_PROVIDER, 'https://example.com/v1', 'bad model')).toBe('A model id uses only letters, digits, ., _, :, /, @, + and -.');
  });
});

describe('limits and the draft', () => {
  it.each(['', ' ', '0', '-1', '1.5', 'many', '1001', '1e3', '0001001'])('rejects %j as a person limit', (value) => {
    expect(limitProblem('perPersonHour', value)).toContain('whole number from 1 to 1000');
  });

  it('accepts whole numbers up to the cap', () => {
    expect(limitProblem('perPersonHour', '1')).toBeNull();
    expect(limitProblem('perPersonHour', '1000')).toBeNull();
    expect(limitProblem('perWorkspaceHour', '10000')).toBeNull();
    expect(limitProblem('perWorkspaceHour', '10001')).toContain('1 to 10000');
  });

  it('starts as the saved settings and finds the first problem', () => {
    const draft = draftOf(saved());
    expect(draft).toEqual({ enabled: false, features: ['generate', 'summarise', 'cluster'], model: 'claude-opus-5-5', personalKeys: false, membersOnly: false, perPersonHour: '20', perWorkspaceHour: '200' });
    expect(draftProblem(draft)).toBeNull();
    expect(draftProblem({ ...draft, perPersonHour: '0' })).toContain('per person');
    expect(draftProblem({ ...draft, perWorkspaceHour: 'x' })).toContain('per workspace');
    expect(draftOf(saved()).features).not.toBe(saved().features);
  });
});

describe('patchOf', () => {
  it('is null when nothing differs, whatever the order of the features', () => {
    expect(patchOf(saved(), draftOf(saved()))).toBeNull();
    expect(patchOf(saved(), { ...draftOf(saved()), features: ['cluster', 'generate', 'summarise'] })).toBeNull();
  });

  it('holds only what differs, so the audit log shows what was changed', () => {
    const draft = { ...draftOf(saved()), enabled: true, model: 'claude-haiku-5-5', personalKeys: true };
    expect(patchOf(saved(), draft)).toEqual({ enabled: true, model: 'claude-haiku-5-5', personalKeys: true });
    expect(patchOf(saved(), { ...draftOf(saved()), membersOnly: true, perWorkspaceHour: '500' })).toEqual({ membersOnly: true, limits: { perWorkspaceHour: 500 } });
    expect(patchOf(saved(), { ...draftOf(saved()), perPersonHour: '5', perWorkspaceHour: '200' })).toEqual({ limits: { perPersonHour: 5 } });
  });

  it('lists the features in the server order and allows none', () => {
    expect(patchOf(saved(), { ...draftOf(saved()), features: ['cluster', 'generate'] })).toEqual({ features: ['generate', 'cluster'] });
    expect(patchOf(saved(), { ...draftOf(saved()), features: [] })).toEqual({ features: [] });
  });
});

describe('what the screens say about a key', () => {
  it('shows the provider and the last four characters only', () => {
    expect(keyLine({ provider: 'anthropic', hint: 'a1b2', baseUrl: null, model: null })).toBe('Anthropic key ending …a1b2');
    expect(keyLine({ provider: 'openai-compatible', hint: 'abcd', baseUrl: 'https://integrate.api.nvidia.com/v1/', model: 'moonshotai/kimi-k3' }))
      .toBe('OpenAI-compatible key ending …abcd · integrate.api.nvidia.com · moonshotai/kimi-k3');
    expect(keyLine({ provider: 'other', hint: 'zzzz', baseUrl: null, model: null })).toBe('other key ending …zzzz');
  });

  it('shows only a safe HTTPS host for a compatible key', () => {
    expect(hostOf('https://user:pass@example.com/v1?secret=x#part')).toBe('example.com');
    expect(hostOf('https://user:pass@example.com:8443/v1')).toBe('example.com:8443');
    expect(hostOf('javascript:alert(1)')).toBeNull();
    expect(hostOf('')).toBeNull();
    expect(hostOf(null)).toBeNull();
  });

  it('says when it was added and last used', () => {
    const ago = (t: number) => `t${t}`;
    expect(keyDates({ createdAt: 5, lastUsedAt: null }, ago)).toBe('Added t5 · never used');
    expect(keyDates({ createdAt: 5, lastUsedAt: 9 }, ago)).toBe('Added t5 · used t9');
  });

  it('says which key a run would use', () => {
    expect(sourceLabel('user')).toBe('Runs use your key.');
    expect(sourceLabel('workspace')).toBe('Runs use the workspace key.');
    expect(sourceLabel(null)).toContain('no key yet');
  });

  it('maps stored-key check errors to short messages', () => {
    expect(keyTestErrorMessage({ code: 'ai_key_invalid' })).toBe('The AI key was rejected.');
    expect(keyTestErrorMessage({ code: 'ai_model_invalid' })).toBe('The provider does not know this model or this address. Check the base URL and the model.');
    expect(keyTestErrorMessage({ code: 'ai_bad_output' })).toBe('This model did not answer in the required JSON format. Try a stronger instruction-following model. Nothing was changed.');
    expect(keyTestErrorMessage({ code: 'ai_rate_limited', facts: { retryAfter: 12 } })).toBe('Too many checks. Try again in 12 s.');
    expect(keyTestErrorMessage({ status: 429, facts: { retryAfter: 1.2 } })).toBe('Too many checks. Try again in 2 s.');
    expect(keyTestErrorMessage({ code: 'ai_unavailable' })).toBe("Anthropic isn't responding. Try again in a moment.");
    expect(keyTestErrorMessage({ code: 'ai_key_unreadable' })).toBe("The key can't be read. Enter it again.");
    expect(keyTestErrorMessage({ code: 'forbidden' })).toBeNull();
  });
});

describe('the API client', () => {
  type Call = { url: string; init: RequestInit };
  const client = (reply: (c: Call) => Response) => {
    const calls: Call[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return reply(call);
    }) as typeof fetch;
    return { api: createApi(fetchFn), calls };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('uses the routes of the server, with the CSRF header on writes only', async () => {
    const { api, calls } = client((c) => (c.init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ ok: true })));
    await api.aiConfig();
    await api.saveMyAiKey({ provider: 'anthropic', apiKey: 'sk-ant-12345678' });
    await api.testMyAiKey();
    await api.deleteMyAiKey();
    await api.adminAi();
    await api.updateAdminAi({ enabled: true, limits: { perPersonHour: 3 } });
    await api.testAdminAiKey();
    await api.deleteAdminAiKey();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/ai/config',
      'PUT /api/ai/keys/me',
      'POST /api/ai/keys/me/test',
      'DELETE /api/ai/keys/me',
      'GET /api/admin/ai',
      'PUT /api/admin/ai',
      'POST /api/admin/ai/key/test',
      'DELETE /api/admin/ai/key',
    ]);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-12345678' });
    expect(JSON.parse(calls[2].init.body as string)).toEqual({});
    expect(JSON.parse(calls[5].init.body as string)).toEqual({ enabled: true, limits: { perPersonHour: 3 } });
    expect(JSON.parse(calls[6].init.body as string)).toEqual({});
    expect(calls.map((c) => Object.values(c.init.headers as Record<string, string>).includes('1'))).toEqual([false, true, true, true, false, true, true, true]);
  });

  it('reports a rejected key with the server code', async () => {
    const { api } = client(() => json({ error: 'ai_key_invalid', message: 'The provider did not accept this key' }, 400));
    await expect(api.saveMyAiKey({ provider: 'anthropic', apiKey: 'sk-ant-12345678' })).rejects.toMatchObject({ status: 400, code: 'ai_key_invalid', message: 'The provider did not accept this key' });
  });
});
