import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { isPublicLinkAddress } from '../server/link-guard.mjs';
import { createAssetHandlers } from '../server/asset-routes.mjs';
import { createAssetStore, createUploadLimiter } from '../server/assets.mjs';
import { SECRET, makePng } from './image-fixtures';

// docs/link-cards.md, "Fetching a preview" (slice 2a: the route, who may ask, the limits, the cache, the setting). The API runs
// in this process behind a real HTTP server; "the web" is local HTTP servers, reached through an injected resolver and an
// injected "public" range, so the real guard and the real fetcher run unchanged and every hop of every redirect is counted.

type Res = { status: number; body: any; headers: Headers; text: string };
const PAGE = '<head><title>Hello</title><meta property="og:description" content="A page"></head><body></body>';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

type Web = { port: number; hits: string[]; handler: (req: IncomingMessage, res: ServerResponse) => void };
async function startWeb(handler?: Web['handler']): Promise<Web> {
  const web: Web = { port: 0, hits: [], handler: handler ?? ((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  }) };
  const server: Server = http.createServer((req, res) => {
    web.hits.push(req.url ?? '');
    web.handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  web.port = (server.address() as AddressInfo).port;
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return web;
}

type Options = {
  env?: Record<string, string>;
  web: Web;
  /** What each host name resolves to; a function sees every lookup so a test can count them. */
  resolve?: (host: string) => string[];
  now?: () => number;
  cloud?: unknown;
  /** More local ports the guard may connect to (a second server a redirect points at). */
  ports?: number[];
  /** Gives the world an asset store; `boardQuota` in bytes. */
  assets?: { boardQuota?: number };
  limits?: Record<string, number>;
};

async function setup({ env = {}, web, resolve = () => ['127.0.0.1'], now = Date.now, cloud = null, ports = [], assets = undefined, limits = undefined }: Options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-unfurl-'));
  const config = loadConfig({ TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', DATA_DIR: dir, TABULA_MAIL: 'file', ...env }, () => {});
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} } });
  const store = assets ? createAssetStore({ dir: path.join(dir, 'assets'), index: directory, limits: { maxBytes: 10 * 1024 * 1024, boardQuota: assets.boardQuota ?? 50 * 1024 * 1024, totalQuota: 0 } }) : null;
  const lookups: string[] = [];
  const logged: string[] = [];
  const api = createApi({
    directory, auth, config, roomExists: () => false, events: new EventEmitter(), mailer: { send: async () => {} }, now, cloud: cloud as never,
    ...(store ? { assets: { store, handlers: createAssetHandlers({ store, limiter: createUploadLimiter() }) } as never } : {}),
    log: (...args: unknown[]) => logged.push(args.join(' ')),
    link: {
      ...(limits ? { limits } : {}),
      fetchOptions: {
        lookup: async (host: string) => {
          lookups.push(host);
          return resolve(host).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
        },
        isPublicAddress: (address: string) => address === '127.0.0.1' || isPublicLinkAddress(address),
        allowedPorts: { http: [web.port, ...ports], https: [443] },
      },
    },
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve2) => server.listen(0, '127.0.0.1', resolve2));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    directory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;
  const signIn = (role: 'owner' | 'admin' | 'member') => {
    const user = directory.createUser({ email: `${role}${++n}-${crypto.randomBytes(3).toString('hex')}@example.com`, role })!;
    const session = directory.createSession(user.id, { ttlMs: 3_600_000 });
    return { user, cookie: `${config.cookieName}=${session.token}` };
  };
  const call = async (who: { cookie: string } | null, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(base + urlPath, {
      method,
      headers: { 'x-tabula': '1', ...(who ? { cookie: who.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers, text };
  };
  /** A board owned by `owner`, shared with `role` to another member. */
  const boardWith = (owner: { user: { id: string } }, shared: { user: { id: string } } | null, role: 'editor' | 'commenter' | 'viewer' = 'editor') => {
    const id = `b${crypto.randomBytes(4).toString('hex')}`;
    directory.createBoard({ id, title: 'T', ownerId: owner.user.id });
    if (shared) directory.shareBoard(id, { principalType: 'user', principalId: shared.user.id, role });
    return id;
  };
  const unfurl = (who: { cookie: string } | null, board: string, url: unknown, headers: Record<string, string> = {}) => call(who, 'POST', `/api/boards/${board}/unfurl`, { url }, headers);
  const target = (p = '/') => `http://preview.test:${web.port}${p}`;
  return { store, base, config, directory, call, signIn, boardWith, unfurl, target, lookups, logged };
}

describe('who may ask', () => {
  it('answers owners and editors with the text fields, and refuses everyone else', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const owner = w.signIn('owner');
    const editor = w.signIn('member');
    const commenter = w.signIn('member');
    const viewer = w.signIn('member');
    const stranger = w.signIn('member');
    const board = w.boardWith(owner, editor, 'editor');
    w.directory.shareBoard(board, { principalType: 'user', principalId: commenter.user.id, role: 'commenter' });
    w.directory.shareBoard(board, { principalType: 'user', principalId: viewer.user.id, role: 'viewer' });

    const ok = await w.unfurl(editor, board, w.target('/a'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'Hello', description: 'A page', image: null, icon: null });
    expect((await w.unfurl(owner, board, w.target('/b'))).status).toBe(200);
    expect((await w.unfurl(commenter, board, w.target('/c'))).status).toBe(403);
    expect((await w.unfurl(viewer, board, w.target('/d'))).status).toBe(403);
    expect((await w.unfurl(stranger, board, w.target('/e'))).status).toBe(404);
    expect((await w.unfurl(null, board, w.target('/f'))).status).toBe(401);
    expect(web.hits).toEqual(['/a', '/b']);
  });
});

describe('guests', () => {
  it('refuses a join-code guest of every role with its own code, and fetches nothing', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on', TABULA_JOIN_CODES: 'on' } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    for (const role of ['editor', 'commenter']) {
      const code = w.directory.createJoinCode({ boardId: board, createdBy: owner.user.id, codeHash: `h-${role}`, role, createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, maxUses: 5 });
      const token = `guest-token-${role}`;
      w.directory.createGuestSession(code!.id, { tokenHash: createHash('sha256').update(token).digest('hex'), name: 'Guest' });
      const guest = { cookie: `${w.config.cookieName}=${token}` };
      const res = await w.unfurl(guest, board, w.target('/g'));
      expect([role, res.status, res.body.error]).toEqual([role, 403, 'guests_cannot_preview']);
      // a guest of this board may not ask about another board either
      expect((await w.unfurl(guest, w.boardWith(owner, null), w.target('/g'))).status).toBe(403);
    }
    expect(web.hits).toEqual([]);
  });
});

describe('the workspace setting and the operator switch', () => {
  it('answers 402 when the workspace is read-only, without fetching', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, cloud: { limits: () => ({ readOnly: true }), workspaceView: () => ({}) } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target());
    expect([res.status, res.body.error]).toEqual([402, 'read_only']);
    expect(web.hits).toEqual([]);
  });

  it('is off for a self-hosted workspace until an admin turns it on, and the admin can turn it off again', async () => {
    const web = await startWeb();
    const w = await setup({ web });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const off = await w.unfurl(owner, board, w.target());
    expect([off.status, off.body.error]).toEqual([409, 'previews_off']);
    expect(web.hits).toEqual([]);

    expect((await w.call(owner, 'PUT', '/api/admin/link-previews', { enabled: true })).body).toMatchObject({ enabled: true, setting: true });
    expect((await w.unfurl(owner, board, w.target())).status).toBe(200);
    expect((await w.call(owner, 'PUT', '/api/admin/link-previews', { enabled: false })).body).toMatchObject({ enabled: false });
    expect((await w.unfurl(owner, board, w.target('/2'))).status).toBe(409);
    expect(w.directory.listAudit(5).map((r) => String(r.action))).toEqual(expect.arrayContaining(['linkPreviews.enabled', 'linkPreviews.disabled']));
  });

  it('lets only admins read or change the setting, and validates it', async () => {
    const web = await startWeb();
    const w = await setup({ web });
    const member = w.signIn('member');
    const admin = w.signIn('admin');
    expect((await w.call(member, 'GET', '/api/admin/link-previews')).status).toBe(403);
    expect((await w.call(member, 'PUT', '/api/admin/link-previews', { enabled: true })).status).toBe(403);
    expect((await w.call(admin, 'PUT', '/api/admin/link-previews', { enabled: 'yes' })).status).toBe(400);
    expect((await w.call(admin, 'PUT', '/api/admin/link-previews', { enabled: true, extra: 1 })).status).toBe(400);
  });

  it('is on by default for a hosted workspace', async () => {
    const web = await startWeb();
    const w = await setup({ web, cloud: { limits: () => ({ readOnly: false }), workspaceView: () => ({}) } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    expect((await w.unfurl(owner, board, w.target())).status).toBe(200);
  });

  it('is shut by TABULA_LINK_PREVIEWS=off whatever the setting says, and the setting cannot be changed against it', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'off' } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    w.directory.setSetting('linkPreviews.enabled', '1');
    expect((await w.unfurl(owner, board, w.target())).status).toBe(409);
    const put = await w.call(owner, 'PUT', '/api/admin/link-previews', { enabled: true });
    expect([put.status, put.body.error]).toEqual([409, 'link_previews_locked']);
    expect(web.hits).toEqual([]);
  });

  it('refuses an invalid operator value at start', () => {
    expect(() => loadConfig({ TABULA_LINK_PREVIEWS: 'maybe' }, () => {})).toThrow(/TABULA_LINK_PREVIEWS/);
  });

  it('tells the signed-in person whether previews are on', async () => {
    const web = await startWeb();
    const w = await setup({ web });
    const owner = w.signIn('owner');
    expect((await w.call(owner, 'GET', '/api/me')).body.linkPreviews).toBeUndefined();
    w.directory.setSetting('linkPreviews.enabled', '1');
    expect((await w.call(owner, 'GET', '/api/me')).body.linkPreviews).toBe(true);
  });
});

