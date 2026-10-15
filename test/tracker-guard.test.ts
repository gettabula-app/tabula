import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as Y from 'yjs';
import { openDirectory } from '../server/directory.mjs';
import { createTicket, updateTicket } from '../server/tracker/tickets.mjs';
import { createTrackerGuard } from '../server/tracker/guard.mjs';
import { createTrackerSocketBudget } from '../server/tracker/socket-budget.mjs';
import { reconcileTrackerProjection } from '../server/tracker/projection.mjs';

const folders: string[] = [];
const closeFixtures: (() => void)[] = [];
let serial = 0;

afterEach(() => {
  for (const close of closeFixtures.splice(0).reverse()) close();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  vi.useRealTimers();
});

function manualClock() {
  let time = 0;
  let id = 0;
  const timers = new Map<number, { due: number; run: () => void }>();
  return {
    now: () => time,
    setTimeout(run: () => void, delay: number) {
      const timer = ++id;
      timers.set(timer, { due: time + delay, run });
      return timer;
    },
    clearTimeout(timer: number) { timers.delete(timer); },
    advance(ms: number) {
      const target = time + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        time = next[1].due;
        timers.delete(next[0]);
        next[1].run();
      }
      time = target;
    },
  };
}

/** Counts the SQL statements a block runs, and the Y.Map snapshots (toJSON) it takes: work counts, not clocks (docs/testing.md). */
function countWork(f: { directory: { db: { prepare(sql: string): object } } }, block: () => void) {
  const statement = Object.getPrototypeOf(f.directory.db.prepare('SELECT 1')) as { run: unknown; get: unknown; all: unknown };
  const counts = { statements: 0, snapshots: 0 };
  const spies = (['run', 'get', 'all'] as const).map((name) => {
    const original = statement[name] as (...args: unknown[]) => unknown;
    const spy = vi.spyOn(statement as unknown as Record<string, (...args: unknown[]) => unknown>, name);
    return spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
      counts.statements++;
      return original.apply(this, args);
    });
  });
  const toJson = Y.Map.prototype.toJSON;
  const snapshots = vi.spyOn(Y.Map.prototype, 'toJSON').mockImplementation(function (this: Y.Map<unknown>) {
    counts.snapshots++;
    return toJson.call(this);
  });
  try {
    block();
  } finally {
    for (const spy of spies) spy.mockRestore();
    snapshots.mockRestore();
  }
  return counts;
}

