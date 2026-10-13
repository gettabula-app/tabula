import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';

// The board activity log over the real relay (TAB-158, docs/agent-presence.md): an MCP call is logged in words, anyone who can see the board reads the log,
// only editors revert, a revert is authorised when it is made, and it leaves what people changed since.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on' }, env: { TABULA_TEST_AGENT_PRESENCE_MS: '1500' } });
let owner: Account;
let alice: Account; // owns the board
let bob: Account; // editor
let dave: Account; // viewer
let frank: Account; // no access
let board: string;
let writer: string;
let live: ReturnType<typeof h.connect>;

const sticky = (text: string) => ({ type: 'sticky', text, x: 0, y: 0 });
const objects = () => (live.doc.getMap('objects').toJSON() as Record<string, Record<string, unknown>>);
const log = async (who: Account) => h.api(who.cookie, 'GET', `/api/boards/${board}/activity`);
const revert = (who: Account, id: string) => h.api(who.cookie, 'POST', `/api/boards/${board}/activity/${id}/revert`);

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const team = (await h.newTeam(owner.cookie)).id;
  [alice, bob, dave, frank] = [await h.joinTeam(owner.cookie, team), await h.joinTeam(owner.cookie, team), await h.joinTeam(owner.cookie, team), await h.joinTeam(owner.cookie, team)];
  board = await h.newBoard(alice.cookie);
  await h.share(alice.cookie, board, bob.user.id, 'editor');
  await h.share(alice.cookie, board, dave.user.id, 'viewer');
  writer = (await h.newToken(alice.cookie, { scope: 'write', name: 'Claude' })).token;
  live = h.connect(board, alice.cookie);
  await live.synced();
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('the activity log', () => {
  it('records a call in words, with the agent named for the member and no content, readable by a viewer but not by a stranger', async () => {
    const made = await h.tool(writer, 'create_objects', { boardId: board, objects: [sticky('SECRET PLAN one'), sticky('SECRET PLAN two')] });
    const ids = (made.data.created as { id: string }[]).map((c) => c.id);
    const res = await log(dave);
    expect(res.status).toBe(200);
    const entry = res.body.entries[0];
    expect(entry).toMatchObject({ agent: { token: 'Claude', member: alice.user.name.split(/\s+/)[0] }, tool: 'create_objects', summary: 'created 2 sticky notes', counts: { created: 2, changed: 0, removed: 0 }, revertible: true });
    expect(entry.ids.sort()).toEqual([...ids].sort());
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(JSON.stringify(res.body)).not.toContain('inverse');
    expect([403, 404]).toContain((await log(frank)).status);
    expect((await h.api(undefined as unknown as string, 'GET', `/api/boards/${board}/activity`)).status).toBeGreaterThanOrEqual(401);
  });

  it('is written only by calls that change the board: a read leaves no entry', async () => {
    const before = (await log(alice)).body.entries.length;
    await h.tool(writer, 'get_board', { boardId: board });
    expect((await log(alice)).body.entries.length).toBe(before);
  });
});

