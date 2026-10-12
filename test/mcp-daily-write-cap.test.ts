import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createMcp } from '../server/mcp.mjs';
import { createMcpUsageStore, MCP_USAGE_MIGRATION } from '../server/mcp-usage.mjs';

const DAY = 24 * 60 * 60 * 1000;
const FENCE = /\[board-content nonce=([0-9a-f]+)\]\n([\s\S]*)\n\[\/board-content nonce=\1\]$/;
const fixtures: { close: () => void }[] = [];

function fixture({ cap = 2000, start = Date.UTC(2026, 9, 12, 12) } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(MCP_USAGE_MIGRATION);
  const get = (sql: string, ...params: (string | number)[]) => db.prepare(sql).get(...params) as Record<string, any> | undefined;
  const run = (sql: string, ...params: (string | number)[]) => Number(db.prepare(sql).run(...params).changes);
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const usage = createMcpUsageStore({ get, run, transaction });
  let time = start;
  let rpcId = 0;
  const user = { id: 'user-a', name: 'Test user', role: 'member' };
  const rooms = new Map<string, Y.Doc>([['board', new Y.Doc()], ['board~comments', new Y.Doc()]]);
  const tokens = new Map<string, string>();
  const oauthTokens = new Map<string, { tokenId: string; grantId: string }>();
  const directory = {
    ...usage,
    findAccessToken(token: string) {
      const id = tokens.get(token);
      return id ? { id, userId: user.id, name: id, scope: 'write', boardIds: null, user } : null;
    },
    findOauthAccessToken(token: string) {
      const found = oauthTokens.get(token);
      return found ? {
        ...found, userId: user.id, user, scope: 'write', boardIds: null, expiresAt: time + DAY,
        resource: 'https://mcp.test/mcp', clientName: 'Test connector',
      } : null;
    },
    touchAccessToken() {},
    touchGrant() {},
    getBoard(id: string) { return id === 'board' ? { id, title: 'Test board', deletedAt: null, updatedAt: time } : null; },
    boardRole(id: string) { return id === 'board' ? 'editor' : null; },
    getTemplateFor() { return null; },
    audit() {},
  };
  const server = createMcp({
    config: { mcp: { mode: 'accounts', oauth: true, issuer: 'https://mcp.test', dailyWrites: cap } },
    directory,
    cloud: null,
    canWriteRoom: () => true,
    roomAccess: {
      exists: (room: string) => rooms.has(room),
      read: (room: string, fn: (doc: Y.Doc) => unknown) => fn(rooms.get(room)!),
      write: (room: string, _origin: string, fn: (doc: Y.Doc) => unknown) => fn(rooms.get(room)!),
    },
    log: () => {},
    now: () => time,
  } as Parameters<typeof createMcp>[0] & { now: () => number });

  function addToken(id: string) {
    const token = `personal-${id}`;
    tokens.set(token, id);
    return token;
  }

  function addOauthToken(id: string, grantId: string) {
    const token = `tbo_${id}`;
    oauthTokens.set(token, { tokenId: id, grantId });
    return token;
  }

  function post(token: string, message: Record<string, unknown>) {
    const req = new EventEmitter() as EventEmitter & {
      method: string;
      headers: Record<string, string>;
      socket: { remoteAddress: string };
    };
    req.method = 'POST';
    req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    req.socket = { remoteAddress: '127.0.0.1' };
    const response = {
      status: 0,
      headers: new Map<string, string>(),
      body: undefined as Record<string, any> | undefined,
      headersSent: false,
      setHeader(name: string, value: string | number) { this.headers.set(name.toLowerCase(), String(value)); },
      writeHead(status: number, headers: Record<string, string | number> = {}) {
        this.status = status;
        for (const [name, value] of Object.entries(headers)) this.headers.set(name.toLowerCase(), String(value));
        this.headersSent = true;
      },
      end(body?: string | Buffer) { if (body !== undefined) this.body = JSON.parse(String(body)); },
    };
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(message)));
      req.emit('end');
    });
    return server.handle(req, response).then(() => response);
  }

  async function call(token: string, method: string, params?: Record<string, unknown>) {
    return post(token, { jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) });
  }

  async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
    const response = await call(token, 'tools/call', { name, arguments: args });
    const text = response.body?.result?.content?.[0]?.text ?? '';
    const fenced = FENCE.exec(text);
    return {
      status: response.status,
      error: response.body?.result?.isError ? JSON.parse(fenced ? fenced[2] : text).error as string : undefined,
      data: JSON.parse(fenced ? fenced[2] : text),
      text,
    };
  }

  const stateCount = () => rooms.get('board')!.getMap('objects').size;
  const close = () => {
    for (const room of rooms.values()) room.destroy();
    db.close();
  };
  const result = {
    addToken,
    addOauthToken,
    call,
    tool,
    stateCount,
    get day() { return new Date(time).toISOString().slice(0, 10); },
    setTime(value: number) { time = value; },
    writesToday(actor: { kind: 'token' | 'grant'; id: string }) { return usage.mcpWritesToday(actor, new Date(time).toISOString().slice(0, 10)); },
    close,
  };
  fixtures.push(result);
  return result;
}

