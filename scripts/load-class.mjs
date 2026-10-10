import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { hostLoad, hostLoadAdvice } from './lib/load-class-host.mjs';
import { errorCount, percentile, summaryRows, verdict } from './lib/load-class-stats.mjs';
import {
  assignAccountsToUsers,
  parseLoadClassTimingOptions,
  parseTargetOptions,
  redactTargetSecrets,
  targetPlanText,
  targetRunDecision,
  validateTargetOptions,
} from './lib/load-class-target.mjs';

// every y-websocket client adds an exit listener to process
process.setMaxListeners(0);
const execFileAsync = promisify(execFile);
const SYNC_TIMEOUT_MS = 30_000;
const PROBE_MS = 2_000;
const MAX_WORKERS = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const epochNow = () => performance.timeOrigin + performance.now();

function dual(settings) {
  return Object.fromEntries(Object.entries(settings).flatMap(([key, value]) => [[`MIRA_${key}`, value], [`TABULA_${key}`, value]]));
}

function parseOptions() {
  const users = String(process.env.USERS ?? '30,60,100').split(',').map((value) => Number(value.trim()));
  if (users.length === 0 || users.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('USERS must be a comma-separated list of positive whole numbers');
  }
  const seconds = Number(process.env.SECONDS ?? 60);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('SECONDS must be a positive number');
  const chat = String(process.env.CHAT ?? 'on').toLowerCase();
  if (chat !== 'on' && chat !== 'off') throw new Error('CHAT must be on or off');
  const nodeArgs = String(process.env.RELAY_NODE_ARGS ?? '').trim().split(/\s+/).filter(Boolean);
  const out = process.env.OUT
    ? path.resolve(process.cwd(), process.env.OUT)
    : path.join(os.tmpdir(), `tabula-load-class-${process.pid}-${Date.now()}.json`);
  return { users, seconds, chat: chat === 'on', chatExplicit: process.env.CHAT !== undefined, nodeArgs, out };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve a local relay port');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startRelay({ root, dir, port, chat, nodeArgs, stderrLines }) {
  const base = `http://127.0.0.1:${port}`;
  const settings = {
    AUTH: 'on',
    OWNER_EMAIL: 'owner@example.com',
    MAIL: 'file',
    TRUST_PROXY: '1',
    BASE_URL: base,
    CHAT: chat ? 'on' : 'off',
  };
  // Keep unrelated shell variables and the repository's .env out of this throwaway relay.
  const inherited = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG', 'TZ']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  const warningFilter = process.allowedNodeEnvironmentFlags.has('--disable-warning=') ? ['--disable-warning=ExperimentalWarning'] : [];
  const proc = spawn(process.execPath, [...warningFilter, ...nodeArgs, path.join(root, 'server/relay.mjs')], {
    cwd: dir,
    env: { ...inherited, PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', QUIET: '', ...dual(settings) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderrBuffer = '';
  let exit = null;
  let stopping = false;
  const appendStderr = (chunk) => {
    stderrBuffer += String(chunk);
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) if (line) stderrLines.push(line);
  };
  proc.stdout.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4000); });
  proc.stderr.on('data', appendStderr);
  proc.on('exit', (code, signal) => {
    if (stderrBuffer) stderrLines.push(stderrBuffer);
    stderrBuffer = '';
    exit = { code, signal, expected: stopping };
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${stdout.slice(-800)}`)), 15_000);
    const check = setInterval(() => {
      if (/relay on http/i.test(stdout)) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      } else if (exit) {
        clearTimeout(timer);
        clearInterval(check);
        reject(new Error(`relay exited during startup (${exit.code ?? exit.signal}): ${stdout.slice(-800)}`));
      }
    }, 25);
    proc.once('error', (error) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(error);
    });
  });
  return {
    proc,
    base,
    ready,
    exit: () => exit,
    stderrLines: () => [...stderrLines, ...(stderrBuffer ? [stderrBuffer] : [])],
    stop: async () => {
      stopping = true;
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
          resolve();
        }, 5_000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill('SIGTERM');
      });
    },
  };
}

async function request(base, cookie, method, route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    redirect: 'error',
    headers: {
      'x-mira': '1',
      'x-tabula': '1',
      origin: new URL(base).origin,
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function signIn({ base, dir, email, invite, ip }) {
  const outbox = path.join(dir, 'outbox.jsonl');
  const before = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0;
  const asked = await request(base, undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': ip });
  const messages = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean) : [];
  const fresh = messages.slice(before).map((line) => JSON.parse(line));
  if (asked.status !== 200 || fresh.length !== 1) throw new Error(`sign-in request failed with ${asked.status}`);
  const tokenMatch = /token=([^\s&]+)/.exec(fresh[0].text);
  if (!tokenMatch) throw new Error('sign-in mail did not contain a token');
  const verified = await request(base, undefined, 'POST', '/api/auth/verify', { token: decodeURIComponent(tokenMatch[1]) });
  if (verified.status !== 200) throw new Error(`sign-in verification failed with ${verified.status}`);
  const setCookie = verified.headers.getSetCookie?.()[0] ?? verified.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in verification did not set a session cookie');
  return { cookie: setCookie.split(';')[0], user: verified.body.user, email };
}

function nextLocalIp(index) {
  // The auth limiter allows 20 requests per IP and 5 per address per hour. Each synthetic student has a fresh
  // address, and this local TRUST_PROXY harness gives each request its own forwarded IP like test/mcp-harness.ts.
  return `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
}

async function bootstrapAccounts({ base, dir, maxUsers }) {
  let ipSeq = 1;
  const owner = await signIn({ base, dir, email: 'owner@example.com', ip: nextLocalIp(ipSeq++) });
  const teamRes = await request(base, owner.cookie, 'POST', '/api/teams', { name: `Class ${randomUUID().slice(0, 8)}` });
  if (teamRes.status !== 201) throw new Error(`team creation failed with ${teamRes.status}`);
  const team = teamRes.body;
  const inviteRes = await request(base, owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' });
  if (inviteRes.status !== 201) throw new Error(`team invite creation failed with ${inviteRes.status}`);
  const students = [];
  const signInFailures = [];
  for (let i = 1; i < maxUsers; i++) {
    try {
      students.push(await signIn({ base, dir, email: `student${i}@example.com`, invite: inviteRes.body.token, ip: nextLocalIp(ipSeq++) }));
    } catch (error) {
      signInFailures.push({ ordinal: i, message: error instanceof Error ? error.message : 'sign-in failed' });
    }
  }
  return { owner, team, students, signInFailures };
}

async function bootstrapTargetAccounts({ base, target }) {
  const accounts = [];
  for (const [index, credential] of target.credentials.entries()) {
    const ordinal = index + 1;
    let cookie = credential.value;
    if (credential.kind === 'token') {
      let token;
      try {
        token = decodeURIComponent(credential.value);
      } catch {
        throw new Error(`Target account ${ordinal} login token could not be decoded`);
      }
      const verified = await request(base, undefined, 'POST', '/api/auth/verify', { token });
      if (verified.status !== 200) throw new Error(`Target account ${ordinal} login token exchange failed (HTTP ${verified.status})`);
      const setCookie = verified.headers.getSetCookie?.()[0] ?? verified.headers.get('set-cookie');
      if (!setCookie) throw new Error(`Target account ${ordinal} login token exchange did not return a session`);
      cookie = setCookie.split(';')[0];
    }

    const checked = await request(base, cookie, 'GET', '/api/me');
    if (checked.status !== 200 || !checked.body?.user?.id) {
      throw new Error(`Target account ${ordinal} failed GET /api/me (HTTP ${checked.status})`);
    }
    accounts.push({ cookie, user: checked.body.user });
  }
  return { owner: accounts[0], accounts, signInFailures: [] };
}

function boardIdFor(step, users) {
  return `class-${step + 1}-${users}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function populateSeedObjects(doc, owner) {
  const objects = doc.getMap('objects');
  for (let i = 0; i < 150; i++) {
    const objectId = `seed-${String(i).padStart(3, '0')}`;
    const x = (i % 15) * 230;
    const y = Math.floor(i / 15) * 230;
    objects.set(objectId, new Y.Map(Object.entries({
      id: objectId,
      type: 'sticky',
      x,
      y,
      w: 192,
      h: 192,
      rotation: 0,
      z: `a${i.toString(36).padStart(3, '0')}`,
      fill: '#FFE16B',
      text: `Class idea ${i + 1}`,
      font: 'satoshi',
      fontSize: 18,
      fontWeight: 500,
      textColor: '#1D1A12',
      align: 'center',
      valign: 'middle',
      createdBy: owner.user.id,
      updatedAt: Date.now(),
    })));
  }
}

async function waitForSync(provider, description, timeoutMs = 10_000) {
  if (provider.synced) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off('sync', onSync);
      reject(new Error(`Timed out waiting for ${description} to sync within ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    const onSync = (synced) => {
      if (!synced) return;
      clearTimeout(timer);
      provider.off('sync', onSync);
      resolve();
    };
    provider.on('sync', onSync);
    if (provider.synced) onSync(true);
  });
}

