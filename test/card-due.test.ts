import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../server/directory.mjs';
import { ASSIGN_WINDOW_MS, CARD_DUE_SETTING, cardDueRow, cardFirstLine, createCardDue, utcDay } from '../server/card-due.mjs';
import { createNotifications } from '../server/notifications.mjs';
import { createNotificationPrefs } from '../server/notification-prefs.mjs';

// Card reminders (TAB-164 slice 2): the pure extraction from a board document, the store's index and sweep against an in-memory
// directory with the real migrations 18 and 19, the assignment notice, the boot backfill, and what the list shows.

const T0 = Date.UTC(2026, 9, 13, 10, 0, 0); // 13 Oct 2026, 10:00 UTC
const DAY = 24 * 60 * 60 * 1000;
const TODAY = '2026-10-13';
const TOMORROW = '2026-10-14';
const YESTERDAY = '2026-10-12';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function open() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT, team_id TEXT, deleted_at INTEGER);
    CREATE TABLE board_shares (board_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (board_id, principal_type, principal_id));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ticket_events (id INTEGER PRIMARY KEY, ticket_id TEXT, actor_type TEXT, actor_id TEXT, details_json TEXT);
    CREATE TABLE user_prefs (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
  `);
  // Migration 18 (user_notifications) and 19 (card_due), exactly as the directory runs them.
  for (const index of [17, 18]) {
    const migration = MIGRATIONS[index];
    db.exec(typeof migration === 'string' ? migration : migration.sql);
  }
  const directory: any = {
    db,
    createUser({ email, name, role = 'member' }: { email: string; name: string; role?: string }) {
      const id = email.split('@')[0];
      db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id, email, name, role);
      return this.getUser(id);
    },
    getUser(id: string) {
      const row = db.prepare('SELECT id, email, name, role, disabled FROM users WHERE id = ?').get(id);
      return row ? { ...row, disabled: Boolean(row.disabled) } : null;
    },
    createBoard({ id, title, ownerId }: { id: string; title: string; ownerId: string }) {
      db.prepare('INSERT INTO boards (id, title, owner_id, team_id) VALUES (?, ?, ?, NULL)').run(id, title, ownerId);
      return this.getBoard(id);
    },
    getBoard(id: string) {
      const row = db.prepare('SELECT id, title, owner_id, deleted_at FROM boards WHERE id = ?').get(id);
      return row ? { id: row.id, title: row.title, ownerId: row.owner_id, deletedAt: row.deleted_at } : null;
    },
    deleteBoard(id: string) {
      db.prepare('UPDATE boards SET deleted_at = ? WHERE id = ?').run(T0, id);
    },
    shareBoard(boardId: string, principalId: string, role: string) {
      db.prepare("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES (?, 'user', ?, ?)").run(boardId, principalId, role);
    },
    unshareBoard(boardId: string, principalId: string) {
      db.prepare("DELETE FROM board_shares WHERE board_id = ? AND principal_type = 'user' AND principal_id = ?").run(boardId, principalId);
    },
    boardRole(boardId: string, userId: string) {
      const user = this.getUser(userId);
      const board = this.getBoard(boardId);
      if (!user || user.disabled || !board) return null;
      if (user.role === 'owner' || user.role === 'admin') return 'owner';
      if (board.deletedAt != null) return null;
      if (board.ownerId === userId) return 'owner';
      const share = db.prepare("SELECT role FROM board_shares WHERE board_id = ? AND principal_type = 'user' AND principal_id = ?").get(boardId, userId);
      return share?.role ?? null;
    },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getSetting(key: string) {
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },
    setSetting(key: string, value: string) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    getPref(userId: string, key: string) {
      return db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(userId, key)?.value ?? null;
    },
    setPref(userId: string, key: string, value: string) {
      db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, value);
    },
  };
  return directory;
}

type Fields = Record<string, unknown>;
/** A board document with a `doing` lane and a `done` lane. */
function boardDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    setObject(doc, 'lane-doing', { type: 'lane', stage: 'doing', name: 'Doing' });
    setObject(doc, 'lane-done', { type: 'lane', stage: 'done', name: 'Done' });
  });
  return doc;
}
function setObject(doc: Y.Doc, id: string, fields: Fields) {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) map.set(key, value);
  doc.getMap('objects').set(id, map);
}
function setCard(doc: Y.Doc, id: string, fields: Fields) {
  doc.transact(() => setObject(doc, id, { type: 'card', parent: 'lane-doing', text: 'Write the report', ...fields }));
}
function editCard(doc: Y.Doc, id: string, fields: Fields) {
  doc.transact(() => {
    const map = doc.getMap<Y.Map<unknown>>('objects').get(id)!;
    for (const [key, value] of Object.entries(fields)) map.set(key, value);
  });
}

/** A board document the store has seen, as the relay does when it opens a room: later changes are announced. */
function seededDoc(store: ReturnType<typeof createCardDue>, boardId: string): Y.Doc {
  const doc = boardDoc();
  store.seed(boardId, doc);
  return doc;
}

function setup(clock = { at: T0 }) {
  const directory = open();
  const ana = directory.createUser({ email: 'ana@example.com', name: 'Ana' });
  const ben = directory.createUser({ email: 'ben@example.com', name: 'Ben' });
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const board = directory.createBoard({ id: 'board_one', title: 'Launch', ownerId: owner.id });
  directory.shareBoard(board.id, ana.id, 'editor');
  directory.shareBoard(board.id, ben.id, 'editor');
  const notifications = createNotifications({ directory, now: () => clock.at });
  const store = createCardDue({ directory, notifications, now: () => clock.at });
  const rows = () => directory.db.prepare('SELECT board_id, card_id, user_id, due, soon_for, overdue_for FROM card_due ORDER BY card_id').all();
  const ledger = (kind?: string) => directory.db.prepare(
    'SELECT user_id, kind, ref, board_id, actor_id, created_at FROM user_notifications WHERE (? IS NULL OR kind = ?) ORDER BY created_at, id',
  ).all(kind ?? null, kind ?? null);
  return { directory, store, notifications, clock, ana, ben, owner, board, rows, ledger };
}

describe('the pure extraction', () => {
  it('indexes a card with a person owner and a due date in a lane that is not done', () => {
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerName: 'Ana', ownerKind: 'person', due: TODAY });
    expect(cardDueRow(doc, 'card-1')).toEqual({ cardId: 'card-1', userId: 'ana', due: TODAY });
    setCard(doc, 'card-2', { ownerId: 'ana', due: TODAY });
    expect(cardDueRow(doc, 'card-2')).toMatchObject({ userId: 'ana' });
  });

  it('skips agent owners, unowned cards, cards without a due date, and bad dates', () => {
    const doc = boardDoc();
    setCard(doc, 'agent', { ownerId: 'token-1', ownerKind: 'agent', due: TODAY });
    setCard(doc, 'nobody', { due: TODAY });
    setCard(doc, 'named-only', { ownerName: 'Marta', ownerKind: 'person', due: TODAY });
    setCard(doc, 'undated', { ownerId: 'ana', ownerKind: 'person' });
    setCard(doc, 'bad-date', { ownerId: 'ana', due: '2026-13-40' });
    setCard(doc, 'word', { ownerId: 'ana', due: 'tomorrow' });
    setCard(doc, 'not-a-card', { ownerId: 'ana', due: TODAY, type: 'sticky' });
    for (const id of ['agent', 'nobody', 'named-only', 'undated', 'bad-date', 'word', 'not-a-card', 'missing']) {
      expect(cardDueRow(doc, id)).toBeNull();
    }
  });

  it('drops a card in a done lane, and brings it back when it moves out', () => {
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY, parent: 'lane-done' });
    expect(cardDueRow(doc, 'card-1')).toBeNull();
    editCard(doc, 'card-1', { parent: 'lane-doing' });
    expect(cardDueRow(doc, 'card-1')).toMatchObject({ userId: 'ana' });
  });

  it('reads the first line of the text, and nothing for a card that is not there', () => {
    const doc = boardDoc();
    setCard(doc, 'card-1', { text: 'First line\nsecond line' });
    expect(cardFirstLine(doc, 'card-1')).toBe('First line');
    expect(cardFirstLine(doc, 'gone')).toBeNull();
  });
});

describe('the index', () => {
  it('upserts on a change, removes a row when the card leaves the index, and resets the reminder flags when the due date changes', () => {
    const { store, rows } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    store.upsertFor('board_one', doc, new Set(['card-1']));
    expect(rows()).toEqual([{ board_id: 'board_one', card_id: 'card-1', user_id: 'ana', due: TODAY, soon_for: null, overdue_for: null }]);

    store.sweep(T0);
    expect(rows()[0]).toMatchObject({ soon_for: TODAY });
    editCard(doc, 'card-1', { due: TOMORROW });
    store.upsertFor('board_one', doc, new Set(['card-1']));
    expect(rows()[0]).toMatchObject({ due: TOMORROW, soon_for: null, overdue_for: null });

    editCard(doc, 'card-1', { due: null });
    store.upsertFor('board_one', doc, new Set(['card-1']));
    expect(rows()).toEqual([]);
  });

  it('keeps the reminder flags when an unrelated field changes', () => {
    const { store, rows } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    store.upsertFor('board_one', doc, new Set(['card-1']));
    store.sweep(T0);
    editCard(doc, 'card-1', { text: 'Write the final report' });
    store.upsertFor('board_one', doc, new Set(['card-1']));
    expect(rows()[0]).toMatchObject({ soon_for: TODAY });
  });

  it('recomputes the cards of a lane whose stage changed, and drops a deleted card', () => {
    const { store, rows } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    setCard(doc, 'card-2', { ownerId: 'ana', ownerKind: 'person', due: TOMORROW });
    store.upsertFor('board_one', doc, new Set(['card-1', 'card-2']));
    expect(rows().map((r: any) => r.card_id)).toEqual(['card-1', 'card-2']);
    editCard(doc, 'lane-doing', { stage: 'done' });
    store.upsertFor('board_one', doc, new Set(['lane-doing']));
    expect(rows()).toEqual([]);
    editCard(doc, 'lane-doing', { stage: 'doing' });
    store.upsertFor('board_one', doc, new Set(['lane-doing']));
    expect(rows().map((r: any) => r.card_id)).toEqual(['card-1', 'card-2']);
    doc.transact(() => doc.getMap('objects').delete('card-1'));
    store.upsertFor('board_one', doc, new Set(['card-1']));
    expect(rows().map((r: any) => r.card_id)).toEqual(['card-2']);
  });

  it('does not index a person who is not an account', () => {
    const { store, rows } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'nobody-here', ownerKind: 'person', due: TODAY });
    store.upsertFor('board_one', doc, new Set(['card-1']));
    expect(rows()).toEqual([]);
  });

  it('removes a board on request', () => {
    const { store, rows } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    store.upsertFor('board_one', doc, new Set(['card-1']));
    store.removeBoard('board_one');
    expect(rows()).toEqual([]);
  });
});

describe('the sweep', () => {
  it('records due today or tomorrow once, and overdue once when the day has passed', () => {
    const { store, ledger, clock, board } = setup();
    const doc = boardDoc();
    setCard(doc, 'today', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    setCard(doc, 'tomorrow', { ownerId: 'ana', ownerKind: 'person', due: TOMORROW });
    setCard(doc, 'yesterday', { ownerId: 'ana', ownerKind: 'person', due: YESTERDAY });
    store.upsertFor(board.id, doc, new Set(['today', 'tomorrow', 'yesterday']));

    expect(store.sweep(clock.at)).toMatchObject({ card_due_soon: 2, card_overdue: 1 });
    expect(ledger('card_due_soon').map((r: any) => r.ref).sort()).toEqual(['today', 'tomorrow']);
    expect(ledger('card_overdue').map((r: any) => r.ref)).toEqual(['yesterday']);
    expect(store.sweep(clock.at + 60_000)).toMatchObject({ card_due_soon: 0, card_overdue: 0 });
    expect(ledger()).toHaveLength(3);
  });

  it('uses the UTC calendar date, not the local one', () => {
    expect(utcDay(Date.UTC(2026, 9, 13, 23, 30))).toBe(TODAY);
    const { store, ledger, board } = setup({ at: Date.UTC(2026, 9, 13, 23, 30) });
    const doc = boardDoc();
    setCard(doc, 'late', { ownerId: 'ana', ownerKind: 'person', due: TOMORROW });
    store.upsertFor(board.id, doc, new Set(['late']));
    expect(store.sweep(Date.UTC(2026, 9, 13, 23, 30))).toMatchObject({ card_due_soon: 1 });
    expect(ledger('card_due_soon')).toHaveLength(1);
  });

  it('re-arms a reminder when the due date changes, and not before', () => {
    const { store, ledger, clock, board } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    store.upsertFor(board.id, doc, new Set(['card-1']));
    store.sweep(clock.at);
    store.sweep(clock.at);
    expect(ledger('card_due_soon')).toHaveLength(1);
    editCard(doc, 'card-1', { due: TODAY });
    store.upsertFor(board.id, doc, new Set(['card-1']));
    store.sweep(clock.at);
    expect(ledger('card_due_soon')).toHaveLength(1);
    editCard(doc, 'card-1', { due: TOMORROW });
    store.upsertFor(board.id, doc, new Set(['card-1']));
    store.sweep(clock.at);
    expect(ledger('card_due_soon')).toHaveLength(2);
  });

  it('records nothing for a person who lost the board role, and records it once they have it again', () => {
    const { store, ledger, directory, clock, board, ana } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    store.upsertFor(board.id, doc, new Set(['card-1']));
    directory.unshareBoard(board.id, ana.id);
    expect(store.sweep(clock.at)).toMatchObject({ card_due_soon: 0 });
    expect(ledger()).toEqual([]);
    directory.shareBoard(board.id, ana.id, 'viewer');
    expect(store.sweep(clock.at)).toMatchObject({ card_due_soon: 1 });
  });

  it('records nothing for a deleted board', () => {
    const { store, ledger, directory, clock, board } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    store.upsertFor(board.id, doc, new Set(['card-1']));
    directory.deleteBoard(board.id);
    store.sweep(clock.at);
    expect(ledger()).toEqual([]);
  });

  it('keeps a done card out of the sweep entirely', () => {
    const { store, ledger, clock, board } = setup();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TODAY, parent: 'lane-done' });
    store.upsertFor(board.id, doc, new Set(['card-1']));
    store.sweep(clock.at);
    expect(ledger()).toEqual([]);
  });

  it('removes rows whose due date is more than 30 days old', () => {
    const { store, rows, clock, board } = setup();
    const doc = boardDoc();
    setCard(doc, 'old', { ownerId: 'ana', ownerKind: 'person', due: utcDay(clock.at - 31 * DAY) });
    setCard(doc, 'recent', { ownerId: 'ana', ownerKind: 'person', due: utcDay(clock.at - 29 * DAY) });
    store.upsertFor(board.id, doc, new Set(['old', 'recent']));
    store.sweep(clock.at);
    expect(rows().map((r: any) => r.card_id)).toEqual(['recent']);
  });
});

describe('the assignment notice', () => {
  it('tells a person a card was assigned to them by someone else, and never for self-assignment', () => {
    const { store, ledger, board, ana, ben } = setup();
    const doc = seededDoc(store, board.id);
    setCard(doc, 'card-1', { ownerId: ana.id, ownerKind: 'person' });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    expect(ledger('card_assigned')).toEqual([expect.objectContaining({ user_id: ana.id, ref: 'card-1', board_id: board.id, actor_id: ben.id })]);

    setCard(doc, 'card-2', { ownerId: ana.id, ownerKind: 'person' });
    store.upsertFor(board.id, doc, new Set(['card-2']), { actorId: ana.id });
    expect(ledger('card_assigned')).toHaveLength(1);
  });

  it('does not repeat when someone edits a card that is already theirs, and is quiet for a write with no actor', () => {
    const { store, ledger, board, ana, ben } = setup();
    const doc = seededDoc(store, board.id);
    setCard(doc, 'card-1', { ownerId: ana.id, ownerKind: 'person' });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    editCard(doc, 'card-1', { text: 'Edited by Ben' });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    setCard(doc, 'card-2', { ownerId: ana.id, ownerKind: 'person' });
    store.upsertFor(board.id, doc, new Set(['card-2']));
    expect(ledger('card_assigned')).toHaveLength(1);
  });

  it('keeps one notice per person and card inside ten minutes, and tells again after the window', () => {
    const { store, ledger, clock, board, ana, ben } = setup();
    const doc = seededDoc(store, board.id);
    setCard(doc, 'card-1', { ownerId: ana.id, ownerKind: 'person' });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    editCard(doc, 'card-1', { ownerId: ben.id });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ana.id });
    clock.at += 60_000;
    editCard(doc, 'card-1', { ownerId: ana.id });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    expect(ledger('card_assigned').filter((r: any) => r.user_id === ana.id)).toHaveLength(1);

    clock.at += ASSIGN_WINDOW_MS;
    editCard(doc, 'card-1', { ownerId: ben.id });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ana.id });
    editCard(doc, 'card-1', { ownerId: ana.id });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    expect(ledger('card_assigned').filter((r: any) => r.user_id === ana.id)).toHaveLength(2);
  });

  it('does not notify a person who has no role on the board', () => {
    const { store, ledger, directory, board, ben } = setup();
    const outsider = directory.createUser({ email: 'outsider@example.com', name: 'Outsider' });
    const doc = seededDoc(store, board.id);
    setCard(doc, 'card-1', { ownerId: outsider.id, ownerKind: 'person' });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    expect(ledger('card_assigned')).toEqual([]);
  });

  it('is not announced for the opening state of a board that was never seen before', () => {
    const { store, ledger, board, ben } = setup();
    const doc = seededDoc(store, board.id);
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person' });
    store.seed(board.id, doc);
    editCard(doc, 'card-1', { text: 'Edited' });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    expect(ledger('card_assigned')).toEqual([]);
  });
});

describe('the boot backfill', () => {
  it('indexes every board that is not deleted, batch by batch, then sets the key and does not run again', async () => {
    const { store, directory, rows, board, ana } = setup();
    const second = directory.createBoard({ id: 'board_two', title: 'Second', ownerId: ana.id });
    const gone = directory.createBoard({ id: 'board_gone', title: 'Gone', ownerId: ana.id });
    directory.deleteBoard(gone.id);
    const docs = new Map<string, Y.Doc>();
    for (const id of [board.id, second.id, gone.id]) {
      const doc = boardDoc();
      setCard(doc, `card-${id}`, { ownerId: ana.id, ownerKind: 'person', due: TODAY });
      docs.set(id, doc);
    }
    const reads: string[] = [];
    const roomAccess = { read: (name: string, fn: (doc: Y.Doc) => unknown) => { reads.push(name); return fn(docs.get(name) ?? new Y.Doc()); } };
    let ticks = 0;
    const schedule = (fn: () => void) => { ticks++; queueMicrotask(fn); };
    await expect(store.backfillAll({ roomAccess, batch: 1, schedule, run: (fn: () => unknown) => fn() })).resolves.toEqual({ boards: 2, skipped: false });
    expect(ticks).toBe(2);
    expect(reads.sort()).toEqual([board.id, second.id].sort());
    expect(rows().map((r: any) => r.board_id).sort()).toEqual([board.id, second.id].sort());
    expect(directory.getSetting(CARD_DUE_SETTING)).toBe('1');
    expect(await store.backfillAll({ roomAccess, schedule, run: (fn: () => unknown) => fn() })).toEqual({ boards: 0, skipped: true });
    expect(reads).toHaveLength(2);
  });
});

describe('the boot backfill does not send old news', () => {
  const run = { schedule: (fn: () => void) => queueMicrotask(fn), run: (fn: () => unknown) => fn() };
  const oneBoard = (store: any, directory: any, board: any, ana: any, due: string) => {
    const doc = boardDoc();
    setCard(doc, 'card-old', { ownerId: ana.id, ownerKind: 'person', due });
    return { doc, roomAccess: { read: (_name: string, fn: (doc: Y.Doc) => unknown) => fn(doc) } };
  };

  it('marks an already overdue card as told, so the first sweep after an upgrade says nothing about it', async () => {
    const { store, directory, rows, ledger, board, ana } = setup();
    const { roomAccess } = oneBoard(store, directory, board, ana, '2020-01-01');
    await store.backfillAll({ roomAccess, ...run });
    expect(rows()[0].overdue_for).toBe('2020-01-01');
    store.sweep();
    expect(ledger('card_overdue')).toEqual([]);
  });

  it('keeps the told-marks when the backfill runs a second time (a restart before it finished)', async () => {
    const { store, directory, rows, ledger, board, ana } = setup();
    const { roomAccess } = oneBoard(store, directory, board, ana, TODAY);
    await store.backfillAll({ roomAccess, ...run });
    store.sweep();
    expect(ledger('card_due_soon')).toHaveLength(1);
    directory.setSetting(CARD_DUE_SETTING, '');
    await store.backfillAll({ roomAccess, ...run });
    expect(rows()[0].soon_for).toBe(TODAY);
    store.sweep();
    expect(ledger('card_due_soon')).toHaveLength(1);
  });
});

describe('what the list shows', () => {
  it('shows the card line only while the person still has a role and the card is on the board', () => {
    const { store, directory, board, ana, ben } = setup();
    const docs = new Map<string, Y.Doc>();
    const doc = seededDoc(store, board.id);
    setCard(doc, 'card-1', { ownerId: ana.id, ownerKind: 'person', text: 'Write the report\nsecond line' });
    docs.set(board.id, doc);
    const roomAccess = { read: (name: string, fn: (doc: Y.Doc) => unknown) => fn(docs.get(name) ?? new Y.Doc()) };
    const live = createNotifications({ directory, roomAccess, now: () => T0 });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    expect(live.list({ user: ana })).toMatchObject({ unread: 1, items: [{ kind: 'card_assigned', snippet: 'Write the report', target: `#/b/${board.id}`, actor: { id: ben.id } }] });

    directory.unshareBoard(board.id, ana.id);
    expect(live.list({ user: ana })).toMatchObject({ unread: 0, items: [] });
    directory.shareBoard(board.id, ana.id, 'viewer');
    expect(live.list({ user: ana }).items).toHaveLength(1);
    doc.transact(() => doc.getMap('objects').delete('card-1'));
    expect(live.list({ user: ana })).toMatchObject({ unread: 0, items: [] });
  });

  it('lists a reminder with no actor and the first line of the card', () => {
    const { store, directory, board, ana, clock } = setup();
    const docs = new Map<string, Y.Doc>();
    const doc = boardDoc();
    setCard(doc, 'card-1', { ownerId: ana.id, ownerKind: 'person', due: TODAY, text: 'Ship the thing' });
    docs.set(board.id, doc);
    const roomAccess = { read: (name: string, fn: (doc: Y.Doc) => unknown) => fn(docs.get(name) ?? new Y.Doc()) };
    store.upsertFor(board.id, doc, new Set(['card-1']));
    store.sweep(clock.at);
    const live = createNotifications({ directory, roomAccess, now: () => T0 });
    expect(live.list({ user: ana })).toMatchObject({ unread: 1, items: [{ kind: 'card_due_soon', actor: null, snippet: 'Ship the thing', board: { id: board.id, title: 'Launch' } }] });
  });
});

