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
    expect(result.data.lanes).toEqual([
      { id: todoId, name: 'To do', stage: 'todo', count: 2 },
      { id: doingId, name: 'Doing', stage: 'doing', count: 0 },
      { id: secondDoingId, name: 'Doing later', stage: 'doing', count: 0 },
    ]);
    expect(result.text).not.toContain('Private card');
    expect(result.text).not.toContain('Hidden card');
  });

  it('creates, updates and deletes labels, scrubbing the deleted id from cards', async () => {
    const token = await addToken('kanban labels');
    const emojiName = '😀'.repeat(40);
    const emojiLabel = await h.tool(token.token, 'create_kanban_label', { boardId: board, kanbanId, name: emojiName });
    expect(emojiLabel.error).toBeUndefined();
    expect(emojiLabel.data.label.name).toBe(emojiName);
    expect((await h.tool(token.token, 'create_kanban_label', { boardId: board, kanbanId, name: '😀'.repeat(41) })).error).toBe('invalid_input');
    await h.tool(token.token, 'delete_kanban_label', { boardId: board, kanbanId, labelId: emojiLabel.data.label.id });

    const created = await h.tool(token.token, 'create_kanban_label', { boardId: board, kanbanId, name: '  MCP Bug  ', color: 'pink' });
    expect(created.error).toBeUndefined();
    expect(created.data.label).toMatchObject({ name: 'MCP Bug', color: 'pink' });
    const label = created.data.label.id as string;
    expect(created.data.labels).toContainEqual({ id: label, name: 'MCP Bug' });

    expect((await h.tool(token.token, 'create_kanban_label', { boardId: board, kanbanId, name: 'mcp bug' })).error).toBe('invalid_input');
    expect((await h.tool(token.token, 'create_kanban_label', { boardId: board, kanbanId, name: 'Bad color', color: 'url(javascript:alert(1))' })).error).toBe('invalid_input');
    const updated = await h.tool(token.token, 'update_kanban_label', { boardId: board, kanbanId, labelId: label, name: 'MCP Defect', color: '#abc' });
    expect(updated.error).toBeUndefined();
    expect(updated.data.label).toMatchObject({ id: label, name: 'MCP Defect', color: '#AABBCC' });
    expect((await h.tool(token.token, 'update_kanban_label', { boardId: board, kanbanId, labelId: label, name: 'bug' })).error).toBe('invalid_input');

    const card = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: doingId, title: 'Label scrub target', labels: [label] });
    expect(card.error).toBeUndefined();
    const cardId = card.data.card.id as string;
    const deleted = await h.tool(token.token, 'delete_kanban_label', { boardId: board, kanbanId, labelId: label });
    expect(deleted.error).toBeUndefined();
    expect(deleted.data.cardsTouched).toBe(1);
    const listed = await h.tool(token.token, 'list_kanban_cards', { boardId: board, kanbanId });
    expect(listed.data.cards.find((item: Body) => item.id === cardId).labels).toEqual([]);
    expect(deleted.data.labels).not.toContainEqual({ id: label, name: 'MCP Defect' });
    await h.tool(token.token, 'delete_objects', { boardId: board, ids: [cardId] });
  });

  it('adds and reorders lanes, then moves other-token agent cards when deleting a lane', async () => {
    const laneWriter = await addToken('lane writer');
    const cardAgent = await addToken('lane card agent');
    const targetResult = await h.tool(laneWriter.token, 'add_kanban_lane', {
      boardId: board, kanbanId, name: 'MCP target', stage: 'doing', afterLaneId: doingId,
    });
    expect(targetResult.error).toBeUndefined();
    const targetLane = targetResult.data.lane.id as string;
    const sourceResult = await h.tool(laneWriter.token, 'add_kanban_lane', {
      boardId: board, kanbanId, name: 'MCP source', afterLaneId: targetLane, wip: 3, wipBlock: true,
    });
    expect(sourceResult.error).toBeUndefined();
    const sourceLane = sourceResult.data.lane.id as string;

    const reordered = await h.tool(laneWriter.token, 'update_kanban_lane', { boardId: board, kanbanId, laneId: sourceLane, afterLaneId: doingId });
    expect(reordered.error).toBeUndefined();
    expect(reordered.data.lanes.findIndex((lane: Body) => lane.id === sourceLane)).toBe(reordered.data.lanes.findIndex((lane: Body) => lane.id === doingId) + 1);
    const targetCard = await h.tool(laneWriter.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: targetLane, title: 'Keeps the lane full' });
    const targetCardId = targetCard.data.card.id as string;
    await h.tool(laneWriter.token, 'update_kanban_lane', { boardId: board, kanbanId, laneId: targetLane, wip: 1, wipBlock: true });
    const agentCard = await h.tool(cardAgent.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: sourceLane, title: 'Owned elsewhere', ownerKind: 'agent' });
    const agentCardId = agentCard.data.card.id as string;
    const sourceCard = await h.tool(laneWriter.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: sourceLane, title: 'Moves with the agent card' });
    const sourceCardId = sourceCard.data.card.id as string;

    const blocked = await h.tool(laneWriter.token, 'delete_kanban_lane', { boardId: board, kanbanId, laneId: sourceLane, moveCardsTo: targetLane });
    expect(blocked.error).toBe('wip_limit');
    expect(blocked.data.message).toBe('This lane is at its WIP limit (1/1).');
    const overLimit = await h.tool(laneWriter.token, 'update_kanban_lane', { boardId: board, kanbanId, laneId: sourceLane, wip: 1 });
    expect(overLimit.error).toBeUndefined();
    expect(overLimit.data.warnings).toContain('The WIP limit is below this lane’s current card count.');

    await h.tool(laneWriter.token, 'update_kanban_lane', { boardId: board, kanbanId, laneId: targetLane, wip: 3 });
    const deleted = await h.tool(laneWriter.token, 'delete_kanban_lane', { boardId: board, kanbanId, laneId: sourceLane, moveCardsTo: targetLane });
    expect(deleted.error).toBeUndefined();
    expect(deleted.data).toMatchObject({ movedCards: 2, movedCardsTo: targetLane });
    const listed = await h.tool(laneWriter.token, 'list_kanban_cards', { boardId: board, kanbanId });
    expect(listed.data.cards.find((item: Body) => item.id === agentCardId)).toMatchObject({ lane: { id: targetLane }, ownerId: cardAgent.id, ownerKind: 'agent' });
    expect(listed.data.cards.find((item: Body) => item.id === sourceCardId)).toMatchObject({ lane: { id: targetLane } });
    expect(listed.data.lanes.find((lane: Body) => lane.id === sourceLane)).toBeUndefined();

    await h.tool(laneWriter.token, 'update_kanban_lane', { boardId: board, kanbanId, laneId: targetLane, wip: null });
    await h.tool(laneWriter.token, 'delete_objects', { boardId: board, ids: [targetCardId, sourceCardId] });
    await h.tool(cardAgent.token, 'delete_objects', { boardId: board, ids: [agentCardId] });
    await h.tool(laneWriter.token, 'delete_kanban_lane', { boardId: board, kanbanId, laneId: targetLane });
  });

  it('forbids label and lane writes to read tokens and viewer-held write tokens', async () => {
    const readToken = await h.newToken(owner.cookie, { name: 'read kanban tools', scope: 'read' });
    madeTokens.push(readToken.id);
    const names = (await h.call(readToken.token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name);
    expect(names).not.toContain('create_kanban_label');
    expect((await h.tool(readToken.token, 'create_kanban_label', { boardId: board, kanbanId, name: 'No access' })).error).toBe('forbidden');

    const viewerToken = await h.newToken(viewer.cookie, { name: 'viewer lane tools', scope: 'write' });
    madeTokens.push(viewerToken.id);
    expect((await h.tool(viewerToken.token, 'add_kanban_lane', { boardId: board, kanbanId, name: 'No access' })).error).toBe('forbidden');
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

  it('leaves the stored card height to editor clients when a link changes', async () => {
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
      await until(() => card.get('link') === 'https://example.com/new-link-layout');
      // the server no longer guesses a height on update: an editor client measures the content and repairs it
      expect(card.get('h')).toBe(KANBAN.cardH + 31);
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

  it('does not write a card height when only the link changes', async () => {
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
      await until(() => card.get('link') === 'https://example.com/layout-change');
      expect(card.get('h')).toBe(319);
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
      expect(blocked.data.message).toBe(`This lane is at its WIP limit (${cards.length}/${visibleCount + 1}).`);

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

  it('reports the pre-move card count for a blocked card move', async () => {
    const token = await addToken('pre-move WIP count');
    const live = await watcher();
    const target = live.doc.getMap('objects').get(doingId) as Y.Map<unknown>;
    const original = { wip: target.get('wip'), wipMode: target.get('wipMode') };
    let fillerId: string | undefined;
    let sourceId: string | undefined;
    try {
      const filler = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: doingId, title: 'Target already has one card' });
      expect(filler.error).toBeUndefined();
      fillerId = filler.data.card.id as string;
      const source = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: todoId, title: 'Blocked move source' });
      expect(source.error).toBeUndefined();
      sourceId = source.data.card.id as string;
      // the lane already holds the fixture's cards: the message must show the count before the move, whatever it is
      const listed = await h.tool(token.token, 'list_kanban_cards', { boardId: board, kanbanId });
      const before = (listed.data.lanes as { id: string; count: number }[]).find((lane) => lane.id === doingId)!.count;
      expect(before).toBeGreaterThanOrEqual(1);
      target.set('wip', 1);
      target.set('wipMode', 'block');
      await until(() => (h.savedDoc(board).getMap('objects').get(doingId) as Y.Map<unknown>)?.get('wipMode') === 'block');

      const moved = await h.tool(token.token, 'move_kanban_card', { boardId: board, kanbanId, cardId: sourceId, laneId: doingId });
      expect(moved.error).toBe('wip_limit');
      expect(moved.data.message).toBe(`This lane is at its WIP limit (${before}/1).`);
      const added = await h.tool(token.token, 'add_kanban_card', { boardId: board, kanbanId, laneId: doingId, title: 'Blocked add' });
      expect(added.error).toBe('wip_limit');
      expect(added.data.message).toBe(`This lane is at its WIP limit (${before}/1).`);
    } finally {
      const cleanup = [fillerId, sourceId].filter((id): id is string => !!id);
      if (cleanup.length) await h.tool(token.token, 'delete_objects', { boardId: board, ids: cleanup });
      if (original.wip === undefined) target.delete('wip'); else target.set('wip', original.wip);
      if (original.wipMode === undefined) target.delete('wipMode'); else target.set('wipMode', original.wipMode);
      await until(() => {
        const saved = h.savedDoc(board).getMap('objects').get(doingId) as Y.Map<unknown>;
        return saved?.get('wip') === original.wip && saved?.get('wipMode') === original.wipMode;
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
    expect(laneUpdate.data.message).toContain('update_kanban_lane');
    const kanbanUpdate = await h.tool(token.token, 'update_objects', { boardId: board, updates: [{ id: kanbanId, w: 900 }] });
    expect(kanbanUpdate.error).toBe('invalid_input');
    expect(kanbanUpdate.data.message).toContain('board UI');
    expect((await h.tool(token.token, 'get_board', { boardId: board })).data.counts.total).toBe(before);
  });

  it('refuses new or changed connector ends on lanes and kanbans while preserving existing ends', async () => {
    const token = await addToken('connector end rules');
    const live = await watcher();
    const cleanupIds = new Set<string>();
    const encoded = () => Buffer.from(Y.encodeStateAsUpdate(live.doc)).toString('base64');
    const rememberCreated = (result: Body) => {
      for (const item of result.data?.created ?? []) cleanupIds.add(item.id);
    };
    try {
      const cardConnector = await h.tool(token.token, 'create_objects', {
        boardId: board, objects: [{ type: 'connector', from: { id: cardId }, to: { x: 20, y: 30 } }],
      });
      rememberCreated(cardConnector);
      expect(cardConnector.error).toBeUndefined();
      const cardConnectorId = cardConnector.data.created[0].id as string;
      await until(() => live.doc.getMap('objects').has(cardConnectorId));
      expect((live.doc.getMap('objects').get(cardConnectorId) as Y.Map<unknown>).get('from')).toEqual({
        kind: 'bound', id: cardId, anchor: 'auto',
      });

      for (const [end, targetId] of [
        ['from', todoId], ['to', todoId], ['from', kanbanId], ['to', kanbanId],
      ] as const) {
        const before = encoded();
        const connector: Record<string, unknown> = { type: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
        connector[end] = { id: targetId };
        const refused = await h.tool(token.token, 'create_objects', { boardId: board, objects: [connector] });
        rememberCreated(refused);
        expect(refused.error).toBe('invalid_input');
        expect(refused.data).toMatchObject({
          message: 'Connect to a card, not to a lane or the kanban', path: `objects[0].${end}`,
        });
        expect(encoded()).toBe(before);
      }

      for (const [end, targetId] of [
        ['from', todoId], ['to', todoId], ['from', kanbanId], ['to', kanbanId],
      ] as const) {
        const before = encoded();
        const patch: Record<string, unknown> = { id: cardConnectorId };
        patch[end] = { id: targetId };
        const refused = await h.tool(token.token, 'update_objects', { boardId: board, updates: [patch] });
        expect(refused.error).toBe('invalid_input');
        expect(refused.data).toMatchObject({
          message: 'Connect to a card, not to a lane or the kanban', path: `updates[0].${end}`,
        });
        expect(encoded()).toBe(before);
      }

      const legacyId = h.unique('legacy-kanban-connector');
      cleanupIds.add(legacyId);
      live.doc.transact(() => {
        live.doc.getMap('objects').set(legacyId, new Y.Map(Object.entries({
          id: legacyId, type: 'connector', z: 'zz-legacy', label: 'Before edit', route: 'elbow',
          startHead: 'none', endHead: 'arrow', createdBy: 'local',
          from: { kind: 'bound', id: kanbanId, anchor: 'auto' },
          to: { kind: 'bound', id: cardId, anchor: 'auto' },
        })));
      }, 'local');
      await until(() => h.savedDoc(board).getMap('objects').has(legacyId));

      const labelEdit = await h.tool(token.token, 'update_objects', {
        boardId: board, updates: [{ id: legacyId, label: 'After edit' }],
      });
      expect(labelEdit.error).toBeUndefined();
      await until(() => (live.doc.getMap('objects').get(legacyId) as Y.Map<unknown>)?.get('label') === 'After edit');
      const sameEnd = await h.tool(token.token, 'update_objects', {
        boardId: board, updates: [{ id: legacyId, from: { id: kanbanId } }],
      });
      expect(sameEnd.error).toBeUndefined();

      const beforeBatch = encoded();
      const batch = await h.tool(token.token, 'create_objects', {
        boardId: board,
        objects: [
          { type: 'connector', from: { id: cardId }, to: { x: 2, y: 3 } },
          { type: 'connector', from: { x: 4, y: 5 }, to: { id: todoId } },
        ],
      });
      rememberCreated(batch);
      expect(batch.error).toBe('invalid_input');
      expect(batch.data).toMatchObject({
        message: 'Connect to a card, not to a lane or the kanban', path: 'objects[1].to',
      });
      expect(encoded()).toBe(beforeBatch);
    } finally {
      if (cleanupIds.size) await h.tool(token.token, 'delete_objects', { boardId: board, ids: [...cleanupIds] });
      live.provider.destroy();
    }
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

  it('returns not_found for a lane after it is hidden from the token', async () => {
    const token = await addToken('hide kanban lane');
    const added = await h.tool(token.token, 'add_kanban_lane', { boardId: board, kanbanId, name: 'Hidden MCP lane' });
    expect(added.error).toBeUndefined();
    const laneId = added.data.lane.id as string;
    const hidden = await h.tool(token.token, 'update_kanban_lane', { boardId: board, kanbanId, laneId, hidden: true });
    expect(hidden.error).toBeUndefined();
    expect(hidden.data.lanes.find((lane: Body) => lane.id === laneId)).toBeUndefined();
    expect((await h.tool(token.token, 'update_kanban_lane', { boardId: board, kanbanId, laneId, name: 'Not visible' })).error).toBe('not_found');
    expect((await h.tool(token.token, 'delete_kanban_lane', { boardId: board, kanbanId, laneId })).error).toBe('not_found');
  });

  it('keeps a visible lane when hiding lanes even when the kanban already has a hidden lane', async () => {
    const token = await addToken('last visible lane');
    const live = await watcher();
    const containerId = 'mcp-last-visible-kanban';
    const existingHiddenId = 'mcp-last-visible-hidden';
    const hideableId = 'mcp-last-visible-hideable';
    const lastVisibleId = 'mcp-last-visible-remains';
    const fixtureIds = [containerId, existingHiddenId, hideableId, lastVisibleId];
    const container = { id: containerId, type: 'container', layout: 'kanban', name: 'Visibility check', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'zz0' };
    const existingHidden = { id: existingHiddenId, type: 'lane', parent: containerId, rank: rankBetween(null, null, containerId), name: 'Already hidden', hidden: true, x: 0, y: 0, w: 280, h: 300, rotation: 0, z: 'zz1' };
    const hideable = { id: hideableId, type: 'lane', parent: containerId, rank: rankBetween(existingHidden.rank, null, containerId), name: 'Can hide', x: 0, y: 0, w: 280, h: 300, rotation: 0, z: 'zz2' };
    const lastVisible = { id: lastVisibleId, type: 'lane', parent: containerId, rank: rankBetween(hideable.rank, null, containerId), name: 'Must remain', x: 0, y: 0, w: 280, h: 300, rotation: 0, z: 'zz3' };
    try {
      live.doc.transact(() => {
        const objects = live.doc.getMap('objects');
        for (const object of [container, existingHidden, hideable, lastVisible]) objects.set(object.id, new Y.Map(Object.entries(object)));
      }, 'local');
      await until(() => fixtureIds.every((id) => h.savedDoc(board).getMap('objects').has(id)));

      const hidden = await h.tool(token.token, 'update_kanban_lane', { boardId: board, kanbanId: containerId, laneId: hideableId, hidden: true });
      expect(hidden.error).toBeUndefined();
      expect(hidden.data.lanes.map((lane: Body) => lane.id)).toEqual([lastVisibleId]);
      expect((await h.tool(token.token, 'update_kanban_lane', { boardId: board, kanbanId: containerId, laneId: hideableId, hidden: false })).error).toBe('not_found');

      const refused = await h.tool(token.token, 'update_kanban_lane', { boardId: board, kanbanId: containerId, laneId: lastVisibleId, hidden: true });
      expect(refused.error).toBe('conflict');
      expect(refused.data).toMatchObject({ message: 'A kanban needs at least one visible lane', path: 'laneId' });
      const saved = h.savedDoc(board).getMap('objects');
      expect((saved.get(lastVisibleId) as Y.Map<unknown>).get('hidden')).toBeUndefined();
      expect(saved.has(existingHiddenId)).toBe(true);
    } finally {
      live.doc.transact(() => fixtureIds.forEach((id) => live.doc.getMap('objects').delete(id)), 'test:cleanup');
      await until(() => fixtureIds.every((id) => !h.savedDoc(board).getMap('objects').has(id)));
      live.provider.destroy();
    }
  });

  it('counts only visible cards when deleting a lane and still moves hidden and private cards', async () => {
    const token = await addToken('visible moved card count');
    const source = await h.tool(token.token, 'add_kanban_lane', { boardId: board, kanbanId, name: 'Count visibility source' });
    expect(source.error).toBeUndefined();
    const sourceLaneId = source.data.lane.id as string;
    const live = await watcher();
    const visibleCardId = 'mcp-moved-visible-card';
    const hiddenCardId = 'mcp-moved-hidden-card';
    const privateCardId = 'mcp-moved-private-card';
    const cardIds = [visibleCardId, hiddenCardId, privateCardId];
    try {
      await until(() => live.doc.getMap('objects').has(sourceLaneId));
      live.doc.transact(() => {
        const objects = live.doc.getMap('objects');
        let previous: string | null = null;
        for (const [id, extra] of [
          [visibleCardId, {}],
          [hiddenCardId, { hidden: true }],
          [privateCardId, { privateStep: 'step-1' }],
        ] as [string, Record<string, unknown>][]) {
          const rank = rankBetween(previous, null, sourceLaneId);
          previous = rank;
          objects.set(id, new Y.Map(Object.entries({
            id, type: 'card', parent: sourceLaneId, rank, text: id, x: 0, y: 0, w: 264, h: 72, rotation: 0, z: 'zz0', ...extra,
          })));
        }
      }, 'local');
      await until(() => cardIds.every((id) => h.savedDoc(board).getMap('objects').has(id)));

      const deleted = await h.tool(token.token, 'delete_kanban_lane', { boardId: board, kanbanId, laneId: sourceLaneId, moveCardsTo: doingId });
      expect(deleted.error).toBeUndefined();
      expect(deleted.data).toMatchObject({ movedCards: 1, movedCardsTo: doingId });
      await until(() => cardIds.every((id) => (h.savedDoc(board).getMap('objects').get(id) as Y.Map<unknown>)?.get('parent') === doingId));
      const listed = await h.tool(token.token, 'list_kanban_cards', { boardId: board, kanbanId });
      expect(listed.data.cards.find((card: Body) => card.id === visibleCardId)?.lane.id).toBe(doingId);
      expect(listed.data.cards.map((card: Body) => card.id)).not.toContain(hiddenCardId);
      expect(listed.data.cards.map((card: Body) => card.id)).not.toContain(privateCardId);
    } finally {
      live.doc.transact(() => {
        const objects = live.doc.getMap('objects');
        for (const id of [...cardIds, sourceLaneId]) objects.delete(id);
      }, 'test:cleanup');
      await until(() => [...cardIds, sourceLaneId].every((id) => !h.savedDoc(board).getMap('objects').has(id)));
      live.provider.destroy();
    }
  });
});
