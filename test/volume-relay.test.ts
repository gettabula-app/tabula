import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// docs/backups.md, "Volumes and restores", and GET /api/internal/volume (docs/cloud.md). The relay runs as a child
// process exactly as `npm start` would, next to a fake control plane, and is restarted on the same data directory
// with the environment a control plane or an operator would give it.

const OWNER = 'owner@example.com';
const TOKEN = 'v'.repeat(48);
const WS_A = 'ws_volume_a';
const WS_B = 'ws_volume_b';

type Run = { proc: ChildProcess; port: number; base: string; out: () => string; err: () => string };
type Ended = { code: number | null; out: string; err: string; port: number };

let controlPlane: http.Server;
let controlUrl = '';
beforeAll(async () => {
  controlPlane = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => controlPlane.listen(0, '127.0.0.1', resolve));
  controlUrl = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
});

const running = new Set<ChildProcess>();
const dirs: string[] = [];

const stop = (p: ChildProcess) =>
  new Promise<void>((resolve) => {
    running.delete(p);
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    p.once('exit', () => resolve());
    p.kill('SIGTERM');
  });

// Every relay stops before any directory goes (Windows will not remove files a process holds open).
afterAll(async () => {
  await Promise.all([...running].map(stop));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  await new Promise<void>((resolve) => controlPlane.close(() => resolve()));
});

function newDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-volume-relay-'));
  dirs.push(d);
  return d;
}

const hosted = (workspace: string) => ({ TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: controlUrl, TABULA_CLOUD_WORKSPACE_ID: workspace });

/** Starts a relay; resolves when it listens ('started') or when it exits first ('exited', with its output). */
async function launch(dir: string, env: Record<string, string>, { auth = true } = {}): Promise<{ started: Run } | { exited: Ended }> {
  const port = await freePort();
  const base = { ...(process.env as Record<string, string>) };
  for (const k of ['TABULA_FLY_VOLUME_ID', 'TABULA_ADOPT_VOLUME', 'TABULA_CLOUD_TOKEN', 'TABULA_CLOUD_URL', 'TABULA_CLOUD_WORKSPACE_ID', 'QUIET']) delete base[k];
  const proc = spawn(process.execPath, ['server/relay.mjs'], {
    env: {
      ...base,
      PORT: String(port),
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      ...(auth ? { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: OWNER, TABULA_MAIL: 'file', TABULA_BASE_URL: `http://127.0.0.1:${port}` } : { TABULA_AUTH: 'off' }),
      TABULA_TRUST_PROXY: '1',
      // no backups are configured here, so nothing can restore; the stub keeps test/no-real-disk.test.ts honest anyway
      TABULA_TEST_RESTORE_DISK_USED: '0.1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(proc);
  let out = '';
  let err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay neither started nor exited\n${out}\n${err}`)), RELAY_START_MS);
    proc.stdout!.on('data', (d) => {
      out += String(d);
      if (out.includes('Tabula relay')) {
        clearTimeout(timer);
        resolve({ started: { proc, port, base: `http://127.0.0.1:${port}`, out: () => out, err: () => err } });
      }
    });
    proc.stderr!.on('data', (d) => (err += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      running.delete(proc);
      clearTimeout(timer);
      resolve({ exited: { code, out, err, port } });
    });
  });
}

async function start(dir: string, env: Record<string, string>, opts?: { auth?: boolean }): Promise<Run> {
  const r = await launch(dir, env, opts);
  if ('exited' in r) throw new Error(`relay exited with ${r.exited.code}\n${r.exited.err}`);
  return r.started;
}

async function refused(dir: string, env: Record<string, string>, opts?: { auth?: boolean }): Promise<Ended> {
  const r = await launch(dir, env, opts);
  if ('started' in r) {
    await stop(r.started.proc);
    throw new Error('the relay started');
  }
  return r.exited;
}

async function api(run: Run, method: string, urlPath: string, { cookie, body, headers = {} }: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(run.base + urlPath, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'x-tabula': '1' }), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

const internalVolume = (run: Run, token: string | null = TOKEN) => api(run, 'GET', '/api/internal/volume', { headers: token ? { authorization: `Bearer ${token}` } : {} });

