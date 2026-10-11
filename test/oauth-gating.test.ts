import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './mcp-harness';

const instances: Harness[] = [];

afterEach(async () => {
  for (const h of instances.splice(0)) await h.cleanup();
});

describe('OAuth gating', () => {
  it('keeps OAuth paths dark when the feature flag is off and refuses tbo_ immediately', async () => {
    const h = createHarness({ accounts: true, settings: { MCP: 'on', MCP_OAUTH: 'off' } });
    instances.push(h);
    await h.start();
    const owner = await h.signInOwner();
    const personal = await h.newToken(owner.cookie, { scope: 'read' });

    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/authorize',
      '/oauth/token',
      '/oauth/revoke',
      '/api/oauth/requests',
    ]) {
      expect((await h.api(undefined, 'GET', path)).status).toBe(404);
    }
    expect((await h.call(`tbo_${'x'.repeat(43)}`, 'ping')).status).toBe(401);
    expect((await h.call(personal.token, 'ping')).status).toBe(200);
    const challenge = await h.call(`tbl_${'x'.repeat(43)}`, 'ping');
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('keeps all OAuth routes dark when MCP is off', async () => {
    const h = createHarness({ accounts: true, settings: { MCP: 'off', MCP_OAUTH: 'on' } });
    instances.push(h);
    await h.start();
    expect((await h.api(undefined, 'GET', '/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await h.api(undefined, 'POST', '/oauth/register', { redirect_uris: ['https://claude.ai/callback'] })).status).toBe(404);
    expect((await h.api(undefined, 'GET', '/api/oauth/requests')).status).toBe(404);
    expect((await h.call(`tbo_${'x'.repeat(43)}`, 'ping')).status).toBe(404);
  });

  it('ignores OAuth in open mode while preserving the configured open bearer', async () => {
    const token = 'o'.repeat(32);
    const h = createHarness({ accounts: false, settings: { MCP: 'on', MCP_OAUTH: 'on', MCP_TOKEN: token } });
    instances.push(h);
    await h.start();
    expect((await h.api(undefined, 'GET', '/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await h.api(undefined, 'POST', '/oauth/register', { redirect_uris: ['https://claude.ai/callback'] })).status).toBe(404);
    expect((await h.api(undefined, 'GET', '/api/oauth/requests')).status).toBe(404);
    expect((await h.call(token, 'ping')).status).toBe(200);
    const rejected = await h.call(`tbo_${'x'.repeat(43)}`, 'ping');
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('www-authenticate')).toBe('Bearer');
  });
});
