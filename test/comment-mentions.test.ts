import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { createCommentGuard } from '../server/comment-authz.mjs';
import { commentIndex, commentsAddedSince, mentionsRecipient, recordCommentMentions } from '../server/comment-mentions.mjs';
import { createNotifications } from '../server/notifications.mjs';

// TAB-53, server slice 1: a mention in a comment records a comment_mention row for each person it names who can open
// the board. Everything here runs in memory and synchronously, so nothing waits.

const BOARD = 'b1';
const OLGA = { id: 'olga', role: 'owner', name: 'Olga' };
const ANA = { id: 'ana', role: 'editor', name: 'Ana' };
const BEN = { id: 'ben', role: 'viewer', name: 'Ben' };
const CY = { id: 'cy', role: 'viewer', name: 'Cy' };
const PALS = Array.from({ length: 11 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);

const dbs: DatabaseSync[] = [];

function openDirectory() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec(`
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
  `);
  const directory: any = {
    db,
    getUser(id: string) {
      const row = db.prepare('SELECT id,email,name,role,disabled FROM users WHERE id = ?').get(id);
      return row ? { ...row, disabled: Boolean(row.disabled) } : null;
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
      if (board.deletedAt != null) return null;
      if (board.ownerId === userId) return 'owner';
      const share = db.prepare("SELECT role FROM board_shares WHERE board_id = ? AND principal_type = 'user' AND principal_id = ?").get(boardId, userId);
      return share?.role ?? null;
    },
    unshareBoard(boardId: string, principalType: string, principalId: string) {
      db.prepare('DELETE FROM board_shares WHERE board_id = ? AND principal_type = ? AND principal_id = ?').run(boardId, principalType, principalId);
    },
  };
  return directory;
}

/** A board with an owner, an editor (Ana), a viewer (Ben), eleven viewers (PALS) and a person with no access (Cy). */
function world() {
  const directory = openDirectory();
  const db: DatabaseSync = directory.db;
  const addUser = (id: string, name: string) =>
    db.prepare("INSERT INTO users (id,email,name,role) VALUES (?,?,?,'member')").run(id, `${id}@example.com`, name);
  addUser(OLGA.id, OLGA.name);
  addUser(ANA.id, ANA.name);
  addUser(BEN.id, BEN.name);
  addUser(CY.id, CY.name);
  PALS.forEach((p) => addUser(p, `Pal ${p}`));
  db.prepare("INSERT INTO boards (id,title,owner_id,team_id,deleted_at) VALUES (?,?,?,NULL,NULL)").run(BOARD, 'Launch board', OLGA.id);
  const share = (userId: string, role: string) =>
    db.prepare("INSERT INTO board_shares (board_id,principal_type,principal_id,role) VALUES (?,'user',?,?)").run(BOARD, userId, role);
  share(ANA.id, 'editor');
  share(BEN.id, 'viewer');
  PALS.forEach((p) => share(p, 'viewer'));

  const server = new Y.Doc();
  const notifications = createNotifications({ directory, roomAccess: { read: (_name: string, fn: (doc: Y.Doc) => unknown) => fn(server) } });
  const rows = (userId: string) =>
    db.prepare('SELECT kind, actor_id, board_id, ref FROM user_notifications WHERE user_id = ? ORDER BY kind, ref').all(userId);
  const inbox = (userId: string) => notifications.list({ user: { id: userId } });

  // The relay's hooks, as server/relay.mjs wires them for a comments room.
  const guard = createCommentGuard(server, {
    isAccount: (id: string) => directory.getUser(id) !== null,
    onReplyAdded: ({ threadId, threadAuthorId, replyId, replyAuthorId }) => {
      const text = server.getMap<any>('threads').get(threadId)?.toJSON().replies?.[replyId]?.text;
      if (mentionsRecipient({ directory, boardId: BOARD, text, authorId: replyAuthorId, recipientId: threadAuthorId })) return;
      notifications.record({ userId: threadAuthorId, kind: 'comment_reply', actorId: replyAuthorId, boardId: BOARD, ref: threadId });
    },
    onCommentAdded: ({ threadId, authorId, text }) =>
      recordCommentMentions({ directory, notifications, boardId: BOARD, threadId, authorId, text }),
  });

  /** A client makes `change` on its copy of the document; the guard applies and corrects it, as the relay does. */
  const send = (actor: { id: string; role: string; name: string }, change: (threads: Y.Map<any>) => void) => {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    const before = Y.encodeStateVector(client);
    client.transact(() => change(client.getMap<any>('threads')));
    const update = Y.encodeStateAsUpdate(client, before);
    return guard.run(actor, () => Y.applyUpdate(server, update, 'socket'));
  };
  return { directory, db, server, notifications, rows, inbox, send };
}

