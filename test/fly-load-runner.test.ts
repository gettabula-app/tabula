import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { makeFlyLoadGoPhrase, makeFlyLoadPlan } from '../scripts/lib/fly-load-plan.mjs';
import { renderFlyLoadDryRun, runFlyLoad } from '../scripts/lib/fly-load-runner.mjs';

const plan = makeFlyLoadPlan({ now: Date.now(), slug: 'tab227-load-test' });
const ownerCookie = 'sid=fake-owner-cookie-secret';
const ownerToken = 'fake-login-token-secret';
const adminToken = 'fake-admin-bearer-secret';
const ownerEmail = 'fake-owner-private@example.test';

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    FLY_LOAD_GO: makeFlyLoadGoPhrase(plan.slug),
    FLY_LOAD_OWNER_EMAIL: ownerEmail,
    ADMIN_URL: 'https://admin.example.test',
    ADMIN_TOKEN: adminToken,
    TARGET_COOKIES: ownerCookie,
    TARGET_LOGIN_TOKENS: ownerToken,
    ...overrides,
  };
}

function adminClient() {
  const calls: Array<[string, string]> = [];
  const client = {
    async request(method: string, route: string) {
      calls.push([method, route]);
      if (method === 'POST' && route === '/admin/workspaces/comp') return { status: 201, body: { workspaceId: 'workspace-123' } };
      if (method === 'GET' && route === '/admin/workspaces/workspace-123') {
        const deletes = calls.filter(([calledMethod, calledRoute]) => calledMethod === 'POST' && calledRoute.endsWith('/delete')).length;
        return deletes ? { status: 404, body: undefined } : { status: 200, body: { workspace: { id: 'workspace-123', state: 'active' } } };
      }
      if (method === 'POST' && route === '/admin/workspaces/workspace-123/delete') return { status: 202, body: { ok: true } };
      throw new Error(`unexpected admin call ${method} ${route}`);
    },
  };
  return { client, calls };
}

function loadReport() {
  return {
    steps: [30, 60, 100].map((users) => ({
      users,
      connectedUsers: users,
      syncLatencyMs: { p50: 2, p95: 20, max: 100 },
      joinMs: { p95: 150 },
      errors: { websocketErrors: 0 },
      relayExit: null,
      verdict: 'OK',
    })),
  };
}

