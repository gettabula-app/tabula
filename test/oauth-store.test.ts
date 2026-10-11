import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { loadOAuthSecret } from '../server/instance-secret.mjs';
import { createClientAwareLimiter } from '../server/limiter.mjs';
import { OAUTH_ACCESS_TTL_MS, OAUTH_CODE_TTL_MS, OAUTH_GRANT_RETENTION_MS, OAUTH_GRANT_TTL_MS, OAUTH_MIGRATION, OAUTH_REPLAY_TTL_MS, OAUTH_SCOPES, OAUTH_UNUSED_CLIENT_TTL_MS, OAUTH_USED_CLIENT_TTL_MS, TOKEN_PREFIX_OAUTH, verifyAuthorizeEnvelope } from '../server/oauth.mjs';
import { isWindows } from './platform';

const T0 = 1_800_000_000_000;
const SECRET = Buffer.alloc(32, 0x31);
const directories: ReturnType<typeof openDirectory>[] = [];
const temporary: string[] = [];

function directory(secret = SECRET) {
  const value = openDirectory(':memory:', { oauthSecret: secret });
  directories.push(value);
  return value;
}

function client(d: ReturnType<typeof openDirectory>, name = 'Claude') {
  return d.registerClient({
    name,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    maxScope: 'write',
    now: T0,
  }).client!;
}

function grant(d: ReturnType<typeof openDirectory>, options: { scope?: 'read' | 'comment' | 'write'; userId?: string } = {}) {
  const person = d.createUser({ email: `oauth-${Math.random().toString(36).slice(2)}@example.com`, role: 'member' })!;
  const registered = client(d);
  return {
    person,
    registered,
    value: d.createGrant({
      clientId: registered.clientId,
      userId: options.userId ?? person.id,
      scope: options.scope ?? 'write',
      boardIds: null,
      resource: 'https://tabula.example/mcp',
      now: T0,
    }),
  };
}