afterEach(() => {
  for (const current of fixtures.splice(0)) current.close();
});

const sticky = (text: string) => ({ type: 'sticky', text, x: 0, y: 0 });

describe('MCP daily write cap', () => {
  it('counts items, reports the remaining budget, and refuses before changing the board', async () => {
    const f = fixture({ cap: 6 });
    const token = f.addToken('token-a');
    const created = await f.tool(token, 'create_objects', {
      boardId: 'board', objects: Array.from({ length: 5 }, (_, index) => sticky(`note ${index}`)),
    });
    expect(created.error).toBeUndefined();
    expect(created.data.created).toHaveLength(5);
    expect(f.writesToday({ kind: 'token', id: 'token-a' })).toBe(5);

    const before = f.stateCount();
    const refused = await f.tool(token, 'create_objects', { boardId: 'board', objects: [sticky('six'), sticky('seven')] });
    expect(refused.error).toBe('daily_limit');
    expect(refused.data.message).toBe('Daily write limit reached for this token: 1 writes left of 6. It resets at 00:00 UTC.');
    expect(f.stateCount()).toBe(before);
    expect((await f.tool(token, 'whoami')).data.dailyWrites).toEqual({
      used: 5, cap: 6, resetsAt: '2026-10-13T00:00:00.000Z',
    });
  });

  it('does not count a failed write', async () => {
    const f = fixture({ cap: 3 });
    const token = f.addToken('token-fail');
    const failed = await f.tool(token, 'create_objects', { boardId: 'board', objects: [{ type: 'unknown' }] });
    expect(failed.error).toBe('invalid_input');
    expect(f.stateCount()).toBe(0);
    expect((await f.tool(token, 'whoami')).data.dailyWrites.used).toBe(0);
  });

  it('isolates personal tokens and resets the count at the next UTC day', async () => {
    const f = fixture({ cap: 1, start: Date.UTC(2026, 9, 12, 23, 59, 59, 500) });
    const tokenA = f.addToken('token-a');
    const tokenB = f.addToken('token-b');
    expect((await f.tool(tokenA, 'create_objects', { boardId: 'board', objects: [sticky('a')] })).error).toBeUndefined();
    expect((await f.tool(tokenB, 'create_objects', { boardId: 'board', objects: [sticky('b')] })).error).toBeUndefined();
    expect(f.writesToday({ kind: 'token', id: 'token-a' })).toBe(1);
    expect(f.writesToday({ kind: 'token', id: 'token-b' })).toBe(1);

    f.setTime(Date.UTC(2026, 9, 13, 0, 0, 0));
    const nextDay = await f.tool(tokenA, 'create_objects', { boardId: 'board', objects: [sticky('new day')] });
    expect(nextDay.error).toBeUndefined();
    expect((await f.tool(tokenA, 'whoami')).data.dailyWrites).toEqual({
      used: 1, cap: 1, resetsAt: '2026-10-14T00:00:00.000Z',
    });
  });

  it('uses an OAuth grant as the actor for counts and request retries', async () => {
    const f = fixture({ cap: 5 });
    const firstGrantToken = f.addOauthToken('oauth-a', 'grant-a');
    const secondGrantToken = f.addOauthToken('oauth-b', 'grant-a');
    const created = await f.tool(firstGrantToken, 'create_objects', {
      boardId: 'board', clientRequestId: 'oauth_req_123', objects: [sticky('oauth write')],
    });
    expect(created.error).toBeUndefined();
    expect(f.writesToday({ kind: 'grant', id: 'grant-a' })).toBe(1);
    const replay = await f.tool(secondGrantToken, 'create_objects', {
      boardId: 'board', clientRequestId: 'oauth_req_123', objects: [sticky('oauth write')],
    });
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.created).toEqual(created.data.created);
    expect(f.stateCount()).toBe(1);
    expect((await f.tool(secondGrantToken, 'whoami')).data.dailyWrites.used).toBe(1);
  });
});

