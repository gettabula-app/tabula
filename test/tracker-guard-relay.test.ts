import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const h = createHarness({
  accounts: true,
  settings: { MCP: 'on', TRACKER: 'on' },
  env: { ROOM_UNLOAD_MS: '1200' },
  dir: path.join(ROOT, `.tracker-guard-s5-${process.pid}-${Date.now()}`),
});
let owner: Account;
let guest: Account;

type CardState = { parent: unknown; text: unknown };

function put(doc: Y.Doc, id: string, type: string, fields: Record<string, unknown> = {}) {
  doc.getMap('objects').set(id, new Y.Map(Object.entries({ id, type, ...fields })));
}

function card(doc: Y.Doc, id: string) {
  return doc.getMap('objects').get(id) as Y.Map<unknown> | undefined;
}

function state(doc: Y.Doc, id: string): CardState {
  const value = card(doc, id);
  return { parent: value?.get('parent'), text: value?.get('text') };
}

function savedState(boardId: string, cardId: string) {
  return savedStates(boardId, [cardId])[cardId];
}

function savedStates(boardId: string, cardIds: string[]) {
  const doc = h.savedDoc(boardId);
  try { return Object.fromEntries(cardIds.map((cardId) => [cardId, state(doc, cardId)])); }
  finally { doc.destroy(); }
}