function fixture({ linked = 1, active = true, clock = manualClock(), readOnly = false, ticketCreateLimit = 10, maxLinkedCardsPerUpdate = 100 }: {
  linked?: number; active?: boolean; clock?: ReturnType<typeof manualClock>; readOnly?: boolean;
  ticketCreateLimit?: number; maxLinkedCardsPerUpdate?: number;
} = {}) {
  const folder = `test/.tracker-guard-${process.pid}-${Date.now()}-${++serial}`;
  fs.mkdirSync(folder, { recursive: true });
  folders.push(folder);
  const directory = openDirectory(`${folder}/directory.sqlite`);
  const user = directory.createUser({ email: `guard-${serial}@example.test`, name: 'Guard Owner', role: 'owner' });
  if (!user) throw new Error('could not create guard test user');
  const boardId = `guard-board-${serial}`;
  directory.createBoard({ id: boardId, title: 'Guard board', ownerId: user.id });
  const actor = { type: 'user', userId: user.id, user };
  const doc = new Y.Doc();
  const objects = doc.getMap('objects');
  const put = (id: string, type: string, fields: Record<string, unknown> = {}) => {
    objects.set(id, new Y.Map(Object.entries({ id, type, ...fields })));
  };
  const kanbanId = 'kanban-main';
  put(kanbanId, 'container', { layout: 'kanban' });
  put('lane-todo', 'lane', { parent: kanbanId, rank: 'a0@kanban' });
  put('lane-doing', 'lane', { parent: kanbanId, rank: 'a1@kanban' });
  put('lane-done', 'lane', { parent: kanbanId, rank: 'a2@kanban' });
  put('lane-free', 'lane', { parent: kanbanId, rank: 'a3@kanban' });
  put('kanban-other', 'container', { layout: 'kanban' });
  put('lane-other', 'lane', { parent: 'kanban-other', rank: 'a0@other' });

  const tickets = new Map<string, any>();
  if (active) {
    const now = 1000;
    const linkId = `kanban-link-${serial}`;
    directory.transaction(() => {
      directory.db.prepare(
        `INSERT INTO kanban_tracker_links (id, board_id, kanban_id, workflow_id, created_at, created_by)
         VALUES (?, ?, ?, 'wf_default', ?, ?)`,
      ).run(linkId, boardId, kanbanId, now, user.id);
      for (const [laneId, stateId] of [['lane-todo', 'st_todo'], ['lane-doing', 'st_in_progress'], ['lane-done', 'st_done']]) {
        directory.db.prepare(
          `INSERT INTO kanban_state_mappings (kanban_link_id, lane_id, state_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(linkId, laneId, stateId, now, now);
      }
      for (let index = 0; index < linked; index++) {
        const cardId = `card-${index}`;
        const ticket = createTicket({ directory, actor, title: `Ticket ${index}`, state: 'todo', source: 'test', now });
        tickets.set(cardId, ticket);
        directory.db.prepare(
          `INSERT INTO ticket_links
            (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id, last_projection_seq)
           VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
        ).run(`card-link-${index}-${serial}`, ticket.id, boardId, kanbanId, cardId, now, user.id, ticket.updatedSeq);
        put(cardId, 'card', {
          parent: 'lane-todo', rank: `a${index}@todo`, text: `Ticket ${index}\nBody line`,
          extProvider: 'tabula', extKey: ticket.key, trackerId: ticket.trackerId,
          tracker: { ticketId: ticket.id, title: ticket.title, projectionSeq: ticket.updatedSeq },
        });
      }
    });
  }

  const room = { name: boardId, doc, held: null as Uint8Array[] | null, sent: [] as Uint8Array[], broadcastUpdate(update: Uint8Array) { this.sent.push(update); } };
  const roomAccess = {
    read: (_boardId: string, fn: (value: Y.Doc) => unknown) => fn(doc),
    write: (_boardId: string, _origin: string, fn: (value: Y.Doc) => unknown) => {
      let result: unknown;
      doc.transact(() => { result = fn(doc); }, 'tracker-test');
      return result;
    },
  };
  let guard = createTrackerGuard({
    directory,
    config: { readOnly },
    now: clock.now,
    setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
    ticketCreateLimit,
    maxLinkedCardsPerUpdate,
  });
  let run = (apply: () => void, who = actor) => guard.run(room, who, () => doc.transact(apply, 'client'));
  const count = (sql: string, ...args: (string | number | null)[]) => Number(directory.db.prepare(sql).get(...args)?.n ?? 0);
  let closed = false;
  let currentGuard = guard;
  const close = () => {
    if (closed) return;
    closed = true;
    currentGuard.flushTitles(boardId);
    currentGuard.clearRestoreWindows(boardId);
    directory.close();
    doc.destroy();
  };
  closeFixtures.push(close);
  const result = { folder, directory, actor, user, boardId, kanbanId, doc, objects, room, roomAccess, guard, run, put, tickets, count, clock, close };
  Object.defineProperty(result, 'guard', { get: () => currentGuard, set: (value: typeof guard) => { currentGuard = guard = value; } });
  Object.defineProperty(result, 'run', { get: () => run, set: (value: typeof run) => { run = value; } });
  return result;
}

function card(f: ReturnType<typeof fixture>, id = 'card-0') {
  return f.objects.get(id) as Y.Map<unknown>;
}

function ticketState(f: ReturnType<typeof fixture>, id = 'card-0') {
  const ticket = f.tickets.get(id);
  return f.directory.db.prepare(
    `SELECT s.state_key FROM tickets t JOIN ticket_states s ON s.id = t.state_id WHERE t.id = ?`,
  ).get(ticket.id)?.state_key as string;
}

