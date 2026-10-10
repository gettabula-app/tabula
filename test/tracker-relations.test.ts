import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/board-ops.mjs';
import { relateTickets } from '../server/tracker/relations.mjs';
import { createTicket, getTicket, updateTicket } from '../server/tracker/tickets.mjs';

const opened: any[] = [];
const open = () => {
  const directory: any = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};
function fixture() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  return { directory, actor: { id: owner.id, role: owner.role, name: owner.name } };
}
function expectCode(run: () => unknown, code: string) {
  let error: any;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(OpsError);
  expect(error.code).toBe(code);
  return error;
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('ticket relations', () => {
  it('stores inverse directions once and reads both tickets from their own perspective', () => {
    const { directory, actor } = fixture();
    const blocked = createTicket({ directory, actor, title: 'Blocked' });
    const blocker = createTicket({ directory, actor, title: 'Blocker' });
    const first = relateTickets({ directory, actor, key: blocker.key, relation: 'blocks', otherKey: blocked.key, now: 10 });
    expect(first.ticket.relations).toEqual([{ kind: 'blocks', key: blocked.key }]);
    expect(getTicket({ directory, actor, key: blocked.key }).relations).toEqual([{ kind: 'blocked_by', key: blocker.key }]);
    const again = relateTickets({ directory, actor, key: blocked.key, relation: 'blocked_by', otherKey: blocker.key, now: 20 });
    expect(again.ticket.relations).toEqual([{ kind: 'blocked_by', key: blocker.key }]);
    expect(directory.db.prepare('SELECT ticket_id, related_ticket_id, kind FROM ticket_relations').all()).toEqual([
      { ticket_id: blocker.id, related_ticket_id: blocked.id, kind: 'blocks' },
    ]);
    expect(directory.db.prepare('SELECT ticket_id, event_type FROM ticket_events WHERE event_type IN (\'related\', \'unrelated\') ORDER BY id').all())
      .toEqual([{ ticket_id: blocker.id, event_type: 'related' }, { ticket_id: blocked.id, event_type: 'related' }]);
    expectCode(() => relateTickets({ directory, actor, key: blocker.key, relation: 'relates_to', otherKey: blocked.key }), 'conflict');
    const seqs = [blocker, blocked].map((ticket) => directory.db.prepare('SELECT updated_seq FROM tickets WHERE id = ?').get(ticket.id).updated_seq);
    expect(seqs.every((seq: number) => seq > 1)).toBe(true);

    relateTickets({ directory, actor, key: blocked.key, relation: 'blocked_by', otherKey: blocker.key, remove: true, now: 30 });
    relateTickets({ directory, actor, key: blocker.key, relation: 'blocks', otherKey: blocked.key, remove: true, now: 40 });
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get().n).toBe(0);
    expect(directory.db.prepare("SELECT ticket_id, event_type FROM ticket_events WHERE event_type = 'unrelated' ORDER BY id").all())
      .toEqual([{ ticket_id: blocked.id, event_type: 'unrelated' }, { ticket_id: blocker.id, event_type: 'unrelated' }]);
  });

  it('normalizes symmetric and duplicate inverses, rejects self-links, and allows archived targets', () => {
    const { directory, actor } = fixture();
    const a = createTicket({ directory, actor, title: 'A' });
    const b = createTicket({ directory, actor, title: 'B' });
    const c = createTicket({ directory, actor, title: 'C' });
    relateTickets({ directory, actor, key: a.key, relation: 'relates_to', otherKey: b.key });
    relateTickets({ directory, actor, key: b.key, relation: 'relates_to', otherKey: a.key });
    expect(directory.db.prepare("SELECT COUNT(*) AS n FROM ticket_relations WHERE kind = 'relates_to'").get().n).toBe(1);
    expect(getTicket({ directory, actor, key: a.key }).relations).toContainEqual({ kind: 'relates_to', key: b.key });
    expect(getTicket({ directory, actor, key: b.key }).relations).toContainEqual({ kind: 'relates_to', key: a.key });
    relateTickets({ directory, actor, key: a.key, relation: 'duplicates', otherKey: c.key });
    relateTickets({ directory, actor, key: c.key, relation: 'duplicated_by', otherKey: a.key });
    expect(directory.db.prepare("SELECT COUNT(*) AS n FROM ticket_relations WHERE kind = 'duplicates'").get().n).toBe(1);
    expect(getTicket({ directory, actor, key: c.key }).relations).toContainEqual({ kind: 'duplicated_by', key: a.key });
    expectCode(() => relateTickets({ directory, actor, key: a.key, relation: 'relates_to', otherKey: a.key }), 'invalid_input');
    updateTicket({ directory, actor, key: c.key, patch: { archived: true } });
    expect(relateTickets({ directory, actor, key: b.key, relation: 'relates_to', otherKey: c.key }).ticket.relations)
      .toContainEqual({ kind: 'relates_to', key: c.key });
  });

  it('rejects blocks cycles of any length and conceals missing or inaccessible relation targets', () => {
    const { directory, actor } = fixture();
    const a = createTicket({ directory, actor, title: 'Cycle A' });
    const b = createTicket({ directory, actor, title: 'Cycle B' });
    const c = createTicket({ directory, actor, title: 'Cycle C' });
    relateTickets({ directory, actor, key: a.key, relation: 'blocks', otherKey: b.key });
    relateTickets({ directory, actor, key: b.key, relation: 'blocks', otherKey: c.key });
    expectCode(() => relateTickets({ directory, actor, key: c.key, relation: 'blocks', otherKey: a.key }), 'conflict');
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get().n).toBe(2);

    const guest = directory.createUser({ email: 'guest@example.com', role: 'guest' });
    const guestActor = { id: guest.id, role: guest.role };
    const hiddenError = expectCode(() => relateTickets({ directory, actor: guestActor, key: a.key, relation: 'relates_to', otherKey: b.key }), 'not_found');
    const missingError = expectCode(() => relateTickets({ directory, actor: guestActor, key: a.key, relation: 'relates_to', otherKey: 'TAB-99999' }), 'not_found');
    expect(hiddenError.message).toBe(missingError.message);
  });

  it('enforces the 100 relation limit per ticket while keeping duplicate additions idempotent', () => {
    const { directory, actor } = fixture();
    const center = createTicket({ directory, actor, title: 'Center' });
    const others = Array.from({ length: 101 }, (_, index) => createTicket({ directory, actor, title: `Peer ${index}` }));
    for (let index = 0; index < 100; index++) relateTickets({ directory, actor, key: center.key, relation: 'relates_to', otherKey: others[index].key });
    const eventCount = directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n;
    relateTickets({ directory, actor, key: center.key, relation: 'relates_to', otherKey: others[0].key });
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n).toBe(eventCount);
    expectCode(() => relateTickets({ directory, actor, key: center.key, relation: 'relates_to', otherKey: others[100].key }), 'limit_exceeded');
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_relations WHERE ticket_id = ? OR related_ticket_id = ?').get(center.id, center.id).n).toBe(100);
  });

  it('checks read-only before adding a relation or appending either event', () => {
    const { directory, actor } = fixture();
    const a = createTicket({ directory, actor, title: 'Read only A' });
    const b = createTicket({ directory, actor, title: 'Read only B' });
    const before = directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n;
    expectCode(() => relateTickets({ directory, actor, key: a.key, relation: 'relates_to', otherKey: b.key, readOnly: () => true }), 'read_only');
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get().n).toBe(0);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n).toBe(before);
  });
});