describe('the per-member switches (docs/notifications.md, Settings)', () => {
  it('marks a reminder told without a row while the switch is off, and does not release it when the switch goes back on', () => {
    const { directory, notifications, ledger, clock, board, ana } = setup();
    const prefs = createNotificationPrefs({ directory });
    const store = createCardDue({ directory, notifications, now: () => clock.at, shouldNotify: (userId, kind) => prefs.allows(userId, kind) });
    const doc = boardDoc();
    setCard(doc, 'old-soon', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    setCard(doc, 'old-late', { ownerId: 'ana', ownerKind: 'person', due: YESTERDAY });
    store.upsertFor(board.id, doc, new Set(['old-soon', 'old-late']));
    prefs.set(ana.id, { cards: false });

    expect(store.sweep(clock.at)).toMatchObject({ card_due_soon: 0, card_overdue: 0 });
    expect(ledger()).toEqual([]);
    expect(directory.db.prepare('SELECT card_id, soon_for, overdue_for FROM card_due ORDER BY card_id').all())
      .toEqual([
        { card_id: 'old-late', soon_for: null, overdue_for: YESTERDAY },
        { card_id: 'old-soon', soon_for: TODAY, overdue_for: null },
      ]);

    prefs.set(ana.id, { cards: true });
    expect(store.sweep(clock.at)).toMatchObject({ card_due_soon: 0, card_overdue: 0 });
    expect(ledger()).toEqual([]);

    setCard(doc, 'fresh', { ownerId: 'ana', ownerKind: 'person', due: TODAY });
    store.upsertFor(board.id, doc, new Set(['fresh']));
    expect(store.sweep(clock.at)).toMatchObject({ card_due_soon: 1, card_overdue: 0 });
    expect(ledger('card_due_soon').map((r: any) => r.ref)).toEqual(['fresh']);
  });

  it('does not write a card_assigned row while the cards switch is off', () => {
    const { directory, notifications, ledger, board, ana, ben } = setup();
    const prefs = createNotificationPrefs({ directory });
    const store = createCardDue({ directory, notifications, now: () => T0, shouldNotify: (userId, kind) => prefs.allows(userId, kind) });
    const doc = seededDoc(store, board.id);
    prefs.set(ana.id, { cards: false });
    setCard(doc, 'card-1', { ownerId: 'ana', ownerKind: 'person', due: TOMORROW });
    store.upsertFor(board.id, doc, new Set(['card-1']), { actorId: ben.id });
    expect(ledger()).toEqual([]);
  });
});

