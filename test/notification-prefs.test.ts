import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createNotificationPrefs, GROUPS, groupOf, NotificationPrefsInputError, parseNotificationPrefsPatch } from '../server/notification-prefs.mjs';
import { createNotifications } from '../server/notifications.mjs';
import { createNotificationRoutes } from '../server/notifications-routes.mjs';

// TAB-164 slice 3: the four per-member switches of the notification bell (docs/notifications.md, Settings). The pure module, the
// routes, enforcement in notifications.record(), and what a switch does not change (rows already there, tracker rows).

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** An in-memory directory with the tables the notification code reads, including user_prefs for the switches. */
function open() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (team_id, user_id));
    CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT, team_id TEXT, deleted_at INTEGER);
    CREATE TABLE board_shares (board_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (board_id, principal_type, principal_id));
    CREATE TABLE user_prefs (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
    CREATE TABLE user_notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, ref TEXT, created_at INTEGER NOT NULL, read_at INTEGER
    );
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
    createUser({ email, name, role = 'member' }: { email: string; name: string; role?: string }) {
      const id = email.split('@')[0];
      db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id, email, name, role);
      return this.getUser(id);
    },
    getUser(id: string) {
      const row = db.prepare('SELECT id, email, name, role, disabled FROM users WHERE id = ?').get(id);
      return row ? { ...row, disabled: Boolean(row.disabled) } : null;
    },
    createBoard({ id, title, ownerId }: { id: string; title: string; ownerId: string }) {
      db.prepare('INSERT INTO boards (id, title, owner_id, team_id) VALUES (?, ?, ?, NULL)').run(id, title, ownerId);
      return this.getBoard(id);
    },
    getBoard(id: string) {
      const row = db.prepare('SELECT id, title, owner_id, deleted_at FROM boards WHERE id = ?').get(id);
      return row ? { id: row.id, title: row.title, ownerId: row.owner_id, deletedAt: row.deleted_at } : null;
    },
    getTeam(id: string) {
      const row = db.prepare('SELECT id, name, archived FROM teams WHERE id = ?').get(id);
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
      const share = db.prepare("SELECT role FROM board_shares WHERE board_id = ? AND principal_type = 'user' AND principal_id = ?").get(boardId, userId);
      return share?.role ?? null;
    },
    shareBoard(boardId: string, principalId: string, role: string) {
      db.prepare("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES (?, 'user', ?, ?)").run(boardId, principalId, role);
    },
    getPref(userId: string, key: string) {
      return db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(userId, key)?.value ?? null;
    },
    setPref(userId: string, key: string, value: string) {
      if (!this.getUser(userId)) throw new Error('user not found');
      db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, String(value));
    },
  };
  return directory;
}

/** Owner, a member, a board the member can see, and a switches module and notifications store over the directory. */
function setup() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const member = directory.createUser({ email: 'member@example.com', name: 'Member' });
  const board = directory.createBoard({ id: 'board_one', title: 'Project board', ownerId: owner.id });
  directory.shareBoard(board.id, member.id, 'viewer');
  const prefs = createNotificationPrefs({ directory });
  const notifications = createNotifications({ directory, prefs, now: () => 1_000 });
  const rows = () => directory.db.prepare('SELECT kind FROM user_notifications WHERE user_id = ? ORDER BY kind').all(member.id).map((r: any) => r.kind);
  return { directory, owner, member, board, prefs, notifications, rows };
}

/** The notification routes, looked up by method and path, compiled the way the API compiles them. */
function routesFor(notifications: any) {
  const compile = (method: string, path: string, options: any, handler: Function) => ({ method, path, options, handler });
  const badRequest = (message: string) => Object.assign(new Error(message), { status: 400, code: 'bad_request' });
  const forbidden = (message: string) => Object.assign(new Error(message), { status: 403, code: 'forbidden' });
  const invalidInput = (message: string) => Object.assign(new Error(message), { status: 400, code: 'invalid_input' });
  const routes = createNotificationRoutes({ notifications, compile, errors: { badRequest, forbidden, invalidInput } }) as any[];
  return (method: string, path: string) => routes.find((route) => route.method === method && route.path === path);
}

const ALL_OFF = { mentions: false, replies: false, cards: false, shares: false };

