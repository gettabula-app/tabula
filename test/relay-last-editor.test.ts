import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { createHarness, until, type Account, type Body } from './mcp-harness';

// "Who last edited this board" (TAB-375), written by the real relay: a save writes the board row in the directory.
// Enforce mode is on for the whole file, so a write the sync guard reverts is seen as reverted (and not as a silent pass), and
// every "must stay the same" check first waits for the write it compares against to be saved (updated_at moves on).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({
  accounts: true,
  settings: { MCP: 'on', JOIN_CODES: 'on', SYNC_VALIDATE: 'enforce' },
  env: { SAVE_DEBOUNCE_MS: '200' },
});

type Live = ReturnType<typeof h.connect>;
type Row = { last_edited_by: string | null; last_edited_kind: string | null; last_edited_at: number | null; updated_at: number };

let workspaceOwner: Account;
let ada: Account;
let bob: Account;
let carol: Account;
let viewer: Account;

beforeAll(async () => {
  await h.start();
  workspaceOwner = await h.signInOwner();
  const team = await h.newTeam(workspaceOwner.cookie);
  ada = await h.joinTeam(workspaceOwner.cookie, team.id);
  bob = await h.joinTeam(workspaceOwner.cookie, team.id);
  carol = await h.joinTeam(workspaceOwner.cookie, team.id);
  viewer = await h.joinTeam(workspaceOwner.cookie, team.id);
  // a card names the person by their current name, so each one gets a name the test can read back
  for (const [who, name] of [[ada, 'Ada Lovelace'], [bob, 'Bob Byron'], [carol, 'Carol Clark']] as const) {
    const named = await h.api(who.cookie, 'PATCH', '/api/me', { name });
    if (named.status !== 200) throw new Error(`could not name ${name} (${named.status})`);
  }
});

// each provider adds an exit listener to the process (y-websocket), so every test closes the ones it opened
afterEach(() => h.closeProviders());

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

/** The board row as the directory has it now. A fresh read-only connection each time, so the relay's writes are never held. */
function row(board: string): Row {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT last_edited_by, last_edited_kind, last_edited_at, updated_at FROM boards WHERE id = ?').get(board) as Row;
  } finally {
    db.close();
  }
}

/** The board as GET /api/boards shows it to a signed-in user. */
async function listed(cookie: string, board: string): Promise<Body> {
  const boards = (await h.api(cookie, 'GET', '/api/boards')).body as Body[];
  return boards.find((b) => b.id === board);
}

