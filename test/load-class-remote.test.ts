import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness } from './mcp-harness';

function runRemoteLoad(env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/load-class.mjs'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        TMPDIR: os.tmpdir(),
        TEMP: os.tmpdir(),
        ...env,
        LOAD_CLASS_ALLOW_BUSY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 75_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('remote class load script', () => {
  it('runs against a local accounts relay with a cookie and a one-time login token without printing either secret', async () => {
    const harness = createHarness({ accounts: true, settings: { CHAT: 'off' } });
    await harness.start();
    try {
      const owner = await harness.signInOwner();
      const cookieOut = path.join(harness.dir, 'remote-cookie.json');
      const cookieRun = await runRemoteLoad({
        TARGET_URL: harness.base,
        TARGET_CONFIRM: '127.0.0.1',
        TARGET_COOKIES: owner.cookie,
        USERS: '3',
        SECONDS: '2',
        LOAD_CLASS_BURST_MS: '500',
        LOAD_CLASS_SEED_SETTLE_MS: '0',
        LOAD_CLASS_RESULT_SETTLE_MS: '0',
        LOAD_CLASS_SAMPLE_INTERVAL_MS: '100',
        CHAT: 'off',
        OUT: cookieOut,
      });
      expect(cookieRun.code, `${cookieRun.stdout}\n${cookieRun.stderr}`).toBe(0);
      expect(cookieRun.stdout).toContain('1 account(s) for 3 users');
      expect(cookieRun.stdout).toContain('after a 0.5 second join burst');
      expect(cookieRun.stdout).toContain('| n/a | n/a |');
      expect(cookieRun.stdout).toContain('relay CPU and memory: read them from Fly (see docs/capacity.md)');
      // latency decides OK or DEGRADED and a loaded CI runner (generator lag over 50 ms) turns OK into DEGRADED, so this test proves the
      // behaviour: the step completed, all users connected, nothing failed. FAILING is the only verdict that would be a defect here.
      expect(cookieRun.stdout).toMatch(/3 users: (OK|DEGRADED)/);
      expect(cookieRun.stdout).not.toContain('FAILING');
      expect(cookieRun.stdout).toContain('(includes network round trips)');
      const cookieReportText = fs.readFileSync(cookieOut, 'utf8');
      const cookieReport = JSON.parse(cookieReportText);
      expect(cookieReport.target).toEqual({ host: '127.0.0.1', remote: true, accounts: 1, usersPerAccount: 3 });
      expect(cookieReport.host).toEqual(expect.objectContaining({ loadStart: expect.any(Number), loadEnd: expect.any(Number), cpus: expect.any(Number), level: expect.any(String) }));
      expect(cookieReport.trustworthy).toBeTypeOf('boolean');
      expect(cookieReport.steps[0].connectedUsers).toBe(3);
      expect(cookieReport.steps[0].verdict).toMatch(/^(OK|DEGRADED)/);
      expect(Object.values(cookieReport.steps[0].errors as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
      expect(cookieReport.steps[0].joinBurstSeconds).toBe(0.5);
      expect(cookieReport.configuration.joinBurstSeconds).toBe(0.5);
      expect(cookieReport.steps[0].relay).toEqual({
        rssPeakBytes: null,
        rssEndBytes: null,
        cpuAveragePct: null,
        cpuPeak5sPct: null,
        samples: 0,
      });
      expect(`${cookieRun.stdout}\n${cookieRun.stderr}\n${cookieReportText}`).not.toContain(owner.cookie);
      const boardsAfterCookieRun = await harness.api(owner.cookie, 'GET', '/api/boards');
      expect(boardsAfterCookieRun.body.some((board: { id: string }) => board.id === cookieReport.steps[0].boardId)).toBe(false);

      const beforeMail = harness.mails().length;
      const requested = await harness.api(undefined, 'POST', '/api/auth/request', { email: owner.email }, { 'x-forwarded-for': harness.nextIp() });
      expect(requested.status).toBe(200);
      const freshMail = harness.mails().slice(beforeMail);
      expect(freshMail).toHaveLength(1);
      const tokenMatch = /token=([^\s&]+)/.exec(freshMail[0].text);
      expect(tokenMatch).not.toBeNull();
      const token = tokenMatch![1];
      const tokenOut = path.join(harness.dir, 'remote-token.json');
      const tokenRun = await runRemoteLoad({
        TARGET_URL: harness.base,
        TARGET_CONFIRM: '127.0.0.1',
        TARGET_LOGIN_TOKENS: token,
        USERS: '1',
        SECONDS: '2',
        LOAD_CLASS_BURST_MS: '500',
        LOAD_CLASS_SEED_SETTLE_MS: '0',
        LOAD_CLASS_RESULT_SETTLE_MS: '0',
        LOAD_CLASS_SAMPLE_INTERVAL_MS: '100',
        CHAT: 'off',
        OUT: tokenOut,
      });
      expect(tokenRun.code, `${tokenRun.stdout}\n${tokenRun.stderr}`).toBe(0);
      expect(tokenRun.stdout).toMatch(/1 users: (OK|DEGRADED)/);
      expect(tokenRun.stdout).not.toContain('FAILING');
      const tokenReportText = fs.readFileSync(tokenOut, 'utf8');
      const tokenReport = JSON.parse(tokenReportText);
      expect(tokenReport.target).toEqual({ host: '127.0.0.1', remote: true, accounts: 1, usersPerAccount: 1 });
      expect(tokenReport.steps[0].verdict).toMatch(/^(OK|DEGRADED)/);
      expect(Object.values(tokenReport.steps[0].errors as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
      expect(tokenReport.configuration.joinBurstSeconds).toBe(0.5);
      expect(`${tokenRun.stdout}\n${tokenRun.stderr}\n${tokenReportText}`).not.toContain(owner.cookie);
      expect(`${tokenRun.stdout}\n${tokenRun.stderr}\n${tokenReportText}`).not.toContain(token);
    } finally {
      await harness.cleanup();
    }
  }, 120_000);
});
