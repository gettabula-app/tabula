// Headless visual QA: screenshots of named app states across widths and themes, with no shared browser.
// It starts its own throwaway relay (fresh data folder, free port), seeds one fixed board through the app's ?debug
// handle, drives headless Chromium and writes tabula-review/<id>/<state>-<theme>-<width>.png plus an index.html.
// Usage and options: docs/visual-check.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WIDTHS = [360, 390, 500, 860, 1024, 1440];
const heightFor = (width) => (width <= 500 ? 844 : 800);
const BOARD_ID = 'visual-seed';
const OWNER_EMAIL = 'owner@example.test';
const USER = { id: 'visual-user', name: 'Visual QA', color: '#2F6FED' };
// The browser clock stands still here, so "5 min ago" and the like read the same in every run.
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OTHER_BOARDS = [
  { id: 'visual-notes', title: 'Meeting notes', ago: 3 * 24 * HOUR },
  { id: 'visual-roadmap', title: 'Roadmap 2026', ago: 3 * HOUR },
];
const SEED_TITLE = 'Sprint retro';

const USAGE = `Usage: npm run visual -- --id TAB-123 [options]

  --id <id>          Review folder name, e.g. TAB-123 (required)
  --mode <mode>      open (default) or accounts
  --states <list>    Comma separated, default all for the mode: home, board, board-selected, comments, templates, settings, in open
                     mode kanban, kanban-card, kanban-drag, kanban-drag-empty, kanban-keyboard, kanban-adding, kanban-wip,
                     kanban-lowdetail, and in accounts mode admin, backups-list, backups-detail, backups-board-copy,
                     backups-confirm, backups-restoring, backups-off, chat, chat-composer, chat-unread (the chat states turn on TABULA_CHAT)
  --widths <list>    Default ${DEFAULT_WIDTHS.join(',')}
  --themes <list>    Default all themes in src/themes.ts
  --dark | --light   Only themes with that colour scheme
  --out <dir>        Parent folder, default tabula-review (shots go to <dir>/<id>/)
  --no-build         Reuse an existing dist/ instead of running npm run build:app
  --frameable        Start the throwaway relay with TABULA_DEV_ALLOW_FRAMING=1
`;

class UsageError extends Error {
  constructor(message, showUsage = true) {
    super(message);
    this.showUsage = showUsage;
  }
}

const list = (value) => value.split(',').map((v) => v.trim()).filter(Boolean);

function readThemes() {
  const source = fs.readFileSync(path.join(root, 'src', 'themes.ts'), 'utf8');
  const themes = [...source.matchAll(/id: '([\w-]+)',\s*name: '[^']*',\s*scheme: '(light|dark)'/g)].map(([, id, scheme]) => ({ id, scheme }));
  if (!themes.length) throw new Error('could not read the themes from src/themes.ts');
  return themes;
}

// ---------------------------------------------------------------- states

// Pending Fontshare stylesheets and the fonts that follow them are the only thing that changes the picture after load.
const settle = (page) =>
  page.evaluate(async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pending = [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) => !link.sheet);
    await Promise.all(pending.map((link) => new Promise((resolve) => {
      link.addEventListener('load', resolve);
      link.addEventListener('error', resolve);
    })));
    await frames();
    await document.fonts.ready;
    await frames();
  });

// A moved mouse or a focused control would leave a tooltip or hover state in the shot.
const park = async (page) => {
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.activeElement?.blur());
};

/** Runs inside the page (serialised by Playwright): creates the fixed board once. Returns false when it is already there. */
function seedBoard({ boardTitle, at }) {
  const app = window.__board;
  const store = app.store;
  if (store.get('seed-title')) return false;
  const body = store.getMeta().bodyFont;
  const heading = store.getMeta().headingFont;
  const objs = [];
  const add = (id, type, x, y, w, h, extra) => objs.push({ id, type, x, y, w, h, rotation: 0, z: '', createdBy: 'visual-seed', updatedAt: at, font: body, ...extra });
  const frame = (id, name, x, fill) => add(id, 'frame', x, 0, 440, 520, { name, fill, font: heading });
  const note = (id, text, x, y, fill, parent) => add(id, 'sticky', x, y, 160, 160, { text, fill, parent, fontSize: 18 });
  const shape = (id, kind, text, x, y, w, h, fill) => add(id, 'shape', x, y, w, h, { kind, text, fill });
  const bound = (id, side) => ({ kind: 'bound', id, anchor: side });
  const link = (id, from, to, extra) => objs.push({ id, type: 'connector', z: '', from, to, route: 'elbow', startHead: 'none', endHead: 'arrow', createdBy: 'visual-seed', updatedAt: at, ...extra });

  add('seed-title', 'text', 0, -130, 640, 52, { text: boardTitle, fontSize: 40, fontWeight: 700, font: heading });
  add('seed-subtitle', 'text', 0, -72, 640, 24, { text: 'Week 12: what to keep, what to change', fontSize: 17, textColor: '#5B6672' });
  frame('seed-frame-good', 'Went well', 0, '#E6F7EF');
  frame('seed-frame-bad', 'To improve', 480, '#FFE9E0');
  note('seed-note-1', 'Reviews were fast', 32, 64, '#FFE16B', 'seed-frame-good');
  note('seed-note-2', 'Clear sprint goal', 248, 64, '#BCE88C', 'seed-frame-good');
  note('seed-note-3', 'Pairing on the hard bits', 32, 264, '#8FE3CA', 'seed-frame-good');
  note('seed-note-4', 'Too many meetings', 512, 64, '#FFA3C4', 'seed-frame-bad');
  note('seed-note-5', 'Flaky tests', 728, 64, '#FFB979', 'seed-frame-bad');
  note('seed-note-6', 'Unclear ownership', 512, 264, '#CDB8FF', 'seed-frame-bad');
  shape('seed-rect', 'rect', 'Backlog', 0, 660, 160, 80, '#DCEBFF');
  shape('seed-diamond', 'diamond', 'Ready?', 280, 612, 144, 144, '#FFF2C2');
  shape('seed-ellipse', 'ellipse', 'Done', 280, 800, 144, 144, '#DDF5E8');
  shape('seed-rounded', 'rounded', 'Review', 560, 652, 176, 64, '#ECE4FF');
  add('seed-label', 'text', 560, 740, 240, 24, { text: 'Flow of work', fontSize: 16, textColor: '#5B6672' });
  link('seed-conn-1', bound('seed-rect', 'right'), bound('seed-diamond', 'left'));
  link('seed-conn-2', bound('seed-rect', 'right'), bound('seed-ellipse', 'left'));
  link('seed-conn-3', bound('seed-diamond', 'bottom'), bound('seed-ellipse', 'top'), { route: 'straight', label: 'yes' });
  link('seed-conn-4', bound('seed-diamond', 'right'), bound('seed-rounded', 'left'));
  link('seed-conn-5', bound('seed-note-2', 'right'), bound('seed-note-4', 'left'), { route: 'curved', dash: 'dashed' });

  const zs = store.topZs(objs.length);
  objs.forEach((o, i) => (o.z = zs[i]));
  store.transact(() => {
    store.setMeta({ name: boardTitle });
    objs.forEach((o) => store.create(o));
  });
  return true;
}

