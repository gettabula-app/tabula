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

describe('OAuth metadata and registration routes', () => {
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

  it('limits only new registrations by IP and leaves authorize, token and revoke unimplemented', async () => {
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

    for (const endpoint of ['/oauth/authorize', '/oauth/token', '/oauth/revoke', '/oauth/future']) {
      expect((await h.api(undefined, 'GET', endpoint)).status).toBe(404);
    }
    const wrongMethod = await h.api(undefined, 'GET', '/oauth/register');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
  });
});
