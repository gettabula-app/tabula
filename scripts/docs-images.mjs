// Re-creates the screenshots in docs/images (README and user guide) from the built app, in headless Chromium, with
// fixed demo data and no shared browser. It starts throwaway relays (open, accounts and chat modes) in temporary
// data folders and stops them at the end. Usage and notes: docs/visual-check.md ("Docs images").
//   npm run docs:images                      all images, into docs/images
//   npm run docs:images -- --only share-roles,signin --out /tmp/shots
//   npm run docs:images -- --only admin-backups,chat-tray,chat-page,kanban-card-dialog,layers-panel
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openDirectory } from '../server/directory.mjs';
import { openChat } from '../server/chat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_EMAIL = 'maya@example.test';
const ANA_EMAIL = 'ana@example.test';
// A recent fixed date, so the dates in the shots look current; the browser clock and the seeded data share it.
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const SCALE = 2;
const OPEN_USER = { id: 'docs-user', name: 'Lena Lund', color: '#D64545' };
const ANA_USER = { name: 'Ana', color: '#E8743B' };
const CHAT_OWNER = 'docs-chat-owner';
const CHAT_REVIEWER = 'docs-chat-reviewer';

const { values: opts } = parseArgs({ options: { only: { type: 'string' }, out: { type: 'string' }, 'no-build': { type: 'boolean' } } });
const outDir = path.resolve(opts.out ?? path.join(root, 'docs', 'images'));
const only = opts.only ? new Set(opts.only.split(',')) : null;

// ---------------------------------------------------------------- relays

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function startRelay(mode, distDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `tabula-docs-${mode}-`));
  if (mode === 'chat') {
    // Avatar colours come from user IDs. Seed fixed, synthetic identities before this isolated relay starts.
    const file = path.join(dataDir, 'directory.sqlite');
    const directory = openDirectory(file);
    try {
      // The browser clock is fixed, while relay maintenance uses real time: never expire these demo messages.
      directory.setSetting('chat.retentionDays', 'forever');
    } finally {
      directory.close();
    }
    const db = new DatabaseSync(file);
    try {
      const insert = db.prepare('INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)');
      insert.run(CHAT_OWNER, OWNER_EMAIL, 'Maya', 'owner', NOW);
      insert.run(CHAT_REVIEWER, ANA_EMAIL, 'Ana', 'member', NOW);
    } finally {
      db.close();
    }
  }
  // Let the OS assign each screenshot relay a port so concurrent runs cannot claim the same fixed port.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // nothing from the caller's shell may reach the relay
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: distDir, QUIET: '1' });
  if (mode === 'accounts' || mode === 'chat') Object.assign(env, { TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: OWNER_EMAIL, TABULA_BASE_URL: base, ...(mode === 'accounts' ? { TABULA_MCP: 'on', TABULA_AI_SECRET: crypto.randomBytes(32).toString('base64') } : {}) });
  if (mode === 'chat') env.TABULA_CHAT = 'on';
  let stderr = '';
  const child = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (c) => (stderr += String(c)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the ${mode} relay stopped at start:\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`the ${mode} relay did not answer in 20 seconds`);
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  return { base, dataDir, child };
}

