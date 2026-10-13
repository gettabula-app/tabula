import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../telemetry-collector/src/config.mjs';
import { deleteWorkspace } from '../telemetry-collector/src/delete.mjs';
import { applyRetention } from '../telemetry-collector/src/lake.mjs';
import { allSeriesNames, reportToLoki, reportToRows, reportToVm } from '../telemetry-collector/src/map.mjs';
import { allowWorkspace, claimHour, isDeleting, listMarkers, readMarker } from '../telemetry-collector/src/state.mjs';
import { createLimiter } from '../telemetry-collector/src/ratelimit.mjs';
import { createRegistry, issueToken, listTokens, revokeTokens } from '../telemetry-collector/src/registry.mjs';
import { createCollector } from '../telemetry-collector/src/server.mjs';
import { listSpool, spoolPath } from '../telemetry-collector/src/spool.mjs';
import { validateReport } from '../telemetry-collector/src/validate.mjs';
import { CONTROL_PLANE_EVENTS, HOUR, WORKSPACE, validReport } from './telemetry-stack-fixtures';

const NOW = HOUR + 20 * 60 * 1000;
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-stack-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function config(extra: Record<string, string> = {}) {
  return loadConfig({ TELEMETRY_DATA_DIR: dir, VM_URL: 'http://vm.test', LOKI_URL: 'http://loki.test', COLLECTOR_DELETE_WAIT_MS: '0', ...extra });
}

describe('validation', () => {
  it('accepts the full catalogue and binds the workspace to the token', () => {
    const result = validateReport(validReport({ workspace: undefined }), { workspace: WORKSPACE, now: NOW }) as any;
    expect(result.ok).toBe(true);
    expect(result.clean.workspace).toBe(WORKSPACE);
  });

  it('rejects a workspace that differs from the token and requires one for control-plane tokens', () => {
    expect(validateReport(validReport(), { workspace: 'ws_other_workspace', now: NOW })).toMatchObject({ ok: false, status: 403 });
    expect(validateReport(validReport({ workspace: undefined }), { workspace: null, now: NOW })).toMatchObject({ ok: false, status: 422, error: 'workspace_required' });
    expect(validateReport(validReport(), { workspace: null, now: NOW })).toMatchObject({ ok: true });
  });

  it.each([
    ['an unknown top-level key', (r: any) => { r.note = 'hello'; }],
    ['an email in a field', (r: any) => { r.app_version = 'a@b.example'; }],
    ['a url as an error frame', (r: any) => { r.errors[0].top_frame = 'https://x.test/a'; }],
    ['an IP address', (r: any) => { r.errors[0].code = '10.0.0.1'; }],
    ['a token-like value', (r: any) => { r.errors[0].code = 'sk_live_0123456789abcdef'; }],
    ['an unknown metric', (r: any) => { r.metrics.push({ name: 'board_titles', labels: {}, value: 1 }); }],
    ['an unknown label value', (r: any) => { r.metrics[0].labels.route = '/boards/secret-title'; }],
    ['an instance alert', (r: any) => { r.alerts = [{ kind: 'other', severity: 'info', workspace: null, at: 1 }]; }],
    ['a person field', (r: any) => { r.user_email = 'ann@example.test'; }],
  ])('rejects a report with %s and never echoes the value', (_name, mutate) => {
    const report = validReport();
    mutate(report);
    const result = validateReport(report, { workspace: WORKSPACE, now: NOW }) as any;
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/example|secret-title|sk_live|10\.0\.0\.1|hello/u);
    expect(result.dropped.total).toBeGreaterThan(0);
  });

  it('rejects hours in the future or too old, and non-objects', () => {
    expect(validateReport(validReport(), { workspace: WORKSPACE, now: HOUR - 3 * 3600_000 })).toMatchObject({ error: 'hour_out_of_range' });
    expect(validateReport(validReport(), { workspace: WORKSPACE, now: HOUR + 100 * 3600_000 })).toMatchObject({ error: 'hour_out_of_range' });
    expect(validateReport([], { workspace: WORKSPACE, now: NOW })).toMatchObject({ ok: false });
    expect(validateReport(null, { workspace: WORKSPACE, now: NOW })).toMatchObject({ ok: false });
  });
});

