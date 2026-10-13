import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import zlib from 'node:zlib';
import { Store } from '../src/store';
import { applyRestore, openSnapshot, planRestore } from '../src/history';
import { createHarness, until, type Account } from './mcp-harness';

const objs = (doc: { getMap(name: string): unknown }): any => doc.getMap('objects');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const h = createHarness({
  accounts: true,
  settings: { TRACKER: 'on' },
  dir: path.join(ROOT, `.tracker-attach-${process.pid}-${Date.now()}`),
});
let owner: Account;
let editor: Account;
let viewer: Account;
let outsider: Account;
let boardId: string;
let linkId: string;
let otherLinkId: string;
let live: ReturnType<typeof h.connect>;
let otherLive: ReturnType<typeof h.connect>;

function put(doc: Y.Doc, id: string, type: string, fields: Record<string, unknown> = {}) {
  objs(doc).set(id, new Y.Map(Object.entries({ id, type, ...fields })));
}
const api = (who: Account, method: string, route: string, body?: unknown) => h.api(who.cookie, method, route, body);
const attach = (who: Account, link: string, body: unknown) => api(who, 'POST', `/api/tracker/links/${link}/cards/attach`, body);

/**
 * Waits until the tracker restore gate answers open again. The server caches its answer for a second, so right after a test removes the gate row a
 * request can still be refused with 503. A refused request is not counted against the attach limiter (the gate is checked before it), and the one
 * that finally gets through counts once: never poll for a state in which attach calls are accepted and counted (60 a minute per person).
 */
const gateOpen = () => until(async () => (await attach(owner, linkId, {})).status !== 503);

function sql<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try { return fn(db); } finally { db.close(); }
}
const count = (query: string, ...args: string[]) => sql((db) => Number((db.prepare(query).get(...args) as { n: number }).n));
const activeLinks = (ticketId: string) => count('SELECT COUNT(*) AS n FROM ticket_links WHERE ticket_id = ? AND removed_at IS NULL', ticketId);

async function newTicket(title: string, state?: string) {
  const made = await api(owner, 'POST', '/api/tracker/tickets', { title, idempotencyKey: `attach-${title}-${Math.random().toString(36).slice(2)}` });
  if (made.status !== 201) throw new Error(`could not create ticket (${made.status})`);
  if (state) {
    const moved = await api(owner, 'POST', `/api/tracker/tickets/${made.body.ticket.key}/transition`, { state });
    if (moved.status !== 200) throw new Error(`could not move ticket (${moved.status})`);
  }
  return made.body.ticket as { id: string; key: string };
}

function boardDoc(cards: Record<string, string>, kanban: string) {
  const doc = new Y.Doc();
  put(doc, kanban, 'container', { layout: 'kanban' });
  put(doc, 'lane-todo', 'lane', { parent: kanban, name: 'To do', stage: 'todo', rank: 'a0@kanban-1' });
  put(doc, 'lane-doing', 'lane', { parent: kanban, name: 'Doing', stage: 'doing', rank: 'a1@kanban-1' });
  Object.entries(cards).forEach(([id, text], i) => put(doc, id, 'card', { parent: 'lane-todo', rank: `a${i}@lane-todo`, text }));
  return doc;
}

