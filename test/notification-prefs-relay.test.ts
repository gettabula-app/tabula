import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';
import { budget } from './wait-budget';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// The notification switches over the real server (docs/notifications.md, Settings; TAB-164 slice 3): a member who switched a group
// off gets no bell row for it, the write that caused it still succeeds, and switching back on makes new rows again.

const h = createHarness({ accounts: true });
let owner: Account;
let ana: Account;
let ben: Account;

const put = (doc: Y.Doc, id: string, fields: Record<string, unknown>) => {
  doc.getMap('objects').set(id, new Y.Map(Object.entries({ id, ...fields })));
};

async function list(account: Account) {
  const res = await h.api(account.cookie, 'GET', '/api/notifications?limit=50');
  if (res.status !== 200) throw new Error(`notifications failed (${res.status})`);
  return res.body as { items: Array<{ kind: string; board: { id: string } | null; actor: { id: string } | null }>; unread: number };
}

async function prefs(account: Account) {
  const res = await h.api(account.cookie, 'GET', '/api/notifications/prefs');
  if (res.status !== 200) throw new Error(`prefs failed (${res.status})`);
  return res.body.prefs as Record<string, boolean>;
}

beforeAll(async () => {
  await h.start({});
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

describe('notification switches over the relay', () => {
  it('starts with all four switches on, and refuses an unknown switch or a non-boolean value', async () => {
    expect(await prefs(ana)).toEqual({ mentions: true, replies: true, cards: true, shares: true });
    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/prefs', { quiet: true })).status).toBe(400);
    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/prefs', { shares: 'no' })).status).toBe(400);
    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/prefs', {})).status).toBe(400);
    expect((await h.api(undefined, 'GET', '/api/notifications/prefs')).status).toBe(401);
    expect(await prefs(ana)).toEqual({ mentions: true, replies: true, cards: true, shares: true });
  });

  it('gives no bell row for a share once shares are switched off, and the share still goes through', async () => {
    const shownBoard = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, shownBoard, ben.user.id, 'viewer');
    await until(async () => (await list(ben)).items.some((item) => item.kind === 'board_shared' && item.board?.id === shownBoard));

    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/prefs', { shares: false })).body).toEqual({
      prefs: { mentions: true, replies: true, cards: true, shares: false },
    });
    const quietBoard = await h.newBoard(owner.cookie);
    const shared = await h.api(owner.cookie, 'POST', `/api/boards/${quietBoard}/shares`, { principalType: 'user', principalId: ana.user.id, role: 'viewer' });
    expect(shared.status).toBe(201);
    expect(shared.body).toMatchObject({ principalId: ana.user.id, role: 'viewer' });
    await new Promise((resolve) => setTimeout(resolve, budget(400)));
    expect((await list(ana)).items.some((item) => item.board?.id === quietBoard)).toBe(false);
    // The switch is per person: Ben still gets his rows.
    expect(await prefs(ben)).toEqual({ mentions: true, replies: true, cards: true, shares: true });
  });

  it('creates rows again for new shares once shares are switched back on', async () => {
    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/prefs', { shares: true })).status).toBe(200);
    const boardId = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, boardId, ana.user.id, 'viewer');
    await until(async () => (await list(ana)).items.some((item) => item.kind === 'board_shared' && item.board?.id === boardId));
  });

  it('gives no card_assigned row while cards are off, and does not release it when cards go back on', async () => {
    const boardId = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, boardId, ben.user.id, 'editor');
    await h.share(owner.cookie, boardId, ana.user.id, 'viewer');
    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/prefs', { cards: false })).status).toBe(200);
    const before = (await list(ana)).items.filter((item) => item.kind === 'card_assigned').length;

    const benSocket = h.connect(boardId, ben.cookie);
    await benSocket.synced();
    benSocket.doc.transact(() => {
      put(benSocket.doc, 'kanban', { type: 'container', layout: 'kanban' });
      put(benSocket.doc, 'doing', { type: 'lane', parent: 'kanban', rank: 'a0@kanban', stage: 'doing' });
      put(benSocket.doc, 'quiet-card', { type: 'card', parent: 'doing', rank: 'a0@doing', text: 'Quiet card', ownerId: ana.user.id, ownerKind: 'person' });
    });
    await new Promise((resolve) => setTimeout(resolve, budget(600)));
    expect((await list(ana)).items.filter((item) => item.kind === 'card_assigned')).toHaveLength(before);

    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/prefs', { cards: true })).status).toBe(200);
    benSocket.doc.transact(() => {
      put(benSocket.doc, 'loud-card', { type: 'card', parent: 'doing', rank: 'a1@doing', text: 'Loud card', ownerId: ana.user.id, ownerKind: 'person' });
    });
    await until(async () => (await list(ana)).items.some((item) => item.kind === 'card_assigned' && item.board?.id === boardId));
    expect((await list(ana)).items.filter((item) => item.kind === 'card_assigned')).toHaveLength(before + 1);
    benSocket.provider.destroy();
  });
});
