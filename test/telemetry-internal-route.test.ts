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
import { PRODUCT_ANALYTICS_METRICS } from '../server/telemetry/collector.mjs';
import { appVersionLabel, dropFeatureSeries } from '../server/telemetry/report.mjs';

// GET /api/internal/telemetry (docs/telemetry-design.md, "How reports leave an instance"): the last finished hour's report, exactly as the
// Privacy tab previews it, for the control plane's bearer token and nobody else. The instance sends nothing itself.

const TOKEN = 'c'.repeat(40);
const PRODUCT = [...PRODUCT_ANALYTICS_METRICS] as string[];
const HOUR = 3_600_000;
type Role = 'owner' | 'admin' | 'member';
const worlds: { close: () => Promise<void> }[] = [];

async function setup(opts: { env?: Record<string, string>; hosted?: boolean; now?: () => number; log?: (line: string) => void; dir?: string } = {}) {
  const hosted = opts.hosted !== false;
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-telemetry-route-'));
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
      workspaceView: () => ({ readOnly: false, banner: null, seatLimit: null, seatsUsed: 0 }),
      tokenOk: (header: string | undefined) => header === `Bearer ${TOKEN}`,
      workspaceId: config.cloud?.workspaceId,
      seatUsage: () => ({}),
    }
    : null;
  const api = createApi({
    directory, auth, config, cloud: cloud as never, roomExists: () => false, events: new EventEmitter(), dataDir: dir,
    mailer: { send: async () => {} }, now: opts.now, maintenance: () => state.restoring, ...(opts.log ? { log: opts.log as unknown as () => void } : {}),
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
    api, config, directory, signIn, pull, call, state, dir,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      directory.close();
      if (!opts.dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
    let at = 1_800_000_000_000;
    const w = await setup({ now: () => at });
    w.api.captureTelemetryHour();
    at += HOUR; // the hour has finished
    expect((await w.pull({})).status).toBe(401);
    expect((await w.pull({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await w.pull({ authorization: `Basic ${TOKEN}` })).status).toBe(401);
    for (const role of ['owner', 'admin', 'member'] as const) {
      at += 61_000; // each group is counted in its own minute: the refusals here are not the point of this test
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
    let at = 1_800_000_000_000;
    const first = at;
    const w = await setup({ now: () => at });
    const owner = w.signIn('owner');
    await w.call(owner, 'GET', '/api/me');
    w.api.captureTelemetryHour();
    at += HOUR;
    const res = await w.pull();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const report = res.body;
    expect(report).toMatchObject({ schema: 1, hour: Math.floor(first / HOUR) * HOUR, mode: 'hosted', workspace: 'ws_telemetry' });
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
    let at = 1_800_000_000_000;
    const w = await setup({ now: () => at });
    const owner = w.signIn('owner');
    const preview = (await w.call(owner, 'GET', '/api/admin/privacy/preview')).body.preview;
    w.api.captureTelemetryHour();
    at += HOUR;
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
    const hour = at - (at % HOUR);
    w.api.telemetryTick();
    expect((await w.pull()).status).toBe(503); // built, but the hour is still running: never handed out inside it
    at += 6_000;
    const res = await w.pull();
    expect([res.status, res.body.hour]).toEqual([200, hour]);
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

  it('keeps answering 200 with operating data when the owner turns product analytics off, through the real path (no manual capture in between)', async () => {
    let at = 1_800_000_000_000;
    const w = await setup({ now: () => at });
    const owner = w.signIn('owner');
    w.api.captureTelemetryHour();
    at += HOUR;
    expect((await w.pull()).status).toBe(200);
    expect((await w.call(owner, 'PUT', '/api/admin/privacy', { enabled: false })).status).toBe(200);
    const after = await w.pull(); // straight away: not a 503 until the next hour
    expect(after.status).toBe(200);
    const names = after.body.metrics.map((m: { name: string }) => m.name);
    expect(names).toContain('entities_total'); // operating data stays on (docs/telemetry-design.md)
    for (const name of PRODUCT) expect(names).not.toContain(name);
    // a build made while the switch is off is operating-only too
    w.api.captureTelemetryHour();
    at += HOUR;
    const later = await w.pull();
    expect(later.status).toBe(200);
    expect(later.body.hour).toBe(Math.floor(at / HOUR) * HOUR - HOUR);
    for (const name of PRODUCT) expect(later.body.metrics.map((m: { name: string }) => m.name)).not.toContain(name);
  });

  it('takes feature series out of a report for good, and leaves the operating series and the rest of the report alone', () => {
    const report = { schema: 1, hour: 5, workspace: 'ws_x', metrics: [{ name: 'chat_messages_total', labels: {}, value: 3 }, { name: 'entities_total', labels: { kind: 'boards' }, value: 2 }, ...PRODUCT.map((name) => ({ name, labels: {}, value: 1 }))], errors: [], events: [], alerts: [] };
    const out = dropFeatureSeries(report);
    expect(out.metrics).toEqual([{ name: 'entities_total', labels: { kind: 'boards' }, value: 2 }]);
    expect(out).toMatchObject({ schema: 1, hour: 5, workspace: 'ws_x' });
    expect(report.metrics.length).toBe(2 + PRODUCT.length); // the original is untouched
    expect(dropFeatureSeries(null)).toBeNull();
  });
});

describe('capture timing', () => {
  const startOfHour = (t: number) => t - (t % HOUR);

  it('builds again every ten seconds in the last minute, so a late or missed timer costs seconds, not the hour', async () => {
    const base = startOfHour(1_800_000_000_000);
    let at = base + 30 * 60_000;
    const w = await setup({ now: () => at });
    w.api.telemetryTick();
    expect((await w.pull()).status).toBe(503); // not yet the last minute
    at = base + HOUR - 59_000;
    w.api.telemetryTick();
    expect((await w.pull()).status).toBe(503); // built, but the hour has not ended: not handed out, so a pull cannot take a partial hour
    // a tick that comes late (here with 1.5 s to go) still builds: the hour is not skipped because an earlier window passed
    at = base + HOUR - 1_500;
    w.api.telemetryTick();
    expect((await w.pull()).status).toBe(503);
    at = base + HOUR + 1_000;
    const done = await w.pull();
    expect([done.status, done.body.hour]).toEqual([200, base]);
  });

  it('throws away a build that crosses the boundary instead of labelling it with the next hour', async () => {
    const base = startOfHour(1_800_000_000_000);
    let at = base + HOUR - 30_000;
    let step = 0;
    const w = await setup({ now: () => (at += step) });
    w.api.telemetryTick();
    // the clock now moves with every read, so a build that starts just before the boundary ends after it
    at = base + HOUR - 700;
    step = 300;
    w.api.captureTelemetryHour();
    step = 0;
    at = base + HOUR + 60_000;
    const after = await w.pull();
    expect(after.status).toBe(200);
    expect(after.body.hour).toBe(base); // the finished hour from the earlier build, not an empty one labelled with the new hour
    expect(after.body.metrics.length).toBeGreaterThan(0);
  });

  it('answers nothing for an hour whose only build crossed the boundary (503, never a report of the next hour)', async () => {
    const base = startOfHour(1_800_000_000_000);
    let at = base + HOUR - 700;
    let step = 300;
    const w = await setup({ now: () => (at += step) });
    w.api.captureTelemetryHour();
    step = 0;
    at = base + HOUR + 60_000;
    const res = await w.pull();
    expect([res.status, res.body.error]).toEqual([503, 'no_report_yet']);
  });

  it('serves the last finished hour for up to 72 hours when the capture window of later hours was missed, then answers stale_report', async () => {
    const base = startOfHour(1_800_000_000_000);
    let at = base + HOUR - 5_000;
    const w = await setup({ now: () => at });
    w.api.telemetryTick(); // hour A built
    at = base + 2 * HOUR - 120_000; // hour B (the next one): the timer does not run in its last minute
    w.api.telemetryTick(); // not in the window: nothing
    at = base + HOUR + 120_000;
    expect((await w.pull()).body.hour).toBe(base);
    at = base + 2 * HOUR + 1_000; // hour B ended with no build: hour A is handed out again (the collector drops the duplicate)
    expect((await w.pull()).body.hour).toBe(base);
    at = base + 72 * HOUR + 1_000; // the collector's window: still accepted
    expect((await w.pull()).status).toBe(200);
    at = base + 73 * HOUR;
    const res = await w.pull();
    expect([res.status, res.body.error]).toEqual([503, 'stale_report']);
  });

  it('does not build while a restore has the workspace, and a tick on a closed directory does not throw', async () => {
    const base = startOfHour(1_800_000_000_000);
    let at = base + HOUR - 30_000;
    const lines: string[] = [];
    const w = await setup({ now: () => at, log: (line: string) => lines.push(line) });
    w.state.restoring = true;
    expect(() => w.api.telemetryTick()).not.toThrow();
    w.state.restoring = false;
    at = base + HOUR + 60_000;
    expect((await w.pull()).body.error).toBe('no_report_yet'); // nothing was built while the restore had it
    expect(lines).toEqual([]);
  });
});

describe('a workspace id the report schema does not accept', () => {
  it('logs one warning per process (never the id), tells the Privacy preview, and still builds nothing for the control plane', async () => {
    const lines: string[] = [];
    let at = 1_800_000_000_000 - (1_800_000_000_000 % HOUR) + HOUR - 5_000;
    const w = await setup({ env: { TABULA_CLOUD_WORKSPACE_ID: 'qa-ws' }, now: () => at, log: (line: string) => lines.push(line) });
    const owner = w.signIn('owner');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TABULA_CLOUD_WORKSPACE_ID');
    expect(lines[0]).not.toContain('qa-ws');
    const preview = await w.call(owner, 'GET', '/api/admin/privacy/preview');
    await w.call(owner, 'GET', '/api/admin/privacy/preview');
    expect([preview.body.problem, preview.body.preview]).toEqual(['workspace_id', null]);
    w.api.telemetryTick();
    at += HOUR;
    expect((await w.pull()).status).toBe(503);
    expect(lines).toHaveLength(1);
  });

  it('says nothing when the id is valid, or when collection is forced off', async () => {
    const good: string[] = [];
    const a = await setup({ log: (line: string) => good.push(line) });
    const preview = await a.call(a.signIn('owner'), 'GET', '/api/admin/privacy/preview');
    expect(preview.body.problem).toBeUndefined();
    expect(good).toEqual([]);
    const off: string[] = [];
    await setup({ env: { TABULA_CLOUD_WORKSPACE_ID: 'qa-ws', TABULA_TELEMETRY: 'off' }, log: (line: string) => off.push(line) });
    expect(off).toEqual([]);
  });
});

describe('a report kept across a stop', () => {
  const startOfHour = (t: number) => t - (t % HOUR);
  const base = startOfHour(1_800_000_000_000);
  const dirs: string[] = [];
  const freshDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-telemetry-keep-')); dirs.push(d); return d; };
  // the servers on these directories are closed first (the file-level hook runs after this one), then the directories go, with retries for Windows
  afterEach(async () => {
    await Promise.all(worlds.splice(0).map((w) => w.close()));
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const stored = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'telemetry-last.json'), 'utf8'));

  it('writes the finished hour to one small file and serves it after a restart that has no report in memory', async () => {
    const dir = freshDir();
    let at = base + HOUR - 5_000;
    const first = await setup({ dir, now: () => at });
    first.api.telemetryTick();
    at = base + HOUR + 60_000;
    const before = await first.pull();
    expect(before.status).toBe(200);
    await first.close();
    worlds.splice(worlds.indexOf(first), 1);
    const file = fs.readFileSync(path.join(dir, 'telemetry-last.json'), 'utf8');
    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.parse(file)).toEqual(before.body);
    expect(file).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/iu);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('telemetry-last'))).toEqual(['telemetry-last.json']); // no temporary file left
    at = base + HOUR + 25 * 60_000; // the machine woke later in the next hour
    const second = await setup({ dir, now: () => at });
    const after = await second.pull();
    expect([after.status, after.body]).toEqual([200, before.body]);
  });

  it('flushes the running hour when the process stops and hands it over after the hour has ended, never inside it', async () => {
    const dir = freshDir();
    let at = base + 20 * 60_000;
    const first = await setup({ dir, now: () => at });
    first.api.flushTelemetry();
    expect(stored(dir)).toMatchObject({ hour: base, workspace: 'ws_telemetry' });
    await first.close();
    worlds.splice(worlds.indexOf(first), 1);
    at = base + 40 * 60_000; // woken in the same hour: the flushed hour is still running, so there is nothing to hand out yet
    const second = await setup({ dir, now: () => at });
    expect((await second.pull()).body.error).toBe('no_report_yet');
    at = base + HOUR + 3 * 60_000;
    const res = await second.pull();
    expect([res.status, res.body.hour]).toEqual([200, base]);
  });

  it('keeps the first report of an hour: a second stop in the same hour does not replace it', async () => {
    const dir = freshDir();
    let at = base + 20 * 60_000;
    const first = await setup({ dir, now: () => at });
    first.api.flushTelemetry();
    const one = fs.readFileSync(path.join(dir, 'telemetry-last.json'), 'utf8');
    await first.close();
    worlds.splice(worlds.indexOf(first), 1);
    at = base + 50 * 60_000;
    const second = await setup({ dir, now: () => at });
    second.api.flushTelemetry();
    expect(fs.readFileSync(path.join(dir, 'telemetry-last.json'), 'utf8')).toBe(one);
  });

  it('does not flush while a restore has the workspace, or when the operator turned collection off', async () => {
    const dir = freshDir();
    const a = await setup({ dir, now: () => base + 20 * 60_000 });
    a.state.restoring = true;
    a.api.flushTelemetry();
    expect(fs.existsSync(path.join(dir, 'telemetry-last.json'))).toBe(false);
    const dir2 = freshDir();
    const b = await setup({ dir: dir2, env: { TABULA_TELEMETRY: 'off' }, now: () => base + 20 * 60_000 });
    b.api.flushTelemetry();
    expect(fs.existsSync(path.join(dir2, 'telemetry-last.json'))).toBe(false);
  });

  it('removes a stored report at start when the operator turned collection off', async () => {
    const dir = freshDir();
    let at = base + 20 * 60_000;
    const first = await setup({ dir, now: () => at });
    first.api.flushTelemetry();
    await first.close();
    worlds.splice(worlds.indexOf(first), 1);
    expect(fs.existsSync(path.join(dir, 'telemetry-last.json'))).toBe(true);
    await setup({ dir, env: { TABULA_TELEMETRY: 'off' }, now: () => at });
    expect(fs.existsSync(path.join(dir, 'telemetry-last.json'))).toBe(false);
  });

  it('answers stale_report when the stored hour is older than 72 hours', async () => {
    const dir = freshDir();
    let at = base + 20 * 60_000;
    const first = await setup({ dir, now: () => at });
    first.api.flushTelemetry();
    await first.close();
    worlds.splice(worlds.indexOf(first), 1);
    at = base + 72 * HOUR + 60_000;
    const second = await setup({ dir, now: () => at });
    expect((await second.pull()).status).toBe(200);
    at = base + 73 * HOUR;
    const res = await second.pull();
    expect([res.status, res.body.error]).toEqual([503, 'stale_report']);
  });

  it('never serves a stored report with feature series after the owner opted out, and rewrites the file without them', async () => {
    const dir = freshDir();
    const at = base + HOUR + 10 * 60_000;
    // a report built before the opt-out, with a product series in it
    const seed = await setup({ dir, now: () => base + 20 * 60_000 });
    seed.api.flushTelemetry();
    await seed.close();
    worlds.splice(worlds.indexOf(seed), 1);
    const report = stored(dir);
    report.metrics.push({ name: 'chat_messages_total', labels: { kind: 'channel' }, value: 4 });
    fs.writeFileSync(path.join(dir, 'telemetry-last.json'), JSON.stringify(report));
    const w = await setup({ dir, now: () => at });
    const owner = w.signIn('owner');
    expect((await w.pull()).body.metrics.map((m: { name: string }) => m.name)).toContain('chat_messages_total'); // on: it is handed out
    expect((await w.call(owner, 'PUT', '/api/admin/privacy', { enabled: false })).status).toBe(200);
    const after = await w.pull();
    expect(after.status).toBe(200);
    for (const name of PRODUCT) expect(after.body.metrics.map((m: { name: string }) => m.name)).not.toContain(name);
    expect(fs.readFileSync(path.join(dir, 'telemetry-last.json'), 'utf8')).not.toContain('chat_messages_total');
    // a process that starts after the opt-out (the switch is saved) filters on serving too, whatever the file holds
    fs.writeFileSync(path.join(dir, 'telemetry-last.json'), JSON.stringify(report));
    await w.close();
    worlds.splice(worlds.indexOf(w), 1);
    const later = await setup({ dir, now: () => at });
    for (const name of PRODUCT) expect((await later.pull()).body.metrics.map((m: { name: string }) => m.name)).not.toContain(name);
  });

  it('ignores a stored report of another workspace, a damaged file, and one the scrubber would change', async () => {
    const dir = freshDir();
    const seed = await setup({ dir, now: () => base + 20 * 60_000 });
    seed.api.flushTelemetry();
    await seed.close();
    worlds.splice(worlds.indexOf(seed), 1);
    const good = stored(dir);
    const at = base + HOUR + 5 * 60_000;
    for (const [label, text] of [['another workspace', JSON.stringify({ ...good, workspace: 'ws_somebodyelse' })], ['damaged', '{"hour":'], ['unknown field', JSON.stringify({ ...good, owner: 'x@example.test' })]] as const) {
      fs.writeFileSync(path.join(dir, 'telemetry-last.json'), text);
      const w = await setup({ dir, now: () => at });
      const res = await w.pull();
      expect([label, res.status, res.body.error]).toEqual([label, 503, 'no_report_yet']);
    }
  });

  it('does nothing for an invalid workspace id: no file, no report', async () => {
    const dir = freshDir();
    const w = await setup({ dir, env: { TABULA_CLOUD_WORKSPACE_ID: 'qa-ws' }, now: () => base + 20 * 60_000 });
    w.api.flushTelemetry();
    expect(fs.existsSync(path.join(dir, 'telemetry-last.json'))).toBe(false);
  });

  it('writes nothing on a server without a control plane', async () => {
    const dir = freshDir();
    const w = await setup({ dir, hosted: false, env: { TABULA_TELEMETRY: 'on' }, now: () => base + 20 * 60_000 });
    w.api.flushTelemetry();
    expect(fs.existsSync(path.join(dir, 'telemetry-last.json'))).toBe(false);
  });
});