describe('tracker linked-card guard', () => {
  it('transitions a move to a mapped lane once and removes moveBase', () => {
    const f = fixture();
    const ticket = f.tickets.get('card-0');
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id);
    const moved = f.run(() => { card(f).set('parent', 'lane-doing'); card(f).set('moveBase', ticket.updatedSeq); });
    expect(moved.undone).toEqual([]);
    expect(ticketState(f)).toBe('in_progress');
    expect(card(f).get('parent')).toBe('lane-doing');
    expect(card(f).has('moveBase')).toBe(false);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before + 1);

    f.run(() => { card(f).set('moveBase', ticket.updatedSeq + 1); });
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before + 1);
    f.close();
  });

  it('undoes a move into an unmapped lane with lane_unmapped', () => {
    const f = fixture();
    expect(f.run(() => card(f).set('parent', 'lane-free')).undone).toEqual([{ cardId: 'card-0', reason: 'lane_unmapped' }]);
    expect(card(f).get('parent')).toBe('lane-todo');
    expect(ticketState(f)).toBe('todo');
    f.close();
  });

  it('undoes a move to another kanban or a loose parent with card_stays_linked', () => {
    const f = fixture();
    expect(f.run(() => card(f).set('parent', 'lane-other')).undone).toEqual([{ cardId: 'card-0', reason: 'card_stays_linked' }]);
    expect(card(f).get('parent')).toBe('lane-todo');
    expect(f.run(() => card(f).set('parent', 'missing-lane')).undone).toEqual([{ cardId: 'card-0', reason: 'card_stays_linked' }]);
    expect(card(f).get('parent')).toBe('lane-todo');
    f.close();
  });

  it('leaves a rank-only reorder alone without a ticket event', () => {
    const f = fixture();
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events');
    expect(f.run(() => card(f).set('rank', 'z9@lane-todo')).undone).toEqual([]);
    expect(card(f).get('rank')).toBe('z9@lane-todo');
    expect(card(f).get('extProvider')).toBe('tabula');
    expect(card(f).get('tracker')).toMatchObject({ ticketId: f.tickets.get('card-0').id });
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events')).toBe(before);
    f.close();
  });

  it('keeps a checklist change on a linked card, and a title change made with it is still restored', () => {
    const f = fixture();
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events');
    const checklist = [{ id: 'pack', text: 'Pack the slides', done: false }];
    expect(f.run(() => card(f).set('checklist', checklist)).undone).toEqual([]);
    expect(card(f).get('checklist')).toEqual(checklist);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events')).toBe(before);

    const done = [{ id: 'pack', text: 'Pack the slides', done: true }];
    expect(f.run(() => { card(f).set('text', '\nbody'); card(f).set('checklist', done); }).undone)
      .toEqual([{ cardId: 'card-0', reason: 'title_invalid' }]);
    expect(card(f).get('text')).toBe('Ticket 0\nBody line');
    expect(card(f).get('checklist')).toEqual(done);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events')).toBe(before);
    f.close();
  });

  it('rejects stale moveBase and accepts a move with no moveBase', () => {
    const f = fixture();
    const ticket = f.tickets.get('card-0');
    f.directory.db.prepare("UPDATE ticket_field_versions SET event_seq = 9000 WHERE ticket_id = ? AND field = 'state'").run(ticket.id);
    expect(f.run(() => { card(f).set('parent', 'lane-doing'); card(f).set('moveBase', 1); }).undone)
      .toEqual([{ cardId: 'card-0', reason: 'conflict' }]);
    expect(card(f).get('parent')).toBe('lane-todo');
    expect(ticketState(f)).toBe('todo');

    expect(f.run(() => card(f).set('parent', 'lane-doing')).undone).toEqual([]);
    expect(ticketState(f)).toBe('in_progress');
    f.close();
  });

  it('deletes a card link without creating a ticket event', () => {
    const f = fixture();
    const ticket = f.tickets.get('card-0');
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id);
    f.run(() => f.objects.delete('card-0'));
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_links WHERE card_id = ? AND removed_at IS NOT NULL', 'card-0')).toBe(1);
    expect(f.count("SELECT COUNT(*) AS n FROM ticket_projection_outbox WHERE card_id = ? AND operation = 'remove'", 'card-0')).toBe(0);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before);
    f.close();
  });

  it('unlinks all cards and mappings when the kanban container is deleted', () => {
    const f = fixture({ linked: 2 });
    f.run(() => f.objects.delete(f.kanbanId));
    expect(f.count('SELECT COUNT(*) AS n FROM kanban_tracker_links WHERE board_id = ? AND removed_at IS NULL', f.boardId)).toBe(0);
    expect(f.count('SELECT COUNT(*) AS n FROM kanban_state_mappings')).toBe(0);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_links WHERE board_id = ? AND removed_at IS NULL', f.boardId)).toBe(0);
    expect(card(f).has('tracker')).toBe(false);
    f.close();
  });

  it('refuses deleting a container that touches more than 100 linked cards', () => {
    const f = fixture({ linked: 101 });
    const result = f.run(() => f.objects.delete(f.kanbanId));
    expect(result.undone).toHaveLength(101);
    expect(result.undone.every((entry) => entry.reason === 'bulk_change')).toBe(true);
    expect(f.objects.has(f.kanbanId)).toBe(true);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_links WHERE removed_at IS NULL')).toBe(101);
    f.close();
  });

  it('restores a mapped lane and its cards when a client deletes it', () => {
    const f = fixture();
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events');
    expect(f.run(() => { f.objects.delete('lane-todo'); f.objects.delete('card-0'); }).undone)
      .toEqual([{ cardId: 'card-0', reason: 'lane_mapped' }]);
    expect(f.objects.has('lane-todo')).toBe(true);
    expect(f.objects.has('card-0')).toBe(true);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events')).toBe(before);
    f.close();
  });

  it('creates a ticket when a mapped-lane card first gets a non-empty title and replays idempotently', () => {
    const f = fixture({ linked: 0 });
    f.run(() => f.put('new-card', 'card', { parent: 'lane-todo', rank: 'a9@todo', text: '' }));
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(0);
    f.run(() => card(f, 'new-card').set('text', 'Created on board\nKeep this body'));
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(1);
    expect(f.directory.db.prepare('SELECT t.title, s.state_key FROM tickets t JOIN ticket_states s ON s.id = t.state_id').get())
      .toMatchObject({ title: 'Created on board', state_key: 'todo' });
    f.run(() => card(f, 'new-card').set('text', 'Created on board\nKeep this body'));
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(1);
    f.close();
  });

  it('strips copied tracker fields from a pasted card and creates it as a new ticket', () => {
    const f = fixture({ linked: 1 });
    f.run(() => f.put('paste-card', 'card', {
      parent: 'lane-todo', rank: 'a8@todo', text: 'Pasted title', extProvider: 'tabula', extKey: 'TAB-OLD',
      trackerId: 'trk_old', tracker: { ticketId: 'old-ticket' }, extUrl: 'https://old.test/t/1',
    }));
    const pasted = card(f, 'paste-card');
    expect(pasted.has('extProvider')).toBe(false);
    expect(pasted.has('extKey')).toBe(false);
    expect(pasted.has('trackerId')).toBe(false);
    expect(pasted.has('tracker')).toBe(false);
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(2);
    expect(f.directory.db.prepare('SELECT t.title FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE l.card_id = ? AND l.removed_at IS NULL').get('paste-card')?.title)
      .toBe('Pasted title');
    f.close();
  });

  it('reactivates a matching deleted card link on undo without making a ticket', () => {
    const f = fixture();
    const ticket = f.tickets.get('card-0');
    f.run(() => f.objects.delete('card-0'));
    f.put('card-0', 'card', {
      parent: 'lane-todo', rank: 'a0@todo', text: 'Ticket 0\nBody line', extProvider: 'tabula',
      extKey: ticket.key, trackerId: ticket.trackerId, tracker: { ticketId: ticket.id, projectionSeq: ticket.updatedSeq },
    });
    const before = f.count('SELECT COUNT(*) AS n FROM tickets');
    f.run(() => card(f).set('text', 'Ticket 0\nBody line restored'));
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(before);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_links WHERE card_id = ? AND removed_at IS NULL', 'card-0')).toBe(1);
    f.close();
  });

  it('undoes linked edits for an actor without tracker write and for hosted read-only', () => {
    const f = fixture();
    const guest = f.directory.createUser({ email: `guard-guest-${serial}@example.test`, name: 'Guest', role: 'guest' });
    if (!guest) throw new Error('could not create guard test guest');
    expect(f.run(() => card(f).set('parent', 'lane-doing'), { type: 'user', userId: guest.id, user: guest }).undone)
      .toEqual([{ cardId: 'card-0', reason: 'forbidden' }]);
    expect(card(f).get('parent')).toBe('lane-todo');
    expect(f.run(() => card(f).set('rank', 'z9@lane-todo'), { type: 'user', userId: guest.id, user: guest }).undone)
      .toEqual([{ cardId: 'card-0', reason: 'forbidden' }]);
    expect(card(f).get('rank')).toBe('a0@todo');
    expect(f.run(() => card(f).set('text', 'Ticket 0\nChanged body'), { type: 'user', userId: guest.id, user: guest }).undone)
      .toEqual([{ cardId: 'card-0', reason: 'forbidden' }]);
    expect(card(f).get('text')).toBe('Ticket 0\nBody line');
    f.close();

    const readOnly = fixture({ readOnly: true });
    expect(readOnly.run(() => card(readOnly).set('parent', 'lane-doing')).undone)
      .toEqual([{ cardId: 'card-0', reason: 'read_only' }]);
    expect(card(readOnly).get('parent')).toBe('lane-todo');
    readOnly.close();
  });

  it('audits rejected linked changes once per user and board minute without card text', () => {
    const f = fixture();
    const guest = f.directory.createUser({ email: `guard-audit-guest-${serial}@example.test`, name: 'Guest', role: 'guest' });
    if (!guest) throw new Error('could not create guard audit test guest');
    const actor = { type: 'user', userId: guest.id, user: guest };
    expect(f.run(() => card(f).set('parent', 'lane-doing'), actor).undone[0]?.reason).toBe('forbidden');
    expect(f.run(() => card(f).set('text', 'Secret card text'), actor).undone[0]?.reason).toBe('forbidden');
    const rows = f.directory.db.prepare("SELECT detail FROM audit WHERE action = 'tracker.guard.reject'").all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('Secret card text');
    expect(JSON.stringify(rows)).toContain('forbidden');
    f.close();
  });

  it('writes text-free audit actions for move, title, create, and unlink', () => {
    const clock = manualClock();
    const f = fixture({ clock });
    f.run(() => card(f).set('parent', 'lane-doing'));
    f.run(() => card(f).set('text', 'Secret audit title\nBody line'));
    clock.advance(400);
    f.run(() => f.put('audit-card', 'card', { parent: 'lane-todo', rank: 'a9@todo', text: 'Created card' }));
    f.run(() => f.objects.delete('card-0'));

    const rows = f.directory.db.prepare("SELECT action, detail FROM audit WHERE action LIKE 'tracker.card.%' ORDER BY id").all();
    expect(rows.map((row) => String(row.action))).toEqual([
      'tracker.card.move', 'tracker.card.title', 'tracker.card.create', 'tracker.card.unlink',
    ]);
    expect(JSON.stringify(rows)).not.toContain('Secret audit title');
    f.close();
  });

  it('refuses an update touching more than 100 linked cards as one bulk change', () => {
    const f = fixture({ linked: 101 });
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events');
    const result = f.run(() => {
      for (let index = 0; index < 101; index++) (f.objects.get(`card-${index}`) as Y.Map<unknown>).set('parent', 'lane-doing');
    });
    expect(result.undone).toHaveLength(101);
    expect(result.undone.every((entry) => entry.reason === 'bulk_change')).toBe(true);
    expect([...Array(101)].every((_, index) => (f.objects.get(`card-${index}`) as Y.Map<unknown>).get('parent') === 'lane-todo')).toBe(true);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events')).toBe(before);
    f.close();
  });

  it('does not count a recolor of 150 linked cards toward the bulk threshold', () => {
    const f = fixture({ linked: 150 });
    const result = f.run(() => {
      for (let index = 0; index < 150; index++) (f.objects.get(`card-${index}`) as Y.Map<unknown>).set('color', `color-${index}`);
    });
    expect(result.undone).toEqual([]);
    expect([...Array(150)].every((_, index) => (f.objects.get(`card-${index}`) as Y.Map<unknown>).get('color') === `color-${index}`)).toBe(true);
    f.close();
  });

  it('keeps the bulk refusal active while a restore window is open', () => {
    const f = fixture({ linked: 101 });
    f.guard.openRestoreWindow(f.boardId, f.user.id, { roomAccess: f.roomAccess });
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events');
    const result = f.run(() => {
      for (let index = 0; index < 101; index++) (f.objects.get(`card-${index}`) as Y.Map<unknown>).set('parent', 'lane-doing');
    });
    expect(result.undone).toHaveLength(101);
    expect(result.undone.every((entry) => entry.reason === 'bulk_change')).toBe(true);
    expect([...Array(101)].every((_, index) => (f.objects.get(`card-${index}`) as Y.Map<unknown>).get('parent') === 'lane-todo')).toBe(true);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events')).toBe(before);
    f.close();
  });

  it('holds lane and title edits during the same user’s restore window and extends it', () => {
    const clock = manualClock();
    const f = fixture({ clock });
    const ticket = f.tickets.get('card-0');
    const first = f.guard.openRestoreWindow(f.boardId, f.user.id, { roomAccess: f.roomAccess });
    expect(first.expiresAt).toBe(15_000);
    clock.advance(1000);
    const extended = f.guard.openRestoreWindow(f.boardId, f.user.id, { roomAccess: f.roomAccess });
    expect(extended.expiresAt).toBe(16_000);
    expect(() => f.guard.openRestoreWindow(f.boardId, 'another-user', { roomAccess: f.roomAccess })).toThrow(/another user/u);

    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id);
    expect(f.run(() => {
      card(f).set('parent', 'lane-doing');
      card(f).set('rank', 'restore-rank');
      card(f).set('text', 'Draft title\nRestored body');
      card(f).set('desc', 'A non-tracker field passes');
    }).undone).toEqual([]);
    expect(card(f).get('parent')).toBe('lane-todo');
    expect(card(f).get('rank')).toBe('a0@todo');
    expect(card(f).get('text')).toBe('Ticket 0\nRestored body');
    expect(card(f).get('desc')).toBe('A non-tracker field passes');
    expect(ticketState(f)).toBe('todo');
    expect(f.directory.db.prepare('SELECT title FROM tickets WHERE id = ?').get(ticket.id)?.title).toBe('Ticket 0');
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before);

    expect(f.guard.closeRestoreWindow(f.boardId, f.user.id)).toMatchObject({ closed: true, projectionPending: false });
    f.close();
  });

  it('records a restore unlink when its update deletes a linked card', () => {
    const f = fixture();
    const ticket = f.tickets.get('card-0');
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id);
    f.guard.openRestoreWindow(f.boardId, f.user.id, { roomAccess: f.roomAccess });
    expect(f.run(() => f.objects.delete('card-0')).undone).toEqual([]);
    expect(f.objects.has('card-0')).toBe(false);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_links WHERE ticket_id = ? AND removed_at IS NULL', ticket.id)).toBe(0);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before + 1);
    expect(f.directory.db.prepare('SELECT event_type, source, details_json FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ticket.id))
      .toMatchObject({ event_type: 'unlinked', source: 'restore', details_json: '{"reason":"restore"}' });
    f.guard.closeRestoreWindow(f.boardId, f.user.id);
    f.close();
  });

  it('reconciles linked lane, rank, and title from SQL and retires a missing card link', () => {
    const f = fixture({ linked: 2 });
    const firstTicket = f.tickets.get('card-0');
    const missingTicket = f.tickets.get('card-1');
    updateTicket({ directory: f.directory, actor: f.actor, key: firstTicket.id, patch: { title: 'SQL title' }, source: 'test', now: 200 });
    card(f).set('parent', 'lane-doing');
    card(f).set('rank', 'restore-rank');
    card(f).set('text', 'Restored title\nBody line');
    f.objects.delete('card-1');

    expect(reconcileTrackerProjection({
      directory: f.directory, roomAccess: f.roomAccess, boardId: f.boardId, now: 300, mode: 'sql-wins',
    })).toMatchObject({ skipped: false, changed: 2, repaired: 2 });
    expect(card(f).get('parent')).toBe('lane-todo');
    expect(card(f).get('rank')).not.toBe('restore-rank');
    expect(card(f).get('text')).toBe('SQL title\nBody line');
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_links WHERE ticket_id = ? AND removed_at IS NULL', missingTicket.id)).toBe(0);
    expect(f.directory.db.prepare('SELECT event_type, source FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(missingTicket.id))
      .toMatchObject({ event_type: 'unlinked', source: 'restore' });
    f.close();
  });

  it('limits title writes to one coalesced commit and preserves later text lines', () => {
    const clock = manualClock();
    const f = fixture({ clock });
    const ticket = f.tickets.get('card-0');
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id);
    f.run(() => card(f).set('text', 'First draft\nbody two\nbody three'));
    expect(f.guard.hasPendingTitle(f.boardId, 'card-0')).toBe(true);
    clock.advance(399);
    f.run(() => card(f).set('text', 'Final title\nbody two\nbody three'));
    clock.advance(399);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before);
    clock.advance(1);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before + 1);
    expect(f.directory.db.prepare('SELECT title FROM tickets WHERE id = ?').get(ticket.id)?.title).toBe('Final title');
    expect(card(f).get('text')).toBe('Final title\nbody two\nbody three');
    expect(f.guard.hasPendingTitle(f.boardId, 'card-0')).toBe(false);
    f.close();
  });

  it('cancels a pending title when the latest draft returns to SQL', () => {
    const clock = manualClock();
    const f = fixture({ clock });
    const ticket = f.tickets.get('card-0');
    const before = f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id);
    f.run(() => card(f).set('text', 'Draft title\nBody line'));
    expect(f.guard.hasPendingTitle(f.boardId, 'card-0')).toBe(true);
    clock.advance(200);
    f.run(() => card(f).set('text', 'Ticket 0\nBody line'));
    clock.advance(1000);
    expect(f.count('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?', ticket.id)).toBe(before);
    expect(f.directory.db.prepare('SELECT title FROM tickets WHERE id = ?').get(ticket.id)?.title).toBe('Ticket 0');
    expect(card(f).get('text')).toBe('Ticket 0\nBody line');
    expect(f.guard.hasPendingTitle(f.boardId, 'card-0')).toBe(false);
    f.close();
  });

  it('commits pending titles when maintenance flushes all open boards', () => {
    const f = fixture();
    const ticket = f.tickets.get('card-0');
    f.run(() => card(f).set('text', 'Pending maintenance title\nBody line'));
    expect(f.guard.hasPendingTitle(f.boardId, 'card-0')).toBe(true);
    expect(f.guard.flushTitles()).toEqual({ committed: 1 });
    expect(f.directory.db.prepare('SELECT title FROM tickets WHERE id = ?').get(ticket.id)?.title)
      .toBe('Pending maintenance title');
    expect(f.guard.hasPendingTitle(f.boardId, 'card-0')).toBe(false);
    f.close();
  });

  it('rejects an empty title immediately', () => {
    const clock = manualClock();
    const f = fixture({ clock });
    expect(f.run(() => card(f).set('text', '\nbody')).undone).toEqual([{ cardId: 'card-0', reason: 'title_invalid' }]);
    expect(card(f).get('text')).toBe('Ticket 0\nBody line');
    f.close();
  });

  it('rate-limits the 241st guarded update for one user and board', () => {
    const clock = manualClock();
    const f = fixture({ clock });
    for (let index = 0; index < 240; index++) f.run(() => card(f).set('text', `Draft ${index}\nBody line`));
    expect(f.run(() => card(f).set('text', 'Draft 240\nBody line')).undone)
      .toEqual([{ cardId: 'card-0', reason: 'rate_limited' }]);
    f.close();
  });

  it('creates 500 tickets in one update and one outer SQL transaction, with SQL work that grows linearly', () => {
    // Raise both production caps here to count the transaction ceiling independently.
    const create = (count: number) => {
      const f = fixture({ linked: 0, ticketCreateLimit: 500, maxLinkedCardsPerUpdate: 500 });
      let depth = 0;
      let outerTransactions = 0;
      const directory = Object.create(f.directory);
      directory.transaction = (fn: () => unknown) => {
        if (depth === 0) outerTransactions++;
        depth++;
        try { return f.directory.transaction(fn); } finally { depth--; }
      };
      f.guard = createTrackerGuard({
        directory, now: f.clock.now,
        setTimeoutFn: f.clock.setTimeout as unknown as typeof setTimeout,
        clearTimeoutFn: f.clock.clearTimeout as unknown as typeof clearTimeout,
        ticketCreateLimit: 500,
        maxLinkedCardsPerUpdate: 500,
      });
      f.run = (apply: () => void, who = f.actor) => f.guard.run(f.room, who, () => f.doc.transact(apply, 'client'));
      const work = countWork(f, () => {
        f.run(() => {
          for (let index = 0; index < count; index++) f.put(`paste-${index}`, 'card', {
            parent: 'lane-todo', rank: `a${index}@todo`, text: `Pasted ${index}`,
          });
        });
      });
      const created = f.count('SELECT COUNT(*) AS n FROM tickets');
      f.close();
      return { work, outerTransactions, created };
    };
    const small = create(100);
    const large = create(500);
    expect(small.created).toBe(100);
    expect(large.created).toBe(500);
    expect(large.outerTransactions).toBe(1);
    // a fixed number of statements per ticket: five times the tickets is at most five times the statements plus a little overhead
    expect(large.work.statements).toBeLessThanOrEqual(5 * small.work.statements);
    expect(large.work.statements / 500).toBeLessThanOrEqual(small.work.statements / 100 + 0.5);
  });

  it('creates at most 500 tickets from one update and sends one limit_exceeded notice', () => {
    const f = fixture({ linked: 0, ticketCreateLimit: 500, maxLinkedCardsPerUpdate: 1000 });
    const result = f.run(() => {
      for (let index = 0; index < 501; index++) f.put(`paste-${index}`, 'card', {
        parent: 'lane-todo', rank: `a${index}@todo`, text: `Pasted ${index}`,
      });
    });
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(500);
    expect(result.undone).toEqual([{ cardId: 'paste-500', reason: 'limit_exceeded' }]);
    expect(f.objects.has('paste-500')).toBe(true);
    f.close();
  });

  it('caps auto-created tickets at 10 per user per minute across updates', () => {
    const clock = manualClock();
    const f = fixture({ linked: 0, clock });
    const first = f.run(() => {
      for (let index = 0; index < 12; index++) f.put(`capped-${index}`, 'card', {
        parent: 'lane-todo', rank: `a${index}@todo`, text: `Capped ${index}`,
      });
    });
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(10);
    expect(first.undone).toEqual([{ cardId: 'capped-10', reason: 'limit_exceeded' }]);
    expect(f.objects.has('capped-10')).toBe(true);
    expect(f.objects.has('capped-11')).toBe(true);

    const next = f.run(() => f.put('capped-later', 'card', {
      parent: 'lane-todo', rank: 'z9@todo', text: 'Capped later',
    }));
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(10);
    expect(next.undone).toEqual([{ cardId: 'capped-later', reason: 'limit_exceeded' }]);

    clock.advance(60_001);
    const reset = f.run(() => f.put('capped-after-window', 'card', {
      parent: 'lane-todo', rank: 'z8@todo', text: 'Capped after window',
    }));
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(11);
    expect(reset.undone).toEqual([]);
    f.close();
  });

  it('does no SQL and takes no object snapshot for a write in an unlinked 500-card room', () => {
    const f = fixture({ linked: 0, active: false });
    for (let index = 0; index < 500; index++) f.put(`plain-${index}`, 'card', { parent: 'lane-todo', rank: `a${index}`, text: `Plain ${index}` });
    f.run(() => (f.objects.get('plain-0') as Y.Map<unknown>).set('x', -1)); // the first write looks the board's links up once
    const work = countWork(f, () => {
      for (let index = 0; index < 20; index++) f.run(() => (f.objects.get('plain-0') as Y.Map<unknown>).set('x', index));
    });
    expect(work).toEqual({ statements: 0, snapshots: 0 });
    f.close();
  });

  it('takes the same snapshots in a 10k-object room as in a small one: the work follows the linked cards, not the room', () => {
    const measure = (extraShapes: number) => {
      const f = fixture({ linked: 150 });
      for (let index = 0; index < extraShapes; index++) f.put(`shape-${index}`, 'shape', { x: index, y: index });
      f.run(() => card(f).set('color', 'warmup'));
      const work = countWork(f, () => {
        for (let index = 0; index < 5; index++) f.run(() => card(f).set('color', `snapshot-${index}`));
      });
      const size = f.objects.size;
      const color = card(f).get('color');
      f.close();
      return { work, size, color };
    };
    const small = measure(0);
    const large = measure(10_000 - small.size);
    expect(large.size).toBe(10_000);
    expect(large.color).toBe('snapshot-4');
    expect(large.work.snapshots).toBeGreaterThan(0);
    expect(large.work).toEqual(small.work);
  });

  it('prunes idle per-user windows after two minutes using the injected clock', () => {
    const clock = manualClock();
    const f = fixture({ clock });
    const directory = Object.create(f.directory);
    directory.audit = () => {};
    f.guard = createTrackerGuard({
      directory, now: clock.now,
      setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
      clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
    });
    f.run = (apply: () => void, who = f.actor) => f.guard.run(f.room, who, () => f.doc.transact(apply, 'client'));

    for (let index = 0; index < 1024; index++) {
      const actor = { type: 'user', id: `idle-first-${index}`, role: 'guest' } as unknown as typeof f.actor;
      f.run(() => card(f).set('rank', `first-${index}`), actor);
    }
    clock.advance(120_001);
    for (let index = 0; index < 128; index++) {
      const actor = { type: 'user', id: `idle-second-${index}`, role: 'guest' } as unknown as typeof f.actor;
      f.run(() => card(f).set('rank', `second-${index}`), actor);
    }
    expect(f.guard.pruneIdleState()).toEqual({ rateWindows: 0, rejectAudits: 0 });
    f.close();
  });

  it('caps guard entries per user and board before work, across reconnects, and resets with an injected clock', () => {
    let time = 0;
    const budget = createTrackerSocketBudget({ now: () => time, max: 2 });
    const key = 'user-1\u0000board-1';
    expect(budget.allow(key)).toBe(true);
    expect(budget.allow(key)).toBe(true);
    expect(budget.allow(key)).toBe(false);
    // another board or another person has its own budget
    expect(budget.allow('user-1\u0000board-2')).toBe(true);
    expect(budget.allow('user-2\u0000board-1')).toBe(true);
    time = 60_000;
    expect(budget.allow(key)).toBe(true);
    for (let i = 0; i < 1100; i++) budget.allow(`idle-${i}\u0000b`);
    time = 200_000;
    budget.allow('fresh\u0000b');
    expect(budget.size).toBeLessThan(5);
  });

  it('fails closed on a thrown directory transaction and logs no card text', () => {
    const f = fixture();
    const messages: unknown[][] = [];
    const directory = Object.create(f.directory);
    directory.transaction = () => { throw Object.assign(new Error('secret title'), { code: 'ERR_SQLITE_ERROR' }); };
    const guard = createTrackerGuard({ directory, log: (...args: unknown[]) => messages.push(args) });
    f.guard = guard;
    const result = f.run(() => card(f).set('parent', 'lane-doing'));
    expect(result.undone).toEqual([{ cardId: 'card-0', reason: 'conflict' }]);
    expect(card(f).get('parent')).toBe('lane-todo');
    expect(ticketState(f)).toBe('todo');
    expect(JSON.stringify(messages)).not.toContain('secret title');
    f.close();
  });
});