describe('smoke script fixture', () => {
  it('prints a report the collector accepts', () => {
    const text = execFileSync('node', [path.resolve(__dirname, '..', 'deploy', 'telemetry', 'scripts', 'synthetic-report.mjs'), WORKSPACE], { encoding: 'utf8' });
    expect(validateReport(JSON.parse(text), { workspace: WORKSPACE })).toMatchObject({ ok: true });
  });
});

describe('mapping', () => {
  const clean = () => (validateReport(validReport(), { workspace: WORKSPACE, now: NOW }) as any).clean;
  // the operating events only the control plane may send, so this report arrives with a control-plane token
  const controlPlaneClean = () => (validateReport(validReport({ events: CONTROL_PLANE_EVENTS }), { workspace: null, now: NOW }) as any).clean;

  it('writes only known series names, all carrying the workspace label and the report hour', () => {
    const samples = reportToVm(clean(), NOW);
    const known = allSeriesNames();
    for (const s of samples) {
      expect(known.has(s.metric.__name__)).toBe(true);
      expect(s.metric.workspace).toBe(WORKSPACE);
      expect(s.timestamps).toEqual([HOUR]);
      expect(Number.isFinite(s.values[0])).toBe(true);
    }
    const names = new Set(samples.map((s: any) => s.metric.__name__));
    expect(names.has('tabula_http_requests_hourly')).toBe(true);
    expect(names.has('tabula_http_duration_ms_bucket')).toBe(true);
    expect(samples.some((s: any) => s.metric.__name__ === 'tabula_http_duration_ms_bucket' && s.metric.le === '+Inf')).toBe(true);
    expect(samples.find((s: any) => s.metric.__name__ === 'tabula_report_info')!.metric).toMatchObject({ app_version: 'v1.2.3', mode: 'hosted' });
  });

  it('puts error codes and operating events in Loki with workspace as a label and no free text', () => {
    const loki = reportToLoki(controlPlaneClean());
    const kinds = loki.streams.map((s: any) => s.stream.kind).sort();
    expect(kinds).toEqual(['error', 'event', 'event', 'report']);
    for (const s of loki.streams) {
      expect(s.stream.workspace).toBe(WORKSPACE);
      expect(s.values[0][0]).toBe(String(BigInt(HOUR) * 1_000_000n));
    }
    const errorLine = JSON.parse(loki.streams.find((s: any) => s.stream.kind === 'error').values[0][1]);
    expect(errorLine).toEqual({ fingerprint: 'abcdef0123456789', code: 'not_found', kind: 'api', status: 404, top_frame: 'server/api.mjs:27', count: 3 });
    expect(loki.streams.some((s: any) => s.stream.event === 'workspace_day')).toBe(false);
  });

  it('flattens the lake rows by stream with the day taken from the report hour', () => {
    const rows = reportToRows(controlPlaneClean(), NOW);
    expect(new Set(rows.map((r: any) => r.stream))).toEqual(new Set(['status', 'reports_hourly', 'errors', 'events']));
    expect(new Set(rows.map((r: any) => r.dt))).toEqual(new Set(['2026-10-11']));
    expect(rows.every((r: any) => r.workspace === WORKSPACE)).toBe(true);
    expect(rows.find((r: any) => r.stream === 'reports_hourly' && r.kind === 'histogram')).toMatchObject({ count: 1, sum: 1 });
  });
});

describe('registry', () => {
  it('stores only a hash, verifies, revokes, and tracks file changes without a restart', () => {
    const file = path.join(dir, 'registry.json');
    const registry = createRegistry(file);
    expect(registry.verify('tt_000000000000_' + 'a'.repeat(43))).toBeNull();
    const { id, token } = issueToken(file, { workspace: WORKSPACE, label: 'goated' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token.split('_').slice(2).join('_'));
    // POSIX permission bits do not exist on Windows (a file reads as 0o666); the registry mode is enforced and checked on Linux and macOS.
    expect(process.platform === 'win32' || (fs.statSync(file).mode & 0o777) === 0o600).toBe(true);
    expect(registry.verify(token)).toEqual({ id, workspace: WORKSPACE });
    expect(registry.verify(`${token}x`)).toBeNull();
    expect(registry.verify('nonsense')).toBeNull();
    expect(revokeTokens(file, { workspace: WORKSPACE })).toBe(1);
    expect(registry.verify(token)).toBeNull();
    expect(listTokens(file)[0].revokedAt).not.toBeNull();
    expect(JSON.stringify(listTokens(file))).not.toContain('hash');
    expect(() => issueToken(file, { workspace: 'bad id!' })).toThrow('invalid workspace id');
  });
});

describe('rate limiter', () => {
  it('allows the limit per window and recovers', () => {
    const limiter = createLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.hit('a', 0).ok).toBe(true);
    expect(limiter.hit('a', 10).ok).toBe(true);
    expect(limiter.hit('a', 20)).toMatchObject({ ok: false });
    expect(limiter.hit('b', 20).ok).toBe(true);
    expect(limiter.hit('a', 1011).ok).toBe(true);
  });
});

