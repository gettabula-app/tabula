#!/usr/bin/env node
// Browser check of the AI review panel (TAB-160, docs/ai.md "Checking the review in a browser"). It starts its own throwaway
// relay in open mode (fresh data folder, free port) whose AI provider is a local stub (scripts/lib/anthropic-stub.mjs), and
// drives headless Chromium: the review panel's states at 390 and 1024 wide, and two people on one board (one reviews and
// adds a subset; the other keeps seeing the original, then both see the same objects, and one Undo removes them all).
// Every step asserts; the last line is `REPORT: PASS=n FAIL=n BLOCKED=n`, and the exit code is 1 unless all pass. Not part of
// `npm test` or CI (test/ai-review-check-config.test.ts checks that).
//
//   npm run check:ai-review [-- --no-build] [-- --out <folder>]
//
// Needs Chromium once: npx playwright install chromium. Screenshots go to tabula-review/ai-review (git-ignored).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { startAnthropicStub } from './lib/anthropic-stub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: npm run check:ai-review -- [--no-build] [--out <folder>]\n  --no-build  reuse an existing dist/ instead of running npm run build:app\n  --out       where the screenshots go (default tabula-review/ai-review)';
let options;
try {
  options = parseArgs({ options: { 'no-build': { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: false }).values;
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
const SHOTS = path.resolve(options.out ?? path.join(root, 'tabula-review', 'ai-review'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-ai-review-'));
let DIST = path.join(root, 'dist');
const API_KEY = 'a-fake-key-for-tests';
const MODEL = 'claude-haiku-5-5';
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const BASE_NOTES = [
  { id: 'seed-note-1', text: 'Fast feedback helped the team', x: -400, y: -180, fill: '#FFE16B' },
  { id: 'seed-note-2', text: 'Tests caught regressions early', x: -180, y: -180, fill: '#BCE88C' },
  { id: 'seed-note-3', text: 'Pairing unblocked the hard work', x: 40, y: -180, fill: '#8FE3CA' },
  { id: 'seed-note-4', text: 'Too many meetings slowed us down', x: -290, y: 60, fill: '#FFA3C4' },
  { id: 'seed-note-5', text: 'Ownership was unclear', x: -70, y: 60, fill: '#FFB979' },
];
const GENERATED = [
  { text: 'Clarify the migration goals', color: 'Yellow' },
  { text: 'Map the legacy dependencies', color: 'Green' },
  { text: 'Assign an owner to each service', color: 'Orange' },
  { text: 'Define a rollback trigger', color: 'Pink' },
  { text: 'Review costs after the first week', color: 'Violet' },
];
const GROUP_PROPOSAL = {
  groups: [
    { title: 'Keep doing', ids: ['seed-note-1', 'seed-note-2'] },
    { title: 'Improve next', ids: ['seed-note-3', 'seed-note-4', 'seed-note-5'] },
  ],
};
const EDITED_TEXT = 'B reviewed: document the recovery steps';
const UNCHECKED_TEXT = GENERATED[1].text;
const CHANGED_PEER_TEXT = 'Peer edited this sticky after the cluster proposal arrived';
const CHANGED_PEER_LABEL = `${CHANGED_PEER_TEXT.slice(0, 39)}…`;
const BASE_IDS = BASE_NOTES.map((n) => n.id);
const report = [];
const produced = [];
const pageLogs = [];
const contexts = [];
let browser = null;
let relay = null;
let stub = null;

function shown(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function check(name, actual, expected, predicate = isDeepStrictEqual) {
  const ok = predicate(actual, expected);
  report.push({ status: ok ? 'PASS' : 'FAIL', name, actual, expected });
  if (!ok) throw new Error(`${name} assertion failed (actual ${shown(actual)}, expected ${shown(expected)})`);
  return actual;
}

function note(name, status, actual) {
  report.push({ status, name, actual });
}

function makeId(label) {
  return label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => err ? reject(err) : resolve(port));
    });
  });
}



async function startRelay(baseUrl) {
  const dataDir = fs.mkdtempSync(path.join(WORK, 'relay-data-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], {
    cwd: dataDir,
    // nothing from the caller's shell may reach the relay (it would turn on MCP, backups, a hosted workspace or a real AI key)
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TABULA_|MIRA_|ANTHROPIC_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(key))),
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      DIST_DIR: DIST,
      QUIET: '1',
      TABULA_AI_API_KEY: API_KEY,
      TABULA_AI_OPEN: '1',
      TABULA_AI_MODEL: MODEL,
      ANTHROPIC_BASE_URL: baseUrl,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let exited = false;
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('exit', () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`relay stopped during startup (exit ${child.exitCode ?? child.signalCode}): ${stderr.slice(-1000)}`);
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return { child, base, dataDir, stderr: () => stderr };
    } catch { /* retry while the owned relay starts */ }
    await sleep(100);
  }
  throw new Error(`relay did not answer in 20 seconds: ${stderr.slice(-1000)}`);
}