function ticketEvents(ticketId: string) {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try {
    return db.prepare('SELECT event_type FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(ticketId)
      .map((row) => String(row.event_type));
  } finally { db.close(); }
}

function ticketEventCount(ticketIds: string[]) {
  if (!ticketIds.length) return 0;
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try {
    const slots = ticketIds.map(() => '?').join(', ');
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id IN (${slots})`).get(...ticketIds)!.n);
  } finally { db.close(); }
}

async function linkedBoard(cardCount = 1, shareGuest = false) {
  const boardId = await h.newBoard(owner.cookie);
  if (shareGuest) await h.share(owner.cookie, boardId, guest.user.id, 'editor');
  const doc = new Y.Doc();
  put(doc, 'relay-kanban', 'container', { layout: 'kanban' });
  put(doc, 'relay-todo', 'lane', { parent: 'relay-kanban', rank: 'a0@relay', stage: 'todo' });
  put(doc, 'relay-doing', 'lane', { parent: 'relay-kanban', rank: 'a1@relay', stage: 'doing' });
  const cardIds = Array.from({ length: cardCount }, (_, index) => `relay-card-${index}`);
  for (let index = 0; index < cardIds.length; index++) {
    put(doc, cardIds[index], 'card', {
      parent: 'relay-todo', rank: `a${index}@todo`, text: `Relay ticket ${index}`,
    });
  }
  fs.writeFileSync(h.roomFile(boardId), Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const response = await h.api(owner.cookie, 'POST', '/api/tracker/links', {
    boardId,
    kanbanId: 'relay-kanban',
    mapping: { 'relay-todo': 'todo', 'relay-doing': 'in_progress' },
    createTickets: true,
    idempotencyKey: `tracker-s5-link-${boardId}`,
  });
  if (response.status !== 201) throw new Error(`could not create relay test link (${response.status})`);
  return {
    boardId,
    linkId: response.body.link.id as string,
    cards: cardIds.map((cardId, index) => ({ cardId, ticket: response.body.created[index].ticket })),
  };
}

function watch(observer: ReturnType<typeof h.connect>, cardIds: string[]) {
  const changes: Record<string, CardState | null>[] = [];
  observer.doc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin !== observer.provider) return;
    const value: Record<string, CardState | null> = {};
    for (const id of cardIds) value[id] = card(observer.doc, id) ? state(observer.doc, id) : null;
    changes.push(value);
  });
  return changes;
}

async function assertFreshAndSaved(boardId: string, expected: Record<string, CardState>) {
  const fresh = h.connect(boardId, owner.cookie);
  await fresh.synced();
  await until(() => Object.entries(expected).every(([id, value]) => {
    const current = state(fresh.doc, id);
    return current.parent === value.parent && current.text === value.text;
  }));
  expect(Object.fromEntries(Object.keys(expected).map((id) => [id, state(fresh.doc, id)]))).toEqual(expected);
  await until(() => Object.entries(savedStates(boardId, Object.keys(expected))).every(([id, current]) => {
    const value = expected[id];
    return current.parent === value.parent && current.text === value.text;
  }));
  expect(savedStates(boardId, Object.keys(expected))).toEqual(expected);
  fresh.provider.destroy();
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const team = await h.newTeam(owner.cookie);
  guest = await h.joinTeam(owner.cookie, team.id);
  const changed = await h.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
  if (changed.status !== 200) throw new Error(`could not make relay test user a guest (${changed.status})`);
});

afterEach(() => h.closeProviders());

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('tracker linked-card relay guard', () => {
  it('lets an editor move a card and broadcasts only the final lane', async () => {
    const setup = await linkedBoard();
    const sender = h.connect(setup.boardId, owner.cookie);
    const observer = h.connect(setup.boardId, owner.cookie);
    await Promise.all([sender.synced(), observer.synced()]);
    const changes = watch(observer, [setup.cards[0].cardId]);
    const current = card(sender.doc, setup.cards[0].cardId)!;
    const moveBase = (current.get('tracker') as { projectionSeq: number }).projectionSeq;
    sender.doc.transact(() => {
      current.set('parent', 'relay-doing');
      current.set('moveBase', moveBase);
    }, 'editor-drag');

    await until(() => changes.some((entry) => entry[setup.cards[0].cardId]?.parent === 'relay-doing'));
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((entry) => entry[setup.cards[0].cardId]?.parent === 'relay-doing')).toBe(true);
    const ticket = await h.api(owner.cookie, 'GET', `/api/tracker/tickets/${setup.cards[0].ticket.key}`);
    expect(ticket.body.ticket.state.key).toBe('in_progress');
    await assertFreshAndSaved(setup.boardId, { [setup.cards[0].cardId]: { parent: 'relay-doing', text: 'Relay ticket 0' } });
  });

  it('processes a small history restore as ordinary changes when no restore window is open', async () => {
    const setup = await linkedBoard();
    const sender = h.connect(setup.boardId, owner.cookie);
    const observer = h.connect(setup.boardId, owner.cookie);
    await Promise.all([sender.synced(), observer.synced()]);
    const cardId = setup.cards[0].cardId;
    const changes = watch(observer, [cardId]);
    const current = card(sender.doc, cardId)!;
    const moveBase = (current.get('tracker') as { projectionSeq: number }).projectionSeq;
    sender.doc.transact(() => {
      current.set('parent', 'relay-doing');
      current.set('moveBase', moveBase);
      current.set('text', 'Restored title\nBody line');
    }, 'small-history-restore-without-window');

    await until(() => changes.some((entry) => entry[cardId]?.parent === 'relay-doing'
      && entry[cardId]?.text === 'Restored title\nBody line'));
    await until(async () => (await h.api(owner.cookie, 'GET', `/api/tracker/tickets/${setup.cards[0].ticket.key}`)).body.ticket.title === 'Restored title');
    const ticket = await h.api(owner.cookie, 'GET', `/api/tracker/tickets/${setup.cards[0].ticket.key}`);
    expect(ticket.body.ticket.state.key).toBe('in_progress');
    expect(ticket.body.ticket.title).toBe('Restored title');
    await assertFreshAndSaved(setup.boardId, { [cardId]: { parent: 'relay-doing', text: 'Restored title\nBody line' } });
  });

  it('never broadcasts a guest editor lane change and tells the sender forbidden', async () => {
    const setup = await linkedBoard(1, true);
    const observer = h.connect(setup.boardId, owner.cookie);
    const sender = h.connect(setup.boardId, guest.cookie);
    await Promise.all([observer.synced(), sender.synced()]);
    const cardId = setup.cards[0].cardId;
    const changes = watch(observer, [cardId]);
    const notices: { undone: { cardId: string; reason: string }[] }[] = [];
    (sender.provider as any).messageHandlers[7] = (_encoder: unknown, decoder: ReturnType<typeof decoding.createDecoder>) => {
      notices.push(JSON.parse(decoding.readVarString(decoder)));
    };
    // read the card afresh each time: a room reloaded from its file can replace the map the client first synced
    const current = () => card(sender.doc, cardId)!;
    sender.doc.transact(() => current().set('parent', 'relay-doing'), 'guest-drag');
    expect(current().get('parent')).toBe('relay-doing');

    await until(() => changes.length > 0 && current().get('parent') === 'relay-todo' && notices.some((notice) =>
      notice.undone.some((entry) => entry.cardId === cardId && entry.reason === 'forbidden')));
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((entry) => entry[cardId]?.parent === 'relay-doing')).toBe(false);
    expect(notices).toContainEqual({ undone: [{ cardId, reason: 'forbidden' }] });
    await assertFreshAndSaved(setup.boardId, { [cardId]: { parent: 'relay-todo', text: 'Relay ticket 0' } });
  });

  it('processes an offline move and title from one update in order', async () => {
    const setup = await linkedBoard();
    const sender = h.connect(setup.boardId, owner.cookie);
    const observer = h.connect(setup.boardId, owner.cookie);
    await Promise.all([sender.synced(), observer.synced()]);
    const cardId = setup.cards[0].cardId;
    const changes = watch(observer, [cardId]);
    await until(() => (card(sender.doc, cardId)?.get('tracker') as { projectionSeq?: number } | undefined)?.projectionSeq !== undefined);
    sender.provider.disconnect();
    await until(() => !sender.provider.wsconnected);
    const current = card(sender.doc, cardId)!;
    const moveBase = (current.get('tracker') as { projectionSeq: number }).projectionSeq;
    sender.doc.transact(() => {
      current.set('parent', 'relay-doing');
      current.set('moveBase', moveBase);
      current.set('text', 'Offline title\nBody line');
    }, 'offline-batch');
    expect(current.get('parent')).toBe('relay-doing');
    sender.provider.connect();

    await until(() => changes.some((entry) => entry[cardId]?.parent === 'relay-doing' && entry[cardId]?.text === 'Offline title\nBody line'));
    await until(async () => (await h.api(owner.cookie, 'GET', `/api/tracker/tickets/${setup.cards[0].ticket.key}`)).body.ticket.title === 'Offline title');
    const ticket = await h.api(owner.cookie, 'GET', `/api/tracker/tickets/${setup.cards[0].ticket.key}`);
    expect(ticket.body.ticket.state.key).toBe('in_progress');
    expect(ticket.body.ticket.title).toBe('Offline title');
    await assertFreshAndSaved(setup.boardId, { [cardId]: { parent: 'relay-doing', text: 'Offline title\nBody line' } });
  });

  it('converges on restart when SQL committed a move but the saved room has the prior lane', async () => {
    const setup = await linkedBoard();
    const observer = h.connect(setup.boardId, owner.cookie);
    await observer.synced();
    const cardId = setup.cards[0].cardId;
    const changes = watch(observer, [cardId]);
    const moved = await h.api(owner.cookie, 'POST', `/api/tracker/tickets/${setup.cards[0].ticket.key}/transition`, { state: 'in_progress' });
    expect(moved.status).toBe(200);
    await until(() => changes.some((entry) => entry[cardId]?.parent === 'relay-doing'));
    h.closeProviders();
    await h.stop();

    const stale = h.savedDoc(setup.boardId);
    card(stale, cardId)?.set('parent', 'relay-todo');
    fs.writeFileSync(h.roomFile(setup.boardId), Y.encodeStateAsUpdate(stale));
    stale.destroy();

    await h.start();
    const fresh = h.connect(setup.boardId, owner.cookie);
    await fresh.synced();
    await until(() => state(fresh.doc, cardId).parent === 'relay-doing');
    expect(state(fresh.doc, cardId).parent).toBe('relay-doing');
    await until(() => savedState(setup.boardId, cardId).parent === 'relay-doing');
    expect(savedState(setup.boardId, cardId).parent).toBe('relay-doing');
    const ticket = await h.api(owner.cookie, 'GET', `/api/tracker/tickets/${setup.cards[0].ticket.key}`);
    expect(ticket.body.ticket.state.key).toBe('in_progress');
    fresh.provider.destroy();
  });

  it('keeps ticket state and title during the opener’s restore window', async () => {
    const setup = await linkedBoard();
    const sender = h.connect(setup.boardId, owner.cookie);
    const observer = h.connect(setup.boardId, owner.cookie);
    await Promise.all([sender.synced(), observer.synced()]);
    const cardId = setup.cards[0].cardId;
    const current = card(sender.doc, cardId)!;
    sender.doc.transact(() => current.set('text', 'Relay ticket 0\nBody line'), 'seed-body');
    await until(() => state(observer.doc, cardId).text === 'Relay ticket 0\nBody line');
    const changes = watch(observer, [cardId]);
    const opened = await h.api(owner.cookie, 'POST', `/api/tracker/boards/${setup.boardId}/restore-window`);
    expect(opened).toMatchObject({ status: 200, body: { expiresAt: expect.any(Number) } });
    const beforeEvents = ticketEvents(setup.cards[0].ticket.id).length;
    sender.doc.transact(() => {
      current.set('parent', 'relay-doing');
      current.set('text', 'Restored title\nRestored body');
      current.set('desc', 'Non-tracker restore data');
    }, 'history-restore');
    expect(current.get('parent')).toBe('relay-doing');

    await until(() => changes.length > 0 && state(observer.doc, cardId).parent === 'relay-todo'
      && state(observer.doc, cardId).text === 'Relay ticket 0\nRestored body');
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((entry) => entry[cardId]?.parent === 'relay-doing')).toBe(false);
    const ticket = await h.api(owner.cookie, 'GET', `/api/tracker/tickets/${setup.cards[0].ticket.key}`);
    expect(ticket.body.ticket.state.key).toBe('todo');
    expect(ticket.body.ticket.title).toBe('Relay ticket 0');
    expect(ticketEvents(setup.cards[0].ticket.id)).toHaveLength(beforeEvents);
    expect(await h.api(owner.cookie, 'DELETE', `/api/tracker/boards/${setup.boardId}/restore-window`))
      .toMatchObject({ status: 200, body: { closed: true, projectionPending: false } });
    await assertFreshAndSaved(setup.boardId, { [cardId]: { parent: 'relay-todo', text: 'Relay ticket 0\nRestored body' } });
  });

  it('refuses a restore touching more than 100 linked cards without a window', async () => {
    const setup = await linkedBoard(101);
    const cardIds = setup.cards.map((entry) => entry.cardId);
    const sender = h.connect(setup.boardId, owner.cookie);
    const observer = h.connect(setup.boardId, owner.cookie);
    await Promise.all([sender.synced(), observer.synced()]);
    const changes = watch(observer, cardIds);
    const notices: { undone: { cardId: string; reason: string }[] }[] = [];
    (sender.provider as any).messageHandlers[7] = (_encoder: unknown, decoder: ReturnType<typeof decoding.createDecoder>) => {
      notices.push(JSON.parse(decoding.readVarString(decoder)));
    };
    const ticketIds = setup.cards.map((entry) => entry.ticket.id as string);
    const beforeEvents = ticketEventCount(ticketIds);
    sender.doc.transact(() => {
      for (const id of cardIds) card(sender.doc, id)?.set('parent', 'relay-doing');
    }, 'unannounced-restore');
    expect(cardIds.every((id) => card(sender.doc, id)?.get('parent') === 'relay-doing')).toBe(true);

    await until(() => changes.length > 0 && notices.some((notice) => notice.undone.length === 101
      && notice.undone.every((entry) => entry.reason === 'bulk_change'))
      && cardIds.every((id) => card(sender.doc, id)?.get('parent') === 'relay-todo'));
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((entry) => cardIds.some((id) => entry[id]?.parent === 'relay-doing'))).toBe(false);
    const bulkNotice = notices.find((notice) => notice.undone.length === 101 && notice.undone.every((entry) => entry.reason === 'bulk_change'));
    expect(bulkNotice?.undone.map((entry) => entry.cardId).sort()).toEqual([...cardIds].sort());
    expect(ticketEventCount(ticketIds)).toBe(beforeEvents);
    await assertFreshAndSaved(setup.boardId, Object.fromEntries(cardIds.map((id) => [id, { parent: 'relay-todo', text: `Relay ticket ${cardIds.indexOf(id)}` }])));
  });

  it('closes a socket before applying an update beyond the pre-snapshot budget', async () => {
    const setup = await linkedBoard();
    const sender = h.connect(setup.boardId, owner.cookie);
    await sender.synced();
    const cardId = setup.cards[0].cardId;
    const notices: { undone?: unknown[]; reason?: string }[] = [];
    (sender.provider as any).messageHandlers[7] = (_encoder: unknown, decoder: ReturnType<typeof decoding.createDecoder>) => {
      notices.push(JSON.parse(decoding.readVarString(decoder)));
    };
    const socket = (sender.provider as any).ws;
    let closed: { code: number; reason: string } | null = null;
    socket.once('close', (code: number, reason: Buffer) => {
      closed = { code, reason: reason.toString() };
      sender.provider.destroy();
    });
    const current = () => card(sender.doc, cardId)!;
    for (let index = 0; index <= 1200; index++) {
      sender.doc.transact(() => current().set('desc', `socket-budget-${index}`), 'socket-budget-burst');
    }
    expect(current().get('desc')).toBe('socket-budget-1200');

    await until(() => closed !== null && notices.some((notice) => notice.reason === 'rate_limited'));
    expect(closed).toEqual({ code: 1008, reason: 'rate_limited' });
    // a notice entry without a card id: the client shows the toast and undoes nothing locally
    expect(notices).toContainEqual({ undone: [{ reason: 'rate_limited' }], reason: 'rate_limited' });

    // the budget belongs to the person and the board, not the socket: a reconnect inside the minute is cut again
    const again = h.connect(setup.boardId, owner.cookie);
    let againClosed: number | null = null;
    again.provider.on('connection-close', (event: { code?: number } | null) => { if (event && againClosed === null) againClosed = event.code ?? -1; });
    again.doc.transact(() => card(again.doc, cardId)?.set('desc', 'after-reconnect'), 'again');
    await until(() => againClosed === 1008);
    again.provider.destroy();

    let accepted: unknown;
    await until(() => {
      const saved = h.savedDoc(setup.boardId);
      try { accepted = card(saved, cardId)?.get('desc'); return typeof accepted === 'string' && accepted.startsWith('socket-budget-'); }
      finally { saved.destroy(); }
    });
    expect(accepted).not.toBe('socket-budget-1200');
    expect(accepted).not.toBe('after-reconnect');
  });
});