describe('the switch groups', () => {
  it('puts each notification kind in one of the four groups and leaves tracker and unknown kinds out', () => {
    expect(GROUPS.get('chat_mention')).toBe('mentions');
    expect(groupOf('comment_mention')).toBe('mentions');
    expect(groupOf('comment_reply')).toBe('replies');
    expect(['card_due_soon', 'card_overdue', 'card_assigned'].map(groupOf)).toEqual(['cards', 'cards', 'cards']);
    expect(['board_shared', 'team_joined'].map(groupOf)).toEqual(['shares', 'shares']);
    expect(groupOf('ticket_assigned')).toBeNull();
    expect(groupOf('constructor')).toBeNull();
  });
});

describe('the switches', () => {
  it('is on for everyone who never changed it', () => {
    const { directory, member, prefs } = setup();
    expect(prefs.get(member.id)).toEqual({ mentions: true, replies: true, cards: true, shares: true });
    expect(directory.getPref(member.id, 'notify.mentions')).toBeNull();
    expect(prefs.allows(member.id, 'board_shared')).toBe(true);
  });

  it('saves only the switches it is given and returns all four', () => {
    const { member, prefs, directory } = setup();
    expect(prefs.set(member.id, { cards: false })).toEqual({ mentions: true, replies: true, cards: false, shares: true });
    expect(directory.getPref(member.id, 'notify.cards')).toBe('0');
    expect(prefs.set(member.id, { cards: true })).toMatchObject({ cards: true });
    expect(directory.getPref(member.id, 'notify.cards')).toBe('1');
  });

  it('keeps one person\'s switches apart from another\'s', () => {
    const { owner, member, prefs } = setup();
    prefs.set(member.id, ALL_OFF);
    expect(prefs.get(owner.id)).toEqual({ mentions: true, replies: true, cards: true, shares: true });
  });

  it('refuses unknown keys, values that are not booleans, an empty patch and a non-object, and saves nothing', () => {
    const { member, prefs, directory } = setup();
    for (const patch of [{ quiet: true }, { mentions: 'no' }, { mentions: 0 }, {}, { mentions: true, digest: false }, [], null, 'mentions']) {
      expect(() => prefs.set(member.id, patch)).toThrow(NotificationPrefsInputError);
    }
    expect(() => parseNotificationPrefsPatch({ shares: 1 })).toThrow('shares must be true or false');
    expect(directory.getPref(member.id, 'notify.mentions')).toBeNull();
    expect(directory.getPref(member.id, 'notify.shares')).toBeNull();
  });

  it('allows every kind that has no group', () => {
    const { member, prefs } = setup();
    prefs.set(member.id, ALL_OFF);
    expect(prefs.allows(member.id, 'ticket_assigned')).toBe(true);
    expect(prefs.allows(member.id, 'chat_mention')).toBe(false);
  });
});

describe('record() with a switch off', () => {
  const samples: [keyof typeof ALL_OFF, Record<string, unknown>][] = [
    ['mentions', { kind: 'comment_mention', boardId: 'board_one', ref: 'thread-1', actorId: 'owner' }],
    ['replies', { kind: 'comment_reply', boardId: 'board_one', ref: 'thread-2', actorId: 'owner' }],
    ['cards', { kind: 'card_due_soon', boardId: 'board_one', ref: 'card-1' }],
    ['shares', { kind: 'board_shared', boardId: 'board_one', actorId: 'owner' }],
  ];

  it.each(samples)('skips the %s group and still records the others', (group, fields) => {
    const { notifications, member, rows, prefs } = setup();
    prefs.set(member.id, { [group]: false });
    expect(notifications.record({ userId: member.id, ...fields })).toBeNull();
    expect(rows()).toEqual([]);
    const other = samples.find(([name]) => name !== group)!;
    expect(notifications.record({ userId: member.id, ...other[1] })).toMatchObject({ created: true });
    expect(rows()).toHaveLength(1);
  });

  it('sends no notify frame and no ping for a skipped row', () => {
    const { directory, member, board, prefs } = setup();
    const frames: unknown[] = [];
    const notifications = createNotifications({ directory, prefs, hub: { notify: (...args: unknown[]) => frames.push(args) } as any });
    prefs.set(member.id, { shares: false });
    expect(notifications.record({ userId: member.id, kind: 'board_shared', boardId: board.id, actorId: 'owner' })).toBeNull();
    expect(frames).toEqual([]);
    notifications.record({ userId: member.id, kind: 'board_shared', boardId: board.id, actorId: 'owner' }, { notify: true });
    expect(frames).toEqual([]);
  });

  it('switches a kind back on for rows written after the switch is turned back on', () => {
    const { notifications, member, rows, prefs } = setup();
    prefs.set(member.id, { shares: false });
    notifications.record({ userId: member.id, kind: 'board_shared', boardId: 'board_one', actorId: 'owner' });
    prefs.set(member.id, { shares: true });
    expect(rows()).toEqual([]);
    notifications.record({ userId: member.id, kind: 'board_shared', boardId: 'board_one', actorId: 'owner' });
    expect(rows()).toEqual(['board_shared']);
  });
});

