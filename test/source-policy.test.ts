import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../server/config.mjs';
import { createSourceGate, loadSourcePolicy } from '../server/source-policy.mjs';
import { createHarness } from './mcp-harness';

// TAB-103, docs/cloud.md "Source policy": with TABULA_SOURCE_POLICY=proxy an instance accepts loopback and Fly's proxy
// range (172.16.0.0/12) and refuses every other peer, in particular the `fdaa:` addresses of other apps on 6PN. Off by default.

const gateFor = (env: Record<string, string>) => createSourceGate(loadSourcePolicy(env));

describe('the source policy setting', () => {
  it('is off unless asked for, and then checks nothing', () => {
    expect(loadSourcePolicy({})).toEqual({ mode: 'off', sources: [] });
    expect(loadSourcePolicy({ TABULA_SOURCE_POLICY: 'off', TABULA_ALLOW_SOURCES: 'nonsense' })).toEqual({ mode: 'off', sources: [] });
    expect(gateFor({}).allows('fdaa:1::2')).toBe(true);
    expect(gateFor({}).enforcing).toBe(false);
  });

  it('refuses a value that is not off or proxy, and a bad address list', () => {
    expect(() => loadSourcePolicy({ TABULA_SOURCE_POLICY: 'strict' })).toThrow('TABULA_SOURCE_POLICY must be off or proxy');
    for (const bad of ['10.0.0.0/33', 'fdaa::/129', 'example.com', '10.0.0.0/x', '10.0.0.1%eth0', '10.0.0.0/-1']) {
      expect(() => loadSourcePolicy({ TABULA_SOURCE_POLICY: 'proxy', TABULA_ALLOW_SOURCES: bad })).toThrow('TABULA_ALLOW_SOURCES entry is not a valid');
    }
  });

  it('is part of the configuration', () => {
    expect(loadConfig({}, () => {}).sourcePolicy.mode).toBe('off');
    expect(loadConfig({ TABULA_SOURCE_POLICY: 'proxy' }, () => {}).sourcePolicy.mode).toBe('proxy');
  });
});

describe('the gate with the default list', () => {
  const gate = gateFor({ TABULA_SOURCE_POLICY: 'proxy' });

  it('accepts loopback and the whole proxy range', () => {
    for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '172.16.5.18', '172.31.255.255', '::ffff:172.16.5.18']) expect([a, gate.allows(a)]).toEqual([a, true]);
  });

  it('refuses 6PN addresses, public addresses, the edges of the range and anything that is not an address', () => {
    for (const a of ['fdaa:0:1234::3', 'fdaa:1:2:3:4:5:6:7', '172.15.255.255', '172.32.0.0', '10.0.0.1', '203.0.113.7', '::', '2001:db8::1', '', undefined, 'unknown', '172.16.5.18:80']) {
      expect([a, gate.allows(a as string)]).toEqual([a, false]);
    }
  });

  it('can be given its own list, which replaces the default', () => {
    const own = gateFor({ TABULA_SOURCE_POLICY: 'proxy', TABULA_ALLOW_SOURCES: '10.1.0.0/16, fdaa:0:1::/48 ,192.0.2.9' });
    expect(own.allows('10.1.2.3')).toBe(true);
    expect(own.allows('fdaa:0:1::7')).toBe(true);
    expect(own.allows('192.0.2.9')).toBe(true);
    expect(own.allows('127.0.0.1')).toBe(false);
    expect(own.allows('172.16.5.18')).toBe(false);
  });

  it('logs the first refusal of a source once and bounds what it remembers', () => {
    const lines: string[] = [];
    const g = createSourceGate(loadSourcePolicy({ TABULA_SOURCE_POLICY: 'proxy' }), { log: (l) => lines.push(l) });
    for (let i = 0; i < 5; i++) g.refused('fdaa:0:1::9');
    expect(lines).toEqual(['source policy: refused a connection from fdaa:0:1::9']);
    for (let i = 0; i < 1_200; i++) g.refused(`198.51.${Math.floor(i / 256)}.${i % 256}`);
    expect(g.refusedSources).toBe(1_000);
  });
});

// A real relay whose list does not contain loopback, so every test connection here is a refused source.
describe('a relay that refuses the connection address', () => {
  const closed = createHarness({ accounts: true, env: { TABULA_SOURCE_POLICY: 'proxy', TABULA_ALLOW_SOURCES: '10.0.0.0/8' } });
  const open = createHarness({ accounts: true, env: { TABULA_SOURCE_POLICY: 'proxy' } });
  afterAll(async () => {
    await closed.cleanup();
    await open.cleanup();
  });

  it('resets API calls and the page, but still answers the health check', async () => {
    await closed.start();
    const health = await fetch(`${closed.base}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    for (const [method, path] of [['GET', '/api/me'], ['GET', '/'], ['POST', '/api/auth/request'], ['GET', '/api/internal/usage'], ['POST', '/mcp']]) {
      await expect(fetch(`${closed.base}${path}`, { method, headers: { 'x-tabula': '1' } })).rejects.toThrow(/./);
    }
    // the health check is GET only: another method on that path is refused like the rest
    await expect(fetch(`${closed.base}/api/health`, { method: 'POST' })).rejects.toThrow(/./);
  });

  it('refuses a WebSocket upgrade', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${closed.base.replace('http', 'ws')}/sync/board-x`, { headers: { Origin: closed.base } });
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('error'));
      ws.on('close', () => resolve('close'));
    });
    expect(outcome).not.toBe('open');
  });

  it('logs the refusal once, with the address and nothing else of the request', async () => {
    const lines = closed.output().split('\n').filter((l) => l.includes('source policy: refused'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/refused a connection from (::ffff:)?127\.0\.0\.1|::1/);
    expect(closed.output()).not.toContain('/api/me');
  });

  it('serves everything to loopback with the default list, as a hosted machine does for its own exec calls', async () => {
    await open.start();
    const owner = await open.signInOwner();
    expect((await open.api(owner.cookie, 'GET', '/api/me')).status).toBe(200);
    const board = await open.newBoard(owner.cookie);
    const client = open.connect(board, owner.cookie);
    await client.synced();
    open.closeProviders();
  });
});
