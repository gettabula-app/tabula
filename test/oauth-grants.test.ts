import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Account, type Harness } from './mcp-harness';

const instances: Harness[] = [];
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function oauthHarness(extraSettings: Record<string, string> = {}) {
  const h = createHarness({
    accounts: true,
    settings: { MCP: 'on', MCP_OAUTH: 'on', OAUTH_REDIRECT_HOSTS: 'claude.ai', ...extraSettings },
  });
  instances.push(h);
  return h;
}

afterEach(async () => {
  for (const h of instances.splice(0)) await h.cleanup();
});

async function register(h: Harness, name = 'Test Connector') {
  const result = await h.api(undefined, 'POST', '/oauth/register', {
    client_name: name,
    redirect_uris: [REDIRECT],
    scope: 'read comment write',
  });
  expect(result.status).toBe(201);
  return result.body as { client_id: string; redirect_uris: string[] };
}

async function authorize(h: Harness, account: Account, clientId: string, boardIds?: string[], tracker?: 'read' | 'write') {
  const verifier = `v${crypto.randomBytes(32).toString('hex')}`;
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL('/oauth/authorize', h.base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', 'read comment write');
  const start = await fetch(`${h.base}${url.pathname}${url.search}`, { redirect: 'manual' });
  const location = start.headers.get('location');
  expect(start.status).toBe(302);
  expect(location).toBeTruthy();
  const fragment = new URL(location!).hash.slice(1);
  const envelope = new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).get('request');
  expect(envelope).toBeTruthy();
  const consent = await h.api(account.cookie, 'GET', `/api/oauth/requests?request=${encodeURIComponent(envelope!)}`);
  expect(consent.status).toBe(200);
  const decision = await h.api(account.cookie, 'POST', '/api/oauth/requests/decision', {
    request: envelope,
    decision: 'allow',
    nonce: consent.body.nonce,
    scope: 'read',
    ...(boardIds ? { boardIds } : {}),
    ...(tracker ? { tracker } : {}),
  });
  expect(decision.status).toBe(200);
  const code = new URL(decision.body.redirect).searchParams.get('code');
  expect(code).toBeTruthy();
  const exchange = await h.api(undefined, 'POST', '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  expect(exchange.status).toBe(200);
  const listed = await h.api(account.cookie, 'GET', '/api/me/grants');
  const grant = listed.body.find((row: { clientId: string }) => row.clientId === clientId);
  expect(grant).toBeTruthy();
  return { grant: grant as { id: string; clientId: string }, accessToken: exchange.body.access_token as string };
}

async function member(h: Harness, owner: Account) {
  const team = await h.newTeam(owner.cookie);
  return h.joinTeam(owner.cookie, team.id);
}

describe('connected app grant routes', () => {
  it('lists only the member’s own grants and exposes no board ids, hashes, tokens or resource', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const guest = await member(h, owner);
    expect((await h.api(guest.cookie, 'GET', '/api/me')).body.mcpOauth).toBe(true);
    const client = await register(h);
    const ownerGrant = await authorize(h, owner, client.client_id);
    const memberGrant = await authorize(h, guest, client.client_id);
    const boardId = await h.newBoard(owner.cookie);
    const restrictedClient = await register(h, 'Scoped Connector');
    await authorize(h, owner, restrictedClient.client_id, [boardId]);

    const own = await h.api(guest.cookie, 'GET', '/api/me/grants');
    expect(own.status).toBe(200);
    expect(own.body).toHaveLength(1);
    expect(own.body[0]).toMatchObject({
      id: memberGrant.grant.id,
      clientId: client.client_id,
      clientName: 'Test Connector',
      redirectHost: 'claude.ai',
      scope: 'read',
      boardCount: null,
    });
    expect(own.body[0]).toMatchObject({ tracker: null });
    expect(Object.keys(own.body[0]).sort()).toEqual([
      'boardCount', 'clientId', 'clientName', 'createdAt', 'expiresAt', 'id', 'lastUsedAt', 'redirectHost', 'scope', 'tracker',
    ]);
    expect(JSON.stringify(own.body)).not.toMatch(/boardIds|resource|hash|token/i);
    expect(own.body[0].id).not.toBe(ownerGrant.grant.id);
    const ownerList = await h.api(owner.cookie, 'GET', '/api/me/grants');
    expect(ownerList.body.find((row: { clientId: string }) => row.clientId === restrictedClient.client_id)).toMatchObject({ boardCount: 1 });
    expect(JSON.stringify(ownerList.body)).not.toContain(boardId);
    const other = await h.api(guest.cookie, 'DELETE', `/api/me/grants/${ownerGrant.grant.id}`);
    expect(other.status).toBe(404);
    const unknown = await h.api(guest.cookie, 'DELETE', '/api/me/grants/no-such-grant');
    expect(unknown.status).toBe(404);
    expect(other.body).toEqual(unknown.body);
    expect((await h.api(guest.cookie, 'DELETE', `/api/me/grants/${memberGrant.grant.id}`)).status).toBe(204);
    expect((await h.call(memberGrant.accessToken, 'tools/list')).status).toBe(401);
    const audit = (await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.oauth.revoke')).body.entries as { detail: Record<string, unknown> }[];
    expect(audit[0]?.detail).toMatchObject({ by: 'self', userId: guest.user.id });
    expect(own.body).toHaveLength(1);
  });

  it('lets admins list and revoke grants, enforces the owner guard, and revokes every remaining grant', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const otherAdmin = await member(h, owner);
    expect((await h.api(owner.cookie, 'PATCH', `/api/members/${otherAdmin.user.id}`, { role: 'admin' })).status).toBe(200);
    const person = await member(h, owner);
    const client = await register(h);
    const ownerGrant = await authorize(h, owner, client.client_id);
    const personGrant = await authorize(h, person, client.client_id);

    const nonAdmin = await h.api(person.cookie, 'GET', '/api/admin/grants');
    expect(nonAdmin.status).toBe(403);
    const listed = await h.api(otherAdmin.cookie, 'GET', '/api/admin/grants');
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(2);
    expect(listed.body.find((g: { id: string }) => g.id === personGrant.grant.id)).toMatchObject({
      userId: person.user.id,
      userName: person.user.name,
      email: person.email,
      userRole: 'member',
    });
    expect((await h.api(otherAdmin.cookie, 'DELETE', `/api/admin/grants/${ownerGrant.grant.id}`)).status).toBe(403);
    expect((await h.api(otherAdmin.cookie, 'DELETE', `/api/admin/grants/${personGrant.grant.id}`)).status).toBe(204);
    expect((await h.call(personGrant.accessToken, 'tools/list')).status).toBe(401);
    expect((await h.api(otherAdmin.cookie, 'POST', '/api/admin/grants/revoke-all')).body).toEqual({ revoked: 1 });
    expect((await h.call(ownerGrant.accessToken, 'tools/list')).status).toBe(401);

    const rows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.oauth.revoke')).body.entries as { detail: Record<string, unknown> }[];
    expect(rows.some((row) => row.detail.by === 'admin' && row.detail.userId === person.user.id)).toBe(true);
    const allRows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.oauth.revoke_all')).body.entries as { detail: Record<string, unknown> }[];
    expect(allRows[0]?.detail).toMatchObject({ grants: 1 });
  });

  it('shows each grant’s ticket ceiling in the member and admin lists, and null when none was chosen', async () => {
    const h = oauthHarness({ TRACKER: 'on' });
    await h.start();
    const owner = await h.signInOwner();
    const person = await member(h, owner);
    const writer = await register(h, 'Writer Connector');
    const reader = await register(h, 'Reader Connector');
    const plain = await register(h, 'Plain Connector');
    const writerGrant = await authorize(h, owner, writer.client_id, undefined, 'write');
    const readerGrant = await authorize(h, person, reader.client_id, undefined, 'read');
    const plainGrant = await authorize(h, person, plain.client_id);

    const own = await h.api(person.cookie, 'GET', '/api/me/grants');
    expect(own.body.find((row: { id: string }) => row.id === readerGrant.grant.id)).toMatchObject({ tracker: 'read' });
    expect(own.body.find((row: { id: string }) => row.id === plainGrant.grant.id)).toMatchObject({ tracker: null });
    const admin = await h.api(owner.cookie, 'GET', '/api/admin/grants');
    expect(admin.body.find((row: { id: string }) => row.id === writerGrant.grant.id)).toMatchObject({ tracker: 'write' });
    expect(admin.body.find((row: { id: string }) => row.id === readerGrant.grant.id)).toMatchObject({ tracker: 'read' });
    expect(admin.body.find((row: { id: string }) => row.id === plainGrant.grant.id)).toMatchObject({ tracker: null });
  });

  it('disconnects a person’s grants when revoking all personal tokens and keeps the counts in the audit row', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const connection = await authorize(h, owner, client.client_id);
    await h.newToken(owner.cookie, { scope: 'read' });
    const revoked = await h.api(owner.cookie, 'POST', '/api/me/tokens/revoke-all');
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: 1, grants: 1 });
    expect((await h.call(connection.accessToken, 'tools/list')).status).toBe(401);
    expect((await h.api(owner.cookie, 'GET', '/api/me/tokens')).body).toEqual([]);
    const rows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.oauth.revoke')).body.entries as { detail: Record<string, unknown> }[];
    expect(rows[0]?.detail).toMatchObject({ by: 'self', userId: owner.user.id });
    const tokenRows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.token.revoke_all')).body.entries as { detail: Record<string, unknown> }[];
    expect(tokenRows[0]?.detail).toMatchObject({ count: 1, grants: 1 });
  });

  it('keeps grant routes off with OAuth disabled and keeps the old revoke-all response', async () => {
    const h = createHarness({ accounts: true, settings: { MCP: 'on', MCP_OAUTH: 'off' } });
    instances.push(h);
    await h.start();
    const owner = await h.signInOwner();
    expect((await h.api(owner.cookie, 'GET', '/api/me')).body.mcpOauth).toBe(false);
    expect((await h.api(owner.cookie, 'GET', '/api/me/grants')).status).toBe(404);
    expect((await h.api(owner.cookie, 'GET', '/api/admin/grants')).status).toBe(404);
    await h.newToken(owner.cookie, { scope: 'read' });
    const revoked = await h.api(owner.cookie, 'POST', '/api/me/tokens/revoke-all');
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: 1 });
  });

  it('allows grant revocation while a hosted workspace is read-only', async () => {
    const cloudToken = 'c'.repeat(48);
    const h = oauthHarness({ CLOUD_TOKEN: cloudToken, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'oauth-grants-read-only' });
    instances.push(h);
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const connection = await authorize(h, owner, client.client_id);
    const otherClient = await register(h, 'Another Connector');
    const otherConnection = await authorize(h, owner, otherClient.client_id);
    expect((await h.api(undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${cloudToken}` })).status).toBe(200);
    expect((await h.api(owner.cookie, 'DELETE', `/api/me/grants/${connection.grant.id}`)).status).toBe(204);
    expect((await h.api(owner.cookie, 'POST', '/api/admin/grants/revoke-all')).body).toEqual({ revoked: 1 });
    expect((await h.call(otherConnection.accessToken, 'tools/list')).status).toBe(401);
  });
});