function connectBoardProvider({ base, boardId, cookie, doc }) {
  const wsBase = base.replace(/^http/, 'ws');
  const AuthWebSocket = class extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { Origin: new URL(base).origin, ...(cookie ? { Cookie: cookie } : {}) } });
    }
  };
  return new WebsocketProvider(`${wsBase}/sync`, boardId, doc, {
    WebSocketPolyfill: AuthWebSocket,
    disableBc: true,
    connect: false,
  });
}

async function seedRemoteBoard({ base, boardId, owner, timings }) {
  const doc = new Y.Doc();
  const provider = connectBoardProvider({ base, boardId, cookie: owner.cookie, doc });
  let observerDoc;
  let observer;
  try {
    provider.connect();
    await waitForSync(provider, 'board owner');
    const markerKey = `load-seed-${randomUUID()}`;
    const markerValue = randomUUID();
    doc.transact(() => {
      populateSeedObjects(doc, owner);
      doc.getMap('loadSeed').set(markerKey, markerValue);
    });

    const ackDeadline = performance.now() + 10_000;
    observerDoc = new Y.Doc();
    observer = connectBoardProvider({ base, boardId, cookie: owner.cookie, doc: observerDoc });
    observer.connect();
    try {
      await waitForSync(observer, 'seed acknowledgement observer', Math.max(1, ackDeadline - performance.now()));
    } catch {
      throw new Error('Timed out waiting for the board seed update to be acknowledged within 10 seconds');
    }
    const observerMarker = observerDoc.getMap('loadSeed');
    while (observerMarker.get(markerKey) !== markerValue || observerDoc.getMap('objects').size !== 150) {
      if (performance.now() >= ackDeadline) throw new Error('Timed out waiting for the board seed update to be acknowledged within 10 seconds');
      await sleep(25);
    }
    await sleep(timings.seedSettleMs);
  } finally {
    observer?.destroy();
    provider.destroy();
    observerDoc?.destroy();
    doc.destroy();
  }
}

