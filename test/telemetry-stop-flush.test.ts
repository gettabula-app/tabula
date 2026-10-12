import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubReport } from '../server/telemetry/scrub.mjs';
import { isWindows } from './platform';
import { startRelayProcess } from './start-relay';

// A hosted machine that stops between hours (Fly autostop) must not lose the running hour: on SIGTERM the relay writes it to
// telemetry-last.json, and the next start hands it over once its hour has ended. Real child processes, real signals, a shifted wall clock.

const TOKEN = 't'.repeat(40);
const HOUR = 3_600_000;
const SHIFT = path.resolve('test/shift-clock.cjs');
const procs: ChildProcess[] = [];
const dirs: string[] = [];

async function launch(dir: string, shiftMs: number, env: Record<string, string> = {}) {
  const { proc, port } = await startRelayProcess({
    envFor: (p) => ({
      ...(process.env as Record<string, string>),
      PORT: String(p), HOST: '127.0.0.1', DATA_DIR: dir, TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.test', TABULA_MAIL: 'file',
      TABULA_BASE_URL: `http://127.0.0.1:${p}`, TABULA_SKIP_DOTENV: '1',
      TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: 'http://127.0.0.1:9', TABULA_CLOUD_WORKSPACE_ID: 'ws_stopflush01',
      SHIFT_MS: String(shiftMs), NODE_OPTIONS: `--require ${SHIFT}`,
      ...env,
    }),
  });
  procs.push(proc);
  const pull = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/telemetry`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { proc, port, pull };
}

const stop = (proc: ChildProcess) => new Promise<{ code: number | null; ms: number }>((resolve) => {
  const started = Date.now();
  proc.once('exit', (code) => resolve({ code, ms: Date.now() - started }));
  proc.kill('SIGTERM');
});

afterEach(async () => {
  // every relay is gone (and its files closed) before its directory is removed: Windows refuses otherwise
  await Promise.all(procs.splice(0).map((p) => new Promise<void>((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    p.once('exit', () => resolve());
    p.kill('SIGKILL');
  })));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// Windows has no SIGTERM handler for a child: kill() is a hard stop (TerminateProcess), so no graceful flush can run there. The hosted
// machines are Linux, where Fly sends SIGTERM/SIGINT; the in-process flush is covered on every platform in telemetry-internal-route.test.ts.
describe.skipIf(isWindows)('a hosted relay that is stopped with SIGTERM', () => {
  it('writes the running hour to telemetry-last.json without delaying the stop, and the next start hands it over after the hour', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-stopflush-'));
    dirs.push(dir);
    // start in the middle of an hour, with the clock moved so the test also knows which hour it is
    const real = Date.now();
    const middle = Math.floor((real + 5 * HOUR) / HOUR) * HOUR + 20 * 60_000;
    const first = await launch(dir, middle - real);
    expect((await first.pull()).body.error).toBe('no_report_yet');
    const stopped = await stop(first.proc);
    expect(stopped.code).toBe(0);
    expect(stopped.ms).toBeLessThan(5_000);
    const file = path.join(dir, 'telemetry-last.json');
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hour = middle - (middle % HOUR);
    expect(report).toMatchObject({ schema: 1, hour, workspace: 'ws_stopflush01', mode: 'hosted' });
    expect(scrubReport(report).clean).toEqual(report);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.stringify(report)).not.toContain('owner@example.test');
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('telemetry-last'))).toEqual(['telemetry-last.json']);

    // woken 100 minutes later (the next hour is over): the stored hour is handed over, the same document on every call
    const second = await launch(dir, middle + 100 * 60_000 - Date.now());
    const one = await second.pull();
    expect([one.status, one.body.hour]).toEqual([200, hour]);
    expect(one.body).toEqual(report);
    expect((await second.pull()).body).toEqual(report);
    await stop(second.proc);
    // a stop in the later hour does not replace anything the control plane could still need: the newest hour wins, and it is that one
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hour).toBeGreaterThanOrEqual(hour);

    // woken after the 72 hours: nothing is handed out
    const third = await launch(dir, middle + 80 * HOUR - Date.now(), { TABULA_TELEMETRY: 'on' });
    const late = await third.pull();
    expect(late.status).toBe(503);
  }, 90_000);

  it('does not flush when the operator turned collection off, and leaves no file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-stopflush-'));
    dirs.push(dir);
    const r = await launch(dir, 0, { TABULA_TELEMETRY: 'off' });
    expect((await stop(r.proc)).code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'telemetry-last.json'))).toBe(false);
  }, 60_000);
});
