import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRelayProcess } from './start-relay';
import { createFakeCloudControlPlane } from './fake-cloud-control-plane';
import { budget } from './wait-budget';

const OWNER = 'tracker-s7c-owner@example.com';
const TOKEN = 'f'.repeat(48);
const WORKSPACE = 'ws_tracker_s7c';
const fakeCloud = createFakeCloudControlPlane();
let controlUrl = '';
type Body = any;
type Reply = { status: number; body: Body; headers: Headers };
type Account = { cookie: string; user: Body; email: string };
type Relay = { base: string; dir: string; proc: ChildProcess };

const relays: Relay[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn: () => boolean, timeoutMs = 20_000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > budget(timeoutMs)) throw new Error('timed out waiting for a relay observer');
    await sleep(20);
  }
}

beforeAll(async () => { controlUrl = await fakeCloud.start(); });
afterEach(() => fakeCloud.reset());
afterAll(async () => {
  await Promise.all(relays.map((relay) => stopRelay(relay.proc)));
  for (const directory of new Set(relays.map((relay) => relay.dir))) fs.rmSync(directory, { recursive: true, force: true });
  await fakeCloud.close();
});

const baseEnv = (port: number, dir: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  TABULA_SKIP_DOTENV: '1',
  PORT: String(port),
  DATA_DIR: dir,
  HOST: '127.0.0.1',
  TABULA_AUTH: 'on',
  TABULA_OWNER_EMAIL: OWNER,
  TABULA_MAIL: 'file',
  TABULA_BASE_URL: `http://127.0.0.1:${port}`,
  TABULA_TRACKER: 'on',
  TABULA_CLOUD_TOKEN: TOKEN,
  TABULA_CLOUD_URL: controlUrl,
  TABULA_CLOUD_WORKSPACE_ID: WORKSPACE,
});

async function launch(env: Record<string, string> = {}): Promise<Relay> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-tracker-s7c-'));
  const { proc, port } = await startRelayProcess({ envFor: (p) => ({ ...baseEnv(p, dir), ...env }) });
  const relay = { base: `http://127.0.0.1:${port}`, dir, proc };
  relays.push(relay);
  return relay;
}

const stopRelay = (proc: ChildProcess) => new Promise<void>((resolve) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
  proc.once('exit', () => resolve());
  proc.kill('SIGTERM');
});