async function seedBoard({ base, dir, owner, team, accounts, remote, step, users, createdBoards, timings }) {
  const id = boardIdFor(step, users);
  const body = { id, title: `Class load ${users}` };
  if (!remote) body.teamId = team.id;
  const created = await request(base, owner.cookie, 'POST', '/api/boards', body);
  if (created.status !== 201) throw new Error(`board creation failed with ${created.status}`);
  createdBoards?.push(id);

  if (remote) {
    const shared = new Set([owner.user.id]);
    for (const [index, account] of accounts.entries()) {
      if (shared.has(account.user.id)) continue;
      const result = await request(base, owner.cookie, 'POST', `/api/boards/${id}/shares`, {
        principalType: 'user',
        principalId: account.user.id,
        role: 'editor',
      });
      if (result.status !== 201) throw new Error(`sharing board with target account ${index + 1} failed (HTTP ${result.status})`);
      shared.add(account.user.id);
    }
    await seedRemoteBoard({ base, boardId: id, owner, timings });
    return id;
  }

  const doc = new Y.Doc();
  doc.transact(() => populateSeedObjects(doc, owner));
  fs.writeFileSync(path.join(dir, `${id}.yjs`), Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return id;
}

async function processMetrics(pid) {
  if (process.platform === 'linux') {
    try {
      const [stat, status] = await Promise.all([
        fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.promises.readFile(`/proc/${pid}/status`, 'utf8'),
      ]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const ticks = Number(fields[11]) + Number(fields[12]);
      const rssKb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1]);
      if (!Number.isFinite(ticks) || !Number.isFinite(rssKb)) return null;
      return { rssBytes: rssKb * 1024, cpuSeconds: ticks / 100 };
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=,cputime=', '-p', String(pid)], { maxBuffer: 1024 * 1024 });
    const [rssRaw, cpuRaw] = stdout.trim().split(/\s+/);
    const rssKb = Number(rssRaw);
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(cpuRaw ?? '');
    if (!Number.isFinite(rssKb) || !match) return null;
    const days = Number(match[1] ?? 0);
    const hours = Number(match[2] ?? 0);
    const minutes = Number(match[3]);
    const seconds = Number(match[4]);
    return { rssBytes: rssKb * 1024, cpuSeconds: days * 86_400 + hours * 3_600 + minutes * 60 + seconds };
  } catch {
    return null;
  }
}

class RelaySampler {
  constructor(pid) {
    this.pid = pid;
    this.samples = [];
    this.rssPeakBytes = null;
    this.rssEndBytes = null;
  }

  async sample() {
    const current = await processMetrics(this.pid);
    if (!current) return;
    const at = performance.now();
    this.samples.push({ at, cpuSeconds: current.cpuSeconds });
    this.rssPeakBytes = Math.max(this.rssPeakBytes ?? 0, current.rssBytes);
    this.rssEndBytes = current.rssBytes;
  }

  result() {
    const points = this.samples;
    const first = points[0];
    const last = points.at(-1);
    const elapsed = first && last ? (last.at - first.at) / 1000 : 0;
    const cpuAveragePct = elapsed > 0 ? Math.max(0, (last.cpuSeconds - first.cpuSeconds) / elapsed * 100) : null;
    let cpuPeak5sPct = null;
    for (let end = 1; end < points.length; end++) {
      for (let start = end - 1; start >= 0; start--) {
        const seconds = (points[end].at - points[start].at) / 1000;
        if (seconds > 5.5) break;
        if (seconds >= 4.5) {
          const percent = Math.max(0, (points[end].cpuSeconds - points[start].cpuSeconds) / seconds * 100);
          cpuPeak5sPct = Math.max(cpuPeak5sPct ?? 0, percent);
          break;
        }
      }
    }
    if (cpuPeak5sPct === null) cpuPeak5sPct = cpuAveragePct;
    return { rssPeakBytes: this.rssPeakBytes, rssEndBytes: this.rssEndBytes, cpuAveragePct, cpuPeak5sPct, samples: points.length };
  }
}

function lagMonitor() {
  const samples = [];
  let expected = performance.now() + 100;
  let timer;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    samples.push(Math.max(0, now - expected));
    expected = now + 100;
    timer = setTimeout(tick, 100);
  };
  timer = setTimeout(tick, 100);
  return {
    stop: () => { stopped = true; clearTimeout(timer); },
    samples,
  };
}

function startWorker(users, { base, boardId, durationMs, chat, remote = false, timings }) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { users, base, boardId, durationMs, chat, remote, timings },
  });
  let readyResolve;
  let readyReject;
  let resultResolve;
  let resultReject;
  let resultReceived = false;
  const status = [];
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  worker.on('message', (message) => {
    if (message.type === 'ready') readyResolve();
    if (message.type === 'result') {
      resultReceived = true;
      resultResolve(message.metrics);
    }
    if (message.type === 'worker-error') {
      const error = new Error(message.message);
      readyReject(error);
      resultReject(error);
    }
    if (message.type === 'progress') status.push(message.event);
  });
  worker.on('error', (error) => {
    readyReject(error);
    resultReject(error);
  });
  worker.on('exit', (code) => {
    if (code !== 0) resultReject(new Error(`load worker exited with code ${code}`));
    else if (!resultReceived) resultReject(new Error('load worker exited without metrics'));
  });
  return { worker, ready, status, done: result };
}