describe('the address', () => {
  it('turns away addresses that are not web addresses, carry credentials, or are too long', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    for (const bad of [undefined, 42, '', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c', `http://x.test/${'a'.repeat(2100)}`]) {
      const res = await w.unfurl(owner, board, bad);
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    const creds = await w.unfurl(owner, board, 'https://user:pass@example.com/');
    expect([creds.status, creds.body.error, creds.body.message]).toEqual([400, 'credentials_in_url', "Addresses that contain a user name or password cannot be added."]);
    expect(web.hits).toEqual([]);
  });

  it('refuses private, local and metadata targets without a lookup or a connection', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    for (const target of ['http://localhost/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:10.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'https://example.com:8443/']) {
      const res = await w.unfurl(owner, board, target);
      expect([target, res.status, res.body.error]).toEqual([target, 422, 'blocked']);
    }
    expect(w.lookups).toEqual([]);
    expect(web.hits).toEqual([]);
  });
});

describe('the guard runs on every hop', () => {
  it('resolves and checks each hop of a redirect chain, and fetches nothing from a hop that fails the check', async () => {
    const hop2 = await startWeb();
    const hop1 = await startWeb((_req, res) => {
      res.writeHead(302, { location: `http://second.test:${hop2.port}/landed` });
      res.end();
    });
    const w = await setup({
      web: hop1,
      ports: [hop2.port],
      env: { TABULA_LINK_PREVIEWS: 'on' },
      resolve: (host) => (host === 'second.test' ? ['10.0.0.9'] : ['127.0.0.1']),
    });
    // the second server is "public" only by address, and 10.0.0.9 is private: the redirect target is refused
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target('/go'));
    expect([res.status, res.body.error]).toEqual([422, 'blocked']);
    expect(hop1.hits).toEqual(['/go']);
    expect(hop2.hits).toEqual([]);
    expect(w.lookups).toEqual(['preview.test', 'second.test']);
  });

  it('counts one lookup per hop on a good redirect chain and follows at most three redirects', async () => {
    let target = '';
    const web = await startWeb((req, res) => {
      const n = Number((req.url ?? '').split('/').pop());
      if (n < 9) {
        res.writeHead(302, { location: `${target}/r/${n + 1}` });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE);
      }
    });
    target = `http://preview.test:${web.port}`;
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const tooMany = await w.unfurl(owner, board, `${target}/r/0`);
    expect(tooMany.status).toBe(422);
    expect(w.lookups).toHaveLength(4); // the address and three redirects; the fourth redirect is never followed
    expect(web.hits).toHaveLength(4);
    const three = await w.unfurl(owner, board, `${target}/r/6`);
    expect(three.status).toBe(200); // 6 -> 7 -> 8 -> 9 is exactly three redirects
    expect(three.body.finalUrl).toBe(`${target}/r/9`);
    expect((await w.unfurl(owner, board, `${target}/r/5`)).status).toBe(422); // four
  });

  it('keeps the address it checked: a resolver that turns private after the first answer changes nothing', async () => {
    const web = await startWeb();
    let answers = 0;
    const w = await setup({
      web,
      env: { TABULA_LINK_PREVIEWS: 'on' },
      resolve: () => (answers++ === 0 ? ['127.0.0.1'] : ['10.0.0.1']),
    });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target());
    expect(res.status).toBe(200);
    expect(answers).toBe(1);
  });

  it('refuses a host with any private answer among its addresses', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, resolve: () => ['127.0.0.1', '192.168.1.5'] });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target());
    expect([res.status, res.body.error]).toEqual([422, 'blocked']);
    expect(web.hits).toEqual([]);
  });
});