async function seedComments(page, fresh) {
  if (!fresh) {
    const arrived = await page.waitForFunction(() => window.__board.comments.list().length > 0, null, { timeout: 3000 }).catch(() => null);
    if (arrived) return;
  }
  const author = await page.evaluate(async () => {
    const res = await fetch('/api/me').catch(() => null);
    const me = res?.ok ? await res.json() : null;
    const user = window.__board.user;
    return me ? { id: me.user.id, name: me.user.name, color: user.color } : { id: user.id, name: user.name, color: user.color };
  });
  await page.clock.setFixedTime(NOW - 30 * MINUTE);
  const threadId = await page.evaluate((who) => {
    const anchor = { x: 192, y: 64, obj: 'seed-note-1', fx: 1, fy: 0 };
    return window.__board.comments.addThread(who, anchor, 'Can we keep this one for the next sprint too?');
  }, author);
  await page.clock.setFixedTime(NOW - 25 * MINUTE);
  await page.evaluate(({ who, id }) => window.__board.comments.reply(id, who, 'Yes, it is cheap to keep.'), { who: author, id: threadId });
  await page.clock.setFixedTime(NOW);
}

const EMPTY_ID = 'visual-empty';
/** The second person of the last empty-focus shot. */
let focusSender = null;

/** A board nobody writes to: the empty-board hint shows. */
async function openEmptyBoard({ page, base }) {
  await page.goto(`${base}/?debug#/b/${EMPTY_ID}`);
  await page.waitForFunction(() => window.__board, null, { timeout: 15_000 });
  await page.locator('.empty-hint').waitFor();
}

async function openSeedBoard({ page, base }) {
  await page.goto(`${base}/?debug#/b/${BOARD_ID}`);
  await page.waitForFunction(() => window.__board, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const provider = window.__board.conn.provider;
    return !provider || provider.synced;
  }, null, { timeout: 15_000 });
  const fresh = await page.evaluate(seedBoard, { boardTitle: SEED_TITLE, at: NOW - HOUR });
  await seedComments(page, fresh);
  await page.evaluate(() => {
    const app = window.__board;
    app.setSelection([]);
    app.zoomToFit();
  });
}

// ---------------------------------------------------------------- backups (accounts mode)

// The throwaway relay has no bucket, so the Backups tab is shown from fixed answers to the backup routes. The relay itself
// answers `backups_off`, which is what backups-off shows.
const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;
const BACKUP_KEY = 'a1b2c3d4';
const stamp = (at) => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const manifestName = (at) => `${stamp(at)}.json.enc`;
const BACKUPS = [
  { at: NOW - 30 * MINUTE, files: 14, bytes: 4_823_552, protectedUntil: NOW + 6 * 24 * HOUR },
  { at: NOW - 90 * MINUTE, files: 14, bytes: 4_811_264 },
  { at: NOW - 150 * MINUTE, files: 13, bytes: 4_790_000, unreadable: 'unknown_key' },
  { at: NOW - 27 * HOUR, files: 12, bytes: 4_201_113 },
  { at: NOW - 3 * 24 * HOUR, files: 12, bytes: 3_998_000, protectedUntil: NOW + 3 * 24 * HOUR },
  { at: NOW - 9 * 24 * HOUR, files: 9, bytes: 2_104_330 },
  { at: NOW - 21 * 24 * HOUR, files: 7, bytes: 1_240_000, unreadable: 'tamper' },
].map((b) => ({
  name: manifestName(b.at),
  createdAt: Math.floor(b.at / 1000) * 1000,
  protected: b.protectedUntil !== undefined,
  protectedUntil: b.protectedUntil ?? null,
  ...(b.unreadable ? { readable: false, error: b.unreadable } : { readable: true, files: b.files, bytes: b.bytes, keyId: BACKUP_KEY }),
}));
const BACKUP_LIST = {
  backups: BACKUPS,
  truncated: false,
  status: {
    lastSuccessAt: NOW - 30 * MINUTE, lastFailureAt: null, lastFailureError: null, consecutiveFailures: 0, nextRunAt: NOW + 30 * MINUTE,
    running: false, intervalMinutes: 60, keyId: BACKUP_KEY, bytesStored: 18_874_368, objects: 52, manifests: BACKUPS.length,
  },
  restore: {
    inProgress: null,
    maintenance: false,
    last: { kind: 'workspace', result: 'done', at: NOW - 3 * 24 * HOUR + 5 * MINUTE, manifest: BACKUPS[4].name, keepOldFor: '7 days' },
    protectedBackups: [],
    oldData: [],
  },
};
const BACKUP_BOARDS = {
  boards: [
    ['roadmap', 'Roadmap 2026', 'team-design', 'Design', false],
    ['retro', 'Sprint retro', 'team-design', 'Design', false],
    ['notes', 'Meeting notes', null, null, false],
    ['launch', 'Launch plan for the spring campaign across every region and every channel we use', 'team-growth', 'Growth', false],
    ['onboarding', 'Customer onboarding journey', 'team-growth', 'Growth', true],
    ['ideas', 'Ideas', null, null, false],
  ].map(([id, title, teamId, teamName, deleted]) => ({ id, title, teamId, teamName, deleted })),
  truncated: false,
};
const backupPreview = (name) => ({
  name, createdAt: BACKUPS.find((b) => b.name === name)?.createdAt ?? NOW, appVersion: '0.1.0', keyId: BACKUP_KEY, files: 14, bytes: 4_823_552, boards: 6,
  protected: true, confirmWord: 'RESTORE', keepOldFor: '7 days', reason: 'There is room on the disk, so the old data is kept for 7 days.',
  space: { needed: 2 * 4_823_552 + 64 * MIB, free: 21 * GIB, enough: true },
});