afterEach(() => {
  for (const d of directories.splice(0)) d.close();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OAuth store migration and persistence', () => {
  it('applies migration 16 with cascading user foreign keys and unique token digests', () => {
    const d = directory();
    expect(MIGRATIONS).toHaveLength(16);
    expect(MIGRATIONS[15]).toMatchObject({ sql: OAUTH_MIGRATION, minReader: 11 });
    expect(d.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 });

    const fixture = grant(d);
    const pair = d.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    expect(pair.accessToken).toMatch(new RegExp(`^${TOKEN_PREFIX_OAUTH}[A-Za-z0-9_-]{43}$`));
    const tokenHash = d.db.prepare("SELECT token_hash FROM oauth_tokens WHERE kind = 'access'").get()!.token_hash;
    expect(() => d.db.prepare(
      `INSERT INTO oauth_tokens (id, grant_id, kind, token_hash, scope, created_at, expires_at)
       VALUES ('duplicate-token', ?, 'access', ?, 'read', ?, ?)`,
    ).run(fixture.value.id, tokenHash, T0, T0 + OAUTH_ACCESS_TTL_MS)).toThrow(/UNIQUE/);

    const foreignKeys = d.db.prepare("PRAGMA foreign_key_list('oauth_grants')").all() as unknown as { from: string; table: string; on_delete: string }[];
    const userFk = foreignKeys.find((row) => row.from === 'user_id');
    expect(userFk).toMatchObject({ table: 'users', on_delete: 'CASCADE' });
    d.db.prepare('DELETE FROM users WHERE id = ?').run(fixture.person.id);
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM oauth_grants').get()).toEqual({ n: 0 });
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 });
  });

  it('stores authorization codes as digests, consumes each once, and enforces 60 seconds', () => {
    const d = directory();
    const fixture = grant(d);
    const challenge = crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url');
    const issued = d.issueCode({
      grantId: fixture.value.id,
      clientId: fixture.registered.clientId,
      redirectUri: fixture.registered.redirectUris[0],
      codeChallenge: challenge,
      scope: 'write',
      resource: 'https://tabula.example/mcp',
      now: T0,
    });
    expect(issued.expiresAt).toBe(T0 + OAUTH_CODE_TTL_MS);
    const digest = d.db.prepare('SELECT code_hash FROM oauth_codes').get()!.code_hash;
    expect(digest).not.toContain(issued.code);
    expect(() => d.db.prepare(
      `INSERT INTO oauth_codes (code_hash, request_id, grant_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES (?, 'duplicate-request', ?, ?, ?, ?, 'write', ?, ?)`,
    ).run(digest, fixture.value.id, fixture.registered.clientId, fixture.registered.redirectUris[0], challenge, 'https://tabula.example/mcp', T0 + 1)).toThrow(/UNIQUE/);

    expect(d.consumeCode(issued.code, T0)).toMatchObject({ clientId: fixture.registered.clientId, scope: 'write' });
    expect(d.consumeCode(issued.code, T0 + 1)).toMatchObject({ reused: true, grantId: fixture.value.id });
    expect(d.getGrant(fixture.value.id)?.revokedAt).toBe(T0 + 1);

    const another = grant(d);
    const expires = d.issueCode({
      grantId: another.value.id,
      clientId: another.registered.clientId,
      redirectUri: another.registered.redirectUris[0],
      codeChallenge: challenge,
      scope: 'write',
      resource: 'https://tabula.example/mcp',
      now: T0,
    });
    expect(d.consumeCode(expires.code, T0 + OAUTH_CODE_TTL_MS)).toBeNull();

    const replayed = grant(d);
    const used = d.issueCode({
      grantId: replayed.value.id,
      clientId: replayed.registered.clientId,
      redirectUri: replayed.registered.redirectUris[0],
      codeChallenge: challenge,
      scope: 'write',
      resource: 'https://tabula.example/mcp',
      now: T0,
    });
    d.consumeCode(used.code, T0);
    expect(d.consumeCode(used.code, T0 + OAUTH_CODE_TTL_MS + 1)).toMatchObject({ reused: true, grantId: replayed.value.id });
    expect(d.getGrant(replayed.value.id)?.revokedAt).toBe(T0 + OAUTH_CODE_TTL_MS + 1);
  });

  it('retains used clients after grant cleanup and expires both client classes from last use', () => {
    const d = directory();
    const fixture = grant(d);
    const activityAt = T0 + 10 * 24 * 60 * 60 * 1000;
    expect(d.touchGrant(fixture.value.id, activityAt)).toBe(true);
    d.revokeGrant(fixture.value.id, 'self', activityAt);
    d.cleanup(activityAt + OAUTH_GRANT_RETENTION_MS);
    expect(d.getGrant(fixture.value.id)).toBeNull();
    expect(d.getClient(fixture.registered.clientId, activityAt + OAUTH_GRANT_RETENTION_MS)).not.toBeNull();

    const reregisteredAt = activityAt + OAUTH_GRANT_RETENTION_MS;
    const repeated = d.registerClient({
      name: fixture.registered.name,
      redirectUris: fixture.registered.redirectUris,
      maxScope: 'write',
      now: reregisteredAt,
    });
    expect(repeated.created).toBe(false);
    expect(d.getClient(fixture.registered.clientId, reregisteredAt + OAUTH_USED_CLIENT_TTL_MS - 1)).not.toBeNull();
    expect(d.getClient(fixture.registered.clientId, reregisteredAt + OAUTH_USED_CLIENT_TTL_MS)).toBeNull();

    const unused = client(d, 'Unused');
    expect(d.getClient(unused.clientId, T0 + OAUTH_UNUSED_CLIENT_TTL_MS)).toBeNull();
  });

  it('encrypts the replacement pair for one replay and erases it when used', () => {
    const d = directory();
    const fixture = grant(d);
    const first = d.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    const rotated = d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: T0 + 1 });
    expect(rotated).toHaveProperty('accessToken');
    const cached = d.db.prepare("SELECT replay_ciphertext, replay_until FROM oauth_tokens WHERE token_hash = ?").get(
      crypto.createHash('sha256').update(first.refreshToken).digest('hex'),
    )!;
    expect(cached.replay_until).toBe(T0 + 1 + OAUTH_REPLAY_TTL_MS);
    expect(cached.replay_ciphertext).toBeTruthy();
    expect(cached.replay_ciphertext).not.toContain(rotated.accessToken);
    expect(cached.replay_ciphertext).not.toContain(rotated.refreshToken);

    const replay = d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: T0 + 2 });
    expect(replay).toEqual(rotated);
    expect(d.db.prepare('SELECT replay_ciphertext, replay_until, replay_count FROM oauth_tokens WHERE token_hash = ?')
      .get(crypto.createHash('sha256').update(first.refreshToken).digest('hex')))
      .toEqual({ replay_ciphertext: null, replay_until: null, replay_count: 1 });
    expect(d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: T0 + 3 }))
      .toMatchObject({ error: 'reuse' });
    expect(d.findOauthAccessToken(rotated.accessToken, T0 + 3)).toBeNull();
  });

  it('revokes one family, all grants for a user, and all active instance grants', () => {
    const d = directory();
    const person = d.createUser({ email: 'oauth-revoke@example.com', role: 'member' })!;
    const firstClient = client(d, 'First app');
    const secondClient = client(d, 'Second app');
    const firstGrant = d.createGrant({
      clientId: firstClient.clientId, userId: person.id, scope: 'write',
      resource: 'https://tabula.example/mcp', now: T0,
    });
    const secondGrant = d.createGrant({
      clientId: secondClient.clientId, userId: person.id, scope: 'read',
      resource: 'https://tabula.example/mcp', now: T0,
    });
    const firstPair = d.issueTokens({ grantId: firstGrant.id, scope: 'write', now: T0 });
    const secondPair = d.issueTokens({ grantId: secondGrant.id, scope: 'read', now: T0 });

    expect(d.revokeGrantFamily(firstGrant.id, 'self', T0 + 1)).toBe(true);
    expect(d.findOauthAccessToken(firstPair.accessToken, T0 + 1)).toBeNull();
    expect(d.findOauthAccessToken(secondPair.accessToken, T0 + 1)).not.toBeNull();
    expect(d.revokeAllForUser(person.id, 'sign_out_everywhere', T0 + 2)).toBe(1);
    expect(d.findOauthAccessToken(secondPair.accessToken, T0 + 2)).toBeNull();

    const otherPerson = d.createUser({ email: 'oauth-restore@example.com', role: 'member' })!;
    const otherClient = client(d, 'Restore app');
    const otherGrant = d.createGrant({
      clientId: otherClient.clientId, userId: otherPerson.id, scope: 'read',
      resource: 'https://tabula.example/mcp', now: T0,
    });
    const otherPair = d.issueTokens({ grantId: otherGrant.id, scope: 'read', now: T0 });
    expect(d.revokeAll('restore', T0 + 3)).toBe(1);
    expect(d.findOauthAccessToken(otherPair.accessToken, T0 + 3)).toBeNull();
  });

  it('erases an expired replay cache and revokes the family on a late presentation', () => {
    const d = directory();
    const fixture = grant(d);
    const first = d.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: T0 + 1 });
    const afterWindow = T0 + 1 + OAUTH_REPLAY_TTL_MS;
    d.cleanup(afterWindow);
    expect(d.db.prepare('SELECT replay_ciphertext FROM oauth_tokens WHERE token_hash = ?')
      .get(crypto.createHash('sha256').update(first.refreshToken).digest('hex')))
      .toEqual({ replay_ciphertext: null });
    expect(d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: afterWindow }))
      .toMatchObject({ error: 'reuse' });
    expect(d.getGrant(fixture.value.id)?.revokedAt).toBe(afterWindow);
  });

  it('burns a code after a wrong PKCE verifier', () => {
    const d = directory();
    const fixture = grant(d);
    const verifier = 'v'.repeat(43);
    const code = d.issueCode({
      grantId: fixture.value.id,
      clientId: fixture.registered.clientId,
      redirectUri: fixture.registered.redirectUris[0],
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      scope: 'write',
      resource: 'https://tabula.example/mcp',
      now: T0,
    });
    expect(d.redeemCode({
      code: code.code,
      clientId: fixture.registered.clientId,
      redirectUri: fixture.registered.redirectUris[0],
      codeVerifier: 'x'.repeat(43),
      now: T0,
    })).toMatchObject({ error: 'invalid_grant' });
    expect(d.redeemCode({
      code: code.code,
      clientId: fixture.registered.clientId,
      redirectUri: fixture.registered.redirectUris[0],
      codeVerifier: verifier,
      now: T0 + 1,
    })).toMatchObject({ error: 'reuse' });
  });
});

