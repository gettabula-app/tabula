import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as Y from 'yjs';
import { createHarness, sleep, until, type Body } from './mcp-harness';

// docs/mcp.md, open mode: no accounts, one shared token with a fixed scope, off unless asked for.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SHARED = 's'.repeat(24) + 'h'.repeat(24);
const sticky = (extra: Record<string, unknown> = {}) => ({ type: 'sticky', text: 'a', x: 0, y: 0, ...extra });

describe('off by default', () => {
  const off = createHarness({});
  beforeAll(() => off.start());
  afterAll(() => off.cleanup());
  afterEach(() => off.closeProviders());

  it('answers 404 JSON on /mcp, not the app, and changes nothing else', async () => {
    for (const method of ['POST', 'GET']) {
      const res = await fetch(`${off.base}/mcp`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${SHARED}` }, body: method === 'POST' ? '{}' : undefined });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect((await off.api(undefined, 'GET', '/api/config')).body).toEqual({ authEnabled: false, images: true });
    expect((await off.api(undefined, 'GET', '/api/me/tokens')).status).toBe(404);
    // sync works as it always did
    const a = off.connect('room-a');
    const b = off.connect('room-a');
    await Promise.all([a.synced(), b.synced()]);
    a.doc.getMap('objects').set('x', new Y.Map([['text', 'hello']]));
    await until(() => b.doc.getMap('objects').has('x'));
  });
});

describe('refusing to start', () => {
  const attempt = async (settings: Record<string, string>) => {
    const h = createHarness({ settings });
    try {
      await h.start();
      return null;
    } catch (e) {
      return String((e as Error).message);
    } finally {
      await h.cleanup();
    }
  };

  it('needs a shared token of 32 or more characters without spaces', async () => {
    expect(await attempt({ MCP: 'on' })).toMatch(/TABULA_MCP_TOKEN/);
    expect(await attempt({ MCP: 'on', MCP_TOKEN: 'short' })).toMatch(/TABULA_MCP_TOKEN/);
    expect(await attempt({ MCP: 'on', MCP_TOKEN: `${'a'.repeat(20)} ${'b'.repeat(20)}` })).toMatch(/without spaces/);
  });

  it('needs a known scope, a known switch, and https beyond this machine', async () => {
    expect(await attempt({ MCP: 'on', MCP_TOKEN: SHARED, MCP_SCOPE: 'root' })).toMatch(/TABULA_MCP_SCOPE/);
    expect(await attempt({ MCP: 'maybe' })).toMatch(/TABULA_MCP must be on or off/);
    expect(await attempt({ MCP: 'on', MCP_TOKEN: SHARED, BASE_URL: 'http://tabula.example.com' })).toMatch(/https/);
  });
});

describe('with the default scope (read)', () => {
  const h = createHarness({ settings: { MCP: 'on', MCP_TOKEN: SHARED } });
  beforeAll(() => h.start());
  afterAll(() => h.cleanup());
  afterEach(() => h.closeProviders());

  let board = '';

  /** A board that exists on the relay: a browser opens it and writes something, as people do. */
  const makeBoard = async (id: string) => {
    const browser = h.connect(id);
    await browser.synced();
    browser.doc.transact(() => {
      browser.doc.getMap('objects').set('o1', new Y.Map(Object.entries({ id: 'o1', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', text: 'from a browser' })));
      browser.doc.getMap('meta').set('name', 'Open board');
    }, 'local');
    await until(() => h.savedDoc(id).getMap('objects').has('o1'));
    return browser;
  };

  beforeAll(async () => {
    board = 'open-board-1';
    await makeBoard(board);
  });

  it('wants the shared token, compared whole', async () => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const bad = [undefined, 'nope', SHARED.slice(1), `${SHARED}x`, SHARED.toUpperCase(), 'x'.repeat(48), ' '.repeat(3)];
    for (const token of bad) {
      const res = await h.rpc(token, ping);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_token', message: 'The token is unknown, expired or revoked.' });
    }
    expect((await h.rpc(SHARED, ping)).status).toBe(200);
    expect((await h.rpc(SHARED, ping, { origin: h.base })).status).toBe(403);
  });

  it('lists the read tools only, with no board list', async () => {
    const tools = (await h.call(SHARED, 'tools/list')).body.result.tools.map((t: Body) => t.name).sort();
    expect(tools).toEqual(['get_board', 'get_objects', 'list_comments', 'list_kanban_cards', 'whoami']);
    expect((await h.call(SHARED, 'tools/call', { name: 'list_boards', arguments: {} })).body.error.code).toBe(-32602);
    const who = await h.tool(SHARED, 'whoami');
    expect(who.data).toMatchObject({ mode: 'open', user: null, token: { name: 'AI tool', scope: 'read' }, workspaceReadOnly: false });
  });

  it('reads a board that exists and refuses everything that would change it', async () => {
    const view = await h.tool(SHARED, 'get_board', { boardId: board });
    expect(view.data.board).toMatchObject({ id: board, title: 'Open board', role: null, access: 'read' });
    expect(view.data.objects.map((o: Body) => o.text)).toEqual(['from a browser']);
    expect(view.data.writable).toBe(false);
    const before = Buffer.from(Y.encodeStateAsUpdate(h.savedDoc(board))).toString('base64');
    for (const [name, args] of [
      ['create_objects', { boardId: board, objects: [sticky()] }],
      ['update_objects', { boardId: board, updates: [{ id: 'o1', text: 'x' }] }],
      ['delete_objects', { boardId: board, ids: ['o1'] }],
      ['add_comment', { boardId: board, text: 'x', x: 0, y: 0 }],
      ['reply_to_comment', { boardId: board, threadId: 'a', text: 'x' }],
    ] as const) {
      expect((await h.tool(SHARED, name, args)).error).toBe('forbidden');
    }
    await sleep(1300);
    expect(Buffer.from(Y.encodeStateAsUpdate(h.savedDoc(board))).toString('base64')).toBe(before);
  });

  it('knows no board it was not shown, and never makes a room', async () => {
    for (const id of ['ghost', 'another-ghost']) {
      expect((await h.tool(SHARED, 'get_board', { boardId: id })).error).toBe('not_found');
      expect((await h.tool(SHARED, 'list_comments', { boardId: id })).error).toBe('not_found');
    }
    expect(fs.readdirSync(h.dir).filter((f) => f.includes('ghost'))).toEqual([]);
    expect((await h.tool(SHARED, 'get_board', { boardId: `${board}~comments` })).error).toBe('invalid_input');
  });

  it('reads comments of a board that has none yet without making their room', async () => {
    expect((await h.tool(SHARED, 'list_comments', { boardId: board })).data).toMatchObject({ threads: [], counts: { open: 0, resolved: 0 } });
    expect(fs.existsSync(h.roomFile(`${board}~comments`))).toBe(false);
  });
});

describe('with the write scope', () => {
  const h = createHarness({ settings: { MCP: 'on', MCP_TOKEN: SHARED, MCP_SCOPE: 'write' }, env: { QUIET: '' } });
  beforeAll(() => h.start());
  afterAll(() => h.cleanup());
  afterEach(() => h.closeProviders());

  it('edits a board that people have open, live, as "mcp", and logs it without the token', async () => {
    const browser = h.connect('open-board-2');
    await browser.synced();
    browser.doc.getMap('meta').set('name', 'Shared');
    await until(() => h.savedDoc('open-board-2').getMap('meta').has('name'));
    const watcher = h.connect('open-board-2');
    await watcher.synced();

    const made = await h.tool(SHARED, 'create_objects', { boardId: 'open-board-2', objects: [sticky({ text: 'from the tool', ref: 'a' }), { type: 'connector', from: { ref: 'a' }, to: { x: 5, y: 5 } }] });
    expect(made.error).toBeUndefined();
    await until(() => watcher.doc.getMap('objects').size === 2);
    expect((watcher.doc.getMap('objects').get(made.data.refs.a) as Y.Map<unknown>).toJSON()).toMatchObject({ text: 'from the tool', createdBy: 'mcp' });

    const id = made.data.refs.a;
    expect((await h.tool(SHARED, 'update_objects', { boardId: 'open-board-2', updates: [{ id, text: 'changed' }] })).error).toBeUndefined();
    await until(() => (watcher.doc.getMap('objects').get(id) as Y.Map<unknown>).get('text') === 'changed');
    expect((await h.tool(SHARED, 'delete_objects', { boardId: 'open-board-2', ids: [id] })).data.alsoDeleted).toHaveLength(1);
    await until(() => watcher.doc.getMap('objects').size === 0);

    const comments = h.connect('open-board-2~comments');
    await comments.synced();
    const said = await h.tool(SHARED, 'add_comment', { boardId: 'open-board-2', text: 'hello from a tool', x: 1, y: 2 });
    await until(() => comments.doc.getMap('threads').has(said.data.threadId));
    expect((comments.doc.getMap('threads').get(said.data.threadId) as Y.Map<unknown>).toJSON()).toMatchObject({ authorId: 'mcp', authorName: 'AI tool', text: 'hello from a tool' });
    expect((await h.tool(SHARED, 'reply_to_comment', { boardId: 'open-board-2', threadId: said.data.threadId, text: 'and a reply' })).error).toBeUndefined();

    await sleep(200);
    const log = h.output();
    expect(log).toContain('mcp.create_objects');
    expect(log).toContain('board=open-board-2');
    expect(log).not.toContain(SHARED);
    expect(log).not.toContain('from the tool');
  });

  it('still makes no room for a board that is not there', async () => {
    const res = await h.tool(SHARED, 'create_objects', { boardId: 'nobody-made-this', objects: [sticky()] });
    expect(res.error).toBe('not_found');
    expect(fs.existsSync(h.roomFile('nobody-made-this'))).toBe(false);
    expect(fs.existsSync(h.roomFile('nobody-made-this~comments'))).toBe(false);
  });
});

describe('with the comment scope', () => {
  const h = createHarness({ settings: { MCP: 'on', MCP_TOKEN: SHARED, MCP_SCOPE: 'comment' } });
  beforeAll(() => h.start());
  afterAll(() => h.cleanup());
  afterEach(() => h.closeProviders());

  it('comments but does not edit', async () => {
    const browser = h.connect('open-board-3');
    await browser.synced();
    browser.doc.getMap('meta').set('name', 'Commentable');
    await until(() => h.savedDoc('open-board-3').getMap('meta').has('name'));
    const tools = (await h.call(SHARED, 'tools/list')).body.result.tools.map((t: Body) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['add_comment', 'reply_to_comment']));
    expect(tools).not.toContain('create_objects');
    expect((await h.tool(SHARED, 'add_comment', { boardId: 'open-board-3', text: 'noted', x: 0, y: 0 })).error).toBeUndefined();
    expect((await h.tool(SHARED, 'create_objects', { boardId: 'open-board-3', objects: [sticky()] })).error).toBe('forbidden');
  });
});

describe('in accounts mode', () => {
  const h = createHarness({ accounts: true, settings: { MCP: 'on', MCP_TOKEN: SHARED, MCP_SCOPE: 'write' } });
  beforeAll(() => h.start());
  afterAll(() => h.cleanup());

  it('does not take the shared token, and says it ignores it', async () => {
    expect((await h.rpc(SHARED, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect(h.output()).toContain('TABULA_MCP_TOKEN is ignored');
    expect(h.output()).toContain('TABULA_MCP_SCOPE is ignored');
    expect(h.output()).not.toContain(SHARED);
  });
});