describe('failures', () => {
  it('maps what went wrong to a fixed code, with no address or range in the answer', async () => {
    const web = await startWeb((req, res) => {
      if (req.url === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF'); }
      else if (req.url === '/404') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('no'); }
      else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<head><title>${'x'.repeat(2 * 1024 * 1024)}`); }
    });
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const codes: Record<string, string> = { '/pdf': 'not_html', '/404': 'http_status', '/big': 'too_large' };
    for (const [p, code] of Object.entries(codes)) {
      const res = await w.unfurl(owner, board, w.target(p));
      expect([p, res.status, res.body.error]).toEqual([p, 422, code]);
      expect(res.text).not.toMatch(/127\.0\.0\.1|10\.0\./);
    }
    // the log carries the code and the host, never the path or the query
    expect(w.logged.join('\n')).toContain('link-preview: not_html preview.test');
    expect(w.logged.join('\n')).not.toMatch(/\/pdf|\/404|\/big/);
  });

  it('remembers a failure for ten minutes and a success for a day', async () => {
    let t = 1_000_000;
    let mode: 'down' | 'up' = 'down';
    const web = await startWeb((_req, res) => {
      if (mode === 'down') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('x'); } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); }
    });
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, now: () => t });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const address = w.target('/x');
    expect((await w.unfurl(owner, board, address)).body.error).toBe('http_status');
    mode = 'up';
    expect((await w.unfurl(owner, board, address)).body.error).toBe('http_status'); // still the remembered failure
    expect(web.hits).toHaveLength(1);
    t += 10 * 60_000 + 1;
    expect((await w.unfurl(owner, board, address)).status).toBe(200);
    expect(web.hits).toHaveLength(2);
    t += 23 * 3_600_000;
    expect((await w.unfurl(owner, board, address)).status).toBe(200);
    expect(web.hits).toHaveLength(2); // a day's cache, shared with other boards and people
    t += 2 * 3_600_000;
    expect((await w.unfurl(owner, board, address)).status).toBe(200);
    expect(web.hits).toHaveLength(3);
  });

  it('serves a second person from the cache, across boards', async () => {
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const a = w.signIn('owner');
    const b = w.signIn('member');
    const one = w.boardWith(a, null);
    const two = w.boardWith(b, null);
    expect((await w.unfurl(a, one, w.target('/same'))).status).toBe(200);
    expect((await w.unfurl(b, two, w.target('/same'))).status).toBe(200);
    expect(web.hits).toEqual(['/same']);
  });
});

describe('limits', () => {
  it('stops a person at 30 a minute with Retry-After, and lets the window pass', async () => {
    let t = 5_000_000;
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, now: () => t });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    for (let i = 0; i < 30; i++) expect((await w.unfurl(owner, board, w.target('/same'))).status).toBe(200);
    const limited = await w.unfurl(owner, board, w.target('/same'));
    expect([limited.status, limited.body.error]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    t += 61_000;
    expect((await w.unfurl(owner, board, w.target('/same'))).status).toBe(200);
  });

  it('fetches one address once for two askers at the same time, and refuses a second address on a busy host', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const web = await startWeb((_req, res) => {
      void gate.then(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    });
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const a = w.signIn('owner');
    const b = w.signIn('member');
    const board = w.boardWith(a, b, 'editor');
    const first = w.unfurl(a, board, w.target('/one'));
    await until(() => web.hits.length === 1);
    const same = w.unfurl(b, board, w.target('/one'));
    const other = await w.unfurl(b, board, w.target('/two'));
    expect([other.status, other.body.error]).toEqual([429, 'rate_limited']);
    release();
    expect((await first).status).toBe(200);
    expect((await same).status).toBe(200);
    expect(web.hits).toEqual(['/one']);
  });
});

describe('going away', () => {
  it('stops the upstream request when the only asker disconnects', async () => {
    let closedUpstream = false;
    const web = await startWeb((req, res) => {
      req.socket.on('close', () => { closedUpstream = true; });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<head><title>slow');
    });
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const controller = new AbortController();
    const request = fetch(`${w.base}/api/boards/${board}/unfurl`, {
      method: 'POST',
      headers: { 'x-tabula': '1', cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ url: w.target('/slow') }),
      signal: controller.signal,
    }).catch(() => {});
    await until(() => web.hits.length === 1);
    controller.abort();
    await request;
    await until(() => closedUpstream);
    expect(closedUpstream).toBe(true);
    // an abort is nobody's failure: it is not remembered, so the next asker fetches again
    web.handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); };
    const again = await w.unfurl(owner, board, w.target('/slow'));
    expect(again.status).toBe(200);
    expect(web.hits).toEqual(['/slow', '/slow']);
  });
});

describe('open mode', () => {
  it('has no route in the API (open mode answers from the relay, see assets-open for its harness)', () => {
    expect(loadConfig({ TABULA_LINK_PREVIEWS: 'on' }, () => {}).linkPreviews).toEqual({ forced: 'on' });
    expect(loadConfig({}, () => {}).linkPreviews).toEqual({ forced: null });
  });
});

async function until(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------- slice 2b: preview images and icons

const png = (w = 4, h = 3) => makePng({ width: w, height: h });
const withImages = (images: Record<string, () => Buffer | { status: number; location?: string }>, head = '<meta property="og:image" content="/p.png"><link rel="icon" href="/i.png">') =>
  (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<head><title>Pics</title>${head}</head>`);
      return;
    }
    const made = images[url]?.();
    if (!made) { res.writeHead(404).end(); return; }
    if (Buffer.isBuffer(made)) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(made); return; }
    res.writeHead(made.status, made.location ? { location: made.location } : {}).end();
  };

describe('preview images and icons', () => {
  it('stores the image and the icon as assets of the board, stripped, and answers their hashes and size', async () => {
    const web = await startWeb(withImages({ '/p.png': () => png(40, 30), '/i.png': () => makePng({ width: 16, height: 16, text: true }) }));
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, assets: {} });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target('/page'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Pics', imageW: 40, imageH: 30 });
    const image = w.store!.read(board, res.body.image);
    const icon = w.store!.read(board, res.body.icon);
    expect([image?.row.mime, icon?.row.width]).toEqual(['image/png', 16]);
    expect(icon!.bytes.includes(Buffer.from(SECRET))).toBe(false); // the metadata is stripped like an upload's
    expect(w.directory.getAsset(board, res.body.image)?.createdBy).toBe(owner.user.id);
  });

  it('sends the image and icon addresses through the guard on every hop, and fetches nothing from a refused one', async () => {
    const hidden = await startWeb(() => { throw new Error('must not be reached'); });
    const web = await startWeb(withImages({
      '/p.png': () => ({ status: 302, location: `http://private.test:${hidden.port}/secret.png` }),
      '/i.png': () => ({ status: 302, location: `http://good.test:${web_port()}/i2.png` }),
      '/i2.png': () => png(8, 8),
    }));
    function web_port() { return web.port; }
    const w = await setup({
      web,
      ports: [hidden.port],
      env: { TABULA_LINK_PREVIEWS: 'on' },
      assets: {},
      resolve: (host) => (host === 'private.test' ? ['10.0.0.7'] : ['127.0.0.1']),
    });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target('/page'));
    expect(res.status).toBe(200);
    expect(res.body.image).toBeNull(); // the redirect to a private address was refused
    expect(res.body.icon).toMatch(/^[0-9a-f]{64}$/); // a redirect to a public one was followed
    expect(hidden.hits).toEqual([]);
    // page, image, its refused hop, icon, its second hop: every one resolved
    expect(w.lookups).toEqual(expect.arrayContaining(['preview.test', 'private.test', 'good.test']));
    expect(w.lookups.filter((h) => h === 'private.test')).toHaveLength(1);
  });

  it('refuses an image address that is private to begin with, without any lookup of a literal address', async () => {
    const web = await startWeb(withImages({}, '<meta property="og:image" content="http://169.254.169.254/latest/p.png"><link rel="icon" href="http://10.1.2.3/f.ico">'));
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, assets: {} });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target('/page'));
    expect([res.status, res.body.title, res.body.image, res.body.icon]).toEqual([200, 'Pics', null, null]);
    expect(w.lookups).toEqual(['preview.test']);
  });

  it('keeps the text when the image is not an image, too large or an unsupported type', async () => {
    const web = await startWeb(withImages({ '/p.png': () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), '/i.png': () => Buffer.alloc(300 * 1024, 1) }));
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, assets: {} });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target('/page'));
    expect([res.status, res.body.title, res.body.image, res.body.icon]).toEqual([200, 'Pics', null, null]);
  });

  it('drops an image that would pass the board quota and keeps the text', async () => {
    const web = await startWeb(withImages({ '/p.png': () => png(40, 30), '/i.png': () => png(4, 4) }));
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, assets: { boardQuota: 1 } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const res = await w.unfurl(owner, board, w.target('/page'));
    expect([res.status, res.body.title, res.body.image, res.body.icon]).toEqual([200, 'Pics', null, null]);
    expect(w.store!.boardBytes(board)).toBe(0);
  });

  it('gives a second board the same images without fetching again, and re-fetches when the first board lost them', async () => {
    const web = await startWeb(withImages({ '/p.png': () => png(40, 30), '/i.png': () => png(4, 4) }));
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, assets: {} });
    const a = w.signIn('owner');
    const b = w.signIn('member');
    const one = w.boardWith(a, null);
    const two = w.boardWith(b, null);
    const first = await w.unfurl(a, one, w.target('/page'));
    const second = await w.unfurl(b, two, w.target('/page'));
    expect(second.body.image).toBe(first.body.image);
    expect(web.hits).toEqual(['/page', '/p.png', '/i.png']);
    expect(w.store!.read(two, second.body.image)?.row.createdBy).toBe(b.user.id);
    // the source's rows and files go away: the next board fetches the page again instead of answering with images it cannot give
    for (const board of [one, two]) { w.directory.deleteAsset(board, first.body.image); w.directory.deleteAsset(board, first.body.icon); }
    const three = w.boardWith(a, null);
    const third = await w.unfurl(a, three, w.target('/page'));
    expect(third.status).toBe(200);
    expect(web.hits.filter((u) => u === '/page')).toHaveLength(2);
    expect(w.store!.read(three, third.body.image)).not.toBeNull();
  });

  it('shares five seconds between the image and the icon, and stops them when the asker goes', async () => {
    let imageClosed = false;
    const web = await startWeb((req, res) => {
      if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<head><title>Slow</title><meta property="og:image" content="/p.png"></head>'); return; }
      req.socket.on('close', () => { imageClosed = true; });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.alloc(8));
    });
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, assets: {}, limits: { imageDeadlineMs: 300 } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const t0 = Date.now();
    const res = await w.unfurl(owner, board, w.target('/page'));
    expect([res.status, res.body.title, res.body.image]).toEqual([200, 'Slow', null]);
    expect(Date.now() - t0).toBeLessThan(3000);
    await until(() => imageClosed);
  });
});