describe('reverting a call', () => {
  it('is for editors: a viewer and a stranger are refused, an editor takes the whole call back in one step', async () => {
    const made = await h.tool(writer, 'create_objects', { boardId: board, objects: [sticky('to revert a'), sticky('to revert b')] });
    const ids = (made.data.created as { id: string }[]).map((c) => c.id);
    await until(() => ids.every((id) => objects()[id]));
    const entry = (await log(alice)).body.entries[0];
    expect(entry.ids.sort()).toEqual([...ids].sort());
    expect((await revert(dave, entry.id)).status).toBe(403);
    expect([403, 404]).toContain((await revert(frank, entry.id)).status);
    expect(ids.every((id) => objects()[id])).toBe(true);
    const done = await revert(bob, entry.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ applied: 2, skipped: [] });
    await until(() => ids.every((id) => !objects()[id]));
    const after = (await log(alice)).body.entries.find((e: { id: string }) => e.id === entry.id);
    expect(after).toMatchObject({ revertible: false, reverted: { by: bob.user.name } });
    expect((await revert(bob, entry.id)).status).toBe(409); // once only
    expect((await revert(alice, 'no-such-entry')).status).toBe(404);
  });

  it('leaves what a person changed since, and says what it left', async () => {
    const made = await h.tool(writer, 'create_objects', { boardId: board, objects: [sticky('mine')] });
    const id = (made.data.created as { id: string }[])[0].id;
    await until(() => !!objects()[id]);
    await h.tool(writer, 'update_objects', { boardId: board, updates: [{ id, text: 'agent edit' }] });
    await until(() => objects()[id]?.text === 'agent edit');
    const entry = (await log(alice)).body.entries[0];
    expect(entry).toMatchObject({ tool: 'update_objects', summary: 'changed 1 sticky note' });
    // a person rewrites the text afterwards
    live.doc.transact(() => (live.doc.getMap('objects').get(id) as Y.Map<unknown>).set('text', 'person edit'));
    const done = await revert(alice, entry.id);
    expect(done.status).toBe(200);
    expect(done.body.applied).toBe(0);
    expect(done.body.skipped).toEqual([{ id, reason: 'changed' }]);
    expect(objects()[id].text).toBe('person edit');
    // nothing was applied, so the entry is still there to try again once the person has dealt with what is in the way
    expect((await log(alice)).body.entries.find((e: { id: string }) => e.id === entry.id)).toMatchObject({ revertible: true });
    expect((await revert(alice, entry.id)).status).toBe(200);
  });

  it('authorises at revert time: an editor whose access was withdrawn is refused, whatever the entry says', async () => {
    const made = await h.tool(writer, 'create_objects', { boardId: board, objects: [sticky('late')] });
    const id = (made.data.created as { id: string }[])[0].id;
    await until(() => !!objects()[id]);
    const entry = (await log(alice)).body.entries[0];
    const unshared = await h.api(alice.cookie, 'DELETE', `/api/boards/${board}/shares/user/${bob.user.id}`);
    expect([200, 204]).toContain(unshared.status);
    expect([403, 404]).toContain((await revert(bob, entry.id)).status);
    expect(objects()[id]).toBeTruthy();
  });
});

describe('an agent at work (presence)', () => {
  const agentsSeenBy = (conn: ReturnType<typeof h.connect>) => {
    const out: { clientId: number; agents: { id: string; token: string; member: string | null; x: number | null; y: number | null }[] }[] = [];
    conn.provider.awareness.getStates().forEach((st, clientId) => {
      if (Array.isArray((st as { agents?: unknown }).agents)) out.push({ clientId, agents: (st as { agents: never }).agents });
    });
    return out;
  };

  it('shows an agent that changed the board, as who it works for and its token name, at the middle of what it changed, and takes it away after a while', async () => {
    const watcher = h.connect(board, dave.cookie); // a viewer sees presence too
    await watcher.synced();
    await until(() => agentsSeenBy(watcher).length === 0, 10_000); // an earlier test's agent has gone
    await h.tool(writer, 'create_objects', { boardId: board, objects: [{ type: 'sticky', text: 'presence', x: 1000, y: 2000 }] });
    await until(() => agentsSeenBy(watcher).length === 1);
    const [{ agents }] = agentsSeenBy(watcher);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ token: 'Claude', member: alice.user.name.split(/\s+/)[0] });
    expect(agents[0].id).toMatch(/^[0-9a-f]{12}$/); // a hash, never the token's own id
    expect(agents[0].x).toBeGreaterThan(900);
    expect(agents[0].y).toBeGreaterThan(1900);
    await until(() => agentsSeenBy(watcher).length === 0, 10_000); // TABULA_TEST_AGENT_PRESENCE_MS = 1.5 s here, 30 s in production
  });

  it('can not be forged: an agents field a client puts in its own awareness reaches nobody, and a read leaves no agent behind', async () => {
    const watcher = h.connect(board, dave.cookie);
    const forger = h.connect(board, alice.cookie); // bob's access was withdrawn by an earlier test
    await Promise.all([watcher.synced(), forger.synced()]);
    forger.provider.awareness.setLocalState({ user: { id: alice.user.id, name: 'Admin', color: '#112233' }, cursor: { x: 5, y: 5 }, agents: [{ id: 'abcdef012345', token: 'Admin', member: 'Ada', x: 0, y: 0 }] });
    await until(() => agentsSeenBy(watcher).length === 0, 10_000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(agentsSeenBy(watcher))}`); });
    await until(() => [...watcher.provider.awareness.getStates().values()].some((st) => JSON.stringify((st as { cursor?: unknown }).cursor) === '{"x":5,"y":5}'));
    expect(agentsSeenBy(watcher)).toEqual([]);
    await h.tool(writer, 'get_board', { boardId: board });
    await new Promise((r) => setTimeout(r, 400));
    expect(agentsSeenBy(watcher)).toEqual([]);
  });
});

