#!/usr/bin/env node
// Playbook evaluation runner (TAB-171, docs/playbook-eval.md). It grades the AI playbooks against the fixtures with a stub or a
// real model, repeated N times, and writes report.json and report.md. It starts ONE throwaway relay in open mode (fresh data
// folder, free port) whose model provider is a recording proxy (scripts/lib/playbook-eval-proxy.mjs). The proxy swaps the local
// token for the real key, which lives only in this process, and forwards to the upstream model API.
//
//   npm run eval:playbooks -- [--provider stub|anthropic|openai-compatible] [--runs N] [--playbook retro-follow-up|all]
//     [--out <folder>] [--model <name>] [--upstream <url>] [--behaviour gold|inject] [--help]
//
// A real provider reads its key from TABULA_EVAL_API_KEY and nowhere else. Exit codes: 0 pass, 1 a failed gate or a run error,
// 2 bad usage or a missing key.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import * as Checks from './lib/playbook-checks.mjs';
import { boardSnapshot, buildFixture } from './lib/playbook-fixtures.mjs';
import { actionsFrom, startGoldStub } from './lib/playbook-gold.mjs';
import { startRecordingProxy } from './lib/playbook-eval-proxy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RUNS = 20;
const RUN_TIMEOUT_MS = 180_000;
const SYNC_TIMEOUT_MS = 20_000;
const PASS_SHARE = 0.8;
const PROVIDERS = ['stub', 'anthropic', 'openai-compatible'];
const STUB_MODEL = 'tabula-stub/json-1';
const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const NOT_BUILT = ['weekly-planning', 'health-check', 'stakeholder-update'];
const HARD = ['H1', 'H2', 'H3', 'H4', 'H5'];
// the scored checks each feature run is graded on (the others of the playbook belong to the other feature run)
const PLAYBOOKS = {
  'retro-follow-up': {
    fixture: 'messy-retro',
    features: [
      { feature: 'cluster', tag: 'cluster', input: 'selection', scored: ['S1'] },
      { feature: 'summarise', tag: 'summarise', input: 'retro', scored: ['S2', 'S3', 'S4'] },
    ],
  },
};

const USAGE = `Usage: node scripts/playbook-eval.mjs [options]
  --provider <kind>   stub (default, no key), anthropic, or openai-compatible
  --runs <N>          how many times to run each feature, 1 to ${MAX_RUNS} (default 1 for stub, 5 for a real provider)
  --playbook <name>   retro-follow-up or all (default all; all skips the playbooks not built yet)
  --out <folder>      where report.json and report.md go (default tabula-review/playbook-eval/<utc timestamp>)
  --model <name>      the model id (required for openai-compatible; default ${STUB_MODEL} for stub)
  --upstream <url>    the real provider's API address: anthropic defaults to ${ANTHROPIC_UPSTREAM}; openai-compatible needs it,
                      including its /v1 path. https only, or http for a loopback server
  --behaviour <kind>  stub only: gold (default, answers from the gold builders) or inject (repeats an injection string, H5 fails)
  --help              this text
A real provider reads its key from the environment variable TABULA_EVAL_API_KEY.`;

// The real key, once read. Every line this process prints, and every report file, passes through scrub() first.
let SECRET = '';
const scrub = (text) => (SECRET ? String(text).split(SECRET).join('[key]') : String(text));
const say = (text) => process.stdout.write(`${scrub(text)}\n`);
const complain = (text) => process.stderr.write(`${scrub(text)}\n`);

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const event = /^event: ([^\r\n]+)$/m.exec(block)?.[1];
      const data = parseJson(/^data: (.+)$/m.exec(block)?.[1] ?? 'null');
      return event && data ? { event, data } : null;
    })
    .filter(Boolean);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Parses --upstream: https, or http to a loopback server only; no credentials, query or fragment. Returns an error text or the base. */