async function linkedBoard(cards: Record<string, string>, key: string, kanban: string) {
  const id = await h.newBoard(owner.cookie);
  const doc = boardDoc(cards, kanban);
  fs.writeFileSync(h.roomFile(id), Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const connection = h.connect(id, owner.cookie);
  await connection.synced();
  const linked = await api(owner, 'POST', '/api/tracker/links', {
    boardId: id, kanbanId: kanban, mapping: { 'lane-todo': 'todo', 'lane-doing': 'in_progress' },
    createTickets: false, idempotencyKey: key,
  });
  if (linked.status !== 201) throw new Error(`could not link (${linked.status})`);
  return { id, link: linked.body.link.id as string, connection };
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const teamId = (await h.newTeam(owner.cookie)).id;
  editor = await h.joinTeam(owner.cookie, teamId);
  viewer = await h.joinTeam(owner.cookie, teamId);
  outsider = await h.joinTeam(owner.cookie, teamId);
  const main = await linkedBoard({ 'card-1': 'First line\nKept line', 'card-2': 'Two', 'card-3': 'Three', 'card-4': 'Four', 'card-5': 'Five', 'card-6': 'Six', 'card-7': 'Old line\nSecond line' }, 'attach-link-main-123', 'kanban-main');
  boardId = main.id; linkId = main.link; live = main.connection;
  const other = await linkedBoard({ 'other-1': 'Other card' }, 'attach-link-other-123', 'kanban-other');
  otherLinkId = other.link; otherLive = other.connection;
  await h.share(owner.cookie, boardId, editor.user.id, 'editor');
  await h.share(owner.cookie, boardId, viewer.user.id, 'viewer');
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('POST /api/tracker/links/:id/cards/attach', () => {
  it('attaches an existing ticket, projects it onto the card, replays with 200 and leaves the ticket unchanged', async () => {
    const ticket = await newTicket('Existing work');
    const events = count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id);
    const first = await attach(owner, linkId, { cardId: 'card-1', ticket: ticket.key });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ cardId: 'card-1', ticket: { key: ticket.key } });
    await until(() => objs(live.doc).get('card-1')?.get('text') === 'Existing work\nKept line');
    expect(objs(live.doc).get('card-1')?.get('ext') ?? objs(live.doc).get('card-1')?.get('extKey')).toBeTruthy();
    expect(count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(events);

    const replay = await attach(owner, linkId, { cardId: 'card-1', ticket: ticket.key.toLowerCase() });
    expect(replay.status).toBe(200);
    expect(activeLinks(ticket.id)).toBe(1);
    const audits = (await api(owner, 'GET', '/api/admin/audit?limit=200&action=tracker.link.attach')).body.entries as { detail: Record<string, unknown> }[];
    expect(audits.filter((row) => row.detail.ticketId === ticket.id)).toHaveLength(1);
    const row = audits.find((entry) => entry.detail.ticketId === ticket.id)!;
    expect(Object.keys(row.detail).sort()).toEqual(['boardId', 'cardId', 'linkId', 'ticketId']);
  });

  it('answers 409 when the card already has another ticket or the ticket is already on this kanban', async () => {
    const a = await newTicket('Conflict A');
    const b = await newTicket('Conflict B');
    expect((await attach(owner, linkId, { cardId: 'card-2', ticket: a.key })).status).toBe(201);
    expect(await attach(owner, linkId, { cardId: 'card-2', ticket: b.key }))
      .toMatchObject({ status: 409, body: { error: 'conflict', path: 'cardId' } });
    expect(await attach(owner, linkId, { cardId: 'card-3', ticket: a.key }))
      .toMatchObject({ status: 409, body: { error: 'conflict', path: 'ticket' } });
    expect(activeLinks(a.id)).toBe(1);
    expect(activeLinks(b.id)).toBe(0);
  });

  it('lets a ticket linked on another board gain one more link without moving the first', async () => {
    const t = await newTicket('Two boards');
    expect((await attach(owner, linkId, { cardId: 'card-3', ticket: t.key })).status).toBe(201);
    expect((await attach(owner, otherLinkId, { cardId: 'other-1', ticket: t.key })).status).toBe(201);
    expect(activeLinks(t.id)).toBe(2);
    await until(() => objs(otherLive.doc).get('other-1')?.get('text') === 'Two boards');
    expect(objs(live.doc).get('card-3')?.get('text')).toBe('Two boards');
  });

  it('refuses a ticket from another tracker as not found', async () => {
    const t = await newTicket('Elsewhere');
    sql((db) => {
      db.prepare("INSERT INTO trackers (id, name, prefix, created_at) VALUES ('trk_other', 'Other', 'OTH', 2)").run();
      db.prepare("UPDATE tickets SET tracker_id = 'trk_other' WHERE id = ?").run(t.id);
    });
    expect(await attach(owner, linkId, { cardId: 'card-4', ticket: t.key })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(activeLinks(t.id)).toBe(0);
  });

  it('checks access in order: board role 403, invisible ticket 404, then card, state and conflicts', async () => {
    const t = await newTicket('Access order');
    // A viewer of the board can read tickets but not write them; the board role comes first, so the editor tests the ticket rule.
    expect(await attach(viewer, linkId, { cardId: 'card-4', ticket: t.key })).toMatchObject({ status: 403 });
    expect(await attach(outsider, linkId, { cardId: 'card-4', ticket: t.key })).toMatchObject({ status: 404 });
    expect(await attach(owner, linkId, { cardId: 'card-4', ticket: 'TAB-99999' })).toMatchObject({ status: 404 });
    // An unknown ticket and an unknown card together still answer about the ticket first.
    expect(await attach(owner, linkId, { cardId: 'no-such-card', ticket: 'TAB-99999' })).toMatchObject({ status: 404 });
    expect(await attach(owner, linkId, { cardId: 'no-such-card', ticket: t.key })).toMatchObject({ status: 400, body: { path: 'cardId' } });
    expect(activeLinks(t.id)).toBe(0);
  });

  it('re-checks access on a replay', async () => {
    const t = await newTicket('Replay access');
    expect((await attach(owner, linkId, { cardId: 'card-5', ticket: t.key })).status).toBe(201);
    expect((await attach(owner, linkId, { cardId: 'card-5', ticket: t.key })).status).toBe(200);
    expect(await attach(outsider, linkId, { cardId: 'card-5', ticket: t.key })).toMatchObject({ status: 404 });
  });

  it('answers 422 for a state with no lane, and nothing is linked', async () => {
    const t = await newTicket('Done already', 'done');
    expect(await attach(owner, linkId, { cardId: 'card-6', ticket: t.key }))
      .toMatchObject({ status: 422, body: { error: 'state_not_mapped', path: 'ticket' } });
    expect(activeLinks(t.id)).toBe(0);
  });

  it('rejects unknown fields and a missing ticket', async () => {
    expect(await attach(owner, linkId, { cardId: 'card-6', ticket: 'TAB-1', extra: 1 })).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
    expect(await attach(owner, linkId, { cardId: 'card-6' })).toMatchObject({ status: 400, body: { error: 'invalid_input', path: 'ticket' } });
  });

  it('is paused by the restore gate', async () => {
    const t = await newTicket('Gated');
    sql((db) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tracker.restore_gate', ?)").run(JSON.stringify({ since: 1, reason: 'restore', floor: 'pending' })));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200)); // the gate answer is cached for one second
      expect(await attach(owner, linkId, { cardId: 'card-6', ticket: t.key })).toMatchObject({ status: 503, body: { error: 'tracker_restoring' } });
    } finally {
      sql((db) => db.prepare("DELETE FROM settings WHERE key = 'tracker.restore_gate'").run());
      await gateOpen(); // the next test starts with the gate open, not with a cached closed answer
    }
    expect(activeLinks(t.id)).toBe(0);
  });
});

describe('board snapshot before an attach replaces card text', () => {
  beforeAll(async () => { await gateOpen(); }); // the restore gate answer is cached for a second: wait until it is open, not a fixed time

  it('keeps the old text in a labelled version first, and restoring it brings the text back', async () => {
    const t = await newTicket('Snap title');
    const versionsBefore = (await api(owner, 'GET', `/api/boards/${boardId}/versions`)).body.versions as { id: string; label: string | null }[];
    expect(versionsBefore.some((v) => v.label === `Before attaching ${t.key}`)).toBe(false);
    expect(objs(live.doc).get('card-7')?.get('text')).toBe('Old line\nSecond line');

    const attached = await attach(owner, linkId, { cardId: 'card-7', ticket: t.key });
    expect({ status: attached.status, body: attached.body }).toMatchObject({ status: 201 }); // a failure shows the status and body
    await until(() => objs(live.doc).get('card-7')?.get('text') === 'Snap title\nSecond line');

    const versions = (await api(owner, 'GET', `/api/boards/${boardId}/versions`)).body.versions as { id: string; label: string | null; kind: string }[];
    const kept = versions.filter((v) => v.label === `Before attaching ${t.key}`);
    expect(kept).toHaveLength(1);
    const bytes = zlib.gunzipSync(fs.readFileSync(path.join(h.dir, 'history', boardId, `${kept[0].id}.yjs.gz`)));
    const snap = openSnapshot(bytes);
    expect(snap.store.objects.get('card-7')?.get('text')).toBe('Old line\nSecond line');
    expect(snap.store.objects.get('card-7')?.get('trackerId')).toBeUndefined();

    // The same plan and apply the history panel runs, against the live client document.
    const store = new Store(live.doc);
    const plan = planRestore(store, snap.store, { isHidden: () => false });
    expect(plan.change.some((c) => c.id === 'card-7')).toBe(true);
    applyRestore(store, plan);
    expect(objs(live.doc).get('card-7')?.get('text')).toBe('Old line\nSecond line');
    snap.doc.destroy();
  });

  it('takes no snapshot for a refused or replayed attach', async () => {
    const t = await newTicket('No snap');
    const count = async () => ((await api(owner, 'GET', `/api/boards/${boardId}/versions`)).body.versions as { label: string | null }[])
      .filter((v) => v.label === `Before attaching ${t.key}`).length;
    const refused = await attach(owner, linkId, { cardId: 'no-such-card', ticket: t.key });
    expect({ status: refused.status, body: refused.body }).toMatchObject({ status: 400 });
    expect(await count()).toBe(0);
  });
});