/** Answers the backup routes (and, for the restoring screen, the restore and /api/health) from the fixed data above. */
async function mockBackups(page, { restoring = false } = {}) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/admin/backups**', (route) => {
    const { pathname } = new URL(route.request().url());
    const rest = pathname.replace(/^\/api\/admin\/backups\/?/, '');
    if (route.request().method() === 'POST') {
      return rest === 'restore' ? json(route, { ok: true, restarting: true, keepOldFor: '7 days' }, 202) : json(route, { error: 'bad_request', message: 'not used' }, 400);
    }
    if (rest === '') return json(route, BACKUP_LIST);
    if (rest.endsWith('/boards')) return json(route, BACKUP_BOARDS);
    return json(route, backupPreview(rest));
  });
  if (restoring) await page.route('**/api/health', (route) => json(route, { ok: true, rooms: 0, connections: 0, restoring: true }));
}

const waitForAdminPanel = (page) =>
  page.waitForFunction(() => {
    const panel = document.querySelector('.admin-panel');
    return panel && !panel.textContent.includes('Loading');
  });

async function openBackup({ page, base }) {
  await mockBackups(page, { restoring: true });
  await page.goto(`${base}/#/admin/backups`);
  await page.locator('.backups-row').first().waitFor();
  await page.getByRole('button', { name: /^Details of the backup/ }).first().click();
  await page.getByRole('button', { name: 'Restore the whole workspace' }).waitFor();
}

// ---------------------------------------------------------------- chat (accounts mode, TABULA_CHAT=on)

/**
 * Opens the seeded board's Chat tab. The owner's read marker goes back to where the seed put it first, because the
 * previous shot read the whole channel, and the "New messages" line belongs in every shot.
 */
async function openSeedChat(env) {
  const { page, chat } = env;
  await resetChatMarker(env);
  await openSeedBoard(env);
  await page.locator('.chat-toggle').click();
  await page.waitForFunction((n) => document.querySelectorAll('.side-tray.show .chat-msg').length >= n, chat.count);
  await page.locator('.chat-new').waitFor();
}

async function resetChatMarker({ chat, dataDir }) {
  if (!chat) throw new Error('the chat states need --mode accounts');
  await withChatDb(dataDir, (db) => {
    db.prepare('UPDATE chat_reads SET last_id = ? WHERE user_id = ? AND kind = ? AND ref = ?').run(chat.readUpTo, chat.ownerId, 'board', BOARD_ID);
  });
}

async function withChatDb(dataDir, fn) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'chat.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

