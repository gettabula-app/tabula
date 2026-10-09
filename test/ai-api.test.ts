import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../server/api.mjs';
import { AiError } from '../server/ai/errors.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { createKeyRing } from '../server/ai/keys.mjs';

// docs/ai.md, "Endpoints" and "Privacy and admin controls". The API runs in this process behind a real HTTP server, with
// a fake provider in place of the network: no request leaves the machine and no real key is involved.

const SECRET = crypto.randomBytes(32).toString('base64');
const newKey = () => `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;

type Body = any;
type Res = { status: number; body: Body; headers: Headers; text: string };
type Verify = (apiKey: string) => Promise<void>;

const stack: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of stack.splice(0).reverse()) await close();
});

/** `dir` reuses the data directory of an earlier world, for a second server on the same directory file. */
async function setup(env: Record<string, string> = { TABULA_AI_SECRET: SECRET }, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-api-'))) {
  const config = loadConfig({ TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', DATA_DIR: dir, TABULA_MAIL: 'file', ...env }, () => {});
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} } });
  const providers: { kind: string; apiKey: string }[] = [];
  const logged: unknown[][] = [];
  const state: { verify: Verify } = { verify: async () => {} };
  const createProvider = ({ kind, apiKey }: { kind: string; apiKey: string }) => {
    providers.push({ kind, apiKey });
    return { kind, models: () => [], verify: () => state.verify(apiKey), run: async function* () {} };
  };
  const api = createApi({
    directory,
    auth,
    config,
    roomExists: () => false,
    events: new EventEmitter(),
    mailer: { send: async () => {} },
    ai: { createProvider, log: (...args: unknown[]) => logged.push(args) },
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const closed: { done: boolean } = { done: false };
  const close = async () => {
    if (closed.done) return;
    closed.done = true;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    directory.close();
  };
  stack.push(async () => {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;
  const signIn = (role: 'owner' | 'admin' | 'member' | 'guest') => {
    const user = directory.createUser({ email: `${role}${++n}-${crypto.randomBytes(3).toString('hex')}@example.com`, role })!;
    const session = directory.createSession(user.id, { ttlMs: 3_600_000 });
    return { user, cookie: `${config.cookieName}=${session.token}` };
  };

  async function call(who: { cookie: string } | null, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        'x-tabula': '1',
        ...(who ? { cookie: who.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers, text };
  }

  return { dir, config, directory, call, signIn, providers, logged, state, close };
}

type World = Awaited<ReturnType<typeof setup>>;
type AuditRow = { action: string; detail: Record<string, unknown>; actorId: string | null };
const auditOf = (w: World, limit: number): AuditRow[] => w.directory.listAudit(limit) as unknown as AuditRow[];
const people = (w: World) => ({ owner: w.signIn('owner'), admin: w.signIn('admin'), member: w.signIn('member'), guest: w.signIn('guest') });

const rejecting = (code: 'ai_key_invalid' | 'ai_rate_limited' | 'ai_unavailable', retryAfter: number | null = null): Verify => async () => {
  throw new AiError(code, { retryAfter });
};

describe('GET /api/ai/config', () => {
  it('needs a session', async () => {
    const w = await setup();
    expect((await w.call(null, 'GET', '/api/ai/config')).status).toBe(401);
  });

  it('is off until an admin turns it on, and says what the person can do about keys', async () => {
    const w = await setup();
    const { member } = people(w);
    const res = await w.call(member, 'GET', '/api/ai/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      features: ['generate', 'summarise', 'cluster'],
      keySource: null,
      provider: null,
      model: 'claude-opus-5-5',
      personalKeys: false,
      hasSecret: true,
      myKey: null,
    });
  });

  it('reports that the server has no secret', async () => {
    const w = await setup({});
    const { member } = people(w);
    expect((await w.call(member, 'GET', '/api/ai/config')).body).toMatchObject({ hasSecret: false, keySource: null });
  });

  it('uses TABULA_AI_MODEL as the default model', async () => {
    const w = await setup({ TABULA_AI_SECRET: SECRET, TABULA_AI_MODEL: 'claude-haiku-5-5' });
    const { member } = people(w);
    expect((await w.call(member, 'GET', '/api/ai/config')).body.model).toBe('claude-haiku-5-5');
  });

  it('keeps guests out when AI is restricted to members', async () => {
    const w = await setup();
    const { owner, member, guest } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { enabled: true, personalKeys: true });
    expect((await w.call(guest, 'GET', '/api/ai/config')).body).toMatchObject({ enabled: true, personalKeys: true });
    await w.call(owner, 'PUT', '/api/admin/ai', { membersOnly: true });
    expect((await w.call(guest, 'GET', '/api/ai/config')).body).toMatchObject({ enabled: false, personalKeys: false });
    expect((await w.call(member, 'GET', '/api/ai/config')).body).toMatchObject({ enabled: true, personalKeys: true });
  });
});

describe('PUT /api/admin/ai', () => {
  it('is for owners and admins', async () => {
    const w = await setup();
    const { owner, admin, member, guest } = people(w);
    for (const who of [member, guest]) {
      for (const [method, url, body] of [['GET', '/api/admin/ai'], ['PUT', '/api/admin/ai', { enabled: true }], ['DELETE', '/api/admin/ai/key']] as const) {
        const res = await w.call(who, method, url, body);
        expect([method, url, res.status, res.body.error]).toEqual([method, url, 403, 'forbidden']);
      }
    }
    expect((await w.call(null, 'PUT', '/api/admin/ai', { enabled: true })).status).toBe(401);
    expect((await w.call(admin, 'PUT', '/api/admin/ai', { enabled: true })).status).toBe(200);
    expect((await w.call(owner, 'PUT', '/api/admin/ai', { enabled: false })).status).toBe(200);
    expect(w.directory.getSetting('ai.enabled')).toBe('0');
    expect(auditOf(w, 50).filter((a) => a.action === 'ai.settings').map((a) => a.actorId)).toEqual([owner.user.id, admin.user.id]);
  });

  it('needs the CSRF header', async () => {
    const w = await setup();
    const { owner } = people(w);
    const res = await w.call(owner, 'PUT', '/api/admin/ai', { enabled: true }, { 'x-tabula': '0' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf');
  });

  it('starts from the defaults the spec names', async () => {
    const w = await setup();
    const { owner } = people(w);
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body).toEqual({
      enabled: false,
      features: ['generate', 'summarise', 'cluster'],
      model: 'claude-opus-5-5',
      personalKeys: false,
      membersOnly: false,
      limits: { perPersonHour: 20, perWorkspaceHour: 200 },
      hasSecret: true,
      key: null,
    });
  });

  it('saves every setting under ai.* in the settings table and audits the change', async () => {
    const w = await setup();
    const { owner } = people(w);
    const res = await w.call(owner, 'PUT', '/api/admin/ai', {
      enabled: true,
      features: ['cluster', 'generate'],
      model: 'claude-sonnet-5-5',
      personalKeys: true,
      membersOnly: true,
      limits: { perPersonHour: 5 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      features: ['generate', 'cluster'],
      model: 'claude-sonnet-5-5',
      personalKeys: true,
      membersOnly: true,
      limits: { perPersonHour: 5, perWorkspaceHour: 200 },
      key: null,
    });
    expect(Object.fromEntries(['enabled', 'features', 'model', 'personalKeys', 'membersOnly', 'limits.perPersonHour', 'limits.perWorkspaceHour'].map((k) => [k, w.directory.getSetting(`ai.${k}`)]))).toEqual({
      enabled: '1',
      features: '["generate","cluster"]',
      model: 'claude-sonnet-5-5',
      personalKeys: '1',
      membersOnly: '1',
      'limits.perPersonHour': '5',
      'limits.perWorkspaceHour': null,
    });
    await w.call(owner, 'PUT', '/api/admin/ai', { limits: { perWorkspaceHour: 900 }, features: [] });
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body).toMatchObject({ features: [], limits: { perPersonHour: 5, perWorkspaceHour: 900 }, enabled: true });
    const audit = auditOf(w, 10).filter((a) => a.action === 'ai.settings').reverse();
    expect(audit.map((a) => a.detail)).toEqual([
      { enabled: true, features: ['generate', 'cluster'], model: 'claude-sonnet-5-5', personalKeys: true, membersOnly: true, limits: { perPersonHour: 5 } },
      { features: [], limits: { perWorkspaceHour: 900 } },
    ]);
  });

  it('reads an unusable stored value as its default', async () => {
    const w = await setup();
    const { owner } = people(w);
    w.directory.setSetting('ai.model', 'gpt-4');
    w.directory.setSetting('ai.features', '{"not":"a list"}');
    w.directory.setSetting('ai.limits.perPersonHour', '-3');
    w.directory.setSetting('ai.limits.perWorkspaceHour', 'many');
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body).toMatchObject({
      model: 'claude-opus-5-5',
      features: ['generate', 'summarise', 'cluster'],
      limits: { perPersonHour: 20, perWorkspaceHour: 200 },
    });
  });

  const bad: [string, unknown][] = [
    ['an empty body', {}],
    ['a list', []],
    ['a string body', '"x"'],
    ['an unknown field', { enable: true }],
    ['a field with the wrong case', { Enabled: true }],
    ['enabled as a string', { enabled: 'true' }],
    ['enabled as a number', { enabled: 1 }],
    ['personalKeys as null', { personalKeys: null }],
    ['membersOnly as a string', { membersOnly: 'yes' }],
    ['features that is not a list', { features: 'generate' }],
    ['an unknown feature', { features: ['generate', 'translate'] }],
    ['a repeated feature', { features: ['generate', 'generate'] }],
    ['too many features', { features: ['generate', 'summarise', 'cluster', 'generate'] }],
    ['a non-string feature', { features: [1] }],
    ['an unknown model', { model: 'claude-opus-5' }],
    ['a dated model', { model: 'claude-opus-5-5-20260401' }],
    ['a model that is not a string', { model: 5 }],
    ['limits that is not an object', { limits: 5 }],
    ['limits that is a list', { limits: [1] }],
    ['no limits named', { limits: {} }],
    ['an unknown limit', { limits: { perHour: 5 } }],
    ['a zero limit', { limits: { perPersonHour: 0 } }],
    ['a negative limit', { limits: { perWorkspaceHour: -1 } }],
    ['a fractional limit', { limits: { perPersonHour: 1.5 } }],
    ['a limit as a string', { limits: { perPersonHour: '5' } }],
    ['a person limit past the cap', { limits: { perPersonHour: 1001 } }],
    ['a workspace limit past the cap', { limits: { perWorkspaceHour: 10001 } }],
    ['a null limit', { limits: { perPersonHour: null } }],
    ['a key that is not a string', { apiKey: 12345678 }],
    ['an empty key', { apiKey: '' }],
    ['a short key', { apiKey: 'short' }],
    ['a key with a space', { apiKey: 'sk-ant-123 45678' }],
    ['a key with a newline', { apiKey: 'sk-ant-12345\n678' }],
    ['a very long key', { apiKey: 'k'.repeat(513) }],
    ['an unknown provider', { apiKey: 'sk-ant-12345678', provider: 'openai-compatible' }],
    ['a provider that is not a string', { apiKey: 'sk-ant-12345678', provider: 7 }],
    ['a base URL', { apiKey: 'sk-ant-12345678', baseUrl: 'https://llm.example.com' }],
    ['a base URL that is not a string', { apiKey: 'sk-ant-12345678', baseUrl: 5 }],
    ['a provider without a key', { provider: 'anthropic', enabled: true }],
    ['a base URL without a key', { baseUrl: 'https://llm.example.com', enabled: true }],
  ];
  it.each(bad)('answers 400 to %s and changes nothing', async (_name, body) => {
    const w = await setup();
    const { owner } = people(w);
    const before = (await w.call(owner, 'GET', '/api/admin/ai')).body;
    const res = await w.call(owner, 'PUT', '/api/admin/ai', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(w.providers).toHaveLength(0);
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body).toEqual(before);
    expect(auditOf(w, 10).filter((a) => a.action.startsWith('ai.'))).toEqual([]);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const w = await setup();
    const { owner } = people(w);
    expect((await w.call(owner, 'PUT', '/api/admin/ai', '{nope')).status).toBe(400);
  });

  it('accepts a null base URL', async () => {
    const w = await setup();
    const { owner } = people(w);
    expect((await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: newKey(), baseUrl: null })).status).toBe(200);
  });
});

describe('the workspace key', () => {
  it('is verified, stored encrypted, and shown back as a hint only', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    const key = newKey();
    const res = await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: `  ${key}  `, provider: 'anthropic', enabled: true });
    expect(res.status).toBe(200);
    expect(w.providers).toEqual([{ kind: 'anthropic', apiKey: key }]);
    expect(res.body.enabled).toBe(true);
    expect(res.body.key).toMatchObject({ provider: 'anthropic', hint: key.slice(-4), lastUsedAt: null, readable: true });
    expect(res.text).not.toContain(key);
    expect(w.directory.getAiKeyInfo('workspace')).toMatchObject({ provider: 'anthropic', hint: key.slice(-4), createdBy: owner.user.id });

    expect((await w.call(member, 'GET', '/api/ai/config')).body).toMatchObject({ enabled: true, keySource: 'workspace', myKey: null });
    expect(auditOf(w, 10).filter((a) => a.action.startsWith('ai.')).reverse().map((a) => [a.action, a.detail])).toEqual([
      ['ai.settings', { enabled: true }],
      ['ai.key.set', { scope: 'workspace', provider: 'anthropic' }],
    ]);
  });

  it('is replaced by a newer one', async () => {
    const w = await setup();
    const { owner } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: newKey() });
    const second = newKey();
    const res = await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: second });
    expect(res.body.key.hint).toBe(second.slice(-4));
    expect(w.directory.useAiKey({ ring: ringOf(w), scope: 'workspace' })!.apiKey).toBe(second);
  });

  it('is removed at once, with an audit row, and removing nothing is fine', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: newKey() });
    const res = await w.call(owner, 'DELETE', '/api/admin/ai/key');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(w.directory.getAiKeyInfo('workspace')).toBeNull();
    expect((await w.call(member, 'GET', '/api/ai/config')).body.keySource).toBeNull();
    expect((await w.call(owner, 'DELETE', '/api/admin/ai/key')).status).toBe(204);
    expect(auditOf(w, 10).filter((a) => a.action === 'ai.key.delete').map((a) => a.detail)).toEqual([{ scope: 'workspace' }]);
  });

  it.each([
    ['a rejected key', rejecting('ai_key_invalid'), 400, 'ai_key_invalid'],
    ['a rate limit', rejecting('ai_rate_limited', 12), 429, 'ai_rate_limited'],
    ['a provider that is down', rejecting('ai_unavailable'), 502, 'ai_unavailable'],
  ])('stores nothing, and changes no setting, after %s', async (_name, verify, status, code) => {
    const w = await setup();
    const { owner } = people(w);
    w.state.verify = verify;
    const res = await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: newKey(), enabled: true, model: 'claude-haiku-5-5' });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    expect(res.headers.get('retry-after')).toBe(status === 429 ? '12' : null);
    expect(w.directory.getAiKeyInfo('workspace')).toBeNull();
    expect(w.directory.getSetting('ai.enabled')).toBeNull();
    expect(w.directory.getSetting('ai.model')).toBeNull();
    expect(auditOf(w, 10).filter((a) => a.action.startsWith('ai.'))).toEqual([]);
  });

  it('keeps an earlier key when a newer one is rejected', async () => {
    const w = await setup();
    const { owner } = people(w);
    const first = newKey();
    await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: first });
    w.state.verify = rejecting('ai_key_invalid');
    expect((await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: newKey() })).status).toBe(400);
    expect(w.directory.useAiKey({ ring: ringOf(w), scope: 'workspace' })!.apiKey).toBe(first);
  });

  it('answers ai_unconfigured when the server has no secret, before it asks the provider anything', async () => {
    const w = await setup({});
    const { owner } = people(w);
    const res = await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: newKey(), enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ai_unconfigured');
    expect(res.body.message).toContain('TABULA_AI_SECRET');
    expect(w.providers).toHaveLength(0);
    expect(w.directory.getAiKeyInfo('workspace')).toBeNull();
    expect(w.directory.getSetting('ai.enabled')).toBeNull();
    // the settings themselves do not need the secret
    expect((await w.call(owner, 'PUT', '/api/admin/ai', { enabled: true })).status).toBe(200);
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body).toMatchObject({ enabled: true, hasSecret: false, key: null });
  });

  it('shows a key the secret can no longer open as unreadable, and opens it again with the previous secret', async () => {
    const w = await setup();
    const { owner } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: newKey() });
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body.key.readable).toBe(true);
    await w.close();

    const lost = await setup({ TABULA_AI_SECRET: crypto.randomBytes(32).toString('base64') }, w.dir);
    expect((await lost.call(lost.signIn('admin'), 'GET', '/api/admin/ai')).body.key).toMatchObject({ provider: 'anthropic', readable: false });
    await lost.close();

    const rotated = await setup({ TABULA_AI_SECRET: crypto.randomBytes(32).toString('base64'), TABULA_AI_SECRET_PREVIOUS: SECRET }, w.dir);
    expect((await rotated.call(rotated.signIn('admin'), 'GET', '/api/admin/ai')).body.key.readable).toBe(true);
  });
});

describe('personal keys', () => {
  it('are refused while the admin has not allowed them, but can always be taken back', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    const res = await w.call(member, 'PUT', '/api/ai/keys/me', { provider: 'anthropic', apiKey: newKey() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(w.providers).toHaveLength(0);

    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    expect((await w.call(member, 'PUT', '/api/ai/keys/me', { provider: 'anthropic', apiKey: newKey() })).status).toBe(200);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: false });
    expect((await w.call(member, 'PUT', '/api/ai/keys/me', { provider: 'anthropic', apiKey: newKey() })).status).toBe(403);
    expect((await w.call(member, 'GET', '/api/ai/config')).body).toMatchObject({ personalKeys: false, keySource: null, myKey: null });
    expect((await w.call(member, 'DELETE', '/api/ai/keys/me')).status).toBe(204);
    expect(w.directory.getAiKeyInfo('user', member.user.id)).toBeNull();
  });

  it('are verified, stored for the person only, and win over the workspace key', async () => {
    const w = await setup();
    const { owner, member, admin } = people(w);
    const workspaceKey = newKey();
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true, enabled: true, apiKey: workspaceKey });
    const mine = newKey();
    const res = await w.call(member, 'PUT', '/api/ai/keys/me', { provider: 'anthropic', apiKey: mine });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ provider: 'anthropic', hint: mine.slice(-4), baseUrl: null, model: null });
    expect(res.text).not.toContain(mine);
    expect(w.providers.at(-1)).toEqual({ kind: 'anthropic', apiKey: mine });

    const config = (await w.call(member, 'GET', '/api/ai/config')).body;
    expect(config.keySource).toBe('user');
    expect(config.myKey).toMatchObject({ provider: 'anthropic', hint: mine.slice(-4), lastUsedAt: null });
    expect(JSON.stringify(config)).not.toContain(mine);
    expect((await w.call(admin, 'GET', '/api/ai/config')).body).toMatchObject({ keySource: 'workspace', myKey: null });
    expect((await w.call(owner, 'GET', '/api/admin/ai')).body.key.hint).toBe(workspaceKey.slice(-4));

    expect((await w.call(member, 'DELETE', '/api/ai/keys/me')).status).toBe(204);
    expect((await w.call(member, 'GET', '/api/ai/config')).body).toMatchObject({ keySource: 'workspace', myKey: null });
    expect(auditOf(w, 20).filter((a) => a.actorId === member.user.id && a.action.startsWith('ai.')).reverse().map((a) => [a.action, a.detail])).toEqual([
      ['ai.key.set', { scope: 'user', provider: 'anthropic' }],
      ['ai.key.delete', { scope: 'user' }],
    ]);
  });

  it('are the first source, so a person without a workspace key can still run', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    expect((await w.call(member, 'GET', '/api/ai/config')).body.keySource).toBeNull();
    await w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: newKey() });
    expect((await w.call(member, 'GET', '/api/ai/config')).body.keySource).toBe('user');
  });

  it('are not for guests when AI is restricted to members', async () => {
    const w = await setup();
    const { owner, guest } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true, membersOnly: true });
    expect((await w.call(guest, 'PUT', '/api/ai/keys/me', { apiKey: newKey() })).status).toBe(403);
    await w.call(owner, 'PUT', '/api/admin/ai', { membersOnly: false });
    expect((await w.call(guest, 'PUT', '/api/ai/keys/me', { apiKey: newKey() })).status).toBe(200);
  });

  it.each([
    ['no key', {}],
    ['an unknown field', { apiKey: 'sk-ant-12345678', extra: true }],
    ['a short key', { apiKey: 'abc' }],
    ['a key with a space', { apiKey: 'sk-ant 12345678' }],
    ['an unknown provider', { provider: 'openai-compatible', apiKey: 'sk-ant-12345678' }],
    ['a base URL', { provider: 'anthropic', apiKey: 'sk-ant-12345678', baseUrl: 'https://x.example' }],
    ['a key that is not a string', { apiKey: ['sk-ant-12345678'] }],
  ])('answer 400 to %s, without asking the provider', async (_name, body) => {
    const w = await setup();
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    const res = await w.call(member, 'PUT', '/api/ai/keys/me', body);
    expect(res.status).toBe(400);
    expect(w.providers).toHaveLength(0);
    expect(w.directory.getAiKeyInfo('user', member.user.id)).toBeNull();
  });

  it('store nothing when the provider rejects the key, and keep the old one', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    const first = newKey();
    await w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: first });
    for (const [verify, status, code] of [[rejecting('ai_key_invalid'), 400, 'ai_key_invalid'], [rejecting('ai_rate_limited', 3), 429, 'ai_rate_limited'], [rejecting('ai_unavailable'), 502, 'ai_unavailable']] as const) {
      w.state.verify = verify;
      const res = await w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: newKey() });
      expect([res.status, res.body.error]).toEqual([status, code]);
    }
    expect(w.directory.getAiKeyInfo('user', member.user.id)?.hint).toBe(first.slice(-4));
    expect(auditOf(w, 20).filter((a) => a.action === 'ai.key.set')).toHaveLength(1);
  });

  it('answer ai_unconfigured without a secret', async () => {
    const w = await setup({});
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    const res = await w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: newKey() });
    expect([res.status, res.body.error]).toEqual([409, 'ai_unconfigured']);
    expect(w.providers).toHaveLength(0);
  });

  it('are dropped with the person', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    await w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: newKey() });
    expect(w.directory.getAiKeyInfo('user', member.user.id)).not.toBeNull();
    expect((await w.call(owner, 'DELETE', `/api/members/${member.user.id}`)).status).toBe(204);
    expect(w.directory.getAiKeyInfo('user', member.user.id)).toBeNull();
  });

  it('are offered to the account menu through GET /api/me, only when allowed', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    expect((await w.call(member, 'GET', '/api/me')).body).not.toHaveProperty('ai');
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    expect((await w.call(member, 'GET', '/api/me')).body.ai).toEqual({ personalKeys: true });
  });
});

describe('a change of mind while the provider is being asked', () => {
  it('does not store a workspace key for someone who stopped being an admin meanwhile', async () => {
    const w = await setup();
    const { admin } = people(w);
    w.state.verify = async () => {
      w.directory.updateUser(admin.user.id, { role: 'member' });
    };
    const res = await w.call(admin, 'PUT', '/api/admin/ai', { apiKey: newKey(), enabled: true });
    expect(res.status).toBe(403);
    expect(w.directory.getAiKeyInfo('workspace')).toBeNull();
    expect(w.directory.getSetting('ai.enabled')).toBeNull();
  });

  it('does not store a personal key once personal keys were switched off meanwhile', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    w.state.verify = async () => {
      await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: false });
    };
    const res = await w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: newKey() });
    expect(res.status).toBe(403);
    expect(w.directory.getAiKeyInfo('user', member.user.id)).toBeNull();
  });

  it('does not store a key for someone disabled meanwhile', async () => {
    const w = await setup();
    const { owner, member } = people(w);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
    w.state.verify = async () => {
      w.directory.updateUser(member.user.id, { disabled: true });
    };
    expect((await w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: newKey() })).status).toBe(403);
    expect(w.directory.getAiKeyInfo('user', member.user.id)).toBeNull();
  });
});

const ringOf = (w: World) => createKeyRing({ secret: w.config.ai.secret, previous: w.config.ai.previous });

describe('CANARY: a key set through either endpoint appears nowhere it should not', () => {
  const noise = ['log', 'info', 'warn', 'error', 'debug'] as const;
  let captured: unknown[][] = [];
  beforeEach(() => {
    captured = [];
    for (const name of noise) vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void captured.push(args));
  });
  afterEach(() => vi.restoreAllMocks());

  const render = (value: unknown) => inspect(value, { depth: 10, maxArrayLength: null, maxStringLength: null, showHidden: true });

  it('is in no response, log line, audit row or file', async () => {
    const w = await setup();
    const { owner, admin, member, guest } = people(w);
    const CANARY = `sk-ant-api03-CANARY-${crypto.randomBytes(32).toString('hex')}`;
    const OTHER = `sk-ant-api03-CANARY-${crypto.randomBytes(32).toString('hex')}`;
    const responses: Res[] = [];
    const call = async (...args: Parameters<typeof w.call>) => {
      const res = await w.call(...args);
      responses.push(res);
      return res;
    };
    const leaky = (apiKey: string) => {
      // what a raw SDK error looks like: the headers of the request, the key among them, in the message and as properties
      const err: any = new Error(`401 invalid x-api-key: ${apiKey}`);
      err.status = 401;
      err.headers = { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` };
      err.request = { headers: { 'x-api-key': apiKey } };
      err.error = { message: apiKey };
      return err;
    };

    await call(owner, 'PUT', '/api/admin/ai', { personalKeys: true, enabled: true });

    // set through both endpoints
    expect((await call(owner, 'PUT', '/api/admin/ai', { apiKey: CANARY, provider: 'anthropic', limits: { perPersonHour: 3 } })).status).toBe(200);
    expect((await call(member, 'PUT', '/api/ai/keys/me', { provider: 'anthropic', apiKey: CANARY })).status).toBe(200);
    expect((await call(admin, 'PUT', '/api/ai/keys/me', { provider: 'anthropic', apiKey: OTHER })).status).toBe(200);

    // rejected, rate limited, unreachable, and broken in a way that leaks into the raw error
    for (const verify of [rejecting('ai_key_invalid'), rejecting('ai_rate_limited', 5), rejecting('ai_unavailable'), async () => { throw leaky(CANARY); }, async () => { throw leaky(OTHER); }]) {
      w.state.verify = verify;
      await call(owner, 'PUT', '/api/admin/ai', { apiKey: CANARY });
      await call(member, 'PUT', '/api/ai/keys/me', { apiKey: CANARY });
    }
    w.state.verify = async () => {};

    // invalid requests that carry the key
    await call(owner, 'PUT', '/api/admin/ai', { apiKey: CANARY, model: 'nonsense' });
    await call(owner, 'PUT', '/api/admin/ai', { apiKey: CANARY, extra: 1 });
    await call(owner, 'PUT', '/api/admin/ai', `{"apiKey":"${CANARY}"`);
    await call(owner, 'PUT', '/api/admin/ai', { apiKey: CANARY, baseUrl: 'https://x.example' });
    await call(guest, 'PUT', '/api/ai/keys/me', { apiKey: CANARY });
    await call(null, 'PUT', '/api/ai/keys/me', { apiKey: CANARY });

    // every read that could show it
    for (const who of [owner, admin, member, guest]) {
      await call(who, 'GET', '/api/ai/config');
      await call(who, 'GET', '/api/me');
    }
    await call(owner, 'GET', '/api/admin/ai');
    await call(owner, 'GET', '/api/admin/audit?limit=200');
    await call(owner, 'GET', '/api/admin/audit?limit=200&action=ai.');
    await call(owner, 'GET', '/api/admin/overview');

    // and the ways to remove it
    await call(member, 'DELETE', '/api/ai/keys/me');
    await call(owner, 'DELETE', '/api/admin/ai/key');
    await call(owner, 'PUT', '/api/admin/ai', { apiKey: CANARY });

    expect(responses.length).toBeGreaterThan(30);
    for (const key of [CANARY, OTHER]) {
      for (const res of responses) {
        expect(res.text).not.toContain(key);
        expect([...res.headers.entries()].flat().join('\n')).not.toContain(key);
      }
    }

    // the 500 that came of the leaky error says nothing, and neither does the log
    const leaked = responses.filter((r) => r.status === 500);
    expect(leaked.length).toBeGreaterThanOrEqual(2);
    for (const res of leaked) expect(res.body).toEqual({ error: 'internal', message: 'Something went wrong' });
    expect(w.logged.length).toBeGreaterThanOrEqual(2);
    const logs = render([w.logged, captured]);
    expect(logs).not.toContain(CANARY);
    expect(logs).not.toContain(OTHER);
    expect(logs).not.toMatch(/sk-ant/);
    expect(logs).not.toMatch(/x-api-key/i);
    expect(w.logged.map((l) => l[1]).join('\n')).toMatch(/status=401/);

    // audit rows: scopes and providers, never a key, never its hint
    const audit = JSON.stringify(auditOf(w, 1000));
    expect(audit).not.toContain(CANARY);
    expect(audit).not.toContain(OTHER);
    // the hint is four characters, so it is only looked for where a stray match cannot be a number in a timestamp
    const aiRows = auditOf(w, 1000).filter((a) => a.action.startsWith('ai.'));
    expect(aiRows.length).toBeGreaterThan(4);
    for (const row of aiRows) {
      expect(JSON.stringify(row.detail)).not.toContain(CANARY.slice(-4));
      expect(JSON.stringify(row.detail)).not.toContain(OTHER.slice(-4));
    }

    // the directory file, with its journal, once every handle is closed
    await w.close();
    const bytes = fs.readdirSync(w.dir).map((f) => ({ f, data: fs.readFileSync(path.join(w.dir, f)) }));
    expect(bytes.map((b) => b.f)).toContain('directory.sqlite');
    for (const { data } of bytes) {
      for (const key of [CANARY, OTHER]) {
        expect(data.includes(Buffer.from(key))).toBe(false);
        expect(data.includes(Buffer.from(key.slice(10)))).toBe(false);
        expect(data.includes(Buffer.from(key, 'utf16le'))).toBe(false);
        expect(data.includes(Buffer.from(Buffer.from(key).toString('base64')))).toBe(false);
        expect(data.includes(Buffer.from(Buffer.from(key).toString('hex')))).toBe(false);
      }
    }
  });

  it('is not printed by the logger of an unexpected error either', async () => {
    const w = await setup();
    const { owner } = people(w);
    const CANARY = `sk-ant-api03-CANARY-${crypto.randomBytes(32).toString('hex')}`;
    // a provider that breaks in the middle of the handler and throws a raw SDK error, built by the SDK itself
    w.state.verify = async () => {
      throw Anthropic.APIError.generate(401, { error: { message: CANARY } }, `bad ${CANARY}`, new Headers({ 'x-api-key': CANARY, authorization: `Bearer ${CANARY}` }));
    };
    const res = await w.call(owner, 'PUT', '/api/admin/ai', { apiKey: CANARY });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(CANARY);
    expect(render([w.logged, captured])).not.toContain(CANARY);
    expect(render([w.logged, captured])).toContain('status=401');
  });
});
