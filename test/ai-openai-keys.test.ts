import { afterEach, describe, expect, it } from 'vitest';
import { AiError } from '../server/ai/errors.mjs';
import { KEY, closeWorlds, setup, type Who, type World } from './ai-run-harness';

// TAB-222: saving, showing, testing and auditing a key of an OpenAI-compatible provider, through the real routes with a fake
// provider (no network, no real key). The address a key is sent to is hostile input, so most of this is what is refused.

afterEach(closeWorlds);

const BASE = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'moonshotai/kimi-k3';
const good = { apiKey: KEY, provider: 'openai-compatible', baseUrl: BASE, model: MODEL };
// the admin body calls the model of a key `keyModel`: `model` there is the workspace's Anthropic model setting
const adminBody = (body: Record<string, unknown>) => {
  const { model, ...rest } = body;
  return model === undefined ? rest : { ...rest, keyModel: model };
};

async function world(personalKeys = false) {
  const w = await setup();
  w.directory.setSetting('ai.enabled', '1');
  if (personalKeys) w.directory.setSetting('ai.personalKeys', '1');
  return { w, admin: w.person('admin'), member: w.person('member') };
}

const putAdmin = (w: World, who: Who, body: Record<string, unknown>) => w.call(who, 'PUT', '/api/admin/ai', adminBody(body));
const putMine = (w: World, who: Who, body: Record<string, unknown>) => w.call(who, 'PUT', '/api/ai/keys/me', body);
const auditRows = (w: World) => w.directory.listAudit(50) as unknown as { action: string; detail: Record<string, unknown> }[];

describe('what a key screen may send for an OpenAI-compatible key', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['no base URL', { ...good, baseUrl: undefined }, 'baseUrl must be a web address'],
    ['no model', { ...good, model: undefined }, 'odel must be'],
    ['an http address', { ...good, baseUrl: 'http://api.example.com/v1' }, 'https://'],
    ['a user name and password', { ...good, baseUrl: 'https://me:pw@api.example.com/v1' }, 'user name'],
    ['a query', { ...good, baseUrl: 'https://api.example.com/v1?token=1' }, 'query'],
    ['a fragment', { ...good, baseUrl: 'https://api.example.com/v1#x' }, 'query or a fragment'],
    ['localhost', { ...good, baseUrl: 'https://localhost/v1' }, 'public'],
    ['a private address', { ...good, baseUrl: 'https://10.0.0.5/v1' }, 'public'],
    ['a loopback address', { ...good, baseUrl: 'https://127.0.0.1:8443/v1' }, 'public'],
    ['the metadata address', { ...good, baseUrl: 'https://169.254.169.254/latest' }, 'public'],
    ['an IPv6 loopback', { ...good, baseUrl: 'https://[::1]/v1' }, 'public'],
    ['a .internal name', { ...good, baseUrl: 'https://vault.internal/v1' }, 'public'],
    ['an address that is too long', { ...good, baseUrl: `https://api.example.com/${'a'.repeat(200)}` }, '200'],
    ['an address that is not a string', { ...good, baseUrl: 42 }, 'web address'],
    ['a model with a space', { ...good, model: 'a b' }, 'odel must be'],
    ['a model that is markup', { ...good, model: '<img src=x onerror=alert(1)>' }, 'odel must be'],
    ['a model that is too long', { ...good, model: 'm'.repeat(101) }, 'odel must be'],
    ['a model that starts with a dash', { ...good, model: '-rf' }, 'odel must be'],
    ['a base URL with Anthropic', { apiKey: KEY, provider: 'anthropic', baseUrl: BASE }, 'openai-compatible provider only'],
    ['a model with Anthropic', { apiKey: KEY, provider: 'anthropic', model: MODEL }, 'openai-compatible provider only'],
    ['an unknown provider', { ...good, provider: 'azure' }, 'provider must be one of'],
    ['a base URL without a key', { baseUrl: BASE, enabled: true }, 'applies together with apiKey'],
  ];

  it.each(bad)('refuses %s from the admin screen, before any call to a provider', async (_name, body, message) => {
    const { w, admin } = await world(true);
    const res = await putAdmin(w, admin, body);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(message);
    expect(w.madeWith).toEqual([]);
    expect(w.directory.getAiKeyInfo('workspace')).toBeNull();
  });

  it.each(bad.filter(([, body]) => body.apiKey))('refuses %s from Your AI key, before any call to a provider', async (_name, body, message) => {
    const { w, member } = await world(true);
    const res = await putMine(w, member, body);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(message);
    expect(w.madeWith).toEqual([]);
    expect(w.directory.getAiKeyInfo('user', member.user.id)).toBeNull();
  });
});

