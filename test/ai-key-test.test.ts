import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../server/api.mjs';
import { AiError } from '../server/ai/errors.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';

// docs/ai.md, "Keys (BYOK)". The fake provider keeps every check local and uses only test keys.

const SECRET = crypto.randomBytes(32).toString('base64');
const newKey = () => `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;
type Res = { status: number; body: any; headers: Headers; text: string };
type Verify = (apiKey: string) => Promise<void>;

const dirs: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** `dir` lets another server open the same key row with a missing or wrong secret. */
async function setup(env: Record<string, string> = { TABULA_AI_SECRET: SECRET }, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-key-test-'))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const config = loadConfig({ TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', DATA_DIR: dir, TABULA_MAIL: 'file', ...env }, () => {});
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} } });
  const providers: { kind: string; apiKey: string }[] = [];
  const logged: unknown[][] = [];
  const state: { readOnly: boolean; t: number; verify: Verify } = { readOnly: false, t: 1_000_000, verify: async () => {} };
  const createProvider = ({ kind, apiKey }: { kind: string; apiKey: string }) => {
    providers.push({ kind, apiKey });
    return { kind, models: () => [], verify: () => state.verify(apiKey), run: async function* () {} };
  };
  const cloud = {
    limits: () => ({ readOnly: state.readOnly, seatLimit: null, banner: null }),
    workspaceView: () => ({}),
    seatsAvailable: () => true,
    tokenOk: () => false,
  };
  const api = createApi({
    directory,
    auth,
    config,
    roomExists: () => false,
    events: new EventEmitter(),
    mailer: { send: async () => {} },
    cloud: cloud as any,
    ai: { createProvider, log: (...args: unknown[]) => logged.push(args), now: () => state.t },
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    directory.close();
  };
  closes.push(close);

  let n = 0;
  const signIn = (role: 'owner' | 'admin' | 'member' | 'guest') => {
    const user = directory.createUser({ email: `${role}${++n}-${crypto.randomBytes(3).toString('hex')}@example.com`, role })!;
    const session = directory.createSession(user.id, { ttlMs: 3_600_000 });
    return { user, cookie: `${config.cookieName}=${session.token}` };
  };
  async function call(who: { cookie: string } | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-tabula': '1', ...(who ? { cookie: who.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers, text };
  }
  const audit = () => directory.listAudit(200) as unknown as { action: string; detail: Record<string, unknown>; actorId: string | null }[];
  return { dir, config, directory, call, signIn, providers, logged, state, audit, close };
}

type World = Awaited<ReturnType<typeof setup>>;
type Who = ReturnType<World['signIn']>;

const saveWorkspaceKey = (w: World, who: Who, key = newKey()) => w.call(who, 'PUT', '/api/admin/ai', { apiKey: key });
const savePersonalKey = async (w: World, owner: Who, member: Who, key = newKey()) => {
  await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });
  return w.call(member, 'PUT', '/api/ai/keys/me', { apiKey: key });
};

function storedKey(w: World, scope: 'workspace' | 'user', userId?: string) {
  const raw = new DatabaseSync(path.join(w.dir, 'directory.sqlite'));
  const row = scope === 'workspace'
    ? raw.prepare('SELECT ciphertext, nonce, key_version, hint, last_used_at FROM ai_keys WHERE scope = ?').get(scope) as any
    : raw.prepare('SELECT ciphertext, nonce, key_version, hint, last_used_at FROM ai_keys WHERE scope = ? AND user_id = ?').get(scope, userId!) as any;
  raw.close();
  return row ? {
    ciphertext: Buffer.from(row.ciphertext).toString('base64'),
    nonce: Buffer.from(row.nonce).toString('base64'),
    key_version: row.key_version,
    hint: row.hint,
    last_used_at: row.last_used_at,
  } : null;
}

describe('POST /api/admin/ai/key/test and POST /api/ai/keys/me/test', () => {
  it('tests the workspace key and the caller’s personal key without changing either row', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    const member = w.signIn('member');
    const workspaceKey = newKey();
    const personalKey = newKey();
    await saveWorkspaceKey(w, owner, workspaceKey);
    await savePersonalKey(w, owner, member, personalKey);
    const workspaceBefore = storedKey(w, 'workspace');
    const personalBefore = storedKey(w, 'user', member.user.id);

    const workspace = await w.call(owner, 'POST', '/api/admin/ai/key/test', {});
    const personal = await w.call(member, 'POST', '/api/ai/keys/me/test', {});

    expect(workspace).toMatchObject({ status: 200, body: { ok: true, provider: 'anthropic', checkedAt: w.state.t } });
    expect(personal).toMatchObject({ status: 200, body: { ok: true, provider: 'anthropic', checkedAt: w.state.t } });
    expect(w.providers.slice(-2)).toEqual([{ kind: 'anthropic', apiKey: workspaceKey }, { kind: 'anthropic', apiKey: personalKey }]);
    expect(storedKey(w, 'workspace')).toEqual(workspaceBefore);
    expect(storedKey(w, 'user', member.user.id)).toEqual(personalBefore);
    expect(w.audit().filter((row) => row.action === 'ai.key.test').map((row) => row.detail)).toEqual([
      { scope: 'user', provider: 'anthropic', ok: true },
      { scope: 'workspace', provider: 'anthropic', ok: true },
    ]);
  });

  it('returns not_found when there is no stored key', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    const member = w.signIn('member');
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: true });

    const workspace = await w.call(owner, 'POST', '/api/admin/ai/key/test', {});
    const personal = await w.call(member, 'POST', '/api/ai/keys/me/test', {});

    expect([workspace.status, workspace.body.error]).toEqual([404, 'not_found']);
    expect([personal.status, personal.body.error]).toEqual([404, 'not_found']);
    expect(w.providers).toHaveLength(0);
  });

  it('returns ai_unconfigured when a saved key has no current secret', async () => {
    const original = await setup();
    const owner = original.signIn('owner');
    await saveWorkspaceKey(original, owner);
    const dir = original.dir;
    await original.close();
    const withoutSecret = await setup({}, dir);

    const res = await withoutSecret.call(owner, 'POST', '/api/admin/ai/key/test', {});

    expect([res.status, res.body.error]).toEqual([409, 'ai_unconfigured']);
    expect(withoutSecret.providers).toHaveLength(0);
  });

  it('returns ai_key_unreadable when another secret cannot open the key', async () => {
    const original = await setup();
    const owner = original.signIn('owner');
    await saveWorkspaceKey(original, owner);
    const dir = original.dir;
    await original.close();
    const wrongSecret = await setup({ TABULA_AI_SECRET: crypto.randomBytes(32).toString('base64') }, dir);

    const res = await wrongSecret.call(owner, 'POST', '/api/admin/ai/key/test', {});

    expect([res.status, res.body.error]).toEqual([409, 'ai_key_unreadable']);
    expect(wrongSecret.providers).toHaveLength(0);
  });

  it('checks sign-in, admin role and the personal-key setting', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    const member = w.signIn('member');
    await saveWorkspaceKey(w, owner);
    await savePersonalKey(w, owner, member);
    await w.call(owner, 'PUT', '/api/admin/ai', { personalKeys: false });

    const adminRole = await w.call(member, 'POST', '/api/admin/ai/key/test', {});
    const signedOutAdmin = await w.call(null, 'POST', '/api/admin/ai/key/test', {});
    const signedOutPersonal = await w.call(null, 'POST', '/api/ai/keys/me/test', {});
    const personalOff = await w.call(member, 'POST', '/api/ai/keys/me/test', {});

    expect([adminRole.status, adminRole.body.error]).toEqual([403, 'forbidden']);
    expect([signedOutAdmin.status, signedOutAdmin.body.error]).toEqual([401, 'unauthenticated']);
    expect([signedOutPersonal.status, signedOutPersonal.body.error]).toEqual([401, 'unauthenticated']);
    expect([personalOff.status, personalOff.body.error]).toEqual([403, 'forbidden']);
    expect(w.providers).toHaveLength(2); // the two saves only
  });

  it('maps provider failures and does not change the stored key, hint or last-used time', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    const key = newKey();
    await saveWorkspaceKey(w, owner, key);
    const before = storedKey(w, 'workspace');

    w.state.verify = async () => { throw new AiError('ai_key_invalid'); };
    const invalid = await w.call(owner, 'POST', '/api/admin/ai/key/test', {});
    expect([invalid.status, invalid.body.error]).toEqual([400, 'ai_key_invalid']);
    expect(storedKey(w, 'workspace')).toEqual(before);

    w.state.verify = async () => { throw new AiError('ai_rate_limited', { retryAfter: 17 }); };
    const limited = await w.call(owner, 'POST', '/api/admin/ai/key/test', {});
    expect([limited.status, limited.body.error, limited.headers.get('retry-after')]).toEqual([429, 'ai_rate_limited', '17']);

    w.state.verify = async () => { throw new AiError('ai_unavailable'); };
    const unavailable = await w.call(owner, 'POST', '/api/admin/ai/key/test', {});
    expect([unavailable.status, unavailable.body.error]).toEqual([502, 'ai_unavailable']);
    expect(storedKey(w, 'workspace')).toEqual(before);
    expect(w.audit().filter((row) => row.action === 'ai.key.test').map((row) => row.detail)).toEqual([
      { scope: 'workspace', provider: 'anthropic', ok: false },
      { scope: 'workspace', provider: 'anthropic', ok: false },
      { scope: 'workspace', provider: 'anthropic', ok: false },
    ]);
  });

  it('shares the ten-check hourly throttle with key saves', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    for (let i = 0; i < 10; i++) await saveWorkspaceKey(w, owner);

    const res = await w.call(owner, 'POST', '/api/admin/ai/key/test', {});

    expect([res.status, res.body.error]).toEqual([429, 'rate_limited']);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(w.providers).toHaveLength(10);
  });

  it('keeps a canary key out of responses, headers, logs and audit rows', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    const key = `sk-ant-api03-CANARY-${crypto.randomBytes(24).toString('hex')}`;
    const responses: Res[] = [];
    const call = async (...args: Parameters<typeof w.call>) => {
      const res = await w.call(...args);
      responses.push(res);
      return res;
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await call(owner, 'PUT', '/api/admin/ai', { apiKey: key });

    w.state.verify = async () => {
      const err: any = new Error(`Provider rejected key ${key}`);
      err.status = 401;
      err.headers = { 'x-api-key': key, authorization: `Bearer ${key}` };
      err.requestID = 'fake-request';
      throw err;
    };
    await call(owner, 'POST', '/api/admin/ai/key/test', {});
    await call(owner, 'GET', '/api/admin/ai');
    await call(owner, 'GET', '/api/admin/audit?limit=200');

    for (const res of responses) {
      expect(res.text).not.toContain(key);
      expect([...res.headers.entries()].flat().join('\n')).not.toContain(key);
    }
    expect(JSON.stringify([w.logged, consoleError.mock.calls, w.audit()])).not.toContain(key);
    const tested = w.audit().filter((row) => row.action === 'ai.key.test');
    expect(tested.map((row) => row.detail)).toEqual([{ scope: 'workspace', provider: 'anthropic', ok: false }]);
    expect(JSON.stringify(tested)).not.toContain('hint');
  });

  it('works while a hosted workspace is read-only', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    const member = w.signIn('member');
    await saveWorkspaceKey(w, owner);
    await savePersonalKey(w, owner, member);
    w.state.readOnly = true;

    expect((await w.call(owner, 'POST', '/api/admin/ai/key/test', {})).status).toBe(200);
    expect((await w.call(member, 'POST', '/api/ai/keys/me/test', {})).status).toBe(200);
  });

  it('re-checks the caller after the provider call', async () => {
    const w = await setup();
    const owner = w.signIn('owner');
    const admin = w.signIn('admin');
    await saveWorkspaceKey(w, owner);
    w.state.verify = async () => {
      w.directory.updateUser(admin.user.id, { disabled: true });
    };

    const res = await w.call(admin, 'POST', '/api/admin/ai/key/test', {});

    expect([res.status, res.body.error]).toEqual([403, 'forbidden']);
    expect(w.audit().filter((row) => row.action === 'ai.key.test')).toEqual([]);
  });
});