describe('MCP clientRequestId retries', () => {
  it('replays the original ids without creating objects or counting the write twice', async () => {
    const f = fixture();
    const token = f.addToken('retry-token');
    const args = { boardId: 'board', clientRequestId: 'create_12345', objects: [sticky('once')] };
    const first = await f.tool(token, 'create_objects', args);
    const before = f.stateCount();
    const replay = await f.tool(token, 'create_objects', args);

    expect(first.error).toBeUndefined();
    expect(replay.error).toBeUndefined();
    expect(replay.data.created).toEqual(first.data.created);
    expect(replay.data.replayed).toBe(true);
    expect(f.stateCount()).toBe(before);
    expect((await f.tool(token, 'whoami')).data.dailyWrites.used).toBe(1);
  });

  it('conflicts when the same id is used with different arguments', async () => {
    const f = fixture();
    const token = f.addToken('conflict-token');
    const original = { boardId: 'board', clientRequestId: 'conflict_123', objects: [sticky('first')] };
    await f.tool(token, 'create_objects', original);
    const before = f.stateCount();
    const conflict = await f.tool(token, 'create_objects', { ...original, objects: [sticky('different')] });

    expect(conflict.error).toBe('request_id_reused');
    expect(conflict.data.message).toBe('That clientRequestId was already used with different arguments.');
    expect(f.stateCount()).toBe(before);
  });

  it('does not save failed calls, so a corrected call can reuse the id', async () => {
    const f = fixture();
    const token = f.addToken('failed-retry-token');
    const requestId = 'fixed_12345';
    const failed = await f.tool(token, 'create_objects', { boardId: 'board', clientRequestId: requestId, objects: [{ type: 'unknown' }] });
    expect(failed.error).toBe('invalid_input');
    const corrected = await f.tool(token, 'create_objects', { boardId: 'board', clientRequestId: requestId, objects: [sticky('corrected')] });

    expect(corrected.error).toBeUndefined();
    expect(corrected.data.replayed).toBeUndefined();
    expect(corrected.data.created).toHaveLength(1);
    expect(f.stateCount()).toBe(1);
    expect((await f.tool(token, 'whoami')).data.dailyWrites.used).toBe(1);
  });

  it('does not save results larger than 64 KiB', async () => {
    const f = fixture();
    const token = f.addToken('large-result-token');
    const kanban = await f.tool(token, 'create_kanban', { boardId: 'board', name: 'Large result' });
    expect(kanban.error).toBeUndefined();
    const laneId = kanban.data.lanes[0].id as string;
    const cards = Array.from({ length: 18 }, (_, index) => ({
      laneId, title: `Large card ${index}`, description: 'x'.repeat(4000),
    }));
    const args = { boardId: 'board', kanbanId: kanban.data.kanban.id as string, cards, clientRequestId: 'large_result_123' };
    const first = await f.tool(token, 'add_kanban_cards', args);
    expect(first.error).toBeUndefined();
    expect(Buffer.byteLength(first.text, 'utf8')).toBeGreaterThan(64 * 1024);
    const before = f.stateCount();
    const second = await f.tool(token, 'add_kanban_cards', args);

    expect(second.error).toBeUndefined();
    expect(second.data.replayed).toBeUndefined();
    expect(second.data.cards).toHaveLength(18);
    expect(f.stateCount()).toBe(before + 18);
  });

  it('expires saved requests after 24 hours', async () => {
    const f = fixture();
    const token = f.addToken('expiry-token');
    const args = { boardId: 'board', clientRequestId: 'expires_123', objects: [sticky('again')] };
    const first = await f.tool(token, 'create_objects', args);
    f.setTime(Date.UTC(2026, 9, 13, 12) + 1);
    const second = await f.tool(token, 'create_objects', args);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.data.replayed).toBeUndefined();
    expect(second.data.created[0].id).not.toBe(first.data.created[0].id);
    expect(f.stateCount()).toBe(2);
  });

  it('publishes the optional request id on every supported tool', async () => {
    const f = fixture();
    const token = f.addToken('schema-token');
    const listed = await f.call(token, 'tools/list');
    const supported = new Set(['create_objects', 'add_kanban_card', 'add_kanban_cards', 'create_kanban', 'use_template', 'add_comment', 'reply_to_comment']);
    const tools = listed.body!.result.tools.filter((tool: { name: string }) => supported.has(tool.name));
    expect(tools).toHaveLength(supported.size);
    for (const tool of tools) {
      expect(tool.inputSchema.properties.clientRequestId).toMatchObject({ minLength: 8, maxLength: 64 });
    }
  });
});