async function apiJson(base, verb, route, body, cookie) {
  const headers = { accept: 'application/json', 'x-tabula': '1', ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const init = { method: verb, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}/api/${route}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${verb} /api/${route} answered ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Signs a person in over the API (through a team invite when there is one) and gives them a name. Returns the cookie. */
async function signInAs({ base, dataDir }, email, name, invite) {
  await postJson(base, 'auth/request', invite ? { email, invite } : { email });
  const verified = await postJson(base, 'auth/verify', { token: await readLoginToken(dataDir) });
  const cookie = verified.headers.getSetCookie()[0].split(';')[0].trim();
  await postJson(base, 'me', { name }, cookie, 'PATCH');
  return cookie;
}

/**
 * Two more people join a team the seeded board is shared with, and the three talk in its chat through the REST API,
 * each with their own session: an edited message, a deleted one, a reply, mentions, a long link and a day break. The
 * server stamps the real time, so the times are then moved next to the browser's fixed clock in chat.sqlite.
 */
async function seedChat(relay, ownerCookie) {
  const { base } = relay;
  const me = await apiJson(base, 'GET', 'me', undefined, ownerCookie);
  const team = await apiJson(base, 'POST', 'teams', { name: 'Retro team' }, ownerCookie);
  const join = async (email, name) => {
    const invite = await apiJson(base, 'POST', `teams/${team.id}/invites`, { role: 'member' }, ownerCookie);
    await sleep(50);
    return signInAs(relay, email, name, invite.token);
  };
  const ana = await join('ana@example.test', 'Ana Lima');
  const ben = await join('ben@example.test', 'Ben Okafor');
  await apiJson(base, 'POST', `boards/${BOARD_ID}/shares`, { principalType: 'team', principalId: team.id, role: 'editor' }, ownerCookie);
  const ids = {};
  for (const [cookie, who] of [[ana, 'ana'], [ben, 'ben']]) ids[who] = (await apiJson(base, 'GET', 'me', undefined, cookie)).user.id;
  ids.owner = me.user.id;

  const route = `chat/board/${BOARD_ID}/messages`;
  let n = 0;
  const say = async (cookie, text, extra = {}) =>
    (await apiJson(base, 'POST', route, { clientId: `visual-seed-${++n}`, text, ...extra }, cookie)).message.id;
  const times = [];
  const at = (id, time, extra = {}) => times.push({ id, time, ...extra });
  const DAY = 24 * HOUR;

  at(await say(ana, 'Retro notes are on the board. Can everyone add their stickies before tomorrow?'), NOW - DAY + 6 * HOUR + 2 * MINUTE);
  at(await say(ana, 'The flow we talked about: https://www.figma.com/file/AbCdEfGhIjKlMnOpQrStUv/Checkout-flow-v3?node-id=1234-5678&mode=design&t=averyveryverylongtokenvalue0123456789'), NOW - DAY + 6 * HOUR + 3 * MINUTE);
  const willDo = await say(ben, 'Will do, after lunch.');
  at(willDo, NOW - DAY + 6 * HOUR + 20 * MINUTE);
  at(await say(ownerCookie, 'Thanks Ana, mine are in.'), NOW - DAY + 6 * HOUR + 21 * MINUTE);
  const question = await say(ben, 'Are we starting at ten?');
  at(question, NOW - 48 * MINUTE);
  const answer = await say(ownerCookie, `Yes, ten sharp. @{${ids.ben}} can you share your screen?`, { replyTo: question });
  at(answer, NOW - 46 * MINUTE);
  const flaky = await say(ana, `Flaky tests are mine, I'll take that action. @{${ids.owner}}`);
  at(flaky, NOW - 20 * MINUTE, { edited: NOW - 18 * MINUTE });
  at(await say(ana, 'Running five minutes late, sorry!'), NOW - 2 * MINUTE);

  await apiJson(base, 'PATCH', `chat/messages/${flaky}`, { text: `Flaky tests are mine, I'll take the action point. @{${ids.owner}}` }, ana);
  await apiJson(base, 'DELETE', `chat/messages/${willDo}`, undefined, ben);
  await apiJson(base, 'PUT', `chat/board/${BOARD_ID}/read`, { lastId: answer }, ownerCookie);

  await withChatDb(relay.dataDir, (db) => {
    const move = db.prepare('UPDATE chat_messages SET created_at = ?, edited_at = CASE WHEN edited_at IS NULL THEN NULL ELSE ? END, deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE ? END WHERE id = ?');
    for (const t of times) move.run(t.time, t.edited ?? t.time, t.time + MINUTE, t.id);
  });
  return { ownerId: ids.owner, readUpTo: answer, count: times.length };
}


// ---------------------------------------------------------------- kanban (docs/kanban.md, slice 2)

const KANBAN_ID = 'visual-kanban';

/** Runs inside the page: a kanban like the design mock's, once. Card heights are stored the way the app stores them. */
function seedKanban({ at }) {
  const app = window.__board;
  const store = app.store;
  if (store.get('k-box')) return false;
  const body = store.getMeta().bodyFont;
  const heading = store.getMeta().headingFont;
  const z = store.topZ();
  const base = { rotation: 0, z, createdBy: 'visual-seed', updatedAt: at };
  const lanes = [
    { id: 'k-todo', name: 'To do', stage: 'todo' },
    { id: 'k-doing', name: 'Doing', stage: 'doing', fill: 'blue', wip: 3 },
    { id: 'k-review', name: 'Review', wip: 2, wipMode: 'block' },
    { id: 'k-done', name: 'Shipped', stage: 'done', fill: 'green' },
  ];
  const cards = {
    'k-todo': [
      { id: 'k-c1', text: 'Write the migration guide for teams moving sprint boards from spreadsheets, with the CSV column mapping and the formula guards', labels: ['docs'], ownerName: 'Lea Brandt' },
      { id: 'k-c2', text: 'Fix the login loop on Safari 17', fill: '#FFA3C4', labels: ['bug', 'ui', 'urgent', 'chore'], due: '2026-01-16', ownerName: 'Visual QA', ownerId: 'visual-user' },
      { id: 'k-c3', text: 'Spike: caching' },
      { id: 'k-c4', text: 'Pick the beta cohort', due: '2026-01-19', ownerName: 'Ana Novak' },
    ],
    'k-doing': [
      { id: 'k-d1', text: 'Card dialog: owner picker', labels: ['feature'], due: '2026-01-12', ownerName: 'Visual QA', ownerId: 'visual-user' },
      { id: 'k-d2', text: 'Lane menu and WIP warning', labels: ['feature'], due: '2026-01-15', ownerName: 'Marta Ruiz' },
      { id: 'k-d3', text: 'CSV export with formula guards', labels: ['bug'], ownerName: 'Visual QA', ownerId: 'visual-user' },
    ],
    'k-review': [],
    'k-done': [
      { id: 'k-e1', text: 'Copy shared/ into the Docker image', due: '2026-01-13', ownerName: 'Visual QA', ownerId: 'visual-user', labels: ['chore'] },
      { id: 'k-e2', text: 'Spec review', labels: ['docs'] },
    ],
  };
  const labels = [['bug', 'Bug', 'pink'], ['feature', 'Feature', 'blue'], ['ui', 'Frontend', 'teal'], ['urgent', 'Urgent', 'orange'], ['docs', 'Docs', 'violet'], ['chore', 'Chore', 'grey']];
  const keys = ['a0', 'a1', 'a2', 'a3', 'a4'];
  const objs = [{ ...base, id: 'k-box', type: 'container', layout: 'kanban', name: 'Q4 delivery', x: 0, y: 0, w: 1200, h: 600, font: heading }];
  lanes.forEach((l, i) => objs.push({ ...base, ...l, type: 'lane', parent: 'k-box', rank: `${keys[i]}@k-box`, x: 0, y: 0, w: 280, h: 200, font: body }));
  for (const [lane, list] of Object.entries(cards)) {
    list.forEach((c, i) => {
      const card = { ...base, ...c, type: 'card', parent: lane, rank: `${keys[i]}@${lane}`, x: 0, y: 0, w: 264, h: 0, font: body };
      card.h = window.__kanban.cardContentHeight(card, 264);
      objs.push(card);
    });
  }
  // ordinary objects beside it, as in the mock
  objs.push({ ...base, id: 'k-frame', type: 'frame', name: 'Ideas', x: -220, y: 0, w: 176, h: 276, fill: '#FFFFFF', font: heading });
  objs.push({ ...base, id: 'k-note-1', type: 'sticky', text: 'Card ageing in Doing?', x: -204, y: 16, w: 104, h: 104, fill: '#FFE16B', parent: 'k-frame', font: body, fontSize: 14 });
  objs.push({ ...base, id: 'k-note-2', type: 'sticky', text: 'Swimlanes by owner', x: -164, y: 152, w: 104, h: 104, fill: '#8FE3CA', parent: 'k-frame', font: body, fontSize: 14 });
  store.transact(() => {
    labels.forEach(([id, name, color], order) => store.labels.set(id, { id, name, color, order }));
    objs.forEach((o) => store.create(o));
  });
  return true;
}

async function openKanbanBoard({ page, base }, { fit = true, board = KANBAN_ID } = {}) {
  await page.goto(`${base}/?debug#/b/${board}`);
  await page.waitForFunction(() => window.__board && window.__kanban, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const provider = window.__board.conn.provider;
    return !provider || provider.synced;
  }, null, { timeout: 15_000 });
  // heights are measured with the board's fonts, so they have to be there first
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  const fresh = await page.evaluate(seedKanban, { at: NOW - HOUR });
  if (fresh) {
    await page.evaluate(() => {
      const app = window.__board;
      app.comments.addThread({ id: 'visual-user', name: 'Visual QA', color: '#2F6FED' }, { x: 0, y: 0, obj: 'k-d3', fx: 0.95, fy: 0.1 }, 'Should the guard cover tabs too?');
    });
  }
  await page.evaluate((doFit) => {
    const app = window.__board;
    app.setSelection([]);
    // a phone shows the kanban alone, as the design's 390 shots do; a desktop shows the objects beside it too
    if (doFit) app.r.fit(window.innerWidth < 600 ? app.r.contentBounds(['k-box']) : app.r.contentBounds(), window.innerWidth < 600 ? 8 : 40, 1);
  }, fit);
  await settle(page);
}

/** The screen point of a world point on the kanban board. */
const screenOf = (page, id, fx, fy) =>
  page.evaluate(({ id, fx, fy }) => {
    const app = window.__board;
    const o = app.store.getPlaced(id);
    const s = app.r.toScreen({ x: o.x + o.w * fx, y: o.y + o.h * fy });
    const box = app.r.svg.getBoundingClientRect();
    return { x: box.left + s.x, y: box.top + s.y };
  }, { id, fx, fy });

const STATES = {
  async home({ page, base }) {
    await page.goto(`${base}/#/`);
    await page.locator('.home-title').waitFor();
    await page.waitForFunction((n) => document.querySelectorAll('.board-row').length >= n, OTHER_BOARDS.length + 1);
  },
  async board(env) {
    await openSeedBoard(env);
  },
  async 'board-selected'(env) {
    await openSeedBoard(env);
    await env.page.evaluate(() => window.__board.setSelection(['seed-rect']));
    const more = env.page.getByRole('button', { name: 'More properties' });
    await more.waitFor();
    await more.evaluate((el) => el.click());
    await env.page.locator('.props.show').waitFor();
  },
  // phones only: the properties panel folded to its title row (TAB-187); on wider windows the fold button is not shown
  async 'board-selected-folded'(env) {
    await STATES['board-selected'](env);
    const fold = env.page.getByRole('button', { name: 'Fold properties' });
    if (await fold.isVisible()) {
      await fold.click();
      await env.page.locator('.props.folded').waitFor();
    }
  },
  // TAB-112 and TAB-133: panels and drawers on the right start below the top bars at every width
  async 'drawer-stickers'(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Stickers', exact: true }).click();
    await env.page.locator('.drawer.show').waitFor();
  },
  async history(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await env.page.getByRole('button', { name: 'Version history' }).click();
    await env.page.locator('.history.show, [aria-label="Version history"]').first().waitFor();
  },
  async comments(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Comments', exact: true }).click();
    await env.page.locator('.side-tray.show .comment-row').first().waitFor();
  },
  // TAB-124: the empty-board hint lies under every overlay
  async 'empty-templates'(env) {
    await openEmptyBoard(env);
    await env.page.getByRole('button', { name: 'Start from a template' }).click();
    await env.page.locator('.drawer.show').waitFor();
  },
  async 'empty-share'(env) {
    await openEmptyBoard(env);
    await env.page.getByRole('button', { name: 'Share', exact: true }).click();
    await env.page.locator('[role="dialog"]').first().waitFor();
  },
  async 'empty-menu'(env) {
    await openEmptyBoard(env);
    await env.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await env.page.getByRole('button', { name: 'Board settings' }).waitFor();
  },
  async 'empty-focus'(env) {
    await openEmptyBoard(env);
    // a second person on the same board asks everyone to look at their view
    // it stays open until the next shot of this state (the card goes when its sender leaves), then it is closed
    await focusSender?.close();
    const other = await newPage(env.page.context().browser(), { width: 1024, theme: 'default', mode: 'open', base: env.base });
    focusSender = other.context;
    {
      const tag = Math.random().toString(36).slice(2, 8);
      await other.page.addInitScript((id) => localStorage.setItem('driftboard:user', JSON.stringify({ id, name: 'Ana', color: '#D64545' })), `visual-other-${tag}`);
      await other.page.goto(`${env.base}/?debug#/b/${EMPTY_ID}`);
      await other.page.waitForFunction(() => window.__board);
      // the request focus.ts puts on its sender's awareness (src/focus-requests.ts buildRequest); the button lives in a running session
      await other.page.evaluate(() => {
        const app = window.__board;
        const u = app.user;
        app.conn.awareness.setLocalStateField('focusRequest', { id: `ask-${u.id}`, x: 0, y: 0, zoom: 1, ts: Date.now(), kind: 'view', from: { id: u.id, name: u.name, color: u.color } });
      });
      await env.page.locator('.focus-stack > *').first().waitFor({ timeout: 8000 });
      await env.page.waitForTimeout(300);
    }
  },
  async 'chat-unread'(env) {
    await resetChatMarker(env);
    await openSeedBoard(env);
    await env.page.locator('.chat-count.show.mention').waitFor();
  },
  async chat(env) {
    await openSeedChat(env);
  },
  async 'chat-composer'(env) {
    await openSeedChat(env);
    const field = env.page.getByRole('combobox', { name: 'Message' });
    await field.click();
    await field.pressSequentially('Thanks @b');
    await env.page.locator('.chat-suggest .chat-option').first().waitFor();
    // the typeahead closes when the field loses focus, so this shot keeps it
    return { keepFocus: true };
  },
  async templates({ page, base }) {
    await page.goto(`${base}/#/templates`);
    await page.locator('.tpl-card').first().waitFor();
  },
  async settings(env) {
    await openSeedBoard(env);
    await env.page.getByRole('button', { name: 'Menu', exact: true }).click();
    await env.page.getByRole('button', { name: 'Board settings' }).click();
    await env.page.getByRole('dialog', { name: 'Board settings' }).waitFor();
  },
  async kanban(env) {
    await openKanbanBoard(env);
  },
  async 'kanban-card'(env) {
    await openKanbanBoard(env);
    await env.page.evaluate(() => window.__board.setSelection(['k-c2']));
  },
  async 'kanban-drag'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    const from = await screenOf(page, 'k-c3', 0.5, 0.5);
    const to = await screenOf(page, 'k-d1', 0.6, 0.95);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-drag-empty'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    const from = await screenOf(page, 'k-c3', 0.5, 0.5);
    const to = await screenOf(page, 'k-review', 0.5, 0.3);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-keyboard'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    await page.evaluate(() => window.__board.setSelection(['k-d2']));
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowDown');
    await page.locator('[role="status"][aria-live="polite"]').filter({ hasText: 'Moved to Doing' }).waitFor({ state: 'attached' });
  },
  async 'kanban-adding'(env) {
    await openKanbanBoard(env);
    const { page } = env;
    await page.evaluate(() => window.__board.cardInput.start('k-todo'));
    await page.locator('.k-input').fill('Draft the release notes');
    await settle(page);
    return { noPark: true };
  },
  async 'kanban-wip'(env) {
    // its own board: the extra card would otherwise stay in the shared one and change every later kanban shot
    await openKanbanBoard(env, { board: `${KANBAN_ID}-wip` });
    await env.page.evaluate(() => {
      const app = window.__board;
      if (!app.store.get('k-d4')) {
        const card = { id: 'k-d4', type: 'card', parent: 'k-doing', rank: 'a3@k-doing', text: 'Phone sheet at 390', labels: ['ui'], ownerName: 'Ana Novak', due: '2026-01-22', x: 0, y: 0, w: 264, h: 0, rotation: 0, z: 'a0', createdBy: 'visual-seed', updatedAt: Date.now(), font: app.store.getMeta().bodyFont };
        card.h = window.__kanban.cardContentHeight(card, 264);
        app.store.transact(() => app.store.create(card));
      }
      app.setSelection([]);
    });
  },
  async 'kanban-lowdetail'(env) {
    await openKanbanBoard(env, { fit: false });
    await env.page.evaluate(() => {
      const app = window.__board;
      const b = app.store.getPlaced('k-box');
      const s = app.r.size();
      const zoom = 0.3;
      app.r.setCamera({ zoom, x: b.x + b.w / 2 - s.w / 2 / zoom, y: b.y + b.h / 2 - s.h / 2 / zoom });
    });
    await settle(env.page);
  },
  async admin({ page, base }) {
    await page.goto(`${base}/#/admin`);
    await waitForAdminPanel(page);
  },
  async 'backups-list'({ page, base }) {
    await mockBackups(page);
    await page.goto(`${base}/#/admin/backups`);
    await page.locator('.backups-row').first().waitFor();
    await waitForAdminPanel(page);
  },
  async 'backups-detail'(env) {
    await openBackup(env);
  },
  async 'backups-board-copy'(env) {
    await openBackup(env);
    await env.page.getByRole('button', { name: 'Restore a board as a copy' }).click();
    await env.page.locator('.backups-pick-row').first().waitFor();
    await env.page.locator('.backups-pick-row').nth(1).click();
  },
  async 'backups-confirm'(env) {
    await openBackup(env);
    await env.page.getByRole('button', { name: 'Restore the whole workspace' }).click();
    await env.page.locator('#backups-confirm').waitFor();
  },
  async 'backups-restoring'(env) {
    await openBackup(env);
    await env.page.getByRole('button', { name: 'Restore the whole workspace' }).click();
    await env.page.locator('#backups-confirm').fill('RESTORE');
    await env.page.getByRole('button', { name: 'Restore this backup' }).click();
    await env.page.locator('.restoring').waitFor();
  },
  async 'backups-off'({ page, base }) {
    await page.goto(`${base}/#/admin/backups`);
    await page.getByText('Not set up', { exact: true }).waitFor();
  },
};
// These pages are longer than the window and the point of the shot is the whole of it (the list under the status).
const FULL_PAGE = new Set(['backups-list', 'backups-detail', 'backups-board-copy', 'backups-confirm']);
const BACKUPS_STATES = ['backups-list', 'backups-detail', 'backups-board-copy', 'backups-confirm', 'backups-restoring', 'backups-off'];
const CHAT_STATES = new Set(['chat', 'chat-composer', 'chat-unread']);
// The kanban board is opened by id and seeded with a fixed comment author, which only open mode accepts as it is.
const KANBAN_STATES = Object.keys(STATES).filter((s) => s.startsWith('kanban'));
const STATE_MODES = { admin: ['accounts'], ...Object.fromEntries(KANBAN_STATES.map((s) => [s, ['open']])), ...Object.fromEntries([...CHAT_STATES].map((s) => [s, ['accounts']])), ...Object.fromEntries(BACKUPS_STATES.map((s) => [s, ['accounts']])) };
const statesFor = (mode) => Object.keys(STATES).filter((s) => !STATE_MODES[s] || STATE_MODES[s].includes(mode));