async function runStep({ stepIndex, users, accounts, base, dir, team, chat, seconds, relay, remote = false, createdBoards, timings }) {
  const signInFailures = remote ? [] : accounts.signInFailures.filter((failure) => failure.ordinal < users);
  const signedStudents = remote ? [] : accounts.students.filter((student) => Number(student.email.match(/student(\d+)/)?.[1]) < users);
  const participants = remote ? assignAccountsToUsers(accounts.accounts, users) : [accounts.owner, ...signedStudents];
  if (remote && accounts.accounts.length < users) {
    console.log(`*** REMOTE ACCOUNT REUSE: ${accounts.accounts.length} account(s) for ${users} users. Simulated users reuse accounts round-robin; this is one person with many tabs, and per-person limits are not multiplied. ***`);
  }
  const boardId = await seedBoard({ base, dir, owner: accounts.owner, team, accounts: accounts.accounts, remote, step: stepIndex, users, createdBoards, timings });
  const workerCount = Math.min(MAX_WORKERS, Math.max(1, participants.length));
  const buckets = Array.from({ length: workerCount }, () => []);
  participants.forEach((person, index) => buckets[index % workerCount].push(person));
  const workers = buckets.map((bucket) => startWorker(bucket, { base, boardId, durationMs: seconds * 1000, chat, remote, timings }));
  try {
    await Promise.all(workers.map((item) => item.ready));
    const sampler = relay ? new RelaySampler(relay.proc.pid) : null;
    const generatorLag = lagMonitor();
    const startEpochMs = epochNow() + 400;
    if (sampler) await sampler.sample();
    for (const item of workers) item.worker.postMessage({ type: 'start', startEpochMs });
    const allDone = Promise.all(workers.map((item) => item.done));
    const timeoutAt = performance.now() + timings.burstMs + seconds * 1000 + SYNC_TIMEOUT_MS + 15_000;
    let relayExit = null;
    while (true) {
      const outcome = await Promise.race([allDone.then((metrics) => ({ metrics })), sleep(timings.sampleIntervalMs).then(() => ({ tick: true }))]);
      if (sampler) await sampler.sample();
      if (outcome.metrics) {
        const workerMetrics = outcome.metrics;
        generatorLag.stop();
        await Promise.allSettled(workers.map((item) => item.worker.terminate()));
        await sleep(timings.resultSettleMs);
        if (sampler) await sampler.sample();
        const lagSamples = [...generatorLag.samples, ...workerMetrics.flatMap((metric) => metric.lagSamples)];
        const perThreadLagP95Ms = [percentile(generatorLag.samples, 95), ...workerMetrics.map((metric) => percentile(metric.lagSamples, 95))];
        const latencies = workerMetrics.flatMap((metric) => metric.latencySamples);
        const joins = workerMetrics.flatMap((metric) => metric.joinMs);
        const errors = workerMetrics.reduce((all, metric) => {
          for (const [key, value] of Object.entries(metric.errors)) all[key] = (all[key] ?? 0) + value;
          return all;
        }, {
          websocketErrors: 0,
          websocketUnexpectedCloses: 0,
          chatRateLimited: 0,
          chatServerErrors: 0,
          chatRequestErrors: 0,
          chatOtherFailures: 0,
          chatSocketDenials: 0,
          failedSignIns: signInFailures.length,
          neverSyncedWithin30s: 0,
          relayStderrLines: 0,
        });
        const stderr = relay?.stderrLines() ?? [];
        errors.relayStderrLines = relay ? unexpectedStderrCount(stderr) : 0;
        const currentExit = relay?.exit() ?? null;
        if (currentExit && !currentExit.expected) relayExit = { code: currentExit.code, signal: currentExit.signal };
        const syncLatencyMs = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: maxValue(latencies), samples: latencies.length };
        const joinMs = { p50: percentile(joins, 50), p95: percentile(joins, 95), samples: joins.length };
        const generatorLagMs = {
          p50: percentile(lagSamples, 50),
          p95: maxValue(perThreadLagP95Ms.filter((value) => value !== null)),
          max: maxValue(lagSamples),
          samples: lagSamples.length,
          perThreadP95Ms: perThreadLagP95Ms,
        };
        const connectedUsers = workerMetrics.reduce((sum, metric) => sum + metric.clientCount, 0);
        const chatPosts = workerMetrics.reduce((total, metric) => ({
          attempted: total.attempted + metric.chatPostsAttempted,
          sent: total.sent + metric.chatPostsSent,
        }), { attempted: 0, sent: 0 });
        const outcomeErrors = errorCount(errors, relayExit);
        const step = {
          users,
          connectedUsers,
          boardId,
          activitySeconds: seconds,
          joinBurstSeconds: timings.burstMs / 1000,
          chat,
          relay: sampler?.result() ?? {
            rssPeakBytes: null,
            rssEndBytes: null,
            cpuAveragePct: null,
            cpuPeak5sPct: null,
            samples: 0,
          },
          syncLatencyMs,
          joinMs,
          generatorLagMs,
          chatPosts,
          errors,
          relayStderrLines: stderr,
          relayExit,
        };
        step.verdict = verdict({ errors: outcomeErrors, relayExit, latencyP95Ms: syncLatencyMs.p95, generatorLagP95Ms: generatorLagMs.p95 });
        return step;
      }
      if (relay?.exit() && !relayExit) {
        const exit = relay.exit();
        if (!exit.expected) {
          relayExit = { code: exit.code, signal: exit.signal };
          for (const item of workers) item.worker.postMessage({ type: 'stop' });
        }
      }
      if (performance.now() > timeoutAt) {
        const status = workers.map((item, index) => `worker ${index + 1}: ${item.status.join(',') || 'no progress'}`).join('; ');
        throw new Error(`load worker timed out for ${users} users (${status})`);
      }
    }
  } finally {
    for (const item of workers) {
      if (item.worker.threadId !== -1) await item.worker.terminate();
    }
  }
}