async function stopRelay(relay) {
  if (!relay) return;
  const { child } = relay;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(relay.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ---------------------------------------------------------------- accounts data

async function api(base, who, method, route, body) {
  const headers = { 'content-type': 'application/json', 'x-tabula': '1', origin: base, ...(who ? { cookie: who.cookie } : {}) };
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${text}`);
  return { json: text ? JSON.parse(text) : null, res };
}

async function signIn(relay, email, invite) {
  const outbox = path.join(relay.dataDir, 'outbox.jsonl');
  const seen = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0;
  await api(relay.base, null, 'POST', '/api/auth/request', { email, ...(invite ? { invite } : {}) });
  let token = null;
  for (let i = 0; i < 100 && !token; i++) {
    const rows = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(seen) : [];
    const row = rows.map((r) => JSON.parse(r)).find((r) => JSON.stringify(r).includes(email));
    token = row && /token=([A-Za-z0-9_-]+)/.exec(row.text)?.[1];
    if (!token) await sleep(100);
  }
  if (!token) throw new Error(`no sign-in mail for ${email}`);
  const { json, res } = await api(relay.base, null, 'POST', '/api/auth/verify', { token });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { cookie, user: json.user };
}

/** Maya owns the workspace, Ana is in the Design team. Fixed names, titles and roles. */
async function seedAccounts(relay) {
  const b = relay.base;
  const owner = await signIn(relay, OWNER_EMAIL);
  await api(b, owner, 'PATCH', '/api/me', { name: 'Maya' });
  const design = (await api(b, owner, 'POST', '/api/teams', { name: 'Design' })).json;
  const invite = (await api(b, owner, 'POST', `/api/teams/${design.id}/invites`, { role: 'member', days: 7 })).json;
  const ana = await signIn(relay, ANA_EMAIL, invite.token);
  await api(b, ana, 'PATCH', '/api/me', { name: ANA_USER.name });
  const board = (id, title, extra = {}) => api(b, owner, 'POST', '/api/boards', { id, title, ...extra });
  const research = (await api(b, owner, 'POST', '/api/teams', { name: 'Research' })).json;
  const samInvite = (await api(b, owner, 'POST', `/api/teams/${research.id}/invites`, { role: 'member', days: 7 })).json;
  const sam = await signIn(relay, 'sam@example.test', samInvite.token);
  await api(b, sam, 'PATCH', '/api/me', { name: 'Sam' });
  await board('retro', 'Sprint retro', { teamId: design.id });
  await board('roadmap', 'Roadmap 2026', { teamId: design.id });
  await board('quarterly', 'Quarterly numbers');
  await api(b, owner, 'POST', '/api/boards/quarterly/shares', { principalType: 'user', principalId: ana.user.id, role: 'viewer' });
  await board('teamnote', 'Team board');
  await api(b, owner, 'POST', '/api/boards/teamnote/shares', { principalType: 'user', principalId: ana.user.id, role: 'editor' });
  await api(b, ana, 'POST', '/api/boards', { id: 'ana-ideas', title: 'Workshop ideas' });
  await api(b, owner, 'POST', '/api/boards/roadmap/shares', { principalType: 'team', principalId: design.id, role: 'editor' });
  await api(b, owner, 'POST', '/api/boards/roadmap/shares', { principalType: 'user', principalId: ana.user.id, role: 'commenter' });
  return { owner, ana, design };
}

/** Real chat storage and HTTP reads, with fixed times, IDs and synthetic participants for repeatable pixels. */
async function seedGuideChat(relay) {
  const owner = await signIn(relay, OWNER_EMAIL);
  await api(relay.base, owner, 'POST', '/api/boards', { id: 'docs-chat', title: 'Design review' });
  await api(relay.base, owner, 'POST', '/api/boards/docs-chat/shares', { principalType: 'user', principalId: CHAT_REVIEWER, role: 'editor' });
  const chat = openChat(path.join(relay.dataDir, 'chat.sqlite'));
  try {
    const say = (authorId, authorName, body, minutesAgo, extra = {}) => chat.insertMessage({
      kind: 'board', ref: 'docs-chat', authorId, authorName, body, clientId: `docs-chat-${minutesAgo}`,
      now: NOW - minutesAgo * 60_000, ...extra,
    }).message.id;
    const question = say(CHAT_REVIEWER, 'Ana', 'Can we review the launch plan today?', 12, { objectId: 'docs-chat-plan' });
    const reply = say(CHAT_OWNER, 'Maya', `Yes! @{${CHAT_REVIEWER}} the notes are ready.`, 10, { replyTo: question, mentions: [CHAT_REVIEWER] });
    chat.setReaction(reply, CHAT_REVIEWER, '👍', true);
    say(CHAT_REVIEWER, 'Ana', 'The checklist covers the last two actions.', 8, { objectId: 'docs-chat-checklist' });
    say(CHAT_OWNER, 'Maya', 'Looks good. Let’s share it with the team.', 6, { replyTo: reply });
  } finally {
    chat.close();
  }
  return { owner };
}

/** No real backup bucket or keys: only the list response is stubbed, matching the guide’s three states. */
const GUIDE_BACKUPS = {
  backups: [
    { name: '20260115T093000Z.json.enc', createdAt: NOW - 30 * 60_000, readable: true, files: 14, bytes: 4_823_552, keyId: 'a1b2c3d4', protected: true, protectedUntil: NOW + 7 * 86_400_000 },
    { name: '20260115T083000Z.json.enc', createdAt: NOW - 90 * 60_000, readable: false, error: 'unknown_key', protected: false, protectedUntil: null },
    { name: '20260114T100000Z.json.enc', createdAt: NOW - 86_400_000, readable: false, error: 'tamper', protected: false, protectedUntil: null },
  ],
  truncated: false,
  status: {
    lastSuccessAt: NOW - 30 * 60_000, lastFailureAt: null, lastFailureError: null, consecutiveFailures: 0,
    nextRunAt: NOW + 30 * 60_000, running: false, intervalMinutes: 60, keyId: 'a1b2c3d4', bytesStored: 18_874_368, objects: 52, manifests: 3,
  },
  restore: { inProgress: null, maintenance: false, last: null, protectedBackups: [], oldData: [] },
};

// ---------------------------------------------------------------- browser

const fontCache = new Map();
async function serveOutside(route) {
  const url = new URL(route.request().url());
  if (!url.hostname.endsWith('fontshare.com')) return route.abort();
  if (!fontCache.has(url.href)) {
    fontCache.set(url.href, route.fetch({ timeout: 8000 }).then(async (res) => ({
      status: res.status(),
      headers: Object.fromEntries(Object.entries(res.headers()).filter(([n]) => !/^(content-encoding|content-length|transfer-encoding)$/.test(n))),
      body: await res.body(),
    }), () => null));
  }
  const cached = await fontCache.get(url.href);
  return cached ? route.fulfill(cached) : route.abort();
}

const pages = []; // every page of the current shot, so a failure can leave a picture of where it stopped

/** A fresh context: fixed clock, locale, zone and theme, motion off, no service worker, outside hosts refused. */
async function newPage(browser, { base, width, height, theme = 'default', user, session, clock = NOW }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: SCALE, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  await context.clock.setFixedTime(clock);
  await context.route((url) => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', serveOutside);
  await context.addInitScript(({ themeId, who }) => {
    try {
      localStorage.setItem('driftboard:theme', themeId);
      if (who) localStorage.setItem('driftboard:user', JSON.stringify(who));
    } catch {
      /* storage is not available in this frame */
    }
  }, { themeId: theme, who: user ?? null });
  if (session) {
    for (const pair of session.cookie.split('; ')) {
      const eq = pair.indexOf('=');
      await context.addCookies([{ name: pair.slice(0, eq), value: pair.slice(eq + 1), url: base, httpOnly: true, sameSite: 'Lax' }]);
    }
  }
  const page = await context.newPage();
  pages.push(page);
  return { context, page };
}

async function openBoard(page, base, id) {
  await page.goto(`${base}/?debug#/b/${id}`);
  await page.waitForFunction(() => window.__board, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const provider = window.__board.conn.provider;
    return !provider || provider.synced;
  }, null, { timeout: 15_000 });
}

const park = (page) => page.mouse.move(2, 2);
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await sleep(250);
};

