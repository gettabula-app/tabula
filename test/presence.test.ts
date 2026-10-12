import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPresenceRegistry, presenceFor } from '../server/presence.mjs';
import { createChatHub } from '../server/chat-hub.mjs';

type Connection = { userId: string; name: string; guest?: boolean; colour?: string | null; joinedAt: number; [key: string]: unknown };

const person = (userId: string, joinedAt: number, extra: Partial<Connection> = {}): Connection => ({
  userId,
  name: userId,
  joinedAt,
  colour: null,
  ...extra,
});

describe('board presence summaries', () => {
  it('deduplicates tabs, counts all others, orders by first join and caps the visible people at eight', () => {
    const connections = [
      person('viewer', 3),
      person('viewer', 1),
      person('other-0', 10),
      person('other-0', 4),
      ...Array.from({ length: 8 }, (_, index) => person(`other-${index + 1}`, 20 + index)),
    ];

    expect(presenceFor(connections, 'viewer', 100)).toMatchObject({
      count: 9,
      me: true,
      people: [
        { userId: 'other-0', joinedAt: 4 },
        { userId: 'other-1', joinedAt: 20 },
        { userId: 'other-2', joinedAt: 21 },
        { userId: 'other-3', joinedAt: 22 },
        { userId: 'other-4', joinedAt: 23 },
        { userId: 'other-5', joinedAt: 24 },
        { userId: 'other-6', joinedAt: 25 },
        { userId: 'other-7', joinedAt: 26 },
      ],
    });
  });

  it('keeps guests distinct and marks only guest entries', () => {
    const summary = presenceFor([
      person('viewer', 1),
      person('guest-1', 2, { guest: true }),
      person('guest-1', 4, { guest: true }),
      person('guest-2', 3, { guest: true }),
    ], 'viewer');

    expect(summary.count).toBe(2);
    expect(summary.people).toEqual([
      { userId: 'guest-1', name: 'guest-1', colour: null, joinedAt: 2, guest: true },
      { userId: 'guest-2', name: 'guest-2', colour: null, joinedAt: 3, guest: true },
    ]);
  });

  it('uses only validated awareness colours and omits cursor and selection data', () => {
    const summary = presenceFor([
      person('invalid', 1, { colour: 'red', cursor: { x: 5 }, selection: ['private-object'] }),
      person('valid', 2, { colour: '#aBc123', cursor: { x: 9 }, selection: ['another-object'] }),
    ], 'viewer');

    expect(summary.people).toEqual([
      { userId: 'invalid', name: 'invalid', colour: null, joinedAt: 1 },
      { userId: 'valid', name: 'valid', colour: '#aBc123', joinedAt: 2 },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/cursor|selection|private-object/);
  });

  it('caps recent live rooms and filters unreadable or newly inaccessible boards', () => {
    const registry = createPresenceRegistry({ maxRooms: 2 });
    registry.update('old', [person('other-old', 1)], 1);
    registry.update('middle', [person('other-middle', 2)], 2);
    registry.update('new', [person('other-new', 3)], 3);
    registry.update('empty', [], 4);
    const canRead = new Set(['middle', 'new']);

    expect(registry.snapshot(['old', 'middle', 'new', 'empty'], 'viewer', (id) => canRead.has(id), 10).map((row) => row.boardId))
      .toEqual(['new', 'middle']);
    canRead.delete('middle'); // a lost share is omitted on the next snapshot
    expect(registry.snapshot(['old', 'middle', 'new', 'empty'], 'viewer', (id) => canRead.has(id), 11).map((row) => row.boardId))
      .toEqual(['new']);
    expect(registry.has('empty')).toBe(false);
  });

  it('reports identity changes but ignores awareness-only cursor changes', () => {
    const registry = createPresenceRegistry();
    const connection = person('other', 1, { cursor: { x: 1 } });
    expect(registry.update('board-1', [connection], 1)).toBe(true);
    expect(registry.update('board-1', [{ ...connection, cursor: { x: 2 }, selection: ['shape'] }], 2)).toBe(false);
    expect(registry.update('board-1', [{ ...connection, colour: '#123456' }], 3)).toBe(true);
    expect(registry.update('board-1', [], 4)).toBe(true);
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: Record<string, any>[] = [];
  closed = false;

  send(data: string, callback?: (error?: Error) => void) {
    this.frames.push(JSON.parse(data));
    callback?.();
  }

  close() { this.closed = true; this.readyState = 3; }
  terminate() { this.closed = true; this.readyState = 3; }
  ping() {}
}

describe('presence over the chat hub', () => {
  it('sends snapshots and changed room projections only to readable-board watchers', () => {
    const events = new EventEmitter();
    const registry = createPresenceRegistry();
    const readable = new Set(['board-1']);
    const viewer = { id: 'viewer', disabled: false, name: 'Viewer' };
    const session = { user: viewer, sessionId: 'session-1', expiresAt: Date.now() + 60_000 };
    const hub = createChatHub({
      auth: { authenticate: () => session },
      directory: { getUser: () => viewer },
      access: () => null,
      summary: () => [],
      presenceBoardIds: () => [...readable],
      presenceCanRead: (_user: typeof viewer, boardId: string) => readable.has(boardId),
      presenceForUser: (_user: typeof viewer, boardIds: Set<string>) => registry.snapshot(boardIds, viewer.id, (id) => readable.has(id)),
      presenceForBoard: (_user: typeof viewer, boardId: string) => registry.forBoard(boardId, viewer.id),
      presenceActivity: (boardId: string) => registry.activity(boardId),
      channelUnread: () => ({ unread: 0, mentions: 0 }),
      events,
      timers: false,
    });
    const socket = new FakeSocket();
    hub.connect(socket, { headers: { cookie: 'session' } } as any);
    // nothing is sent until the Boards page asks
    expect(socket.frames.map((frame) => frame.t)).toEqual(['hello']);
    socket.emit('message', Buffer.from(JSON.stringify({ t: 'presence.watch' })), false);
    expect(socket.frames.at(-1)).toEqual({ t: 'presence.snapshot', boards: [] });

    registry.update('board-1', [person('viewer', 1)], 1);
    hub.publishPresence('board-1');
    const beforeDuplicateTab = socket.frames.filter((frame) => frame.t === 'presence.update').length;
    registry.update('board-1', [person('viewer', 1), person('viewer', 2)], 2);
    hub.publishPresence('board-1');
    expect(socket.frames.filter((frame) => frame.t === 'presence.update')).toHaveLength(beforeDuplicateTab);
    expect(socket.frames.at(-1)).toEqual({
      t: 'presence.update',
      board: { boardId: 'board-1', count: 0, people: [], me: true },
    });

    const beforeCursor = socket.frames.length;
    registry.update('board-1', [person('viewer', 1, { cursor: { x: 1 } }), person('viewer', 2)], 3);
    hub.publishPresence('board-1');
    expect(socket.frames).toHaveLength(beforeCursor);

    registry.update('board-1', [person('viewer', 1), person('viewer', 2), person('other', 3)], 4);
    hub.publishPresence('board-1');
    expect(socket.frames.at(-1)).toMatchObject({ t: 'presence.update', board: { boardId: 'board-1', count: 1 } });
    registry.update('board-1', [], 5);
    hub.publishPresence('board-1');
    expect(socket.frames.at(-1)).toEqual({ t: 'presence.clear', boardId: 'board-1' });
    registry.update('board-1', [person('other', 6)], 6);
    hub.publishPresence('board-1');
    expect(socket.frames.at(-1)).toMatchObject({ t: 'presence.update', board: { boardId: 'board-1', count: 1 } });

    readable.delete('board-1'); // access-change sends a replacement snapshot without the lost share
    events.emit('access-changed', { userId: 'viewer', boardId: 'board-1' });
    expect(socket.frames.at(-1)).toEqual({ t: 'presence.snapshot', boards: [] });
    expect(socket.frames.some((frame) => frame.t === 'presence.update' && frame.board?.boardId === 'inaccessible')).toBe(false);

    socket.emit('message', JSON.stringify({ t: 'presence.unwatch' }), false);
    expect(socket.frames.at(-1)).toEqual({ t: 'presence.snapshot', boards: [] });
    const afterUnwatch = socket.frames.length;
    registry.update('board-1', [person('other', 5)], 5);
    hub.publishPresence('board-1');
    expect(socket.frames).toHaveLength(afterUnwatch);

    socket.emit('message', JSON.stringify({ t: 'presence.watch' }), false);
    expect(socket.frames.at(-1)).toEqual({ t: 'presence.snapshot', boards: [] });
    hub.stop();
  });
});
