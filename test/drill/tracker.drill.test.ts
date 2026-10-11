import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { createBackup, loadBackupConfig } from '../../server/backup.mjs';
import { MIGRATIONS, openDirectory } from '../../server/directory.mjs';
import { createLabel, createTicket, commentTicket } from '../../server/tracker/tickets.mjs';
import { relateTickets } from '../../server/tracker/relations.mjs';
import { subscribeTicket } from '../../server/tracker/subscriptions.mjs';
import { refreshTicketSearch } from '../../server/tracker/search.mjs';
import { checkTrackerData } from '../../server/tracker/backup-check.mjs';
import { reconcileTrackerProjection, SERVER_CARD_FIELDS } from '../../server/tracker/projection.mjs';
import { applyRestore, openSnapshot, planRestore } from '../../src/history';
import { Store } from '../../src/store';
import { CREDS, KEY, envFor } from '../backup-harness';
import { startFakeS3, type FakeS3 } from '../backup-fake-s3';
import { CONFIRM, filesOf } from '../restore-harness';
import { createFakeCloudControlPlane } from '../fake-cloud-control-plane';
import { createRelayKit, until, type Relay } from './drill-kit';

// TAB-94 / tracker slice 7D: runbook section 8, on real relay children and fake hosted services.
// The boxes are sequential and share one workspace; a failed prerequisite should make later boxes fail.

const CLOUD_TOKEN = 'd'.repeat(48);
const WORKSPACE = 'ws_tracker_drill';
const OWNER = 'owner@example.com';
const MEMBER = 'member@example.com';
const KEY_ROTATED = crypto.createHash('sha256').update('tracker drill rotated key').digest();
const TITLE_CANARY = 'Tracker restore title canary';
const COMMENT_CANARY = 'Tracker restore comment canary';
const B1 = 'trackerRestoreBoardOne';
const B2 = 'trackerRestoreBoardTwo';
const K1 = 'tracker-kanban-one';
const K2 = 'tracker-kanban-two';
const LANE1 = 'tracker-lane-one';
const LANE2 = 'tracker-lane-two';
const CANARY_ALIAS = 'OLD-7';

const kit = createRelayKit(CLOUD_TOKEN);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-tracker-drill-'));
const mainDir = path.join(scratch, 'workspace');
fs.mkdirSync(mainDir);
const fakes: FakeS3[] = [];
let fake: FakeS3;
let controlPlane: ReturnType<typeof createFakeCloudControlPlane>;
let controlUrl = '';
const measured: Record<string, unknown> = {};

function note(key: string, value: unknown) {
  measured[key] = value;
  const file = process.env.DRILL_REPORT_FILE;
  if (!file) return;
  // both drill files report into one file: merge what the other one wrote
  let other: Record<string, unknown> = {};
  try { other = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* nothing yet */ }
  fs.writeFileSync(file, JSON.stringify({ ...other, ...measured }, null, 2));
}

function trackerActor(user: any) {
  return { type: 'user', userId: user.id, user };
}

function keyEnv(key: Buffer, previous?: Buffer) {
  return {
    TABULA_BACKUP_KEY: key.toString('base64'),
    ...(previous ? { TABULA_BACKUP_KEY_PREVIOUS: previous.toString('base64') } : {}),
  };
}

function relayEnv(bucket: FakeS3, extra: Record<string, string> = {}) {
  return {
    TABULA_CLOUD_TOKEN: CLOUD_TOKEN,
    TABULA_CLOUD_URL: controlUrl,
    TABULA_CLOUD_WORKSPACE_ID: WORKSPACE,
    TABULA_FLY_VOLUME_ID: 'vol_tracker_drill',
    TABULA_CHAT: 'on',
    ...envFor(bucket, keyEnv(KEY)),
    ...keyEnv(KEY),
    TABULA_BACKUP_SETTLE_SECONDS: '1',
    TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    TABULA_TEST_RESTORE_EXIT_DELAY_MS: '2500',
    TABULA_TEST_RESTORE_DISK_USED: '0.2',
    ...extra,
    TABULA_TRACKER: 'on',
  };
}

const start = (dir: string, bucket: FakeS3, extra: Record<string, string> = {}) =>
  kit.launch(dir, relayEnv(bucket, extra), { clean: true });

type Client = ReturnType<typeof kit.client>;

/** The restore engine allows one whole restore per interval and keeps the time in its status record; the drill does several. */
function clearRestoreInterval(dir: string) {
  withDb(dir, (db) => { db.exec("DELETE FROM settings WHERE key = 'restore.status'"); }, false);
}