/** Fixed demo content. Positions in board units; the callers fit the view. */
const seeds = {
  layers: (app) => {
    const z = app.store.topZs(5);
    app.store.transact(() => {
      app.store.create({ id: 'docs-frame', type: 'frame', name: 'Sprint ideas', x: 0, y: 0, w: 480, h: 260, rotation: 0, z: z[0], fill: '#FFFFFF' });
      app.store.create({ id: 'docs-frame-note-1', type: 'sticky', parent: 'docs-frame', text: 'Make onboarding simpler', x: 24, y: 40, w: 192, h: 192, rotation: 0, z: z[1], fill: '#FFE16B', fontSize: 18 });
      app.store.create({ id: 'docs-frame-note-2', type: 'sticky', parent: 'docs-frame', text: 'Share a weekly update', x: 248, y: 40, w: 192, h: 192, rotation: 0, z: z[2], fill: '#8FE3CA', fontSize: 18 });
      app.store.create({ id: 'docs-layer-box', type: 'shape', kind: 'rect', name: 'Next steps', text: 'Next steps', x: 80, y: 320, w: 160, h: 64, rotation: 0, z: z[3], fill: '#FFFFFF', stroke: '#18212B', strokeWidth: 2 });
      app.store.create({ id: 'docs-layer-title', type: 'text', text: 'Team workshop', x: 0, y: -64, w: 320, h: 28, rotation: 0, z: z[4], fontSize: 24 });
    });
  },
  kanban: (app) => {
    const z = app.store.topZs(3);
    const base = { x: 0, y: 0, rotation: 0 };
    const card = { ...base, id: 'docs-card', type: 'card', parent: 'docs-lane', rank: 'a0@docs-lane', z: z[2], w: 264,
      text: 'Prepare the launch checklist', desc: 'Review the welcome screen and write a short guide for the team.\n\nShare the draft before Friday’s review.',
      ownerId: 'docs-reviewer', ownerName: 'Ana', due: '2026-01-22', labels: ['docs-label-design', 'docs-label-review'], fill: '#FFE16B' };
    card.h = window.__kanban.cardContentHeight(card, card.w);
    app.store.transact(() => {
      app.store.labels.set('docs-label-design', { id: 'docs-label-design', name: 'Design', color: 'blue', order: 0 });
      app.store.labels.set('docs-label-review', { id: 'docs-label-review', name: 'Review', color: 'violet', order: 1 });
      app.store.create({ ...base, id: 'docs-kanban', type: 'container', layout: 'kanban', name: 'Launch plan', z: z[0], w: 360, h: 500 });
      app.store.create({ ...base, id: 'docs-lane', type: 'lane', parent: 'docs-kanban', rank: 'a0@docs-kanban', name: 'To do', z: z[1], w: 280, h: 300 });
      app.store.create(card);
    });
  },
  chat: (app) => {
    const z = app.store.topZs(2);
    app.store.transact(() => {
      app.store.create({ id: 'docs-chat-plan', type: 'sticky', text: 'Launch plan', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: z[0], fill: '#FFE16B', fontSize: 18 });
      app.store.create({ id: 'docs-chat-checklist', type: 'sticky', text: 'Final checklist', x: 224, y: 0, w: 192, h: 192, rotation: 0, z: z[1], fill: '#8FE3CA', fontSize: 18 });
    });
  },
  // an ellipse with centred text and a plain rectangle next to it (quick actions, text options, lock badge)
  shapes: (app, { lockEllipse = false } = {}) => {
    const z = app.store.topZs(2);
    app.store.transact(() => {
      app.store.create({ id: 'docs-rect', type: 'shape', kind: 'rect', x: 0, y: 20, w: 144, h: 72, rotation: 0, z: z[0], fill: '#FFFFFF', stroke: '#18212B', strokeWidth: 2 });
      app.store.create({ id: 'docs-ellipse', type: 'shape', kind: 'ellipse', x: 216, y: 0, w: 144, h: 96, rotation: 0, z: z[1], fill: '#FFFFFF', stroke: '#18212B', strokeWidth: 2, text: 'Centred while typing', fontSize: 16, locked: lockEllipse || undefined });
    });
  },
  // a sticky, a connector to a white box and a line of text (theme shots)
  theme: (app) => {
    const z = app.store.topZs(4);
    app.store.transact(() => {
      app.store.create({ id: 'docs-note', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: z[0], fill: '#FFE16B', text: 'Sprint goals', fontSize: 18 });
      app.store.create({ id: 'docs-box', type: 'shape', kind: 'rect', x: 240, y: 224, w: 120, h: 120, rotation: 0, z: z[1], fill: '#BFD7FF', stroke: '#18212B', strokeWidth: 2, text: 'Review', fontSize: 18 });
      app.store.create({ id: 'docs-link', type: 'connector', z: z[2], from: { kind: 'bound', id: 'docs-note', anchor: 'right' }, to: { kind: 'bound', id: 'docs-box', anchor: 'top' }, route: 'elbow', startHead: 'none', endHead: 'arrow' });
      app.store.create({ id: 'docs-text', type: 'text', x: -120, y: 360, w: 320, h: 28, rotation: 0, z: z[3], text: 'Plain text on the canvas', fontSize: 18 });
    });
  },
};

/** Put the top-left of the objects' bounds at screen (sx, sy) at the given zoom, so the crop has room where it needs it. */
const placeAt = (page, ids, zoom, sx, sy) =>
  page.evaluate(({ list, z, x, y }) => {
    const app = window.__board;
    const b = app.r.contentBounds(list);
    app.r.setCamera({ zoom: z, x: b.x - x / z, y: b.y - y / z });
    app.setSelection([]);
  }, { list: ids, z: zoom, x: sx, y: sy });

const union = (...rects) => {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};
const pad = (r, n, vw, vh, minY = 0) => {
  const x = Math.max(0, r.x - n), y = Math.max(minY, r.y - n);
  return { x, y, width: Math.min(vw - x, r.width + 2 * n), height: Math.min(vh - y, r.height + 2 * n) };
};
const boxOf = async (locator) => {
  const r = await locator.boundingBox();
  if (!r) throw new Error('an element for the crop is not visible');
  return r;
};
/** The screen rectangle of a board object, from the renderer's own camera. */
const screenRect = (page, id) =>
  page.evaluate((oid) => {
    const app = window.__board;
    const o = app.store.get(oid);
    const s = app.r.size();
    const a = app.r.toScreen({ x: o.x, y: o.y });
    const b = app.r.toScreen({ x: o.x + o.w, y: o.y + o.h });
    return { x: a.x + s.left, y: a.y + s.top, width: b.x - a.x, height: b.y - a.y };
  }, id);

/** The rectangle that holds everything visible on the page (text, controls, pictures, drawn surfaces) plus `pad` px, within the viewport: a crop to the content. */
const contentClip = (page, pad = 24) => page.evaluate((margin) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (r) => { if (r.width > 0 && r.height > 0) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); } };
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const surface = el.matches('button, input, select, textarea, img, svg.canvas, [role="dialog"], .modal, .card, .notice, .board-row, .tray') && el.getBoundingClientRect().width < innerWidth * 0.98;
    if (own || surface) add(el.getBoundingClientRect());
  }
  const x = Math.max(0, Math.floor(x0 - margin)), y = Math.max(0, Math.floor(y0 - margin));
  return { x, y, width: Math.min(innerWidth, Math.ceil(x1 + margin)) - x, height: Math.min(innerHeight, Math.ceil(y1 + margin)) - y };
}, pad);

const save = (page, name, clip) => page.screenshot({ path: path.join(outDir, `${name}.png`), clip, animations: 'disabled', caret: 'hide' });

// ---------------------------------------------------------------- the images