function format(value, digits = 0) {
  return value === null || value === undefined || !Number.isFinite(value) ? '-' : Number(value).toFixed(digits);
}

function maxValue(values) {
  return values.length ? values.reduce((max, value) => Math.max(max, value), -Infinity) : null;
}

function unexpectedStderrCount(lines) {
  const sqliteNotice = lines.some((line) => /ExperimentalWarning: SQLite is an experimental feature and might change at any time/.test(line));
  return lines.filter((line) =>
    !/ExperimentalWarning: SQLite is an experimental feature and might change at any time/.test(line)
      && !(sqliteNotice && line === '(Use `node --trace-warnings ...` to show where the warning was created)'),
  ).length;
}

function printSummary(steps, out, chat, seconds, burstMs, host, target = null) {
  console.log(`Class load: ${target ? `target=${target.host} (includes network round trips), ` : ''}chat=${chat ? 'on' : 'off'}, ${seconds}s activity after a ${burstMs / 1000}s join burst`);
  console.log(`host load: 1-minute average ${format(host.loadEnd, 2)} on ${host.cpus} cores (${host.level})`);
  if (host.level === 'overloaded') {
    console.log(`!!! latency not trustworthy: the machine was overloaded (load average ${format(host.loadEnd, 2)} on ${host.cpus} cores)`);
  }
  console.log('Users (connected) | Relay RSS MB peak/end | CPU % avg/peak-5s | Sync ms p50/p95/max | Join p95 ms | Generator lag p95 ms | Chat posts attempted/sent | Errors | Verdict');
  for (const [index, row] of summaryRows(steps).entries()) {
    const step = steps[index];
    const relayRss = target ? 'n/a' : `${format(row.relayPeakRssMb, 1)}/${format(row.relayEndRssMb, 1)}`;
    const relayCpu = target ? 'n/a' : `${format(row.cpuAveragePct, 1)}/${format(row.cpuPeak5sPct, 1)}`;
    console.log(`${row.users} (${row.connectedUsers}) | ${relayRss} | ${relayCpu} | ${format(step.syncLatencyMs.p50)}/${format(step.syncLatencyMs.p95)}/${format(step.syncLatencyMs.max)} | ${format(step.joinMs.p95)} | ${format(step.generatorLagMs.p95)} | ${step.chatPosts.attempted}/${step.chatPosts.sent} | ${row.errors} | ${row.verdict}`);
    console.log(`${row.users} users: ${row.verdict}`);
    if (step.generatorLagMs.p95 !== null && step.generatorLagMs.p95 > 50) {
      console.log(`!!! WARNING: generator lag p95 is ${format(step.generatorLagMs.p95, 1)} ms (>50 ms); this step's latency is not trustworthy. Clients already use ${MAX_WORKERS} worker_threads; split them across a second process and rerun.`);
    }
  }
  if (target) console.log('relay CPU and memory: read them from Fly (see docs/capacity.md)');
  else console.log('Relay CPU is percent of one local core. A Fly shared-cpu-1x receives a fraction of a core with burst capacity, so local CPU percentages are a lower bound on its pressure.');
  console.log(`JSON results: ${out}`);
}

async function deleteRemoteBoards({ base, owner, boardIds }) {
  const leftBehind = [];
  if (!owner) return boardIds;
  for (const id of boardIds) {
    try {
      const deleted = await request(base, owner.cookie, 'DELETE', `/api/boards/${id}`);
      if (deleted.status !== 204) leftBehind.push(id);
    } catch {
      leftBehind.push(id);
    }
  }
  return leftBehind;
}

let targetForRedaction = null;

