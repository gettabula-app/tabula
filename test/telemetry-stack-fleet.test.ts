import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../telemetry-collector/src/config.mjs';
import { deleteWorkspace } from '../telemetry-collector/src/delete.mjs';
import { allSeriesNames, reportToLoki, reportToRows, reportToVm } from '../telemetry-collector/src/map.mjs';
import { allowWorkspace, claimHour, pruneHours } from '../telemetry-collector/src/state.mjs';
import { issueToken } from '../telemetry-collector/src/registry.mjs';
import { createCollector } from '../telemetry-collector/src/server.mjs';
import { spoolPath } from '../telemetry-collector/src/spool.mjs';
import { validateReport } from '../telemetry-collector/src/validate.mjs';
import { HOUR, WORKSPACE, validReport } from './telemetry-stack-fixtures';

// Fleet snapshots: the control plane's own report about a workspace (kind 'fleet', one workspace_hour event). Control-plane token only, own hour
// claim, tabula_fleet_* gauges and lake events rows, nothing in Loki.

const NOW = HOUR + 20 * 60 * 1000;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-fleet-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const config = (extra: Record<string, string> = {}) =>
  loadConfig({ TELEMETRY_DATA_DIR: dir, VM_URL: 'http://vm.test', LOKI_URL: 'http://loki.test', COLLECTOR_DELETE_WAIT_MS: '0', ...extra });

const fleetReport = (overrides: Record<string, unknown> = {}, event: Record<string, unknown> = {}): any => ({
  schema: 1, kind: 'fleet', hour: HOUR, workspace: WORKSPACE,
  events: [{
    event: 'workspace_hour', state: 'active', machine: 'stopped', plan: 'paid', backup_state: 'ok', seats_paid: 1, seats_used: 7, guests_used: 2, members_used: 9,
    disk_used_bytes: 100, disk_total_bytes: 1000, backup_age_hours: 5, app_version: 'v5.3.1', ...event,
  }].map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined))),
  ...overrides,
});
const clean = (report: unknown = fleetReport()) => (validateReport(report, { workspace: null, now: NOW }) as any).clean;

describe('validation of a fleet report', () => {
  it('accepts it from a control-plane token and keeps exactly the fleet shape', () => {
    const checked = validateReport(fleetReport(), { workspace: null, now: NOW }) as any;
    expect(checked.ok).toBe(true);
    expect(Object.keys(checked.clean).sort()).toEqual(['events', 'hour', 'kind', 'schema', 'workspace']);
    expect(checked.clean.events).toHaveLength(1);
  });

  it('refuses it from a workspace-bound token with 403, whatever the workspace says', () => {
    expect(validateReport(fleetReport(), { workspace: WORKSPACE, now: NOW })).toMatchObject({ ok: false, status: 403, error: 'fleet_requires_control_plane' });
    expect(validateReport(fleetReport({ workspace: 'ws_other0123456' }), { workspace: WORKSPACE, now: NOW })).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects the whole report when the scrubber had to drop anything', () => {
    for (const bad of [
      fleetReport({ metrics: [{ name: 'data_bytes', labels: {}, value: 1 }] }),
      fleetReport({ errors: [{ fingerprint: 'abcdef0123456789', code: 'not_found', kind: 'api', status: 404, top_frame: 'server/api.mjs:27', count: 1 }] }),
      fleetReport({ connections_now: 3 }),
      fleetReport({}, { state: 'weird' }),
      fleetReport({}, { slug: 'secret' }),
      fleetReport({ events: [] }),
      fleetReport({ events: [fleetReport().events[0], fleetReport().events[0]] }),
      fleetReport({}, { seats_used: 100_001 }),
    ]) {
      expect(validateReport(bad, { workspace: null, now: NOW })).toMatchObject({ ok: false, status: 422, error: 'invalid_report' });
    }
  });

  it('keeps an instance report with a workspace_hour event rejected, and a normal report unchanged', () => {
    const sneaky = validReport({ events: [...validReport().events, fleetReport().events[0]] });
    expect(validateReport(sneaky, { workspace: WORKSPACE, now: NOW })).toMatchObject({ ok: false, status: 422 });
    expect(validateReport(validReport(), { workspace: WORKSPACE, now: NOW })).toMatchObject({ ok: true });
  });
});

