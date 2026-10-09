import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { createCloud } from '../server/cloud.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { CREDS, KEY, MIN, T0, harness, type Harness } from './backup-harness';
import { isWindows, simulatedWindows } from './platform';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// docs/backups.md and docs/cloud.md. GET /api/internal/backup-status in process, and the relay as a child process with
// backups configured, half configured, misconfigured and unreachable.

const TOKEN = 'b'.repeat(48);
const CLOUD_ENV = { TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: 'https://cloud.example.com', TABULA_CLOUD_WORKSPACE_ID: 'ws_backup' };
const AUTH_ENV = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com' };

let h: Harness | undefined;
const servers: http.Server[] = [];
const opened: ReturnType<typeof openDirectory>[] = [];

afterEach(async () => {
  await h?.close();
  h = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const d of opened.splice(0)) d.close();
});

async function serve(env: Record<string, string>, backupStatus?: () => unknown) {
  const config = loadConfig({ PORT: '8787', ...env });
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const events = new EventEmitter();
  const cloud = createCloud({ config: config.cloud, directory, events, log: () => {} });
  const mailer = { async send() {} };
  const auth = createAuth({ directory, config, mailer, seatsAvailable: cloud?.seatsAvailable });
  const api = createApi({ directory, auth, config, roomExists: () => false, events, cloud: cloud as never, mailer, ...(backupStatus ? { backupStatus: backupStatus as never } : {}) });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (urlPath: string, init: { method?: string; token?: string | null; cookie?: string } = {}) => {
    const res = await fetch(base + urlPath, {
      method: init.method ?? 'GET',
      headers: { ...(init.method && init.method !== 'GET' ? { 'x-tabula': '1' } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  return { call, directory, cloud, config };
}

describe('GET /api/internal/backup-status', () => {
  it('answers { enabled: false } in cloud mode when backups are off', async () => {
    const s = await serve({ ...AUTH_ENV, ...CLOUD_ENV });
    const res = await s.call('/api/internal/backup-status', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('needs the bearer token: 401 without one, with a wrong one, and with only a session', async () => {
    const s = await serve({ ...AUTH_ENV, ...CLOUD_ENV });
    for (const init of [{}, { token: 'x'.repeat(48) }, { token: TOKEN.slice(1) }, { cookie: 'tabula_session=whatever' }]) {
      const res = await s.call('/api/internal/backup-status', init);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthenticated' });
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('answers 404 when cloud mode is off, like every internal route', async () => {
    const accountsOnly = await serve({ ...AUTH_ENV });
    expect((await accountsOnly.call('/api/internal/backup-status', { token: TOKEN })).status).toBe(404);
    const statusEnabled = await serve({ ...AUTH_ENV }, () => ({ enabled: true }));
    expect((await statusEnabled.call('/api/internal/backup-status', { token: TOKEN })).status).toBe(404);
  });

  it('only answers GET', async () => {
    const s = await serve({ ...AUTH_ENV, ...CLOUD_ENV });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await s.call('/api/internal/backup-status', { method, token: TOKEN })).status).toBe(405);
    }
  });

  it('is open while the workspace is read-only', async () => {
    const s = await serve({ ...AUTH_ENV, ...CLOUD_ENV });
    s.cloud!.setLimits({ readOnly: true });
    expect((await s.call('/api/internal/backup-status', { token: TOKEN })).status).toBe(200);
  });

  it('shows the status of a real backup, and nothing secret', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    await engine.runNow();
    h.fake.rules.push({ method: 'PUT', status: 403, times: 99 });
    h.write('b2.yjs', Buffer.from('changed'));
    h.clock.now += 60 * MIN;
    await engine.runNow();

    const s = await serve({ ...AUTH_ENV, ...CLOUD_ENV }, () => engine.status());
    const res = await s.call('/api/internal/backup-status', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true, running: false, keyId: engine.keyId, intervalMinutes: 60, lastSuccessAt: T0, lastRunAt: T0 + 60 * MIN, lastError: 'S3 PUT failed (status 403, AccessDenied)',
      lastFailureAt: T0 + 60 * MIN, lastFailureError: 'S3 PUT failed (status 403, AccessDenied)', consecutiveFailures: 1,
      lastManifest: '20261008T193000Z.json.enc', manifests: 1, nextRunAt: null,
    });
    expect(res.body.bytesStored).toBeGreaterThan(0);
    expect(res.body.objects).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    for (const secret of [CREDS.secretKey, CREDS.accessKey, KEY.toString('hex'), KEY.toString('base64'), 'Signature', 'AWS4']) expect(text).not.toContain(secret);
  });
});

// ---------------------------------------------------------------- the relay as a child process

const running: { proc: ChildProcess; dir: string }[] = [];

type Launched = { port: number; base: string; dir: string; proc: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> };

async function launch(env: Record<string, string>, { waitForStart = true } = {}): Promise<Launched> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-backup-relay-'));
  const proc = spawn(process.execPath, ['server/relay.mjs'], {
    env: {
      ...(process.env as Record<string, string>), PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', TABULA_MAIL: 'file',
      TABULA_BASE_URL: `http://127.0.0.1:${port}`, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push({ proc, dir });
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    const result = { port, base: `http://127.0.0.1:${port}`, dir, proc, out: () => out, err: () => err, exited };
    if (!waitForStart) return void resolve(result);
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${err}`)), RELAY_START_MS);
    proc.stdout!.on('data', () => {
      if (out.includes('Tabula relay')) {
        clearTimeout(timer);
        resolve(result);
      }
    });
    void exited.then(() => reject(new Error(`relay exited: ${err}`)));
  });
}

afterAll(async () => {
  await Promise.all(running.map(({ proc }) => new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  })));
  for (const { dir } of running) fs.rmSync(dir, { recursive: true, force: true });
});

const stop = (r: Launched) => {
  // With win32 forced on a system that has signals, SIGTERM would run the relay's handler and exit 0, which Windows does not do; SIGKILL has no handler, so the child ends without an exit code, as under TerminateProcess.
  r.proc.kill(simulatedWindows ? 'SIGKILL' : 'SIGTERM');
  return r.exited;
};
// Windows has no signals: kill() is TerminateProcess, so the SIGTERM handler never runs and the child reports a signal instead of exit code 0.
const expectCleanStop = async (r: Launched) => {
  const code = await stop(r);
  if (isWindows) {
    expect(code).toBeNull();
    expect(r.proc.signalCode).not.toBeNull();
  } else {
    expect(code).toBe(0);
  }
};
const status = async (r: Launched, token: string | null = TOKEN) => {
  const res = await fetch(`${r.base}/api/internal/backup-status`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

describe('the relay with backups', () => {
  const backupEnv = (endpoint: string, extra: Record<string, string> = {}) => ({
    TABULA_BACKUP_S3_ENDPOINT: endpoint, TABULA_BACKUP_BUCKET: CREDS.bucket, TABULA_BACKUP_ACCESS_KEY: CREDS.accessKey,
    TABULA_BACKUP_SECRET_KEY: CREDS.secretKey, TABULA_BACKUP_KEY: KEY.toString('base64'), ...extra,
  });
  const cloudEnv = { ...AUTH_ENV, ...CLOUD_ENV, TABULA_CLOUD_URL: 'http://127.0.0.1:1' };

  it('refuses to start with half a configuration, naming the missing variables and nothing else', async () => {
    const env = backupEnv('https://s3.example.com');
    delete (env as Record<string, string | undefined>).TABULA_BACKUP_SECRET_KEY;
    delete (env as Record<string, string | undefined>).TABULA_BACKUP_BUCKET;
    const r = await launch(env, { waitForStart: false });
    expect(await r.exited).not.toBe(0);
    expect(r.err()).toContain('TABULA_BACKUP_S3_ENDPOINT, TABULA_BACKUP_BUCKET, TABULA_BACKUP_ACCESS_KEY, TABULA_BACKUP_SECRET_KEY, TABULA_BACKUP_KEY must be set together (missing TABULA_BACKUP_BUCKET, TABULA_BACKUP_SECRET_KEY)');
    for (const secret of [CREDS.accessKey, KEY.toString('base64'), KEY.toString('hex')]) {
      expect(r.err()).not.toContain(secret);
      expect(r.out()).not.toContain(secret);
    }
  });

  it('refuses to start with a key that is not 32 bytes, without printing it', async () => {
    const bad = 'this-is-not-a-key-but-looks-secret-9f8e7d';
    const r = await launch(backupEnv('https://s3.example.com', { TABULA_BACKUP_KEY: bad }), { waitForStart: false });
    expect(await r.exited).not.toBe(0);
    expect(r.err()).toContain('TABULA_BACKUP_KEY must be 32 bytes');
    expect(r.err()).not.toContain(bad);
    expect(r.out()).not.toContain(bad);
    expect(r.err()).not.toContain(CREDS.secretKey);
  });

  it('is off, and says so, without any backup variable', async () => {
    const r = await launch({ ...cloudEnv });
    expect(r.out()).not.toContain('backups on');
    expect(await status(r)).toEqual({ status: 200, body: { enabled: false } });
    expect((await status(r, null)).status).toBe(401);
    await expectCleanStop(r);
  });

  it('is 404 without cloud mode, in accounts mode and in open mode', async () => {
    const accounts = await launch({ ...AUTH_ENV });
    expect((await status(accounts)).status).toBe(404);
    const open = await launch({});
    expect((await status(open)).status).toBe(404);
    expect((await fetch(`${open.base}/api/health`)).status).toBe(200);
    await stop(accounts);
    await stop(open);
  });

  it('starts with backups on, reports the schedule, and stops cleanly', async () => {
    h = await harness({ accounts: true, seed: false });
    const before = Date.now();
    const r = await launch({ ...cloudEnv, ...backupEnv(h.fake.url) });
    expect(r.out()).toContain('(backups on)');
    const { status: code, body } = await status(r);
    expect(code).toBe(200);
    expect(body).toMatchObject({ enabled: true, running: false, lastSuccessAt: null, lastRunAt: null, consecutiveFailures: 0, manifests: 0 });
    expect(body.nextRunAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(body.nextRunAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(body.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain(CREDS.secretKey);
    expect(h.fake.log).toEqual([]);
    expect((await fetch(`${r.base}/api/health`)).status).toBe(200);
    await expectCleanStop(r);
    expect(r.err()).not.toContain('Error');
  });

  it('starts, and serves, with a bucket that cannot be reached', async () => {
    const r = await launch({ ...cloudEnv, ...backupEnv('http://127.0.0.1:1') });
    expect(r.out()).toContain('(backups on)');
    expect((await status(r)).body).toMatchObject({ enabled: true, consecutiveFailures: 0 });
    expect((await fetch(`${r.base}/api/health`)).status).toBe(200);
    await expectCleanStop(r);
  });

  it('also runs in open mode, where backups have no directory and no status endpoint', async () => {
    const r = await launch({ ...backupEnv('http://127.0.0.1:1') });
    expect(r.out()).toContain('(backups on)');
    expect((await status(r)).status).toBe(404);
    expect((await fetch(`${r.base}/api/health`)).status).toBe(200);
    await expectCleanStop(r);
  });

  it('accepts the old MIRA_ spelling, with the usual warning', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(backupEnv('http://127.0.0.1:1'))) env[k.replace('TABULA_', 'MIRA_')] = v;
    const r = await launch({ ...cloudEnv, ...env });
    expect(r.out()).toContain('(backups on)');
    expect(r.err() + r.out()).not.toContain(CREDS.secretKey);
    await stop(r);
  });
});