describe('saving a key of an OpenAI-compatible provider', () => {
  it('checks it with the provider, stores the address and model with it, and shows them back without the key', async () => {
    const { w, admin } = await world();
    const saved = await putAdmin(w, admin, { ...good, baseUrl: `${BASE}///` });
    expect(saved.status).toBe(200);
    // the provider was asked to check this very address and model, and the address is not trusted
    expect(w.madeWith).toEqual([{ kind: 'openai-compatible', apiKey: KEY, baseUrl: BASE, model: MODEL }]);
    expect(saved.body.key).toMatchObject({ provider: 'openai-compatible', baseUrl: BASE, model: MODEL, hint: KEY.slice(-4), readable: true });
    expect(saved.text).not.toContain(KEY);
    const again = await w.call(admin, 'GET', '/api/admin/ai');
    expect(again.body.key).toMatchObject({ baseUrl: BASE, model: MODEL });
    expect(again.text).not.toContain(KEY);
  });

  it('reports the model of the key in use as the effective model, and its provider', async () => {
    const { w, admin, member } = await world(true);
    await putAdmin(w, admin, { ...good, model: MODEL });
    const config = await w.call(member, 'GET', '/api/ai/config');
    expect(config.body).toMatchObject({ keySource: 'workspace', provider: 'openai-compatible', model: MODEL });
    // a personal Anthropic key puts the workspace's Anthropic model back
    await putMine(w, member, { apiKey: `${KEY}-mine`, provider: 'anthropic' });
    const mine = await w.call(member, 'GET', '/api/ai/config');
    expect(mine.body).toMatchObject({ keySource: 'user', provider: 'anthropic' });
    expect(mine.body.model).toBe(admin && (await w.call(admin, 'GET', '/api/admin/ai')).body.model);
  });

  it('replaces the address and the model with a new key, and clears them for an Anthropic one', async () => {
    const { w, admin } = await world();
    await putAdmin(w, admin, good);
    await putAdmin(w, admin, { apiKey: `${KEY}-2`, provider: 'anthropic' });
    expect(w.directory.getAiKeyInfo('workspace')).toMatchObject({ provider: 'anthropic', baseUrl: null, model: null });
  });

  it('stores nothing when the provider refuses the key, the model or the address', async () => {
    const { w, admin } = await world();
    for (const code of ['ai_key_invalid', 'ai_model_invalid', 'ai_timeout', 'ai_unavailable'] as const) {
      w.state.verify = async () => {
        throw new AiError(code);
      };
      const res = await putAdmin(w, admin, good);
      expect(res.body.error).toBe(code);
      expect(w.directory.getAiKeyInfo('workspace')).toBeNull();
      // a refused save leaves a person a retry: the throttle is for saves that reach the provider, so wait it out per code
      w.state.t += 3_600_000;
    }
  });

  it('writes the provider, the host and the model into the audit row, and never the key or the whole address', async () => {
    const { w, admin } = await world();
    await putAdmin(w, admin, { ...good, baseUrl: `${BASE}/secret-looking-path` });
    const row = auditRows(w).find((r) => r.action === 'ai.key.set')!;
    expect(row.detail).toEqual({ scope: 'workspace', provider: 'openai-compatible', host: 'integrate.api.nvidia.com', model: MODEL });
    expect(JSON.stringify(auditRows(w))).not.toContain(KEY);
    expect(JSON.stringify(auditRows(w))).not.toContain('secret-looking-path');
    expect(JSON.stringify(w.logged)).not.toContain(KEY);
  });
});

describe('Test key for both providers', () => {
  it('asks the provider about the stored address and model, for the workspace key and a personal one', async () => {
    const { w, admin, member } = await world(true);
    await putAdmin(w, admin, good);
    await putMine(w, member, { apiKey: `${KEY}-mine`, provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/llama-4' });
    w.madeWith.length = 0;

    const workspace = await w.call(admin, 'POST', '/api/admin/ai/key/test', {});
    expect(workspace.status).toBe(200);
    expect(workspace.body).toMatchObject({ ok: true, provider: 'openai-compatible' });
    const mine = await w.call(member, 'POST', '/api/ai/keys/me/test', {});
    expect(mine.status).toBe(200);
    expect(w.madeWith).toEqual([
      { kind: 'openai-compatible', apiKey: KEY, baseUrl: BASE, model: MODEL },
      { kind: 'openai-compatible', apiKey: `${KEY}-mine`, baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/llama-4' },
    ]);
    expect(workspace.text + mine.text).not.toContain(KEY);
  });

  it('still tests an Anthropic key with no address or model', async () => {
    const { w, admin } = await world();
    await putAdmin(w, admin, { apiKey: KEY, provider: 'anthropic' });
    w.madeWith.length = 0;
    expect((await w.call(admin, 'POST', '/api/admin/ai/key/test', {})).status).toBe(200);
    expect(w.madeWith).toEqual([{ kind: 'anthropic', apiKey: KEY, baseUrl: null, model: null }]);
  });

  it('says what is wrong: the model, the key, a slow model, and writes a failed audit row without the address', async () => {
    const { w, admin } = await world();
    await putAdmin(w, admin, good);
    for (const [code, status] of [['ai_model_invalid', 400], ['ai_key_invalid', 400], ['ai_timeout', 504], ['ai_unavailable', 502]] as const) {
      w.state.verify = async () => {
        throw new AiError(code);
      };
      const res = await w.call(admin, 'POST', '/api/admin/ai/key/test', {});
      expect(res.status).toBe(status);
      expect(res.body.error).toBe(code);
      w.state.t += 3_600_000;
    }
    const failed = auditRows(w).filter((r) => r.action === 'ai.key.test');
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain(KEY);
    expect(JSON.stringify(failed)).not.toContain('integrate.api.nvidia.com');
  });
});
