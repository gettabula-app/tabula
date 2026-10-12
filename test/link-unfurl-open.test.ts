import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness } from './mcp-harness';

// docs/link-cards.md, "Who may ask": open mode has no accounts, so previews exist only with TABULA_LINK_PREVIEWS=on and are
// counted per client address. The relay runs as a child process, so the real resolver and the real guard are in play and only
// refusals and failures can be asserted here (the success path is in link-unfurl-api.test.ts).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const post = (base: string, board: string, body: unknown, headers: Record<string, string> = { 'x-tabula': '1' }) =>
  fetch(`${base}/api/boards/${board}/unfurl`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (res) => ({ status: res.status, headers: res.headers, body: await res.json().catch(() => undefined) }));

describe('off by default', () => {
  const h = createHarness({});
  beforeAll(() => h.start());
  afterAll(() => h.cleanup());

  it('has no unfurl route', async () => {
    const res = await post(h.base, 'board1', { url: 'https://example.com/' });
    expect(res.status).toBe(404);
  });
});

describe('with TABULA_LINK_PREVIEWS=on', () => {
  const h = createHarness({ settings: { LINK_PREVIEWS: 'on' } });
  beforeAll(() => h.start());
  afterAll(() => h.cleanup());

  it('needs the x-tabula header and a POST', async () => {
    expect((await post(h.base, 'board1', { url: 'https://example.com/' }, {})).status).toBe(403);
    const get = await fetch(`${h.base}/api/boards/board1/unfurl`);
    expect(get.status).toBe(405);
  });

  it('refuses addresses the guard refuses, before any lookup', async () => {
    for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'https://example.com:8443/']) {
      const res = await post(h.base, 'board1', { url });
      expect([url, res.status, res.body?.error]).toEqual([url, 422, 'blocked']);
    }
    expect((await post(h.base, 'board1', { url: 'https://user:pw@example.com/' })).body?.error).toBe('credentials_in_url');
    expect((await post(h.base, 'board1', { url: 'ftp://example.com/' })).body?.error).toBe('bad_url');
    expect((await post(h.base, 'board1', 'x')).status).toBe(400);
  });

  it('counts each client address: ten a minute, then 429 with Retry-After', async () => {
    // an address that cannot resolve fails fast and is remembered as a failure, so the same one can be asked again
    const url = 'http://no-such-host.invalid/';
    for (let i = 0; i < 10; i++) expect((await post(h.base, 'board2', { url })).status).toBe(422);
    const limited = await post(h.base, 'board2', { url });
    expect([limited.status, limited.body?.error]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
