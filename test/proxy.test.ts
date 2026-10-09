import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { loadConfig } from '../server/config.mjs';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// The relay in accounts mode behind a reverse proxy that terminates https (docs/accounts.md, TABULA_TRUST_PROXY). The
// relay is a child process on plain http; a small Node proxy sits in front of it, adds X-Forwarded-For (appending the
// client address it saw, like nginx's $proxy_add_x_forwarded_for) and X-Forwarded-Proto, and forwards WebSocket upgrades.
// The test plays the browser: it talks to the proxy with the Host and Origin of the public https address.

const OWNER = 'owner@example.com';
const HOST = 'tabula.example';
const ORIGIN = `https://${HOST}`;
const SECURE_COOKIE = '__Host-tabula_session';

type Body = any;
type Res = { status: number; body: Body; setCookie: string[]; headers: http.IncomingHttpHeaders };

const startRelay = (port: number, dir: string, env: Record<string, string>) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ['server/relay.mjs'], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        HOST: '127.0.0.1',
        TABULA_AUTH: 'on',
        TABULA_OWNER_EMAIL: OWNER,
        TABULA_MAIL: 'file',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('relay did not start'));
    }, RELAY_START_MS);
    p.stdout!.on('data', (d) => {
      if (String(d).includes('Tabula relay')) {
        clearTimeout(timer);
        resolve(p);
      }
    });
    p.stderr!.on('data', () => {});
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code}`));
    });
  });

const stopRelay = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGTERM');
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
};

const within = <T>(p: Promise<T>, ms = 4000) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error('timed out')))]) as Promise<T>;

// ---------------------------------------------------------------- the proxy

type ProxyOptions = {
  target: number;
  /** Sent as X-Forwarded-Proto, or left out when null. */
  forwardedProto: 'https' | null;
  /** When false, Host is rewritten to the relay's own address, as nginx does unless told otherwise. */
  preserveHost: boolean;
  /**
   * Behave like Fly's edge followed by a `fly-replay` hop (TAB-71): Fly-Client-IP is set to the client (a client's own
   * value is replaced), and X-Forwarded-For ends with the replaying machine's address, not the client's.
   */
  fly?: boolean;
};

/** The address a `fly-replay` hop appends in the fake Fly setup. */
const REPLAY_HOP = '172.19.4.2';

/**
 * The address the proxy reports as the client is whatever the test puts in `x-test-client` (the test only ever
 * connects from this machine); the header itself is not forwarded. A client's own X-Forwarded-For is kept and the
 * client address is appended to it.
 */
async function startProxy(initial: ProxyOptions) {
  const options = { ...initial };
  const open = new Set<Duplex>();
  const track = (s: Duplex) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  };

  function upstreamHeaders(req: http.IncomingMessage) {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    const seen = headers['x-test-client'];
    const client = typeof seen === 'string' ? seen : (req.socket.remoteAddress ?? 'unknown');
    delete headers['x-test-client'];
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${client}` : client;
    if (options.fly) {
      headers['fly-client-ip'] = client;
      headers['x-forwarded-for'] = `${headers['x-forwarded-for']}, ${REPLAY_HOP}`;
    }
    headers['x-forwarded-host'] = req.headers.host;
    if (options.forwardedProto) headers['x-forwarded-proto'] = options.forwardedProto;
    else delete headers['x-forwarded-proto'];
    if (!options.preserveHost) headers.host = `127.0.0.1:${options.target}`;
    return headers;
  }

  const server = http.createServer((req, res) => {
    const headers = upstreamHeaders(req);
    delete headers.connection;
    delete headers['keep-alive'];
    const upstream = http.request({ host: '127.0.0.1', port: options.target, method: req.method, path: req.url, headers, agent: false }, (up) => {
      const raw: string[] = [];
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        if (!['connection', 'keep-alive'].includes(up.rawHeaders[i].toLowerCase())) raw.push(up.rawHeaders[i], up.rawHeaders[i + 1]);
      }
      res.writeHead(up.statusCode ?? 502, up.statusMessage, raw);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(options.target, '127.0.0.1');
    track(socket);
    track(upstream);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(upstreamHeaders(req))) {
      for (const v of [value].flat()) {
        if (v !== undefined) raw += `${name}: ${v}\r\n`;
      }
    }
    upstream.on('connect', () => {
      upstream.write(`${raw}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.end());
    socket.on('close', () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    options,
    stop: async () => {
      for (const s of open) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Proxy = Awaited<ReturnType<typeof startProxy>>;

// ---------------------------------------------------------------- the browser

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        agent: false,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, setCookie: res.headers['set-cookie'] ?? [], headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

let clientSeq = 0;
const nextClient = () => `198.51.100.${++clientSeq}`;
let emailSeq = 0;
const nextEmail = () => `flood${++emailSeq}x${Math.random().toString(36).slice(2, 7)}@example.com`;

/** A browser at `https://tabula.example`, reaching the relay through the proxy (or straight at the relay when `via` is the relay's port). */
const browser = (via: number, client?: string, base: { host: string; origin: string } = { host: HOST, origin: ORIGIN }) =>
  (method: string, urlPath: string, init: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    request(
      via,
      method,
      urlPath,
      {
        host: base.host,
        origin: base.origin,
        'x-tabula': '1',
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(client ? { 'x-test-client': client } : {}),
        ...init.headers,
      },
      init.body,
    );
type Browser = ReturnType<typeof browser>;

type Mail = { to: string; subject: string; text: string };
const lastMail = (dir: string): Mail => JSON.parse(fs.readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8').trim().split('\n').pop()!);
const tokenOf = (mail: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);

/** Signs in through `b` and returns the Set-Cookie header the server sent along with the `name=value` pair a browser would send back. */
async function signIn(b: Browser, dir: string, email = OWNER) {
  const asked = await b('POST', '/api/auth/request', { body: { email } });
  if (asked.status !== 200) throw new Error(`sign-in request failed with ${asked.status}`);
  const mail = lastMail(dir);
  const verify = await b('POST', '/api/auth/verify', { body: { token: tokenOf(mail) } });
  if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
  const setCookie = verify.setCookie[0];
  return { setCookie, cookie: setCookie.split(';')[0], mail, user: verify.body.user as Body };
}

// ---------------------------------------------------------------- websockets through the proxy

const sockets = new Set<WebSocket>();
const providers = new Set<WebsocketProvider>();

afterEach(() => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  for (const p of providers) p.destroy();
  providers.clear();
});

function rawSocket(port: number, room: string, headers: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/${room}`, { headers: { Host: HOST, ...headers } });
  sockets.add(ws);
  ws.on('error', () => {});
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const joined = new Promise<void>((resolve) => ws.once('message', () => resolve()));
  const rejected = new Promise<number>((resolve) =>
    ws.on('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    }),
  );
  return { ws, closed, joined, rejected };
}

function connect(port: number, room: string, cookie: string) {
  const doc = new Y.Doc();
  const polyfill = class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie } });
    }
  };
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/sync`, room, doc, {
    WebSocketPolyfill: polyfill as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  providers.add(provider);
  return { doc, provider };
}

const synced = (c: ReturnType<typeof connect>) => until(() => c.provider.wsconnected && c.provider.synced);

// ---------------------------------------------------------------- the servers

type Stack = { port: number; dir: string; relay: ChildProcess; proxy: Proxy };
const stacks: Stack[] = [];

/** A relay with its own proxy in front; every relay has its own in-memory rate limits. */
async function launch(env: Record<string, string>, proxy: Partial<ProxyOptions> = {}): Promise<Stack> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-proxy-'));
  const relay = await startRelay(port, dir, env);
  const front = await startProxy({ target: port, forwardedProto: 'https', preserveHost: true, ...proxy });
  const stack = { port, dir, relay, proxy: front };
  stacks.push(stack);
  return stack;
}

afterAll(async () => {
  for (const s of stacks) await s.proxy.stop();
  for (const s of stacks) {
    if (s.relay.exitCode === null && s.relay.signalCode === null) await stopRelay(s.relay);
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const PROXIED = { TABULA_BASE_URL: ORIGIN, TABULA_TRUST_PROXY: '1' };

// ---------------------------------------------------------------- tests

describe('behind a proxy that terminates https, with TABULA_TRUST_PROXY=1', { timeout: 30_000 }, () => {
  let server: Stack;
  let owner: Awaited<ReturnType<typeof signIn>>;
  let viaProxy: Browser;

  beforeAll(async () => {
    server = await launch(PROXIED);
    viaProxy = browser(server.proxy.port, nextClient());
    owner = await signIn(viaProxy, server.dir);
  });

  it('sets a __Host- prefixed, Secure, host-only cookie and links to the https address', async () => {
    expect(owner.mail.text).toContain(`${ORIGIN}/#/signin/verify?token=`);
    expect(owner.setCookie).toMatch(/^__Host-tabula_session=[A-Za-z0-9_-]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    expect(owner.setCookie).not.toMatch(/domain/i);

    const me = await viaProxy('GET', '/api/me', { cookie: owner.cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(OWNER);

    // the plain name is a different cookie as far as this server is concerned
    const plain = owner.cookie.replace(`${SECURE_COOKIE}=`, 'tabula_session=');
    expect((await viaProxy('GET', '/api/me', { cookie: plain })).status).toBe(401);
  });

  it('decides Secure from TABULA_BASE_URL alone: it makes no difference whether the proxy sends X-Forwarded-Proto', async () => {
    server.proxy.options.forwardedProto = null;
    try {
      const again = await signIn(viaProxy, server.dir);
      expect(again.setCookie).toMatch(/^__Host-tabula_session=[A-Za-z0-9_-]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
      expect((await viaProxy('GET', '/api/me', { cookie: again.cookie })).status).toBe(200);

      // signing out clears the same cookie with the same attributes, as a __Host- cookie needs
      const out = await viaProxy('POST', '/api/auth/logout', { cookie: again.cookie });
      expect(out.status).toBe(204);
      expect(out.setCookie[0]).toBe(`${SECURE_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax; Secure`);
      expect((await viaProxy('GET', '/api/me', { cookie: again.cookie })).status).toBe(401);
    } finally {
      server.proxy.options.forwardedProto = 'https';
    }
  });

  it('rate limits by the rightmost X-Forwarded-For entry and ignores whatever a client puts to its left', async () => {
    const abuser = nextClient();
    const bystander = nextClient();
    const ask = (client: string, forged: string) =>
      browser(server.proxy.port, client)('POST', '/api/auth/request', { body: { email: nextEmail() }, headers: { 'x-forwarded-for': forged } });

    for (let i = 0; i < 20; i++) expect((await ask(abuser, `7.7.7.${i}`)).status).toBe(200);
    const over = await ask(abuser, '7.7.7.200');
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('rate_limited');
    expect(over.headers['retry-after']).toBe('3600');

    // somebody else is not limited, even when they claim to be the abuser, and the abuser cannot become somebody else
    expect((await ask(bystander, abuser)).status).toBe(200);
    expect((await ask(abuser, bystander)).status).toBe(429);
    expect((await ask(abuser, '')).status).toBe(429);
  });

  it('falls back to the connection address when there is no usable X-Forwarded-For entry', async () => {
    const direct = (forwarded?: string) =>
      browser(server.port)('POST', '/api/auth/request', { body: { email: nextEmail() }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

    for (let i = 0; i < 10; i++) expect((await direct()).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await direct(' , ,')).status).toBe(200);
    expect((await direct()).status).toBe(429);
    expect((await direct(' , ,')).status).toBe(429);
    // anyone who can reach the relay without the proxy can pick their own address, which is why the variable is off by default
    expect((await direct('203.0.113.250')).status).toBe(200);
  });

  it('only lets a WebSocket in whose Origin is the https address, whatever the proxy says about the scheme', async () => {
    const board = 'proxied-origin';
    expect((await viaProxy('POST', '/api/boards', { cookie: owner.cookie, body: { id: board } })).status).toBe(201);
    const join = (headers: Record<string, string>) => rawSocket(server.proxy.port, board, { Cookie: owner.cookie, ...headers });

    const good = join({ Origin: ORIGIN });
    await within(good.joined);
    expect(good.ws.readyState).toBe(WebSocket.OPEN);

    const refused: Record<string, string>[] = [
      { Origin: 'http://tabula.example' }, // right host, wrong scheme, although the proxy claims https
      { Origin: 'https://tabula.example:8443' },
      { Origin: 'https://evil.example' },
      { Origin: 'https://tabula.example.evil.example' },
      { Origin: `http://127.0.0.1:${server.port}` },
      { Origin: 'null' },
      {},
    ];
    for (const headers of refused) expect(await within(join(headers).rejected)).toBe(403);

    // the close codes get through the proxy too
    expect(await within(rawSocket(server.proxy.port, board, { Origin: ORIGIN }).closed)).toBe(4401);
    expect(await within(join({ Origin: ORIGIN, Cookie: owner.cookie.replace(`${SECURE_COOKIE}=`, 'tabula_session=') }).closed)).toBe(4401);
    expect(await within(rawSocket(server.proxy.port, 'proxied-ghost', { Origin: ORIGIN, Cookie: owner.cookie }).closed)).toBe(4404);
  });

  it('syncs documents and awareness through the proxy, with the connection at the relay itself', async () => {
    const board = 'proxied-sync';
    expect((await viaProxy('POST', '/api/boards', { cookie: owner.cookie, body: { id: board } })).status).toBe(201);
    const a = connect(server.proxy.port, board, owner.cookie);
    const b = connect(server.proxy.port, board, owner.cookie);
    const direct = connect(server.port, board, owner.cookie);
    await Promise.all([a, b, direct].map(synced));

    a.doc.getMap('objects').set('fromA', 1);
    await until(() => b.doc.getMap('objects').get('fromA') === 1 && direct.doc.getMap('objects').get('fromA') === 1);
    direct.doc.getMap('objects').set('fromDirect', 2);
    await until(() => a.doc.getMap('objects').get('fromDirect') === 2 && b.doc.getMap('objects').get('fromDirect') === 2);

    a.provider.awareness.setLocalStateField('user', { name: 'through the proxy' });
    await until(() => [...direct.provider.awareness.getStates().values()].some((s) => s.user?.name === 'through the proxy'));

    const file = path.join(server.dir, `${board}.yjs`);
    await until(() => {
      try {
        const saved = new Y.Doc();
        Y.applyUpdate(saved, fs.readFileSync(file));
        return saved.getMap('objects').has('fromA') && saved.getMap('objects').has('fromDirect');
      } catch {
        return false; // not saved yet, or the relay is replacing the file right now (Windows)
      }
    });
  });

  it('refuses every state-changing request when the proxy rewrites Host, because the Origin no longer matches it', async () => {
    const rewriting = await startProxy({ target: server.port, forwardedProto: 'https', preserveHost: false });
    stacks.push({ ...server, proxy: rewriting });
    const b = browser(rewriting.port, nextClient());

    const post = await b('POST', '/api/auth/request', { body: { email: nextEmail() } });
    expect(post.status).toBe(403);
    expect(post.body.error).toBe('csrf');
    expect((await b('GET', '/api/config')).status).toBe(200);
    expect((await b('POST', '/api/auth/logout', { cookie: owner.cookie })).status).toBe(403);
    expect((await viaProxy('GET', '/api/me', { cookie: owner.cookie })).status).toBe(200);

    // a WebSocket never looks at Host
    const ws = rawSocket(rewriting.port, 'proxied-sync', { Origin: ORIGIN, Cookie: owner.cookie });
    await within(ws.joined);
    expect(ws.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('behind the same proxy without TABULA_TRUST_PROXY', { timeout: 60_000 }, () => {
  it('ignores X-Forwarded-For altogether: every client of the proxy shares the proxy address', async () => {
    const server = await launch({ TABULA_BASE_URL: ORIGIN, TABULA_TRUST_PROXY: '0' });
    const ask = (via: number, client: string | undefined, forged: string) =>
      browser(via, client)('POST', '/api/auth/request', { body: { email: nextEmail() }, headers: { 'x-forwarded-for': forged } });

    for (let i = 0; i < 20; i++) expect((await ask(server.proxy.port, nextClient(), `7.7.7.${i}`)).status).toBe(200);
    const over = await ask(server.proxy.port, nextClient(), '8.8.8.8');
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('rate_limited');

    // the bucket is the address of the connection, so a request that skips the proxy lands in the same one
    expect((await ask(server.port, undefined, '9.9.9.9')).status).toBe(429);
  });

  it('does not turn on for anything but the value 1', () => {
    const trust = (value: string | undefined) =>
      loadConfig({ TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: OWNER, ...(value === undefined ? {} : { TABULA_TRUST_PROXY: value }) }, () => {}).trustProxy;
    expect(trust('1')).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', 'on', ' 1']) expect(trust(value)).toBe(false);
  });
});

describe('behind Fly with fly-replay (TAB-71)', { timeout: 60_000 }, () => {
  const ask = (stack: Stack, client: string, headers: Record<string, string> = {}) =>
    browser(stack.proxy.port, client)('POST', '/api/auth/request', { body: { email: nextEmail() }, headers });

  it('with TABULA_CLIENT_IP_HEADER=fly-client-ip, limits each visitor by the address Fly saw, whatever they send', async () => {
    const stack = await launch({ ...PROXIED, TABULA_CLIENT_IP_HEADER: 'fly-client-ip' }, { fly: true });
    const abuser = nextClient();
    const bystander = nextClient();
    for (let i = 0; i < 20; i++) expect((await ask(stack, abuser, { 'fly-client-ip': `7.7.7.${i}`, 'x-forwarded-for': `8.8.8.${i}` })).status).toBe(200);
    expect((await ask(stack, abuser)).status).toBe(429);
    // the replay hop is in X-Forwarded-For for both, and does not tie them together
    expect((await ask(stack, bystander, { 'fly-client-ip': abuser })).status).toBe(200);
  });

  it('with the default X-Forwarded-For, every visitor shares the replay hop\'s address: why the option exists', async () => {
    const stack = await launch({ ...PROXIED }, { fly: true });
    for (let i = 0; i < 20; i++) expect((await ask(stack, nextClient())).status).toBe(200);
    expect((await ask(stack, nextClient())).status).toBe(429);
  });
});

describe('a plain http base URL behind a proxy that says https', { timeout: 60_000 }, () => {
  it('ignores X-Forwarded-Proto: the cookie is not Secure, and a WebSocket from the https page is refused', async () => {
    const plainOrigin = `http://${HOST}`;
    const server = await launch({ TABULA_BASE_URL: plainOrigin, TABULA_TRUST_PROXY: '1' });
    const b = browser(server.proxy.port, nextClient(), { host: HOST, origin: plainOrigin });
    const owner = await signIn(b, server.dir);

    expect(owner.mail.text).toContain(`${plainOrigin}/#/signin/verify?token=`);
    expect(owner.setCookie).toMatch(/^tabula_session=[A-Za-z0-9_-]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(owner.setCookie).not.toMatch(/secure|__Host-|domain/i);
    expect((await b('GET', '/api/me', { cookie: owner.cookie })).status).toBe(200);

    const board = 'plain-base';
    expect((await b('POST', '/api/boards', { cookie: owner.cookie, body: { id: board } })).status).toBe(201);
    // the page itself is served over https, so the browser's Origin is https://tabula.example, which is not the configured origin
    expect(await within(rawSocket(server.proxy.port, board, { Origin: ORIGIN, Cookie: owner.cookie }).rejected)).toBe(403);
    const ok = rawSocket(server.proxy.port, board, { Origin: plainOrigin, Cookie: owner.cookie });
    await within(ok.joined);
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });
});
