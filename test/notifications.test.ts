import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../server/directory.mjs';
import { openChat } from '../server/chat.mjs';
import { createNotifications, mergeNotificationRows } from '../server/notifications.mjs';
import { createNotificationRoutes } from '../server/notifications-routes.mjs';
import { migrate } from '../server/schema.mjs';
import { REMOVE_TRACKER_MIGRATION } from './tracker-rewind';

const directories: any[] = [];
const chats: ReturnType<typeof openChat>[] = [];
const roots: string[] = [];
const open = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (team_id, user_id));
    CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT, team_id TEXT, deleted_at INTEGER);
    CREATE TABLE board_shares (board_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (board_id, principal_type, principal_id));
    CREATE TABLE user_notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, ref TEXT, created_at INTEGER NOT NULL, read_at INTEGER
    );
    CREATE INDEX user_notifications_inbox ON user_notifications(user_id, read_at, created_at DESC, id);
    CREATE TABLE user_prefs (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
    CREATE TABLE ticket_states (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL);
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, title TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
      due_date TEXT, archived_at INTEGER, state_id TEXT NOT NULL, assignee_user_id TEXT
    );
    CREATE TABLE ticket_events (id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, actor_type TEXT, actor_id TEXT, after_json TEXT, details_json TEXT);
    CREATE TABLE ticket_comments (id TEXT PRIMARY KEY, body TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticket_id TEXT NOT NULL, event_id INTEGER, kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER, next_email_at INTEGER, suppressed_at INTEGER
    );
    CREATE TABLE ticket_links (ticket_id TEXT NOT NULL, board_id TEXT NOT NULL, removed_at INTEGER);
  `);
  const directory: any = {
    db,
    close: () => db.close(),
    createUser({ email, name, role }: { email: string; name: string; role: string }) {
      const id = email.split('@')[0];
      db.prepare('INSERT INTO users (id,email,name,role) VALUES (?,?,?,?)').run(id, email, name, role);
      return this.getUser(id);
    },
    getUser(id: string) {
      const row = db.prepare('SELECT id,email,name,role,disabled FROM users WHERE id = ?').get(id);
      return row ? { ...row, disabled: Boolean(row.disabled) } : null;
    },
    createBoard({ id, title, ownerId, teamId }: { id: string; title: string; ownerId: string; teamId: string | null }) {
      db.prepare('INSERT INTO boards (id,title,owner_id,team_id) VALUES (?,?,?,?)').run(id, title, ownerId, teamId);
      return this.getBoard(id);
    },
    getBoard(id: string) {
      const row = db.prepare('SELECT id,title,owner_id,team_id,deleted_at FROM boards WHERE id = ?').get(id);
      return row ? { id: row.id, title: row.title, ownerId: row.owner_id, teamId: row.team_id, deletedAt: row.deleted_at } : null;
    },
    getTeam(id: string) {
      const row = db.prepare('SELECT id,name,archived FROM teams WHERE id = ?').get(id);
      return row ? { id: row.id, name: row.name, archived: Boolean(row.archived) } : null;
    },
    getTeamRole(teamId: string, userId: string) {
      return db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId)?.role ?? null;
    },
    boardRole(boardId: string, userId: string) {
      const user = this.getUser(userId);
      const board = this.getBoard(boardId);
      if (!user || user.disabled || !board) return null;
      if (user.role === 'owner' || user.role === 'admin') return 'owner';
      if (board.deletedAt != null) return null;
      if (board.ownerId === userId) return 'owner';
      const share = db.prepare('SELECT role FROM board_shares WHERE board_id = ? AND principal_type = \'user\' AND principal_id = ?').get(boardId, userId);
      return share?.role ?? null;
    },
    shareBoard(boardId: string, { principalType, principalId, role }: { principalType: string; principalId: string; role: string }) {
      db.prepare('INSERT INTO board_shares (board_id,principal_type,principal_id,role) VALUES (?,?,?,?)').run(boardId, principalType, principalId, role);
    },
    unshareBoard(boardId: string, principalType: string, principalId: string) {
      db.prepare('DELETE FROM board_shares WHERE board_id = ? AND principal_type = ? AND principal_id = ?').run(boardId, principalType, principalId);
    },
    getPref(userId: string, key: string) {
      return db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(userId, key)?.value ?? null;
    },
    setPref(userId: string, key: string, value: string) {
      db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, String(value));
    },
  };
  directories.push(directory);
  return directory;
};
const chatDb = () => {
  const chat = openChat(':memory:');
  chats.push(chat);
  return chat;
};

function people(directory: any) {
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const member = directory.createUser({ email: 'member@example.com', name: 'Member', role: 'member' });
  const board = directory.createBoard({ id: 'board_one', title: 'Project board', ownerId: owner.id, teamId: null });
  return { owner, member, board };
}

function ticket(directory: any, { id = 'ticket_1', key = 'TAB-1', title = 'Inbox ticket' } = {}) {
  directory.db.prepare("INSERT OR IGNORE INTO ticket_states (id,name,category) VALUES ('state_todo','To do','unstarted')").run();
  directory.db.prepare(
    "INSERT INTO tickets (id,key,title,priority,state_id) VALUES (?,?,?,'normal','state_todo')",
  ).run(id, key, title);
  return { id, key, title };
}

afterEach(() => {
  for (const chat of chats.splice(0)) chat.close();
  for (const directory of directories.splice(0)) directory.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('per-user notifications', () => {
  it('hides a board notification and excludes it from counts after access is removed', () => {
    const directory = open();
    const { owner, member, board } = people(directory);
    directory.shareBoard(board.id, { principalType: 'user', principalId: member.id, role: 'viewer' });
    const notifications = createNotifications({ directory });
    notifications.record({ userId: member.id, kind: 'board_shared', actorId: owner.id, boardId: board.id });
    expect(notifications.list({ user: member })).toMatchObject({ unread: 1, items: [{ kind: 'board_shared', board: { id: board.id, title: board.title } }] });

    directory.unshareBoard(board.id, 'user', member.id);
    expect(notifications.list({ user: member })).toMatchObject({ unread: 0, unreadMentions: 0, items: [], nextCursor: null });
    expect(notifications.unread(member)).toEqual({ unread: 0, unreadMentions: 0 });
  });

  it('hides tracker rows and excludes them from counts after linked-board access is removed', () => {
    const directory = open();
    const { owner, board } = people(directory);
    const guest = directory.createUser({ email: 'guest@example.com', name: 'Guest', role: 'guest' })!;
    directory.shareBoard(board.id, { principalType: 'user', principalId: guest.id, role: 'viewer' });
    const ticketRecord = ticket(directory, { id: 'ticket_linked', key: 'TAB-3', title: 'Linked ticket' });
    directory.db.prepare('INSERT INTO ticket_links (ticket_id, board_id, removed_at) VALUES (?, ?, NULL)').run(ticketRecord.id, board.id);
    const notifications = createNotifications({ directory, trackerEnabled: true });
    notifications.record({ userId: guest.id, kind: 'board_shared', actorId: owner.id, boardId: board.id, createdAt: 9 }, { notify: false });
    directory.db.prepare(
      `INSERT INTO notifications (id, user_id, ticket_id, kind, dedupe_key, created_at)
       VALUES ('linked-ticket-row', ?, ?, 'assigned', 'linked-ticket-dedupe', 10)`,
    ).run(guest.id, ticketRecord.id);

    expect(notifications.list({ user: guest })).toMatchObject({ unread: 2, items: [{ kind: 'ticket_assigned' }, { kind: 'board_shared' }] });
    directory.unshareBoard(board.id, 'user', guest.id);
    expect(notifications.list({ user: guest })).toMatchObject({ unread: 0, unreadMentions: 0, items: [], nextCursor: null });
  });

  it('pages one merged list of personal and tracker rows by a shared keyset cursor', () => {
    const directory = open();
    const { owner, member, board } = people(directory);
    directory.shareBoard(board.id, { principalType: 'user', principalId: member.id, role: 'viewer' });
    const ticketRecord = ticket(directory);
    const notifications = createNotifications({ directory, trackerEnabled: true });
    const first = notifications.record({ userId: member.id, kind: 'board_shared', actorId: owner.id, boardId: board.id, createdAt: 100 }, { notify: false });
    const latest = notifications.record({ userId: member.id, kind: 'board_shared', actorId: owner.id, boardId: board.id, createdAt: 102 }, { notify: false });
    directory.db.prepare(
      `INSERT INTO notifications (id, user_id, ticket_id, kind, dedupe_key, created_at)
       VALUES ('tracker-row', ?, ?, 'assigned', 'tracker-dedupe', 101)`,
    ).run(member.id, ticketRecord.id);

    const page1 = notifications.list({ user: member, limit: 2 });
    expect(page1.items.map((item: any) => item.id)).toEqual([`n_${latest!.id}`, 't_tracker-row']);
    expect(page1.items.map((item: any) => item.at)).toEqual([102, 101]);
    expect(page1.items[1]).toMatchObject({ id: 't_tracker-row', kind: 'ticket_assigned', target: `/t/${ticketRecord.key}`, read: false });
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = notifications.list({ user: member, limit: 2, before: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]).toMatchObject({ id: `n_${first!.id}`, kind: 'board_shared', at: 100 });
    expect(page2.nextCursor).toBeNull();
    expect(page2.unread).toBe(3);
  });

  it('resolves a chat snippet at list time and syncs read state from the channel cursor', () => {
    const directory = open();
    const { owner, member, board } = people(directory);
    directory.shareBoard(board.id, { principalType: 'user', principalId: member.id, role: 'viewer' });
    const chat = chatDb();
    const inserted = chat.insertMessage({
      kind: 'board', ref: board.id, authorId: owner.id, authorName: owner.name,
      body: `Hello @{${member.id}}`, clientId: 'notification-message', mentions: [member.id], now: 250,
    });
    const notifications = createNotifications({
      directory,
      chatStore: chat,
      chatAccess: (user: any, kind: string, ref: string) => (kind === 'board' && directory.boardRole(ref, user.id) ? { read: true } : null),
      now: () => 300,
    });
    const saved = notifications.record({ userId: member.id, kind: 'chat_mention', actorId: owner.id, boardId: board.id, ref: String(inserted.message.id), createdAt: 260 });
    const page = notifications.list({ user: member });
    expect(page.items[0]).toMatchObject({
      id: `n_${saved!.id}`,
      kind: 'chat_mention',
      at: 260,
      actor: { id: owner.id, name: owner.name },
      board: { id: board.id, title: board.title },
      snippet: 'Hello @Member',
      target: `#/chat/board/${board.id}`,
    });
    expect(page.unreadMentions).toBe(1);

    expect(notifications.markChatReadThrough(member.id, 'board', board.id, inserted.message.id).updated).toBe(1);
    expect(notifications.list({ user: member }).items[0].read).toBe(true);
    expect(notifications.unread(member)).toEqual({ unread: 0, unreadMentions: 0 });
  });

  it('marks selected rows or all rows read in both ledgers without changing another user', () => {
    const directory = open();
    const { owner, member, board } = people(directory);
    directory.shareBoard(board.id, { principalType: 'user', principalId: member.id, role: 'viewer' });
    const other = directory.createUser({ email: 'other@example.com', name: 'Other', role: 'member' })!;
    const ticketRecord = ticket(directory, { id: 'ticket_read', key: 'TAB-2', title: 'Ticket' });
    const notifications = createNotifications({ directory, trackerEnabled: true, now: () => 500 });
    const own = notifications.record({ userId: member.id, kind: 'board_shared', actorId: owner.id, boardId: board.id }, { notify: false });
    const otherRow = notifications.record({ userId: other.id, kind: 'board_shared', actorId: owner.id, boardId: board.id }, { notify: false });
    directory.db.prepare(
      `INSERT INTO notifications (id, user_id, ticket_id, kind, dedupe_key, created_at, next_email_at)
       VALUES ('tracker-read', ?, ?, 'assigned', 'tracker-read-dedupe', 10, 20)`,
    ).run(member.id, ticketRecord.id);

    expect(notifications.markRead({ user: member, ids: [`n_${own!.id}`, 't_tracker-read'] })).toMatchObject({ updated: 2, unread: 0 });
    expect(directory.db.prepare('SELECT read_at FROM user_notifications WHERE id = ?').get(own!.id).read_at).toBe(500);
    expect(directory.db.prepare("SELECT read_at, next_email_at FROM notifications WHERE id = 'tracker-read'").get()).toEqual({ read_at: 500, next_email_at: null });
    expect(directory.db.prepare('SELECT read_at FROM user_notifications WHERE id = ?').get(otherRow!.id).read_at).toBeNull();

    const allRow = notifications.record({ userId: member.id, kind: 'board_shared', actorId: owner.id, boardId: board.id }, { notify: false });
    directory.db.prepare(
      `INSERT INTO notifications (id, user_id, ticket_id, kind, dedupe_key, created_at)
       VALUES ('tracker-all', ?, ?, 'assigned', 'tracker-all-dedupe', 11)`,
    ).run(member.id, ticketRecord.id);
    expect(notifications.markRead({ user: member, all: true })).toMatchObject({ updated: 2, unread: 0 });
    expect(directory.db.prepare('SELECT read_at FROM user_notifications WHERE id = ?').get(allRow!.id).read_at).toBe(500);
    expect(directory.db.prepare("SELECT read_at FROM notifications WHERE id = 'tracker-all'").get().read_at).toBe(500);
  });

  it('counts only the newest 200 accessible unread rows', () => {
    const directory = open();
    const { owner, member, board } = people(directory);
    directory.shareBoard(board.id, { principalType: 'user', principalId: member.id, role: 'viewer' });
    const notifications = createNotifications({ directory });
    for (let i = 0; i < 205; i++) {
      notifications.record({ userId: member.id, kind: 'board_shared', actorId: owner.id, boardId: board.id, createdAt: i + 1 }, { notify: false });
    }
    expect(notifications.unread(member)).toEqual({ unread: 200, unreadMentions: 0 });
  });

  it('prunes both ledgers after 90 days and keeps unread rows ahead of read rows within the combined 500-row cap', () => {
    const directory = open();
    const { owner, member } = people(directory);
    const at = 10_000_000_000;
    const notifications = createNotifications({ directory, now: () => at });
    const insert = directory.db.prepare(
      `INSERT INTO user_notifications (id, user_id, kind, actor_id, ref, created_at, read_at)
       VALUES (?, ?, 'board_shared', ?, NULL, ?, ?)`,
    );
    insert.run('stale', member.id, owner.id, at - 90 * 24 * 60 * 60 * 1000 - 1, 1);
    insert.run('old-unread', member.id, owner.id, at - 1000, null);
    for (let i = 0; i < 501; i++) insert.run(`read-${String(i).padStart(3, '0')}`, member.id, owner.id, at - 500 + i, 1);
    directory.db.prepare(
      `INSERT INTO notifications (id, user_id, ticket_id, kind, dedupe_key, created_at, read_at)
       VALUES ('tracker-stale', ?, 'unused-ticket', 'assigned', 'tracker-stale', ?, 1),
              ('tracker-read-1', ?, 'unused-ticket', 'assigned', 'tracker-read-1', ?, 1),
              ('tracker-read-2', ?, 'unused-ticket', 'assigned', 'tracker-read-2', ?, 1)`,
    ).run(member.id, at - 90 * 24 * 60 * 60 * 1000 - 1, member.id, at + 2, member.id, at + 1);

    expect(notifications.prune(at)).toEqual({ old: 2, overflow: 4, deleted: 6 });
    const personalCount = Number(directory.db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ?').get(member.id).n);
    const trackerCount = Number(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(member.id).n);
    expect(personalCount + trackerCount).toBe(500);
    expect(directory.db.prepare("SELECT 1 FROM user_notifications WHERE id = 'old-unread'").get()).toBeDefined();
    expect(directory.db.prepare("SELECT 1 FROM user_notifications WHERE id = 'read-000'").get()).toBeUndefined();
    expect(directory.db.prepare("SELECT 1 FROM user_notifications WHERE id = 'read-003'").get()).toBeUndefined();
    expect(directory.db.prepare("SELECT 1 FROM notifications WHERE id = 'tracker-read-1'").get()).toBeDefined();
    expect(directory.db.prepare("SELECT 1 FROM notifications WHERE id = 'tracker-stale'").get()).toBeUndefined();
    expect(directory.db.prepare("SELECT 1 FROM user_notifications WHERE id = 'stale'").get()).toBeUndefined();
  });

  it('stores only ids, kind and timestamps, never caller-supplied text', () => {
    const directory = open();
    const { owner, member, board } = people(directory);
    const notifications = createNotifications({ directory });
    const result = notifications.record({
      userId: member.id, kind: 'board_shared', actorId: owner.id, boardId: board.id,
      snippet: 'private notification canary', body: 'private notification canary',
    } as any, { notify: false });
    const row = directory.db.prepare('SELECT * FROM user_notifications WHERE id = ?').get(result!.id);
    const columns = directory.db.prepare('PRAGMA table_info(user_notifications)').all().map((column: any) => column.name);
    expect(columns).toEqual(['id', 'user_id', 'kind', 'actor_id', 'board_id', 'team_id', 'ref', 'created_at', 'read_at']);
    expect(JSON.stringify(row)).not.toContain('private notification canary');
  });

  it('upgrades migrations 18 and 19 and recreates them when rewound to schema 17', () => {
    const root = fs.mkdtempSync(fileURLToPath(new URL('./notifications-migration-', import.meta.url)));
    roots.push(root);
    const file = path.join(root, 'directory.sqlite');
    // this test is about migrations 18 and 19 on a minimal file; later migrations (20 alters an OAuth table this file lacks) are not part of it
    const upTo19 = MIGRATIONS.slice(0, 19);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(19);
    expect(MIGRATIONS[17]).toMatchObject({ minReader: 11 });
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE teams (id TEXT PRIMARY KEY);
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key,value) VALUES ('min_reader','11');
      PRAGMA user_version = 17;
    `);
    migrate(raw, upTo19, 'directory');
    expect(raw.prepare('PRAGMA user_version').get()!.user_version).toBe(19);
    expect(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'user_notifications_inbox'").get()!.sql)
      .toContain('(user_id, read_at, created_at DESC, id)');
    expect(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'card_due_due'").get()!.sql).toContain('(due)');
    raw.exec('DROP TABLE card_due; DROP TABLE user_notifications; PRAGMA user_version = 17;');
    migrate(raw, upTo19, 'directory');
    expect(raw.prepare('PRAGMA user_version').get()!.user_version).toBe(19);
    expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_notifications'").get()).toBeDefined();
    expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_due'").get()).toBeDefined();
    raw.close();
    expect(REMOVE_TRACKER_MIGRATION).toContain('DROP TABLE IF EXISTS user_notifications');
  });

  it('merges pure rows newest first and exposes the API routes with their response shapes', async () => {
    expect(mergeNotificationRows([{ id: 'n_1', at: 1 }, { id: 'n_3', at: 3 }], [{ id: 't_2', at: 2 }], 2).map((row) => row.id))
      .toEqual(['n_3', 't_2']);
    const notifications = {
      list: () => ({ items: [], nextCursor: null, unread: 2, unreadMentions: 1 }),
      unread: () => ({ unread: 2, unreadMentions: 1 }),
      markRead: ({ all }: { all: boolean }) => ({ updated: all ? 2 : 1, unread: 0, unreadMentions: 0 }),
    };
    const compile = (method: string, path: string, options: unknown, handler: Function) => ({ method, path, options, handler });
    const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });
    const routes = createNotificationRoutes({ notifications, compile, errors: { badRequest } }) as any[];
    const byPath = (path: string) => routes.find((route) => route.path === path);
    expect(await byPath('notifications').handler({ user: { id: 'u1' }, query: new URLSearchParams() }))
      .toEqual([200, { items: [], nextCursor: null, unread: 2, unreadMentions: 1 }]);
    expect(await byPath('notifications/unread').handler({ user: { id: 'u1' } })).toEqual([200, { unread: 2, unreadMentions: 1 }]);
    expect(await byPath('notifications/read').handler({ user: { id: 'u1' }, body: { all: true } }))
      .toEqual([200, { updated: 2, unread: 0, unreadMentions: 0 }]);
    expect(byPath('notifications/read').options).toMatchObject({ body: true, maxBody: 8 * 1024, readOnlyOk: true });
    await expect(Promise.resolve().then(() => byPath('notifications/read').handler({ user: { id: 'u1' }, body: { ids: Array.from({ length: 101 }, (_, i) => `n_${i}`) } })))
      .rejects.toThrow('up to 100 notification ids');
    await expect(Promise.resolve().then(() => byPath('notifications/read').handler({ user: { id: 'u1' }, body: null })))
      .rejects.toThrow('Body must be an object');
  });
});