async function main() {
  const options = parseOptions();
  const target = parseTargetOptions();
  const timings = parseLoadClassTimingOptions(target);
  targetForRedaction = target;
  if (target.remote) {
    validateTargetOptions(target, options.users);
    const plan = targetPlanText(target, options.users, options.seconds, timings.burstMs);
    console.log(plan);
    const decision = targetRunDecision(target);
    if (!decision.run) {
      if (decision.reason === 'confirmation') console.log(`To proceed, add this line:\n${decision.confirmationLine}`);
      process.exitCode = decision.exitCode;
      return;
    }
  }

  // os.loadavg() is [0, 0, 0] on Windows; hostLoad treats that as quiet.
  const hostAtStart = hostLoad({ loadavg: os.loadavg(), cpus: os.cpus().length });
  const hostAdvice = hostLoadAdvice(hostAtStart, { allowBusy: process.env.LOAD_CLASS_ALLOW_BUSY === '1' });
  for (const line of hostAdvice.lines) console.error(line);
  if (!hostAdvice.proceed) {
    process.exitCode = 2;
    return;
  }

  if (target.remote) {
    const hasReuse = options.users.some((users) => users > target.accountCount);
    if (hasReuse && !options.chatExplicit) options.chat = false;
    if (hasReuse && !options.chatExplicit) {
      console.log('*** CHAT DEFAULTED OFF: fewer accounts than users; set CHAT=on explicitly to include chat. ***');
    } else if (hasReuse && options.chat) {
      console.log('*** CHAT ON WITH REUSED ACCOUNTS: per-person chat limits will count as chatRateLimited. ***');
    }
  }

  const steps = [];
  const createdBoards = [];
  let accounts;
  let relay;
  let dir;
  let boardsLeftBehind = [];
  try {
    if (target.remote) {
      accounts = await bootstrapTargetAccounts({ base: target.origin, target });
      for (const [stepIndex, users] of options.users.entries()) {
        steps.push(await runStep({
          stepIndex, users, accounts, base: target.origin, chat: options.chat, seconds: options.seconds,
          remote: true, createdBoards, timings,
        }));
      }
    } else {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-load-class-'));
      const port = await freePort();
      const stderrLines = [];
      relay = startRelay({ root, dir, port, chat: options.chat, nodeArgs: options.nodeArgs, stderrLines });
      await relay.ready;
      accounts = await bootstrapAccounts({ base: relay.base, dir, maxUsers: Math.max(...options.users) });
      for (const [stepIndex, users] of options.users.entries()) {
        steps.push(await runStep({ stepIndex, users, accounts, base: relay.base, dir, team: accounts.team, chat: options.chat, seconds: options.seconds, relay, timings }));
      }
    }
  } finally {
    if (target.remote) {
      boardsLeftBehind = await deleteRemoteBoards({ base: target.origin, owner: accounts?.owner, boardIds: createdBoards });
      if (boardsLeftBehind.length) console.log(`boards left behind: ${boardsLeftBehind.join(', ')}`);
    } else if (relay) {
      await relay.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const hostAtEnd = hostLoad({ loadavg: os.loadavg(), cpus: hostAtStart.cpus });
  const host = {
    loadStart: hostAtStart.load1,
    loadEnd: hostAtEnd.load1,
    cpus: hostAtStart.cpus,
    level: hostAtEnd.level,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    host,
    trustworthy: hostAtEnd.level !== 'overloaded',
    ...(target.remote ? {
      target: {
        host: target.host,
        remote: true,
        accounts: accounts.accounts.length,
        usersPerAccount: Math.ceil(Math.max(...options.users) / accounts.accounts.length),
      },
    } : { relayBase: relay.base }),
    configuration: { users: options.users, seconds: options.seconds, chat: options.chat, joinBurstSeconds: timings.burstMs / 1000, maxWorkerThreads: MAX_WORKERS },
    accountSetup: target.remote
      ? { accountsValidated: accounts.accounts.length, failedSignIns: 0 }
      : { studentsCreated: accounts.students.length, signInFailures: accounts.signInFailures },
    ...(target.remote ? { boardsLeftBehind } : {}),
    steps,
  };
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(steps, options.out, options.chat, options.seconds, timings.burstMs, host, target.remote ? target : null);
}

function runWorker(config) {
  return new Promise((resolve) => {
    const clients = [];
    const globalTimers = new Set();
    const errors = {
      websocketErrors: 0,
      websocketUnexpectedCloses: 0,
      chatRateLimited: 0,
      chatServerErrors: 0,
      chatRequestErrors: 0,
      chatOtherFailures: 0,
      chatSocketDenials: 0,
      neverSyncedWithin30s: 0,
    };
    const latencySamples = [];
    const joinMs = [];
    const lagSamples = [];
    let chatPostsAttempted = 0;
    let chatPostsSent = 0;
    let started = false;
    let completed = false;
    let ending = false;
    let activityStart = 0;
    let activityEnd = 0;
    let lagTimer = null;
    let lagExpected = 0;

    const addTimer = (set, fn, ms) => {
      let timer;
      timer = setTimeout(() => {
        set.delete(timer);
        fn();
      }, Math.max(0, ms));
      set.add(timer);
      return timer;
    };
    const clearTimers = (set) => {
      for (const timer of set) clearTimeout(timer);
      set.clear();
    };
    const maybeComplete = () => {
      if (!ending || completed || clients.length !== config.users.length || !clients.every((client) => client.closed)) return;
      finish();
    };
    const closeClient = (client) => {
      if (client.closed) return;
      client.closed = true;
      clearTimers(client.timers);
      if (client.deadlineTimer) {
        clearTimeout(client.deadlineTimer);
        globalTimers.delete(client.deadlineTimer);
      }
      if (client.provider) {
        client.tearingDown = true;
        client.provider.awareness.setLocalStateField('cursor', null);
        client.provider.destroy();
      }
      if (client.chatSocket && client.chatSocket.readyState < WebSocket.CLOSING) {
        client.chatClosing = true;
        client.chatSocket.close(1000, 'class load step complete');
      }
      parentPort.postMessage({ type: 'progress', event: `closed-${client.ordinal}` });
      maybeComplete();
    };
    const finish = (forced = false) => {
      if (completed) return;
      completed = true;
      clearTimers(globalTimers);
      if (lagTimer) clearTimeout(lagTimer);
      for (const client of clients) closeClient(client);
      const metric = {
        clientCount: clients.length,
        latencySamples,
        joinMs,
        lagSamples,
        chatPostsAttempted,
        chatPostsSent,
        errors,
        forced,
      };
      parentPort.postMessage({ type: 'result', metrics: metric });
      parentPort.close();
      resolve();
    };
    const scheduleClientTimer = (client, fn, delay) => addTimer(client.timers, fn, delay);

    function startActivity(client) {
      if (client.closed) return;
      client.active = true;
      const phase = Math.random() * 4_000;
      let lastMoving = false;
      const cursorTimer = setInterval(() => {
        if (client.closed || client.syncedAt === null) return;
        const elapsed = performance.now() - activityStart + phase;
        const moving = elapsed % 4_000 < 2_000;
        if (moving) {
          client.provider.awareness.setLocalStateField('cursor', {
            x: Math.round(client.cursorX += (Math.random() - 0.5) * 8),
            y: Math.round(client.cursorY += (Math.random() - 0.5) * 8),
          });
        } else if (lastMoving) {
          client.provider.awareness.setLocalStateField('cursor', null);
        }
        lastMoving = moving;
      }, 50);
      client.timers.add(cursorTimer);

      const probe = client.doc.getMap('probe');
      const writeProbe = () => {
        if (!client.closed && client.syncedAt !== null) {
          probe.set(client.probeKey, JSON.stringify({ stamp: epochNow(), writer: config.remote ? client.probeKey : client.user.user.id }));
        }
      };
      scheduleClientTimer(client, () => {
        writeProbe();
        const timer = setInterval(writeProbe, PROBE_MS);
        client.timers.add(timer);
      }, Math.random() * PROBE_MS);

      const objects = client.doc.getMap('objects');
      let noteCount = 0;
      const addNote = () => {
        if (client.closed || client.syncedAt === null) return;
        const id = `load-${client.ordinal}-${noteCount++}-${randomUUID().slice(0, 8)}`;
        const note = new Y.Map(Object.entries({
          id,
          type: 'sticky',
          x: Math.round(Math.random() * 2400),
          y: Math.round(Math.random() * 1800),
          w: 192,
          h: 192,
          rotation: 0,
          z: `z${Date.now().toString(36)}${client.ordinal.toString(36)}${noteCount.toString(36)}`,
          fill: '#FFE16B',
          text: `Idea from ${client.user.user.name}: ${noteCount}`,
          font: 'satoshi',
          fontSize: 18,
          fontWeight: 500,
          textColor: '#1D1A12',
          align: 'center',
          valign: 'middle',
          createdBy: client.user.user.id,
          updatedAt: Date.now(),
        }));
        objects.set(id, note);
        client.noteIds.push(id);
        scheduleClientTimer(client, addNote, 8_000 + Math.random() * 4_000);
      };
      scheduleClientTimer(client, addNote, 8_000 + Math.random() * 4_000);

      const moveNote = () => {
        if (!client.closed && client.syncedAt !== null) {
          const id = client.noteIds.at(-1) ?? `seed-${String((client.ordinal * 7) % 150).padStart(3, '0')}`;
          const note = objects.get(id);
          if (note instanceof Y.Map) {
            note.set('x', Number(note.get('x') ?? 0) + Math.round((Math.random() - 0.5) * 36));
            note.set('y', Number(note.get('y') ?? 0) + Math.round((Math.random() - 0.5) * 36));
            note.set('updatedAt', Date.now());
          }
        }
        if (!client.closed) scheduleClientTimer(client, moveNote, 3_500 + Math.random() * 1_000);
      };
      scheduleClientTimer(client, moveNote, Math.random() * 4_000);

      const sendChat = async () => {
        if (client.closed || !client.syncedAt || !client.chatSocket || client.chatSocket.readyState !== WebSocket.OPEN) {
          if (!client.closed) scheduleClientTimer(client, sendChat, 25_000 + Math.random() * 10_000);
          return;
        }
        try {
          chatPostsAttempted++;
          const response = await fetch(`${config.base}/api/chat/board/${config.boardId}/messages`, {
            method: 'POST',
            redirect: 'error',
            headers: { origin: new URL(config.base).origin, cookie: client.user.cookie, 'content-type': 'application/json', 'x-mira': '1', 'x-tabula': '1' },
            body: JSON.stringify({ clientId: randomUUID(), text: `Class message from ${client.user.user.name}` }),
          });
          if (response.status === 429) errors.chatRateLimited++;
          else if (response.status >= 500) errors.chatServerErrors++;
          else if (!response.ok) errors.chatOtherFailures++;
          else chatPostsSent++;
          await response.arrayBuffer();
        } catch {
          errors.chatRequestErrors++;
        }
        if (!client.closed) scheduleClientTimer(client, sendChat, 25_000 + Math.random() * 10_000);
      };
      if (config.chat) scheduleClientTimer(client, sendChat, Math.random() * Math.min(30_000, config.durationMs));
    }

    function connectClient(user, ordinal) {
      if (completed) return;
      const client = {
        user,
        ordinal,
        timers: new Set(),
        noteIds: [],
        probeKey: config.remote ? `load-probe-${user.user.id}-${ordinal}-${randomUUID().slice(0, 8)}` : `load-probe-${user.user.id}`,
        provider: null,
        chatSocket: null,
        connectStarted: performance.now(),
        syncDeadline: performance.now() + SYNC_TIMEOUT_MS,
        syncedAt: null,
        closed: false,
        tearingDown: false,
        chatClosing: false,
        cursorX: Math.random() * 2000,
        cursorY: Math.random() * 1400,
        active: false,
      };
      clients.push(client);
      parentPort.postMessage({ type: 'progress', event: `connect-${ordinal}` });
      const doc = new Y.Doc();
      client.doc = doc;
      const probe = doc.getMap('probe');
      probe.observe((event, transaction) => {
        if (transaction.local || client.syncedAt === null || client.closed) return;
        for (const [key] of event.changes.keys) {
          if (key === client.probeKey) continue;
          const raw = probe.get(key);
          if (typeof raw !== 'string') continue;
          try {
            const marker = JSON.parse(raw);
            if ((config.remote ? marker.writer !== client.probeKey : marker.writer !== user.user.id) && Number.isFinite(marker.stamp)) {
              const latency = epochNow() - marker.stamp;
              if (latency >= 0) latencySamples.push(latency);
            }
          } catch { /* a malformed marker is not a load result */ }
        }
      });

      const AuthWebSocket = class extends WebSocket {
        constructor(url, protocols) {
          super(url, protocols, { headers: { Origin: config.base, Cookie: user.cookie } });
        }
      };
      const provider = new WebsocketProvider(`${config.wsBase}/sync`, config.boardId, doc, {
        WebSocketPolyfill: AuthWebSocket,
        disableBc: true,
        connect: false,
      });
      client.provider = provider;
      provider.awareness.setLocalStateField('user', { id: user.user.id, name: user.user.name, color: '#2347F5' });
      provider.on('connection-error', () => { errors.websocketErrors++; });
      provider.on('connection-close', () => {
        if (!client.tearingDown) errors.websocketUnexpectedCloses++;
      });
      provider.on('sync', (synced) => {
        if (!synced || client.syncedAt !== null || client.closed) return;
        const at = performance.now();
        if (at > client.syncDeadline) {
          if (!client.deadlineReached) {
            client.deadlineReached = true;
            errors.neverSyncedWithin30s++;
          }
          if (ending) closeClient(client);
          return;
        }
        client.syncedAt = at;
        joinMs.push(at - client.connectStarted);
        parentPort.postMessage({ type: 'progress', event: `sync-${ordinal}` });
        if (client.deadlineTimer) {
          clearTimeout(client.deadlineTimer);
          globalTimers.delete(client.deadlineTimer);
        }
        if (ending) closeClient(client);
      });
      provider.connect();

      if (config.chat) {
        const socket = new WebSocket(`${config.wsBase}/chat`, [], { headers: { Origin: config.base, Cookie: user.cookie } });
        client.chatSocket = socket;
        socket.on('open', () => socket.send(JSON.stringify({ t: 'sub', kind: 'board', ref: config.boardId })));
        socket.on('message', (data) => {
          try {
            const frame = JSON.parse(String(data));
            if (frame.t === 'denied' && frame.kind === 'board' && frame.ref === config.boardId) errors.chatSocketDenials++;
          } catch { /* only subscription acknowledgements matter to this harness */ }
        });
        socket.on('error', () => { errors.websocketErrors++; });
        socket.on('close', () => {
          if (!client.chatClosing) errors.websocketUnexpectedCloses++;
        });
      }
      client.deadlineTimer = addTimer(globalTimers, () => {
        if (!client.closed && client.syncedAt === null && !client.deadlineReached) {
          client.deadlineReached = true;
          errors.neverSyncedWithin30s++;
          if (ending) closeClient(client);
        }
      }, SYNC_TIMEOUT_MS);
      addTimer(globalTimers, () => startActivity(client), Math.max(0, activityStart - performance.now()));
    }

    function start() {
      if (started || completed) return;
      started = true;
      parentPort.postMessage({ type: 'progress', event: 'start' });
      const localStart = performance.now() + (config.startEpochMs - epochNow());
      activityStart = localStart + config.timings.burstMs;
      activityEnd = activityStart + config.durationMs;
      const lagTick = () => {
        if (completed) return;
        const now = performance.now();
        lagSamples.push(Math.max(0, now - lagExpected));
        lagExpected = now + 100;
        lagTimer = setTimeout(lagTick, 100);
      };
      lagExpected = localStart + 100;
      lagTimer = setTimeout(lagTick, Math.max(0, lagExpected - performance.now()));
      config.users.forEach((user, index) => {
        const offset = config.users.length < 2 ? 0 : index * config.timings.burstMs / (config.users.length - 1);
        const due = localStart + offset;
        addTimer(globalTimers, () => connectClient(user, index + 1), Math.max(0, due - performance.now()));
      });
      addTimer(globalTimers, () => {
        ending = true;
        parentPort.postMessage({ type: 'progress', event: 'activity-ended' });
        for (const client of clients) {
          if (client.syncedAt !== null || client.deadlineReached) closeClient(client);
        }
        maybeComplete();
      }, Math.max(0, activityEnd - performance.now()));
    }

    parentPort.on('message', (message) => {
      if (message.type === 'start') {
        config.startEpochMs = message.startEpochMs;
        start();
      } else if (message.type === 'stop') {
        ending = true;
        finish(true);
      }
    });
    parentPort.postMessage({ type: 'ready' });
  });
}

if (isMainThread) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`Class load harness failed: ${redactTargetSecrets(message, targetForRedaction ?? [])}`);
    process.exitCode = error?.exitCode ?? 1;
  });
} else {
  runWorker({ ...workerData, wsBase: workerData.base.replace(/^http/, 'ws') }).catch((error) => {
    parentPort.postMessage({ type: 'worker-error', message: error instanceof Error ? error.message : 'load worker failed' });
    parentPort.close();
    process.exitCode = 1;
  });
}