/** The ellipse with its quick-action bar open, on an open-mode board. */
async function shapesBoard(browser, base, { width, height, lock = false, zoom = 1.25, at = [120, 200] }) {
  const { context, page } = await newPage(browser, { base, width, height, user: OPEN_USER });
  await openBoard(page, base, `docs-shapes-${Math.random().toString(36).slice(2, 8)}`);
  await page.evaluate(`(${seeds.shapes.toString()})(window.__board, { lockEllipse: ${lock} })`);
  await placeAt(page, ['docs-rect', 'docs-ellipse'], zoom, at[0], at[1]);
  return { context, page };
}

const SHOTS = {
  async 'quick-actions'({ browser, open }) {
    const W = 1100, H = 460;
    const { context, page } = await shapesBoard(browser, open.base, { width: W, height: H, at: [130, 240] });
    await page.evaluate(() => window.__board.setSelection(['docs-ellipse']));
    const bar = page.locator('.quickbar');
    await bar.waitFor();
    await park(page);
    await settle(page);
    await save(page, 'quick-actions', pad(union(await boxOf(bar), await screenRect(page, 'docs-rect')), 60, W, H, 70));
    await context.close();
  },

  async 'text-options'({ browser, open }) {
    const W = 1100, H = 640;
    const { context, page } = await shapesBoard(browser, open.base, { width: W, height: H, at: [120, 400] });
    await page.evaluate(() => window.__board.setSelection(['docs-ellipse']));
    await page.locator('.quickbar').getByRole('button', { name: 'Text style', exact: true }).click();
    const pop = page.getByText('Text colour', { exact: true });
    await pop.waitFor();
    const panel = page.locator('.popover, .qb-pop, [role="dialog"]').filter({ has: pop }).last();
    await park(page);
    await settle(page);
    const parts = [await boxOf(page.locator('.quickbar')), await boxOf(panel), await screenRect(page, 'docs-rect')];
    await save(page, 'text-options', pad(union(...parts), 40, W, H, 70));
    await context.close();
  },

  async 'locked-badge'({ browser, open }) {
    const W = 900, H = 560;
    const { context, page } = await shapesBoard(browser, open.base, { width: W, height: H, lock: true, zoom: 1.5, at: [300, 220] });
    const r = await screenRect(page, 'docs-ellipse');
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(300);
    await settle(page);
    const rect = await screenRect(page, 'docs-rect');
    await save(page, 'locked-badge', pad(union(rect, r), 70, W, H));
    await context.close();
  },

  async 'shapes-panel'({ browser, open }) {
    const { context, page } = await newPage(browser, { base: open.base, width: 1300, height: 1500, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-shapes-panel');
    await page.getByRole('button', { name: 'Shapes', exact: true }).click();
    const drawer = page.locator('.drawer.show');
    await drawer.waitFor();
    await park(page);
    await settle(page);
    // the panel from its top to just above the closing hint (which the drawer's own scroll box cuts), so no sentence is cut off
    const panel = await boxOf(drawer);
    const hint = await boxOf(drawer.getByText('Hover a shape on the board').first());
    await save(page, 'shapes-panel', { x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, hint.y - panel.y - 8) });
    await context.close();
  },

  async 'themes-menu-matrix'({ browser, open }) {
    const W = 1200, H = 1000;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, theme: 'matrix', user: OPEN_USER });
    await openBoard(page, open.base, 'docs-theme-menu');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`);
    await placeAt(page, ['docs-note', 'docs-box', 'docs-text'], 1, 500, 220);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('.board-menu-appearance .board-menu-sub-trigger').click(); // the themes sit in the Theme submenu of the board menu
    await page.locator('.theme-item').first().waitFor();
    await park(page);
    await settle(page);
    await save(page, 'themes-menu-matrix', { x: 480, y: 0, width: W - 480, height: 930 });
    await context.close();
  },

  async 'theme-ayu'({ browser, open }) {
    const W = 1000, H = 700;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, theme: 'ayu', user: OPEN_USER });
    await openBoard(page, open.base, 'docs-theme-ayu');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`);
    await placeAt(page, ['docs-note', 'docs-box', 'docs-text'], 1, 220, 150);
    await park(page);
    await settle(page);
    await save(page, 'theme-ayu', { x: 0, y: 56, width: 720, height: 520 });
    await context.close();
  },

  async 'business-model-canvas'({ browser, open }) {
    const { context, page } = await newPage(browser, { base: open.base, width: 1280, height: 800, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-template');
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await page.locator('.template-picker-card', { hasText: 'Business Model Canvas' }).first().click(); // the template picker (cards, then Use template)
    await page.locator('.template-picker-use').click();
    await page.getByText('Session ready').waitFor();
    await page.evaluate(() => window.__board.store.setMeta({ name: 'Strategy workshop' }));
    await page.waitForFunction(() => !document.querySelector('.toast.show'), null, { timeout: 12_000 });
    await sleep(500);
    // the board as large as the window allows, between the rail and the bottom bar, so its text reads at the width the guide shows it
    await page.evaluate(() => { const app = window.__board; app.r.fit(app.r.contentBounds(), 20, 1); });
    await park(page);
    await settle(page);
    await save(page, 'template-business-model-canvas');
    await context.close();
  },

  async signin({ browser, acc }) {
    const { context, page } = await newPage(browser, { base: acc.base, width: 960, height: 560 });
    await page.goto(`${acc.base}/`);
    await page.getByRole('button', { name: 'Email me a link' }).waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await park(page);
    await settle(page);
    await save(page, 'signin', await contentClip(page, 28));
    await context.close();
  },

  async 'teams-home'({ browser, acc, people }) {
    const { context, page } = await newPage(browser, { base: acc.base, width: 1000, height: 980, session: people.ana, clock: Date.now() + 6 * 60_000 });
    await page.goto(`${acc.base}/#/`);
    await page.getByText('Shared with you').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.board-row').length >= 5);
    await park(page);
    await settle(page);
    await save(page, 'teams-home', await contentClip(page, 28));
    await context.close();
  },

  async 'access-removed'({ browser, acc, people }) {
    const W = 1000, H = 520;
    const { context, page } = await newPage(browser, {
      base: acc.base, width: W, height: H, session: people.ana,
      user: { id: 'docs-ana', name: ANA_USER.name, color: '#CE2C7D' },
    });
    await openBoard(page, acc.base, 'teamnote');
    await page.evaluate(() => {
      const app = window.__board;
      const [z] = app.store.topZs(1);
      app.store.transact(() => app.store.create({ id: 'docs-team-note', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z, fill: '#FFE16B', text: 'Team board note', fontSize: 18 }));
      const b = app.r.contentBounds(['docs-team-note']);
      app.r.setCamera({ zoom: 0.8, x: b.x - 176 / 0.8, y: b.y - 140 / 0.8 });
    });
    await settle(page);
    await api(acc.base, people.owner, 'DELETE', `/api/boards/teamnote/shares/user/${people.ana.user.id}`);
    await page.getByText('Your access to this board was removed').waitFor({ timeout: 15_000 });
    await park(page);
    await settle(page);
    await save(page, 'access-removed', await contentClip(page, 24));
    await context.close();
  },

  async 'share-roles'({ browser, acc, people }) {
    const { context, page } = await newPage(browser, { base: acc.base, width: 900, height: 760, session: people.owner });
    await page.goto(`${acc.base}/#/b/roadmap`);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('People with access').first().waitFor();
    await dialog.locator('.share-people select').first().waitFor();
    // a neutral address instead of the throwaway local relay's
    const stableOrigin = 'https://your-team.thetabula.cloud';
    await dialog.getByRole('textbox', { name: 'Board link' }).evaluate((input, origin) => {
      if (!input.value.startsWith(location.origin)) throw new Error('the board link did not use the local screenshot origin');
      input.value = input.value.replace(location.origin, origin);
    }, stableOrigin);
    await dialog.locator('.modal-body .stack > p.muted.small').last().evaluate((line, origin) => {
      if (!line.textContent?.includes(location.origin)) throw new Error('the relay note did not use the local screenshot origin');
      line.textContent = line.textContent.replace(location.origin, origin);
    }, stableOrigin);
    await park(page);
    await settle(page);
    const box = await boxOf(dialog);
    await save(page, 'share-roles', { x: Math.ceil(box.x), y: Math.ceil(box.y), width: Math.floor(box.width) - 2, height: Math.floor(box.height) - 2 }); // 2 px inside the box edge: no edge line in the shot
    await context.close();
  },

  async 'admin-backups'({ browser, acc, people }) {
    const W = 1280, H = 1100;
    const { context, page } = await newPage(browser, { base: acc.base, width: W, height: H, session: people.owner });
    await page.route('**/api/admin/backups', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(GUIDE_BACKUPS) }));
    await page.goto(`${acc.base}/#/admin/backups`);
    await page.waitForFunction(() => document.querySelectorAll('.backups-row').length === 3 && document.querySelectorAll('.backups-row.unreadable').length === 2);
    await page.getByText(`Protected until ${new Date(NOW + 7 * 86_400_000).toISOString().slice(0, 10)}`, { exact: true }).waitFor();
    await park(page);
    await settle(page);
    await save(page, 'admin-backups', pad(await boxOf(page.locator('.admin-panel')), 12, W, H));
    await context.close();
  },

  async 'chat-tray'({ browser, chat, chatPeople }) {
    const W = 1100, H = 760;
    const { context, page } = await newPage(browser, { base: chat.base, width: W, height: H, session: chatPeople.owner });
    await openBoard(page, chat.base, 'docs-chat');
    await page.evaluate(`(${seeds.chat.toString()})(window.__board)`);
    await placeAt(page, ['docs-chat-plan', 'docs-chat-checklist'], 0.8, 140, 220);
    await page.locator('.chat-toggle').click();
    const tray = page.locator('.chat-dock:not([hidden])');
    await tray.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.chat-dock:not([hidden]) .chat-msg').length === 4);
    await tray.locator('.chat-quote').first().waitFor();
    await tray.locator('.chat-mention').waitFor();
    await tray.locator('.chat-reaction').waitFor();
    await tray.locator('.chat-object').first().waitFor();
    await park(page);
    await settle(page);
    await save(page, 'chat-tray', pad(await boxOf(tray), 12, W, H));
    await context.close();
  },

  // the Chat page (docs/chat.md, Interface): the channel list and the open board conversation, at a width where both show
  async 'chat-page'({ browser, chat, chatPeople }) {
    // tall enough that the four messages show whole from the first one, with nothing to scroll
    const W = 1200, H = 1000;
    const { context, page } = await newPage(browser, { base: chat.base, width: W, height: H, session: chatPeople.owner });
    // The list shows boards with recent chat by the relay's real clock, and the demo messages carry the fixed 15 Jan date: only the
    // list response gets the board's row added (as the backups shot stubs only its list).
    await page.route('**/api/chat/channels', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (!body.channels.some((c) => c.kind === 'board' && c.ref === 'docs-chat')) {
        body.channels.push({ kind: 'board', ref: 'docs-chat', name: 'Design review', write: true, unread: 0, mentions: 0, lastId: 4, lastAt: NOW - 6 * 60_000 });
      }
      await route.fulfill({ response: res, json: body });
    });
    // the board's own objects, so the message chips read "Launch plan" and "Final checklist" as in the docked chat shot
    await openBoard(page, chat.base, 'docs-chat');
    await page.evaluate(`(${seeds.chat.toString()})(window.__board)`);
    await page.waitForTimeout(600);
    // client-side, so the page keeps the board's object names it just learned (a reload would show "An object on the board")
    await page.evaluate(() => { location.hash = '#/chat/board/docs-chat'; });
    await page.locator('.chat-conv.open').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll('.chat-conv.open .chat-msg').length === 4);
    await page.locator('.chat-conv.open .chat-reaction').waitFor();
    await page.locator('.chat-row.on').waitFor();
    await park(page);
    await page.evaluate(() => document.activeElement?.blur());
    await settle(page);
    await save(page, 'chat-page', { x: 0, y: 0, width: W, height: H });
    await context.close();
  },

  async 'kanban-card-dialog'({ browser, open }) {
    const W = 1100, H = 900;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-kanban');
    await page.waitForFunction(() => window.__kanban);
    await page.evaluate(`(${seeds.kanban.toString()})(window.__board)`);
    await placeAt(page, ['docs-kanban'], 0.8, 320, 140);
    await page.evaluate(() => window.__board.openCardDialog('docs-card'));
    const dialog = page.getByRole('dialog', { name: 'Card in To do' });
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.k-labels .k-chip.on').length === 2);
    await page.evaluate(() => document.activeElement?.blur());
    await park(page);
    await settle(page);
    await save(page, 'kanban-card-dialog', pad(await boxOf(dialog), 20, W, H));
    await context.close();
  },

  async 'layers-panel'({ browser, open }) {
    const W = 1000, H = 560;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-layers');
    await page.evaluate(`(${seeds.layers.toString()})(window.__board)`);
    await placeAt(page, ['docs-frame', 'docs-layer-box', 'docs-layer-title'], 0.65, 440, 140);
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    const drawer = page.locator('.drawer.show');
    await drawer.locator('[data-id="docs-frame"][aria-expanded="true"]').waitFor();
    await drawer.locator('[data-id="docs-frame-note-1"][aria-level="2"]').waitFor();
    await drawer.locator('[data-id="docs-frame-note-2"][aria-level="2"]').waitFor();
    await park(page);
    await settle(page);
    // the clip ends on the bottom edge of the last listed row and is as wide as the other dialog crops (560 px), with the board beside the panel
    const head = await boxOf(drawer.locator('.drawer-head'));
    const last = await boxOf(drawer.locator('.layer-row', { hasText: 'Make onboarding simpler' }));
    const panel = await boxOf(drawer);
    const x = Math.max(0, panel.x), y = Math.max(0, head.y - 12);
    const clip = { x, y, width: Math.min(panel.width, W - x), height: last.y + last.height + 12 - y }; // the panel alone: no half-cut note of the board beside it
    await save(page, 'layers-panel', clip);
    await context.close();
  },

  // ---- the guide's other screens (docs/guide placeholders): empty board, poll form, sticker picker, connector, line, picture bar, comment, session bar

  async 'getting-started-board'({ browser, open }) {
    const W = 1280, H = 720;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-empty-board');
    await page.evaluate(() => window.__board.store.setMeta({ name: 'Sprint planning' }));
    await page.locator('.empty-hint').waitFor();
    await park(page);
    await settle(page);
    await save(page, 'getting-started-board', { x: 0, y: 0, width: W, height: H });
    await context.close();
  },

  async 'quick-poll-form'({ browser, open }) {
    const W = 900, H = 620;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-poll-form');
    await page.getByRole('button', { name: 'Start a quick poll' }).click();
    const form = page.locator('.poll-pop');
    await form.waitFor();
    await form.getByLabel('Question', { exact: true }).fill('Which day works best for the demo?');
    await form.getByLabel('Option 1', { exact: true }).fill('Monday');
    await form.getByLabel('Option 2', { exact: true }).fill('Wednesday');
    await form.getByRole('button', { name: 'Add option' }).click();
    await form.getByLabel('Option 3', { exact: true }).fill('Friday');
    await park(page);
    await settle(page);
    await save(page, 'quick-poll-form', pad(await boxOf(form), 14, W, H));
    await context.close();
  },

  async 'sticker-picker'({ browser, open }) {
    const W = 1000, H = 640;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-sticker-picker');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`);
    await placeAt(page, ['docs-note'], 1.2, 380, 250);
    await page.evaluate(() => window.__board.setSelection(['docs-note']));
    await page.locator('.quickbar').getByRole('button', { name: 'React with a sticker', exact: true }).click();
    const pop = page.locator('.popover').last();
    await pop.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.reaction-grid img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15_000 });
    await park(page);
    await settle(page);
    await save(page, 'sticker-picker', pad(union(await boxOf(page.locator('.quickbar')), await boxOf(pop), await screenRect(page, 'docs-note')), 40, W, H, 40));
    await context.close();
  },

  async 'connector-drag'({ browser, open }) {
    const W = 1100, H = 440;
    const { context, page } = await shapesBoard(browser, open.base, { width: W, height: H, at: [150, 190] });
    const rect = await screenRect(page, 'docs-rect');
    const ell = await screenRect(page, 'docs-ellipse');
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await sleep(250);
    // the connection dot on the right side sits 14 px outside the edge
    await page.mouse.move(rect.x + rect.width + 14, rect.y + rect.height / 2);
    await sleep(150);
    await page.mouse.down();
    await page.mouse.move(ell.x - 40, ell.y + ell.height / 2 - 10, { steps: 8 });
    await page.mouse.move(ell.x + 20, ell.y + ell.height / 2, { steps: 6 });
    await sleep(250);
    await settle(page);
    await save(page, 'connector-drag', pad(union(rect, ell), 90, W, H, 40));
    await page.mouse.up();
    await context.close();
  },

  async 'line-drag'({ browser, open }) {
    const W = 1100, H = 520;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-line-drag');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`); // a board with something on it, so the empty-board hint is not in the way
    await placeAt(page, ['docs-note', 'docs-box', 'docs-text'], 0.6, 640, 230);
    await page.evaluate(() => window.__board.setTool({ kind: 'line' }));
    await page.mouse.move(300, 330);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(520, 250, { steps: 10 });
    await page.mouse.move(660, 169, { steps: 10 }); // 30 degrees up from the start: a 15-degree step the end snaps to
    await sleep(250);
    await settle(page);
    await save(page, 'line-drag', { x: 0, y: 40, width: W, height: 420 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await context.close();
  },

  async 'picture-quickbar'({ browser, open }) {
    const W = 1000, H = 640;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-picture');
    // a picture drawn here (no file in the repo): sky, sun and two hills
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 600;
      const g = c.getContext('2d');
      g.fillStyle = '#BFD7FF'; g.fillRect(0, 0, 900, 600);
      g.fillStyle = '#FFE16B'; g.beginPath(); g.arc(690, 150, 70, 0, 7); g.fill();
      g.fillStyle = '#7DBB8C'; g.beginPath(); g.ellipse(250, 640, 420, 230, 0, 0, 7); g.fill();
      g.fillStyle = '#5AA06F'; g.beginPath(); g.ellipse(700, 650, 380, 190, 0, 0, 7); g.fill();
      return c.toDataURL('image/png');
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await (await chooser).setFiles({ name: 'hills.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
    await page.locator('.quickbar').getByRole('button', { name: 'Alt text', exact: true }).waitFor({ timeout: 15_000 });
    await sleep(600);
    await park(page);
    await settle(page);
    await save(page, 'picture-quickbar', { x: 90, y: 40, width: W - 90, height: H - 150 });
    await context.close();
  },

  async 'comment-thread'({ browser, open }) {
    const W = 1000, H = 640;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-comment');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`);
    await placeAt(page, ['docs-note'], 1, 260, 170);
    const note = await screenRect(page, 'docs-note');
    await page.evaluate(() => window.__board.setTool({ kind: 'comment' }));
    await page.mouse.click(note.x + note.width - 20, note.y + 24);
    const box = page.getByPlaceholder('Add a comment');
    await box.fill('Can we reword this goal before Friday?');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Resolve' }).waitFor({ timeout: 10_000 });
    await page.getByPlaceholder('Reply').fill('Yes, I will reword it this afternoon.');
    await page.keyboard.press('Enter');
    await page.getByText('Yes, I will reword it this afternoon.').waitFor({ timeout: 10_000 });
    await park(page);
    await settle(page);
    await save(page, 'comment-thread', { x: 0, y: 40, width: W, height: H - 60 });
    await context.close();
  },

  async 'session-bar'({ browser, open }) {
    const W = 1280, H = 720;
    const { context, page } = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(page, open.base, 'docs-session-bar');
    await page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await page.locator('.template-picker-card', { hasText: 'Start / Stop / Continue' }).first().click();
    await page.locator('.template-picker-use').click();
    await page.getByText('Session ready').waitFor();
    await page.getByRole('button', { name: 'Start session' }).click();
    await page.getByRole('button', { name: 'Next step' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.toast.show'), null, { timeout: 12_000 });
    await sleep(500);
    await page.evaluate(() => { const app = window.__board; app.store.setMeta({ name: 'Sprint retro' }); app.r.fit(app.r.contentBounds(), 20, 1); document.activeElement?.blur(); });
    await park(page);
    await settle(page);
    await save(page, 'session-bar', { x: 0, y: 0, width: W, height: H });
    await context.close();
  },

  async 'look-request'({ browser, open }) {
    const W = 1280, H = 720;
    const a = await newPage(browser, { base: open.base, width: W, height: H, user: OPEN_USER });
    await openBoard(a.page, open.base, 'docs-look-request');
    await a.page.getByRole('button', { name: 'Templates and team exercises' }).click();
    await a.page.locator('.template-picker-card', { hasText: 'Start / Stop / Continue' }).first().click();
    await a.page.locator('.template-picker-use').click();
    await a.page.getByText('Session ready').waitFor();
    await a.page.getByRole('button', { name: 'Start session' }).click();
    await a.page.getByRole('button', { name: 'Next step' }).waitFor();
    const b = await newPage(browser, { base: open.base, width: W, height: H, user: { id: 'docs-ana', ...ANA_USER } });
    await openBoard(b.page, open.base, 'docs-look-request');
    await b.page.getByRole('button', { name: 'Ask everyone to look here' }).click();
    const card = a.page.locator('.focus-request, .look-request').first();
    await a.page.getByRole('button', { name: 'Follow' }).waitFor({ timeout: 15_000 });
    await a.page.waitForFunction(() => !document.querySelector('.toast.show'), null, { timeout: 12_000 });
    await a.page.evaluate(() => { window.__board.store.setMeta({ name: 'Sprint retro' }); document.activeElement?.blur(); });
    await park(a.page);
    await settle(a.page);
    await save(a.page, 'look-request', { x: 0, y: 0, width: W, height: H });
    await b.context.close();
    await a.context.close();
  },

  // the Templates page with a saved template: the board's own Save board as template dialog, then the page
  async 'templates-page'({ browser, acc, people }) {
    const W = 1200, H = 1400;
    const { context, page } = await newPage(browser, { base: acc.base, width: W, height: H, session: people.owner, user: { id: 'docs-maya', name: 'Maya', color: '#CE2C7D' } });
    await openBoard(page, acc.base, 'retro');
    await page.evaluate(() => {
      const app = window.__board;
      const z = app.store.topZs(4);
      app.store.transact(() => {
        app.store.create({ id: 'docs-t-frame', type: 'frame', name: 'Went well', x: 0, y: 0, w: 360, h: 300, rotation: 0, z: z[0], fill: '#FFFFFF' });
        app.store.create({ id: 'docs-t-a', type: 'sticky', x: 30, y: 50, w: 140, h: 140, rotation: 0, z: z[1], fill: '#BDE7C8', text: 'Fast reviews', fontSize: 16, parent: 'docs-t-frame' });
        app.store.create({ id: 'docs-t-b', type: 'sticky', x: 190, y: 50, w: 140, h: 140, rotation: 0, z: z[2], fill: '#FFE16B', text: 'Clear goals', fontSize: 16, parent: 'docs-t-frame' });
      });
    });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByText('Save board as template', { exact: true }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name').fill('Sprint retro starter');
    await dlg.getByLabel('Description').fill('Two columns and a few notes to start a retrospective.');
    await dlg.getByRole('button', { name: 'Save template' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.goto(`${acc.base}/#/templates`);
    await page.getByText('Sprint retro starter').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.template-card, .tpl-card').length > 3);
    await page.evaluate(() => document.activeElement?.blur());
    await park(page);
    await settle(page);
    await save(page, 'templates-page', { x: 0, y: 0, width: W, height: 1180 });
    await context.close();
  },

  async 'version-history'({ browser, acc, people }) {
    const W = 1200, H = 800;
    const { context, page } = await newPage(browser, { base: acc.base, width: W, height: H, session: people.owner, user: { id: 'docs-maya', name: 'Maya', color: '#CE2C7D' } });
    const at = (min) => NOW - min * 60_000;
    const versions = [
      { id: 'v5', createdAt: at(12), kind: 'auto', label: null, by: null, byName: null, objects: 14, bytes: 5200, from: null },
      { id: 'v4', createdAt: at(55), kind: 'auto', label: null, by: null, byName: null, objects: 12, bytes: 4800, from: null },
      { id: 'v3', createdAt: at(130), kind: 'named', label: 'Before the client review', by: 'docs-maya', byName: 'Maya', objects: 11, bytes: 4400, from: null },
      { id: 'v2', createdAt: at(200), kind: 'auto', label: null, by: null, byName: null, objects: 9, bytes: 3900, from: null },
      { id: 'v1', createdAt: at(2900), kind: 'auto', label: null, by: null, byName: null, objects: 5, bytes: 2500, from: null },
    ];
    await page.route('**/api/boards/*/versions', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ versions }) }) : route.continue()));
    await openBoard(page, acc.base, 'roadmap');
    await page.evaluate(`(${seeds.theme.toString()})(window.__board)`);
    await placeAt(page, ['docs-note', 'docs-box', 'docs-text'], 0.8, 300, 200);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByText('Version history', { exact: true }).click();
    await page.getByText('Before the client review').waitFor();
    await park(page);
    await settle(page);
    await save(page, 'version-history', { x: 0, y: 0, width: W, height: H });
    await context.close();
  },

  async 'token-form'({ browser, acc, people }) {
    const W = 1100, H = 1300;
    const { context, page } = await newPage(browser, { base: acc.base, width: W, height: H, session: people.owner });
    await page.goto(`${acc.base}/#/`);
    await page.getByRole('button', { name: /Maya/ }).first().click();
    await page.getByText('AI tool access', { exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'AI tool access' });
    await dlg.getByRole('button', { name: 'New token' }).click();
    await dlg.getByLabel('Name').fill('Claude Code on my laptop');
    await dlg.getByText('Read and comment', { exact: true }).click();
    await dlg.getByText('Only these', { exact: true }).click();
    await dlg.getByText('Sprint retro', { exact: true }).click();
    await dlg.getByText('Roadmap 2026', { exact: true }).click();
    await park(page);
    await settle(page);
    await save(page, 'token-form', pad(await boxOf(dlg), 4, W, H));
    await context.close();
  },

  // the admin tabs the guide describes: Overview, AI and Chat
  async 'admin-overview'({ browser, acc, people }) {
    const W = 1280, H = 1100;
    const { context, page } = await newPage(browser, { base: acc.base, width: W, height: H, session: people.owner });
    await page.goto(`${acc.base}/#/admin`);
    await page.getByText('Instance', { exact: true }).waitFor();
    // the throwaway relay's own address and port are not for a guide: show an example address in its place
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.admin-panel *')) if (el.children.length === 0 && /^http:\/\/127\.0\.0\.1:\d+$/.test(el.textContent ?? '')) el.textContent = 'https://tabula.example.com';
    });
    await park(page);
    await settle(page);
    await save(page, 'admin-overview', await contentClip(page, 28));
    await context.close();
  },

  async 'admin-ai'({ browser, acc, people }) {
    const W = 1280, H = 1500;
    const { context, page } = await newPage(browser, { base: acc.base, width: W, height: H, session: people.owner });
    // the relay would check a key with its provider, so the page gets the workspace key as the relay would report one: only the last four characters
    await page.route('**/api/admin/ai', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, enabled: true, hasSecret: true, key: { provider: 'anthropic', hint: '4f2a', baseUrl: null, model: null, createdAt: NOW - 3 * 86_400_000, lastUsedAt: NOW - 2 * 3_600_000, readable: true } } });
    });
    await page.goto(`${acc.base}/#/admin/ai`);
    await page.getByText('Workspace key', { exact: true }).waitFor();
    await sleep(800);
    await page.evaluate(() => document.activeElement?.blur());
    await park(page);
    await settle(page);
    // down to the key line: below it the empty replace-key form shows its own prompt
    const clip = await contentClip(page, 28);
    const keyRow = await boxOf(page.getByText('Added ', { exact: false }).first());
    await save(page, 'admin-ai', { ...clip, height: keyRow.y + keyRow.height + 28 - clip.y });
    await context.close();
  },

  async 'admin-chat'({ browser, chat, chatPeople }) {
    const W = 1280, H = 1000;
    const { context, page } = await newPage(browser, { base: chat.base, width: W, height: H, session: chatPeople.owner });
    await page.goto(`${chat.base}/#/admin/chat`);
    await page.locator('.admin-panel').waitFor();
    await sleep(800);
    await park(page);
    await settle(page);
    await save(page, 'admin-chat', await contentClip(page, 28));
    await context.close();
  },
};