function parseUpstream(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return '--upstream is not a valid URL';
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return '--upstream must be https:// (http:// only for a loopback server)';
  if (url.username || url.password || url.search || url.hash) return '--upstream must not contain credentials, a query or a fragment';
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Runs the relay as a child of this process: the caller's environment is not passed on, only what the relay needs. */
async function startRelay(dataDir, aiEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], {
    cwd: dataDir,
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      DIST_DIR: path.join(dataDir, 'no-dist'),
      QUIET: '1',
      TABULA_AI_OPEN: '1',
      // open mode counts AI runs per client address (20 an hour); each run names its own address in x-forwarded-for
      TABULA_TRUST_PROXY: '1',
      ...aiEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let exited = false;
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  child.once('exit', () => {
    exited = true;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the relay stopped during startup: ${stderr.slice(-400)}`);
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return { child, base };
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`the relay did not answer in 20 seconds: ${stderr.slice(-400)}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
}

/** Starts everything a run needs; every handle is kept so stopEnvironment can undo whatever was started. */
async function startEnvironment({ provider, model, upstream, behaviour, key }) {
  const handles = { relay: null, proxy: null, stub: null, dataDir: null };
  try {
    // the relay's key is a random local token; the real key is known to the proxy alone
    const localKey = crypto.randomBytes(16).toString('hex');
    const kind = provider === 'anthropic' ? 'anthropic' : 'openai-compatible';
    let upstreamBase = upstream;
    if (provider === 'stub') {
      handles.stub = await startGoldStub({ model, behaviour });
      upstreamBase = handles.stub.base;
    }
    const realKey = provider === 'stub' ? localKey : key;
    handles.proxy = await startRecordingProxy({
      upstream: upstreamBase,
      kind,
      authName: kind === 'anthropic' ? 'x-api-key' : 'authorization',
      authValue: kind === 'anthropic' ? realKey : `Bearer ${realKey}`,
      localAuth: kind === 'anthropic' ? localKey : `Bearer ${localKey}`,
    });
    // Anthropic in open mode takes its address from the SDK's ANTHROPIC_BASE_URL (TABULA_AI_PROXY_URL is for hosted credits only)
    const aiEnv =
      kind === 'anthropic'
        ? { ANTHROPIC_BASE_URL: handles.proxy.url, ...(model ? { TABULA_AI_MODEL: model } : {}), TABULA_AI_API_KEY: localKey }
        : { TABULA_AI_PROVIDER: 'openai-compatible', TABULA_AI_BASE_URL: handles.proxy.url, TABULA_AI_MODEL: model, TABULA_AI_API_KEY: localKey };
    handles.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-playbook-eval-'));
    handles.relay = await startRelay(handles.dataDir, aiEnv);
    return handles;
  } catch (err) {
    await stopEnvironment(handles);
    throw err;
  }
}

/** Stops only what startEnvironment started, then removes the data folder. Each step runs even if an earlier one failed. */
async function stopEnvironment(handles) {
  await stopChild(handles.relay?.child).catch(() => {});
  await handles.proxy?.close().catch(() => {});
  await handles.stub?.close().catch(() => {});
  if (handles.dataDir) fs.rmSync(handles.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function connectBoard(base, boardId, doc) {
  const origin = new URL(base).origin;
  const Authed = class extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { Origin: origin } });
    }
  };
  const provider = new WebsocketProvider(`${base.replace(/^http/, 'ws')}/sync`, boardId, doc, { WebSocketPolyfill: Authed, disableBc: true, connect: false });
  // the relay sends notices of app types that y-websocket does not know (src/sync.ts: 4 workspace, 5 comment, 6 AI runs, 7
  // tracker); the runner has no use for them, and without a handler y-websocket logs "Unable to compute message" for each
  for (const type of [4, 5, 6, 7]) provider.messageHandlers[type] = () => {};
  return provider;
}

function waitForSync(provider, description) {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off('sync', onSync);
      reject(new Error(`timed out waiting for ${description} to sync`));
    }, SYNC_TIMEOUT_MS);
    const onSync = (synced) => {
      if (!synced) return;
      clearTimeout(timer);
      provider.off('sync', onSync);
      resolve();
    };
    provider.on('sync', onSync);
  });
}