describe('mapping a fleet report', () => {
  it('writes the fleet gauges at the report hour with the enums as labels of one info series', () => {
    const lines = reportToVm(clean(), NOW) as any[];
    const byName = Object.fromEntries(lines.map((l) => [l.metric.__name__, l]));
    expect(byName.tabula_fleet_workspace_info.metric).toEqual({ __name__: 'tabula_fleet_workspace_info', workspace: WORKSPACE, state: 'active', plan: 'paid', machine: 'stopped', backup_state: 'ok' });
    expect(JSON.stringify(lines)).not.toContain('v5.3.1'); // the version is not a label or a value here
    expect(byName.tabula_fleet_machine_started.values).toEqual([0]);
    expect(byName.tabula_fleet_seats_used.values).toEqual([7]);
    expect(byName.tabula_fleet_backup_age_hours.values).toEqual([5]);
    expect(byName.tabula_fleet_disk_total_bytes.values).toEqual([1000]);
    expect(lines.every((l) => l.metric.workspace === WORKSPACE && l.timestamps[0] === HOUR)).toBe(true);
    expect(lines.every((l) => allSeriesNames().has(l.metric.__name__))).toBe(true);
    expect(lines.some((l) => /connections|report_info/.test(l.metric.__name__))).toBe(false);
  });

  it('marks a started machine and leaves out the numbers the control plane did not know', () => {
    const lines = reportToVm(clean(fleetReport({}, { machine: 'started', seats_used: undefined, disk_used_bytes: undefined, backup_age_hours: undefined, app_version: undefined })), NOW) as any[];
    const byName = Object.fromEntries(lines.map((l) => [l.metric.__name__, l]));
    expect(byName.tabula_fleet_machine_started.values).toEqual([1]);
    expect(byName.tabula_fleet_seats_used).toBeUndefined();
    expect(byName.tabula_fleet_workspace_info.metric).not.toHaveProperty('app_version');
  });

  it('keeps the image version in the lake row', () => {
    expect(JSON.parse((reportToRows(clean(), NOW) as any[])[0].data)).toMatchObject({ app_version: 'v5.3.1' });
  });

  it('puts nothing in Loki and one events row in the lake, flat and without the instance status row', () => {
    expect(reportToLoki(clean())).toEqual({ streams: [] });
    const rows = reportToRows(clean(), NOW) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stream: 'events', name: 'workspace_hour', workspace: WORKSPACE, hour: HOUR, dt: '2026-10-11' });
    expect(JSON.parse(rows[0].data)).toMatchObject({ state: 'active', machine: 'stopped', seats_used: 7 });
  });
});