describe('Fly load orchestration', () => {
  it('prints the full default plan and makes zero calls in dry-run mode', async () => {
    const request = vi.fn<() => Promise<never>>(async () => { throw new Error('dry run called the network client'); });
    const runLoadClass = vi.fn<() => Promise<never>>(async () => { throw new Error('dry run started the child process'); });
    const output: string[] = [];
    const env = baseEnv({ FLY_LOAD_GO: 'incorrect phrase' });
    const result = await runFlyLoad({
      plan,
      env,
      client: { request },
      runLoadClass,
      output: (line: string) => output.push(line),
    });
    const printed = output.join('\n');
    expect(result.dryRun).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(runLoadClass).not.toHaveBeenCalled();
    expect(printed).toContain('POST https://admin.example.test/admin/workspaces/comp');
    expect(printed).toContain('shared-cpu-1x (512 MB)');
    expect(printed).toContain('performance-1x (1024 MB)');
    expect(printed).toContain('performance-2x (2048 MB)');
    expect(printed).toContain('180 total minutes');
    for (const secret of [ownerCookie, ownerToken, adminToken, ownerEmail]) expect(printed).not.toContain(secret);
  });

  it('redacts secrets from every printed string while collecting one report', async () => {
    const { client } = adminClient();
    const output: string[] = [];
    let captured: any;
    const childCredentials: Array<{ cookies?: string; tokens?: string }> = [];
    const result = await runFlyLoad({
      plan,
      env: baseEnv(),
      client,
      output: (line: string) => output.push(line),
      runLoadClass: async ({ onOutput, env: childEnv }: { onOutput: (line: string) => void; env: Record<string, string> }) => {
        childCredentials.push({ cookies: childEnv.TARGET_COOKIES, tokens: childEnv.TARGET_LOGIN_TOKENS });
        onOutput(`${adminToken} ${ownerCookie} ${ownerToken} ${ownerEmail}`);
        if (!fs.existsSync(childEnv.TARGET_SESSION_OUT)) fs.writeFileSync(childEnv.TARGET_SESSION_OUT, JSON.stringify([ownerCookie]));
      },
      readLoadReport: async () => loadReport(),
      collectMetrics: async () => ({
        30: { cpuSustainedPct: 20, relayRssMb: 80 },
        60: { cpuSustainedPct: 35, relayRssMb: 160 },
        100: { cpuSustainedPct: 68, relayRssMb: 250 },
      }),
      manualCheckpoint: async () => {},
      writeReport: async (_paths: unknown, report: unknown, markdown: string) => { captured = { report, markdown }; },
      timing: { pollIntervalMs: 0, cleanupTimeoutMs: 1000 },
    });
    const printed = output.join('\n');
    for (const secret of [ownerCookie, ownerToken, adminToken, ownerEmail]) expect(printed).not.toContain(secret);
    expect(result.teardown?.verified).toBe(true);
    expect(result.evaluation?.recommendation).toBe('shared-cpu-1x');
    expect(childCredentials[0].tokens).toBe(ownerToken);
    expect(childCredentials.slice(1)).toEqual([
      { cookies: ownerCookie, tokens: undefined },
      { cookies: ownerCookie, tokens: undefined },
    ]);
    expect(captured.markdown).toContain('| shared-cpu-1x | 100 |');
    expect(JSON.stringify(captured.report)).not.toContain(ownerCookie);
    expect(JSON.stringify(captured.report)).not.toContain(ownerToken);
  });

  it('runs workspace teardown and verifies it when a load child fails', async () => {
    const { client, calls } = adminClient();
    const output: string[] = [];
    await expect(runFlyLoad({
      plan,
      env: baseEnv(),
      client,
      output: (line: string) => output.push(line),
      runLoadClass: async () => { throw new Error('synthetic load failure'); },
      writeReport: async () => {},
      timing: { pollIntervalMs: 0, cleanupTimeoutMs: 1000 },
    })).rejects.toThrow('synthetic load failure');
    expect(calls).toContainEqual(['POST', '/admin/workspaces/workspace-123/delete']);
    expect(calls).toContainEqual(['GET', '/admin/workspaces/workspace-123']);
    expect(output.some((line) => line.includes('Workspace teardown verified'))).toBe(true);
  });

  it('runs teardown and verifies it when the run is aborted at an operator checkpoint', async () => {
    const { client, calls } = adminClient();
    const abort = new AbortController();
    await expect(runFlyLoad({
      plan,
      env: baseEnv(),
      client,
      signal: abort.signal,
      manualCheckpoint: async () => { abort.abort(new Error('operator cancelled')); },
      runLoadClass: async () => { throw new Error('child should not start after abort'); },
      writeReport: async () => {},
      timing: { pollIntervalMs: 0, cleanupTimeoutMs: 1000 },
    })).rejects.toThrow('operator cancelled');
    expect(calls).toContainEqual(['POST', '/admin/workspaces/workspace-123/delete']);
    expect(calls).toContainEqual(['GET', '/admin/workspaces/workspace-123']);
  });

  it('documents the exact creation and deletion calls in the dry-run output', () => {
    const output = renderFlyLoadDryRun(plan, baseEnv());
    expect(output).toContain('POST https://admin.example.test/admin/workspaces/comp');
    expect(output).toContain('POST https://admin.example.test/admin/workspaces/<workspaceId>/delete');
    expect(output).toContain('GET  https://admin.example.test/admin/workspaces/<workspaceId> until 404 or state=deleted');
    expect(output).not.toContain(adminToken);
  });
});