/** What the server holds for a board, read over a fresh connection. */
async function readBoard(base, boardId) {
  const doc = new Y.Doc();
  const provider = connectBoard(base, boardId, doc);
  provider.connect();
  try {
    await waitForSync(provider, 'the board');
    return boardSnapshot(doc);
  } finally {
    provider.destroy();
    doc.destroy();
  }
}

/** Puts the fixture into the relay and waits until a fresh reader sees every object back from the server. */
async function loadBoard(base, boardId, fixture) {
  const loader = new Y.Doc();
  const sender = connectBoard(base, boardId, loader);
  sender.connect();
  try {
    await waitForSync(sender, 'the fixture board');
    Y.applyUpdate(loader, Y.encodeStateAsUpdate(fixture.doc));
    const want = Object.keys(boardSnapshot(fixture.doc).objects).length;
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    for (;;) {
      const seen = await readBoard(base, boardId);
      if (Object.keys(seen.objects).length === want) return;
      if (Date.now() > deadline) throw new Error('the server did not take the fixture board in 20 seconds');
      await sleep(150);
    }
  } finally {
    sender.destroy();
    loader.destroy();
  }
}

/** One feature run through POST /api/ai/run. Returns the status, the SSE events or JSON answer, and the time taken. */
async function postRun(base, body, address) {
  const started = performance.now();
  const res = await fetch(`${base}/api/ai/run`, {
    method: 'POST',
    headers: { 'x-tabula': '1', 'content-type': 'application/json', 'x-forwarded-for': address },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  const text = await res.text();
  const stream = (res.headers.get('content-type') ?? '').startsWith('text/event-stream');
  return { status: res.status, events: stream ? parseSse(text) : [], json: !stream && text ? parseJson(text) : null, ms: performance.now() - started };
}

/** Grades one feature run: the hard gates always, and only the scored checks of that feature. */
function gradeFeature(feature, run, allowedHosts) {
  const report = Checks.evaluateRun('retro-follow-up', run, { allowedHosts });
  const keep = new Set(['W1', ...HARD, ...feature.scored]);
  return report.results
    .filter((result) => keep.has(result.id))
    .map((result) => ({
      id: result.id,
      hard: Boolean(result.hard),
      warning: Boolean(result.warning),
      ok: result.ok,
      ...(result.score === undefined ? {} : { score: result.score }),
      detail: result.detail,
    }));
}

/** One feature run end to end: fresh board, the run, the server's own copy of the board afterwards, then the grade. */
async function evaluateOnce({ env, pb, feature, n, slot, fixtureName, upstreamHost }) {
  const boardId = `fx-retro-r${n}-${feature.tag}`;
  const fixture = buildFixture(fixtureName);
  const before = boardSnapshot(fixture.doc);
  await loadBoard(env.relay.base, boardId, fixture);
  const address = `198.18.${Math.floor(slot / 256)}.${slot % 256}`;
  const input = feature.input === 'selection' ? { selection: Object.keys(boardSnapshot(fixture.doc).objects) } : { type: 'retro' };
  const mark = env.proxy.mark();
  let res;
  try {
    res = await postRun(env.relay.base, { feature: feature.feature, boardId, input }, address);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { playbook: pb, feature: feature.feature, status: null, error: timedOut ? 'timeout' : 'run_failed', ms: RUN_TIMEOUT_MS, usage: null, hardOk: false, results: [] };
  }
  const after = await readBoard(env.relay.base, boardId);
  const recorded = env.proxy.recordedSince(mark);
  const result = res.events.find((event) => event.event === 'result');
  const failure = res.events.find((event) => event.event === 'error');
  const refusal = failure ? String(failure.data.error) : res.status === 200 ? null : String(res.json?.error ?? res.status);
  const proposal = result ? (result.data.proposal ?? null) : null;
  const usage = result?.data.usage ?? {};
  const run = {
    fixture,
    before,
    after,
    proposal,
    rawOutputs: recorded.texts,
    requests: recorded.requests,
    outbound: recorded.hosts,
    mail: [],
    refusal,
    runUserId: 'p-anna',
    createdIds: [],
    metrics: { ms: res.ms, inputTokens: Number(usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0) },
    actions: actionsFrom({ proposal, fixture }),
  };
  const results = gradeFeature(feature, run, [upstreamHost]);
  return {
    playbook: pb,
    feature: feature.feature,
    status: res.status,
    error: refusal,
    ms: Math.round(res.ms),
    usage: { inputTokens: run.metrics.inputTokens, outputTokens: run.metrics.outputTokens },
    hardOk: results.filter((result) => result.hard).every((result) => result.ok),
    results,
  };
}

/** The pass rule: hard gates in every run, scored checks in at least ceil(0.8 * runs), W1 as a count of warnings. */
function judge(runs, selected, n) {
  const rows = [];
  for (const pb of selected) {
    for (const feature of PLAYBOOKS[pb].features) {
      const perRun = runs.map((run) => run.features.find((f) => f.playbook === pb && f.feature === feature.feature));
      for (const id of [...HARD, ...feature.scored]) {
        const kind = HARD.includes(id) ? 'hard' : 'scored';
        const passes = perRun.filter((f) => f?.results.find((r) => r.id === id)?.ok === true).length;
        const needed = kind === 'hard' ? n : Math.ceil(PASS_SHARE * n);
        const firstFail = perRun.map((f) => f?.results.find((r) => r.id === id)).find((r) => r && !r.ok);
        rows.push({
          playbook: pb,
          feature: feature.feature,
          check: id,
          kind,
          passes,
          runs: n,
          needed,
          ok: passes >= needed,
          detail: firstFail ? firstFail.detail : 'every run passed',
        });
      }
      const warned = perRun.filter((f) => f?.results.find((r) => r.id === 'W1' && !r.ok)).length;
      rows.push({
        playbook: pb,
        feature: feature.feature,
        check: 'W1',
        kind: 'warning',
        passes: n - warned,
        runs: n,
        needed: n,
        ok: true,
        warned,
        detail: warned === 0 ? 'no markup or links in the proposal text' : `markup or links in ${warned} of ${n} runs (kept by the server, drawn as plain text)`,
      });
    }
  }
  return rows;
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function markdownFor({ options, rows, outcome, cost }) {
  const lines = [
    '# Playbook evaluation',
    '',
    `Provider: ${options.provider}${options.model ? ` (model ${options.model})` : ''}, upstream: ${options.upstream}, runs: ${options.runs}, playbooks: ${options.playbooks.join(', ')}${options.behaviour ? `, behaviour: ${options.behaviour}` : ''}.`,
    `Outcome: ${outcome.ok ? 'PASS' : 'FAIL'} (exit ${outcome.exitCode}).`,
    '',
    `Pass rule: every hard gate in every run; each scored check in at least ${Math.ceil(PASS_SHARE * options.runs)} of ${options.runs} runs; W1 is a warning only.`,
    '',
    '| check | kind | passes | needed | result | detail |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const label = `${row.playbook} ${row.feature} ${row.check}`;
    const result = row.kind === 'warning' ? (row.warned ? 'WARN' : 'pass') : row.ok ? 'pass' : 'FAIL';
    lines.push(`| ${cell(label)} | ${row.kind} | ${row.passes}/${row.runs} | ${row.needed} | ${result} | ${cell(row.detail)} |`);
  }
  lines.push('');
  lines.push(`Failed hard gates: ${outcome.hardFailed.length ? [...new Set(outcome.hardFailed.map((x) => x.check))].join(', ') : 'none'}.`);
  lines.push(`Scored shortfalls: ${outcome.scoredShortfalls.length ? outcome.scoredShortfalls.map((x) => `${x.check} (${x.feature}, ${x.passes}/${x.runs})`).join(', ') : 'none'}.`);
  lines.push(`Run errors: ${outcome.runErrors.length ? outcome.runErrors.map((x) => `${x.feature} run ${x.run}: ${x.error}`).join(', ') : 'none'}.`);
  lines.push(`Cost: ${cost.inputTokens} input tokens and ${cost.outputTokens} output tokens, as the provider reported them.`);
  return `${lines.join('\n')}\n`;
}

const USAGE_CODE = 2;

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: 'string' },
        runs: { type: 'string' },
        playbook: { type: 'string' },
        out: { type: 'string' },
        model: { type: 'string' },
        upstream: { type: 'string' },
        behaviour: { type: 'string' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    complain(`${err.message}\n${USAGE}`);
    return USAGE_CODE;
  }
  if (values.help) {
    say(USAGE);
    return 0;
  }
  const usageError = (message) => {
    complain(`${message}\n${USAGE}`);
    return USAGE_CODE;
  };

  const provider = values.provider ?? 'stub';
  if (!PROVIDERS.includes(provider)) return usageError(`--provider must be one of ${PROVIDERS.join(', ')}`);
  const real = provider !== 'stub';

  const runsText = values.runs ?? (real ? '5' : '1');
  if (!/^\d+$/.test(runsText) || Number(runsText) < 1) return usageError('--runs must be a whole number');
  const runs = Number(runsText);
  if (runs > MAX_RUNS) return usageError(`--runs is at most ${MAX_RUNS}`);

  const requested = values.playbook ?? 'all';
  const selected = [];
  if (requested === 'all') {
    selected.push('retro-follow-up');
    for (const name of NOT_BUILT) say(`${name}: not built yet (TAB-169), skipped`);
  } else if (PLAYBOOKS[requested]) {
    selected.push(requested);
  } else if (NOT_BUILT.includes(requested)) {
    complain(`${requested}: not built yet (TAB-169)`);
    return USAGE_CODE;
  } else {
    return usageError('--playbook must be retro-follow-up or all');
  }

  const behaviour = values.behaviour ?? 'gold';
  if (!['gold', 'inject'].includes(behaviour)) return usageError('--behaviour must be gold or inject');
  if (values.behaviour !== undefined && provider !== 'stub') return usageError('--behaviour applies to --provider stub only');

  let model = values.model ?? (provider === 'stub' ? STUB_MODEL : null);
  if (provider === 'openai-compatible' && !model) return usageError('--model is required with --provider openai-compatible');
  if (model !== null && !/^[A-Za-z0-9._:/-]{1,100}$/.test(model)) return usageError('--model has characters that are not allowed in a model id');

  if (provider === 'stub' && values.upstream !== undefined) return usageError('--upstream applies to a real provider only');
  let upstream = values.upstream ?? (provider === 'anthropic' ? ANTHROPIC_UPSTREAM : null);
  if (provider === 'openai-compatible' && !upstream) return usageError('--upstream is required with --provider openai-compatible');
  if (upstream !== null) {
    const parsed = parseUpstream(upstream);
    if (parsed.startsWith('--')) return usageError(parsed);
    upstream = parsed;
  }

  let key = '';
  if (real) {
    key = process.env.TABULA_EVAL_API_KEY ?? '';
    if (key === '') {
      complain('TABULA_EVAL_API_KEY is not set');
      return USAGE_CODE;
    }
    if (key.length < 8 || key.length > 512 || /\s/.test(key)) {
      complain('TABULA_EVAL_API_KEY must be 8 to 512 characters without spaces');
      return USAGE_CODE;
    }
    SECRET = key;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(values.out ?? path.join(root, 'tabula-review', 'playbook-eval', stamp));
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return usageError(`--out cannot be created: ${err.code ?? 'error'}`);
  }

  const upstreamHost = provider === 'stub' ? '127.0.0.1' : new URL(upstream).hostname.toLowerCase();
  const options = {
    provider,
    model,
    runs,
    playbooks: selected,
    ...(real ? {} : { behaviour }),
    upstream: provider === 'stub' ? 'loopback stub' : upstreamHost,
  };
  say(`playbook evaluation: provider ${provider}, ${runs} run(s) per feature, ${selected.join(', ')}`);

  const runResults = [];
  const env = await startEnvironment({ provider, model: model ?? '', upstream, behaviour, key });
  try {
    let slot = 0;
    for (let n = 1; n <= runs; n++) {
      const features = [];
      for (const pb of selected) {
        for (const feature of PLAYBOOKS[pb].features) {
          slot += 1;
          const outcome = await evaluateOnce({ env, pb, feature, n, slot, fixtureName: PLAYBOOKS[pb].fixture, upstreamHost });
          features.push(outcome);
          const failed = outcome.results.filter((r) => !r.ok && !r.warning).map((r) => r.id);
          const summary = outcome.error ? `error ${outcome.error}` : failed.length ? `failed ${failed.join(', ')}` : 'gates and scored checks pass';
          say(`run ${n}, ${feature.feature}: ${summary} (${outcome.ms} ms)`);
        }
      }
      runResults.push({ run: n, features });
    }
  } finally {
    await stopEnvironment(env);
  }

  const rows = judge(runResults.map((r) => ({ features: r.features })), selected, runs);
  const hardFailed = rows.filter((row) => row.kind === 'hard' && !row.ok).map(({ playbook, feature, check, passes, runs: total }) => ({ check, playbook, feature, passes, runs: total }));
  const scoredShortfalls = rows.filter((row) => row.kind === 'scored' && !row.ok).map(({ playbook, feature, check, passes, runs: total, needed }) => ({ check, playbook, feature, passes, runs: total, needed }));
  const runErrors = runResults.flatMap((r) => r.features.filter((f) => f.error && f.status === null).map((f) => ({ run: r.run, feature: f.feature, error: f.error })));
  const ok = hardFailed.length === 0 && scoredShortfalls.length === 0 && runErrors.length === 0;
  const cost = runResults.reduce(
    (sum, r) => {
      for (const f of r.features) {
        sum.inputTokens += f.usage?.inputTokens ?? 0;
        sum.outputTokens += f.usage?.outputTokens ?? 0;
      }
      return sum;
    },
    { inputTokens: 0, outputTokens: 0 },
  );
  const outcome = { ok, exitCode: ok ? 0 : 1, hardFailed, scoredShortfalls, runErrors, warned: rows.filter((row) => row.kind === 'warning' && row.warned).length };

  const report = {
    tool: 'playbook-eval',
    generatedAt: new Date().toISOString(),
    options,
    passRule: { hardGates: 'every run', scoredChecks: `at least ceil(${PASS_SHARE} x runs)`, warnings: 'reported, never failing' },
    outcome,
    checks: rows,
    runs: runResults,
    cost,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), `${scrub(JSON.stringify(report, null, 2))}\n`);
  const markdown = markdownFor({ options, rows, outcome, cost });
  fs.writeFileSync(path.join(outDir, 'report.md'), scrub(markdown));
  say('');
  say(markdown);
  say(`reports: ${outDir}`);
  say(`cost: ${cost.inputTokens} input and ${cost.outputTokens} output tokens across ${runResults.reduce((count, r) => count + r.features.length, 0)} feature runs`);
  return outcome.exitCode;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    complain(`playbook evaluation failed: ${err?.message ?? err}`);
    process.exit(1);
  });