const sticky = (id: string, extra: Record<string, unknown> = {}) =>
  new Y.Map<unknown>(Object.entries({ id, type: 'sticky', text: 'hi', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', ...extra }));

async function connected(board: string, cookie?: string): Promise<Live> {
  const live = h.connect(board, cookie);
  await live.synced();
  return live;
}

function write(live: Live, change: (doc: Y.Doc) => void) {
  live.doc.transact(() => change(live.doc), 'local');
}

/**
 * Waits until the relay has handled every frame sent so far on this socket. The relay drops a read-only socket's updates but still
 * answers its state vector (step 1) with step 2, and frames on one socket are handled in order, so the answer is the barrier.
 */
async function drained(live: Live) {
  live.provider.synced = false;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // the sync message type
  syncProtocol.writeSyncStep1(enc, live.doc);
  live.provider.ws!.send(encoding.toUint8Array(enc));
  await until(() => live.provider.synced);
}

/** Waits until the board row has been written by a save that came after `before` (updated_at moved on). */
const savedAfter = (board: string, before: Row) => until(() => row(board).updated_at > before.updated_at);

describe('last editor on the relay', () => {
  it('a person edit names that person by user id, with the time of the edit', async () => {
    const board = await h.newBoard(ada.cookie);
    const live = await connected(board, ada.cookie);
    const start = Date.now();

    write(live, (doc) => doc.getMap('objects').set('s-a', sticky('s-a')));
    await until(() => row(board).last_edited_by === ada.user.id);

    const saved = row(board);
    expect(saved).toMatchObject({ last_edited_by: ada.user.id, last_edited_kind: 'person' });
    expect(saved.last_edited_at).toBeGreaterThanOrEqual(start);
    expect(saved.last_edited_at).toBeLessThanOrEqual(Date.now());
    expect(await listed(ada.cookie, board)).toMatchObject({ lastEditedBy: 'Ada Lovelace', lastEditedKind: 'person' });
  });

  it('a later edit by a second person replaces the first', async () => {
    const board = await h.newBoard(ada.cookie);
    await h.share(ada.cookie, board, bob.user.id, 'editor');
    const adaLive = await connected(board, ada.cookie);
    write(adaLive, (doc) => doc.getMap('objects').set('s-1', sticky('s-1')));
    await until(() => row(board).last_edited_by === ada.user.id);

    const bobLive = await connected(board, bob.cookie);
    write(bobLive, (doc) => doc.getMap('objects').set('s-2', sticky('s-2')));
    await until(() => row(board).last_edited_by === bob.user.id);

    expect(row(board)).toMatchObject({ last_edited_by: bob.user.id, last_edited_kind: 'person' });
  });

  it('a height correction alone (h and updatedAt) does not move the editor', async () => {
    const board = await h.newBoard(ada.cookie);
    await h.share(ada.cookie, board, bob.user.id, 'editor');
    const adaLive = await connected(board, ada.cookie);
    write(adaLive, (doc) => doc.getMap('objects').set('s-heal', sticky('s-heal')));
    await until(() => row(board).last_edited_by === ada.user.id);
    const earlier = row(board);

    const bobLive = await connected(board, bob.cookie);
    await until(() => bobLive.doc.getMap('objects').has('s-heal'));
    write(bobLive, (doc) => {
      const object = doc.getMap('objects').get('s-heal') as Y.Map<unknown>;
      object.set('h', 240);
      object.set('updatedAt', Date.now());
    });
    await until(() => (h.savedDoc(board).getMap('objects').get('s-heal') as Y.Map<unknown> | undefined)?.get('h') === 240);
    await savedAfter(board, earlier);

    expect(row(board)).toMatchObject({
      last_edited_by: ada.user.id,
      last_edited_kind: 'person',
      last_edited_at: earlier.last_edited_at,
    });
  });

  it('a poll answer and a vote after a person edit leave the editor and its time alone', async () => {
    const board = await h.newBoard(ada.cookie);
    const live = await connected(board, ada.cookie);
    write(live, (doc) => doc.getMap('objects').set('s-d', sticky('s-d')));
    await until(() => row(board).last_edited_by === ada.user.id);
    const earlier = row(board);

    // TAB-145 (anonymous questions) is not built yet, so this uses an anonymous poll (anonymous: true) with an answer, and a vote,
    // as the last writes. Neither map counts as an edit, so the editor and its time must stay as the person's edit left them.
    const answerKey = `poll-anon:${ada.user.id}`;
    const voteKey = `step-1:${ada.user.id}:item-1`;
    write(live, (doc) => {
      doc.getMap('polls').set('poll-anon', {
        id: 'poll-anon', question: 'Where for lunch?', options: [{ id: 'o1', text: 'Here' }, { id: 'o2', text: 'There' }], anonymous: true,
      });
      doc.getMap('pollAnswers').set(answerKey, { pollId: 'poll-anon', userId: ada.user.id, optionIds: ['o1'] });
      doc.getMap('votes').set(voteKey, { itemId: 'item-1', userId: ada.user.id, stepId: 'step-1' });
    });
    await until(() => h.savedDoc(board).getMap('pollAnswers').has(answerKey) && h.savedDoc(board).getMap('votes').has(voteKey));
    await savedAfter(board, earlier);

    const after = row(board);
    expect(after.last_edited_by).toBe(earlier.last_edited_by);
    expect(after.last_edited_at).toBe(earlier.last_edited_at);
    expect(after.updated_at).toBeGreaterThan(earlier.updated_at);
  });

  it('a message the sync guard reverts does not name its sender', async () => {
    const board = await h.newBoard(ada.cookie);
    const live = await connected(board, ada.cookie);
    const rejectedBefore = ((await h.api(undefined, 'GET', '/api/health')).body as Body).syncValidate?.rejected ?? 0;

    // x as a string is a bad type: enforce mode reverts the whole message
    write(live, (doc) => doc.getMap('objects').set('s-bad', sticky('s-bad', { x: 'no' })));
    await until(async () => (((await h.api(undefined, 'GET', '/api/health')).body as Body).syncValidate?.rejected ?? 0) > rejectedBefore);
    await until(() => !live.doc.getMap('objects').has('s-bad'));

    // a valid vote afterwards is the save that flushes the board row
    const flushed = row(board);
    const voteKey = `step-1:${ada.user.id}:item-2`;
    write(live, (doc) => doc.getMap('votes').set(voteKey, { itemId: 'item-2', userId: ada.user.id, stepId: 'step-1' }));
    await until(() => h.savedDoc(board).getMap('votes').has(voteKey));
    await savedAfter(board, flushed);

    expect(h.savedDoc(board).getMap('objects').has('s-bad')).toBe(false);
    expect(row(board)).toMatchObject({ last_edited_by: null, last_edited_kind: null, last_edited_at: null });
  });

  it('a join-code guest and a read-only viewer never become the editor', async () => {
    const board = await h.newBoard(ada.cookie);
    await h.share(ada.cookie, board, viewer.user.id, 'viewer');
    const adaLive = await connected(board, ada.cookie);
    write(adaLive, (doc) => doc.getMap('objects').set('s-first', sticky('s-first')));
    await until(() => row(board).last_edited_by === ada.user.id);
    const earlier = row(board);

    // a guest with editor rights: the write is applied and saved, and a guest is never recorded
    const code = await h.api(ada.cookie, 'POST', `/api/boards/${board}/join-codes`, { role: 'editor' });
    expect(code.status).toBe(201);
    const joined = await h.api(undefined, 'POST', '/api/join', { code: code.body.code, name: 'Guest' }, { 'x-forwarded-for': h.nextIp() });
    expect(joined.status).toBe(201);
    const guestCookie = joined.headers.getSetCookie()[0].split(';')[0];
    const guest = await connected(board, guestCookie);
    write(guest, (doc) => doc.getMap('objects').set('s-guest', sticky('s-guest')));
    await until(() => h.savedDoc(board).getMap('objects').has('s-guest'));
    await savedAfter(board, earlier);
    expect(row(board)).toMatchObject({ last_edited_by: ada.user.id, last_edited_at: earlier.last_edited_at });

    // a viewer's write is dropped before it reaches the document, so it is never saved. The drained barrier proves the relay has
    // handled that dropped frame; the anchor below is ada's own vote, saved after it.
    const viewerLive = await connected(board, viewer.cookie);
    write(viewerLive, (doc) => doc.getMap('objects').set('s-viewer', sticky('s-viewer')));
    await drained(viewerLive);
    const beforeAnchor = row(board);
    const voteKey = `step-1:${ada.user.id}:item-3`;
    write(adaLive, (doc) => doc.getMap('votes').set(voteKey, { itemId: 'item-3', userId: ada.user.id, stepId: 'step-1' }));
    await until(() => h.savedDoc(board).getMap('votes').has(voteKey));
    await savedAfter(board, beforeAnchor);

    expect(h.savedDoc(board).getMap('objects').has('s-viewer')).toBe(false);
    expect(row(board)).toMatchObject({ last_edited_by: ada.user.id, last_edited_at: earlier.last_edited_at });
  });

  it('an MCP write names its token as an agent, and the card shows the token name', async () => {
    const board = await h.newBoard(ada.cookie);
    const made = await h.newToken(ada.cookie, { name: 'Claude', scope: 'write' });

    const result = await h.tool(made.token, 'create_objects', { boardId: board, objects: [{ type: 'sticky', text: 'from Claude', x: 0, y: 0 }] });
    expect(result.error).toBeUndefined();
    await until(() => row(board).last_edited_kind === 'agent');

    expect(row(board)).toMatchObject({ last_edited_by: 'Claude', last_edited_kind: 'agent' });
    expect(await listed(ada.cookie, board)).toMatchObject({ lastEditedBy: 'Claude', lastEditedKind: 'agent' });
  });

  it('a long token name is capped at 40 characters, and control characters are refused when the token is made', async () => {
    const board = await h.newBoard(ada.cookie);
    expect((await h.api(ada.cookie, 'POST', '/api/me/tokens', { name: 'Bot\u0007', scope: 'write' })).status).toBe(400);

    // a format character (U+200B) passes the token check and is stripped when the agent is named; 60 more characters, capped
    const made = await h.newToken(ada.cookie, { name: `Bot​${'x'.repeat(60)}`, scope: 'write' });
    const result = await h.tool(made.token, 'create_objects', { boardId: board, objects: [{ type: 'sticky', text: 'long name', x: 0, y: 0 }] });
    expect(result.error).toBeUndefined();
    await until(() => row(board).last_edited_kind === 'agent');

    expect(row(board).last_edited_by).toBe(`Bot${'x'.repeat(37)}`);
    expect(await listed(ada.cookie, board)).toMatchObject({ lastEditedBy: `Bot${'x'.repeat(37)}`, lastEditedKind: 'agent' });
  });

  it('a person who edited and was then disabled is shown as a former member', async () => {
    const board = await h.newBoard(ada.cookie);
    await h.share(ada.cookie, board, carol.user.id, 'editor');
    const carolLive = await connected(board, carol.cookie);
    write(carolLive, (doc) => doc.getMap('objects').set('s-carol', sticky('s-carol')));
    await until(() => row(board).last_edited_by === carol.user.id);

    // leave the socket first: a disabled account's socket is closed by the relay and would reconnect
    carolLive.provider.destroy();
    expect((await h.api(workspaceOwner.cookie, 'PATCH', `/api/members/${carol.user.id}`, { disabled: true })).status).toBe(200);

    expect(await listed(ada.cookie, board)).toMatchObject({ lastEditedBy: 'A former member', lastEditedKind: 'person' });
    // the directory keeps the id; the card names no one
    expect(row(board)).toMatchObject({ last_edited_by: carol.user.id, last_edited_kind: 'person' });
  });
});
