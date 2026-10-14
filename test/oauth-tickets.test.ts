import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Account, type Harness } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// TAB-365: an OAuth grant may carry a ticket access ceiling chosen at consent. These tests drive the real consent API and the
// /mcp endpoint with tbo_ tokens. Each test uses a fresh member so no person reaches the 20 active grants cap.

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const TICKET_TOOLS = [
  'create_ticket', 'get_ticket', 'list_tickets', 'search_tickets', 'update_ticket', 'transition_ticket', 'update_tickets',
  'comment_ticket', 'ticket_meta', 'create_ticket_label',
  'relate_tickets', 'list_saved_views', 'get_saved_view', 'create_saved_view', 'update_saved_view',
  'list_projects', 'create_project', 'update_project', 'list_milestones', 'create_milestone', 'update_milestone',
].sort();
const TICKET_READ_TOOLS = [
  'get_ticket', 'list_tickets', 'search_tickets', 'ticket_meta',
  'list_saved_views', 'get_saved_view', 'list_projects', 'list_milestones',
].sort();
const INVALID_CHOICE = 'The selected ticket access is not available.';

const instances: Harness[] = [];

function harness(settings: Record<string, string>) {
  const h = createHarness({ accounts: true, settings: { MCP: 'on', MCP_OAUTH: 'on', OAUTH_REDIRECT_HOSTS: 'claude.ai', ...settings } });
  instances.push(h);
  return h;
}

const tracked = harness({ TRACKER: 'on' });
const untracked = harness({});
const capped = harness({ TRACKER: 'on', MCP_TICKET_HOURLY: '3', MCP_TICKET_CREATE_HOURLY: '4' });
let owner: Account;
let teamId: string;
let cappedOwner: Account;
let cappedTeamId: string;
let untrackedOwner: Account;

beforeAll(async () => {
  await tracked.start();
  owner = await tracked.signInOwner();
  teamId = (await tracked.newTeam(owner.cookie)).id;
  await untracked.start();
  untrackedOwner = await untracked.signInOwner();
  await untracked.newTeam(untrackedOwner.cookie);
  await capped.start();
  cappedOwner = await capped.signInOwner();
  cappedTeamId = (await capped.newTeam(cappedOwner.cookie)).id;
});

afterAll(async () => {
  for (const h of instances.splice(0)) await h.cleanup();
});

async function register(h: Harness, name: string) {
  const result = await h.api(undefined, 'POST', '/oauth/register', { client_name: name, redirect_uris: [REDIRECT], scope: 'read comment write' });
  expect(result.status).toBe(201);
  return result.body.client_id as string;
}

// The authorize step: the stateless signed request, read from the consent route in the redirect's fragment.
async function startFlow(h: Harness, clientId: string, overrides: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const verifier = `v${crypto.randomBytes(32).toString('hex')}`;
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL('/oauth/authorize', h.base);
  const params: Record<string, string> = {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'read comment write', ...overrides, ...extra,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const start = await fetch(`${h.base}${url.pathname}${url.search}`, { redirect: 'manual' });
  const location = start.headers.get('location');
  let envelope: string | null = null;
  if (location && start.status === 302 && new URL(location).hash) {
    const fragment = new URL(location).hash.slice(1);
    envelope = new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).get('request');
  }
  return { status: start.status, location, envelope, verifier };
}

async function consentOf(h: Harness, account: Account, envelope: string) {
  return h.api(account.cookie, 'GET', `/api/oauth/requests?request=${encodeURIComponent(envelope)}`);
}

// Allows a connection and exchanges the code. `tracker` is sent only when given, so "no choice" is a missing key, as a client would send it.
async function connect(h: Harness, account: Account, clientId: string, options: { tracker?: 'read' | 'write'; scope?: 'read' | 'write' } = {}) {
  const flow = await startFlow(h, clientId);
  expect(flow.status).toBe(302);
  expect(flow.envelope).toBeTruthy();
  const consent = await consentOf(h, account, flow.envelope!);
  expect(consent.status).toBe(200);
  const decision = await h.api(account.cookie, 'POST', '/api/oauth/requests/decision', {
    request: flow.envelope, decision: 'allow', scope: options.scope ?? 'read', nonce: consent.body.nonce,
    ...(options.tracker ? { tracker: options.tracker } : {}),
  });
  expect(decision.status).toBe(200);
  const code = new URL(decision.body.redirect).searchParams.get('code');
  expect(code).toBeTruthy();
  const exchanged = await h.api(undefined, 'POST', '/oauth/token', {
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: flow.verifier,
  });
  expect(exchanged.status).toBe(200);
  const grant = (await h.api(account.cookie, 'GET', '/api/me/grants')).body.find((row: { clientId: string }) => row.clientId === clientId);
  expect(grant).toBeTruthy();
  return { accessToken: exchanged.body.access_token as string, refreshToken: exchanged.body.refresh_token as string, grantId: grant.id as string };
}