describe('unread rows and tracker rows when a switch is off', () => {
  it('keeps rows already there in the list and the counts, and only stops new rows', () => {
    const { notifications, member, board, prefs } = setup();
    notifications.record({ userId: member.id, kind: 'board_shared', boardId: board.id, actorId: 'owner' });
    prefs.set(member.id, ALL_OFF);
    expect(notifications.list({ user: member })).toMatchObject({ unread: 1, items: [{ kind: 'board_shared', read: false }] });
    expect(notifications.record({ userId: member.id, kind: 'board_shared', boardId: board.id, actorId: 'owner' })).toBeNull();
    expect(notifications.list({ user: member })).toMatchObject({ unread: 1 });
  });

  it('leaves tracker rows listed while every group is off', () => {
    const { directory, member, prefs } = setup();
    directory.db.prepare("INSERT INTO ticket_states (id, name, category) VALUES ('state_todo', 'To do', 'unstarted')").run();
    directory.db.prepare("INSERT INTO tickets (id, key, title, priority, state_id) VALUES ('ticket_linked', 'TAB-3', 'Linked ticket', 'normal', 'state_todo')").run();
    directory.db.prepare("INSERT INTO ticket_links (ticket_id, board_id, removed_at) VALUES ('ticket_linked', 'board_one', NULL)").run();
    directory.db.prepare(
      "INSERT INTO notifications (id, user_id, ticket_id, kind, dedupe_key, created_at) VALUES ('linked-ticket-row', ?, 'ticket_linked', 'assigned', 'd1', 10)",
    ).run(member.id);
    const notifications = createNotifications({ directory, trackerEnabled: true, prefs, now: () => 1_000 });
    expect(notifications.list({ user: member })).toMatchObject({ unread: 1, items: [{ kind: 'ticket_assigned' }] });
    prefs.set(member.id, ALL_OFF);
    expect(notifications.list({ user: member })).toMatchObject({ unread: 1, items: [{ kind: 'ticket_assigned' }] });
  });
});

describe('the routes', () => {
  it('reads and writes the four switches for a signed-in account', async () => {
    const { notifications, member } = setup();
    const byRoute = routesFor(notifications);
    const get = () => byRoute('GET', 'notifications/prefs').handler({ user: member, query: new URLSearchParams() });
    const put = (body: unknown) => byRoute('PUT', 'notifications/prefs').handler({ user: member, body });
    expect(await get()).toEqual([200, { prefs: { mentions: true, replies: true, cards: true, shares: true } }]);
    expect(await put({ shares: false })).toEqual([200, { prefs: { mentions: true, replies: true, cards: true, shares: false } }]);
    expect(await get()).toEqual([200, { prefs: { mentions: true, replies: true, cards: true, shares: false } }]);
  });

  it('answers 400 invalid input for an unknown field, a non-boolean value or an empty body', async () => {
    const { notifications, member } = setup();
    const put = routesFor(notifications)('PUT', 'notifications/prefs').handler;
    for (const body of [{ quiet: true }, { mentions: 'yes' }, {}, null]) {
      await expect(Promise.resolve().then(() => put({ user: member, body }))).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    }
  });

  it('refuses a guest session with 403 on both routes', async () => {
    const { notifications } = setup();
    const guest = { id: 'guest_1', role: 'guest', guest: true };
    const byRoute = routesFor(notifications);
    await expect(Promise.resolve().then(() => byRoute('GET', 'notifications/prefs').handler({ user: guest, query: new URLSearchParams() })))
      .rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(Promise.resolve().then(() => byRoute('PUT', 'notifications/prefs').handler({ user: guest, body: { mentions: false } })))
      .rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('is allowed in a read-only workspace and has the body limit of the other notification routes', () => {
    const { notifications } = setup();
    const put = routesFor(notifications)('PUT', 'notifications/prefs');
    expect(put.options).toMatchObject({ body: true, readOnlyOk: true, maxBody: 8 * 1024 });
  });
});
