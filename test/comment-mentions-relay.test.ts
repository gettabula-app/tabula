import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';
import { budget } from './wait-budget';

// TAB-53 over a real relay in accounts mode: the relay's own comment hooks record the mention rows (the unit tests rebuild the wiring).

const h = createHarness({ accounts: true });
let owner: Account;
let editor: Account;
let outsider: Account;
let boardId: string;

const api = (who: Account, method: string, route: string, body?: unknown) => h.api(who.cookie, method, route, body);
const inbox = async (who: Account) => ((await api(who, 'GET', '/api/notifications?limit=50')).body?.items ?? []) as { kind: string; read: boolean; snippet: string | null }[];

function addThread(doc: Y.Doc, id: string, who: Account, text: string) {
  const threads = doc.getMap('threads');
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    threads.set(id, m);
    const fields = { id, createdAt: Date.now(), authorId: who.user.id, authorName: who.user.name, authorColor: '#123456', text, anchor: { x: 0, y: 0 }, resolved: false };
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    m.set('replies', new Y.Map());
  });
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const teamId = (await h.newTeam(owner.cookie)).id;
  editor = await h.joinTeam(owner.cookie, teamId);
  outsider = await h.joinTeam(owner.cookie, teamId);
  boardId = await h.newBoard(owner.cookie);
  await h.share(owner.cookie, boardId, editor.user.id, 'editor');
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('comment mentions through the relay', () => {
  it('notifies a named board member once, and nobody who cannot open the board', async () => {
    const conn = h.connect(`${boardId}~comments`, editor.cookie);
    await conn.synced();
    addThread(conn.doc, 't-mention', editor, `Please look, @{${owner.user.id}} and @{${outsider.user.id}} and @{${owner.user.id}}`);
    await until(async () => (await inbox(owner)).some((i) => i.kind === 'comment_mention'));
    const mine = (await inbox(owner)).filter((i) => i.kind === 'comment_mention');
    expect(mine).toHaveLength(1);
    expect(mine[0].snippet).toContain('Please look');
    expect((await inbox(outsider)).filter((i) => i.kind === 'comment_mention')).toHaveLength(0);
  });

  it('does not notify again when the comment is edited', async () => {
    const conn = h.connect(`${boardId}~comments`, editor.cookie);
    await conn.synced();
    const threads = conn.doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    await until(() => threads.has('t-mention'));
    const before = (await inbox(owner)).filter((i) => i.kind === 'comment_mention').length;
    conn.doc.transact(() => { threads.get('t-mention')!.set('text', `Edited @{${owner.user.id}}`); threads.get('t-mention')!.set('editedAt', Date.now()); });
    await new Promise((r) => setTimeout(r, budget(400))); // a negative check: give a wrong second row time to appear
    expect((await inbox(owner)).filter((i) => i.kind === 'comment_mention')).toHaveLength(before);
  });
});