function withDb<T>(dir: string, fn: (db: DatabaseSync) => T, readOnly = true): T {
  const db = new DatabaseSync(path.join(dir, 'directory.sqlite'), readOnly ? { readOnly: true } : {});
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function docOf(bytes: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

function put(doc: Y.Doc, id: string, type: string, fields: Record<string, unknown> = {}) {
  doc.getMap('objects').set(id, new Y.Map(Object.entries({ id, type, ...fields })));
}

function boardBytes(board: 1 | 2) {
  const doc = new Y.Doc();
  const kanbanId = board === 1 ? K1 : K2;
  const laneId = board === 1 ? LANE1 : LANE2;
  put(doc, kanbanId, 'container', { layout: 'kanban' });
  put(doc, laneId, 'lane', { parent: kanbanId, name: 'To do', stage: 'todo', rank: 'a0@' + kanbanId });
  const cards: Array<{ id: string; title: string }> = [];
  for (let index = 0; index < 12; index++) {
    const id = 'tracker-card-' + board + '-' + index;
    const title = 'Linked tracker card ' + board + ' ' + index;
    put(doc, id, 'card', { parent: laneId, rank: 'a' + index.toString(36) + '@' + laneId, text: title });
    cards.push({ id, title });
  }
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return { bytes, kanbanId, laneId, cards };
}

function fileRoomAccess(directory: ReturnType<typeof openDirectory>, boardId: string) {
  const file = path.join(mainDir, boardId + '.yjs');
  const doc = docOf(fs.readFileSync(file));
  const roomAccess = {
    read: (_id: string, fn: (value: Y.Doc) => unknown) => fn(doc),
    write: (_id: string, _origin: string, fn: (value: Y.Doc) => unknown) => {
      let result: unknown;
      doc.transact(() => { result = fn(doc); }, 'tracker-drill');
      return result;
    },
  };
  return {
    doc,
    roomAccess,
    save() { fs.writeFileSync(file, Buffer.from(Y.encodeStateAsUpdate(doc))); },
  };
}

function manifestsOf(bucket: FakeS3) {
  return bucket.keys(/\/manifests\//).map((key) => key.split('/').pop()!).sort();
}

function newestOf(bucket: FakeS3) {
  return manifestsOf(bucket).at(-1)!;
}

function reader(bucket: FakeS3, keys: Buffer[] = [KEY_ROTATED, KEY]) {
  const config = loadBackupConfig(envFor(bucket, {
    TABULA_BACKUP_KEY: keys[0].toString('base64'),
    ...(keys.length > 1 ? { TABULA_BACKUP_KEY_PREVIOUS: keys.slice(1).map((key) => key.toString('base64')).join(',') } : {}),
  }), () => {})!;
  const dir = fs.mkdtempSync(path.join(scratch, 'reader-'));
  return createBackup({ config, dataDir: dir, directory: null, log: () => {} })!;
}

async function cloneBucket(from: FakeS3) {
  const clone = await startFakeS3({ creds: CREDS });
  fakes.push(clone);
  for (const [key, value] of from.objects) {
    clone.objects.set(key, { body: Buffer.from(value.body), lastModified: value.lastModified });
  }
  return clone;
}

async function backedUpSince(client: Client, since: number, ms = 30_000) {
  let status: any;
  await until(async () => {
    status = (await client.internal('/api/internal/backup-status')).body;
    return status.lastSuccessAt >= since && !status.running && !status.dirty;
  }, ms);
  return status;
}

let chatSequence = 0;
async function changeWorkspace(client: Client, cookie: string) {
  const sequence = ++chatSequence;
  return client.api(cookie, 'POST', '/api/chat/board/' + B1 + '/messages', {
    text: 'tracker drill barrier marker ' + sequence,
    clientId: 'tracker-drill-chat-marker-' + sequence,
  });
}

function summaryIn(dir: string) {
  return withDb(dir, (db) => checkTrackerData(db));
}

function counterNext(dir: string) {
  return withDb(dir, (db) => Number(db.prepare(
    'SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?',
  ).get('trk_default', 'TAB')!.next_number));
}

function gateOnDisk(dir: string) {
  return withDb(dir, (db) => {
    const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('tracker.restore_gate')?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : null;
  });
}

function freshDir(name: string) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function roomHasCard(dir: string, boardId: string, cardId: string) {
  const file = path.join(dir, boardId + '.yjs');
  if (!fs.existsSync(file)) return false;
  const doc = docOf(fs.readFileSync(file));
  try {
    return doc.getMap('objects').has(cardId);
  } finally {
    doc.destroy();
  }
}

function floorReportedAtLeast(next: number) {
  return controlPlane.seen.some((call) => {
    if (call.method !== 'POST' || !call.url.endsWith('/key-floor')) return false;
    try {
      return JSON.parse(call.body).counters.some((row: any) =>
        row.scope === 'trk_default' && row.prefix === 'TAB' && row.floor >= next);
    } catch {
      return false;
    }
  });
}

function reportedFloorAtLeast(next: number) {
  const rows = controlPlane.seen.filter((call) => call.method === 'POST' && call.url.endsWith('/key-floor'))
    .flatMap((call) => {
      try { return JSON.parse(call.body).counters as Array<{ scope: string; prefix: string; floor: number }>; }
      catch { return []; }
    });
  return rows.filter((row) => row.scope === 'trk_default' && row.prefix === 'TAB' && row.floor >= next)
    .map((row) => row.floor).at(-1);
}

async function cloneManifest(bucket: FakeS3, name: string, dirName: string) {
  const dir = path.join(scratch, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const relay = await start(dir, bucket, {
    TABULA_BACKUP_SETTLE_SECONDS: '3600',
    TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
  });
  const client = kit.client(relay, dir);
  const cookie = await client.signIn(OWNER);
  const listing = (await client.api(cookie, 'GET', '/api/admin/backups')).body;
  const target = listing.backups.find((backup: any) => backup.name === name);
  expect(target).toMatchObject({ name, readable: true });
  const response = await client.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: name, confirm: CONFIRM });
  expect(response.status).toBe(202);
  expect(await relay.exited).toBe(75);
  kit.closeClients();
  const gateBeforeRecovery = gateOnDisk(dir);
  const startedAt = Date.now();
  const restoredRelay = await start(dir, bucket, {
    TABULA_BACKUP_SETTLE_SECONDS: '3600',
    TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
  });
  const restoredClient = kit.client(restoredRelay, dir);
  const restoredCookie = await restoredClient.signIn(OWNER);
  return { dir, relay: restoredRelay, client: restoredClient, cookie: restoredCookie, startedAt, gateBeforeRecovery };
}

function roomCardTitle(dir: string, boardId: string, cardId: string) {
  const doc = docOf(fs.readFileSync(path.join(dir, boardId + '.yjs')));
  try {
    const card = doc.getMap('objects').get(cardId) as Y.Map<unknown> | undefined;
    return typeof card?.get('text') === 'string' ? String(card.get('text')).split(/\r?\n/u)[0] : null;
  } finally {
    doc.destroy();
  }
}

const entries = async (client: Client, cookie: string, action: string) =>
  (await client.api(cookie, 'GET', '/api/admin/audit?limit=200&action=' + encodeURIComponent(action))).body.entries as Array<{ action: string; detail: any }>;

const state: {
  relay?: Relay;
  client?: Client;
  owner?: string;
  target?: string;
  targetCreatedAt?: number;
  barrierSince?: number;
  liveCounter?: number;
  lostKeys: string[];
  seedTickets: any[];
  seedTexts: string[];
  linkedCards: Array<{ boardId: string; cardId: string; title: string }>;
  linkIds: Record<string, string>;
  sharedTicketId?: string;
  sharedTicketKey?: string;
  aliasTicketKey?: string;
  cloneAvailable?: FakeS3;
  cloneUnknown?: FakeS3;
  restoreRecord?: any;
  damagedManifest?: string;
  schemaBucket?: FakeS3;
  schemaManifest?: string;
} = {
  lostKeys: [],
  seedTickets: [],
  seedTexts: [TITLE_CANARY, COMMENT_CANARY],
  linkedCards: [],
  linkIds: {},
};

beforeAll(async () => {
  controlPlane = createFakeCloudControlPlane();
  controlUrl = await controlPlane.start();
  fake = await startFakeS3({ creds: CREDS });
  fakes.push(fake);
});

afterAll(async () => {
  kit.closeClients();
  await kit.killAll();
  for (const bucket of fakes) await bucket.close();
  await controlPlane.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('hosted tracker restore drill (runbook section 8)', () => {
  it('[tracker.seed] pre-seed 40 tickets and link twelve cards on each of two boards', async () => {
    const directory = openDirectory(path.join(mainDir, 'directory.sqlite'));
    try {
      const owner = directory.createUser({ email: OWNER, name: 'Tracker Drill Owner', role: 'owner' })!;
      const member = directory.createUser({ email: MEMBER, name: 'Tracker Drill Member', role: 'member' })!;
      const ownerActor = trackerActor(owner);
      const memberActor = trackerActor(member);
      createLabel({ directory, actor: ownerActor, name: 'Tracker Seed', color: '#345678', now: Date.now() });
      createLabel({ directory, actor: ownerActor, name: 'Tracker Recovery', color: '#765432', now: Date.now() + 1 });
      for (let index = 0; index < 40; index++) {
        const title = index === 0 ? TITLE_CANARY : 'Tracker seed ticket ' + index;
        state.seedTexts.push(title);
        state.seedTickets.push(createTicket({
          directory,
          actor: ownerActor,
          title,
          labels: index === 1 ? ['Tracker Seed', 'Tracker Recovery'] : [],
          now: Date.now() + index,
        }));
      }
      directory.db.prepare(
        "INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, created_at) VALUES (?, ?, 'linear', ?, ?, ?)",
      ).run('tracker-imported-alias-s7d', state.seedTickets[0].id, CANARY_ALIAS, CANARY_ALIAS, Date.now());
      refreshTicketSearch(directory.db, state.seedTickets[0].id);
      subscribeTicket({ directory, actor: memberActor, key: state.seedTickets[0].key, now: Date.now() });
      commentTicket({
        directory,
        actor: ownerActor,
        key: state.seedTickets[0].key,
        body: COMMENT_CANARY,
        now: Date.now(),
      });
      relateTickets({
        directory,
        actor: ownerActor,
        key: state.seedTickets[1].key,
        relation: 'relates_to',
        otherKey: state.seedTickets[2].key,
        now: Date.now(),
      });
      expect(Number(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()!.n)).toBeGreaterThan(0);
    } finally {
      directory.close();
    }

    state.relay = await start(mainDir, fake, {
      TABULA_BACKUP_SETTLE_SECONDS: '3600',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    await until(() => floorReportedAtLeast(41));

    for (const [boardId, title] of [[B1, 'Tracker Restore Board One'], [B2, 'Tracker Restore Board Two']] as const) {
      expect((await state.client.api(state.owner, 'POST', '/api/boards', { id: boardId, title })).status).toBe(201);
    }
    const boardOne = boardBytes(1);
    const boardTwo = boardBytes(2);
    fs.writeFileSync(path.join(mainDir, B1 + '.yjs'), boardOne.bytes);
    fs.writeFileSync(path.join(mainDir, B2 + '.yjs'), boardTwo.bytes);
    state.linkedCards.push(...boardOne.cards.map((card) => ({ cardId: card.id, title: card.title, boardId: B1 })));
    state.linkedCards.push(...boardTwo.cards.map((card) => ({ cardId: card.id, title: card.title, boardId: B2 })));
    state.seedTexts.push(...state.linkedCards.map((card) => card.title));

    const firstLink = await state.client.api(state.owner, 'POST', '/api/tracker/links', {
      boardId: B1,
      kanbanId: K1,
      mapping: { [LANE1]: 'todo' },
      createTickets: true,
      idempotencyKey: 'tracker-seed-link-board-one',
    });
    expect(firstLink.status).toBe(201);
    expect(firstLink.body.created).toHaveLength(12);
    state.linkIds[B1] = firstLink.body.link.id;
    const secondLink = await state.client.api(state.owner, 'POST', '/api/tracker/links', {
      boardId: B2,
      kanbanId: K2,
      mapping: { [LANE2]: 'todo' },
      createTickets: true,
      idempotencyKey: 'tracker-seed-link-board-two',
    });
    expect(secondLink.status).toBe(201);
    expect(secondLink.body.created).toHaveLength(12);
    state.linkIds[B2] = secondLink.body.link.id;

    // The current link-card route creates a ticket and accepts no existing ticket reference. Re-point one
    // second-board card while stopped to exercise the requested cross-board ticket link without API rate pressure.
    kit.closeClients();
    expect(await kit.stop(state.relay)).toBe(0);
    const stopped = openDirectory(path.join(mainDir, 'directory.sqlite'));
    const room = fileRoomAccess(stopped, B2);
    try {
      // The first card of board one already has a ticket (made by the link): board two's first card is re-pointed to it.
      const shared = stopped.db.prepare(
        'SELECT l.ticket_id AS id, t.key FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE l.board_id = ? AND l.kanban_id = ? AND l.card_id = ? AND l.removed_at IS NULL',
      ).get(B1, K1, boardOne.cards[0].id) as { id: string; key: string };
      const sharedId = shared.id;
      const row = stopped.db.prepare(
        'SELECT id FROM ticket_links WHERE board_id = ? AND kanban_id = ? AND card_id = ? AND removed_at IS NULL',
      ).get(B2, K2, boardTwo.cards[0].id) as { id: string };
      stopped.db.prepare(
        'UPDATE ticket_links SET ticket_id = ?, last_projection_seq = (SELECT updated_seq FROM tickets WHERE id = ?) WHERE id = ?',
      ).run(sharedId, sharedId, row.id);
      reconcileTrackerProjection({
        directory: stopped,
        roomAccess: room.roomAccess,
        boardId: B2,
        baseUrl: 'https://tabula.example.test',
        now: Date.now(),
        mode: 'sql-wins',
      });
      room.save();
      state.sharedTicketId = shared.id;
      state.sharedTicketKey = shared.key;
      state.aliasTicketKey = state.seedTickets[0].key;
    } finally {
      room.doc.destroy();
      stopped.close();
    }

    state.relay = await start(mainDir, fake);
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    state.barrierSince = Date.now();
    await changeWorkspace(state.client, state.owner);
  });

  it('[tracker.barrier_backup] backup summary matches live tracker counts and has no findings', async () => {
    const status = await backedUpSince(state.client!, state.barrierSince!);
    state.target = status.lastManifest;
    expect(state.target).toBeTruthy();
    expect(newestOf(fake)).toBe(state.target);

    const checkStarted = Date.now();
    const live = summaryIn(mainDir);
    note('trackerCheckMs', Date.now() - checkStarted);
    expect(live.findings).toEqual([]);
    const configReader = reader(fake);
    const manifest = await configReader.readManifest(state.target!);
    const manifestTracker = manifest.tracker!;
    const manifestSummary = manifestTracker.summary!;
    state.targetCreatedAt = Date.parse(manifest.createdAt);
    expect(manifestSummary).toEqual(live.summary);
    expect(manifestTracker.findings).toEqual([]);

    const listed = (await state.client!.api(state.owner!, 'GET', '/api/admin/backups')).body;
    expect(listed.status.tracker).toMatchObject({
      tickets: live.summary!.tickets,
      events: live.summary!.events,
      findings: [],
    });

    // Freeze disaster buckets before the in-place restore writes its higher-counter safety manifest.
    state.cloneAvailable = await cloneBucket(fake);
    state.cloneUnknown = await cloneBucket(fake);
  });

  it('[tracker.restore_workspace] restore the barrier snapshot through exit 75 and recover tracker rows', async () => {
    kit.closeClients();
    expect(await kit.stop(state.relay!)).toBe(0);
    const directory = openDirectory(path.join(mainDir, 'directory.sqlite'));
    try {
      const owner = directory.getUserByEmail(OWNER)!;
      const actor = trackerActor(owner);
      for (let index = 0; index < 5; index++) {
        const title = 'Lost after barrier ticket ' + index;
        state.seedTexts.push(title);
        state.lostKeys.push(createTicket({ directory, actor, title, now: Date.now() + index }).key);
      }
      state.liveCounter = Number(directory.db.prepare(
        'SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?',
      ).get('trk_default', 'TAB')!.next_number);
    } finally {
      directory.close();
    }

    state.relay = await start(mainDir, fake, {
      TABULA_BACKUP_SETTLE_SECONDS: '3600',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    await until(() => floorReportedAtLeast(state.liveCounter!));
    const manifestReader = reader(fake);
    const manifest = await manifestReader.readManifest(state.target!);
    const manifestSummary = manifest.tracker!.summary!;
    note('trackerDataAgeAtRestoreSeconds', Math.max(0, Math.floor((Date.now() - Date.parse(manifest.createdAt)) / 1000)));

    const restoreStartedAt = Date.now();
    const response = await state.client.api(state.owner, 'POST', '/api/admin/backups/restore', {
      manifest: state.target,
      confirm: CONFIRM,
    });
    expect(response.status).toBe(202);
    expect(await state.relay.exited).toBe(75);
    kit.closeClients();
    note('trackerRestoreSeconds', Math.round((Date.now() - restoreStartedAt) / 100) / 10);

    expect(gateOnDisk(mainDir)).toMatchObject({ floor: 'known' });
    const recoveryStartedAt = Date.now();
    state.relay = await start(mainDir, fake);
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    let recoveryReadiness: any;
    await until(async () => {
      recoveryReadiness = (await state.client!.api(state.owner!, 'GET', '/api/admin/tracker/readiness')).body;
      return recoveryReadiness.gate === null;
    });
    expect(recoveryReadiness.gate).toBeNull();
    note('trackerReconcileSeconds', Math.round((Date.now() - recoveryStartedAt) / 100) / 10);
    const listing = (await state.client.api(state.owner, 'GET', '/api/admin/backups')).body;
    state.restoreRecord = listing.restore.last;
    expect(state.restoreRecord).toMatchObject({ kind: 'workspace', result: 'done', manifest: state.target });
    const restored = summaryIn(mainDir).summary!;
    expect(restored).toMatchObject({
      tickets: manifestSummary.tickets,
      events: manifestSummary.events,
      comments: manifestSummary.comments,
      aliases: manifestSummary.aliases,
      links: manifestSummary.links,
      kanbanLinks: manifestSummary.kanbanLinks,
    });
    expect(restored.tickets).toBeGreaterThanOrEqual(40);
    expect(restored.counters[0].next).toBeGreaterThanOrEqual(state.liveCounter!);
    expect(summaryIn(mainDir).findings).toEqual([]);
    const detail = (await state.client.api(state.owner, 'GET', '/api/tracker/tickets/' + state.aliasTicketKey)).body;
    expect(detail.ticket.aliases).toContain(CANARY_ALIAS);
    expect(detail.comments.map((comment: any) => comment.body)).toContain(COMMENT_CANARY);
    expect(withDb(mainDir, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get()!.n))).toBeGreaterThanOrEqual(1);
    const shared = (await state.client.api(state.owner, 'GET', '/api/tracker/tickets/' + state.sharedTicketKey)).body;
    expect(shared.ticket.links.map((link: any) => link.boardId)).toEqual(expect.arrayContaining([B1, B2]));
    const labelled = (await state.client.api(state.owner, 'GET', '/api/tracker/tickets/' + state.seedTickets[1].key)).body.ticket;
    expect(labelled.labels.map((label: any) => label.name)).toEqual(expect.arrayContaining(['Tracker Seed', 'Tracker Recovery']));
    expect(withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM ticket_subscriptions WHERE ticket_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)',
    ).get(state.seedTickets[0].id, MEMBER)!.n))).toBe(1);
    expect(withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)',
    ).get(state.seedTickets[0].id, MEMBER)!.n))).toBeGreaterThan(0);
  });

  it('[tracker.lost_keys_not_reissued] the next ticket key is above all five lost keys', async () => {
    expect(state.lostKeys).toHaveLength(5);
    const lostNumbers = state.lostKeys.map((key) => Number(key.slice(key.lastIndexOf('-') + 1)));
    const created = await state.client!.api(state.owner!, 'POST', '/api/tracker/tickets', {
      title: 'Tracker post-restore key check',
      idempotencyKey: 'tracker-drill-post-restore-key',
    });
    expect(created.status).toBe(201);
    state.seedTexts.push(created.body.ticket.title);
    const number = Number(created.body.ticket.key.slice(created.body.ticket.key.lastIndexOf('-') + 1));
    expect(number).toBeGreaterThan(Math.max(...lostNumbers));
    expect(number).toBeGreaterThanOrEqual(state.liveCounter!);
  });

  it('[tracker.gate_cycle] readiness reports the restored gate cleared and an audit row exists', async () => {
    let readiness: any;
    await until(async () => {
      readiness = (await state.client!.api(state.owner!, 'GET', '/api/admin/tracker/readiness')).body;
      return readiness.gate === null;
    });
    expect(readiness.gate).toBeNull();
    expect(await entries(state.client!, state.owner!, 'tracker.gate_cleared')).toHaveLength(1);
  });

  it('[tracker.reconcile_boards] both linked boards are projected from SQL with unique active links', async () => {
    const listing = (await state.client!.api(state.owner!, 'GET', '/api/admin/backups')).body;
    const trackerRestore = listing.restore.last.tracker;
    expect(trackerRestore.boardsReconciled).toBe(2);
    expect(Object.values(trackerRestore.repaired).every((value) => typeof value === 'number')).toBe(true);
    const active = withDb(mainDir, (db) => db.prepare(
      'SELECT l.board_id, l.kanban_id, l.card_id, l.ticket_id, t.title FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE l.removed_at IS NULL ORDER BY l.board_id, l.card_id',
    ).all() as Array<{ board_id: string; kanban_id: string; card_id: string; ticket_id: string; title: string }>);
    expect(active).toHaveLength(24);
    expect(withDb(mainDir, (db) => db.prepare(
      'SELECT COUNT(*) AS n FROM (SELECT board_id, card_id FROM ticket_links WHERE removed_at IS NULL GROUP BY board_id, card_id HAVING COUNT(*) > 1)',
    ).get()!.n)).toBe(0);
    expect(withDb(mainDir, (db) => db.prepare(
      'SELECT COUNT(*) AS n FROM (SELECT kanban_id, ticket_id FROM ticket_links WHERE removed_at IS NULL GROUP BY kanban_id, ticket_id HAVING COUNT(*) > 1)',
    ).get()!.n)).toBe(0);
    expect(active.filter((row) => row.ticket_id === state.sharedTicketId).map((row) => row.board_id).sort()).toEqual([B1, B2].sort());
    for (const row of active) expect(roomCardTitle(mainDir, row.board_id, row.card_id)).toBe(row.title);
  });

  it('[tracker.search_rebuilt] restored FTS finds the imported alias and the canary title', async () => {
    const alias = (await state.client!.api(state.owner!, 'GET', '/api/tracker/tickets?q=' + encodeURIComponent(CANARY_ALIAS))).body;
    expect(alias.tickets.map((ticket: any) => ticket.key)).toContain(state.aliasTicketKey);
    const title = (await state.client!.api(state.owner!, 'GET', '/api/tracker/tickets?q=' + encodeURIComponent(TITLE_CANARY))).body;
    expect(title.tickets.map((ticket: any) => ticket.title)).toContain(TITLE_CANARY);
    const readiness = (await state.client!.api(state.owner!, 'GET', '/api/admin/tracker/readiness')).body;
    expect(readiness.checks.find((check: any) => check.id === 'search_ok')).toMatchObject({ state: 'pass' });
  });

  it('[tracker.hosted_floor_available] a new machine restores above the reported hosted key floor', async () => {
    await until(() => floorReportedAtLeast(state.liveCounter!));
    const reported = reportedFloorAtLeast(state.liveCounter!);
    expect(reported).toBeGreaterThanOrEqual(state.liveCounter!);
    const disaster = await cloneManifest(state.cloneAvailable!, state.target!, 'hosted-floor-available');
    expect(disaster.gateBeforeRecovery).toMatchObject({ floor: 'known' });

    let readiness: any;
    await until(async () => {
      readiness = (await disaster.client.api(disaster.cookie, 'GET', '/api/admin/tracker/readiness')).body;
      return readiness.gate === null;
    });
    expect(readiness.gate).toBeNull();
    expect(counterNext(disaster.dir)).toBeGreaterThanOrEqual(reported! + 25);
    expect((await disaster.client.api(disaster.cookie, 'GET', '/api/tracker/tickets?q=' + encodeURIComponent(CANARY_ALIAS))).status).toBe(200);
    expect(await kit.stop(disaster.relay)).toBe(0);
  });

  it('[tracker.hosted_floor_unknown] an unavailable hosted floor holds writes until the owner jumps the epoch', async () => {
    const targetManifest = await reader(fake).readManifest(state.target!);
    const oldNext = Number(targetManifest.tracker!.summary!.counters.find((row: any) => row.scope === 'trk_default' && row.prefix === 'TAB').next);
    controlPlane.setKeyFloorReadStatus(503);
    try {
      const disaster = await cloneManifest(state.cloneUnknown!, state.target!, 'hosted-floor-unknown');
      expect(disaster.gateBeforeRecovery).toMatchObject({ floor: 'pending' });
      let readiness: any;
      await until(async () => {
        readiness = (await disaster.client.api(disaster.cookie, 'GET', '/api/admin/tracker/readiness')).body;
        return readiness.gate?.closed === true && readiness.gate.floor === 'pending';
      });
      expect((await disaster.client.api(disaster.cookie, 'GET', '/api/tracker/tickets?q=' + encodeURIComponent(CANARY_ALIAS))).status).toBe(200);
      const blocked = await disaster.client.api(disaster.cookie, 'POST', '/api/tracker/tickets', {
        title: 'Tracker unknown floor write blocked',
        idempotencyKey: 'tracker-unknown-floor-write',
      });
      expect(blocked.status).toBe(503);
      expect(blocked.body.error).toBe('tracker_restoring');

      const jump = await disaster.client.api(disaster.cookie, 'POST', '/api/admin/tracker/key-epoch', { confirm: 'JUMP' });
      expect(jump.status).toBe(200);
      await until(async () => {
        readiness = (await disaster.client.api(disaster.cookie, 'GET', '/api/admin/tracker/readiness')).body;
        return readiness.gate === null;
      });
      expect(readiness.gate).toBeNull();
      const auditRows = await entries(disaster.client, disaster.cookie, 'tracker.key_epoch');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].detail.counters.every((row: any) => Number.isSafeInteger(row.oldNext)
        && Number.isSafeInteger(row.newNext) && row.newNext > row.oldNext)).toBe(true);
      const created = await disaster.client.api(disaster.cookie, 'POST', '/api/tracker/tickets', {
        title: 'Tracker ticket after owner epoch jump',
        idempotencyKey: 'tracker-unknown-floor-after-jump',
      });
      expect(created.status).toBe(201);
      const number = Number(created.body.ticket.key.slice(created.body.ticket.key.lastIndexOf('-') + 1));
      expect(number).toBeGreaterThanOrEqual(oldNext + 1000);
      state.seedTexts.push('Tracker unknown floor write blocked', 'Tracker ticket after owner epoch jump');
      expect(await kit.stop(disaster.relay)).toBe(0);
    } finally {
      controlPlane.setKeyFloorReadStatus(200);
    }
  });

  it('[tracker.board_copy_stripped] a copied linked board has no tracker projection fields or link rows', async () => {
    const linksBefore = withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM ticket_links WHERE board_id IN (?, ?) AND removed_at IS NULL',
    ).get(B1, B2)!.n));
    const copied = await state.client!.api(state.owner!, 'POST', '/api/admin/backups/restore-board', {
      manifest: state.target,
      boardId: B1,
    });
    expect(copied.status).toBe(200);
    expect(copied.body.trackerDetached).toBeGreaterThanOrEqual(1);
    const copyId = copied.body.boardId as string;
    const doc = docOf(fs.readFileSync(path.join(mainDir, copyId + '.yjs')));
    try {
      const cards: Y.Map<unknown>[] = [];
      doc.getMap('objects').forEach((object) => {
        if (object instanceof Y.Map && object.get('type') === 'card') cards.push(object);
      });
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) for (const field of SERVER_CARD_FIELDS) expect(card.has(field)).toBe(false);
    } finally {
      doc.destroy();
    }
    expect(withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM kanban_tracker_links WHERE board_id = ?',
    ).get(copyId)!.n))).toBe(0);
    expect(withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM ticket_links WHERE board_id = ?',
    ).get(copyId)!.n))).toBe(0);
    expect(withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM ticket_links WHERE board_id IN (?, ?) AND removed_at IS NULL',
    ).get(B1, B2)!.n))).toBe(linksBefore);
  });

  it('[tracker.history_restore] restoring a named pre-card version removes the link without a duplicate ticket', async () => {
    const named = await state.client!.api(state.owner!, 'POST', '/api/boards/' + B1 + '/versions', {
      label: 'Tracker drill before history card',
    });
    expect([200, 201]).toContain(named.status);
    const versionId = named.body.id as string;
    const stateResponse = await fetch(state.relay!.base + '/api/boards/' + B1 + '/versions/' + versionId + '/state', {
      headers: { cookie: state.owner! },
    });
    expect(stateResponse.status).toBe(200);
    const snapshotBytes = new Uint8Array(await stateResponse.arrayBuffer());

    const board = state.client!.connect(B1, state.owner!);
    await until(() => board.provider.wsconnected && board.provider.synced);
    const countBeforeCard = withDb(mainDir, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n));
    const cardId = 'tracker-history-extra-card';
    const title = 'Tracker history restore extra card';
    board.doc.getMap('objects').set(cardId, new Y.Map(Object.entries({
      id: cardId,
      type: 'card',
      parent: LANE1,
      rank: 'z9@' + LANE1,
      text: title,
    })));
    await until(() => roomHasCard(mainDir, B1, cardId));
    // A card made in a linked kanban gets its ticket from the server's guard (docs/tracker-api.md): wait for that link.
    await until(() => withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM ticket_links WHERE board_id = ? AND card_id = ? AND removed_at IS NULL',
    ).get(B1, cardId)!.n)) === 1, 15_000);
    state.seedTexts.push(title);
    const countAfterLink = withDb(mainDir, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n));
    expect(countAfterLink).toBe(countBeforeCard + 1);

    const began = await state.client!.api(state.owner!, 'POST', '/api/boards/' + B1 + '/versions/' + versionId + '/begin-restore', {});
    expect(began.status).toBe(200);
    const window = await state.client!.api(state.owner!, 'POST', '/api/tracker/boards/' + B1 + '/restore-window');
    expect(window.status).toBe(200);
    const snapshot = openSnapshot(snapshotBytes);
    try {
      const live = new Store(board.doc);
      applyRestore(live, planRestore(live, snapshot.store, { isHidden: () => false }));
      // Keep this path strict: if the named pre-card snapshot cannot remove the linked card through the restore window,
      // let this box fail here with the relay state available for diagnosis instead of relaxing the expectation.
      await until(() => !roomHasCard(mainDir, B1, cardId));
    } finally {
      snapshot.doc.destroy();
      const closed = await state.client!.api(state.owner!, 'DELETE', '/api/tracker/boards/' + B1 + '/restore-window');
      expect(closed.status).toBe(200);
    }
    await until(() => withDb(mainDir, (db) => Number(db.prepare(
      'SELECT COUNT(*) AS n FROM ticket_links WHERE board_id = ? AND card_id = ? AND removed_at IS NULL',
    ).get(B1, cardId)!.n)) === 0);
    expect(withDb(mainDir, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n))).toBe(countAfterLink);
  });

  it('[tracker.key_rotation] a previous key restores the manifest and a missing key is refused', async () => {
    const bucket = await cloneBucket(fake);
    const dir = freshDir('key-rotation');
    const rotatedKeys = keyEnv(KEY_ROTATED, KEY);
    let relay = await start(dir, bucket, { ...rotatedKeys, TABULA_BACKUP_SETTLE_SECONDS: '3600', TABULA_BACKUP_SHUTDOWN_SECONDS: '0' });
    let client = kit.client(relay, dir);
    let cookie = await client.signIn(OWNER);
    const restore = await client.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: state.target, confirm: CONFIRM });
    expect(restore.status).toBe(202);
    expect(await relay.exited).toBe(75);
    relay = await start(dir, bucket, { ...rotatedKeys, TABULA_BACKUP_SETTLE_SECONDS: '3600', TABULA_BACKUP_SHUTDOWN_SECONDS: '0' });
    client = kit.client(relay, dir);
    cookie = await client.signIn(OWNER);
    expect((await client.api(cookie, 'GET', '/api/admin/backups')).body.restore.last).toMatchObject({
      kind: 'workspace',
      result: 'done',
      manifest: state.target,
    });
    expect(summaryIn(dir).summary!.tickets).toBeGreaterThanOrEqual(40);
    expect(await kit.stop(relay)).toBe(0);

    const missingBucket = await cloneBucket(fake);
    const missingDir = freshDir('key-rotation-missing');
    const wrong = await start(missingDir, missingBucket, {
      ...keyEnv(KEY_ROTATED),
      TABULA_BACKUP_SETTLE_SECONDS: '3600',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    const wrongClient = kit.client(wrong, missingDir);
    const wrongCookie = await wrongClient.signIn(OWNER);
    const beforeFiles = filesOf(missingDir);
    const beforeTickets = withDb(missingDir, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n));
    const failed = await wrongClient.api(wrongCookie, 'POST', '/api/admin/backups/restore', { manifest: state.target, confirm: CONFIRM });
    expect(failed.status).toBe(422);
    expect(failed.body.error).toBe('unknown_key');
    expect(filesOf(missingDir)).toEqual(beforeFiles);
    expect(withDb(missingDir, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n))).toBe(beforeTickets);
    expect((await wrongClient.api(wrongCookie, 'GET', '/api/me')).status).toBe(200);
    expect(await kit.stop(wrong)).toBe(0);
  });

  it('[tracker.damaged_search] a restore rebuilds an emptied search index', async () => {
    kit.closeClients();
    expect(await kit.stop(state.relay!)).toBe(0);
    const damaged = new DatabaseSync(path.join(mainDir, 'directory.sqlite'));
    try {
      damaged.exec('DELETE FROM ticket_search');
      expect(Number(damaged.prepare('SELECT COUNT(*) AS n FROM ticket_search').get()!.n)).toBe(0);
    } finally {
      damaged.close();
    }

    const since = Date.now();
    state.relay = await start(mainDir, fake, {
      TABULA_BACKUP_SETTLE_SECONDS: '1',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    await changeWorkspace(state.client, state.owner);
    const status = await backedUpSince(state.client, since);
    state.damagedManifest = status.lastManifest;
    const restore = await state.client.api(state.owner, 'POST', '/api/admin/backups/restore', {
      manifest: state.damagedManifest,
      confirm: CONFIRM,
    });
    expect(restore.status).toBe(202);
    expect(await state.relay.exited).toBe(75);
    kit.closeClients();

    const rebuildStarted = Date.now();
    state.relay = await start(mainDir, fake);
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    let found: any;
    await until(async () => {
      found = await state.client!.api(state.owner!, 'GET', '/api/tracker/tickets?q=' + encodeURIComponent(TITLE_CANARY));
      return found.status === 200 && found.body.tickets.some((ticket: any) => ticket.title === TITLE_CANARY);
    }, 30_000);
    const readiness = (await state.client.api(state.owner, 'GET', '/api/admin/tracker/readiness')).body;
    expect(readiness.checks.find((check: any) => check.id === 'search_ok')).toMatchObject({ state: 'pass' });
    const restoreRecord = (await state.client.api(state.owner, 'GET', '/api/admin/backups')).body.restore.last;
    expect(Number(restoreRecord.tracker.repaired.fts_missing)).toBeGreaterThan(0);
    expect(found.status).toBe(200);
    note('trackerFtsRebuildSeconds', Math.round((Date.now() - rebuildStarted) / 100) / 10);
  });

  it('[tracker.missing_room_file] restoring a snapshot without one board unlinks that board only', async () => {
    await backedUpSince(state.client!, 0);
    kit.closeClients();
    expect(await kit.stop(state.relay!)).toBe(0);
    clearRestoreInterval(mainDir);
    const parked = path.join(scratch, 'tracker-board-one-parked.yjs');
    fs.renameSync(path.join(mainDir, B1 + '.yjs'), parked);

    state.relay = await start(mainDir, fake, {
      TABULA_BACKUP_SETTLE_SECONDS: '1',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    const since = Date.now();
    await changeWorkspace(state.client, state.owner);
    const status = await backedUpSince(state.client, since);
    const manifest = await reader(fake).readManifest(status.lastManifest);
    expect(manifest.files.some((file: any) => file.path === B1 + '.yjs')).toBe(false);
    fs.renameSync(parked, path.join(mainDir, B1 + '.yjs'));

    const restore = await state.client.api(state.owner, 'POST', '/api/admin/backups/restore', {
      manifest: status.lastManifest,
      confirm: CONFIRM,
    });
    expect(restore.status).toBe(202);
    expect(await state.relay.exited).toBe(75);
    kit.closeClients();
    state.relay = await start(mainDir, fake);
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);

    const last = (await state.client.api(state.owner, 'GET', '/api/admin/backups')).body.restore.last;
    expect(last.tracker.unlinked).toBeGreaterThan(0);
    const boardTwoLinks = withDb(mainDir, (db) => db.prepare(
      'SELECT l.card_id, t.title FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE l.board_id = ? AND l.removed_at IS NULL ORDER BY l.card_id',
    ).all(B2) as Array<{ card_id: string; title: string }>);
    expect(boardTwoLinks).toHaveLength(12);
    for (const row of boardTwoLinks) expect(roomCardTitle(mainDir, B2, row.card_id)).toBe(row.title);

    const emptyBoard = state.client.connect(B1, state.owner);
    await until(() => emptyBoard.provider.wsconnected && emptyBoard.provider.synced);
    expect(emptyBoard.doc.getMap('objects').size).toBe(0);
  });

  it('[tracker.schema_too_new] a newer directory schema is refused without changing workspace data', async () => {
    kit.closeClients();
    expect(await kit.stop(state.relay!)).toBe(0);
    const schemaDir = freshDir('schema-too-new-source');
    fs.copyFileSync(path.join(mainDir, 'directory.sqlite'), path.join(schemaDir, 'directory.sqlite'));
    const future = new DatabaseSync(path.join(schemaDir, 'directory.sqlite'));
    try {
      future.exec('DROP TABLE schema_meta; PRAGMA user_version = ' + (MIGRATIONS.length + 1));
    } finally {
      future.close();
    }

    state.schemaBucket = await cloneBucket(fake);
    const config = loadBackupConfig(envFor(state.schemaBucket, keyEnv(KEY)), () => {})!;
    const engine = createBackup({ config, dataDir: schemaDir, directory: null, log: () => {} })!;
    const backedUp = await engine.runNow() as { ok: boolean; manifest?: string };
    expect(backedUp).toMatchObject({ ok: true });
    state.schemaManifest = backedUp.manifest!;

    clearRestoreInterval(mainDir);
    state.relay = await start(mainDir, state.schemaBucket, {
      TABULA_BACKUP_SETTLE_SECONDS: '3600',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    state.client = kit.client(state.relay, mainDir);
    state.owner = await state.client.signIn(OWNER);
    const beforeSummary = summaryIn(mainDir).summary;
    const beforeRooms = filesOf(mainDir);
    const failed = await state.client.api(state.owner, 'POST', '/api/admin/backups/restore', {
      manifest: state.schemaManifest,
      confirm: CONFIRM,
    });
    expect(failed.status).toBe(422);
    expect(failed.body.error).toBe('schema_too_new');
    expect(summaryIn(mainDir).summary).toEqual(beforeSummary);
    expect(filesOf(mainDir)).toEqual(beforeRooms);
    expect((await state.client.api(state.owner, 'GET', '/api/me')).status).toBe(200);
  });

  it('[tracker.no_text_in_logs] ticket titles and comment text stay out of logs and status', async () => {
    const audit = (await state.client!.api(state.owner!, 'GET', '/api/admin/audit?limit=200')).body;
    const backups = (await state.client!.api(state.owner!, 'GET', '/api/admin/backups')).body;
    const readiness = (await state.client!.api(state.owner!, 'GET', '/api/admin/tracker/readiness')).body;
    const searchable = [
      ...kit.outputs.flatMap((output) => [output.out(), output.err()]),
      JSON.stringify(audit),
      JSON.stringify(backups.status),
      JSON.stringify(backups.restore?.last),
      JSON.stringify(readiness),
    ].join('\n');
    for (const text of state.seedTexts) expect(searchable).not.toContain(text);
  });
});