async function stopOwnedRelay(handle) {
  if (!handle) return;
  const { child } = handle;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(2000)]);
    }
  }
  fs.rmSync(handle.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const event = /^event: ([^\r\n]+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return event && data ? { event, data: JSON.parse(data) } : null;
  }).filter(Boolean);
}

function eventBody(events, name) {
  return events.find((e) => e.event === name)?.data ?? null;
}

function ensureBuilt(noBuild) {
  const built = () => fs.existsSync(path.join(DIST, 'index.html'));
  if (noBuild && built()) return DIST;
  console.log('building the app (npm run build:app)');
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:app'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (run.status !== 0 || !built()) throw new Error('npm run build:app failed');
  return DIST;
}

async function launchBrowser(chromium) {
  return chromium.launch({
    // a profile of its own and nothing of the caller's environment but what Chromium needs to start
    env: { PATH: process.env.PATH, HOME: WORK, TMPDIR: WORK, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: WORK, TMP: WORK } : {}) },
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
}

async function routeOutside(route, appOrigin) {
  const url = new URL(route.request().url());
  if (url.origin === appOrigin) return route.continue();
  if (url.hostname === 'api.fontshare.com' && url.pathname === '/v2/fonts') {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ fonts: [] }) });
  }
  if ((url.hostname === 'api.fontshare.com' && url.pathname === '/v2/css') || url.hostname.endsWith('.fontshare.com')) {
    return route.fulfill({ status: 200, contentType: 'text/css', headers: { 'access-control-allow-origin': '*' }, body: '' });
  }
  return route.abort();
}