function newThread(threads: Y.Map<any>, id: string, author: { id: string; name: string }, extra: Record<string, unknown> = {}) {
  const m = new Y.Map<unknown>();
  threads.set(id, m);
  const fields = { id, createdAt: 1, authorId: author.id, authorName: author.name, authorColor: '#123', text: 'Hello', anchor: { x: 0, y: 0 }, resolved: false, ...extra };
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  m.set('replies', new Y.Map());
  return m;
}

const addReply = (threads: Y.Map<any>, threadId: string, id: string, author: { id: string; name: string }, text: string) =>
  (threads.get(threadId)!.get('replies') as Y.Map<unknown>).set(id, { id, authorId: author.id, authorName: author.name, authorColor: '#123', text, createdAt: 2 });

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('comment mentions (TAB-53, server)', () => {
  it('records one comment_mention row for a board member who is named', () => {
    const { send, rows, inbox } = world();
    expect(send(ANA, (t) => newThread(t, 't1', ANA, { text: 'Hi @{ben}, see this' }))).toEqual([]);
    expect(rows(BEN.id)).toEqual([{ kind: 'comment_mention', actor_id: ANA.id, board_id: BOARD, ref: 't1' }]);
    expect(rows(ANA.id)).toEqual([]);
    const page = inbox(BEN.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: 'comment_mention',
      actor: { id: ANA.id, name: 'Ana' },
      board: { id: BOARD, title: 'Launch board' },
      snippet: 'Hi @Ben, see this',
      target: `#/b/${BOARD}`,
      read: false,
    });
    expect(page.unreadMentions).toBe(1);
  });

  it('records nothing for a person who is named but cannot open the board', () => {
    const { send, rows, inbox } = world();
    send(ANA, (t) => newThread(t, 't1', ANA, { text: 'Over to @{cy}' }));
    expect(rows(CY.id)).toEqual([]);
    expect(inbox(CY.id).items).toEqual([]);
  });

  it('does not notify the author who names themself', () => {
    const { send, rows } = world();
    send(ANA, (t) => newThread(t, 't1', ANA, { text: 'Note to @{ana}' }));
    expect(rows(ANA.id)).toEqual([]);
  });

  it('records one row when the same person is named twice', () => {
    const { send, rows } = world();
    send(ANA, (t) => newThread(t, 't1', ANA, { text: '@{ben} and again @{ben}' }));
    expect(rows(BEN.id)).toHaveLength(1);
  });

  it('records only the first ten people named in a comment', () => {
    const { send, rows } = world();
    const text = PALS.map((p) => `@{${p}}`).join(' ');
    send(ANA, (t) => newThread(t, 't1', ANA, { text }));
    for (const p of PALS.slice(0, 10)) expect(rows(p)).toHaveLength(1);
    expect(rows(PALS[10])).toEqual([]);
  });

  it('does not notify when a comment is edited', () => {
    const { send, rows } = world();
    send(ANA, (t) => newThread(t, 't1', ANA, { text: 'No names yet' }));
    expect(send(ANA, (t) => t.get('t1')!.set('text', 'Now with @{ben}'))).toEqual([]);
    expect(rows(BEN.id)).toEqual([]);
  });

  it('gives the thread author one comment_mention row, and no comment_reply, for a reply that names them', () => {
    const { send, rows, inbox } = world();
    send(ANA, (t) => newThread(t, 't1', ANA));
    expect(send(BEN, (t) => addReply(t, 't1', 'r1', BEN, '@{ana} can you check this?'))).toEqual([]);
    expect(rows(ANA.id)).toEqual([{ kind: 'comment_mention', actor_id: BEN.id, board_id: BOARD, ref: 't1' }]);
    expect(inbox(ANA.id).items.map((i: any) => i.kind)).toEqual(['comment_mention']);
    expect(inbox(ANA.id).items[0].snippet).toBe('@Ana can you check this?');
  });

  it('keeps a comment_reply row for a reply to the thread author that names someone else', () => {
    const { send, rows } = world();
    send(ANA, (t) => newThread(t, 't1', ANA));
    send(BEN, (t) => addReply(t, 't1', 'r1', BEN, 'Thanks, @{p01}'));
    expect(rows(ANA.id)).toEqual([{ kind: 'comment_reply', actor_id: BEN.id, board_id: BOARD, ref: 't1' }]);
    expect(rows('p01')).toEqual([{ kind: 'comment_mention', actor_id: BEN.id, board_id: BOARD, ref: 't1' }]);
  });

  it('records no mention for an imported comment', () => {
    const { send, rows } = world();
    expect(send(OLGA, (t) => newThread(t, 't1', { id: ANA.id, name: ANA.name }, {
      imported: true,
      importedBy: OLGA.id,
      text: 'Old note for @{ben}',
    }))).toEqual([]);
    expect(rows(BEN.id)).toEqual([]);
  });

  it('shows the mention with its snippet and target, and hides it once the person loses board access', () => {
    const { send, directory, rows, inbox } = world();
    send(ANA, (t) => newThread(t, 't1', ANA, { text: 'Please look, @{ben}' }));
    expect(inbox(BEN.id)).toMatchObject({ unreadMentions: 1, items: [{ kind: 'comment_mention', snippet: 'Please look, @Ben' }] });

    directory.unshareBoard(BOARD, 'user', BEN.id);
    expect(inbox(BEN.id)).toMatchObject({ unread: 0, unreadMentions: 0, items: [], nextCursor: null });
    // the ledger keeps the row; it is simply not shown to someone who cannot open the board
    expect(rows(BEN.id)).toHaveLength(1);
  });

  it('records mentions in comments written straight to the document (the MCP path)', () => {
    const { directory, notifications, server, rows, send } = world();
    send(ANA, (t) => newThread(t, 't1', ANA));
    const index = commentIndex(server);
    server.transact(() => {
      const threads = server.getMap<any>('threads');
      newThread(threads, 't2', ANA, { text: 'For @{ben}' });
      addReply(threads, 't1', 'r1', ANA, 'Also @{ben}');
    });
    const added = commentsAddedSince(index, server, ANA.id);
    expect(added).toHaveLength(2);
    expect(added).toEqual(expect.arrayContaining([
      { threadId: 't2', replyId: null, text: 'For @{ben}' },
      { threadId: 't1', replyId: 'r1', text: 'Also @{ben}' },
    ]));
    for (const a of added) {
      recordCommentMentions({ directory, notifications, boardId: BOARD, threadId: a.threadId, authorId: ANA.id, text: a.text });
    }
    expect(rows(BEN.id)).toEqual([
      { kind: 'comment_mention', actor_id: ANA.id, board_id: BOARD, ref: 't1' },
      { kind: 'comment_mention', actor_id: ANA.id, board_id: BOARD, ref: 't2' },
    ]);
  });
});
