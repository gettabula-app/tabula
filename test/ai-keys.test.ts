import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiError } from '../server/ai/errors.mjs';
import { AI_KEYS_MIGRATION, createKeyRing, parseSecret } from '../server/ai/keys.mjs';
import { loadConfig } from '../server/config.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';

// docs/ai.md, "Keys (BYOK)". Secrets are generated here and never read from the environment or a .env file.

const secret = () => crypto.randomBytes(32);
// The key version is one byte of an HMAC of the secret, so two random secrets share one 1 time in 256. A test that
// needs the versions to differ (or to be equal) draws until they do.
const versionOf = (s: Buffer) => createKeyRing({ secret: s }).currentVersion;
const secretWhere = (old: Buffer, sameVersion: boolean) => {
  for (;;) {
    const next = secret();
    if ((versionOf(next) === versionOf(old)) === sameVersion) return next;
  }
};
const secretOtherThan = (old: Buffer) => secretWhere(old, false);
const secretLike = (old: Buffer) => secretWhere(old, true);
const b64 = (buf: Buffer) => buf.toString('base64');
const KEY = `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const person = (d: ReturnType<typeof openDirectory>, role: 'owner' | 'admin' | 'member' | 'guest' = 'member') =>
  d.createUser({ email: `person${++n}@example.com`, role })!;

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a failure');
};

const failureCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return (err as AiError).code;
  }
  throw new Error('expected a failure');
};

describe('TABULA_AI_SECRET', () => {
  it('reads 32 bytes of base64', () => {
    const bytes = secret();
    expect(parseSecret(b64(bytes), 'TABULA_AI_SECRET')!.equals(bytes)).toBe(true);
    expect(parseSecret(`  ${b64(bytes)}\n`, 'TABULA_AI_SECRET')!.equals(bytes)).toBe(true);
  });

  it('is null when unset or blank', () => {
    expect(parseSecret(undefined, 'TABULA_AI_SECRET')).toBeNull();
    expect(parseSecret('', 'TABULA_AI_SECRET')).toBeNull();
    expect(parseSecret('   ', 'TABULA_AI_SECRET')).toBeNull();
  });

  it.each([
    ['not base64', 'this is not base64 at all, no way'],
    ['too short', b64(crypto.randomBytes(16))],
    ['too long', b64(crypto.randomBytes(33))],
    ['31 bytes', b64(crypto.randomBytes(31))],
    ['base64url', b64(secret()).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '-_'],
    ['hex', crypto.randomBytes(32).toString('hex')],
    ['unpadded', b64(secret()).replace(/=+$/, '')],
  ])('refuses a secret that is %s, without printing it', (_name, value) => {
    let thrown: Error | undefined;
    try {
      parseSecret(value, 'TABULA_AI_SECRET');
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toContain('TABULA_AI_SECRET must be 32 random bytes encoded as base64');
    expect(thrown?.message).not.toContain(value);
    expect(thrown?.stack).not.toContain(value);
  });
});

describe('the configuration', () => {
  const AUTH = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com' };
  const load = (env: Record<string, string>, warn = vi.fn<(m: string) => void>()) => ({ config: loadConfig(env, warn), warn });

  it('has AI off with the defaults when nothing is set', () => {
    const { config, warn } = load({});
    expect(config.ai.provider).toBe('anthropic');
    expect(config.ai.model).toBe('claude-opus-5-5');
    expect(config.ai.secret).toBeNull();
    expect(config.ai.previous).toBeNull();
    expect(config.ai.open).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to start with a malformed secret and says which variable, not its value', () => {
    for (const name of ['TABULA_AI_SECRET', 'TABULA_AI_SECRET_PREVIOUS']) {
      const bad = 'Zm9v-definitely-malformed';
      const env = { ...(name === 'TABULA_AI_SECRET_PREVIOUS' ? { TABULA_AI_SECRET: b64(secret()) } : {}), [name]: bad };
      expect(() => loadConfig(env, () => {})).toThrow(`${name} must be 32 random bytes encoded as base64`);
      expect(messageOf(() => loadConfig(env, () => {}))).not.toContain(bad);
    }
    expect(() => loadConfig({ ...AUTH, TABULA_AI_SECRET: 'short' }, () => {})).toThrow('TABULA_AI_SECRET');
  });

  it('wants the current secret whenever a previous one is set', () => {
    expect(() => loadConfig({ TABULA_AI_SECRET_PREVIOUS: b64(secret()) }, () => {})).toThrow('TABULA_AI_SECRET_PREVIOUS needs TABULA_AI_SECRET');
    const current = secret();
    const previous = secret();
    const { config } = load({ TABULA_AI_SECRET: b64(current), TABULA_AI_SECRET_PREVIOUS: b64(previous) });
    expect(config.ai.secret.equals(current)).toBe(true);
    expect(config.ai.previous.equals(previous)).toBe(true);
  });

  it('checks the provider and the model', () => {
    expect(() => loadConfig({ TABULA_AI_PROVIDER: 'openai-compatible' }, () => {})).toThrow('TABULA_AI_PROVIDER must be one of anthropic');
    expect(() => loadConfig({ TABULA_AI_MODEL: 'claude-opus-5' }, () => {})).toThrow('TABULA_AI_MODEL must be one of');
    expect(load({ TABULA_AI_PROVIDER: 'anthropic', TABULA_AI_MODEL: 'claude-haiku-5-5' }).config.ai.model).toBe('claude-haiku-5-5');
    expect(() => loadConfig({ TABULA_AI_OPEN: 'yes' }, () => {})).toThrow('TABULA_AI_OPEN must be 1 or 0');
    expect(() => loadConfig({ TABULA_AI_API_KEY: 'two words here' }, () => {})).toThrow('TABULA_AI_API_KEY must be 8 to 512 characters');
  });

  describe('open mode', () => {
    it('is off with a key alone, and says why', () => {
      const { config, warn } = load({ TABULA_AI_API_KEY: KEY });
      expect(config.ai.open).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('TABULA_AI_OPEN');
      expect(warn.mock.calls[0][0]).not.toContain(KEY);
    });

    it('is off with the switch alone', () => {
      const { config, warn } = load({ TABULA_AI_OPEN: '1' });
      expect(config.ai.open).toBeNull();
      expect(warn.mock.calls[0][0]).toContain('TABULA_AI_API_KEY');
    });

    it('is on only with both', () => {
      const { config, warn } = load({ TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1' });
      expect(config.ai.open!.apiKey).toBe(KEY);
      expect(warn).not.toHaveBeenCalled();
      expect(load({ TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '0' }).config.ai.open).toBeNull();
    });

    it('honours the old MIRA_ spelling', () => {
      const { config, warn } = load({ MIRA_AI_API_KEY: KEY, MIRA_AI_OPEN: '1', MIRA_AI_MODEL: 'claude-sonnet-5-5' });
      expect(config.ai.open!.apiKey).toBe(KEY);
      expect(config.ai.model).toBe('claude-sonnet-5-5');
      expect(warn.mock.calls.some(([m]) => String(m).includes('MIRA_AI_API_KEY (use TABULA_AI_API_KEY)'))).toBe(true);
    });
  });

  it('ignores the operator key in accounts mode, where the key is set in the dashboard', () => {
    const { config, warn } = load({ ...AUTH, TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1' });
    expect(config.ai.open).toBeNull();
    expect(warn.mock.calls[0][0]).toContain('ignored in accounts mode');
  });

  it('keeps the secrets out of anything that prints or serialises the config', () => {
    const current = secret();
    const previous = secret();
    const { config } = load({ TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1', TABULA_AI_SECRET: b64(current), TABULA_AI_SECRET_PREVIOUS: b64(previous) });
    const shown = [JSON.stringify(config), inspect(config, { depth: 6 }), String(Object.keys(config.ai))].join('\n');
    for (const hidden of [KEY, b64(current), b64(previous), current.toString('hex'), previous.toString('hex')]) expect(shown).not.toContain(hidden);
    expect(shown).not.toContain(JSON.stringify(current.toJSON()));
    expect(config.ai.secret.equals(current)).toBe(true);
  });
});

describe('the key ring', () => {
  const scope = { scope: 'user', userId: 'u1' };
  const seal = (ring: ReturnType<typeof createKeyRing>, where = scope) => ({ ...where, ...ring.seal(where, KEY) });

  it('seals and opens a key, with a version byte up front and a fresh nonce each time', () => {
    const ring = createKeyRing({ secret: secret() });
    expect(ring.configured).toBe(true);
    const a = seal(ring);
    const b = seal(ring);
    expect(a.keyVersion).toBe(ring.currentVersion);
    expect(a.ciphertext[0]).toBe(a.keyVersion);
    expect(a.ciphertext.length).toBe(1 + KEY.length + 16);
    expect(a.nonce.length).toBe(12);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.includes(Buffer.from(KEY))).toBe(false);
    expect(ring.open(a)).toEqual({ plaintext: KEY, stale: false });
    expect(ring.open({ ...b, ciphertext: new Uint8Array(b.ciphertext), nonce: new Uint8Array(b.nonce) }).plaintext).toBe(KEY);
  });

  it('binds a ciphertext to its scope and its user', () => {
    const ring = createKeyRing({ secret: secret() });
    const mine = seal(ring);
    expect(failureCode(() => ring.open({ ...mine, userId: 'u2' }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...mine, userId: null }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...mine, scope: 'workspace' }))).toBe('ai_key_unreadable');
    const shared = seal(ring, { scope: 'workspace', userId: null as unknown as string });
    expect(ring.open(shared).plaintext).toBe(KEY);
    expect(failureCode(() => ring.open({ ...shared, scope: 'user', userId: 'u1' }))).toBe('ai_key_unreadable');
  });

  it('fails on a tampered ciphertext, nonce or version', () => {
    const ring = createKeyRing({ secret: secret() });
    const good = seal(ring);
    const flipped = (buf: Buffer, at: number) => {
      const copy = Buffer.from(buf);
      copy[at] ^= 1;
      return copy;
    };
    for (const at of [1, 5, good.ciphertext.length - 1]) expect(failureCode(() => ring.open({ ...good, ciphertext: flipped(good.ciphertext, at) }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...good, nonce: flipped(good.nonce, 0) }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...good, nonce: good.nonce.subarray(1) }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...good, keyVersion: (good.keyVersion + 1) % 256 }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...good, ciphertext: flipped(good.ciphertext, 0) }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...good, ciphertext: good.ciphertext.subarray(0, 10) }))).toBe('ai_key_unreadable');
    expect(failureCode(() => ring.open({ ...good, ciphertext: Buffer.alloc(0) }))).toBe('ai_key_unreadable');
  });

  it('does not open under another secret', () => {
    const good = seal(createKeyRing({ secret: secret() }));
    expect(failureCode(() => createKeyRing({ secret: secret() }).open(good))).toBe('ai_key_unreadable');
  });

  it('opens what the previous secret wrote and says so, so it can be sealed again', () => {
    const oldSecret = secret();
    const newSecret = secretOtherThan(oldSecret);
    const written = seal(createKeyRing({ secret: oldSecret }));
    const rotated = createKeyRing({ secret: newSecret, previous: oldSecret });
    expect(rotated.currentVersion).not.toBe(written.keyVersion);
    expect(rotated.open(written)).toEqual({ plaintext: KEY, stale: true });
    const again = seal(rotated);
    expect(rotated.open(again).stale).toBe(false);
    expect(createKeyRing({ secret: newSecret }).open(again).plaintext).toBe(KEY);
    expect(failureCode(() => createKeyRing({ secret: newSecret }).open(written))).toBe('ai_key_unreadable');
  });

  it('opens what the previous secret wrote, and seals it again, when both secrets have the same version byte', () => {
    const oldSecret = secret();
    const newSecret = secretLike(oldSecret);
    const written = seal(createKeyRing({ secret: oldSecret }));
    const rotated = createKeyRing({ secret: newSecret, previous: oldSecret });
    expect(rotated.currentVersion).toBe(written.keyVersion);
    expect(rotated.open(written)).toEqual({ plaintext: KEY, stale: true });
    const again = seal(rotated);
    expect(again.keyVersion).toBe(written.keyVersion);
    expect(rotated.open(again).stale).toBe(false);
    expect(createKeyRing({ secret: newSecret }).open(again).plaintext).toBe(KEY);
    expect(failureCode(() => createKeyRing({ secret: newSecret }).open(written))).toBe('ai_key_unreadable');
  });

  it('seals nothing without a secret', () => {
    const ring = createKeyRing({});
    expect(ring.configured).toBe(false);
    expect(failureCode(() => ring.seal(scope, KEY))).toBe('ai_unconfigured');
    expect(failureCode(() => ring.open({ ...scope, ciphertext: Buffer.alloc(40), nonce: Buffer.alloc(12), keyVersion: 0 }))).toBe('ai_unconfigured');
    expect(createKeyRing({ secret: null, previous: secret() }).configured).toBe(false);
  });

  it('copes with a previous secret that equals the current one', () => {
    const same = secret();
    const ring = createKeyRing({ secret: same, previous: Buffer.from(same) });
    expect(ring.open(seal(ring)).stale).toBe(false);
  });
});

describe('the ai_keys table', () => {
  it('is migration 7 and keeps what an older directory holds', () => {
    expect(MIGRATIONS[6]).toBe(AI_KEYS_MIGRATION);
    const file = path.join(tmp(), 'directory.sqlite');
    const d = openDirectory(file);
    const u = person(d, 'owner');
    d.createBoard({ id: 'board1', title: 'Kept', ownerId: u.id });
    d.close();
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE ai_keys; PRAGMA user_version = 6');
    raw.close();

    const again = openDirectory(file);
    expect(again.getBoard('board1')?.title).toBe('Kept');
    expect(again.getAiKeyInfo('workspace')).toBeNull();
    again.close();
    const check = new DatabaseSync(file);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7);
    check.close();
  });

  it('allows one workspace row and one row per person, whatever the code does', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = openDirectory(file);
    const a = person(d);
    const b = person(d);
    d.close();
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    const insert = (id: string, scope: string, userId: string | null) =>
      raw.prepare("INSERT INTO ai_keys (id, scope, user_id, provider, ciphertext, nonce, key_version, hint, created_at) VALUES (?, ?, ?, 'anthropic', x'00', x'00', 1, 'abcd', 1)").run(id, scope, userId);
    insert('w1', 'workspace', null);
    expect(() => insert('w2', 'workspace', null)).toThrow(/UNIQUE/);
    insert('u1', 'user', a.id);
    insert('u2', 'user', b.id);
    expect(() => insert('u3', 'user', a.id)).toThrow(/UNIQUE/);
    expect(() => insert('x1', 'user', null)).toThrow(/CHECK/);
    expect(() => insert('x2', 'workspace', a.id)).toThrow(/CHECK/);
    expect(() => insert('x3', 'team', null)).toThrow(/CHECK/);
    expect(() => insert('x4', 'user', 'nobody')).toThrow(/FOREIGN KEY/);
    raw.close();
  });
});

describe('storing keys', () => {
  const open = (file = ':memory:') => openDirectory(file);

  it('keeps one row per owner and shows back only the provider, the hint and the dates', () => {
    const d = open();
    const u = person(d);
    const ring = createKeyRing({ secret: secret() });
    expect(d.getAiKeyInfo('workspace')).toBeNull();
    expect(d.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: KEY, createdBy: u.id, now: 1000 })).toEqual({ provider: 'anthropic', hint: KEY.slice(-4) });
    d.saveAiKey({ ring, scope: 'user', userId: u.id, provider: 'anthropic', apiKey: `${KEY}-mine`, createdBy: u.id, now: 2000 });
    expect(d.getAiKeyInfo('workspace')).toEqual({ provider: 'anthropic', baseUrl: null, hint: KEY.slice(-4), createdAt: 1000, createdBy: u.id, lastUsedAt: null });
    expect(d.getAiKeyInfo('user', u.id)).toMatchObject({ hint: 'mine', createdAt: 2000 });
    expect(JSON.stringify([d.getAiKeyInfo('workspace'), d.getAiKeyInfo('user', u.id)])).not.toContain(KEY);

    d.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: `${KEY}-second`, createdBy: u.id, now: 3000 });
    expect(d.getAiKeyInfo('workspace')).toMatchObject({ hint: 'cond', createdAt: 3000 });
    expect(d.useAiKey({ ring, scope: 'workspace' })!.apiKey).toBe(`${KEY}-second`);
    d.close();
  });

  it('refuses to save without a secret and stores nothing', () => {
    const d = open();
    const u = person(d);
    const ring = createKeyRing({});
    expect(failureCode(() => d.saveAiKey({ ring, scope: 'user', userId: u.id, provider: 'anthropic', apiKey: KEY }))).toBe('ai_unconfigured');
    expect(failureCode(() => d.saveAiKey({ ring: undefined, scope: 'workspace', provider: 'anthropic', apiKey: KEY }))).toBe('ai_unconfigured');
    expect(d.getAiKeyInfo('user', u.id)).toBeNull();
    expect(d.getAiKeyInfo('workspace')).toBeNull();
    d.close();
  });

  it('rejects an owner that does not fit its scope', () => {
    const d = open();
    const ring = createKeyRing({ secret: secret() });
    expect(() => d.saveAiKey({ ring, scope: 'user', provider: 'anthropic', apiKey: KEY })).toThrow('invalid key owner');
    expect(() => d.saveAiKey({ ring, scope: 'workspace', userId: 'u1', provider: 'anthropic', apiKey: KEY })).toThrow('invalid key owner');
    expect(() => d.getAiKeyInfo('team')).toThrow('invalid key owner');
    d.close();
  });

  it('deletes a key, and reports whether there was one', () => {
    const d = open();
    const u = person(d);
    const ring = createKeyRing({ secret: secret() });
    d.saveAiKey({ ring, scope: 'user', userId: u.id, provider: 'anthropic', apiKey: KEY });
    expect(d.deleteAiKey('user', u.id)).toBe(true);
    expect(d.deleteAiKey('user', u.id)).toBe(false);
    expect(d.getAiKeyInfo('user', u.id)).toBeNull();
    expect(d.useAiKey({ ring, scope: 'user', userId: u.id })).toBeNull();
    d.close();
  });

  it('goes with the person: removing a user removes their key, and only theirs', () => {
    const d = open();
    const gone = person(d);
    const stays = person(d);
    const admin = person(d, 'admin');
    const ring = createKeyRing({ secret: secret() });
    d.saveAiKey({ ring, scope: 'user', userId: gone.id, provider: 'anthropic', apiKey: KEY });
    d.saveAiKey({ ring, scope: 'user', userId: stays.id, provider: 'anthropic', apiKey: KEY });
    d.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: KEY, createdBy: admin.id });
    d.removeUser(gone.id);
    expect(d.getAiKeyInfo('user', gone.id)).toBeNull();
    expect(d.getAiKeyInfo('user', stays.id)).not.toBeNull();
    d.removeUser(admin.id);
    expect(d.getAiKeyInfo('workspace')).toMatchObject({ createdBy: null });
    d.close();
  });

  it('notes the use of a key', () => {
    const d = open();
    const ring = createKeyRing({ secret: secret() });
    d.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: KEY });
    expect(d.useAiKey({ ring, scope: 'workspace', now: 5000 })).toEqual({ provider: 'anthropic', baseUrl: null, apiKey: KEY });
    expect(d.getAiKeyInfo('workspace')?.lastUsedAt).toBe(5000);
    d.close();
  });

  it('seals a key written under the previous secret again, under the current one, on its next use', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const oldSecret = secret();
    const newSecret = secretOtherThan(oldSecret);
    const d = open(file);
    const u = person(d);
    d.saveAiKey({ ring: createKeyRing({ secret: oldSecret }), scope: 'user', userId: u.id, provider: 'anthropic', apiKey: KEY });
    const rotated = createKeyRing({ secret: newSecret, previous: oldSecret });
    const onlyNew = createKeyRing({ secret: newSecret });

    expect(d.aiKeyReadable({ ring: onlyNew, scope: 'user', userId: u.id })).toBe(false);
    expect(failureCode(() => d.useAiKey({ ring: onlyNew, scope: 'user', userId: u.id }))).toBe('ai_key_unreadable');
    expect(d.aiKeyReadable({ ring: rotated, scope: 'user', userId: u.id })).toBe(true);

    const versionOf = () => {
      const raw = new DatabaseSync(file);
      const row = raw.prepare('SELECT key_version, ciphertext FROM ai_keys').get() as { key_version: number; ciphertext: Uint8Array };
      raw.close();
      return { version: row.key_version, first: row.ciphertext[0] };
    };
    const before = versionOf();
    expect(before.version).not.toBe(rotated.currentVersion);

    expect(d.useAiKey({ ring: rotated, scope: 'user', userId: u.id })!.apiKey).toBe(KEY);
    const after = versionOf();
    expect(after).toEqual({ version: rotated.currentVersion, first: rotated.currentVersion });
    // the old secret is no longer needed
    expect(d.useAiKey({ ring: onlyNew, scope: 'user', userId: u.id })!.apiKey).toBe(KEY);
    d.close();
  });

  it('does not open a ciphertext that was copied onto another row', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = open(file);
    const a = person(d);
    const b = person(d);
    const ring = createKeyRing({ secret: secret() });
    d.saveAiKey({ ring, scope: 'user', userId: a.id, provider: 'anthropic', apiKey: KEY });
    d.saveAiKey({ ring, scope: 'user', userId: b.id, provider: 'anthropic', apiKey: 'sk-ant-other-key-1234' });
    d.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: 'sk-ant-workspace-key-5678' });

    const raw = new DatabaseSync(file);
    const mine = raw.prepare('SELECT ciphertext, nonce, key_version FROM ai_keys WHERE user_id = ?').get(a.id) as any;
    raw.prepare('UPDATE ai_keys SET ciphertext = ?, nonce = ?, key_version = ? WHERE user_id = ?').run(mine.ciphertext, mine.nonce, mine.key_version, b.id);
    raw.prepare('UPDATE ai_keys SET ciphertext = ?, nonce = ?, key_version = ? WHERE scope = ?').run(mine.ciphertext, mine.nonce, mine.key_version, 'workspace');
    raw.close();

    expect(d.aiKeyReadable({ ring, scope: 'user', userId: a.id })).toBe(true);
    expect(d.aiKeyReadable({ ring, scope: 'user', userId: b.id })).toBe(false);
    expect(d.aiKeyReadable({ ring, scope: 'workspace' })).toBe(false);
    expect(failureCode(() => d.useAiKey({ ring, scope: 'user', userId: b.id }))).toBe('ai_key_unreadable');
    expect(failureCode(() => d.useAiKey({ ring, scope: 'workspace' }))).toBe('ai_key_unreadable');
    d.close();
  });

  it('does not open a tampered row, and says so without the key', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = open(file);
    const u = person(d);
    const ring = createKeyRing({ secret: secret() });
    d.saveAiKey({ ring, scope: 'user', userId: u.id, provider: 'anthropic', apiKey: KEY });
    const raw = new DatabaseSync(file);
    const row = raw.prepare('SELECT ciphertext FROM ai_keys').get() as { ciphertext: Uint8Array };
    const bad = Buffer.from(row.ciphertext);
    bad[bad.length - 1] ^= 1;
    raw.prepare('UPDATE ai_keys SET ciphertext = ?').run(bad);
    raw.close();
    expect(failureCode(() => d.useAiKey({ ring, scope: 'user', userId: u.id }))).toBe('ai_key_unreadable');
    expect(messageOf(() => d.useAiKey({ ring, scope: 'user', userId: u.id }))).not.toContain(KEY);
    d.close();
  });

  it('puts no part of the key in the database file', () => {
    const dir = tmp();
    const d = open(path.join(dir, 'directory.sqlite'));
    const u = person(d);
    const ring = createKeyRing({ secret: secret() });
    d.saveAiKey({ ring, scope: 'user', userId: u.id, provider: 'anthropic', apiKey: KEY });
    d.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: KEY });
    d.close();
    const bytes = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)));
    expect(bytes.length).toBeGreaterThan(0);
    for (const b of bytes) {
      expect(b.includes(Buffer.from(KEY))).toBe(false);
      expect(b.includes(Buffer.from(KEY.slice(0, 20)))).toBe(false);
    }
  });
});