// ---------------------------------------------------------------- relay

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

function relayEnv({ mode, port, dataDir, distDir, frameable, chat }) {
  // Nothing from the caller's shell may reach the relay: it would turn on MCP, backups, AI or a hosted workspace.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(key)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: distDir, QUIET: '1' });
  if (mode === 'accounts') {
    Object.assign(env, { TABULA_AUTH: 'on', TABULA_MAIL: 'file', TABULA_OWNER_EMAIL: OWNER_EMAIL, TABULA_BASE_URL: `http://127.0.0.1:${port}` });
    if (chat) env.TABULA_CHAT = 'on';
  }
  if (frameable) env.TABULA_DEV_ALLOW_FRAMING = '1';
  return env;
}

const newRelayHandle = () => ({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-visual-')), base: '', child: null });

/** Starts the relay for `handle` and resolves when it answers. The caller stops it, also when this throws. */
async function startRelay(handle, options) {
  const port = await freePort();
  handle.base = `http://127.0.0.1:${port}`;
  let stderr = '';
  let exited = false;
  // cwd is the empty data folder because the relay loads a .env file from where it starts
  const child = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], {
    cwd: handle.dataDir,
    env: relayEnv({ ...options, port, dataDir: handle.dataDir }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  handle.child = child;
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  child.on('exit', () => (exited = true));
  child.on('error', (err) => (stderr += String(err)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited) throw new Error(`the relay stopped at start:\n${stderr.trim()}`);
    if (Date.now() > deadline) throw new Error(`the relay did not answer in 20 seconds:\n${stderr.trim()}`);
    const ok = await fetch(`${handle.base}/api/health`).then((res) => res.ok, () => false);
    if (ok) return;
    await sleep(100);
  }
}

async function stopRelay(handle) {
  const { child } = handle;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    const stopped = await Promise.race([exited.then(() => true), sleep(5000, null, { ref: false }).then(() => false)]);
    if (!stopped) {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(2000, null, { ref: false })]);
    }
  }
  removeDir(handle.dataDir);
}

