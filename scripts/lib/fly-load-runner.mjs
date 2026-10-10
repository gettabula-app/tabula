import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { errorCount } from './load-class-stats.mjs';
import { createFlyLoadAdminClient } from './fly-load-client.mjs';
import { evaluateFlyLoadPassRule, hasFlyLoadGoPhrase, makeFlyLoadGoPhrase } from './fly-load-plan.mjs';

const PROVISION_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const LOAD_SCRIPT = fileURLToPath(new URL('../load-class.mjs', import.meta.url));

const formatIso = (stamp) => new Date(stamp).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function flyLoadOutputPaths(plan, env = process.env, { cwd = process.cwd(), tempDir = os.tmpdir() } = {}) {
  const jsonPath = env.FLY_LOAD_OUT
    ? path.resolve(cwd, env.FLY_LOAD_OUT)
    : path.join(tempDir, `tabula-fly-load-${plan.slug}.json`);
  if (!/\.json$/i.test(jsonPath)) throw new Error('FLY_LOAD_OUT must name a .json report file');
  const mdPath = jsonPath.replace(/\.json$/i, '.md');
  return { jsonPath, mdPath };
}

function secretsFromEnv(env) {
  const secrets = [env.ADMIN_TOKEN, env.TARGET_COOKIES, env.TARGET_LOGIN_TOKENS, env.FLY_LOAD_OWNER_EMAIL];
  for (const key of ['TARGET_COOKIES', 'TARGET_LOGIN_TOKENS']) {
    if (env[key]) secrets.push(...String(env[key]).split(',').map((value) => value.trim()));
  }
  return [...new Set(secrets.filter((value) => typeof value === 'string' && value.length > 0))];
}

export function redactFlyLoadText(value, secrets = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  }
  return text;
}

function adminUrlForDisplay(value) {
  if (!value) return '<ADMIN_URL required for a real run>';
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return '[ADMIN_URL redacted]';
    return url.origin;
  } catch {
    return '[ADMIN_URL redacted]';
  }
}

export function renderFlyLoadDryRun(plan, env = process.env, paths = flyLoadOutputPaths(plan, env)) {
  const adminBase = adminUrlForDisplay(env.ADMIN_URL);
  const ownerEmail = env.FLY_LOAD_OWNER_EMAIL ? '[REDACTED]' : '<FLY_LOAD_OWNER_EMAIL required>';
  const expiry = formatIso(plan.workspaceExpiresAt);
  const sizeLines = plan.sizes.map((size, index) => {
    const stepReportPath = path.join(os.tmpdir(), `tabula-fly-load-${plan.slug}-${size.id}.json`);
    const nextAction = index === 0
      ? `Verify the workspace machine is ${size.machineSize} / ${size.memoryMb} MB in the Fly dashboard.`
      : `Manually change the workspace machine to ${size.machineSize} / ${size.memoryMb} MB and verify it in the Fly dashboard.`;
    return [
      `\n${index + 1}. ${size.machineSize} (${size.memoryMb} MB)`,
      `   Manual checkpoint: ${nextAction}`,
      `   Command:`,
      `   TARGET_URL=${plan.targetUrl} TARGET_CONFIRM=${plan.targetHost} TARGET_COOKIES='[REDACTED]' TARGET_LOGIN_TOKENS='[REDACTED]' USERS=${plan.userSteps.join(',')} SECONDS=${plan.secondsPerStep} OUT=${stepReportPath} node scripts/load-class.mjs`,
      `   Read the load-class report JSON, then enter Fly CPU/memory and relay process CPU/RSS for users ${plan.userSteps.join(', ')}.`,
    ].join('\n');
  });
  return [
    'FLY LOAD RUN PLAN (DRY RUN — no requests will be made)',
    `Workspace slug: ${plan.slug}`,
    `Target: ${plan.targetUrl}`,
    `Owner email: ${ownerEmail}`,
    `Region: ${plan.region}; seats: ${plan.seats}`,
    `One go phrase for a real run: FLY_LOAD_GO=${makeFlyLoadGoPhrase(plan.slug)}`,
    `Admin base: ${adminBase}`,
    'Admin API calls the real run would make (Authorization: Bearer [REDACTED]):',
    `  POST ${adminBase}/admin/workspaces/comp { slug: "${plan.slug}", name: "${plan.workspaceName}", ownerEmail: "[REDACTED]", region: "${plan.region}", seats: ${plan.seats}, expiresAt: ${expiry}, note: "TAB-227 load test; delete after" }`,
    `  GET  ${adminBase}/admin/workspaces/<workspaceId> every 5 s until state=active (up to 15 min)`,
    `  GET  ${adminBase}/admin/workspaces?plan=comp only if create returns no id; match slug ${plan.slug}`, 
    `  POST ${adminBase}/admin/workspaces/<workspaceId>/delete in finally`,
    `  GET  ${adminBase}/admin/workspaces/<workspaceId> until 404 or state=deleted (verify teardown)`,
    'No documented comp admin route resizes machines, and no documented machine metrics/exec route exists; those are manual checkpoints.',
    'Load harness commands (one child process per size):',
    ...sizeLines,
    `\nExpected harness activity: ${plan.estimated.measuredMinutes.toFixed(1)} minutes of user activity and join bursts, plus provisioning, manual checkpoints, and cleanup.`,
    `Hard cap: ${plan.maxTotalMinutes} total minutes from plan start; workspace expiry is ${expiry} (now + 3 h).`,
    `Machine bound: one workspace machine for at most ${plan.maxTotalMinutes} machine-minutes, resized through the ladder. Comp expiry stops it after 3 h; if deletion fails, the 1 GB volume may remain until the control plane's 30-day deletion schedule. Dollar cost depends on Fly region and size rates.`,
    `Report after a real run: ${paths.jsonPath} and ${paths.mdPath}`,
    'The operator-supplied sessions, ADMIN_TOKEN, and FLY_LOAD_OWNER_EMAIL are never included in this plan.',
  ].join('\n');
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Fly load run aborted');
}