let ipSeq = 0;
async function signIn(run: Run, dir: string) {
  const outbox = path.join(dir, 'outbox.jsonl');
  const mails = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean) : []);
  const before = mails().length;
  const req = await api(run, 'POST', '/api/auth/request', { body: { email: OWNER }, headers: { 'x-forwarded-for': `10.9.${ipSeq >> 8}.${ipSeq++ & 255}` } });
  expect(req.status).toBe(200);
  const sent = mails().slice(before);
  const token = decodeURIComponent(/token=([^\s&"\\]+)/.exec(JSON.parse(sent[0]).text)![1]);
  const verify = await api(run, 'POST', '/api/auth/verify', { body: { token } });
  expect(verify.status).toBe(200);
  return /tabula_session=[^;]+/.exec(verify.headers.getSetCookie()[0])![0];
}

const me = async (run: Run, cookie: string) => (await api(run, 'GET', '/api/me', { cookie })).status;
const adoptRows = async (run: Run, cookie: string) => (await api(run, 'GET', '/api/admin/audit?action=volume.adopt', { cookie })).body.entries as any[];
const markerOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'volume.json'), 'utf8'));

async function portClosed(port: number) {
  const answered = await fetch(`http://127.0.0.1:${port}/api/health`).then(
    () => true,
    () => false,
  );
  expect(answered).toBe(false);
}

describe('a hosted workspace and its volume', () => {
  const dir = newDir();
  let cookie = '';
  let volumeId = '';

  it('marks the volume on the first start and reports it to the control plane', async () => {
    const run = await start(dir, { ...hosted(WS_A), TABULA_FLY_VOLUME_ID: 'vol_1' });
    const marker = markerOf(dir);
    expect(marker).toMatchObject({ version: 1, workspaceId: WS_A, flyVolumeId: 'vol_1', adoptedAt: null, history: [] });
    volumeId = marker.volumeId;
    expect(volumeId).toMatch(/^[0-9a-f]{32}$/);

    const res = await internalVolume(run);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ volumeId, workspaceId: WS_A, flyVolumeId: 'vol_1', adoptedAt: null, startedAt: expect.any(Number), lastAdoption: null });
    expect((await internalVolume(run, null)).status).toBe(401);
    expect((await internalVolume(run, 'w'.repeat(48))).status).toBe(401);
    // not in the backup status
    expect((await api(run, 'GET', '/api/internal/backup-status', { headers: { authorization: `Bearer ${TOKEN}` } })).body).not.toHaveProperty('volumeId');

    cookie = await signIn(run, dir);
    expect(await me(run, cookie)).toBe(200);
    await stop(run.proc);
  });

  it('serves the same volume again with the same ids, and nobody is signed out', async () => {
    const run = await start(dir, { ...hosted(WS_A), TABULA_FLY_VOLUME_ID: 'vol_1' });
    expect(await me(run, cookie)).toBe(200);
    expect(markerOf(dir)).toMatchObject({ volumeId, workspaceId: WS_A, flyVolumeId: 'vol_1', adoptedAt: null });
    await stop(run.proc);
  });

  it('refuses to start on another workspace\'s volume and never serves it', async () => {
    const ended = await refused(dir, { ...hosted(WS_B), TABULA_FLY_VOLUME_ID: 'vol_1' });
    expect(ended.code).not.toBe(0);
    expect(ended.err).toContain(`belongs to workspace ${WS_A}`);
    expect(ended.err).toContain(`this server is workspace ${WS_B}`);
    expect(ended.err).toContain(`TABULA_ADOPT_VOLUME=${WS_B}`);
    expect(ended.out).not.toContain('Tabula relay');
    await portClosed(ended.port);
    expect(markerOf(dir)).toMatchObject({ workspaceId: WS_A, adoptedAt: null });
  });

  it('refuses a TABULA_ADOPT_VOLUME that is not this workspace', async () => {
    const ended = await refused(dir, { ...hosted(WS_B), TABULA_ADOPT_VOLUME: WS_A });
    expect(ended.code).not.toBe(0);
    expect(ended.err).toContain(`TABULA_ADOPT_VOLUME (${WS_A}) is not this server's workspace (${WS_B})`);
    await portClosed(ended.port);
    expect(markerOf(dir)).toMatchObject({ workspaceId: WS_A, adoptedAt: null });
  });

  it('adopts it when the operator names this workspace: everyone is signed out and the audit log says so', async () => {
    const run = await start(dir, { ...hosted(WS_B), TABULA_FLY_VOLUME_ID: 'vol_2', TABULA_ADOPT_VOLUME: WS_B });
    expect(run.out()).toMatch(new RegExp(`volume: adopted volume ${volumeId} \\(operator\\) from workspace ${WS_A}, Fly volume vol_1 to workspace ${WS_B}, Fly volume vol_2`));
    expect(await me(run, cookie)).toBe(401);

    const marker = markerOf(dir);
    const from = { workspaceId: WS_A, flyVolumeId: 'vol_1' };
    const to = { workspaceId: WS_B, flyVolumeId: 'vol_2' };
    expect(marker).toMatchObject({ volumeId, workspaceId: WS_B, flyVolumeId: 'vol_2', adoptedAt: expect.any(Number), history: [{ at: marker.adoptedAt, from, to, reason: 'operator' }] });

    const fresh = await signIn(run, dir);
    expect(await adoptRows(run, fresh)).toEqual([expect.objectContaining({ actorId: null, action: 'volume.adopt', detail: { from, to, reason: 'operator' } })]);
    const res = await internalVolume(run);
    expect(res.body).toEqual({ volumeId, workspaceId: WS_B, flyVolumeId: 'vol_2', adoptedAt: marker.adoptedAt, startedAt: expect.any(Number), lastAdoption: { at: marker.adoptedAt, from, to, reason: 'operator' } });
    cookie = fresh;
    await stop(run.proc);
  });

  it('with TABULA_ADOPT_VOLUME left set, starts without adopting again and says it can go', async () => {
    const run = await start(dir, { ...hosted(WS_B), TABULA_FLY_VOLUME_ID: 'vol_2', TABULA_ADOPT_VOLUME: WS_B });
    expect(run.out()).toContain('TABULA_ADOPT_VOLUME is set but there is nothing to adopt');
    expect(await me(run, cookie)).toBe(200);
    expect(await adoptRows(run, cookie)).toHaveLength(1);
    expect(markerOf(dir).history).toHaveLength(1);
    await stop(run.proc);
  });
});