async function names(h: Harness, token: string): Promise<string[]> {
  const listed = await h.call(token, 'tools/list');
  expect(listed.status).toBe(200);
  return (listed.body.result.tools as { name: string }[]).map((tool) => tool.name).sort();
}

const ticketNames = (all: string[]) => all.filter((name) => TICKET_TOOLS.includes(name));
const boardNames = (all: string[]) => all.filter((name) => !TICKET_TOOLS.includes(name));

async function member(h: Harness, boss: Account, team: string) {
  return h.joinTeam(boss.cookie, team);
}

describe('OAuth connector ticket access ceiling (TAB-365)', () => {
  it('a grant with no ceiling lists no ticket tools, and create_ticket is an unknown tool', async () => {
    const person = await member(tracked, owner, teamId);
    const clientId = await register(tracked, 'No ceiling connector');
    const grant = await connect(tracked, person, clientId);

    expect(ticketNames(await names(tracked, grant.accessToken))).toEqual([]);
    const attempt = await tracked.call(grant.accessToken, 'tools/call', { name: 'create_ticket', arguments: { title: 'x', idempotencyKey: 'no-ceiling-1' } });
    expect(attempt.status).toBe(200);
    expect(attempt.body.error).toMatchObject({ code: -32602, message: 'Unknown tool' });
  });

  it('a write ceiling adds the ticket tools, create_ticket runs despite board scope read, and board write tools stay refused', async () => {
    const board = await tracked.newBoard(owner.cookie);
    const writer = await tracked.newToken(owner.cookie, { scope: 'write', boardIds: [board] });
    const reader = await tracked.newToken(owner.cookie, { scope: 'read' });
    const writerNames = await names(tracked, writer.token);
    const readerNames = await names(tracked, reader.token);
    // board tools that only a write token is offered: the ones a read grant must keep refusing
    const boardWriteTools = boardNames(writerNames).filter((name) => !readerNames.includes(name));
    expect(boardWriteTools).toEqual(expect.arrayContaining(['create_objects', 'update_objects', 'delete_objects']));

    const person = await member(tracked, owner, teamId);
    const clientId = await register(tracked, 'Write ceiling connector');
    const grant = await connect(tracked, person, clientId, { tracker: 'write', scope: 'read' });
    const plainClient = await register(tracked, 'Plain read connector');
    const plain = await connect(tracked, person, plainClient, {});

    const listed = await names(tracked, grant.accessToken);
    expect(ticketNames(listed)).toEqual(TICKET_TOOLS);
    // the tracker ceiling adds ticket tools and nothing else: the board tools are exactly those of the same grant without one
    expect(boardNames(listed)).toEqual(boardNames(await names(tracked, plain.accessToken)));

    const created = await tracked.tool(grant.accessToken, 'create_ticket', { title: 'Ticket from a connector', idempotencyKey: 'ceiling-write-1' });
    expect(created.error).toBeUndefined();
    expect(created.data.ticket.title).toBe('Ticket from a connector');

    for (const name of boardWriteTools) {
      const refused = await tracked.call(grant.accessToken, 'tools/call', { name, arguments: {} });
      expect({ name, status: refused.status, error: refused.body.error }).toEqual({ name, status: 403, error: 'insufficient_scope' });
      expect({ name, challenge: refused.headers.get('www-authenticate') }).toMatchObject({ challenge: expect.stringContaining('error="insufficient_scope"') });
    }
  });

  it('a read ceiling shows only the read ticket tools and refuses every ticket write as unknown', async () => {
    const person = await member(tracked, owner, teamId);
    const clientId = await register(tracked, 'Read ceiling connector');
    const grant = await connect(tracked, person, clientId, { tracker: 'read' });

    expect(ticketNames(await names(tracked, grant.accessToken))).toEqual(TICKET_READ_TOOLS);
    for (const name of ['create_ticket', 'update_ticket', 'transition_ticket', 'comment_ticket']) {
      const attempt = await tracked.call(grant.accessToken, 'tools/call', { name, arguments: {} });
      expect({ name, status: attempt.status, error: attempt.body.error }).toMatchObject({ name, status: 200, error: { message: 'Unknown tool' } });
    }
    const listed = await tracked.tool(grant.accessToken, 'list_tickets', {});
    expect(listed.error).toBeUndefined();
  });

  it('the consent screen offers the role ceiling, and the decision refuses any choice above it', async () => {
    const person = await member(tracked, owner, teamId);
    const clientId = await register(tracked, 'Ceiling offer connector');
    const flow = await startFlow(tracked, clientId);
    const consent = await consentOf(tracked, person, flow.envelope!);
    expect(consent.status).toBe(200);
    expect(consent.body.trackerCeiling).toBe('write');
    expect((await consentOf(tracked, owner, (await startFlow(tracked, clientId)).envelope!)).body.trackerCeiling).toBe('write');

    const refused = await tracked.api(person.cookie, 'POST', '/api/oauth/requests/decision', {
      request: flow.envelope, decision: 'allow', scope: 'read', nonce: consent.body.nonce, tracker: 'admin',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message ?? refused.body.message).toBe(INVALID_CHOICE);

    const allowed = await tracked.api(person.cookie, 'POST', '/api/oauth/requests/decision', {
      request: flow.envelope, decision: 'allow', scope: 'read', nonce: consent.body.nonce, tracker: 'read',
    });
    expect(allowed.status).toBe(200);

    const ownerClient = await register(tracked, 'Owner ceiling connector');
    const ownerGrant = await connect(tracked, owner, ownerClient, { tracker: 'write' });
    expect(ticketNames(await names(tracked, ownerGrant.accessToken))).toEqual(TICKET_TOOLS);

    const audit = (await tracked.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.oauth.authorize')).body.entries as
      { detail: Record<string, unknown> }[];
    const mine = audit.filter((row) => row.detail.clientId === clientId);
    expect(mine.map((row) => row.detail.tracker)).toEqual(['read']);
    const ownerRow = audit.find((row) => row.detail.clientId === ownerClient);
    expect(ownerRow?.detail).toMatchObject({ decision: 'allow', tracker: 'write' });
    expect(JSON.stringify(audit)).not.toContain(ownerGrant.accessToken);
  });

  it('a guest gets no ceiling and any choice from a guest is refused before a grant can exist', async () => {
    const guest = await member(tracked, owner, teamId);
    expect((await tracked.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' })).status).toBe(200);
    const clientId = await register(tracked, 'Guest connector');
    const flow = await startFlow(tracked, clientId);
    expect(flow.status).toBe(302);
    expect((await consentOf(tracked, guest, flow.envelope!)).status).toBe(404);

    for (const tracker of ['read', 'write']) {
      const refused = await tracked.api(guest.cookie, 'POST', '/api/oauth/requests/decision', {
        request: flow.envelope, decision: 'allow', scope: 'read', nonce: 'x'.repeat(43), tracker,
      });
      expect({ tracker, status: refused.status }).toEqual({ tracker, status: 400 });
      expect(refused.body.error?.message ?? refused.body.message).toBe(INVALID_CHOICE);
    }
    const grants = (await tracked.api(owner.cookie, 'GET', '/api/admin/grants')).body as { userId: string }[];
    expect(grants.some((grant) => grant.userId === guest.user.id)).toBe(false);
  });

  it('with the tracker flag off the consent reports no ceiling and any ticket choice is refused', async () => {
    const person = await untracked.joinTeam(untrackedOwner.cookie, (await untracked.newTeam(untrackedOwner.cookie)).id);
    const clientId = await register(untracked, 'Flag off connector');
    const flow = await startFlow(untracked, clientId);
    const consent = await consentOf(untracked, person, flow.envelope!);
    expect(consent.status).toBe(200);
    expect(consent.body.trackerCeiling).toBeNull();

    const refused = await untracked.api(person.cookie, 'POST', '/api/oauth/requests/decision', {
      request: flow.envelope, decision: 'allow', scope: 'read', nonce: consent.body.nonce, tracker: 'read',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message ?? refused.body.message).toBe(INVALID_CHOICE);

    const plain = await connect(untracked, person, clientId, {});
    expect(ticketNames(await names(untracked, plain.accessToken))).toEqual([]);
  });

  it('a tracker query parameter or a tracker scope string on the authorize request preselects nothing', async () => {
    const person = await member(tracked, owner, teamId);
    const clientId = await register(tracked, 'Preselect connector');
    // an unknown query parameter is refused by redirect before any consent request exists (oauth-routes: unknownParameter)
    const withParam = await startFlow(tracked, clientId, {}, { tracker: 'write' });
    expect(withParam.status).toBe(302);
    expect(new URL(withParam.location!).searchParams.get('error')).toBe('invalid_request');
    expect(withParam.envelope).toBeNull();

    // a tracker word in scope is an unknown scope token, refused exactly as before
    for (const scope of ['read tracker:write', 'tracker:write']) {
      const refused = await startFlow(tracked, clientId, { scope });
      expect({ scope, status: refused.status }).toEqual({ scope, status: 302 });
      expect({ scope, error: new URL(refused.location!).searchParams.get('error') }).toEqual({ scope, error: 'invalid_scope' });
      expect({ scope, envelope: refused.envelope }).toEqual({ scope, envelope: null });
    }

    // the only channel left is the decision body: a plain consent with no choice creates a grant with no ceiling
    const plain = await startFlow(tracked, clientId);
    expect(plain.status).toBe(302);
    const consent = await consentOf(tracked, person, plain.envelope!);
    expect(consent.status).toBe(200);
    const allowed = await tracked.api(person.cookie, 'POST', '/api/oauth/requests/decision', {
      request: plain.envelope, decision: 'allow', scope: 'read', nonce: consent.body.nonce,
    });
    expect(allowed.status).toBe(200);
    const code = new URL(allowed.body.redirect).searchParams.get('code');
    const exchanged = await tracked.api(undefined, 'POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: plain.verifier,
    });
    expect(exchanged.status).toBe(200);
    expect(ticketNames(await names(tracked, exchanged.body.access_token))).toEqual([]);
    expect((await tracked.api(person.cookie, 'GET', '/api/me/grants')).body.find((row: { clientId: string }) => row.clientId === clientId))
      .toMatchObject({ tracker: null });
  });

  it('a second consent for the same client replaces the earlier grant and its tokens stop working', async () => {
    const person = await member(tracked, owner, teamId);
    const clientId = await register(tracked, 'Reconsent connector');
    const first = await connect(tracked, person, clientId, { tracker: 'write' });
    expect(ticketNames(await names(tracked, first.accessToken))).toEqual(TICKET_TOOLS);

    const second = await connect(tracked, person, clientId, {});
    expect(second.grantId).not.toBe(first.grantId);
    expect((await tracked.call(first.accessToken, 'tools/list')).status).toBe(401);
    expect(ticketNames(await names(tracked, second.accessToken))).toEqual([]);
    const mine = (await tracked.api(person.cookie, 'GET', '/api/me/grants')).body.filter((row: { clientId: string }) => row.clientId === clientId);
    expect(mine).toEqual([expect.objectContaining({ id: second.grantId, tracker: null })]);
  });

  it('a revoked grant gets 401 on every ticket tool', async () => {
    const person = await member(tracked, owner, teamId);
    const clientId = await register(tracked, 'Revoked ceiling connector');
    const grant = await connect(tracked, person, clientId, { tracker: 'write' });
    expect((await tracked.tool(grant.accessToken, 'list_tickets', {})).res.status).toBe(200);
    expect((await tracked.api(person.cookie, 'DELETE', `/api/me/grants/${grant.grantId}`)).status).toBe(204);
    const afterRevoke = await tracked.tool(grant.accessToken, 'create_ticket', { title: 'After revoke', idempotencyKey: 'revoked-ceiling-1' });
    expect(afterRevoke.res.status).toBe(401);
    expect((await tracked.call(grant.accessToken, 'tools/list')).status).toBe(401);
  });
});

describe('the TAB-330 hourly cap on a ceiling grant', () => {
  it('counts per grant, so a refresh does not reset the update budget', async () => {
    const person = await capped.joinTeam(cappedOwner.cookie, cappedTeamId);
    const clientId = await register(capped, 'Capped ceiling connector');
    const grant = await connect(capped, person, clientId, { tracker: 'write' });
    const created = await capped.tool(grant.accessToken, 'create_ticket', { title: 'Capped ticket', idempotencyKey: 'capped-ceiling-1' });
    expect(created.error).toBeUndefined();
    const key = created.data.ticket.key as string;

    for (const title of ['Update 1', 'Update 2', 'Update 3']) {
      expect((await capped.tool(grant.accessToken, 'update_ticket', { key, title })).error).toBeUndefined();
    }
    const exchanged = await capped.api(undefined, 'POST', '/oauth/token', { grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: clientId });
    expect(exchanged.status).toBe(200);

    const refused = await capped.call(exchanged.body.access_token, 'tools/call', { name: 'update_ticket', arguments: { key, title: 'Update 4' } });
    expect(refused.status).toBe(429);
    expect(refused.body.error.data).toMatchObject({ error: 'rate_limited' });
    expect((await capped.tool(exchanged.body.access_token, 'get_ticket', { key })).data.ticket.title).toBe('Update 3');
  });
});