function statusError(action, status) {
  return new Error(`${action} returned HTTP ${status}`);
}

async function api(client, method, route, body, signal) {
  assertNotAborted(signal);
  const response = await client.request(method, route, body, signal ? { signal } : {});
  if (!response || !Number.isInteger(response.status)) throw new Error('Admin API client returned an invalid response');
  return response;
}

function workspacePayload(body) {
  return body?.workspace ?? body?.data?.workspace ?? body?.data ?? body;
}

function workspaceIdFrom(body) {
  return body?.workspaceId ?? body?.id ?? body?.workspace?.id ?? body?.workspace?.workspaceId ?? null;
}

function workspacesFrom(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.workspaces)) return body.workspaces;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.workspaces)) return body.data.workspaces;
  return [];
}

async function findWorkspaceIdBySlug(client, slug) {
  const response = await client.request('GET', '/admin/workspaces?plan=comp');
  if (response.status !== 200) return null;
  const workspace = workspacesFrom(response.body).find((item) => item?.slug === slug);
  return workspace?.id ?? workspace?.workspaceId ?? null;
}

async function waitForActive({ client, workspaceId, signal, now, wait, timing, plan }) {
  const timeoutAt = Math.min(now() + timing.provisionTimeoutMs, plan.workspaceExpiresAt - timing.cleanupTimeoutMs);
  while (now() < timeoutAt) {
    assertNotAborted(signal);
    const response = await api(client, 'GET', `/admin/workspaces/${encodeURIComponent(workspaceId)}`, undefined, signal);
    if (response.status === 200) {
      const workspace = workspacePayload(response.body);
      if (workspace?.state === 'active') return workspace;
      if (['failed', 'suspended', 'deleting', 'deleted'].includes(workspace?.state)) {
        throw new Error(`Comp workspace entered state ${workspace.state} before becoming active`);
      }
    } else if (response.status !== 404) {
      throw statusError('Workspace readiness check', response.status);
    }
    await wait(Math.min(timing.pollIntervalMs, Math.max(0, timeoutAt - now())), signal);
  }
  throw new Error('Timed out waiting for the comp workspace to become active');
}

function loadEnvForChild(env, plan, outPath) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('FLY_LOAD_') || key === 'ADMIN_URL' || key === 'ADMIN_TOKEN' || key === 'TARGET_DRY_RUN') delete childEnv[key];
  }
  childEnv.TARGET_URL = plan.targetUrl;
  childEnv.TARGET_CONFIRM = plan.targetHost;
  childEnv.TARGET_ALLOW_HOST = plan.targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  childEnv.USERS = plan.userSteps.join(',');
  childEnv.SECONDS = String(plan.secondsPerStep);
  childEnv.OUT = outPath;
  delete childEnv.CHAT;
  return childEnv;
}

