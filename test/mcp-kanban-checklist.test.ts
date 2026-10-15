import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { rankBetween } from '../shared/containers.mjs';
import { createHarness, until, type Account } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// TAB-372: a card checklist through the existing card tools (one optional `checklist` param, whole-list replace, no new tool).
const h = createHarness({ accounts: true, settings: { MCP: 'on' } });
const kanbanId = 'kanban-main';
const laneId = 'lane-todo';
const linkedId = 'card-linked';
let owner: Account;
let board: string;
let token = '';

beforeAll(async () => {
  await h.start();
  const workspaceOwner = await h.signInOwner();
  const team = await h.newTeam(workspaceOwner.cookie);
  owner = await h.joinTeam(workspaceOwner.cookie, team.id);
  board = await h.newBoard(owner.cookie);
  const editor = h.connect(board, owner.cookie);
  await editor.synced();
  editor.doc.transact(() => {
    const objects = editor.doc.getMap('objects');
    const set = (obj: Record<string, unknown>) => objects.set(obj.id as string, new Y.Map(Object.entries(obj)));
    set({ id: kanbanId, type: 'container', layout: 'kanban', name: 'Roadmap', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a0' });
    set({ id: laneId, type: 'lane', parent: kanbanId, rank: rankBetween(null, null, kanbanId), name: 'To do', stage: 'todo', x: 0, y: 0, w: 280, h: 300, rotation: 0, z: 'a0' });
    set({ id: linkedId, type: 'card', parent: laneId, rank: rankBetween(null, null, laneId), text: 'Linked', x: 0, y: 0, w: 264, h: 72, rotation: 0, z: 'a0',
      extProvider: 'tabula', trackerId: 'tracker-1', extKey: 'TAB-1' });
  }, 'local');
  await until(() => h.savedDoc(board).getMap('objects').has(linkedId));
  editor.provider.destroy();
  token = (await h.newToken(owner.cookie, { name: 'checklist', scope: 'write' })).token;
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

const add = (extra: Record<string, unknown>) => h.tool(token, 'add_kanban_card', { boardId: board, kanbanId, stage: 'todo', title: 'Card', ...extra });

describe('kanban card checklist over MCP', () => {
  it('adds a card with items, mints missing ids, and reads them back', async () => {
    const made = await add({ checklist: [{ text: 'First' }, { id: 'keep-1', text: '  Second\n item ', done: true }] });
    expect(made.error).toBeUndefined();
    const items = made.data.card.checklist;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ text: 'First', done: false });
    expect(typeof items[0].id).toBe('string');
    expect(items[1]).toEqual({ id: 'keep-1', text: 'Second item', done: true });
    const listed = await h.tool(token, 'list_kanban_cards', { boardId: board, kanbanId });
    expect(listed.data.cards.find((c: { id: string }) => c.id === made.data.card.id).checklist).toEqual(items);
  });

  it('ticks one item by sending the list back, and clears with null or []', async () => {
    const made = await add({ checklist: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] });
    const cardId = made.data.card.id;
    const ticked = await h.tool(token, 'update_kanban_card', { boardId: board, kanbanId, cardId, checklist: [{ id: 'a', text: 'A', done: true }, { id: 'b', text: 'B' }] });
    expect(ticked.error).toBeUndefined();
    expect(ticked.data.card.checklist.map((i: { done: boolean }) => i.done)).toEqual([true, false]);
    for (const clear of [null, []]) {
      await h.tool(token, 'update_kanban_card', { boardId: board, kanbanId, cardId, checklist: [{ id: 'a', text: 'A' }] });
      const cleared = await h.tool(token, 'update_kanban_card', { boardId: board, kanbanId, cardId, checklist: clear });
      expect(cleared.error).toBeUndefined();
      expect(cleared.data.card).not.toHaveProperty('checklist');
    }
  });

  it('refuses bad lists: too many, empty text, long text, duplicate ids, unknown keys, a non-boolean done', async () => {
    const bad: unknown[] = [
      Array.from({ length: 51 }, (_, i) => ({ text: `n${i}` })),
      [{ text: '   ' }], [{ text: 'x'.repeat(201) }], [{ id: 'd', text: 'a' }, { id: 'd', text: 'b' }],
      [{ text: 'a', extra: 1 }], [{ text: 'a', done: 'yes' }], [{ id: 'bad id!', text: 'a' }], 'text',
    ];
    for (const checklist of bad) expect({ checklist: JSON.stringify(checklist).slice(0, 40), error: (await add({ checklist })).error }).toMatchObject({ error: 'invalid_input' });
    expect((await add({ checklist: Array.from({ length: 50 }, (_, i) => ({ text: `n${i}` })) })).error).toBeUndefined();
  });

  it('adds checklists in a batch and refuses the whole batch when one list is bad', async () => {
    const ok = await h.tool(token, 'add_kanban_cards', { boardId: board, kanbanId, cards: [{ stage: 'todo', title: 'B1', checklist: [{ text: 'x' }] }, { stage: 'todo', title: 'B2' }] });
    expect(ok.error).toBeUndefined();
    expect(ok.data.cards[0].checklist).toHaveLength(1);
    const refused = await h.tool(token, 'add_kanban_cards', { boardId: board, kanbanId, cards: [{ stage: 'todo', title: 'B3' }, { stage: 'todo', title: 'B4', checklist: [{ text: '' }] }] });
    expect(refused.error).toBe('invalid_input');
    const titles = (await h.tool(token, 'list_kanban_cards', { boardId: board, kanbanId })).data.cards.map((c: { title: string }) => c.title);
    expect(titles).not.toContain('B3');
  });

  it('does not let an AI change the checklist of a ticket-linked card', async () => {
    const refused = await h.tool(token, 'update_kanban_card', { boardId: board, kanbanId, cardId: linkedId, checklist: [{ text: 'x' }] });
    expect(refused.error).toBe('invalid_input');
  });
});
