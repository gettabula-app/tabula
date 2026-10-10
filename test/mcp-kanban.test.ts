import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { KANBAN, rankBetween, sortedChildren, splitRank } from '../shared/containers.mjs';
import { createHarness, until, type Account, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on' }, env: { ROOM_UNLOAD_MS: '1200' } });
const kanbanId = 'kanban-main';
const todoId = 'lane-todo';
const doingId = 'lane-doing';
const secondDoingId = 'lane-doing-second';
const cardId = 'card-visible';
const lockedId = 'card-locked';
const hiddenId = 'card-hidden';
const privateId = 'card-private';
const privateNoteId = 'private-note';
const labelId = 'label-bug';

let owner: Account;
let viewer: Account;
let board: string;

// An account may hold 20 active tokens: the tokens a test made are revoked after it, so a long file never hits the limit.
const madeTokens: string[] = [];
const addToken = async (name: string) => {
  const made = await h.newToken(owner.cookie, { name, scope: 'write' });
  madeTokens.push(made.id);
  return made;
};
afterEach(async () => {
  for (const id of madeTokens.splice(0)) await h.api(owner.cookie, 'DELETE', `/api/me/tokens/${id}`);
});

async function watcher() {
  const client = h.connect(board, owner.cookie);
  await client.synced();
  return client;
}

beforeAll(async () => {
  await h.start();
  const workspaceOwner = await h.signInOwner();
  const team = await h.newTeam(workspaceOwner.cookie);
  owner = await h.joinTeam(workspaceOwner.cookie, team.id);
  viewer = await h.joinTeam(workspaceOwner.cookie, team.id);
  board = await h.newBoard(owner.cookie);
  await h.share(owner.cookie, board, viewer.user.id, 'viewer');

  const editor = h.connect(board, owner.cookie);
  await editor.synced();
  const container = { id: kanbanId, type: 'container', layout: 'kanban', name: 'Roadmap', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a0' };
  const todo = { id: todoId, type: 'lane', parent: kanbanId, rank: rankBetween(null, null, kanbanId), name: 'To do', stage: 'todo', x: 0, y: 0, w: 280, h: 300, rotation: 0, z: 'a0' };
  const doing = { id: doingId, type: 'lane', parent: kanbanId, rank: rankBetween(todo.rank, null, kanbanId), name: 'Doing', stage: 'doing', x: 300, y: 0, w: 280, h: 300, rotation: 0, z: 'a0' };
  const doingSecond = { id: secondDoingId, type: 'lane', parent: kanbanId, rank: rankBetween(doing.rank, null, kanbanId), name: 'Doing later', stage: 'doing', x: 600, y: 0, w: 280, h: 300, rotation: 0, z: 'a0' };
  const card = (id: string, parent: string, rank: string, text: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'card', parent, rank, text, x: 0, y: 0, w: 264, h: 72, rotation: 0, z: 'a0', ...extra,
  });
  editor.doc.transact(() => {
    const objects = editor.doc.getMap('objects');
    for (const obj of [container, todo, doing, doingSecond]) objects.set(obj.id, new Y.Map(Object.entries(obj)));
    objects.set(cardId, new Y.Map(Object.entries(card(cardId, todoId, rankBetween(null, null, todoId), 'Visible card', {
      desc: 'A description', due: '2026-11-01', labels: [labelId], link: 'https://example.com/task', ownerId: 'person-1', ownerName: 'Priya', ownerKind: 'person',
    }))));
    objects.set(lockedId, new Y.Map(Object.entries(card(lockedId, todoId, rankBetween(rankBetween(null, null, todoId), null, todoId), 'Locked card', { locked: true }))));
    objects.set(hiddenId, new Y.Map(Object.entries(card(hiddenId, todoId, rankBetween(rankBetween(rankBetween(null, null, todoId), null, todoId), null, todoId), 'Hidden card', { hidden: true }))));
    objects.set(privateId, new Y.Map(Object.entries(card(privateId, todoId, rankBetween(rankBetween(rankBetween(rankBetween(null, null, todoId), null, todoId), null, todoId), null, todoId), 'Private card', { privateStep: 'step-1' }))));
    objects.set(privateNoteId, new Y.Map(Object.entries({ id: privateNoteId, type: 'sticky', text: 'Private note', privateStep: 'step-1', createdBy: 'another-person', x: 0, y: 0, w: 192, h: 192 })));
    editor.doc.getMap('labels').set(labelId, { id: labelId, name: 'Bug', color: 'red', order: 0 });
  }, 'local');
  await until(() => h.savedDoc(board).getMap('objects').has(privateId));
  editor.provider.destroy();
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('kanban MCP card tools', () => {
  it('lists a kanban in lane order with card fields and omits hidden and private cards', async () => {
    const token = await addToken('list cards');
    const result = await h.tool(token.token, 'list_kanban_cards', { boardId: board, kanbanId });
    expect(result.error).toBeUndefined();
    expect(result.data.cards.map((c: Body) => c.id)).toEqual([cardId, lockedId]);
    expect(result.data.cards[0]).toMatchObject({
      title: 'Visible card', description: 'A description',
      lane: { id: todoId, name: 'To do' }, stage: 'todo', ownerName: 'Priya', ownerKind: 'person',
      due: '2026-11-01', labels: [labelId], link: 'https://example.com/task',
    });
    expect(result.data.cards[0]).not.toHaveProperty('ownerId');
    expect(result.data.labels).toEqual([{ id: labelId, name: 'Bug' }]);
    expect(result.text).not.toContain('Private card');
    expect(result.text).not.toContain('Hidden card');
  });

  it('adds a card to the first lane with the requested stage and binds an agent owner to its token id', async () => {
    const token = await addToken('kanban  agent');
    const live = await watcher();
    try {
      const result = await h.tool(token.token, 'add_kanban_card', {
        boardId: board, kanbanId, stage: 'doing', title: 'Ship release', description: 'Prepare the release',
        due: '2026-12-31', labels: [labelId], link: 'https://example.com/release', ownerKind: 'agent',
      });
      expect(result.error).toBeUndefined();
      expect(result.data.card).toMatchObject({
        title: 'Ship release', description: 'Prepare the release', lane: { id: doingId }, stage: 'doing',
        ownerId: token.id, ownerName: 'kanban agent', ownerKind: 'agent', due: '2026-12-31', labels: [labelId], link: 'https://example.com/release',
      });
      const id = result.data.card.id as string;
      await until(() => live.doc.getMap('objects').get(id) instanceof Y.Map);
      expect((live.doc.getMap('objects').get(id) as Y.Map<unknown>).get('h')).toBe(KANBAN.cardH);
    } finally {
      live.provider.destroy();
    }
  });

  it('uses the shared card height when a link change triggers re-layout', async () => {
    const token = await addToken('link layout');
    const live = await watcher();
    const card = live.doc.getMap('objects').get(cardId) as Y.Map<unknown>;
    const oldLink = card.get('link');
    const oldHeight = card.get('h');
    try {
      card.set('h', KANBAN.cardH + 31);
      await until(() => (h.savedDoc(board).getMap('objects').get(cardId) as Y.Map<unknown>)?.get('h') === KANBAN.cardH + 31);
      const result = await h.tool(token.token, 'update_kanban_card', {
        boardId: board, kanbanId, cardId, link: 'https://example.com/new-link-layout',
      });
      expect(result.error).toBeUndefined();
      await until(() => card.get('h') === KANBAN.cardH);
    } finally {
      if (typeof oldLink === 'string') card.set('link', oldLink); else card.delete('link');
      card.set('h', oldHeight);
      await until(() => {
        const saved = h.savedDoc(board).getMap('objects').get(cardId) as Y.Map<unknown> | undefined;
        return saved?.get('link') === oldLink && saved?.get('h') === oldHeight;
      });
      live.provider.destroy();
    }
  });

  it('updates a card title, date, labels, link and person owner', async () => {
    const token = await addToken('update card');
    const live = await watcher();
    try {
      const result = await h.tool(token.token, 'update_kanban_card', {
        boardId: board, kanbanId, cardId, title: 'Revised title', description: 'Revised description', due: '2026-12-01',
        labels: [], link: 'http://example.com/revised', ownerName: 'Morgan', ownerKind: 'person',
      });
      expect(result.error).toBeUndefined();
      expect(result.data.card).toMatchObject({
        id: cardId, title: 'Revised title', description: 'Revised description', due: '2026-12-01', labels: [],
        link: 'http://example.com/revised', ownerName: 'Morgan', ownerKind: 'person',
      });
      expect(result.data.card).not.toHaveProperty('ownerId');
      expect((live.doc.getMap('objects').get(cardId) as Y.Map<unknown>).get('ownerId')).toBeUndefined();
      await until(() => (live.doc.getMap('objects').get(cardId) as Y.Map<unknown>)?.get('text') === 'Revised title');
    } finally {
      live.provider.destroy();
    }
  });

  it('recomputes the shared default card height when only the link changes', async () => {
    const token = await addToken('link relayout');
    const live = await watcher();
    const card = live.doc.getMap('objects').get(cardId) as Y.Map<unknown>;
    try {
      card.set('h', 319);
      await until(() => (h.savedDoc(board).getMap('objects').get(cardId) as Y.Map<unknown>)?.get('h') === 319);
      const result = await h.tool(token.token, 'update_kanban_card', {
        boardId: board, kanbanId, cardId, link: 'https://example.com/layout-change',
      });
      expect(result.error).toBeUndefined();
      await until(() => card.get('h') === KANBAN.cardH);
      expect(card.get('h')).toBe(KANBAN.cardH);
    } finally {
      live.provider.destroy();
    }
  });

  it('refuses person owner ids and never reassigns an agent owner to the caller', async () => {
    const first = await addToken('first agent');
    const second = await addToken('second agent');
    const assigned = await h.tool(first.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, ownerKind: 'agent' });
    expect(assigned.error).toBeUndefined();
    expect(assigned.data.card).toMatchObject({ ownerId: first.id, ownerName: 'first agent', ownerKind: 'agent' });

    const takeover = await h.tool(second.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, ownerKind: 'agent' });
    expect(takeover.error).toBe('conflict');
    const stillFirstAfterTakeover = await h.tool(second.token, 'list_kanban_cards', { boardId: board, kanbanId });
    expect(stillFirstAfterTakeover.data.cards.find((card: Body) => card.id === cardId)).toMatchObject({ ownerId: first.id, ownerKind: 'agent' });

    const nameOnly = await h.tool(second.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, ownerName: 'second agent' });
    expect(nameOnly.error).toBe('conflict');
    const stillFirst = await h.tool(second.token, 'list_kanban_cards', { boardId: board, kanbanId });
    expect(stillFirst.data.cards.find((card: Body) => card.id === cardId)).toMatchObject({ ownerId: first.id, ownerKind: 'agent' });

    for (const clear of [{ ownerId: null }, { ownerName: null }]) {
      const refused = await h.tool(second.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, ...clear });
      expect(refused.error).toBe('conflict');
      const unchanged = await h.tool(first.token, 'list_kanban_cards', { boardId: board, kanbanId });
      expect(unchanged.data.cards.find((card: Body) => card.id === cardId)).toMatchObject({ ownerId: first.id, ownerKind: 'agent' });

      const cleared = await h.tool(first.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, ...clear });
      expect(cleared.error).toBeUndefined();
      expect(cleared.data.card).not.toHaveProperty('ownerId');
      expect(cleared.data.card).not.toHaveProperty('ownerName');
      expect(cleared.data.card).not.toHaveProperty('ownerKind');
      await h.tool(first.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, ownerKind: 'agent' });
    }

    await h.tool(first.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, ownerName: null });
    const person = await h.tool(second.token, 'update_kanban_card', {
      boardId: board, kanbanId, cardId, ownerKind: 'person', ownerName: 'Morgan',
    });
    expect(person.error).toBeUndefined();
    expect(person.data.card).toMatchObject({ ownerName: 'Morgan', ownerKind: 'person' });
    expect(person.data.card).not.toHaveProperty('ownerId');
    const impersonation = await h.tool(second.token, 'update_kanban_card', {
      boardId: board, kanbanId, cardId, ownerId: 'person-2', ownerName: 'Morgan', ownerKind: 'person',
    });
    expect(impersonation.error).toBe('invalid_input');
    expect(impersonation.data.path).toBe('ownerId');
  });

  it('omits a stored link that fails the shared reader validator', async () => {
    const token = await addToken('invalid stored link');
    const live = await watcher();
    const card = live.doc.getMap('objects').get(cardId) as Y.Map<unknown>;
    const original = card.get('link');
    try {
      card.set('link', 'https://u:p@evil.example/');
      await until(() => (h.savedDoc(board).getMap('objects').get(cardId) as Y.Map<unknown>)?.get('link') === 'https://u:p@evil.example/');
      const listed = await h.tool(token.token, 'list_kanban_cards', { boardId: board, kanbanId });
      const out = listed.data.cards.find((item: Body) => item.id === cardId);
      expect(out).not.toHaveProperty('link');
      expect(listed.text).not.toContain('u:p@evil.example');
    } finally {
      if (typeof original === 'string') card.set('link', original); else card.delete('link');
      await until(() => (h.savedDoc(board).getMap('objects').get(cardId) as Y.Map<unknown>)?.get('link') === original);
      live.provider.destroy();
    }
  });

  it('moves a card to the first lane with the requested stage and never creates a lane', async () => {
    const token = await addToken('move card');
    const live = await watcher();
    try {
      const laneCount = [...live.doc.getMap('objects').values()].filter((o) => o instanceof Y.Map && o.get('type') === 'lane').length;
      const result = await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId, stage: 'doing' });
      expect(result.error).toBeUndefined();
      expect(result.data.card).toMatchObject({ lane: { id: doingId }, stage: 'doing' });
      await until(() => (live.doc.getMap('objects').get(cardId) as Y.Map<unknown>)?.get('parent') === doingId);
      expect([...live.doc.getMap('objects').values()].filter((o) => o instanceof Y.Map && o.get('type') === 'lane')).toHaveLength(laneCount);
    } finally {
      live.provider.destroy();
    }
  });

  it('does not write when a move requests the card’s current stage', async () => {
    const token = await addToken('same stage');
    const live = await watcher();
    try {
      const before = Y.encodeStateVector(live.doc);
      const result = await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId, stage: 'doing' });
      expect(result.error).toBeUndefined();
      expect(result.data.moved).toBe(false);
      expect(Y.encodeStateVector(live.doc)).toEqual(before);
    } finally {
      live.provider.destroy();
    }
  });

  it('moves to the first matching lane when another lane has the same stage', async () => {
    const token = await addToken('repeated stage');
    const live = await watcher();
    let card: string | undefined;
    try {
      const added = await h.tool(token.token, 'add_kanban_card', {
        boardId: board, kanbanId, laneId: secondDoingId, title: 'Move to first Doing lane',
      });
      expect(added.error).toBeUndefined();
      card = added.data.card.id as string;
      const moved = await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId: card, stage: 'doing' });
      expect(moved.error).toBeUndefined();
      expect(moved.data).toMatchObject({ moved: true, card: { lane: { id: doingId } } });
      await until(() => (live.doc.getMap('objects').get(card!) as Y.Map<unknown>)?.get('parent') === doingId);
    } finally {
      if (card) {
        live.doc.getMap('objects').delete(card);
        await until(() => !h.savedDoc(board).getMap('objects').has(card!));
      }
      live.provider.destroy();
    }
  });

  it('flattens title newlines and normalizes owner whitespace before applying code-point limits', async () => {
    const token = await addToken('normalized fields');
    const result = await h.tool(token.token, 'add_kanban_card', {
      boardId: board, kanbanId, laneId: todoId, title: '  First\n\t second  ', ownerName: '  Ada\n  Lovelace  ',
    });
    expect(result.error).toBeUndefined();
    expect(result.data.card.title).toBe('First second');
    expect(result.data.card.ownerName).toBe('Ada Lovelace');
    const collapsedOwner = `${'A'.repeat(39)}${' '.repeat(100)}${'B'.repeat(40)}`;
    const ownerAtLimit = await h.tool(token.token, 'add_kanban_card', {
      boardId: board, kanbanId, laneId: todoId, title: 'Owner normalized', ownerName: collapsedOwner,
    });
    expect(ownerAtLimit.error).toBeUndefined();
    expect(ownerAtLimit.data.card.ownerName).toBe(`${'A'.repeat(39)} ${'B'.repeat(40)}`);
    for (const title of ['x'.repeat(201), '😀'.repeat(201)]) {
      const refused = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title });
      expect(refused.error).toBe('invalid_input');
      expect(refused.data.path).toBe('title');
    }
    const refusedOwner = await h.tool(token.token, 'add_kanban_card', {
      boardId: board, kanbanId, laneId: todoId, title: 'Owner too long', ownerName: '😀'.repeat(81),
    });
    expect(refusedOwner.error).toBe('invalid_input');
    expect(refusedOwner.data.path).toBe('ownerName');
  });

  it('counts hidden and unrevealed private cards for WIP and appends after every card rank', async () => {
    const token = await addToken('all lane cards');
    const live = await watcher();
    const objects = live.doc.getMap('objects');
    const lane = objects.get(todoId) as Y.Map<unknown>;
    const hidden = objects.get(hiddenId) as Y.Map<unknown>;
    const privateCard = objects.get(privateId) as Y.Map<unknown>;
    const original = {
      hiddenRank: hidden.get('rank'), privateRank: privateCard.get('rank'), wip: lane.get('wip'), wipMode: lane.get('wipMode'),
    };
    let addedId: string | undefined;
    try {
      const cards = [...objects.values()].filter((value) => value instanceof Y.Map && value.get('type') === 'card' && value.get('parent') === todoId) as Y.Map<unknown>[];
      const visibleCount = cards.filter((card) => card.get('hidden') !== true && !card.get('privateStep')).length;
      expect(cards.some((card) => card.get('hidden') === true)).toBe(true);
      expect(cards.some((card) => !!card.get('privateStep'))).toBe(true);
      const currentLast = sortedChildren(cards.map((card) => card.toJSON() as { id: string; rank?: string; parent?: string } )).at(-1)!;
      const hiddenRank = rankBetween(currentLast.rank ?? null, null, todoId);
      const privateRank = rankBetween(hiddenRank, null, todoId);
      hidden.set('rank', hiddenRank);
      privateCard.set('rank', privateRank);
      lane.set('wip', visibleCount + 1);
      lane.set('wipMode', 'block');
      await until(() => (h.savedDoc(board).getMap('objects').get(todoId) as Y.Map<unknown>)?.get('wip') === visibleCount + 1);

      const blocked = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Blocked by hidden cards' });
      expect(blocked.error).toBe('wip_limit');

      lane.delete('wip');
      lane.delete('wipMode');
      await until(() => !(h.savedDoc(board).getMap('objects').get(todoId) as Y.Map<unknown>)?.has('wip'));
      const added = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Rank after hidden' });
      expect(added.error).toBeUndefined();
      addedId = added.data.card.id as string;
      await until(() => objects.get(addedId!) instanceof Y.Map);
      const made = objects.get(addedId) as Y.Map<unknown>;
      expect(splitRank(made.get('rank') as string)?.parent).toBe(todoId);
      const finalCards = sortedChildren([...objects.values()]
        .filter((value) => value instanceof Y.Map && value.get('type') === 'card' && value.get('parent') === todoId)
        .map((value) => (value as Y.Map<unknown>).toJSON() as { id: string; rank?: string; parent?: string }));
      expect(finalCards.at(-1)?.id).toBe(addedId);
    } finally {
      if (addedId) objects.delete(addedId);
      hidden.set('rank', original.hiddenRank);
      privateCard.set('rank', original.privateRank);
      if (original.wip === undefined) lane.delete('wip'); else lane.set('wip', original.wip);
      if (original.wipMode === undefined) lane.delete('wipMode'); else lane.set('wipMode', original.wipMode);
      await until(() => {
        const saved = h.savedDoc(board).getMap('objects');
        const savedHidden = saved.get(hiddenId) as Y.Map<unknown> | undefined;
        const savedPrivate = saved.get(privateId) as Y.Map<unknown> | undefined;
        const savedLane = saved.get(todoId) as Y.Map<unknown> | undefined;
        return (!addedId || !saved.has(addedId)) && savedHidden?.get('rank') === original.hiddenRank && savedPrivate?.get('rank') === original.privateRank &&
          savedLane?.get('wip') === original.wip && savedLane?.get('wipMode') === original.wipMode;
      });
      live.provider.destroy();
    }
  });

  it('returns not_found for unknown kanbans and cards', async () => {
    const token = await addToken('unknown kanban');
    for (const [name, args] of [
      ['list_kanban_cards', { boardId: board, kanbanId: 'missing-kanban' }],
      ['add_kanban_card', { boardId: board, kanbanId: 'missing-kanban', laneId: todoId, title: 'X' }],
      ['update_kanban_card', { boardId: board, kanbanId: 'missing-kanban', cardId, title: 'X' }],
      ['move_kanban_card', { boardId: board, kanbanId: 'missing-kanban', cardId, laneId: todoId }],
      ['update_kanban_card', { boardId: board, kanbanId, cardId: 'missing-card', title: 'X' }],
      ['move_kanban_card', { boardId: board, kanbanId, cardId: 'missing-card', laneId: todoId }],
    ] as const) {
      expect((await h.tool(token.token, name, args)).error).toBe('not_found');
    }
  });

  it('reports a clear error when no lane has the requested stage', async () => {
    const token = await addToken('missing stage');
    const add = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, stage: 'done', title: 'No lane' });
    expect(add.error).toBe('not_found');
    expect(add.data.message).toContain("No lane in this kanban has stage 'done'");
    const move = await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId, stage: 'done' });
    expect(move.error).toBe('not_found');
    expect(move.data.message).toContain("No lane in this kanban has stage 'done'");
  });

  it('rejects dates outside the shared real-date range', async () => {
    const token = await addToken('date range');
    for (const due of ['1899-12-31', '2201-01-01', '2026-02-30']) {
      const result = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Bad date', due });
      expect(result.error).toBe('invalid_input');
      expect(result.data.path).toBe('due');
    }
    const enumValue = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Bad kind', ownerKind: 'robot' });
    expect(enumValue.error).toBe('invalid_input');
    expect(enumValue.data.path).toBe('ownerKind');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hello'],
    ['credentials', 'https://u:p@h.com'],
    ['deceptive userinfo', 'https://trusted.com@evil.com/'],
    ['too long', `https://example.com/${'x'.repeat(2000)}`],
  ])('rejects a %s link on both add and update', async (_label, link) => {
    const token = await addToken('bad link');
    const added = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Bad link', link });
    expect(added.error).toBe('invalid_input');
    expect(added.data.path).toBe('link');
    const updated = await h.tool(token.token, 'update_kanban_card', { boardId: board, kanbanId, cardId, link });
    expect(updated.error).toBe('invalid_input');
    expect(updated.data.path).toBe('link');
  });

  it('refuses add, update and move for a viewer even when the token scope is write', async () => {
    const token = await h.newToken(viewer.cookie, { name: 'viewer kanban', scope: 'write', boardIds: [board] });
    for (const [name, args] of [
      ['add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Denied' }],
      ['update_kanban_card', { boardId: board, kanbanId, cardId, title: 'Denied' }],
      ['move_kanban_card', { boardId: board, kanbanId, cardId, laneId: doingId }],
    ] as const) expect((await h.tool(token.token, name, args)).error).toBe('forbidden');
  });

  it('refuses updates and moves of a locked card', async () => {
    const token = await addToken('locked kanban');
    expect((await h.tool(token.token, 'update_kanban_card', { boardId: board, kanbanId, cardId: lockedId, title: 'Changed' })).error).toBe('conflict');
    expect((await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId: lockedId, laneId: doingId })).error).toBe('conflict');
  });

  it('never returns or changes hidden or unrevealed private cards', async () => {
    const token = await addToken('private kanban');
    const live = await watcher();
    try {
      const before = (id: string) => JSON.stringify((live.doc.getMap('objects').get(id) as Y.Map<unknown>).toJSON());
      const hiddenBefore = before(hiddenId);
      const privateBefore = before(privateId);
      const privateNoteBefore = before(privateNoteId);
      const listed = await h.tool(token.token, 'list_kanban_cards', { boardId: board, kanbanId });
      expect(listed.text).not.toContain('Hidden card');
      expect(listed.text).not.toContain('Private card');
      expect(listed.text).not.toContain('Private note');
      for (const id of [hiddenId, privateId]) {
        expect((await h.tool(token.token, 'update_kanban_card', { boardId: board, kanbanId, cardId: id, title: 'Exposed' })).error).toBe('not_found');
        expect((await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId: id, laneId: doingId })).error).toBe('not_found');
      }
      expect((await h.tool(token.token, 'update_kanban_card', { boardId: board, kanbanId, cardId: privateNoteId, title: 'Exposed' })).error).toBe('not_found');
      expect((await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId: privateNoteId, laneId: doingId })).error).toBe('not_found');
      expect(before(hiddenId)).toBe(hiddenBefore);
      expect(before(privateId)).toBe(privateBefore);
      expect(before(privateNoteId)).toBe(privateNoteBefore);
    } finally {
      live.provider.destroy();
    }
  });

  it('keeps kanban-only types out of generic create and update tools', async () => {
    const token = await addToken('generic object refusals');
    const listed = await h.call(token.token, 'tools/list');
    const createTool = listed.body.result.tools.find((tool: Body) => tool.name === 'create_objects');
    expect(createTool.inputSchema.properties.objects.items.properties.type.enum).toEqual(['sticky', 'shape', 'text', 'frame', 'connector']);

    const before = (await h.tool(token.token, 'get_board', { boardId: board })).data.counts.total;
    for (const type of ['container', 'lane', 'card', 'group', 'image']) {
      const refused = await h.tool(token.token, 'create_objects', { boardId: board, objects: [{ type, x: 0, y: 0 }] });
      expect(refused.error).toBe('invalid_input');
      expect(refused.data.path).toBe('objects[0].type');
    }

    const cardUpdate = await h.tool(token.token, 'update_objects', { boardId: board, updates: [{ id: cardId, x: 12, parent: doingId }] });
    expect(cardUpdate.error).toBe('invalid_input');
    expect(cardUpdate.data.path).toBe('updates[0].id');
    expect(cardUpdate.data.message).toContain('update_kanban_card');
    const laneUpdate = await h.tool(token.token, 'update_objects', { boardId: board, updates: [{ id: todoId, x: 12 }] });
    expect(laneUpdate.error).toBe('invalid_input');
    expect(laneUpdate.data.message).toContain('board UI');
    const kanbanUpdate = await h.tool(token.token, 'update_objects', { boardId: board, updates: [{ id: kanbanId, w: 900 }] });
    expect(kanbanUpdate.error).toBe('invalid_input');
    expect(kanbanUpdate.data.message).toContain('board UI');
    expect((await h.tool(token.token, 'get_board', { boardId: board })).data.counts.total).toBe(before);
  });

  it('returns the same not_found for hidden generic update targets as for a missing id', async () => {
    const token = await addToken('hidden generic updates');
    const live = await watcher();
    const hiddenLaneId = 'mcp-hidden-lane';
    const cardInHiddenLaneId = 'mcp-card-in-hidden-lane';
    const hiddenKanbanId = 'mcp-hidden-kanban';
    try {
      live.doc.transact(() => {
        const objects = live.doc.getMap('objects');
        objects.set(hiddenLaneId, new Y.Map(Object.entries({
          id: hiddenLaneId, type: 'lane', parent: kanbanId, rank: rankBetween(null, null, hiddenLaneId), name: 'Hidden lane', hidden: true,
          x: 0, y: 0, w: 280, h: 300, rotation: 0, z: 'zz0',
        })));
        objects.set(cardInHiddenLaneId, new Y.Map(Object.entries({
          id: cardInHiddenLaneId, type: 'card', parent: hiddenLaneId, rank: rankBetween(null, null, cardInHiddenLaneId), text: 'Hidden lane card',
          x: 0, y: 0, w: 264, h: 72, rotation: 0, z: 'zz1',
        })));
        objects.set(hiddenKanbanId, new Y.Map(Object.entries({
          id: hiddenKanbanId, type: 'container', layout: 'kanban', name: 'Hidden kanban', hidden: true,
          x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'zz2',
        })));
      }, 'local');
      await until(() => h.savedDoc(board).getMap('objects').has(cardInHiddenLaneId));

      const missing = await h.tool(token.token, 'update_objects', { boardId: board, updates: [{ id: 'mcp-no-such-object', x: 12 }] });
      expect(missing.error).toBe('not_found');
      expect(missing.data).toEqual({ error: 'not_found', message: 'No such object', path: 'updates[0].id' });
      for (const id of [hiddenId, privateId, hiddenLaneId, cardInHiddenLaneId, hiddenKanbanId]) {
        const result = await h.tool(token.token, 'update_objects', { boardId: board, updates: [{ id, x: 12 }] });
        expect(result.error).toBe('not_found');
        expect(result.data).toEqual(missing.data);
      }
    } finally {
      live.provider.destroy();
    }
  });

  it('refuses lane and kanban deletes and protects locked, hidden, private and other-agent cards', async () => {
    const token = await addToken('generic delete refusals');
    expect((await h.tool(token.token, 'delete_objects', { boardId: board, ids: [todoId] })).error).toBe('conflict');
    expect((await h.tool(token.token, 'delete_objects', { boardId: board, ids: [kanbanId] })).error).toBe('conflict');
    expect((await h.tool(token.token, 'delete_objects', { boardId: board, ids: [lockedId] })).error).toBe('conflict');
    for (const id of [hiddenId, privateId, privateNoteId]) {
      expect((await h.tool(token.token, 'delete_objects', { boardId: board, ids: [id] })).error).toBe('not_found');
    }

    const other = await addToken('second card agent');
    const added = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Agent-owned card', ownerKind: 'agent' });
    expect(added.error).toBeUndefined();
    const agentCardId = added.data.card.id as string;
    const denied = await h.tool(other.token, 'delete_objects', { boardId: board, ids: [agentCardId] });
    expect(denied.error).toBe('conflict');
    expect(denied.data.message).toBe('The card is assigned to another agent');
    expect((await h.tool(token.token, 'delete_objects', { boardId: board, ids: [agentCardId] })).error).toBeUndefined();

    const personCard = await h.tool(other.token, 'add_kanban_card', {
      boardId: board, kanbanId, laneId: todoId, title: 'Person-owned card', ownerKind: 'person', ownerName: 'Priya',
    });
    expect(personCard.error).toBeUndefined();
    expect((await h.tool(token.token, 'delete_objects', { boardId: board, ids: [personCard.data.card.id] })).error).toBeUndefined();
  });

  it('deletes group members but keeps an unrevealed private note outside the group', async () => {
    const token = await addToken('delete group');
    const live = await watcher();
    const groupId = 'mcp-delete-group';
    const nestedId = 'mcp-delete-nested';
    const memberId = 'mcp-delete-member';
    const secretId = 'mcp-delete-secret';
    try {
      live.doc.transact(() => {
        const objects = live.doc.getMap('objects');
        objects.set(groupId, new Y.Map(Object.entries({ id: groupId, type: 'group', name: 'Group', z: 'zz0' })));
        objects.set(nestedId, new Y.Map(Object.entries({ id: nestedId, type: 'group', name: 'Nested', parent: groupId, z: 'zz1' })));
        objects.set(memberId, new Y.Map(Object.entries({ id: memberId, type: 'shape', kind: 'rect', text: 'Member', x: 0, y: 0, w: 100, h: 100, rotation: 0, parent: nestedId, z: 'zz2' })));
        objects.set(secretId, new Y.Map(Object.entries({ id: secretId, type: 'sticky', text: 'PRIVATE GROUP NOTE', x: 0, y: 0, w: 100, h: 100, parent: nestedId, privateStep: 'step-1', z: 'zz3' })));
      }, 'local');
      await until(() => h.savedDoc(board).getMap('objects').has(secretId));

      const removed = await h.tool(token.token, 'delete_objects', { boardId: board, ids: [groupId] });
      expect(removed.error).toBeUndefined();
      expect(removed.data.deleted.sort()).toEqual([groupId, memberId, nestedId].sort());
      expect(removed.text).not.toContain('PRIVATE GROUP NOTE');
      expect(removed.text).not.toContain(secretId);
      await until(() => {
        const objects = h.savedDoc(board).getMap('objects');
        return !objects.has(groupId) && objects.has(secretId) && (objects.get(secretId) as Y.Map<unknown>).get('parent') === undefined;
      });
    } finally {
      live.provider.destroy();
    }
  });
});