export function runFlyLoadClassChild({ plan, size, outPath, env = process.env, signal, onOutput = () => {} }) {
  assertNotAborted(signal);
  const child = spawn(process.execPath, [LOAD_SCRIPT], {
    cwd: process.cwd(),
    env: loadEnvForChild(env, plan, outPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const outputBuffers = { stdout: '', stderr: '' };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const forward = (kind, chunk) => {
      outputBuffers[kind] += String(chunk);
      const lines = outputBuffers[kind].split(/\r?\n/);
      outputBuffers[kind] = lines.pop() ?? '';
      for (const line of lines) if (line) onOutput(line);
    };
    const abort = () => {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref?.();
    };
    child.stdout.on('data', (chunk) => forward('stdout', chunk));
    child.stderr.on('data', (chunk) => forward('stderr', chunk));
    child.once('error', (error) => finish(error));
    child.once('close', (code, childSignal) => {
      for (const kind of ['stdout', 'stderr']) if (outputBuffers[kind]) onOutput(outputBuffers[kind]);
      if (signal?.aborted) finish(signal.reason instanceof Error ? signal.reason : new Error('Fly load run aborted'));
      else if (code !== 0) finish(new Error(`load-class exited for ${size.id} (${code ?? childSignal})`));
      else finish();
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function numericMetric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Manual metrics must be non-negative numbers or blank');
  return number;
}

function normalizedRows(size, report, metrics) {
  if (!Array.isArray(report?.steps)) throw new Error(`load-class report for ${size.id} has no steps array`);
  return report.steps.map((step) => {
    const captured = metrics?.[step.users] ?? metrics?.[String(step.users)] ?? {};
    const errors = errorCount(step.errors, step.relayExit);
    return {
      sizeId: size.id,
      machineSize: size.machineSize,
      memoryMb: size.memoryMb,
      users: step.users,
      syncP50Ms: step.syncLatencyMs?.p50 ?? null,
      syncP95Ms: step.syncLatencyMs?.p95 ?? null,
      syncMaxMs: step.syncLatencyMs?.max ?? null,
      joinP95Ms: step.joinMs?.p95 ?? null,
      errors,
      loadClassVerdict: step.verdict ?? null,
      cpuSustainedPct: numericMetric(captured.cpuSustainedPct),
      flyCpuSustainedPct: numericMetric(captured.flyCpuSustainedPct ?? captured.cpuSustainedPct),
      flyMemoryUsedMb: numericMetric(captured.flyMemoryUsedMb),
      relayCpuSustainedPct: numericMetric(captured.relayCpuSustainedPct),
      relayRssMb: numericMetric(captured.relayRssMb),
      generatorLagP95Ms: step.generatorLagMs?.p95 ?? null,
      connectedUsers: step.connectedUsers ?? null,
    };
  });
}

function metricText(value, suffix = '') {
  return Number.isFinite(value) ? `${Number(value.toFixed(1))}${suffix}` : 'not recorded';
}

export function renderFlyLoadMarkdown(report) {
  const lines = [
    '# TAB-227 Fly capacity run',
    '',
    `- Workspace: \`${report.workspace.slug}\` (id \`${report.workspace.id ?? 'unknown'}\`)`,
    `- Region: ${report.workspace.region}`,
    `- Expiry: ${report.workspace.expiresAt}`,
    `- Teardown verified: ${report.teardown?.verified ? 'yes' : 'no'}`,
    '',
    '| Size | Users | Sync p50 / p95 / max | Join p95 | Errors | Peak RSS | CPU | Verdict |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of report.rows ?? []) {
    const sync = [row.syncP50Ms, row.syncP95Ms, row.syncMaxMs].map((value) => metricText(value, ' ms')).join(' / ');
    const rss = Number.isFinite(row.relayRssMb)
      ? `${metricText(row.relayRssMb, ' MB')} / ${row.memoryMb} MB (${metricText(row.relayRssMb / row.memoryMb * 100, '%')})`
      : 'not recorded';
    const cpu = `${metricText(row.flyCpuSustainedPct ?? row.cpuSustainedPct, '%')} Fly / ${metricText(row.relayCpuSustainedPct, '%')} relay`;
    lines.push(`| ${row.machineSize} | ${row.users} | ${sync} | ${metricText(row.joinP95Ms, ' ms')} | ${row.errors} | ${rss} | ${cpu} | ${row.loadClassVerdict ?? 'unknown'} |`);
  }
  lines.push('', `**Recommendation:** ${report.evaluation?.recommendation ?? 'none met the pass rule'}`, '');
  lines.push('Pass rule for 100 users: load-class verdict `OK`, sustained Fly CPU under 70%, and relay RSS under 70% of configured memory.', '');
  lines.push(`**Teardown:** ${report.teardown?.verified ? 'verified' : 'not verified'}${report.teardown?.detail ? ` — ${report.teardown.detail}` : ''}`, '');
  return `${lines.join('\n')}\n`;
}

function manualCleanupText(adminBase, workspaceId, slug) {
  if (workspaceId) {
    return `Manual cleanup if needed: POST ${adminBase}/admin/workspaces/${encodeURIComponent(workspaceId)}/delete with Authorization: Bearer ADMIN_TOKEN; then GET ${adminBase}/admin/workspaces/${encodeURIComponent(workspaceId)} until 404 or state=deleted.`;
  }
  return `No workspace id was confirmed. Check GET ${adminBase}/admin/workspaces?plan=comp for slug ${slug}, then POST /admin/workspaces/<id>/delete and verify with GET /admin/workspaces/<id>.`;
}

async function teardownWorkspace({ client, plan, workspaceId, timing, now, wait, adminBase }) {
  const deadline = now() + timing.cleanupTimeoutMs;
  let deleteAccepted = false;
  let lastProblem = null;

  if (!workspaceId) {
    try { workspaceId = await findWorkspaceIdBySlug(client, plan.slug); } catch (error) { lastProblem = error; }
  }
  if (!workspaceId) {
    return { workspaceId: null, verified: false, detail: manualCleanupText(adminBase, null, plan.slug), error: lastProblem };
  }

  const route = `/admin/workspaces/${encodeURIComponent(workspaceId)}/delete`;
  while (now() < deadline && !deleteAccepted) {
    try {
      const response = await client.request('POST', route);
      if ([200, 202, 204, 404].includes(response.status)) deleteAccepted = true;
      else lastProblem = statusError('Workspace delete request', response.status);
    } catch (error) {
      lastProblem = error;
    }
    if (!deleteAccepted) await wait(Math.min(timing.pollIntervalMs, Math.max(0, deadline - now())));
  }

  while (now() < deadline) {
    try {
      const response = await client.request('GET', `/admin/workspaces/${encodeURIComponent(workspaceId)}`);
      if (response.status === 404 || (response.status === 200 && workspacePayload(response.body)?.state === 'deleted')) {
        return { workspaceId, verified: true, detail: 'admin detail returned 404 or state=deleted' };
      }
      if (response.status !== 200) lastProblem = statusError('Workspace teardown verification', response.status);
      else lastProblem = new Error(`workspace remains in state ${workspacePayload(response.body)?.state ?? 'unknown'}`);
    } catch (error) {
      lastProblem = error;
    }
    await wait(Math.min(timing.pollIntervalMs, Math.max(0, deadline - now())));
  }
  return { workspaceId, verified: false, detail: manualCleanupText(adminBase, workspaceId, plan.slug), error: lastProblem };
}

function validateRealRunEnv(env) {
  if (!env.ADMIN_URL) throw new Error('ADMIN_URL is required for a real Fly load run');
  if (!env.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is required for a real Fly load run');
  if (!env.FLY_LOAD_OWNER_EMAIL) throw new Error('FLY_LOAD_OWNER_EMAIL is required to create a comp workspace');
}

async function defaultWriteReport(paths, report, markdown) {
  fs.mkdirSync(path.dirname(paths.jsonPath), { recursive: true });
  fs.writeFileSync(paths.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(paths.mdPath, markdown);
}

/**
 * Orchestrates the admin API lifecycle and load-class children. Admin API calls, children, operator checkpoints,
 * time and report IO are injectable so tests never need a network host.
 * @param {{
 *   plan: any,
 *   env?: NodeJS.ProcessEnv,
 *   client?: { request: (method: string, route: string, body?: unknown, options?: { signal?: AbortSignal }) => Promise<any> },
 *   output?: (line: string) => void,
 *   runLoadClass?: (args: any) => Promise<void>,
 *   readLoadReport?: (reportPath: string, context?: any) => Promise<any> | any,
 *   manualCheckpoint?: (context: any) => Promise<void>,
 *   collectMetrics?: (context: any) => Promise<any>,
 *   getTargetSession?: (context: any) => Promise<Record<string, string>>,
 *   writeReport?: (paths: any, report: any, markdown: string) => Promise<void>,
 *   wait?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   now?: () => number,
 *   signal?: AbortSignal,
 *   timing?: Record<string, number>
 * }} options
 */
export async function runFlyLoad({
  plan,
  env = process.env,
  client: injectedClient,
  output = () => {},
  runLoadClass = runFlyLoadClassChild,
  readLoadReport = (reportPath) => JSON.parse(fs.readFileSync(reportPath, 'utf8')),
  manualCheckpoint = async () => {},
  collectMetrics = async () => ({}),
  getTargetSession = async ({ env }) => {
    if (env.TARGET_COOKIES || env.TARGET_LOGIN_TOKENS) return {};
    throw new Error('Provide the workspace owner session through TARGET_COOKIES or TARGET_LOGIN_TOKENS after the workspace becomes active');
  },
  writeReport = defaultWriteReport,
  wait = (ms) => sleep(ms),
  now = Date.now,
  signal: externalSignal,
  timing = {},
} = {}) {
  if (!plan) throw new Error('A fly load plan is required');
  const secrets = secretsFromEnv(env);
  const log = (line) => output(redactFlyLoadText(line, secrets));
  const paths = flyLoadOutputPaths(plan, env);

  if (!hasFlyLoadGoPhrase(env.FLY_LOAD_GO, plan.slug)) {
    log(renderFlyLoadDryRun(plan, env, paths));
    return { dryRun: true, paths };
  }

  validateRealRunEnv(env);
  const admin = new URL(env.ADMIN_URL);
  if (!['http:', 'https:'].includes(admin.protocol) || admin.username || admin.password || admin.search || admin.hash || !['', '/'].includes(admin.pathname)) {
    throw new Error('ADMIN_URL must be a bare HTTP(S) base URL without credentials, path, query, or fragment');
  }
  const client = injectedClient ?? createFlyLoadAdminClient({ baseUrl: env.ADMIN_URL, token: env.ADMIN_TOKEN });
  if (!client || typeof client.request !== 'function') throw new Error('An injectable admin API client is required');

  const settings = {
    provisionTimeoutMs: timing.provisionTimeoutMs ?? PROVISION_TIMEOUT_MS,
    cleanupTimeoutMs: timing.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
    pollIntervalMs: timing.pollIntervalMs ?? POLL_INTERVAL_MS,
  };
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(new Error(`Fly load run reached its ${plan.maxTotalMinutes}-minute cap`)), Math.max(0, plan.workspaceExpiresAt - now()));
  deadlineTimer.unref?.();
  const signal = externalSignal ? AbortSignal.any([externalSignal, deadlineController.signal]) : deadlineController.signal;
  let workspaceId = null;
  let primaryError = null;
  let cleanup = null;
  let sessionCacheDirectory = null;
  const rows = [];
  let activeWorkspace = null;

  try {
    assertNotAborted(signal);
    const createResponse = await api(client, 'POST', '/admin/workspaces/comp', {
      slug: plan.slug,
      name: plan.workspaceName,
      ownerEmail: env.FLY_LOAD_OWNER_EMAIL,
      region: plan.region,
      seats: plan.seats,
      expiresAt: plan.workspaceExpiresAt,
      note: 'TAB-227 load test; delete after',
    }, signal);
    if (createResponse.status !== 201) throw statusError('Comp workspace creation', createResponse.status);
    workspaceId = workspaceIdFrom(createResponse.body);
    if (!workspaceId) throw new Error('Comp workspace create response did not include workspaceId');
    log(`Created comp workspace ${plan.slug} (${workspaceId}); waiting for active state.`);
    activeWorkspace = await waitForActive({ client, workspaceId, signal, now, wait, timing: settings, plan });
    const sessionEnv = await getTargetSession({ plan, workspaceId, workspace: activeWorkspace, env, signal });
    if (!(env.TARGET_COOKIES || env.TARGET_LOGIN_TOKENS || sessionEnv?.TARGET_COOKIES || sessionEnv?.TARGET_LOGIN_TOKENS)) {
      throw new Error('Workspace owner session was not provided');
    }
    const childEnv = { ...env, ...sessionEnv };
    for (const secret of secretsFromEnv(childEnv)) if (!secrets.includes(secret)) secrets.push(secret);
    sessionCacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-fly-load-auth-'));
    fs.chmodSync(sessionCacheDirectory, 0o700);
    const sessionCachePath = path.join(sessionCacheDirectory, 'cookies.json');
    childEnv.TARGET_SESSION_OUT = sessionCachePath;

    for (const [index, size] of plan.sizes.entries()) {
      assertNotAborted(signal);
      await manualCheckpoint({ plan, size, index, previousSize: index ? plan.sizes[index - 1] : null, workspace: activeWorkspace, signal });
      assertNotAborted(signal);
      const stepReportPath = path.join(os.tmpdir(), `tabula-fly-load-${plan.slug}-${size.id}.json`);
      log(`Running ${size.id}: ${plan.userSteps.join(', ')} users, ${plan.secondsPerStep} seconds each.`);
      await runLoadClass({ plan, size, outPath: stepReportPath, env: childEnv, signal, onOutput: log });
      assertNotAborted(signal);
      if (index === 0 && fs.existsSync(sessionCachePath)) {
        const cachedCookies = JSON.parse(fs.readFileSync(sessionCachePath, 'utf8'));
        if (!Array.isArray(cachedCookies) || cachedCookies.length === 0 || cachedCookies.some((cookie) => typeof cookie !== 'string')) {
          throw new Error('load-class wrote an invalid owner session cache');
        }
        childEnv.TARGET_COOKIES = cachedCookies.join(',');
        delete childEnv.TARGET_LOGIN_TOKENS;
      } else if (index === 0 && childEnv.TARGET_LOGIN_TOKENS) {
        throw new Error('load-class did not write the session cache after exchanging a one-time login token');
      }
      const loadReport = await readLoadReport(stepReportPath, { size, plan });
      const metrics = await collectMetrics({ plan, size, users: plan.userSteps, signal });
      rows.push(...normalizedRows(size, loadReport, metrics));
    }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error('Fly load run failed');
  } finally {
    try {
      cleanup = await teardownWorkspace({
        client,
        plan,
        workspaceId,
        timing: settings,
        now,
        wait,
        adminBase: admin.origin,
      });
      if (!cleanup.verified) log(cleanup.detail);
      else log(`Workspace teardown verified for ${plan.slug}.`);
    } catch (error) {
      cleanup = { workspaceId, verified: false, detail: manualCleanupText(admin.origin, workspaceId, plan.slug), error };
      log(cleanup.detail);
    }

    if (sessionCacheDirectory) {
      try { fs.rmSync(sessionCacheDirectory, { recursive: true, force: true }); } catch { log('Could not remove the temporary owner session cache.'); }
    }

    const evaluation = evaluateFlyLoadPassRule(rows);
    const report = {
      generatedAt: new Date(now()).toISOString(),
      workspace: {
        id: cleanup?.workspaceId ?? workspaceId,
        slug: plan.slug,
        targetUrl: plan.targetUrl,
        region: plan.region,
        expiresAt: formatIso(plan.workspaceExpiresAt),
      },
      configuration: {
        userSteps: plan.userSteps,
        secondsPerStep: plan.secondsPerStep,
        maxTotalMinutes: plan.maxTotalMinutes,
        machineLadder: plan.sizes,
        metrics: plan.metrics,
      },
      rows,
      evaluation,
      teardown: {
        requested: Boolean(cleanup?.workspaceId),
        verified: cleanup?.verified ?? false,
        detail: cleanup?.detail ?? 'No workspace id was confirmed.',
      },
    };
    try {
      const markdown = renderFlyLoadMarkdown(report);
      await writeReport(paths, report, redactFlyLoadText(markdown, secrets));
      log(`Report JSON: ${paths.jsonPath}`);
      log(`Report Markdown: ${paths.mdPath}`);
    } catch (error) {
      if (!primaryError) primaryError = error instanceof Error ? error : new Error('Could not write Fly load report');
      log('Could not write Fly load report.');
    }
    clearTimeout(deadlineTimer);
  }

  if (cleanup && !cleanup.verified) {
    const teardownError = new Error(`Comp workspace teardown could not be verified. ${cleanup.detail}`);
    if (primaryError) throw new AggregateError([primaryError, teardownError], `${primaryError.message}; teardown also failed`);
    throw teardownError;
  }
  if (primaryError) throw primaryError;
  return { dryRun: false, workspaceId, paths, rows, evaluation: evaluateFlyLoadPassRule(rows), teardown: cleanup };
}

export function parseManualMetric(value) {
  return numericMetric(value);
}