describe('the release label', () => {
  it.each([['5.3.1', 'v5.3.1'], ['v5.3.1', 'v5.3.1'], ['2026.10.09-1', 'v2026.10.09'], ['2026.10.09', 'v2026.10.09'], ['1.2', 'v1.2'], ['abc1234', 'abc1234'], ['0123456789ab', '0123456789ab'], ['weird label', 'v0.1.0'], ['', 'v0.1.0']])('writes %s as %s', (label, expected) => {
    expect(appVersionLabel(label)).toBe(expected);
  });

  it('keeps a date-style TABULA_VERSION from costing the whole report', async () => {
    let at = 1_800_000_000_000;
    const w = await setup({ env: { TABULA_VERSION: '2026.10.09-1' }, now: () => at });
    w.api.captureTelemetryHour();
    at += HOUR;
    const res = await w.pull();
    expect([res.status, res.body.app_version]).toEqual([200, 'v2026.10.09']);
  });
});

describe('refused control-token attempts', () => {
  it('counts them per address, answers 429 after thirty a minute, logs once a minute without any credential, and never counts a valid call', async () => {
    const lines: string[] = [];
    let at = 1_800_000_000_000;
    const w = await setup({ now: () => at, log: (line: string) => lines.push(line) });
    w.api.captureTelemetryHour();
    at += HOUR;
    const bad = { authorization: 'Bearer secret-attempt-value' };
    for (let i = 0; i < 30; i++) expect((await w.pull(bad)).status).toBe(401);
    const limited = await w.pull(bad);
    expect([limited.status, limited.body.error]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await w.pull()).status).toBe(200); // the control plane's own token still works
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('internal route internal/telemetry refused');
    expect(lines[0]).not.toContain('secret-attempt-value');
    expect(lines[0]).not.toContain(TOKEN);
    at += 61_000;
    expect((await w.pull(bad)).status).toBe(401); // a minute later it is counted afresh, and logged again
    expect(lines).toHaveLength(2);
  });
});

describe('the preview note', () => {
  it('says what Tabula does with the report on a hosted workspace, and that nothing is sent on a server you run', async () => {
    const hosted = await setup();
    expect((await hosted.call(hosted.signIn('owner'), 'GET', '/api/admin/privacy/preview')).body.note).toBe('Collected by Tabula once an hour, as shown');
    const self = await setup({ hosted: false, env: { TABULA_TELEMETRY: 'on' } });
    expect((await self.call(self.signIn('owner'), 'GET', '/api/admin/privacy/preview')).body.note).toBe('Nothing has been sent');
  });
});

