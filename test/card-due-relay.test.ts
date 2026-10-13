import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';
import { budget } from './wait-budget';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// Card reminders over real sockets (docs/notifications.md, TAB-164): an editor's write names an assignee, and the assignee's
// notification list shows the assignment; a due-soon or overdue card is recorded by the sweep, which runs on a short test interval.

const h = createHarness({ accounts: true });
let owner: Account;
let ana: Account;
let ben: Account;

const put = (doc: Y.Doc, id: string, fields: Record<string, unknown>) => {
  doc.getMap('objects').set(id, new Y.Map(Object.entries({ id, ...fields })));
};
const todayUtc = () => new Date().toISOString().slice(0, 10);
const dayBefore = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function list(account: Account) {
  const res = await h.api(account.cookie, 'GET', '/api/notifications?limit=50');
  if (res.status !== 200) throw new Error(`notifications failed (${res.status})`);
  return res.body as { items: Array<{ kind: string; snippet: string | null; actor: { id: string } | null; target: string; board: { id: string } | null }>; unread: number };
}

beforeAll(async () => {
  await h.start({ TABULA_TEST_CARD_DUE_SWEEP_MS: '150' });
  owner = await h.signInOwner();
  const team = await h.newTeam(owner.cookie);
  ana = await h.joinTeam(owner.cookie, team.id);
  ben = await h.joinTeam(owner.cookie, team.id);
});

afterEach(() => h.closeProviders());

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('card reminders over the relay', () => {
  it('tells the assignee when an editor assigns them a card, with the first line of the card', async () => {
    const boardId = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, boardId, ben.user.id, 'editor');
    await h.share(owner.cookie, boardId, ana.user.id, 'viewer');
    const before = await list(ana);

    const benSocket = h.connect(boardId, ben.cookie);
    await benSocket.synced();
    benSocket.doc.transact(() => {
      put(benSocket.doc, 'kanban', { type: 'container', layout: 'kanban' });
      put(benSocket.doc, 'doing', { type: 'lane', parent: 'kanban', rank: 'a0@kanban', stage: 'doing' });
      put(benSocket.doc, 'card-1', { type: 'card', parent: 'doing', rank: 'a0@doing', text: 'Pay the invoice\nsecond line' });
    });
    benSocket.doc.transact(() => {
      const card = benSocket.doc.getMap<Y.Map<unknown>>('objects').get('card-1')!;
      card.set('ownerId', ana.user.id);
      card.set('ownerName', 'Ana');
      card.set('ownerKind', 'person');
    });

    await until(async () => (await list(ana)).items.some((item) => item.kind === 'card_assigned'));
    const after = await list(ana);
    expect(after.items.length).toBe(before.items.length + 1);
    const row = after.items.find((item) => item.kind === 'card_assigned')!;
    expect(row).toMatchObject({ snippet: 'Pay the invoice', actor: { id: ben.user.id }, board: { id: boardId }, target: `#/b/${boardId}` });
    expect(JSON.stringify(after)).not.toContain('second line');

    // The editor's own assignment to themselves is never a notice.
    const benList = await list(ben);
    expect(benList.items.some((item) => item.kind === 'card_assigned')).toBe(false);
    benSocket.provider.destroy();
  });

  it('records a due-soon card and an overdue card once each, through the sweep', async () => {
    const boardId = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, boardId, ben.user.id, 'editor');
    await h.share(owner.cookie, boardId, ana.user.id, 'viewer');
    const benSocket = h.connect(boardId, ben.cookie);
    await benSocket.synced();
    benSocket.doc.transact(() => {
      put(benSocket.doc, 'kanban', { type: 'container', layout: 'kanban' });
      put(benSocket.doc, 'doing', { type: 'lane', parent: 'kanban', rank: 'a0@kanban', stage: 'doing' });
      put(benSocket.doc, 'soon', { type: 'card', parent: 'doing', rank: 'a0@doing', text: 'Due soon card', ownerId: ana.user.id, ownerKind: 'person', due: todayUtc() });
      put(benSocket.doc, 'late', { type: 'card', parent: 'doing', rank: 'a1@doing', text: 'Late card', ownerId: ana.user.id, ownerKind: 'person', due: dayBefore(2) });
    });

    await until(async () => {
      const items = (await list(ana)).items;
      return items.some((item) => item.kind === 'card_due_soon') && items.some((item) => item.kind === 'card_overdue');
    });
    const items = (await list(ana)).items;
    const soon = items.filter((item) => item.kind === 'card_due_soon');
    const late = items.filter((item) => item.kind === 'card_overdue');
    expect(soon).toHaveLength(1);
    expect(late).toHaveLength(1);
    expect(soon[0]).toMatchObject({ snippet: 'Due soon card', actor: null, target: `#/b/${boardId}` });
    expect(late[0]).toMatchObject({ snippet: 'Late card', actor: null });

    // Negative check: several sweeps later the same reminders are still there once each, not repeated.
    await new Promise((resolve) => setTimeout(resolve, budget(600)));
    const later = (await list(ana)).items;
    expect(later.filter((item) => item.kind === 'card_due_soon')).toHaveLength(1);
    expect(later.filter((item) => item.kind === 'card_overdue')).toHaveLength(1);
    benSocket.provider.destroy();
  });

  it('hides the card from the assignee once their board access is removed', async () => {
    const boardId = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, boardId, ben.user.id, 'editor');
    await h.share(owner.cookie, boardId, ana.user.id, 'viewer');
    const benSocket = h.connect(boardId, ben.cookie);
    await benSocket.synced();
    benSocket.doc.transact(() => {
      put(benSocket.doc, 'kanban', { type: 'container', layout: 'kanban' });
      put(benSocket.doc, 'doing', { type: 'lane', parent: 'kanban', rank: 'a0@kanban', stage: 'doing' });
      put(benSocket.doc, 'card-x', { type: 'card', parent: 'doing', rank: 'a0@doing', text: 'Hidden later', ownerId: ana.user.id, ownerKind: 'person' });
    });
    await until(async () => (await list(ana)).items.some((item) => item.snippet === 'Hidden later' || item.kind === 'card_assigned'));
    const shown = await list(ana);
    expect(shown.items.some((item) => item.board?.id === boardId)).toBe(true);

    const removed = await h.api(owner.cookie, 'DELETE', `/api/boards/${boardId}/shares/user/${ana.user.id}`);
    expect(removed.status).toBeLessThan(300);
    await until(async () => !(await list(ana)).items.some((item) => item.board?.id === boardId));
    benSocket.provider.destroy();
  });
});