describe('OAuth authorize envelope', () => {
  it('is signed, versioned, expiring, instance-bound and fails after client purge', () => {
    const d = directory();
    const registered = client(d);
    const fields = {
      clientId: registered.clientId,
      redirectUri: registered.redirectUris[0],
      state: 'opaque state',
      codeChallenge: 'c'.repeat(43),
      scope: 'read comment write',
      resource: 'https://tabula.example/mcp',
    };
    const envelope = d.signRequest(fields, T0);
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM oauth_requests').get()).toEqual({ n: 0 });
    expect(d.readRequest(envelope, T0 + 1)).toMatchObject({ clientId: registered.clientId, state: fields.state });

    const changed = `${envelope.slice(0, -1)}${envelope.endsWith('A') ? 'B' : 'A'}`;
    expect(d.readRequest(changed, T0 + 1)).toBeNull();
    expect(verifyAuthorizeEnvelope(envelope, Buffer.alloc(32, 0x42), T0 + 1)).toBeNull();
    expect(d.readRequest(envelope, T0 + 10 * 60 * 1000)).toBeNull();
    const bytes = Buffer.from(envelope, 'base64url');
    bytes[0] = 2;
    expect(d.readRequest(bytes.toString('base64url'), T0 + 1)).toBeNull();

    d.purgeClients('operator', T0 + 1);
    expect(d.decideRequest({ envelope, userId: 'no-user', scope: 'read', now: T0 + 1 })).toBeNull();
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM oauth_requests').get()).toEqual({ n: 0 });
  });

  it('creates and verifies a per-session nonce with a distinct derived key', () => {
    const d = directory();
    const fields = { requestId: 'request', sessionId: 'session', expiresAt: T0 + 1000 };
    const nonce = d.createOAuthNonce(fields);
    expect(d.verifyOAuthNonce(nonce, fields)).toBe(true);
    expect(d.verifyOAuthNonce(nonce, { ...fields, sessionId: 'other' })).toBe(false);
  });
});

