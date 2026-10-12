import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { scrubReport } from '../server/telemetry/scrub.mjs';
import { TELEMETRY_SCHEMA } from '../server/telemetry/schema.mjs';

// GET /api/internal/telemetry (docs/telemetry-design.md, "How reports leave an instance"): the last finished hour's report, exactly as the
// Privacy tab previews it, for the control plane's bearer token and nobody else. The instance sends nothing itself.

const TOKEN = 'c'.repeat(40);
const HOUR = 3_600_000;
type Role = 'owner' | 'admin' | 'member';
const worlds: { close: () => Promise<void> }[] = [];

async function setup(opts: { env?: Record<string, string>; hosted?: boolean; now?: () => number } = {}) {
  const hosted = opts.hosted !== false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-telemetry-route-'));
  const env = {
    TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.test', DATA_DIR: dir, TABULA_MAIL: 'file',
    ...(hosted ? { TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: 'https://cloud.example.test', TABULA_CLOUD_WORKSPACE_ID: 'ws_telemetry' } : {}),
    ...opts.env,
  };
  const config = loadConfig(env, () => {});
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} } });
  const state = { restoring: false };
  const cloud = hosted
    ? {
      limits: () => ({ readOnly: false }),
      tokenOk: (header: string | undefined) => header === `Bearer ${TOKEN}`,
      workspaceId: config.cloud?.workspaceId,
      seatUsage: () => ({}),
    }
    : null;
  const api = createApi({
    directory, auth, config, cloud: cloud as never, roomExists: () => false, events: new EventEmitter(), dataDir: dir,
    mailer: { send: async () => {} }, now: opts.now, maintenance: () => state.restoring,
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let serial = 0;
  const signIn = (role: Role) => {
    const user = directory.createUser({ email: `${role}-${++serial}@example.test`, role })!;
    return { cookie: `${config.cookieName}=${directory.createSession(user.id, { ttlMs: HOUR }).token}`, user };
  };
  const pull = async (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => {
    const res = await fetch(`${base}/api/internal/telemetry`, { headers });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const call = async (who: { cookie: string }, method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(base + urlPath, {
      method, headers: { 'x-tabula': '1', cookie: who.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const world = {
    api, config, directory, signIn, pull, call, state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      directory.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((w) => w.close()));
});

describe('who may ask', () => {
  it('answers only the control plane\'s bearer token: no token, a wrong one, and a signed-in person are all refused', async () => {
    const w = await setup();
    w.api.captureTelemetryHour();
    expect((await w.pull({})).status).toBe(401);
    expect((await w.pull({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await w.pull({ authorization: `Basic ${TOKEN}` })).status).toBe(401);
    for (const role of ['owner', 'admin', 'member'] as const) {
      const who = w.signIn(role);
      // a session cookie counts for nothing on an internal route, with or without the CSRF header
      expect((await w.pull({ cookie: who.cookie })).status).toBe(401);
      expect((await w.pull({ cookie: who.cookie, 'x-tabula': '1' })).status).toBe(401);
      expect((await w.call(who, 'GET', '/api/internal/telemetry')).status).toBe(401);
    }
    expect((await w.pull()).status).toBe(200);
  });

  it('does not exist on a server without a control plane (self-hosted), whoever asks', async () => {
    const w = await setup({ hosted: false, env: { TABULA_TELEMETRY: 'on' } });
    w.api.captureTelemetryHour();
    expect((await w.pull()).status).toBe(404);
    expect((await w.call(w.signIn('owner'), 'GET', '/api/internal/telemetry')).status).toBe(404);
  });

  it('is skipped while a restore has the workspace', async () => {
    const w = await setup();
    w.api.captureTelemetryHour();
    w.state.restoring = true;
    const res = await w.pull();
    expect([res.status, res.body.error]).toEqual([503, 'restoring']);
  });
});

describe('what it answers', () => {
  it('says no hour has finished yet until one has', async () => {
    const w = await setup();
    const res = await w.pull();
    expect([res.status, res.body.error]).toEqual([503, 'no_report_yet']);
  });

  it('answers the finished hour as the report itself: scrubbed, the schema\'s shape, under 256 KB, with the workspace id and no content', async () => {
    const at = 1_800_000_000_000;
    const w = await setup({ now: () => at });
    const owner = w.signIn('owner');
    await w.call(owner, 'GET', '/api/me');
    w.api.captureTelemetryHour();
    const res = await w.pull();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const report = res.body;
    expect(report).toMatchObject({ schema: 1, hour: Math.floor(at / HOUR) * HOUR, mode: 'hosted', workspace: 'ws_telemetry' });
    expect(Array.isArray(report.metrics) && report.metrics.length > 0).toBe(true);
    // the scrubber would not change it, so it is exactly what the collector's schema allows
    expect(scrubReport(report).clean).toEqual(report);
    expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(TELEMETRY_SCHEMA.limits.maxBytes);
    expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(256 * 1024);
    // no identifier of a person, no session, no content
    for (const secret of ['owner@example.test', owner.cookie.split('=')[1], owner.user.id, TOKEN, 'cloud.example.test']) expect(res.text).not.toContain(secret);
    expect(res.text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/iu);
    expect(res.text).not.toMatch(/https?:\/\//u);
  });

  it('has the same shape as the Privacy tab\'s preview, and answers the same hour again if asked again', async () => {
    const w = await setup({ now: () => 1_800_000_000_000 });
    const owner = w.signIn('owner');
    const preview = (await w.call(owner, 'GET', '/api/admin/privacy/preview')).body.preview;
    w.api.captureTelemetryHour();
    const first = (await w.pull()).body;
    expect(Object.keys(first).sort()).toEqual(Object.keys(preview).sort());
    expect(first.metrics.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(['entities_total']));
    expect((await w.pull()).body).toEqual(first);
  });

  it('is captured once, in the last seconds of an hour, and not at any other time', async () => {
    let at = 1_800_000_000_000 - (1_800_000_000_000 % HOUR) + 30 * 60_000;
    const w = await setup({ now: () => at });
    w.api.telemetryTick();
    expect((await w.pull()).status).toBe(503); // half past: nothing yet
    at += 30 * 60_000 - 5_000;
    w.api.telemetryTick();
    const res = await w.pull();
    expect([res.status, res.body.hour]).toEqual([200, at - (at % HOUR)]);
    const before = res.text;
    w.api.telemetryTick(); // the same hour again: not built twice
    expect((await w.pull()).text).toBe(before);
  });
});

describe('the owner\'s and the operator\'s switches', () => {
  it('answers 204 and builds nothing when the operator turned telemetry off', async () => {
    const w = await setup({ env: { TABULA_TELEMETRY: 'off' } });
    w.api.captureTelemetryHour();
    w.api.telemetryTick();
    const res = await w.pull();
    expect([res.status, res.text]).toEqual([204, '']);
    const owner = w.signIn('owner');
    expect((await w.call(owner, 'GET', '/api/admin/privacy')).body.lastBuiltAt).toBeNull(); // nothing was built
  });

  it('keeps operating data and drops feature counts when the owner turns product analytics off, and does not hand out the hour built before', async () => {
    const w = await setup({ now: () => 1_800_000_000_000 });
    const owner = w.signIn('owner');
    w.api.captureTelemetryHour();
    expect((await w.pull()).status).toBe(200);
    expect((await w.call(owner, 'PUT', '/api/admin/privacy', { enabled: false })).status).toBe(200);
    // the finished hour held feature counts too, so it is gone until the next one is built
    expect((await w.pull()).body.error).toBe('no_report_yet');
    w.api.captureTelemetryHour();
    const after = await w.pull();
    expect(after.status).toBe(200);
    const names = after.body.metrics.map((m: { name: string }) => m.name);
    expect(names).toContain('entities_total'); // operating data stays on (docs/telemetry-design.md)
    for (const name of ['chat_messages_total', 'ai_calls_total', 'client_sessions_total', 'ui_events_total', 'mcp_calls_total', 'oauth_events_total', 'tracker_ops_total', 'uploads_total', 'upload_bytes']) expect(names).not.toContain(name);
  });
});