describe('a restored copy of the same workspace', () => {
  const dir = newDir();
  let cookie = '';

  it('the first TABULA_FLY_VOLUME_ID is only recorded: nobody is signed out and nothing is audited', async () => {
    let run = await start(dir, hosted(WS_A));
    expect(markerOf(dir)).toMatchObject({ workspaceId: WS_A, flyVolumeId: null });
    cookie = await signIn(run, dir);
    await stop(run.proc);

    run = await start(dir, { ...hosted(WS_A), TABULA_FLY_VOLUME_ID: 'vol_1' });
    expect(run.out()).toContain('volume: recorded Fly volume vol_1');
    expect(await me(run, cookie)).toBe(200);
    expect(await adoptRows(run, cookie)).toEqual([]);
    expect(markerOf(dir)).toMatchObject({ flyVolumeId: 'vol_1', adoptedAt: null, history: [] });
    expect((await internalVolume(run)).body).toMatchObject({ flyVolumeId: 'vol_1', adoptedAt: null, lastAdoption: null });
    await stop(run.proc);
  });

  it('a new Fly volume id is adopted on its own, with the same effects', async () => {
    // what a backup run in the snapshot left behind
    fs.writeFileSync(path.join(dir, 'directory.sqlite.backup-0123456789abcdef.tmp'), 'half a copy');
    const run = await start(dir, { ...hosted(WS_A), TABULA_FLY_VOLUME_ID: 'vol_2' });
    expect(run.out()).toContain('(restored-copy)');
    expect(await me(run, cookie)).toBe(401);
    expect(fs.existsSync(path.join(dir, 'directory.sqlite.backup-0123456789abcdef.tmp'))).toBe(false);
    const from = { workspaceId: WS_A, flyVolumeId: 'vol_1' };
    const to = { workspaceId: WS_A, flyVolumeId: 'vol_2' };
    const fresh = await signIn(run, dir);
    expect(await adoptRows(run, fresh)).toEqual([expect.objectContaining({ actorId: null, detail: { from, to, reason: 'restored-copy' } })]);
    const res = await internalVolume(run);
    expect(res.body).toMatchObject({ flyVolumeId: 'vol_2', lastAdoption: { from, to, reason: 'restored-copy' } });
    expect(res.body.adoptedAt).toBe(res.body.lastAdoption.at);
    await stop(run.proc);
  });
});

