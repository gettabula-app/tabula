import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { rankBetween } from '../shared/containers.mjs';
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

const addToken = (name: string) => h.newToken(owner.cookie, { name, scope: 'write' });

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
      lane: { id: todoId, name: 'To do' }, stage: 'todo', ownerId: 'person-1', ownerName: 'Priya', ownerKind: 'person',
      due: '2026-11-01', labels: [labelId], link: 'https://example.com/task',
    });
    expect(result.text).not.toContain('Private card');
    expect(result.text).not.toContain('Hidden card');
  });

  it('adds a card to the first lane with the requested stage and binds an agent owner to its token id', async () => {
    const token = await addToken('kanban agent');
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
      await until(() => [...live.doc.getMap('objects').values()].some((o) => o instanceof Y.Map && o.get('text') === 'Ship release'));
    } finally {
      live.provider.destroy();
    }
  });

  it('updates a card title, date, labels, link and person owner', async () => {
    const token = await addToken('update card');
    const live = await watcher();
    try {
      const result = await h.tool(token.token, 'update_kanban_card', {
        boardId: board, kanbanId, cardId, title: 'Revised title', description: 'Revised description', due: '2026-12-01',
        labels: [], link: 'http://example.com/revised', ownerId: 'person-2', ownerName: 'Morgan', ownerKind: 'person',
      });
      expect(result.error).toBeUndefined();
      expect(result.data.card).toMatchObject({
        id: cardId, title: 'Revised title', description: 'Revised description', due: '2026-12-01', labels: [],
        link: 'http://example.com/revised', ownerId: 'person-2', ownerName: 'Morgan', ownerKind: 'person',
      });
      await until(() => (live.doc.getMap('objects').get(cardId) as Y.Map<unknown>)?.get('text') === 'Revised title');
    } finally {
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

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hello'],
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
});