// ---------------------------------------------------------------- accounts mode

async function postJson(base, route, body, cookie, verb = 'POST') {
  const headers = { 'content-type': 'application/json', 'x-tabula': '1', ...(cookie ? { cookie } : {}) };
  const init = { method: verb, headers, body: JSON.stringify(body) };
  const res = await fetch(`${base}/api/${route}`, init);
  if (!res.ok) throw new Error(`${verb} /api/${route} answered ${res.status}: ${await res.text()}`);
  return res;
}

async function readLoginToken(dataDir) {
  const outbox = path.join(dataDir, 'outbox.jsonl');
  for (let i = 0; i < 100; i++) {
    const last = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).at(-1) : undefined;
    const match = last && /token=([^\s&]+)/.exec(JSON.parse(last).text);
    if (match) return decodeURIComponent(match[1]);
    await sleep(100);
  }
  throw new Error('no sign-in mail reached outbox.jsonl');
}

/** Signs the owner in over the API and creates the boards the home screen lists. Returns the session cookie. */
async function prepareAccounts({ base, dataDir }) {
  await postJson(base, 'auth/request', { email: OWNER_EMAIL });
  const verified = await postJson(base, 'auth/verify', { token: await readLoginToken(dataDir) });
  const [pair] = verified.headers.getSetCookie()[0].split(';');
  const cookie = pair.trim();
  await postJson(base, 'me', { name: USER.name }, cookie, 'PATCH');
  // created oldest first, a second apart, so the list order does not depend on the server's clock resolution
  for (const { id, title } of [...OTHER_BOARDS, { id: BOARD_ID, title: SEED_TITLE }]) {
    await postJson(base, 'boards', { id, title }, cookie);
    await sleep(1100);
  }
  const eq = cookie.indexOf('=');
  return { session: { name: cookie.slice(0, eq), value: cookie.slice(eq + 1) }, cookie };
}