describe('open mode', () => {
  it('marks the volume without a workspace and has no internal endpoint', async () => {
    const dir = newDir();
    const run = await start(dir, {}, { auth: false });
    expect(markerOf(dir)).toMatchObject({ workspaceId: null, flyVolumeId: null });
    expect((await internalVolume(run)).status).toBe(404);
    await stop(run.proc);
  });

  it('refuses TABULA_ADOPT_VOLUME, which needs a hosted workspace', async () => {
    const dir = newDir();
    const ended = await refused(dir, { TABULA_ADOPT_VOLUME: WS_A }, { auth: false });
    expect(ended.code).not.toBe(0);
    expect(ended.err).toContain('not a hosted workspace');
    await portClosed(ended.port);
  });
});

describe('accounts mode without a control plane', () => {
  it('has no internal volume endpoint', async () => {
    const dir = newDir();
    const run = await start(dir, {});
    expect((await internalVolume(run)).status).toBe(404);
    await stop(run.proc);
  });
});

// An MCP access token and an invite link made before the adoption: a volume adopted from another workspace must not
// bring working credentials with it, while a restored copy of the same workspace keeps its own (TAB-200).
describe('access tokens and invite links on adoption', () => {
  const MCP = { TABULA_MCP: 'on' };
  async function grants(run: Run, cookie: string) {
    const token = await api(run, 'POST', '/api/me/tokens', { cookie, body: { name: 'agent', scope: 'read' } });
    expect(token.status).toBe(201);
    const team = await api(run, 'POST', '/api/teams', { cookie, body: { name: 'Design' } });
    expect(team.status).toBe(201);
    const invite = await api(run, 'POST', `/api/teams/${team.body.id}/invites`, { cookie, body: {} });
    expect(invite.status).toBe(201);
    return invite.body.token as string;
  }
  const activeTokens = async (run: Run, cookie: string) => ((await api(run, 'GET', '/api/me/tokens', { cookie })).body as unknown[]).length;
  const inviteStatus = async (run: Run, token: string) => (await api(run, 'GET', `/api/invites/${token}`)).status;

  it('revokes them when the operator adopts another workspace\'s volume', async () => {
    const dir = newDir();
    let run = await start(dir, { ...hosted(WS_A), ...MCP, TABULA_FLY_VOLUME_ID: 'vol_1' });
    const invite = await grants(run, await signIn(run, dir));
    await stop(run.proc);

    run = await start(dir, { ...hosted(WS_B), ...MCP, TABULA_FLY_VOLUME_ID: 'vol_9', TABULA_ADOPT_VOLUME: WS_B });
    expect(run.out()).toContain('every MCP access token and invite link revoked');
    const fresh = await signIn(run, dir);
    expect(await activeTokens(run, fresh)).toBe(0);
    expect(await inviteStatus(run, invite)).toBe(404);
    await stop(run.proc);
  });

  it('keeps them when a restored copy of the same workspace is adopted', async () => {
    const dir = newDir();
    let run = await start(dir, { ...hosted(WS_A), ...MCP, TABULA_FLY_VOLUME_ID: 'vol_1' });
    const invite = await grants(run, await signIn(run, dir));
    await stop(run.proc);

    run = await start(dir, { ...hosted(WS_A), ...MCP, TABULA_FLY_VOLUME_ID: 'vol_2' });
    expect(run.out()).toContain('(restored-copy)');
    expect(run.out()).not.toContain('invite link revoked');
    const fresh = await signIn(run, dir);
    expect(await activeTokens(run, fresh)).toBe(1);
    expect(await inviteStatus(run, invite)).toBe(200);
    await stop(run.proc);
  });
});
