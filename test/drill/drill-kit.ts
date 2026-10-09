import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { expect } from 'vitest';
import { freePort } from '../free-port';
import { RELAY_START_MS } from '../relay-timing';

// The relay as a child process, exactly as `npm start` runs it, and a client of it (HTTP as a signed-in person, sync
// sockets). Moved here from test/restore-relay.test.ts so the restore drill (test/drill, `npm run drill:local`) uses
// the same helpers; restore-relay.test.ts imports them from here.

export type Relay = { port: number; base: string; proc: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
}

/** One registry of relays, sockets and editors; the test file stops them in its hooks. */
export function createRelayKit(cloudToken: string) {
  const running: { proc: ChildProcess }[] = [];
  const sockets = new Set<WebSocket>();
  const providers = new Set<WebsocketProvider>();
  /** stdout and stderr of every relay this kit started, for the secret search of the drill. */
  const outputs: { out: () => string; err: () => string }[] = [];
  let ip = 0;

  /**
   * Starts a relay on `dir`. `clean` drops TABULA_* and MIRA_* settings inherited from the shell first, so only `env`
   * decides how it runs (the drill); the restore tests keep what they always had.
   */
  async function launch(dir: string, env: Record<string, string>, { waitForStart = true, clean = false } = {}): Promise<Relay> {
    const port = await freePort();
    const inherited = { ...(process.env as Record<string, string>) };
    if (clean) for (const k of Object.keys(inherited)) if (/^(TABULA|MIRA)_|^QUIET$/.test(k)) delete inherited[k];
    const proc = spawn(process.execPath, ['server/relay.mjs'], {
      env: {
        ...inherited, PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com',
        TABULA_MAIL: 'file', TABULA_BASE_URL: `http://127.0.0.1:${port}`, TABULA_TRUST_PROXY: '1',
        // a restore or its preview reads how full the disk is; the runner's own disk must not decide a test's outcome
        TABULA_TEST_RESTORE_DISK_USED: '0.2',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push({ proc });
    let out = '';
    let err = '';
    proc.stdout!.on('data', (d) => (out += d));
    proc.stderr!.on('data', (d) => (err += d));
    outputs.push({ out: () => out, err: () => err });
    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
    const relay = { port, base: `http://127.0.0.1:${port}`, proc, out: () => out, err: () => err, exited };
    if (!waitForStart) return Promise.resolve(relay);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start: ${err}`)), RELAY_START_MS);
      proc.stdout!.on('data', () => {
        if (out.includes('Tabula relay')) {
          clearTimeout(timer);
          resolve(relay);
        }
      });
      void exited.then((code) => reject(new Error(`relay exited with ${code}: ${err}`)));
    });
  }

  /** A graceful stop (SIGTERM, as a supervisor sends it); resolves with the exit code. */
  async function stop(relay: Relay) {
    if (relay.proc.exitCode !== null || relay.proc.signalCode !== null) return relay.proc.exitCode;
    relay.proc.kill('SIGTERM');
    return relay.exited;
  }

  function closeClients() {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    for (const p of providers) p.destroy();
    providers.clear();
  }

  /** Stops every relay this kit started (SIGKILL) and waits for them. */
  async function killAll() {
    await Promise.all(running.splice(0).map(({ proc }) => new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    })));
  }

  function client(relay: Relay, dir: string) {
    async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(relay.base + urlPath, {
        method,
        headers: { ...(method === 'GET' ? {} : { 'x-tabula': '1' }), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
    }
    async function signIn(email: string, invite?: string) {
      const outbox = path.join(dir, 'outbox.jsonl');
      const before = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0;
      const res = await api(undefined, 'POST', '/api/auth/request', invite ? { email, invite } : { email }, { 'x-forwarded-for': `10.0.${(++ip >> 8) & 255}.${ip & 255}` });
      expect(res.status).toBe(200);
      const lines = fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(before);
      const token = decodeURIComponent(/token=([^\s&"\\]+)/.exec(JSON.parse(lines[0]).text)![1]);
      const verify = await api(undefined, 'POST', '/api/auth/verify', { token });
      expect(verify.status).toBe(200);
      return /tabula_session=[^;]+/.exec(verify.headers.getSetCookie()[0])![0];
    }
    const internal = (urlPath: string) => api(undefined, 'GET', urlPath, undefined, { authorization: `Bearer ${cloudToken}` });

    /** A client of one room that records how its socket was closed. */
    function connect(room: string, cookie: string) {
      const closes: number[] = [];
      const Socket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols, { headers: { Origin: relay.base, Cookie: cookie } });
          sockets.add(this);
          this.on('close', (code) => closes.push(code));
        }
      };
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://127.0.0.1:${relay.port}/sync`, room, doc, { WebSocketPolyfill: Socket as unknown as typeof globalThis.WebSocket, disableBc: true });
      providers.add(provider);
      return { doc, provider, closes };
    }

    /** A bare socket, to see what the relay does with a connection made during maintenance. */
    function listen(room: string, cookie: string) {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/sync/${room}`, { headers: { Origin: relay.base, Cookie: cookie } });
      sockets.add(ws);
      const closes: number[] = [];
      ws.on('close', (code) => closes.push(code));
      ws.on('error', () => {});
      return closes;
    }
    return { api, signIn, internal, connect, listen };
  }

  return { launch, stop, client, closeClients, killAll, outputs };
}