function client(relay: Relay) {
  const outbox = path.join(relay.dir, 'outbox.jsonl');
  async function call(cookie: string | undefined, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const response = await fetch(`${relay.base}${route}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'x-tabula': '1' }),
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
  }

  async function signIn(email: string, invite?: string): Promise<Account> {
    const before = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0;
    const requested = await call(undefined, 'POST', '/api/auth/request', { email, ...(invite ? { invite } : {}) }, { 'x-forwarded-for': '198.51.100.31' });
    if (requested.status !== 200) throw new Error(`sign-in request failed with ${requested.status}`);
    await until(() => fs.existsSync(outbox) && fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length > before);
    const mail = fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean)[before];
    const token = decodeURIComponent(/token=([^\s&"\\]+)/.exec(JSON.parse(mail).text)?.[1] ?? '');
    if (!token) throw new Error('sign-in mail did not contain a token');
    const verified = await call(undefined, 'POST', '/api/auth/verify', { token });
    if (verified.status !== 200) throw new Error(`sign-in verify failed with ${verified.status}`);
    const cookie = /tabula_session=[^;]+/.exec(verified.headers.getSetCookie()[0] ?? '')?.[0];
    if (!cookie) throw new Error('sign-in response did not set a session cookie');
    return { cookie, user: verified.body.user, email };
  }

  return { call, signIn };
}

describe('tracker slice 7C admin routes', () => {
  it('serves the four owner routes, denies members and admins, and flushes ticket floors to the shared control-plane fake', async () => {
    const relay = await launch();
    const c = client(relay);
    const owner = await c.signIn(OWNER);

    // The owner response proves the route reached its intended handler before denial checks run.
    const readiness = await c.call(owner.cookie, 'GET', '/api/admin/tracker/readiness');
    expect(readiness.status).toBe(200);
    expect(readiness.body.checks.map((check: any) => check.id)).toEqual([
      'offsite_enabled', 'latest_backup_fresh', 'schedule_meets_rpo', 'backup_decrypts', 'tracker_data_clean',
      'counters_floor_ok', 'links_consistent', 'search_ok', 'slice8_secrets', 'restore_drill_recent',
      'retention_30d', 'import_verified',
    ]);

    const created = await c.call(owner.cookie, 'POST', '/api/tracker/tickets', {
      title: 'Floor observer seed',
      idempotencyKey: 'tracker-s7c-create-0001',
    });
    expect(created.status).toBe(201);
    const epoch = await c.call(owner.cookie, 'POST', '/api/admin/tracker/key-epoch', { confirm: 'JUMP' });
    expect(epoch).toMatchObject({ status: 200, body: { counters: [{ scope: 'trk_default', prefix: 'TAB' }] } });
    const today = new Date().toISOString().slice(0, 10);
    const drill = await c.call(owner.cookie, 'POST', '/api/admin/tracker/drill-record', {
      at: Date.now(), kind: 'production', schema: 1, restoreSeconds: 10, dataLossSeconds: 5,
      boxes: [{ id: 'seed', result: 'pass' }], overall: 'pass',
    });
    expect(drill.status).toBe(200);
    expect((await c.call(owner.cookie, 'POST', '/api/admin/tracker/cutover-record', { importVerifiedAt: today, lossReportAccepted: true }))
      .status).toBe(200);

    const team = await c.call(owner.cookie, 'POST', '/api/teams', { name: 'Tracker S7C access' });
    expect(team.status).toBe(201);
    const invitation = await c.call(owner.cookie, 'POST', `/api/teams/${team.body.id}/invites`, { role: 'member' });
    expect(invitation.status).toBe(201);
    const member = await c.signIn('tracker-s7c-member@example.com', invitation.body.token);
    const promoted = await c.call(owner.cookie, 'PATCH', `/api/members/${member.user.id}`, { role: 'admin' });
    expect(promoted.status).toBe(200);
    const admin = { cookie: member.cookie };

    const requests = [
      ['GET', '/api/admin/tracker/readiness', undefined],
      ['POST', '/api/admin/tracker/key-epoch', { confirm: 'JUMP' }],
      ['POST', '/api/admin/tracker/drill-record', { at: Date.now(), kind: 'local', schema: 1, restoreSeconds: 1, dataLossSeconds: 1, boxes: [], overall: 'pass' }],
      ['POST', '/api/admin/tracker/cutover-record', { importVerifiedAt: today, lossReportAccepted: true }],
    ] as const;
    for (const [method, route, body] of requests) {
      for (const cookie of [member.cookie, admin.cookie]) {
        expect((await c.call(cookie, method, route, body)).status).toBe(403);
      }
    }

    await stopRelay(relay.proc);
    const report = fakeCloud.seen.filter((entry) => entry.url.endsWith('/key-floor')).at(-1);
    expect(report).toMatchObject({ method: 'POST', authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(report!.body).counters).toEqual([{ scope: 'trk_default', prefix: 'TAB', floor: 1002 }]);
    const read = await fetch(`${controlUrl}/v1/workspaces/${WORKSPACE}/key-floor/read`, { method: 'POST', body: '{}' });
    expect(await read.json()).toEqual({ counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 1002 }] });
  });

  it('does not register any of the four routes when TABULA_TRACKER is off', async () => {
    const relay = await launch({ TABULA_TRACKER: 'off' });
    const c = client(relay);
    const owner = await c.signIn(OWNER);
    const requests = [
      ['GET', '/api/admin/tracker/readiness', undefined],
      ['POST', '/api/admin/tracker/key-epoch', { confirm: 'JUMP' }],
      ['POST', '/api/admin/tracker/drill-record', {}],
      ['POST', '/api/admin/tracker/cutover-record', {}],
    ] as const;
    for (const [method, route, body] of requests) {
      expect((await c.call(owner.cookie, method, route, body))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
  });
});