/** Fake VictoriaMetrics and Loki: HTTP stubs that record what they receive. */
async function fakeSinks() {
  const calls: { sink: string; method: string; url: string; body: string }[] = [];
  let failUntil = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const sink = req.url?.startsWith('/loki') ? 'loki' : 'vm';
      calls.push({ sink, method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      if (Date.now() < failUntil && !req.url?.includes('delete')) { res.writeHead(503); return res.end(); }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, failFor: (ms: number) => { failUntil = Date.now() + ms; }, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

async function startCollector(sinkUrl: string, extra: Record<string, string> = {}) {
  const cfg = config({ VM_URL: sinkUrl, LOKI_URL: sinkUrl, COLLECTOR_SINK_RETRY_MS: '50', ...extra });
  const logs: string[] = [];
  const log = { info: (m: string, f: any) => logs.push(JSON.stringify({ m, ...f })), warn: (m: string, f: any) => logs.push(JSON.stringify({ m, ...f })), error: (m: string, f: any) => logs.push(JSON.stringify({ m, ...f })) };
  const { server, sinks, counters } = createCollector(cfg, { log, now: () => NOW });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { cfg, base, sinks, counters, logs, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const post = (base: string, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('collector integration against fake sinks', () => {
  it('takes a full report through to VictoriaMetrics, Loki and the lake spool, without logging the payload', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url);
    const { token } = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    try {
      const response = await post(c.base, token, validReport());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ ok: true, sinks: { vm: 'ok', loki: 'ok' } });

      const vm = sinks.calls.find((call) => call.sink === 'vm')!;
      expect(vm.url).toBe('/api/v1/import');
      const vmLines = vm.body.split('\n').map((line) => JSON.parse(line));
      expect(vmLines.length).toBeGreaterThan(50);
      expect(vmLines.every((line: any) => line.metric.workspace === WORKSPACE)).toBe(true);

      const loki = sinks.calls.find((call) => call.sink === 'loki')!;
      expect(loki.url).toBe('/loki/api/v1/push');
      expect(JSON.parse(loki.body).streams.length).toBeGreaterThanOrEqual(2);

      const spool = fs.readFileSync(spoolPath(c.cfg.lakeDir, NOW), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(spool.some((row) => row.stream === 'errors' && row.name === 'not_found')).toBe(true);
      expect(spool.every((row) => row.workspace === WORKSPACE)).toBe(true);

      const logText = c.logs.join('\n');
      expect(logText).toContain('report_accepted');
      expect(logText).not.toContain(token);
      expect(logText).not.toContain('server/api.mjs');
      expect(logText).not.toContain('abcdef0123456789');

      const second = await post(c.base, token, validReport());
      expect(second.status).toBe(409);
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('answers 401, 403, 413, 415, 405 and 422 and keeps rejected reports out of every store', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url, { COLLECTOR_MAX_BODY_BYTES: '1024' });
    const { token } = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    const revoked = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    revokeTokens(c.cfg.registryFile, { id: revoked.id });
    try {
      const small = (extra: Record<string, unknown> = {}) => validReport({ metrics: [], errors: [], events: [], ...extra });
      expect((await post(c.base, null, small())).status).toBe(401);
      expect((await post(c.base, revoked.token, small())).status).toBe(401);
      expect((await post(c.base, token, small({ workspace: 'ws_somebody_else' }))).status).toBe(403);
      expect((await post(c.base, token, small(), { 'content-type': 'text/plain' })).status).toBe(415);
      expect((await post(c.base, token, validReport())).status).toBe(413); // the full catalogue is far above 1 KB
      expect((await fetch(`${c.base}/v1/telemetry`)).status).toBe(405);
      expect((await post(c.base, token, '{not json')).status).toBe(400);
      const bad = await post(c.base, token, { ...validReport({ metrics: [], errors: [], events: [] }), email: 'a@b.example' });
      expect(bad.status).toBe(422);
      expect(JSON.stringify(await bad.json())).not.toContain('b.example');
      expect(sinks.calls.length).toBe(0);
      expect(listSpool(c.cfg.lakeDir).length).toBe(0);
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('rate limits per token and throttles repeated bad tokens', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url, { COLLECTOR_RATE_PER_HOUR: '2', COLLECTOR_AUTH_FAILURES_PER_MINUTE: '3' });
    const { token } = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    const small = (hour: number) => validReport({ hour, metrics: [], errors: [], events: [] });
    try {
      expect((await post(c.base, token, small(HOUR))).status).toBe(200);
      expect((await post(c.base, token, small(HOUR - 3600_000))).status).toBe(200);
      const limited = await post(c.base, token, small(HOUR - 7200_000));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await post(c.base, 'tt_bad', {})).status);
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('a failing sink does not fail the post and the queue delivers once it recovers', async () => {
    const sinks = await fakeSinks();
    sinks.failFor(400);
    const c = await startCollector(sinks.url);
    const { token } = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    try {
      const body = await (await post(c.base, token, validReport())).json();
      expect(body.sinks).toEqual({ vm: 'queued', loki: 'queued' });
      expect(fs.existsSync(spoolPath(c.cfg.lakeDir, NOW))).toBe(true);
      const deadline = Date.now() + 5000;
      while (c.sinks.queueLength > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
      expect(c.sinks.queueLength).toBe(0);
      expect(c.sinks.stats.delivered).toEqual({ vm: 1, loki: 1 });
    } finally {
      await c.close();
      await sinks.close();
    }
  });
});

describe('deletion and retention', () => {
  it('deletes a workspace from VictoriaMetrics, Loki, the lake and the spool, revokes its tokens, and leaves others alone', async () => {
    const sinks = await fakeSinks();
    const cfg = config({ VM_URL: sinks.url, LOKI_URL: sinks.url });
    const other = 'ws_other0123456';
    // spool: two workspaces; lake: partitions for both in two streams
    const { appendRows } = await import('../telemetry-collector/src/spool.mjs');
    const clean = (id: string) => (validateReport(validReport({ workspace: id }), { workspace: id, now: NOW }) as any).clean;
    await appendRows(cfg.lakeDir, [...reportToRows(clean(WORKSPACE), NOW), ...reportToRows(clean(other), NOW)], NOW);
    for (const id of [WORKSPACE, other]) {
      for (const stream of ['reports_hourly', 'errors']) {
        const part = path.join(cfg.lakeDir, `stream=${stream}`, 'dt=2026-10-10', `workspace=${id}`);
        fs.mkdirSync(part, { recursive: true });
        fs.writeFileSync(path.join(part, 'part-0.parquet'), 'x');
      }
    }
    const { token } = issueToken(cfg.registryFile, { workspace: WORKSPACE });
    const keep = issueToken(cfg.registryFile, { workspace: other });
    try {
      const result = await deleteWorkspace(cfg, WORKSPACE, { now: NOW });
      expect(result).toMatchObject({ ok: true, victoriametrics: 'ok', loki: 'ok', tokensRevoked: 1 });
      expect(result.lake).toMatchObject({ partitionsRemoved: 2 });
      expect((result.lake as any).spoolRowsRemoved).toBeGreaterThan(10);

      const vmCall = sinks.calls.find((call) => call.url.startsWith('/api/v1/admin/tsdb/delete_series'))!;
      expect(decodeURIComponent(vmCall.url)).toContain(`match[]={workspace="${WORKSPACE}"}`);
      const lokiCall = sinks.calls.find((call) => call.url.startsWith('/loki/api/v1/delete'))!;
      expect(decodeURIComponent(lokiCall.url)).toContain(`query={workspace="${WORKSPACE}"}`);
      // Loki answers 400 "deletes in the future are not allowed" when end is after now (found on the first real smoke run).
      const lokiEnd = Number(new URL(lokiCall.url, 'http://x').searchParams.get('end'));
      expect(lokiEnd).toBeLessThanOrEqual(Math.floor(NOW / 1000));

      expect(fs.existsSync(path.join(cfg.lakeDir, 'stream=errors', 'dt=2026-10-10', `workspace=${WORKSPACE}`))).toBe(false);
      expect(fs.existsSync(path.join(cfg.lakeDir, 'stream=errors', 'dt=2026-10-10', `workspace=${other}`))).toBe(true);
      const spool = fs.readFileSync(spoolPath(cfg.lakeDir, NOW), 'utf8');
      expect(spool).not.toContain(WORKSPACE);
      expect(spool).toContain(other);

      const registry = createRegistry(cfg.registryFile);
      expect(registry.verify(token)).toBeNull();
      expect(registry.verify(keep.token)).not.toBeNull();

      const ledger = fs.readFileSync(cfg.deletionLog, 'utf8');
      expect(ledger).toContain(WORKSPACE);
      expect(ledger).not.toContain('"user');
    } finally {
      await sinks.close();
    }
  });

  it('reports a failed store, still clears the others, and refuses a malformed id', async () => {
    const cfg = config({ VM_URL: 'http://127.0.0.1:1', LOKI_URL: 'http://127.0.0.1:1' });
    const result = await deleteWorkspace(cfg, WORKSPACE, { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.victoriametrics).toMatch(/^failed/u);
    expect(result.lake).toMatchObject({ partitionsRemoved: 0 });
    await expect(deleteWorkspace(cfg, '{workspace=~".*"}')).rejects.toThrow('invalid workspace id');
  });

  it('drops partitions past each stream retention and keeps newer ones', async () => {
    const cfg = config();
    const mk = (stream: string, day: string) => {
      const part = path.join(cfg.lakeDir, `stream=${stream}`, `dt=${day}`, `workspace=${WORKSPACE}`);
      fs.mkdirSync(part, { recursive: true });
      fs.writeFileSync(path.join(part, 'p.parquet'), 'x');
    };
    const now = Date.parse('2026-11-30T12:00:00Z');
    const day = (n: number) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);
    mk('errors', day(31)); mk('errors', day(29));
    mk('status', day(91)); mk('status', day(89));
    mk('events', day(366)); mk('events', day(364));
    mk('reports_hourly', day(397)); mk('reports_hourly', day(395));
    const removed = await applyRetention(cfg, { now });
    expect(removed.sort()).toEqual([
      `stream=errors/dt=${day(31)}`, `stream=events/dt=${day(366)}`, `stream=reports_hourly/dt=${day(397)}`, `stream=status/dt=${day(91)}`,
    ].sort());
    expect(fs.existsSync(path.join(cfg.lakeDir, 'stream=errors', `dt=${day(29)}`))).toBe(true);
    expect(fs.existsSync(path.join(cfg.lakeDir, 'stream=reports_hourly', `dt=${day(395)}`))).toBe(true);
  });
});

const smallReport = (extra: Record<string, unknown> = {}) => validReport({ metrics: [], errors: [], events: [], ...extra });

describe('erasure cannot be undone by live ingestion', () => {
  it('refuses new reports for a workspace under deletion, even from a control-plane token, and keeps the marker after the purge', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url);
    const cp = issueToken(c.cfg.registryFile, { workspace: null });
    allowWorkspace(c.cfg, WORKSPACE);
    try {
      expect((await post(c.base, cp.token, smallReport())).status).toBe(200);
      const result = await deleteWorkspace(c.cfg, WORKSPACE, { fetchImpl: fetch, now: NOW });
      expect(result.ok).toBe(true);
      expect(isDeleting(c.cfg, WORKSPACE)).toBe(true);
      expect(readMarker(c.cfg, WORKSPACE)).toMatchObject({ backups: 'pending', storesPurgedAt: NOW });
      const again = await post(c.base, cp.token, smallReport({ hour: HOUR - 3600_000 }));
      expect(again.status).toBe(410);
      expect(listSpool(c.cfg.lakeDir).length).toBe(1);
      expect(fs.readFileSync(spoolPath(c.cfg.lakeDir, NOW), 'utf8')).not.toContain(WORKSPACE);
      expect(listMarkers(c.cfg).map((m: any) => m.workspace)).toEqual([WORKSPACE]);
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('drops queued sink items of a workspace once its deletion marker exists', async () => {
    const sinks = await fakeSinks();
    sinks.failFor(300);
    const c = await startCollector(sinks.url);
    const { token } = issueToken(c.cfg.registryFile, { workspace: WORKSPACE });
    try {
      expect((await (await post(c.base, token, validReport())).json()).sinks).toEqual({ vm: 'queued', loki: 'queued' });
      const { markDeleting } = await import('../telemetry-collector/src/state.mjs');
      markDeleting(c.cfg, WORKSPACE, NOW);
      const deadline = Date.now() + 5000;
      while (c.sinks.queueLength > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
      expect(c.sinks.queueLength).toBe(0);
      expect(c.sinks.stats.delivered).toEqual({ vm: 0, loki: 0 });
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('waits for in-flight requests before purging when it created the marker', async () => {
    const cfg = config({ COLLECTOR_DELETE_WAIT_MS: '300', VM_URL: 'http://127.0.0.1:1', LOKI_URL: 'http://127.0.0.1:1' });
    // Count the 300 ms waits instead of timing the calls: an upper bound on elapsed time fails on a slow runner (it measured 291 ms against 250 on Windows).
    const waits = vi.spyOn(globalThis, 'setTimeout');
    const started = Date.now();
    await deleteWorkspace(cfg, WORKSPACE, { now: NOW });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(waits.mock.calls.filter(([, ms]) => ms === 300)).toHaveLength(1);
    waits.mockClear();
    const retry = await deleteWorkspace(cfg, WORKSPACE, { now: NOW });
    expect(waits.mock.calls.filter(([, ms]) => ms === 300)).toHaveLength(0); // the marker exists, so the second call does not wait again
    waits.mockRestore();
    expect(retry.ok).toBe(false); // the stores are unreachable, so the caller must retry; the marker still blocks writes
    expect(isDeleting(cfg, WORKSPACE)).toBe(true);
  });
});

describe('control-plane tokens and rate limits', () => {
  it('lets a control-plane token write only allowlisted workspaces and fails closed without a list', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url);
    const cp = issueToken(c.cfg.registryFile, { workspace: null });
    try {
      expect((await post(c.base, cp.token, smallReport())).status).toBe(403);
      allowWorkspace(c.cfg, 'ws_someoneelse1');
      expect((await post(c.base, cp.token, smallReport())).status).toBe(403);
      allowWorkspace(c.cfg, WORKSPACE);
      expect((await post(c.base, cp.token, smallReport())).status).toBe(200);
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('limits per workspace after validation, and fleet-wide', async () => {
    const sinks = await fakeSinks();
    const c = await startCollector(sinks.url, { COLLECTOR_RATE_PER_HOUR: '2', COLLECTOR_FLEET_RATE_PER_HOUR: '3' });
    const cp = issueToken(c.cfg.registryFile, { workspace: null });
    const other = 'ws_other0123456';
    allowWorkspace(c.cfg, WORKSPACE);
    allowWorkspace(c.cfg, other);
    try {
      const at = (h: number, ws = WORKSPACE) => post(c.base, cp.token, smallReport({ hour: HOUR - h * 3600_000, workspace: ws }));
      expect((await at(0)).status).toBe(200);
      expect((await at(1)).status).toBe(200);
      expect(await (await at(2)).json()).toMatchObject({ error: 'rate_limited' });
      expect((await at(0, other)).status).toBe(200);
      expect(await (await at(1, other)).json()).toMatchObject({ error: 'fleet_rate_limited' });
    } finally {
      await c.close();
      await sinks.close();
    }
  });

  it('caps the limiter memory even when every key is active', () => {
    const limiter = createLimiter({ limit: 5, windowMs: 1e9, maxKeys: 3 });
    for (let i = 0; i < 50; i++) limiter.hit(`k${i}`, i);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});

describe('replay protection survives a restart', () => {
  it('refuses the same workspace and hour after the collector is restarted, and frees it when the spool write fails', async () => {
    const sinks = await fakeSinks();
    const first = await startCollector(sinks.url);
    const { token } = issueToken(first.cfg.registryFile, { workspace: WORKSPACE });
    expect((await post(first.base, token, smallReport())).status).toBe(200);
    await first.close();
    const second = await startCollector(sinks.url);
    try {
      expect((await post(second.base, token, smallReport())).status).toBe(409);
      expect(claimHour(second.cfg, WORKSPACE, HOUR - 3600_000)).toBe(true);
      expect(claimHour(second.cfg, WORKSPACE, HOUR - 3600_000)).toBe(false);
    } finally {
      await second.close();
      await sinks.close();
    }
  });
});
