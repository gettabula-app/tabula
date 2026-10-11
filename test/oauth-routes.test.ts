import crypto from 'node:crypto';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './mcp-harness';

const instances: Harness[] = [];

function oauthHarness(extraSettings: Record<string, string> = {}) {
  const h = createHarness({
    accounts: true,
    settings: {
      MCP: 'on',
      MCP_OAUTH: 'on',
      OAUTH_REDIRECT_HOSTS: 'claude.ai,claude.com',
      ...extraSettings,
    },
  });
  instances.push(h);
  return h;
}

afterEach(async () => {
  for (const h of instances.splice(0)) await h.cleanup();
});

async function raw(h: Harness, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${h.base}${path}`, {
    method: options.method ?? 'GET',
    redirect: 'manual',
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : undefined; } catch {}
  return { status: response.status, headers: response.headers, body };
}

async function register(h: Harness, redirectUri = 'https://claude.ai/api/mcp/auth_callback') {
  const result = await h.api(undefined, 'POST', '/oauth/register', {
    client_name: 'Test Connector',
    redirect_uris: [redirectUri],
    scope: 'read comment write',
  });
  expect(result.status).toBe(201);
  return result.body as { client_id: string; redirect_uris: string[] };
}

async function beginAuthorization(
  h: Harness,
  clientId: string,
  options: { redirectUri?: string; state?: string; cookie?: string } = {},
) {
  const verifier = 'v'.repeat(43);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL('/oauth/authorize', h.base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', options.redirectUri ?? 'https://claude.ai/api/mcp/auth_callback');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', 'read comment write');
  if (options.state !== undefined) url.searchParams.set('state', options.state);
  const result = await raw(h, `${url.pathname}${url.search}`, { headers: options.cookie ? { cookie: options.cookie } : {} });
  const location = result.headers.get('location');
  let envelope: string | null = null;
  if (location) {
    const fragment = new URL(location).hash.slice(1);
    const query = fragment.slice(fragment.indexOf('?') + 1);
    envelope = new URLSearchParams(query).get('request');
  }
  return { ...result, envelope, verifier };
}

async function consent(h: Harness, cookie: string, envelope: string) {
  const query = new URLSearchParams({ request: envelope });
  return h.api(cookie, 'GET', `/api/oauth/requests?${query}`);
}

async function decide(h: Harness, cookie: string, envelope: string, nonce: string, scope = 'read') {
  return h.api(cookie, 'POST', '/api/oauth/requests/decision', { request: envelope, decision: 'allow', scope, nonce });
}

function callbackParams(redirect: string) {
  return new URL(redirect).searchParams;
}

async function tokenRequest(h: Harness, body: Record<string, unknown>, form = false) {
  return raw(h, '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : body,
  });
}

async function authorizeAndConsent(h: Harness, cookie: string, clientId: string, options: { state?: string; redirectUri?: string } = {}) {
  const started = await beginAuthorization(h, clientId, options);
  expect(started.status).toBe(302);
  expect(started.envelope).toBeTruthy();
  const request = await consent(h, cookie, started.envelope!);
  expect(request.status).toBe(200);
  expect(request.headers.get('cache-control')).toBe('no-store');
  const decision = await decide(h, cookie, started.envelope!, request.body.nonce);
  expect(decision.status).toBe(200);
  return { started, request, decision, callback: callbackParams(decision.body.redirect) };
}

describe('OAuth metadata and registration routes', () => {
  it('gives a connector no tracker tools even when the tracker is on', async () => {
    const h = oauthHarness({ TRACKER: 'on' });
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const flow = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const exchanged = await tokenRequest(h, {
      grant_type: 'authorization_code', code: flow.callback.get('code'), client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: flow.started.verifier,
    });
    expect(exchanged.status).toBe(200);
    const listed = await h.call(exchanged.body.access_token, 'tools/list');
    expect(listed.status).toBe(200);
    const names = (listed.body.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /ticket|tracker|saved_view|project|milestone/.test(name))).toEqual([]);
    const attempt = await h.call(exchanged.body.access_token, 'tools/call', { name: 'create_ticket', arguments: { title: 'x', idempotencyKey: 'oauth-no-tracker-1' } });
    expect(attempt.status === 200 ? Boolean(attempt.body.error ?? attempt.body.result?.isError) : attempt.status >= 400).toBe(true);
  });

  it('serves RFC 9728 and RFC 8414 documents with metadata-only CORS', async () => {
    const h = oauthHarness();
    await h.start();
    const root = await h.api(undefined, 'GET', '/.well-known/oauth-protected-resource');
    const mcp = await h.api(undefined, 'GET', '/.well-known/oauth-protected-resource/mcp');
    expect(root.status).toBe(200);
    expect(root.body).toEqual(mcp.body);
    expect(root.body).toMatchObject({
      resource: `${h.base}/mcp`,
      authorization_servers: [h.base],
      scopes_supported: ['read', 'comment', 'write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Tabula boards',
    });
    expect(root.body.resource_documentation).toBeUndefined();
    expect(root.headers.get('access-control-allow-origin')).toBe('*');
    expect(root.headers.get('cache-control')).toBe('public, max-age=300');
    expect(root.headers.get('x-content-type-options')).toBe('nosniff');

    const preflight = await h.api(undefined, 'OPTIONS', '/.well-known/oauth-authorization-server');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

    const authorization = await h.api(undefined, 'GET', '/.well-known/oauth-authorization-server');
    expect(authorization.status).toBe(200);
    expect(authorization.body).toEqual({
      issuer: h.base,
      authorization_endpoint: `${h.base}/oauth/authorize`,
      token_endpoint: `${h.base}/oauth/token`,
      registration_endpoint: `${h.base}/oauth/register`,
      revocation_endpoint: `${h.base}/oauth/revoke`,
      scopes_supported: ['read', 'comment', 'write'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${h.base}/docs/mcp.html`,
    });
    expect(authorization.headers.get('access-control-allow-origin')).toBe('*');
    expect((await h.api(undefined, 'GET', '/.well-known/oauth-protected-resource/other')).status).toBe(404);
    expect((await h.api(undefined, 'GET', '/.well-known/openid-configuration')).status).toBe(404);
  });

  it('registers sanitized public clients idempotently and ignores untrusted metadata', async () => {
    const h = oauthHarness();
    await h.start();
    const input = {
      client_name: '  Claude\u202e Connector\n',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      scope: 'read comment write',
      client_uri: 'https://example.org',
      logo_uri: 'https://example.org/logo.svg',
      software_statement: 'ignored',
      unknown_property: 'ignored',
    };
    const first = await h.api(undefined, 'POST', '/oauth/register', input, { 'x-forwarded-for': '192.0.2.20' });
    const again = await h.api(undefined, 'POST', '/oauth/register', input, { 'x-forwarded-for': '192.0.2.20' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(first.body).toEqual(again.body);
    expect(first.body).toMatchObject({
      client_name: 'Claude Connector',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read comment write',
    });
    expect(first.body.client_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.body).not.toHaveProperty('client_secret');
    expect(first.body).not.toHaveProperty('registration_access_token');
    expect(first.body).not.toHaveProperty('client_uri');
    expect(first.body).not.toHaveProperty('software_statement');
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('enforces canonical, HTTPS allowlisted redirects and always accepts native loopback literals', async () => {
    const h = oauthHarness();
    await h.start();
    const invalid = [
      'http://example.com/callback',
      'https://user@claude.ai/callback',
      'https://claude.ai/callback#fragment',
      'https://claude.ai:443/callback',
      'HTTPS://claude.ai/callback',
      'https://evil.example/callback',
      'https://127.0.0.1/callback',
      'https://claude.ai*/callback',
      'javascript:alert(1)',
      'http://localhost:1234/callback',
    ];
    for (const uri of invalid) {
      const res = await h.api(undefined, 'POST', '/oauth/register', { redirect_uris: [uri] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_redirect_uri');
    }
    for (const uri of ['http://127.0.0.1:41231/callback', 'http://[::1]:41231/callback']) {
      const res = await h.api(undefined, 'POST', '/oauth/register', { redirect_uris: [uri] });
      expect(res.status).toBe(201);
    }
  });

  it('allows only configured reverse-domain schemes and refuses registration without a hosted exact allowlist', async () => {
    const custom = oauthHarness({ OAUTH_REDIRECT_SCHEMES: 'com.example.app' });
    await custom.start();
    expect((await custom.api(undefined, 'POST', '/oauth/register', { redirect_uris: ['com.example.app:/callback'] })).status).toBe(201);

    for (const allowlist of [undefined, '', '*']) {
      const hostedSettings = {
        MCP: 'on',
        MCP_OAUTH: 'on',
        CLOUD_TOKEN: 'c'.repeat(32),
        CLOUD_URL: 'https://control.example',
        CLOUD_WORKSPACE_ID: 'oauth-test',
        ...(allowlist === undefined ? {} : { OAUTH_REDIRECT_HOSTS: allowlist }),
      };
      const hosted = createHarness({ accounts: true, settings: hostedSettings });
      instances.push(hosted);
      await hosted.start();
      const result = await hosted.api(undefined, 'POST', '/oauth/register', {
        redirect_uris: ['http://127.0.0.1:49123/callback'],
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_redirect_uri');
      await hosted.cleanup();
      instances.splice(instances.indexOf(hosted), 1);
    }
  });

  it('limits only new registrations by IP and keeps OAuth endpoint method and not-found responses explicit', async () => {
    const h = oauthHarness();
    await h.start();
    const ip = '198.51.100.25';
    const firstBody = { redirect_uris: ['https://claude.ai/callback-0'] };
    const first = await h.api(undefined, 'POST', '/oauth/register', firstBody, { 'x-forwarded-for': ip });
    expect(first.status).toBe(201);
    expect((await h.api(undefined, 'POST', '/oauth/register', firstBody, { 'x-forwarded-for': ip })).status).toBe(201);
    for (let i = 1; i < 10; i++) {
      const res = await h.api(undefined, 'POST', '/oauth/register', { redirect_uris: [`https://claude.ai/callback-${i}`] }, { 'x-forwarded-for': ip });
      expect(res.status).toBe(201);
    }
    const limited = await h.api(undefined, 'POST', '/oauth/register', { redirect_uris: ['https://claude.ai/callback-last'] }, { 'x-forwarded-for': ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const authorize = await raw(h, '/oauth/authorize');
    expect(authorize.status).toBe(400);
    expect(authorize.headers.get('location')).toBeNull();
    expect(authorize.headers.get('content-type')).toContain('text/html');
    for (const endpoint of ['/oauth/token', '/oauth/revoke']) {
      expect((await h.api(undefined, 'GET', endpoint)).status).toBe(405);
    }
    expect((await h.api(undefined, 'GET', '/oauth/future')).status).toBe(404);
    const wrongMethod = await h.api(undefined, 'GET', '/oauth/register');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
  });

  it('keeps the stateless authorize endpoint limited per IP and client', async () => {
    const h = oauthHarness();
    await h.start();
    const client = await register(h);
    for (let i = 0; i < 30; i++) {
      const attempt = await beginAuthorization(h, client.client_id);
      expect(attempt.status).toBe(302);
      expect(attempt.envelope).toBeTruthy();
    }
    const limited = await beginAuthorization(h, client.client_id);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('location')).toBeNull();
    expect(limited.body).not.toContain(client.client_id);
  });

  it('returns static non-redirect errors for unknown clients and unregistered redirect URIs', async () => {
    const h = oauthHarness();
    await h.start();
    const client = await register(h);
    const unknown = new URL('/oauth/authorize', h.base);
    unknown.searchParams.set('client_id', 'unknown-client');
    unknown.searchParams.set('redirect_uri', 'https://evil.example/steal');
    const unknownResult = await raw(h, `${unknown.pathname}${unknown.search}`);
    expect(unknownResult.status).toBe(400);
    expect(unknownResult.headers.get('location')).toBeNull();
    expect(unknownResult.body).not.toContain('evil.example');

    const mismatch = new URL('/oauth/authorize', h.base);
    mismatch.searchParams.set('client_id', client.client_id);
    mismatch.searchParams.set('redirect_uri', 'https://evil.example/steal');
    const mismatchResult = await raw(h, `${mismatch.pathname}${mismatch.search}`);
    expect(mismatchResult.status).toBe(400);
    expect(mismatchResult.headers.get('location')).toBeNull();
    expect(mismatchResult.body).not.toContain('evil.example');
  });

  it('redirects validated resource errors safely and enforces the token body limit without echoing input', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const verifier = 'v'.repeat(43);
    const url = new URL('/oauth/authorize', h.base);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.client_id);
    url.searchParams.set('redirect_uri', client.redirect_uris[0]);
    url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', `${h.base}/other`);
    url.searchParams.set('state', 'keep & encode');
    const rejected = await raw(h, `${url.pathname}${url.search}`);
    expect(rejected.status).toBe(302);
    const callback = new URL(rejected.headers.get('location')!);
    expect(`${callback.origin}${callback.pathname}`).toBe(client.redirect_uris[0]);
    expect(callback.searchParams.get('error')).toBe('invalid_target');
    expect(callback.searchParams.get('state')).toBe('keep & encode');
    expect(callback.searchParams.get('iss')).toBe(h.base);

    const flow = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const exchange = {
      grant_type: 'authorization_code', code: flow.callback.get('code'), client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: flow.started.verifier,
    };
    const wrongResource = await tokenRequest(h, { ...exchange, resource: `${h.base}/other` });
    expect(wrongResource.status).toBe(400);
    expect(wrongResource.body).toMatchObject({ error: 'invalid_target' });
    const correctResource = await tokenRequest(h, { ...exchange, resource: `${h.base}/mcp` });
    expect(correctResource.status).toBe(200);

    const oversizedInput = `{"marker":"${'secret-input-'.repeat(700)}"}`;
    const oversized = await raw(h, '/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: oversizedInput,
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(oversized.body)).not.toContain('secret-input');
  });

  it('round-trips state containing ampersand, hash and newline through URLSearchParams and issues a connector token', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h, 'https://claude.ai/callback?existing=kept');
    const state = 'opaque & #\nstate';
    const flow = await authorizeAndConsent(h, owner.cookie, client.client_id, {
      state,
      redirectUri: client.redirect_uris[0],
    });
    expect(flow.callback.get('state')).toBe(state);
    expect(flow.callback.get('iss')).toBe(h.base);
    expect(flow.callback.get('existing')).toBe('kept');
    expect(flow.request.body).toMatchObject({ clientName: 'Test Connector', clientNameIsClaim: true, verified: true, maxScope: 'read' });
    expect(flow.callback.get('code')).toMatch(/^tbc_[A-Za-z0-9_-]{43}$/);

    const exchanged = await tokenRequest(h, {
      grant_type: 'authorization_code',
      code: flow.callback.get('code'),
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_verifier: flow.started.verifier,
      resource: `${h.base}/mcp`,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toBe('no-store');
    expect(exchanged.headers.get('pragma')).toBe('no-cache');
    expect(exchanged.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    expect(typeof exchanged.body.access_token).toBe('string');
    expect(typeof exchanged.body.refresh_token).toBe('string');

    const who = await h.tool(exchanged.body.access_token, 'whoami');
    expect(who.res.status).toBe(200);
    expect(who.data.connector).toBe('Test Connector');
    const insufficient = await h.call(exchanged.body.access_token, 'tools/call', { name: 'create_kanban', arguments: {} });
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(insufficient.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('burns a code on the first wrong PKCE verifier and revokes the grant when the code is reused', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const started = await beginAuthorization(h, client.client_id);
    const request = await consent(h, owner.cookie, started.envelope!);
    const allowed = await decide(h, owner.cookie, started.envelope!, request.body.nonce);
    const code = callbackParams(allowed.body.redirect).get('code')!;
    const wrong = await tokenRequest(h, {
      grant_type: 'authorization_code', code, client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: 'x'.repeat(43),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: 'invalid_grant' });
    const correctAfterBurn = await tokenRequest(h, {
      grant_type: 'authorization_code', code, client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: started.verifier,
    });
    expect(correctAfterBurn.status).toBe(400);
    expect(correctAfterBurn.body).toMatchObject({ error: 'invalid_grant' });
    const audit = await h.api(owner.cookie, 'GET', '/api/admin/audit?action=mcp.oauth.reuse_detected');
    expect(JSON.stringify(audit.body)).toContain('mcp.oauth.reuse_detected');
  });

  it('revokes every token in a grant on code reuse and uses form refresh and revoke bodies', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const flow = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const code = flow.callback.get('code')!;
    const exchanged = await tokenRequest(h, {
      grant_type: 'authorization_code', code, client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: flow.started.verifier,
    });
    expect(exchanged.status).toBe(200);
    const rotated = await tokenRequest(h, {
      grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token,
      client_id: client.client_id,
    }, true);
    expect(rotated.status).toBe(200);
    const replay = await tokenRequest(h, {
      grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token,
      client_id: client.client_id,
    }, true);
    expect(replay.status).toBe(200);
    expect(replay.body.access_token === rotated.body.access_token).toBe(true);
    expect(replay.body.refresh_token === rotated.body.refresh_token).toBe(true);
    const third = await tokenRequest(h, {
      grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token,
      client_id: client.client_id,
    }, true);
    expect(third.status).toBe(400);
    expect(third.body).toMatchObject({ error: 'invalid_grant' });
    expect((await h.call(rotated.body.access_token, 'ping')).status).toBe(401);
    expect((await h.call(rotated.body.refresh_token, 'ping')).status).toBe(401);

    const unused = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const secondExchange = await tokenRequest(h, {
      grant_type: 'authorization_code', code: unused.callback.get('code'), client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: unused.started.verifier,
    });
    expect(secondExchange.status).toBe(200);
    const otherClient = await h.api(undefined, 'POST', '/oauth/register', {
      client_name: 'Other Connector', redirect_uris: client.redirect_uris, scope: 'read comment write',
    });
    expect(otherClient.status).toBe(201);
    const wrongClientRevoke = await raw(h, '/oauth/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: { token: secondExchange.body.access_token, client_id: otherClient.body.client_id },
    });
    expect(wrongClientRevoke.status).toBe(200);
    expect((await h.call(secondExchange.body.access_token, 'ping')).status).toBe(200);
    const revoked = await raw(h, '/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: secondExchange.body.access_token, client_id: client.client_id }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toBeUndefined();
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    expect((await h.call(secondExchange.body.access_token, 'ping')).status).toBe(401);
    expect((await tokenRequest(h, { grant_type: 'refresh_token', refresh_token: secondExchange.body.refresh_token, client_id: client.client_id }, true)).body)
      .toMatchObject({ error: 'invalid_grant' });
  });

  it('binds the consent nonce to one session, recomputes the scope ceiling and makes Allow one-time', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const otherSession = await h.signInOwner();
    const client = await register(h);
    const started = await beginAuthorization(h, client.client_id);
    const request = await consent(h, owner.cookie, started.envelope!);
    const body = { request: started.envelope, decision: 'allow', scope: 'read', nonce: request.body.nonce };
    const missingCsrf = await raw(h, '/api/oauth/requests/decision', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie }, body,
    });
    expect(missingCsrf.status).toBe(403);
    const foreignOrigin = await raw(h, '/api/oauth/requests/decision', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie, 'x-tabula': '1', origin: 'https://evil.example' }, body,
    });
    expect(foreignOrigin.status).toBe(403);
    const wrongSession = await decide(h, otherSession.cookie, started.envelope!, request.body.nonce);
    expect(wrongSession.status).toBe(404);
    const tooWide = await decide(h, owner.cookie, started.envelope!, request.body.nonce, 'write');
    expect(tooWide.status).toBe(400);
    expect(tooWide.body).toMatchObject({ error: 'invalid_scope' });
    const allowed = await decide(h, owner.cookie, started.envelope!, request.body.nonce);
    expect(allowed.status).toBe(200);
    expect(callbackParams(allowed.body.redirect).get('iss')).toBe(h.base);
    const replay = await decide(h, owner.cookie, started.envelope!, request.body.nonce);
    expect(replay.status).toBe(404);
  });

  it('returns an access_denied callback on Deny without creating a grant marker', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const started = await beginAuthorization(h, client.client_id, { state: 'deny-state' });
    const request = await consent(h, owner.cookie, started.envelope!);
    const body = { request: started.envelope, decision: 'deny', nonce: request.body.nonce };
    const denied = await h.api(owner.cookie, 'POST', '/api/oauth/requests/decision', body);
    expect(denied.status).toBe(200);
    expect(callbackParams(denied.body.redirect).get('error')).toBe('access_denied');
    expect(callbackParams(denied.body.redirect).get('state')).toBe('deny-state');
    expect(callbackParams(denied.body.redirect).get('iss')).toBe(h.base);
    expect((await h.api(owner.cookie, 'POST', '/api/oauth/requests/decision', body)).status).toBe(200);
  });

  it('caps viewer, commenter and owner consent at read until a board picker exists', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const team = await h.newTeam(owner.cookie);
    const viewer = await h.joinTeam(owner.cookie, team.id);
    const commenter = await h.joinTeam(owner.cookie, team.id);
    const privateMember = await h.joinTeam(owner.cookie, team.id);
    const board = await h.newBoard(owner.cookie);
    await h.newBoard(privateMember.cookie);
    await h.share(owner.cookie, board, viewer.user.id, 'viewer');
    await h.share(owner.cookie, board, commenter.user.id, 'commenter');
    const client = await register(h);

    const ownerRequest = await beginAuthorization(h, client.client_id);
    expect((await consent(h, owner.cookie, ownerRequest.envelope!)).body.maxScope).toBe('read');
    const viewerRequest = await beginAuthorization(h, client.client_id);
    expect((await consent(h, viewer.cookie, viewerRequest.envelope!)).body.maxScope).toBe('read');
    const commenterRequest = await beginAuthorization(h, client.client_id);
    expect((await consent(h, commenter.cookie, commenterRequest.envelope!)).body.maxScope).toBe('read');
    const privateRequest = await beginAuthorization(h, client.client_id);
    const privateContext = await consent(h, privateMember.cookie, privateRequest.envelope!);
    expect(privateContext.body.maxScope).toBe('write');
    const privateAllow = await h.api(privateMember.cookie, 'POST', '/api/oauth/requests/decision', {
      request: privateRequest.envelope, decision: 'allow', scope: 'write', nonce: privateContext.body.nonce,
    });
    expect(privateAllow.status).toBe(200);
  });

  it('revokes OAuth grants on sign-out everywhere and demotion to guest', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const team = await h.newTeam(owner.cookie);
    const member = await h.joinTeam(owner.cookie, team.id);
    const client = await register(h);

    const ownerFlow = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const ownerTokens = await tokenRequest(h, {
      grant_type: 'authorization_code', code: ownerFlow.callback.get('code'), client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: ownerFlow.started.verifier,
    });
    expect(ownerTokens.status).toBe(200);
    expect((await h.api(owner.cookie, 'POST', '/api/auth/logout-all')).status).toBe(204);
    expect((await h.call(ownerTokens.body.access_token, 'ping')).status).toBe(401);
    const ownerAgain = await h.signInOwner();

    const memberFlow = await beginAuthorization(h, client.client_id);
    const memberRequest = await consent(h, member.cookie, memberFlow.envelope!);
    const memberAllow = await decide(h, member.cookie, memberFlow.envelope!, memberRequest.body.nonce);
    expect(memberAllow.status).toBe(200);
    const memberTokens = await tokenRequest(h, {
      grant_type: 'authorization_code', code: callbackParams(memberAllow.body.redirect).get('code'),
      client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: memberFlow.verifier,
    });
    expect(memberTokens.status).toBe(200);
    const demoted = await h.api(ownerAgain.cookie, 'PATCH', `/api/members/${member.user.id}`, { role: 'guest' });
    expect(demoted.status).toBe(200);
    expect((await h.call(memberTokens.body.access_token, 'ping')).status).toBe(401);
  });

  it('does not accept OAuth bearer tokens on the API or sync socket, and never uses an MCP cookie', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const board = await h.newBoard(owner.cookie);
    const client = await register(h);
    const flow = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const exchanged = await tokenRequest(h, {
      grant_type: 'authorization_code', code: flow.callback.get('code'), client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: flow.started.verifier,
    });
    const accessToken = exchanged.body.access_token as string;
    const apiResponse = await h.api(undefined, 'GET', '/api/me', undefined, { authorization: `Bearer ${accessToken}` });
    expect(apiResponse.status).toBe(401);

    const withoutBearer = await raw(h, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(withoutBearer.status).toBe(401);
    const withCookie = await raw(h, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, cookie: owner.cookie },
      body: { jsonrpc: '2.0', id: 2, method: 'ping' },
    });
    expect(withCookie.status).toBe(200);

    const invalidOAuth = await h.call(`tbo_${'x'.repeat(43)}`, 'ping');
    expect(invalidOAuth.status).toBe(401);
    expect(invalidOAuth.headers.get('www-authenticate')).toContain('invalid_token');
    expect(invalidOAuth.headers.get('www-authenticate')).toContain('resource_metadata=');
    const missing = await h.call(undefined, 'ping');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).not.toContain('invalid_token');
    expect(missing.headers.get('www-authenticate')).toContain('resource_metadata=');
    const invalidPersonal = await h.call(`tbl_${'x'.repeat(43)}`, 'ping');
    expect(invalidPersonal.status).toBe(401);
    expect(invalidPersonal.headers.get('www-authenticate')).toContain('resource_metadata=');
    const personal = await h.newToken(owner.cookie, { scope: 'read' });
    expect((await h.call(personal.token, 'tools/call', { name: 'create_kanban', arguments: {} })).status).toBe(200);

    const socket = new WebSocket(`${h.base.replace(/^http/u, 'ws')}/sync/${board}`, {
      headers: { Origin: h.base, Authorization: `Bearer ${accessToken}` },
    });
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sync socket did not close without a session cookie')), 5000);
      socket.once('close', (code) => { clearTimeout(timeout); resolve(code); });
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    expect(closeCode).toBe(4401);
  });

  it('revokes a grant when the issuer resource changes after restart', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const flow = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const exchanged = await tokenRequest(h, {
      grant_type: 'authorization_code', code: flow.callback.get('code'), client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: flow.started.verifier,
    });
    expect(exchanged.status).toBe(200);

    await h.stop();
    await h.start({ TABULA_BASE_URL: `http://localhost:${h.port}` });
    expect((await h.call(exchanged.body.access_token, 'ping')).status).toBe(401);
    const refresh = await tokenRequest(h, {
      grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token, client_id: client.client_id,
    });
    expect(refresh.status).toBe(400);
    expect(refresh.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('keeps the MCP call rate bucket across refresh by keying it to the grant', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const flow = await authorizeAndConsent(h, owner.cookie, client.client_id);
    const exchanged = await tokenRequest(h, {
      grant_type: 'authorization_code', code: flow.callback.get('code'), client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: flow.started.verifier,
    });
    const rotated = await tokenRequest(h, {
      grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token, client_id: client.client_id,
    });
    expect(rotated.status).toBe(200);
    for (let i = 0; i < 120; i++) expect((await h.call(exchanged.body.access_token, 'ping')).status).toBe(200);
    expect((await h.call(rotated.body.access_token, 'ping')).status).toBe(429);
  });

  it('carries only a valid signed request through the sign-in email link', async () => {
    const h = oauthHarness();
    await h.start();
    const owner = await h.signInOwner();
    const client = await register(h);
    const started = await beginAuthorization(h, client.client_id);
    const valid = await h.api(undefined, 'POST', '/api/auth/request', { email: owner.email, oauthRequest: started.envelope });
    expect(valid.status).toBe(200);
    const validLink = h.mails().at(-1)?.text ?? '';
    expect(validLink).toContain(encodeURIComponent(started.envelope!));

    const invalid = await h.api(undefined, 'POST', '/api/auth/request', { email: owner.email, oauthRequest: 'tampered-envelope' });
    expect(invalid.status).toBe(200);
    const invalidLink = h.mails().at(-1)?.text ?? '';
    expect(invalidLink).not.toContain('oauthRequest=');
  });
});