async function openBoard(boardId, width, name, color) {
  const context = await browser.newContext({
    viewport: { width, height: width <= 500 ? 844 : 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  contexts.push(context);
  await context.clock.setFixedTime(NOW);
  await context.addInitScript(({ person }) => {
    localStorage.setItem('driftboard:theme', 'default');
    localStorage.setItem('driftboard:user', JSON.stringify(person));
    localStorage.setItem('driftboard:ai-bar', 'open');
    localStorage.setItem('driftboard:fontshare-catalogue', JSON.stringify({ at: Date.UTC(2026, 0, 15, 10, 0, 0), fonts: [] }));
    const fetchOriginal = window.fetch.bind(window);
    window.__tab160AiRunResponses = [];
    window.fetch = async (input, init) => {
      const response = await fetchOriginal(input, init);
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/ai/run') {
        const clone = response.clone();
        void clone.text().then((text) => window.__tab160AiRunResponses.push({
          status: response.status,
          contentType: response.headers.get('content-type'),
          text,
        })).catch((err) => window.__tab160AiRunResponses.push({ status: 0, contentType: null, text: '', error: String(err) }));
      }
      return response;
    };
  }, { person: { id: makeId(name), name, color } });
  const page = await context.newPage();
  const errors = { console: [], page: [], failedRequests: [] };
  pageLogs.push({ name, width, errors });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (err) => errors.page.push(err.message));
  page.on('requestfailed', (req) => errors.failedRequests.push({ url: req.url(), error: req.failure()?.errorText ?? 'unknown' }));
  const origin = new URL(relay.base).origin;
  await context.route('**/*', (route) => routeOutside(route, origin));
  await page.goto(`${relay.base}/?debug&aibar#/b/${boardId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((id) => window.__board?.conn?.id === id, boardId, { timeout: 20_000 });
  await page.waitForFunction(() => {
    const provider = window.__board?.conn?.provider;
    return !provider || provider.synced === true;
  }, null, { timeout: 20_000 });
  await page.locator('.aibar').waitFor({ timeout: 20_000 });
  check(`${name}: light theme and AI bar`, await page.evaluate(() => ({
    theme: localStorage.getItem('driftboard:theme'),
    canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim().toLowerCase(),
    aiBar: Boolean(document.querySelector('.aibar')),
  })), { theme: 'default', canvas: '#eef1f4', aiBar: true });
  return { context, page, errors, boardId, name, width };
}

async function seedBoard(page, title) {
  const result = await page.evaluate(({ items, boardTitle, at }) => {
    const app = window.__board;
    const store = app.store;
    if (items.every((n) => store.get(n.id))) return 'already-seeded';
    const font = store.getMeta().bodyFont;
    const zs = store.topZs(items.length);
    store.transact(() => {
      store.setMeta({ name: boardTitle });
      items.forEach((n, i) => store.create({
        id: n.id, type: 'sticky', x: n.x, y: n.y, w: 192, h: 192, rotation: 0, z: zs[i],
        createdBy: app.user.id, updatedAt: at, font, fontSize: 18, fill: n.fill, text: n.text,
      }));
    });
    app.setSelection([]);
    app.zoomToFit();
    return 'seeded';
  }, { items: BASE_NOTES, boardTitle: title, at: NOW });
  check(`${title}: seed board`, result, 'seeded');
  await page.waitForFunction((ids) => ids.every((id) => window.__board?.store?.cache?.has(id)), BASE_IDS, { timeout: 15_000 });
}

async function waitForBoardIds(page, ids) {
  await page.waitForFunction((wanted) => wanted.every((id) => window.__board?.store?.cache?.has(id)), ids, { timeout: 20_000 });
}

async function boardObjects(page) {
  return page.evaluate(() => [...window.__board.store.cache.values()].map((o) => ({
    id: o.id, type: o.type, text: o.text ?? null, name: o.name ?? null, fill: o.fill ?? null,
    parent: o.parent ?? null, proposedBy: o.proposedBy ?? null,
  })));
}

async function ghostMarkup(page) {
  return page.evaluate(() => window.__board.r.overlay.ai ?? '');
}

function ghostText(markup) {
  return markup.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function waitForGhostText(page, text) {
  await page.waitForFunction((needle) => {
    const markup = window.__board.r.overlay.ai ?? '';
    const visible = markup.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    return visible.includes(needle);
  }, text, { timeout: 10_000 });
}

async function waitForGhostColor(page, color) {
  const expected = color.toLowerCase();
  await page.waitForFunction((needle) => (window.__board.r.overlay.ai ?? '').toLowerCase().includes(`fill="${needle}"`), expected, { timeout: 10_000 });
}

async function previewSnapshot(page) {
  const snapshot = await page.evaluate(() => ({
    row: Boolean(document.querySelector('.ailive-row:not([hidden])')),
    ghosts: window.__board.r.overlay.ai ?? '',
  }));
  const text = ghostText(snapshot.ghosts);
  return { row: snapshot.row, allGhosts: GENERATED.every((o) => text.includes(o.text)) };
}

function slimProposal(p) {
  if (!p) return null;
  if (p.kind === 'create') return {
    kind: p.kind,
    objects: p.objects.map((o) => ({ text: o.text, ...(o.color ? { color: o.color } : {}) })),
    ...(p.frame ? { frame: { title: p.frame.title } } : {}),
  };
  return { kind: p.kind, groups: p.groups.map((g) => ({ title: g.title, ids: [...g.ids] })) };
}

async function runFeature(target, feature, prompt = 'Generate exactly five useful project follow-ups.') {
  const { page, name } = target;
  if (feature === 'cluster') {
    await page.evaluate((ids) => window.__board.setSelection(ids), BASE_IDS);
    await page.locator('.aibar-chips').getByRole('button', { name: 'Cluster', exact: true }).click();
  } else {
    await page.locator('.aibar-input').fill(prompt);
  }
  const previousResponses = await page.evaluate(() => window.__tab160AiRunResponses.length);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction((before) => window.__tab160AiRunResponses.length > before, previousResponses, { timeout: 20_000 });
  const captured = await page.evaluate((at) => window.__tab160AiRunResponses[at], previousResponses);
  const bodyText = captured.text ?? '';
  const events = parseSse(bodyText);
  const data = eventBody(events, 'result');
  check(`${name}: ${feature} request HTTP/SSE`, { status: captured.status, contentType: captured.contentType, error: captured.error ?? null, events: events.map((e) => e.event) }, {
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    error: null,
    events: ['progress', 'progress', 'result'],
  }, (a, e) => a.status === e.status && a.contentType?.startsWith('text/event-stream') && a.error === null && a.events[0] === 'progress' && a.events.at(-1) === 'result' && a.events.includes('progress'));
  if (!data) throw new Error(`${name}: ${feature} stream did not contain a result event: ${bodyText.slice(-1000)}`);
  await page.locator('.aibar[data-ui="preview"]').waitFor({ timeout: 15_000 });
  await page.locator('.ailive-row').waitFor({ timeout: 15_000 });
  await fitPreviewIntoView(page, data.proposal);
  await page.waitForFunction(() => Boolean(document.querySelector('.ailive-row:not([hidden])')) && Boolean(window.__board.r.overlay.ai), null, { timeout: 10_000 });
  return { events, data, proposal: slimProposal(data.proposal), runId: data.runId };
}

async function fitPreviewIntoView(page, proposal) {
  await page.evaluate((p) => {
    const app = window.__board;
    const content = app.r.contentBounds();
    const right = content ? content.x + content.w : 0;
    const top = content ? content.y : 0;
    let w = 0;
    let h = 0;
    if (p.kind === 'create') {
      const cols = Math.max(1, Math.ceil(Math.sqrt(p.objects.length)));
      const rows = Math.max(1, Math.ceil(p.objects.length / cols));
      const pad = p.frame ? 48 : 0;
      w = cols * 216 - 24 + 2 * pad;
      h = rows * 216 - 24 + 2 * pad;
    } else {
      w = p.groups.length * 240 - 48;
      h = Math.max(32, ...p.groups.map((g) => 32 + 16 + Math.max(0, g.ids.length - 1) * 216 + 192));
    }
    const x = Math.round(right + 80);
    const bounds = content ? {
      x: Math.min(content.x, x), y: Math.min(content.y, top),
      w: Math.max(content.x + content.w, x + w) - Math.min(content.x, x),
      h: Math.max(content.y + content.h, top + h) - Math.min(content.y, top),
    } : { x, y: top, w, h };
    app.r.fit(bounds, 72, 0.9);
  }, proposal);
}

async function openReview(target) {
  const { page } = target;
  const ownReview = page.locator('.aibar-actions').getByRole('button', { name: 'Review', exact: true });
  if (await ownReview.count()) await ownReview.click();
  else await page.locator('.ailive-row').getByRole('button', { name: 'Review', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Review the AI proposal' });
  await panel.waitFor({ timeout: 10_000 });
  return panel;
}

async function saveShot(target, file) {
  const { page, width, name } = target;
  // Fixed page time keeps app timers stable; hide only the transient toast in the captured image (never click its action).
  await page.evaluate(() => document.querySelector('.toast')?.classList.remove('show'));
  await page.mouse.move(1, 1);
  await page.evaluate(async () => {
    document.activeElement?.blur?.();
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const fullPath = path.join(SHOTS, file);
  await page.screenshot({ path: fullPath, animations: 'disabled', caret: 'hide' });
  produced.push(fullPath);
  note(`${name}: screenshot ${file} (${width}x${width <= 500 ? 844 : 800})`, 'PASS', fullPath);
}

async function showPropertiesFor(target, objectId) {
  const { page } = target;
  await page.evaluate((id) => window.__board.setSelection([id]), objectId);
  const more = page.getByRole('button', { name: 'More properties', exact: true });
  await more.waitFor({ timeout: 10_000 });
  await more.click();
  await page.locator('.props.show').waitFor({ timeout: 10_000 });
  const origin = page.locator('.props-origin');
  await origin.waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const line = document.querySelector('.props-origin');
    if (!line) return false;
    line.scrollIntoView({ block: 'center' });
    return true;
  }, null, { timeout: 10_000 });
}

async function screenshotScenario(width) {
  const boardId = `tab160-single-${width}`;
  const target = await openBoard(boardId, width, `Reviewer ${width}`, '#2F6FED');
  try {
    await seedBoard(target.page, `TAB-160 review ${width}`);
    const run = await runFeature(target, 'generate');
    const expected = {
      kind: 'create', objects: GENERATED, frame: { title: 'Summary' },
    };
    check(`A.${width}: ready CREATE proposal has five stickies and Summary frame`, slimProposal(run.data.proposal), expected);
    const closedState = await target.page.evaluate(() => ({
      ui: document.querySelector('.aibar')?.getAttribute('data-ui'),
      panelOpen: Boolean(document.querySelector('.aireview')),
      reviewVisible: [...document.querySelectorAll('.aibar-actions button')].some((b) => b.textContent?.trim() === 'Review' && b.getClientRects().length > 0),
      ghosts: window.__board.r.overlay.ai ?? '',
    }));
    const closedText = ghostText(closedState.ghosts);
    check(`A.${width}: ready state and closed panel with ghosts and Review button`, {
      ui: closedState.ui, panelOpen: closedState.panelOpen, reviewVisible: closedState.reviewVisible,
      ghostTexts: GENERATED.map((o) => closedText.includes(o.text)), summaryGhost: closedText.includes('Summary'),
    }, { ui: 'preview', panelOpen: false, reviewVisible: true, ghostTexts: [true, true, true, true, true], summaryGhost: true });
    await saveShot(target, `01-create-closed-${width}.png`);

    const panel = await openReview(target);
    check(`A.${width}: untouched create review keeps five stickies and frame`, await panel.evaluate((el) => ({
      checkedStickies: [...el.querySelectorAll('input[aria-label^="Keep sticky"]')].filter((e) => e.checked).length,
      frameChecked: el.querySelector('[aria-label="Put the stickies in a frame"]')?.checked ?? false,
      add: el.querySelector('.aireview-foot .btn.primary')?.textContent?.trim(),
    })), { checkedStickies: 5, frameChecked: true, add: 'Add all (5)' });
    await saveShot(target, `02-review-untouched-${width}.png`);

    await panel.locator('[aria-label="Keep sticky 2"]').uncheck();
    await panel.locator('[aria-label="Sticky 3 text"]').fill(EDITED_TEXT);
    await panel.locator('[aria-label="Sticky 4 colour"]').getByRole('radio', { name: 'Blue', exact: true }).click();
    await waitForGhostText(target.page, EDITED_TEXT);
    await waitForGhostColor(target.page, '#A3D2FF');
    await panel.evaluate((el) => {
      const body = el.querySelector('.aireview-body');
      const row = el.querySelector('[aria-label="Keep sticky 2"]')?.closest('li');
      if (body && row) body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    });
    const reviewGhosts = await ghostMarkup(target.page);
    check(`A.${width}: edits and untick update the ghost preview`, {
      editedTextShown: ghostText(reviewGhosts).includes(EDITED_TEXT),
      uncheckedTextHidden: !ghostText(reviewGhosts).includes(UNCHECKED_TEXT),
      blueFillShown: reviewGhosts.toLowerCase().includes('#a3d2ff'),
      summaryFrameShown: reviewGhosts.includes('Summary'),
      addLabel: await panel.locator('.aireview-foot .btn.primary').textContent(),
    }, { editedTextShown: true, uncheckedTextHidden: true, blueFillShown: true, summaryFrameShown: true, addLabel: 'Add selected (4)' }, (a, e) =>
      a.editedTextShown === e.editedTextShown && a.uncheckedTextHidden === e.uncheckedTextHidden && a.blueFillShown === e.blueFillShown && a.summaryFrameShown === e.summaryFrameShown && a.addLabel.trim() === e.addLabel);
    await saveShot(target, `03-review-edited-${width}.png`);

    await panel.getByRole('button', { name: 'Add selected (4)', exact: true }).click();
    await target.page.locator('.aibar[data-ui="idle"]').waitFor({ timeout: 15_000 });
    await target.page.waitForFunction(() => {
      const all = [...window.__board.store.cache.values()];
      const generated = all.filter((o) => o.proposedBy?.feature === 'generate');
      return generated.some((o) => o.type === 'sticky') ? generated.map((o) => ({ type: o.type, text: o.text ?? null, name: o.name ?? null, proposedBy: o.proposedBy })) : false;
    }, null, { timeout: 15_000 });
    const addedObjects = await target.page.evaluate(() => [...window.__board.store.cache.values()]
      .filter((o) => o.proposedBy?.feature === 'generate')
      .map((o) => ({ id: o.id, type: o.type, text: o.text ?? null, name: o.name ?? null, fill: o.fill ?? null, proposedBy: o.proposedBy })));
    const addedStickies = addedObjects.filter((o) => o.type === 'sticky');
    check(`A.${width}: Add selected stores only the reviewed sticky subset and frame`, {
      stickyTexts: addedStickies.map((o) => o.text).sort(),
      colorOfChangedItem: addedStickies.find((o) => o.text === GENERATED[3].text)?.fill,
      frames: addedObjects.filter((o) => o.type === 'frame').map((o) => o.name),
      proposedBy: addedStickies.every((o) => o.proposedBy?.feature === 'generate' && o.proposedBy?.by?.name === `Reviewer ${width}`),
      untouchedTextCount: addedStickies.filter((o) => o.text === UNCHECKED_TEXT).length,
    }, {
      stickyTexts: [GENERATED[0].text, EDITED_TEXT, GENERATED[3].text, GENERATED[4].text].sort(),
      colorOfChangedItem: '#A3D2FF',
      frames: ['Summary'], proposedBy: true, untouchedTextCount: 0,
    });
    const selected = addedStickies[0];
    check(`A.${width}: stored proposedBy carries feature and reviewer name`, selected.proposedBy, {
      feature: 'generate', by: { id: null, name: `Reviewer ${width}` },
    });
    await showPropertiesFor(target, selected.id);
    const origin = await target.page.locator('.props-origin').textContent();
    check(`A.${width}: properties panel shows Proposed by AI line`, origin, `Proposed by AI (Generate ideas) for Reviewer ${width}`);
    await saveShot(target, `05-added-properties-${width}.png`);

    await target.page.locator('.rail-btn[aria-label="Undo"]').click();
    await target.page.waitForFunction(() => ![...window.__board.store.cache.values()].some((o) => o.proposedBy?.feature === 'generate'), null, { timeout: 10_000 });
    check(`A.${width}: reset after the Add screenshot leaves only five seed notes`, await target.page.evaluate(() => ({
      seedCount: [...window.__board.store.cache.values()].filter((o) => o.id.startsWith('seed-note-')).length,
      generatedCount: [...window.__board.store.cache.values()].filter((o) => o.proposedBy?.feature === 'generate').length,
    })), { seedCount: 5, generatedCount: 0 });

    const allOffRun = await runFeature(target, 'generate', 'Generate a second set of project follow-ups.');
    check(`A.${width}: second CREATE proposal ready for all-off review`, slimProposal(allOffRun.data.proposal), expected);
    const allOffPanel = await openReview(target);
    await allOffPanel.locator('[aria-label="Put the stickies in a frame"]').uncheck();
    for (let i = 1; i <= 5; i++) await allOffPanel.locator(`[aria-label="Keep sticky ${i}"]`).uncheck();
    check(`A.${width}: all items unticked disables Add`, await allOffPanel.evaluate((el) => ({
      checkboxes: [...el.querySelectorAll('input[type="checkbox"]')].map((e) => e.checked),
      addLabel: el.querySelector('.aireview-foot .btn.primary')?.textContent?.trim(),
      addDisabled: el.querySelector('.aireview-foot .btn.primary')?.getAttribute('aria-disabled'),
    })), { checkboxes: [false, false, false, false, false, false], addLabel: 'Add selected (0)', addDisabled: 'true' });
    await saveShot(target, `06-review-all-unticked-${width}.png`);
    await allOffPanel.getByRole('button', { name: 'Discard', exact: true }).click();
    await target.page.locator('.aireview').waitFor({ state: 'detached', timeout: 10_000 });

    const peer = await openBoard(boardId, width, `Peer ${width}`, '#D64545');
    try {
      await waitForBoardIds(peer.page, BASE_IDS);
      const groupRun = await runFeature(target, 'cluster');
      check(`A.${width}: ready GROUP proposal covers the five selected source stickies`, slimProposal(groupRun.data.proposal), {
        kind: 'group', groups: [
          { title: 'Keep doing', ids: ['seed-note-1', 'seed-note-2'] },
          { title: 'Improve next', ids: ['seed-note-3', 'seed-note-4', 'seed-note-5'] },
        ],
      });
      await peer.page.evaluate(({ id, text }) => {
        const app = window.__board;
        app.store.transact(() => app.store.update(id, { text }));
      }, { id: 'seed-note-2', text: CHANGED_PEER_TEXT });
      await target.page.waitForFunction((text) => window.__board.store.get('seed-note-2')?.text === text, CHANGED_PEER_TEXT, { timeout: 15_000 });
      const groupPanel = await openReview(target);
      await groupPanel.getByText('Changed since', { exact: true }).waitFor({ timeout: 10_000 });
      check(`A.${width}: peer edit marks the group member Changed since and unticked`, await groupPanel.evaluate((el) => {
        const row = [...el.querySelectorAll('.aireview-member')].find((li) => li.textContent?.includes('Changed since'));
        const box = row?.querySelector('input[type="checkbox"]');
        return { tag: row?.querySelector('.aireview-tag')?.textContent?.trim() ?? null, checked: box?.checked ?? null, disabled: box?.disabled ?? null, label: row?.querySelector('.aireview-member-text')?.textContent?.trim() ?? null };
      }), { tag: 'Changed since', checked: false, disabled: true, label: CHANGED_PEER_LABEL });
      await saveShot(target, `04-group-changed-since-${width}.png`);
      await groupPanel.getByRole('button', { name: 'Discard', exact: true }).click();
      await target.page.locator('.aireview').waitFor({ state: 'detached', timeout: 10_000 });
    } finally {
      await peer.context.close().catch(() => undefined);
      const ix = contexts.indexOf(peer.context);
      if (ix >= 0) contexts.splice(ix, 1);
    }
  } finally {
    await target.context.close().catch(() => undefined);
    const ix = contexts.indexOf(target.context);
    if (ix >= 0) contexts.splice(ix, 1);
  }
}

async function multiplayerScenario() {
  const boardId = 'tab160-multiplayer';
  const a = await openBoard(boardId, 1024, 'Person A', '#2F6FED');
  let b = null;
  try {
    await seedBoard(a.page, 'TAB-160 two-person review');
    b = await openBoard(boardId, 1024, 'Person B', '#D64545');
    await waitForBoardIds(b.page, BASE_IDS);
    const run = await runFeature(a, 'generate');
    check('B.multiplayer: A run produces the original five-item CREATE proposal', slimProposal(run.data.proposal), {
      kind: 'create', objects: GENERATED, frame: { title: 'Summary' },
    });
    await waitForGhostText(b.page, 'Clarify the migration goals');
    await fitPreviewIntoView(b.page, run.data.proposal);
    await b.page.waitForFunction(() => Boolean(document.querySelector('.ailive-row:not([hidden])')), null, { timeout: 10_000 });
    await fitPreviewIntoView(a.page, run.data.proposal);
    check('B.multiplayer: both contexts see the original ready preview', await Promise.all([previewSnapshot(a.page), previewSnapshot(b.page)]), [
      { row: true, allGhosts: true }, { row: true, allGhosts: true },
    ]);
    await saveShot(a, 'mp-01-A-preview-original.png');
    await saveShot(b, 'mp-01-B-preview-original.png');

    const panel = await openReview(b);
    await panel.locator('[aria-label="Keep sticky 2"]').uncheck();
    await panel.locator('[aria-label="Sticky 3 text"]').fill(EDITED_TEXT);
    await panel.locator('[aria-label="Sticky 4 colour"]').getByRole('radio', { name: 'Blue', exact: true }).click();
    await waitForGhostText(b.page, EDITED_TEXT);
    await waitForGhostColor(b.page, '#A3D2FF');
    const bGhost = await ghostMarkup(b.page);
    const aGhost = await ghostMarkup(a.page);
    check('B.multiplayer: B local review changes B ghosts only', {
      bShowsEdit: ghostText(bGhost).includes(EDITED_TEXT),
      bHidesUnticked: !ghostText(bGhost).includes(UNCHECKED_TEXT),
      bShowsBlue: bGhost.toLowerCase().includes('#a3d2ff'),
      aShowsOriginal: GENERATED.every((o) => ghostText(aGhost).includes(o.text)) && !ghostText(aGhost).includes(EDITED_TEXT),
      bAdd: await panel.locator('.aireview-foot .btn.primary').textContent(),
    }, { bShowsEdit: true, bHidesUnticked: true, bShowsBlue: true, aShowsOriginal: true, bAdd: 'Add selected (4)' }, (x, e) =>
      x.bShowsEdit === e.bShowsEdit && x.bHidesUnticked === e.bHidesUnticked && x.bShowsBlue === e.bShowsBlue && x.aShowsOriginal === e.aShowsOriginal && x.bAdd.trim() === e.bAdd);
    await saveShot(b, 'mp-02-B-reviewed-local.png');
    await saveShot(a, 'mp-02-A-still-original.png');

    await panel.getByRole('button', { name: 'Add selected (4)', exact: true }).click();
    await b.page.locator('.aibar[data-ui="idle"]').waitFor({ timeout: 15_000 });
    await a.page.locator('.aibar[data-ui="idle"]').waitFor({ timeout: 15_000 });
    const expectedTexts = [GENERATED[0].text, EDITED_TEXT, GENERATED[3].text, GENERATED[4].text].sort();
    await Promise.all([a.page, b.page].map((p) => p.waitForFunction((expected) => {
      const texts = [...window.__board.store.cache.values()].filter((o) => o.type === 'sticky' && o.proposedBy?.feature === 'generate').map((o) => o.text).sort();
      return texts.length === expected.length && JSON.stringify(texts) === JSON.stringify(expected);
    }, expectedTexts, { timeout: 20_000 })));
    const afterAdd = await Promise.all([a, b].map(async (person) => {
      const objects = await boardObjects(person.page);
      const added = objects.filter((o) => o.proposedBy?.feature === 'generate');
      return {
        name: person.name,
        texts: added.filter((o) => o.type === 'sticky').map((o) => o.text).sort(),
        frameNames: added.filter((o) => o.type === 'frame').map((o) => o.name),
        ids: added.map((o) => o.id).sort(),
        allProposedBy: added.filter((o) => o.type === 'sticky').every((o) => o.proposedBy?.feature === 'generate' && o.proposedBy?.by?.name === 'Person A'),
        previewGone: !await person.page.locator('.ailive-row').count(),
        ui: await person.page.locator('.aibar').getAttribute('data-ui'),
      };
    }));
    check('B.multiplayer: reviewed subset is stored once and synchronized to both people', afterAdd, [
      { name: 'Person A', texts: expectedTexts, frameNames: ['Summary'], ids: afterAdd[0].ids, allProposedBy: true, previewGone: true, ui: 'idle' },
      { name: 'Person B', texts: expectedTexts, frameNames: ['Summary'], ids: afterAdd[0].ids, allProposedBy: true, previewGone: true, ui: 'idle' },
    ], (actual, expected) => actual.length === 2 && actual.every((x, i) =>
      x.name === expected[i].name && isDeepStrictEqual(x.texts, expectedTexts) && isDeepStrictEqual(x.frameNames, ['Summary']) &&
      isDeepStrictEqual(x.ids, expected[i].ids) && x.allProposedBy && x.previewGone && x.ui === 'idle') &&
      afterAdd[0].ids.length === 5 && afterAdd[0].ids.every((id) => afterAdd[1].ids.includes(id)));
    check('B.multiplayer: relay accepted run disappeared from A', await a.page.evaluate(() => ({
      previewRows: document.querySelectorAll('.ailive-row').length,
      previewState: document.querySelector('.aibar')?.getAttribute('data-ui'),
    })), { previewRows: 0, previewState: 'idle' });
    const oneAdded = await b.page.evaluate(() => [...window.__board.store.cache.values()].find((o) => o.type === 'sticky' && o.proposedBy?.feature === 'generate')?.id ?? null);
    await showPropertiesFor(b, oneAdded);
    check('B.multiplayer: stored AI attribution is readable in properties', await b.page.locator('.props-origin').textContent(), 'Proposed by AI (Generate ideas) for Person A');
    await saveShot(a, 'mp-03-A-after-add.png');
    await saveShot(b, 'mp-03-B-after-add.png');

    await b.page.keyboard.press('Meta+z');
    await Promise.all([a.page, b.page].map((p) => p.waitForFunction(() => ![...window.__board.store.cache.values()].some((o) => o.proposedBy?.feature === 'generate'), null, { timeout: 20_000 })));
    const afterUndo = await Promise.all([a, b].map(async (person) => ({
      name: person.name,
      aiObjects: (await boardObjects(person.page)).filter((o) => o.proposedBy?.feature === 'generate').length,
      seedNotes: (await boardObjects(person.page)).filter((o) => o.id.startsWith('seed-note-')).length,
      previewRows: await person.page.locator('.ailive-row').count(),
    })));
    check('B.multiplayer: one Undo removes all added objects for both contexts', afterUndo, [
      { name: 'Person A', aiObjects: 0, seedNotes: 5, previewRows: 0 },
      { name: 'Person B', aiObjects: 0, seedNotes: 5, previewRows: 0 },
    ]);
    await saveShot(b, 'mp-04-B-after-one-undo.png');
    await saveShot(a, 'mp-04-A-after-peer-undo.png');
  } finally {
    if (b) {
      await b.context.close().catch(() => undefined);
      const ix = contexts.indexOf(b.context);
      if (ix >= 0) contexts.splice(ix, 1);
    }
    await a.context.close().catch(() => undefined);
    const ix = contexts.indexOf(a.context);
    if (ix >= 0) contexts.splice(ix, 1);
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  DIST = ensureBuilt(options['no-build']);
  const { chromium } = await import('playwright').catch(() => {
    throw new Error('playwright is not installed. Run npm ci, then once: npx playwright install chromium');
  });
  browser = await launchBrowser(chromium);
  stub = await startAnthropicStub({ apiKey: API_KEY, model: MODEL, answers: { generate: { objects: GENERATED, frame: { title: 'Summary' } }, cluster: GROUP_PROPOSAL } });
  relay = await startRelay(stub.base);
  const cfg = await fetch(`${relay.base}/api/ai/config`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
  check('setup: Open mode enables the requested AI model', { enabled: cfg.enabled, model: cfg.model, features: cfg.features }, {
    enabled: true, model: MODEL, features: ['generate', 'summarise', 'cluster'],
  }, (a, e) => a.enabled === e.enabled && a.model === e.model && ['generate', 'summarise', 'cluster'].every((f) => a.features?.includes(f)));

  for (const width of [390, 1024]) {
    try {
      await screenshotScenario(width);
    } catch (err) {
      note(`A.${width}: scenario execution`, 'FAIL', err?.stack ?? String(err));
    }
  }
  try {
    await multiplayerScenario();
  } catch (err) {
    note('B.multiplayer: scenario execution', 'FAIL', err?.stack ?? String(err));
  }

  check('setup: every provider call went to the local Anthropic stub', {
    count: stub.calls.length,
    hosts: [...new Set(stub.calls.map((c) => c.path))],
    models: [...new Set(stub.calls.map((c) => c.model))],
    keysMatched: stub.calls.every((c) => c.apiKeyMatched),
    features: stub.calls.map((c) => c.feature),
    formats: stub.calls.map((c) => c.requestFormat),
  }, {
    count: 7,
    hosts: ['/v1/messages'],
    models: [MODEL],
    keysMatched: true,
    features: ['generate', 'generate', 'cluster', 'generate', 'generate', 'cluster', 'generate'],
    formats: ['json_schema', 'json_schema', 'json_schema', 'json_schema', 'json_schema', 'json_schema', 'json_schema'],
  }, (a, e) => a.count === e.count && isDeepStrictEqual(a.hosts, e.hosts) && isDeepStrictEqual(a.models, e.models) && a.keysMatched && isDeepStrictEqual(a.features, e.features) && isDeepStrictEqual(a.formats, e.formats));
}

async function cleanup() {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopOwnedRelay(relay).catch((err) => note('cleanup: relay', 'FAIL', String(err)));
  if (stub?.server) await new Promise((resolve) => stub.server.close(resolve));
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

try {
  await main();
} catch (err) {
  note('setup execution', 'BLOCKED', err?.stack ?? String(err));
} finally {
  await cleanup();
}

for (const entry of report) {
  const actual = shown(entry.actual);
  const expected = entry.expected === undefined ? '' : ` | expected=${shown(entry.expected)}`;
  console.log(`${entry.status} ${entry.name}: actual=${actual}${expected}`);
}
for (const page of pageLogs) {
  console.log(`CONSOLE ${page.name} ${page.width}px: ${JSON.stringify(page.errors.console)}`);
  console.log(`PAGEERROR ${page.name} ${page.width}px: ${JSON.stringify(page.errors.page)}`);
  if (page.errors.failedRequests.length) console.log(`REQUESTFAIL ${page.name} ${page.width}px: ${JSON.stringify(page.errors.failedRequests)}`);
}
console.log('FILES:');
for (const file of produced) console.log(file);
const counts = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED'].map((status) => [status, report.filter((r) => r.status === status).length]));
console.log(`REPORT: PASS=${counts.PASS} FAIL=${counts.FAIL} BLOCKED=${counts.BLOCKED} screenshots=${produced.length} provider_calls=${stub?.calls.length ?? 0}`);
if (report.some((r) => r.status === 'FAIL' || r.status === 'BLOCKED')) process.exitCode = 1;
