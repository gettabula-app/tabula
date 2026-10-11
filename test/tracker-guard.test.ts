import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as Y from 'yjs';
import { openDirectory } from '../server/directory.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';
import { createTrackerGuard } from '../server/tracker/guard.mjs';

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

function fixture({ linked = 1, active = true, clock = manualClock(), readOnly = false }: { linked?: number; active?: boolean; clock?: ReturnType<typeof manualClock>; readOnly?: boolean } = {}) {
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
  let guard = createTrackerGuard({
    directory,
    config: { readOnly },
    now: clock.now,
    setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
  });
  let run = (apply: () => void, who = actor) => guard.run(room, who, () => doc.transact(apply, 'client'));
  const count = (sql: string, ...args: (string | number | null)[]) => Number(directory.db.prepare(sql).get(...args)?.n ?? 0);
  let closed = false;
  let currentGuard = guard;
  const close = () => {
    if (closed) return;
    closed = true;
    currentGuard.flushTitles(boardId);
    directory.close();
    doc.destroy();
  };
  closeFixtures.push(close);
  const result = { folder, directory, actor, user, boardId, kanbanId, doc, objects, room, guard, run, put, tickets, count, clock, close };
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

  it('runs a 500-card paste inside one outer SQL transaction', () => {
    const f = fixture({ linked: 0 });
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
    });
    f.run = (apply: () => void, who = f.actor) => f.guard.run(f.room, who, () => f.doc.transact(apply, 'client'));
    f.run(() => {
      for (let index = 0; index < 500; index++) f.put(`paste-${index}`, 'card', {
        parent: 'lane-todo', rank: `a${index}@todo`, text: `Pasted ${index}`,
      });
    });
    expect(outerTransactions).toBe(1);
    expect(f.count('SELECT COUNT(*) AS n FROM tickets')).toBe(500);
    f.close();
  });

  it('creates at most 500 tickets from one update and sends one limit_exceeded notice', () => {
    const f = fixture({ linked: 0 });
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

  it('keeps the median unlinked-board guard cost below 1 ms in a 500-card room', () => {
    const f = fixture({ linked: 0, active: false });
    for (let index = 0; index < 500; index++) f.put(`plain-${index}`, 'card', { parent: 'lane-todo', rank: `a${index}`, text: `Plain ${index}` });
    const samples: number[] = [];
    for (let index = 0; index < 41; index++) {
      const start = process.hrtime.bigint();
      f.run(() => (f.objects.get('plain-0') as Y.Map<unknown>).set('x', index));
      samples.push(Number(process.hrtime.bigint() - start) / 1_000_000);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(1);
    f.close();
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