describe('OAuth instance secret and configuration', () => {
  it('separates client-aware limiter buckets for clients behind the same IP', () => {
    let now = T0;
    const limiter = createClientAwareLimiter(1, () => now, 60_000);
    expect(limiter.hit('192.0.2.10', 'client-a')).toBe(0);
    expect(limiter.hit('192.0.2.10', 'client-a')).toBe(60);
    expect(limiter.hit('192.0.2.10', 'client-b')).toBe(0);
    now += 60_001;
    expect(limiter.hit('192.0.2.10', 'client-a')).toBe(0);
  });

  it('creates a stable 32-byte mode-0600 secret file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-secret-test-'));
    temporary.push(dir);
    const secret = loadOAuthSecret(dir);
    const secretFile = path.join(dir, 'oauth-secret');
    expect(secret).toHaveLength(32);
    expect(loadOAuthSecret(dir)).toEqual(secret);
    expect(isWindows || (fs.statSync(secretFile).mode & 0o777) === 0o600).toBe(true);
  });

  it('defaults OAuth off, validates its flag, parses redirect policy and disables an invalid issuer only', () => {
    const env = (settings: Record<string, string>) => Object.fromEntries(Object.entries({
      AUTH: 'on', OWNER_EMAIL: 'owner@example.com', MCP: 'on', ...settings,
    }).map(([key, value]) => [`TABULA_${key}`, value]));
    expect(loadConfig(env({})).mcp).toMatchObject({ mode: 'accounts', oauth: false });
    expect(() => loadConfig(env({ MCP_OAUTH: 'yes' }))).toThrow(/TABULA_MCP_OAUTH must be on or off/);
    expect(loadConfig(env({ MCP_OAUTH: 'on', BASE_URL: 'https://tabula.example', OAUTH_REDIRECT_HOSTS: 'claude.ai,claude.com', OAUTH_REDIRECT_SCHEMES: 'com.example.app' })).mcp)
      .toMatchObject({ oauth: true, issuer: 'https://tabula.example', redirectHosts: ['claude.ai', 'claude.com'], redirectSchemes: ['com.example.app'] });
    const warnings: string[] = [];
    const invalidIssuer = loadConfig(env({ MCP_OAUTH: 'on', BASE_URL: 'https://tabula.example/workspace' }), (message) => warnings.push(message));
    expect(invalidIssuer.mcp).toMatchObject({ oauth: false, issuer: null });
    expect(warnings).toHaveLength(1);
    expect(() => loadConfig(env({ MCP_OAUTH: 'on', BASE_URL: 'https://tabula.example', OAUTH_REDIRECT_SCHEMES: 'claude' }))).toThrow(/reverse-domain schemes/);
    expect(OAUTH_SCOPES).toEqual(['read', 'comment', 'write']);
    expect(OAUTH_GRANT_TTL_MS).toBe(180 * 24 * 60 * 60 * 1000);
  });

  it('ignores an enabled OAuth flag in open mode with one warning', () => {
    const warnings: string[] = [];
    const config = loadConfig({
      TABULA_MCP: 'on',
      TABULA_MCP_OAUTH: 'on',
      TABULA_MCP_TOKEN: 'x'.repeat(32),
      TABULA_BASE_URL: 'http://127.0.0.1:8787',
    }, (message) => warnings.push(message));
    expect(config.mcp).toMatchObject({ mode: 'open', oauth: false });
    expect(warnings).toHaveLength(1);
  });
});