// ---------------------------------------------------------------- main

async function launchChromium() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('playwright is not installed. Run npm ci, then once: npx playwright install chromium');
  }
  try {
    return await playwright.chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (err) {
    if (/Executable doesn't exist/i.test(err.message)) throw new Error('Chromium for Playwright is not installed. Run once: npx playwright install chromium');
    throw err;
  }
}

async function main() {
  const names = Object.keys(SHOTS).filter((n) => !only || only.has(n));
  const unknown = [...(only ?? [])].filter((n) => !SHOTS[n]);
  if (unknown.length) throw new Error(`unknown image: ${unknown.join(', ')} (known: ${Object.keys(SHOTS).join(', ')})`);
  const distDir = path.join(root, 'dist');
  if (!opts['no-build'] || !fs.existsSync(path.join(distDir, 'index.html'))) {
    const { status } = (await import('node:child_process')).spawnSync('npm', ['run', 'build:app'], { cwd: root, stdio: 'inherit' });
    if (status !== 0) throw new Error('npm run build:app failed');
  }
  fs.mkdirSync(outDir, { recursive: true });
  let browser = null, open = null, acc = null, chat = null;
  const cleanup = async () => {
    await browser?.close().catch(() => undefined);
    await stopRelay(open);
    await stopRelay(acc);
    await stopRelay(chat);
  };
  const interrupted = () => cleanup().finally(() => process.exit(130));
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  process.on('SIGHUP', interrupted);
  const failed = [];
  try {
    browser = await launchChromium();
    open = await startRelay('open', distDir);
    const needsAccounts = names.some((n) => ['signin', 'teams-home', 'access-removed', 'share-roles', 'admin-backups', 'templates-page', 'version-history', 'token-form', 'admin-overview', 'admin-ai'].includes(n));
    let people = null;
    if (needsAccounts) {
      acc = await startRelay('accounts', distDir);
      people = await seedAccounts(acc);
    }
    let chatPeople = null;
    if (names.some((n) => ['chat-tray', 'chat-page', 'admin-chat'].includes(n))) {
      chat = await startRelay('chat', distDir);
      chatPeople = await seedGuideChat(chat);
    }
    for (const name of names) {
      try {
        pages.length = 0;
        await SHOTS[name]({ browser, open, acc, people, chat, chatPeople });
        console.log(`ok ${name}`);
      } catch (err) {
        failed.push(name);
        console.error(`failed ${name}: ${String(err.message).split('\n')[0]}`);
        if (process.env.DOCS_IMAGES_DEBUG) await pages[0]?.screenshot({ path: path.join(outDir, `failed-${name}.png`) }).catch(() => undefined);
      }
    }
  } finally {
    await cleanup();
  }
  console.log(`docs-images: ${names.length - failed.length} of ${names.length} in ${path.relative(process.cwd(), outDir) || '.'}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