// ---------------------------------------------------------------- browser

// Fonts come from Fontshare (the app's own choice). They are fetched once per run and replayed, so the run does not
// depend on the network after that; every other outside host is refused. Offline, the app falls back to system fonts.
const fontCache = new Map();
const isOutside = (url) => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1';

async function serveOutside(route) {
  const url = new URL(route.request().url());
  if (!url.hostname.endsWith('fontshare.com')) return route.abort();
  const key = url.href;
  if (!fontCache.has(key)) {
    fontCache.set(key, route.fetch({ timeout: 8000 }).then(async (res) => ({
      status: res.status(),
      headers: Object.fromEntries(Object.entries(res.headers()).filter(([name]) => !/^(content-encoding|content-length|transfer-encoding)$/.test(name))),
      body: await res.body(),
    }), () => null));
  }
  const cached = await fontCache.get(key);
  return cached ? route.fulfill(cached) : route.abort();
}

async function newPage(browser, { width, theme, mode, base, session }) {
  const context = await browser.newContext({
    viewport: { width, height: heightFor(width) },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.clock.setFixedTime(NOW);
  await context.route(isOutside, serveOutside);
  const boards = mode === 'open'
    ? [
      { id: BOARD_ID, name: SEED_TITLE, createdAt: NOW - 2 * HOUR, updatedAt: NOW - 5 * MINUTE },
      ...OTHER_BOARDS.map((b) => ({ id: b.id, name: b.title, createdAt: NOW - b.ago - HOUR, updatedAt: NOW - b.ago })),
    ]
    : null;
  await context.addInitScript(({ themeId, user, index }) => {
    try {
      localStorage.setItem('driftboard:theme', themeId);
      localStorage.setItem('driftboard:user', JSON.stringify(user));
      if (index) localStorage.setItem('driftboard:boards', JSON.stringify(index));
    } catch {
      /* storage is not available in this frame */
    }
  }, { themeId: theme, user: USER, index: boards });
  if (session) await context.addCookies([{ ...session, url: base, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return { context, page, errors };
}

async function capture({ browser, state, theme, width, file, shared }) {
  const { context, page, errors } = await newPage(browser, { width, theme, ...shared });
  const result = { state, theme, width, file, overflow: 0, errors, failed: null };
  try {
    const shot = await STATES[state]({ page, base: shared.base, dataDir: shared.dataDir, chat: shared.chat });
    // a state that holds the mouse down or keeps an input focused would be undone by parking
    if (shot?.noPark) { /* left as it is */ }
    else if (shot?.keepFocus) await page.mouse.move(1, 1);
    else await park(page);
    await settle(page);
    result.overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    await page.screenshot({ path: path.join(shared.outDir, file), animations: 'disabled', caret: 'hide', fullPage: FULL_PAGE.has(state) });
  } catch (err) {
    result.failed = String(err.message).split('\n')[0];
    result.file = file.replace(/\.png$/, '-FAILED.png');
    await page.screenshot({ path: path.join(shared.outDir, result.file), animations: 'disabled' }).catch(() => undefined);
  } finally {
    await context.close().catch(() => undefined);
  }
  return result;
}

// ---------------------------------------------------------------- contact sheet

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function writeIndex(outDir, { id, mode, results, seconds }) {
  const notes = (r) => [
    r.failed && `failed: ${r.failed}`,
    r.overflow > 0 && `page is ${r.overflow}px wider than the window`,
    r.errors.length > 0 && `${r.errors.length} script error${r.errors.length > 1 ? 's' : ''}: ${r.errors[0]}`,
  ].filter(Boolean);
  const states = [...new Set(results.map((r) => r.state))];
  const sections = states.map((state) => {
    const ofState = results.filter((r) => r.state === state);
    const rows = [...new Set(ofState.map((r) => r.theme))].map((theme) => {
      const figures = ofState.filter((r) => r.theme === theme).map((r) => {
        const flags = notes(r);
        return `<figure style="width:${Math.min(360, Math.max(140, Math.round(r.width / 4)))}px">
<a href="${esc(r.file)}"><img src="${esc(r.file)}" alt="${esc(`${r.state} ${r.theme} ${r.width}`)}" loading="lazy"></a>
<figcaption>${esc(r.theme)} · ${r.width}px${flags.length ? `<br><b>${esc(flags.join('; '))}</b>` : ''}</figcaption>
</figure>`;
      });
      return `<div class="row">\n${figures.join('\n')}\n</div>`;
    });
    return `<section><h2>${esc(state)}</h2>\n${rows.join('\n')}\n</section>`;
  });
  const problems = results.filter((r) => notes(r).length).length;
  fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(id)} visual check</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#18212b}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-top:1px solid #d5dbe2;padding-top:12px}
p{margin:0;color:#5b6672}.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;margin-bottom:16px}
figure{margin:0}img{display:block;width:100%;height:auto;border:1px solid #d5dbe2}
figcaption{font-size:12px;color:#5b6672;margin-top:4px}figcaption b{color:#d41e24;font-weight:600}
</style></head><body>
<h1>${esc(id)} visual check</h1>
<p>${results.length} screenshots, ${esc(mode)} mode, ${problems} with problems, ${seconds}s. Click a shot for full size.</p>
${sections.join('\n')}
</body></html>
`);
}

// ---------------------------------------------------------------- main

function readOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        id: { type: 'string' }, mode: { type: 'string', default: 'open' }, states: { type: 'string' }, widths: { type: 'string' },
        themes: { type: 'string' }, out: { type: 'string', default: 'tabula-review' }, 'no-build': { type: 'boolean' },
        frameable: { type: 'boolean' }, dark: { type: 'boolean' }, light: { type: 'boolean' }, help: { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  if (!values.id) throw new UsageError('--id is required, for example --id TAB-123');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values.id)) throw new UsageError('--id may only hold letters, digits, dot, dash and underscore');
  if (values.mode !== 'open' && values.mode !== 'accounts') throw new UsageError('--mode must be open or accounts');
  if (values.dark && values.light) throw new UsageError('--dark and --light exclude each other');

  const themes = readThemes();
  const chosenThemes = values.themes ? list(values.themes) : themes.map((t) => t.id);
  for (const t of chosenThemes) if (!themes.some((x) => x.id === t)) throw new UsageError(`unknown theme "${t}" (known: ${themes.map((x) => x.id).join(', ')})`);
  const scheme = values.dark ? 'dark' : values.light ? 'light' : null;
  const finalThemes = chosenThemes.filter((t) => !scheme || themes.find((x) => x.id === t).scheme === scheme);
  if (!finalThemes.length) throw new UsageError(`no ${scheme} theme among ${chosenThemes.join(', ')}`);

  const available = statesFor(values.mode);
  const states = values.states ? list(values.states) : available;
  for (const s of states) {
    if (!(s in STATES)) throw new UsageError(`unknown state "${s}" (known: ${Object.keys(STATES).join(', ')})`);
    if (!available.includes(s)) throw new UsageError(`state "${s}" needs --mode ${STATE_MODES[s].join(' or ')}`);
  }

  const widths = values.widths ? list(values.widths) : DEFAULT_WIDTHS;
  for (const w of widths) if (!/^\d+$/.test(String(w)) || w < 200 || w > 4000) throw new UsageError(`bad width "${w}" (200 to 4000)`);

  return {
    id: values.id, mode: values.mode, states, widths: widths.map(Number), themes: finalThemes, noBuild: values['no-build'] === true,
    frameable: values.frameable === true, outDir: path.resolve(values.out, values.id),
  };
}

function ensureBuilt(noBuild) {
  const custom = process.env.DIST_DIR;
  const distDir = path.resolve(custom || path.join(root, 'dist'));
  const built = fs.existsSync(path.join(distDir, 'index.html'));
  if (custom) {
    if (!built) throw new Error(`DIST_DIR is set but ${distDir}/index.html does not exist`);
    return distDir;
  }
  if (noBuild && built) return distDir;
  console.log('building the app (npm run build:app)');
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:app'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (run.status !== 0) throw new Error('npm run build:app failed');
  return distDir;
}

async function launchChromium() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new UsageError('playwright is not installed. Run npm ci, then once: npx playwright install chromium', false);
  }
  try {
    return await playwright.chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (err) {
    if (/Executable doesn't exist/i.test(err.message)) throw new UsageError('Chromium for Playwright is not installed. Run once: npx playwright install chromium', false);
    throw err;
  }
}

async function main() {
  const options = readOptions();
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const started = Date.now();
  let browser = null;
  let relay = null;
  let closing = null;
  const cleanup = () => (closing ??= (async () => {
    await browser?.close().catch(() => undefined);
    if (relay) await stopRelay(relay);
  })());
  const interrupted = () => cleanup().finally(() => process.exit(130));
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  process.on('SIGHUP', interrupted);

  const results = [];
  try {
    browser = await launchChromium();
    const distDir = ensureBuilt(options.noBuild);
    fs.mkdirSync(options.outDir, { recursive: true });
    relay = newRelayHandle();
    const chat = options.mode === 'accounts' && options.states.some((s) => CHAT_STATES.has(s));
    await startRelay(relay, { mode: options.mode, distDir, frameable: options.frameable, chat });
    const shared = { base: relay.base, mode: options.mode, outDir: options.outDir, session: null, dataDir: relay.dataDir, chat: null };
    if (options.mode === 'accounts') {
      const owner = await prepareAccounts(relay);
      shared.session = owner.session;
      if (chat) shared.chat = await seedChat(relay, owner.cookie);
    }
    for (const state of options.states) {
      for (const theme of options.themes) {
        for (const width of options.widths) {
          results.push(await capture({ browser, state, theme, width, file: `${state}-${theme}-${width}.png`, shared }));
        }
      }
    }
  } finally {
    await cleanup();
  }

  const seconds = Math.round((Date.now() - started) / 100) / 10;
  writeIndex(options.outDir, { id: options.id, mode: options.mode, results, seconds });
  const failed = results.filter((r) => r.failed);
  const flagged = results.filter((r) => !r.failed && (r.overflow > 0 || r.errors.length));
  for (const r of failed) console.error(`failed: ${r.state} ${r.theme} ${r.width}: ${r.failed}`);
  for (const r of flagged) console.error(`check: ${r.state} ${r.theme} ${r.width}: ${r.overflow > 0 ? `${r.overflow}px wider than the window` : `${r.errors.length} script error(s): ${r.errors[0]}`}`);
  const where = path.relative(process.cwd(), options.outDir) || '.';
  console.log(`visual-check: ${results.length - failed.length} screenshot${results.length - failed.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed` : ''}${flagged.length ? `, ${flagged.length} to look at` : ''} in ${where} (${seconds}s), open ${path.join(where, 'index.html')}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof UsageError) {
      console.error(err.showUsage ? `${err.message}\n\n${USAGE}` : err.message);
      process.exit(err.showUsage ? 2 : 1);
    }
    console.error(err);
    process.exit(1);
  },
);
