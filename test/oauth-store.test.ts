import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { loadOAuthSecret } from '../server/instance-secret.mjs';
import { createClientAwareLimiter } from '../server/limiter.mjs';
import { OAUTH_ACCESS_TTL_MS, OAUTH_CODE_TTL_MS, OAUTH_GRANT_RETENTION_MS, OAUTH_GRANT_TTL_MS, OAUTH_MIGRATION, OAUTH_REPLAY_TTL_MS, OAUTH_SCOPES, MAX_OAUTH_CLIENTS, OAUTH_UNUSED_CLIENT_TTL_MS, OAUTH_USED_CLIENT_TTL_MS, TOKEN_PREFIX_OAUTH, verifyAuthorizeEnvelope } from '../server/oauth.mjs';
import { isWindows } from './platform';

const T0 = 1_800_000_000_000;
const SECRET = Buffer.alloc(32, 0x31);
const directories: ReturnType<typeof openDirectory>[] = [];
const temporary: string[] = [];

function directory(secret = SECRET) {
  const value = openDirectory(':memory:', { oauthSecret: secret, oauthInternals: true });
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
    value: d.oauthInternals!.createGrant({
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

describe('OAuth grants bound to boards', () => {
  it('stores up to 50 board ids, refuses 51, and reads a stored list back exactly', () => {
    const d = directory();
    const person = d.createUser({ email: 'picker@example.com', role: 'member' })!;
    const registered = client(d);
    const create = (boardIds: string[]) => d.oauthInternals!.createGrant({
      clientId: registered.clientId, userId: person.id, scope: 'read', boardIds, resource: 'https://tabula.example/mcp', now: T0,
    });
    const ids = Array.from({ length: 50 }, (_, i) => `board${String(i).padStart(3, '0')}`);
    const made = create(ids);
    const pair = d.oauthInternals!.issueTokens({ grantId: made.id, scope: 'read', now: T0 });
    expect(d.findOauthAccessToken(pair.accessToken, T0 + 1)!.boardIds).toEqual(ids);
    expect(() => create([...ids, 'board050'])).toThrow('invalid grant boards');
  });

  it('fails closed to no boards when the stored list is damaged', () => {
    const d = directory();
    const fixture = grant(d, { scope: 'read' });
    const pair = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'read', now: T0 });
    d.db.prepare('UPDATE oauth_grants SET board_ids = ? WHERE id = ?').run('{"not":"a list"}', fixture.value.id);
    expect(d.findOauthAccessToken(pair.accessToken, T0 + 1)!.boardIds).toEqual([]);
  });
});

describe('OAuth store migration and persistence', () => {
  it('applies migration 16 with cascading user foreign keys and unique token digests', () => {
    const d = directory();
    expect(MIGRATIONS).toHaveLength(17);
    expect(MIGRATIONS[15]).toMatchObject({ sql: OAUTH_MIGRATION, minReader: 11 });
    expect(d.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });

    const fixture = grant(d);
    const pair = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
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
    const issued = d.oauthInternals!.issueCode({
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

    expect(d.oauthInternals!.consumeCode(issued.code, T0)).toMatchObject({ clientId: fixture.registered.clientId, scope: 'write' });
    expect(d.oauthInternals!.consumeCode(issued.code, T0 + 1)).toMatchObject({ reused: true, grantId: fixture.value.id });
    expect(d.getGrant(fixture.value.id)?.revokedAt).toBe(T0 + 1);

    const another = grant(d);
    const expires = d.oauthInternals!.issueCode({
      grantId: another.value.id,
      clientId: another.registered.clientId,
      redirectUri: another.registered.redirectUris[0],
      codeChallenge: challenge,
      scope: 'write',
      resource: 'https://tabula.example/mcp',
      now: T0,
    });
    expect(d.oauthInternals!.consumeCode(expires.code, T0 + OAUTH_CODE_TTL_MS)).toBeNull();

    const replayed = grant(d);
    const used = d.oauthInternals!.issueCode({
      grantId: replayed.value.id,
      clientId: replayed.registered.clientId,
      redirectUri: replayed.registered.redirectUris[0],
      codeChallenge: challenge,
      scope: 'write',
      resource: 'https://tabula.example/mcp',
      now: T0,
    });
    d.oauthInternals!.consumeCode(used.code, T0);
    expect(d.oauthInternals!.consumeCode(used.code, T0 + OAUTH_CODE_TTL_MS + 1)).toMatchObject({ reused: true, grantId: replayed.value.id });
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
    const first = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
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

  it('gives a replay of the old refresh token nothing once its grant was revoked', () => {
    const d = directory();
    const fixture = grant(d);
    const first = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    const rotated = d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: T0 + 1 });
    expect(rotated).toHaveProperty('accessToken');
    d.revokeGrant(fixture.value.id, 'self', T0 + 2);
    const replay = d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: T0 + 3 });
    expect(replay).not.toHaveProperty('accessToken');
    expect(d.findOauthAccessToken(rotated.accessToken, T0 + 3)).toBeNull();
  });

  it('keeps a client ceiling as first registered, does not keep a never-granted client alive, and makes room when full', () => {
    const d = directory();
    const uris = ['https://claude.ai/api/mcp/auth_callback'];
    const first = d.registerClient({ name: 'Claude', redirectUris: uris, maxScope: 'read', now: T0 });
    const repeat = d.registerClient({ name: 'Claude', redirectUris: uris, maxScope: 'write', now: T0 + 1000 });
    expect(repeat.created).toBe(false);
    expect(repeat.client!.maxScope).toBe('read');
    expect(d.getClient(first.client!.clientId, T0 + 1000)!.maxScope).toBe('read');
    // repeating the registration does not extend a client that never got a grant
    d.registerClient({ name: 'Claude', redirectUris: uris, maxScope: 'read', now: T0 + OAUTH_UNUSED_CLIENT_TTL_MS - 1 });
    expect(d.getClient(first.client!.clientId, T0 + OAUTH_UNUSED_CLIENT_TTL_MS)).toBeNull();

    const full = directory();
    for (let i = 0; i < MAX_OAUTH_CLIENTS; i++) {
      expect(full.registerClient({ name: `App ${i}`, redirectUris: [`https://claude.ai/cb/${i}`], now: T0 + i }).client).not.toBeNull();
    }
    const next = full.registerClient({ name: 'Real connector', redirectUris: ['https://claude.ai/cb/real'], now: T0 + MAX_OAUTH_CLIENTS });
    expect(next.client).not.toBeNull();
    expect(full.countClients()).toBe(MAX_OAUTH_CLIENTS);
    // the oldest never-granted client was the one dropped: registering it again makes a new client
    expect(full.registerClient({ name: 'App 0', redirectUris: ['https://claude.ai/cb/0'], now: T0 + MAX_OAUTH_CLIENTS + 1 }).created).toBe(true);
  });

  it('revokes one family, all grants for a user, and all active instance grants', () => {
    const d = directory();
    const person = d.createUser({ email: 'oauth-revoke@example.com', role: 'member' })!;
    const firstClient = client(d, 'First app');
    const secondClient = client(d, 'Second app');
    const firstGrant = d.oauthInternals!.createGrant({
      clientId: firstClient.clientId, userId: person.id, scope: 'write',
      resource: 'https://tabula.example/mcp', now: T0,
    });
    const secondGrant = d.oauthInternals!.createGrant({
      clientId: secondClient.clientId, userId: person.id, scope: 'read',
      resource: 'https://tabula.example/mcp', now: T0,
    });
    const firstPair = d.oauthInternals!.issueTokens({ grantId: firstGrant.id, scope: 'write', now: T0 });
    const secondPair = d.oauthInternals!.issueTokens({ grantId: secondGrant.id, scope: 'read', now: T0 });

    expect(d.revokeGrantFamily(firstGrant.id, 'self', T0 + 1)).toBe(true);
    expect(d.findOauthAccessToken(firstPair.accessToken, T0 + 1)).toBeNull();
    expect(d.findOauthAccessToken(secondPair.accessToken, T0 + 1)).not.toBeNull();
    expect(d.revokeAllForUser(person.id, 'sign_out_everywhere', T0 + 2)).toBe(1);
    expect(d.findOauthAccessToken(secondPair.accessToken, T0 + 2)).toBeNull();

    const otherPerson = d.createUser({ email: 'oauth-restore@example.com', role: 'member' })!;
    const otherClient = client(d, 'Restore app');
    const otherGrant = d.oauthInternals!.createGrant({
      clientId: otherClient.clientId, userId: otherPerson.id, scope: 'read',
      resource: 'https://tabula.example/mcp', now: T0,
    });
    const otherPair = d.oauthInternals!.issueTokens({ grantId: otherGrant.id, scope: 'read', now: T0 });
    expect(d.revokeAll('restore', T0 + 3)).toBe(1);
    expect(d.findOauthAccessToken(otherPair.accessToken, T0 + 3)).toBeNull();
  });

  it('erases an expired replay cache and revokes the family on a late presentation', () => {
    const d = directory();
    const fixture = grant(d);
    const first = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: T0 + 1 });
    const afterWindow = T0 + 1 + OAUTH_REPLAY_TTL_MS;
    d.cleanup(afterWindow);
    expect(d.db.prepare('SELECT replay_ciphertext FROM oauth_tokens WHERE token_hash = ?')
      .get(crypto.createHash('sha256').update(first.refreshToken).digest('hex')))
      .toEqual({ replay_ciphertext: null });
    const lateRefresh = d.refresh({ refreshToken: first.refreshToken, clientId: fixture.registered.clientId, now: afterWindow });
    expect(lateRefresh.error).toBe('reuse');
    expect(d.getGrant(fixture.value.id)?.revokedAt).toBe(afterWindow);
  });

  it('burns a code after a wrong PKCE verifier', () => {
    const d = directory();
    const fixture = grant(d);
    const verifier = 'v'.repeat(43);
    const code = d.oauthInternals!.issueCode({
      grantId: fixture.value.id,
      clientId: fixture.registered.clientId,
      redirectUri: fixture.registered.redirectUris[0],
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      scope: 'write',
      resource: 'https://tabula.example/mcp',
      now: T0,
    });
    const wrongVerifier = d.redeemCode({
      code: code.code,
      clientId: fixture.registered.clientId,
      redirectUri: fixture.registered.redirectUris[0],
      codeVerifier: 'x'.repeat(43),
      now: T0,
    });
    expect(wrongVerifier.error).toBe('invalid_grant');
    expect(d.redeemCode({
      code: code.code,
      clientId: fixture.registered.clientId,
      redirectUri: fixture.registered.redirectUris[0],
      codeVerifier: verifier,
      now: T0 + 1,
    })).toMatchObject({ error: 'reuse' });
  });

  it('serializes concurrent refreshes to one replacement pair with one replay', async () => {
    const d = directory();
    const fixture = grant(d);
    const original = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    let now = T0 + 1;
    const results = await Promise.all([
      Promise.resolve().then(() => d.refresh({ refreshToken: original.refreshToken, clientId: fixture.registered.clientId, now })),
      Promise.resolve().then(() => d.refresh({ refreshToken: original.refreshToken, clientId: fixture.registered.clientId, now })),
    ]);
    expect(results[0]).toHaveProperty('accessToken');
    expect(results[1]).toEqual(results[0]);
    expect(d.getGrant(fixture.value.id)?.revokedAt).toBeNull();
  });

  it('permanently lowers the grant ceiling when refresh narrows scope', () => {
    const d = directory();
    const fixture = grant(d);
    const original = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    const narrowed = d.refresh({ refreshToken: original.refreshToken, clientId: fixture.registered.clientId, scope: 'comment', now: T0 + 2 } as any);
    expect(narrowed).toMatchObject({ scope: 'comment' });
    expect(d.getGrant(fixture.value.id)?.scope).toBe('comment');
    const attemptToWiden = d.refresh({ refreshToken: narrowed.refreshToken, clientId: fixture.registered.clientId, scope: 'write', now: T0 + 3 } as any);
    expect(attemptToWiden.error).toBe('invalid_scope');
    const next = d.refresh({ refreshToken: narrowed.refreshToken, clientId: fixture.registered.clientId, now: T0 + 4 });
    expect(next).toMatchObject({ scope: 'comment' });
    expect(d.getGrant(fixture.value.id)?.scope).toBe('comment');
  });

  it('revokes access and refresh together through RFC 7009 token lookup', () => {
    const d = directory();
    const fixture = grant(d);
    const pair = d.oauthInternals!.issueTokens({ grantId: fixture.value.id, scope: 'write', now: T0 });
    expect(d.revokeToken(pair.accessToken, fixture.registered.clientId, T0 + 1)).toMatchObject({ grantId: fixture.value.id });
    expect(d.findOauthAccessToken(pair.accessToken, T0 + 1)).toBeNull();
    expect(d.refresh({ refreshToken: pair.refreshToken, clientId: fixture.registered.clientId, now: T0 + 1 })).toMatchObject({ error: 'invalid_grant' });
    expect(d.revokeToken(pair.refreshToken, 'another-client', T0 + 2)).toBeNull();
  });

  it('enforces one active grant per client, the per-person cap and the stored client scope ceiling', () => {
    const d = directory();
    const person = d.createUser({ email: 'oauth-grant-cap@example.com', role: 'member' })!;
    const firstClient = d.registerClient({ name: 'App 1', redirectUris: ['https://claude.ai/callback'], maxScope: 'read', now: T0 }).client!;
    const grantFields = { clientId: firstClient.clientId, userId: person.id, scope: 'read' as const, resource: 'https://tabula.example/mcp', now: T0 };
    const first = d.oauthInternals!.createGrant(grantFields);
    const replacement = d.oauthInternals!.createGrant(grantFields);
    expect(d.getGrant(first.id)).toMatchObject({ revokedReason: 'replaced' });
    expect(d.getGrant(replacement.id)).toMatchObject({ revokedAt: null });
    expect(() => d.oauthInternals!.createGrant({ ...grantFields, scope: 'write' })).toThrow(/scope exceeds client maximum/);

    for (let index = 2; index <= 20; index++) {
      const client = d.registerClient({ name: `App ${index}`, redirectUris: [`https://claude.ai/${index}`], maxScope: 'read', now: T0 }).client!;
      d.oauthInternals!.createGrant({ ...grantFields, clientId: client.clientId });
    }
    const capClient = d.registerClient({ name: 'App 21', redirectUris: ['https://claude.ai/21'], maxScope: 'read', now: T0 }).client!;
    let capError: unknown;
    try {
      d.oauthInternals!.createGrant({ ...grantFields, clientId: capClient.clientId });
    } catch (error) {
      capError = error;
    }
    expect(capError).toMatchObject({ code: 'grant_limit' });
  });

  it('touches a grant at most once per minute', () => {
    const d = directory();
    const fixture = grant(d);
    expect(d.touchGrant(fixture.value.id, T0 + 1)).toBe(true);
    expect(d.touchGrant(fixture.value.id, T0 + 59_999)).toBe(false);
    expect(d.touchGrant(fixture.value.id, T0 + 60_001)).toBe(true);
    expect(d.getGrant(fixture.value.id)?.lastUsedAt).toBe(T0 + 60_001);
  });

  it('revokes the grant when the user is disabled, removed or demoted to guest, and on resource change', () => {
    const d = directory();
    const disabled = grant(d);
    const disabledPair = d.oauthInternals!.issueTokens({ grantId: disabled.value.id, scope: 'write', now: T0 });
    d.updateUser(disabled.person.id, { disabled: true });
    expect(d.findOauthAccessToken(disabledPair.accessToken, Date.now())).toBeNull();
    expect(d.getGrant(disabled.value.id)?.revokedReason).toBe('user_state');

    const guest = grant(d);
    const guestPair = d.oauthInternals!.issueTokens({ grantId: guest.value.id, scope: 'write', now: T0 });
    d.updateUser(guest.person.id, { role: 'guest' });
    expect(d.findOauthAccessToken(guestPair.accessToken, Date.now())).toBeNull();
    expect(d.getGrant(guest.value.id)?.revokedReason).toBe('user_state');

    const removed = grant(d);
    const removedPair = d.oauthInternals!.issueTokens({ grantId: removed.value.id, scope: 'write', now: T0 });
    d.removeUser(removed.person.id);
    expect(d.findOauthAccessToken(removedPair.accessToken, Date.now())).toBeNull();
    expect(d.getGrant(removed.value.id)).toBeNull();

    const changed = grant(d);
    const changedPair = d.oauthInternals!.issueTokens({ grantId: changed.value.id, scope: 'write', now: T0 });
    expect(d.refresh({
      refreshToken: changedPair.refreshToken,
      clientId: changed.registered.clientId,
      expectedResource: 'https://new.example/mcp',
      now: T0 + 1,
    } as any)).toMatchObject({ error: 'invalid_grant' });
    expect(d.getGrant(changed.value.id)?.revokedReason).toBe('user_state');
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
      .toMatchObject({ oauth: true, issuer: 'https://tabula.example', redirectKnown: true, redirectHosts: ['claude.ai', 'claude.com'], redirectSchemes: ['com.example.app'] });
    expect(loadConfig(env({ MCP_OAUTH: 'on', BASE_URL: 'https://tabula.example', OAUTH_REDIRECTS: 'none' })).mcp)
      .toMatchObject({ oauth: true, redirectKnown: false });
    expect(() => loadConfig(env({ OAUTH_REDIRECTS: 'maybe' }))).toThrow(/TABULA_OAUTH_REDIRECTS must be known or none/);
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