describe('the limits that were fixed constants', () => {
  it('stops at the hourly person limit, the workspace limit and four fetches in flight', async () => {
    let t = 9_000_000;
    const web = await startWeb();
    const w = await setup({ web, env: { TABULA_LINK_PREVIEWS: 'on' }, now: () => t, limits: { personPerMinute: 1000, personPerHour: 3, workspacePerHour: 5, inFlight: 4 } });
    const a = w.signIn('owner');
    const b = w.signIn('member');
    const board = w.boardWith(a, b, 'editor');
    for (let i = 0; i < 3; i++) expect((await w.unfurl(a, board, w.target('/same'))).status).toBe(200);
    const hourly = await w.unfurl(a, board, w.target('/same'));
    expect([hourly.status, hourly.body.error]).toEqual([429, 'rate_limited']);
    expect(Number(hourly.headers.get('retry-after'))).toBeGreaterThan(60);
    // another person still has the workspace budget: 3 used by a, 2 left
    for (let i = 0; i < 2; i++) expect((await w.unfurl(b, board, w.target('/same'))).status).toBe(200);
    const shared = await w.unfurl(b, board, w.target('/same'));
    expect([shared.status, shared.body.error]).toEqual([429, 'rate_limited']);
    t += 3_600_001;
    expect((await w.unfurl(a, board, w.target('/same'))).status).toBe(200);
  });

  it('refuses a fifth fetch while four are in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const webs = [await startWeb(), await startWeb(), await startWeb(), await startWeb(), await startWeb()];
    for (const x of webs) x.handler = (_req, res) => { void gate.then(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); }); };
    const w = await setup({ web: webs[0], ports: webs.slice(1).map((x) => x.port), env: { TABULA_LINK_PREVIEWS: 'on' }, limits: { inFlight: 4 } });
    const owner = w.signIn('owner');
    const board = w.boardWith(owner, null);
    const hosts = ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'];
    const calls = webs.slice(0, 4).map((x, i) => w.unfurl(owner, board, `http://${hosts[i]}:${x.port}/`));
    await until(() => webs.slice(0, 4).every((x) => x.hits.length === 1));
    const fifth = await w.unfurl(owner, board, `http://${hosts[4]}:${webs[4].port}/`);
    expect([fifth.status, fifth.body.error]).toEqual([429, 'rate_limited']);
    expect(fifth.body.message).toBe('Previews are busy right now. Try again in a moment.');
    release();
    for (const call of await Promise.all(calls)) expect(call.status).toBe(200);
  });
});