async function fakeSinks() {
  const calls: { sink: string; url: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { calls.push({ sink: req.url?.startsWith('/loki') ? 'loki' : 'vm', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(204); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

async function startCollector(sinkUrl: string) {
  const cfg = config({ VM_URL: sinkUrl, LOKI_URL: sinkUrl, COLLECTOR_SINK_RETRY_MS: '50' });
  const logs: string[] = [];
  const log = { info: (m: string, f: any) => logs.push(JSON.stringify({ m, ...f })), warn: (m: string, f: any) => logs.push(JSON.stringify({ m, ...f })), error: (m: string, f: any) => logs.push(JSON.stringify({ m, ...f })) };
  const { server } = createCollector(cfg, { log, now: () => NOW });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { cfg, base, logs, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const post = (base: string, token: string, body: unknown) =>
  fetch(`${base}/v1/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

describe('the collector with fleet reports', () => {
  it('takes a fleet report from the control-plane token to VictoriaMetrics and the lake, nothing to Loki, and refuses a repeat of the same hour', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url);
    const cp = issueToken(c.cfg.registryFile, { workspace: null });
    allowWorkspace(c.cfg, WORKSPACE);
    try {
      const response = await post(c.base, cp.token, fleetReport());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, accepted: { metrics: 0, errors: 0, events: 1 }, sinks: { vm: 'ok', loki: 'skipped' } });
      const vm = sinks.calls.find((call) => call.sink === 'vm')!;
      expect(vm.body.split('\n').map((l) => JSON.parse(l).metric.__name__)).toContain('tabula_fleet_workspace_info');
      expect(sinks.calls.some((call) => call.sink === 'loki')).toBe(false);
      const spool = fs.readFileSync(spoolPath(c.cfg.lakeDir, NOW), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(spool).toHaveLength(1);
      expect(spool[0]).toMatchObject({ stream: 'events', name: 'workspace_hour' });
      expect(c.logs.join('\n')).toContain('"kind":"fleet"');
      expect(c.logs.join('\n')).not.toContain(cp.token);
      expect((await post(c.base, cp.token, fleetReport())).status).toBe(409);
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('keeps the fleet claim apart from the instance report claim of the same hour, in both orders', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url);
    const cp = issueToken(c.cfg.registryFile, { workspace: null });
    const own = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    allowWorkspace(c.cfg, WORKSPACE);
    try {
      expect((await post(c.base, own.token, validReport())).status).toBe(200);
      expect((await post(c.base, cp.token, fleetReport())).status).toBe(200);
      expect((await post(c.base, own.token, validReport())).status).toBe(409);
      expect((await post(c.base, cp.token, fleetReport())).status).toBe(409);
      // the other hour first
      expect((await post(c.base, cp.token, fleetReport({ hour: HOUR - 3_600_000 }))).status).toBe(200);
      expect((await post(c.base, own.token, validReport({ hour: HOUR - 3_600_000 }))).status).toBe(200);
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('refuses a fleet report from a workspace-bound token (403) and from a control-plane token for a workspace not on the allowlist, storing nothing', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url);
    const cp = issueToken(c.cfg.registryFile, { workspace: null });
    const own = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    try {
      const bound = await post(c.base, own.token, fleetReport());
      expect(bound.status).toBe(403);
      expect(await bound.json()).toMatchObject({ error: 'fleet_requires_control_plane' });
      expect((await post(c.base, cp.token, fleetReport())).status).toBe(403); // empty allowlist fails closed
      allowWorkspace(c.cfg, 'ws_someoneelse1');
      expect((await post(c.base, cp.token, fleetReport())).status).toBe(403);
      expect((await post(c.base, cp.token, fleetReport({ metrics: [{ name: 'data_bytes', labels: {}, value: 1 }] }))).status).toBe(422);
      expect(sinks.calls).toHaveLength(0);
      expect(fs.existsSync(spoolPath(c.cfg.lakeDir, NOW))).toBe(false);
      expect(claimHour(c.cfg, WORKSPACE, HOUR, 'fleet')).toBe(true); // nothing was claimed by the refusals
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('prunes old fleet claims like report claims, and a workspace deletion removes the fleet gauges, rows and claims', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url);
    const cp = issueToken(c.cfg.registryFile, { workspace: null });
    allowWorkspace(c.cfg, WORKSPACE);
    try {
      expect((await post(c.base, cp.token, fleetReport())).status).toBe(200);
      expect(pruneHours(c.cfg, NOW + 100 * 3_600_000)).toBe(1);
      expect(claimHour(c.cfg, WORKSPACE, HOUR, 'fleet')).toBe(true); // pruned, so claimable again
      const result = await deleteWorkspace(c.cfg, WORKSPACE, { now: NOW });
      expect(result).toMatchObject({ ok: true, victoriametrics: 'ok' });
      expect((result.lake as any).spoolRowsRemoved).toBe(1);
      expect(fs.readFileSync(spoolPath(c.cfg.lakeDir, NOW), 'utf8')).not.toContain(WORKSPACE);
      expect(decodeURIComponent(sinks.calls.find((call) => call.url.includes('delete_series'))!.url)).toContain(`{workspace="${WORKSPACE}"}`);
      expect(claimHour(c.cfg, WORKSPACE, HOUR, 'fleet')).toBe(true); // claims of the workspace are gone
      expect((await post(c.base, cp.token, fleetReport({ hour: HOUR - 3_600_000 }))).status).toBe(410);
    } finally {
      await c.close();
      await sinks.close();
    }
  });
});
