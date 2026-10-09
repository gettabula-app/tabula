// Chat messages (docs/chat.md). A database of its own, <DATA_DIR>/chat.sqlite, so years of conversation never slow the
// directory's backup copy and a full chat disk never takes sign-in down. The server is the only writer: authors, times
// and the order (the row id) are set here from what the routes pass in, never from a request body.
//
// There are no foreign keys to users or boards (they live in the other database). The routes check access through the
// directory before any query here.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CHAT_MIGRATIONS = [
  `
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('board', 'team', 'workspace')),
    ref TEXT NOT NULL,
    author_id TEXT,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_to INTEGER,
    object_id TEXT,
    client_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    deleted_by TEXT,
    UNIQUE (kind, ref, author_id, client_id)
  );
  CREATE INDEX chat_by_channel ON chat_messages (kind, ref, id);
  CREATE TABLE chat_reads (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    last_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, ref)
  );
  CREATE TABLE chat_mentions (
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX chat_mentions_by_user ON chat_mentions (user_id, message_id);
  CREATE TABLE chat_reactions (
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  `,
];

// Workspace settings for chat live in the directory's `settings` table with the others (docs/chat.md, Interface).
export const CHAT_SETTING_KEYS = Object.freeze({ viewersMayPost: 'chat.viewersMayPost', retentionDays: 'chat.retentionDays' });
/** Keep chat messages: one year unless an administrator chooses otherwise. null is "forever". */
export const RETENTION_CHOICES = [365, 90, 30, null];
export const DEFAULT_RETENTION_DAYS = 365;

/** The chat settings as stored, with their defaults. `directory` needs only getSetting. */
export function readChatSettings(directory) {
  const retention = directory.getSetting(CHAT_SETTING_KEYS.retentionDays);
  const days = retention === 'forever' ? null : Number(retention);
  return {
    viewersMayPost: directory.getSetting(CHAT_SETTING_KEYS.viewersMayPost) === '1',
    retentionDays: retention === null || !RETENTION_CHOICES.includes(days) ? DEFAULT_RETENTION_DAYS : days,
  };
}

function migrate(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > CHAT_MIGRATIONS.length) {
    throw new Error(`chat.sqlite was written by a newer Tabula (schema ${version}, this build knows ${CHAT_MIGRATIONS.length})`);
  }
  for (let i = version; i < CHAT_MIGRATIONS.length; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(CHAT_MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

const toMessage = (r) => ({
  id: Number(r.id),
  kind: r.kind,
  ref: r.ref,
  authorId: r.author_id ?? null,
  authorName: r.author_name,
  body: r.body,
  replyTo: r.reply_to == null ? null : Number(r.reply_to),
  objectId: r.object_id ?? null,
  clientId: r.client_id,
  createdAt: Number(r.created_at),
  editedAt: r.edited_at == null ? null : Number(r.edited_at),
  deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
  deletedBy: r.deleted_by ?? null,
  mentions: [],
});

export function openChat(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  /** @type {Map<string, import('node:sqlite').StatementSync>} */
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const get = (sql, ...params) => stmt(sql).get(...params);
  const all = (sql, ...params) => stmt(sql).all(...params);
  const run = (sql, ...params) => stmt(sql).run(...params);

  let closed = false;
  let depth = 0;
  function transaction(fn) {
    const nested = depth > 0;
    const savepoint = `sp${depth}`;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      if (nested) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      else db.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  }

  /**
   * The mention lists of some messages, filled in place.
   * @param {ReturnType<typeof toMessage>[]} messages
   */
  function withMentions(messages) {
    const live = messages.filter((m) => m.deletedAt === null);
    for (let i = 0; i < live.length; i += 500) {
      const chunk = live.slice(i, i + 500);
      const byId = new Map(chunk.map((m) => [m.id, m]));
      const rows = all(
        `SELECT message_id, user_id FROM chat_mentions WHERE message_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY rowid`,
        ...chunk.map((m) => m.id),
      );
      for (const r of rows) byId.get(Number(r.message_id))?.mentions.push(r.user_id);
    }
    return messages;
  }

  function getMessage(id) {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const row = get('SELECT * FROM chat_messages WHERE id = ?', id);
    return row ? withMentions([toMessage(row)])[0] : null;
  }

  function findByClientId(kind, ref, authorId, clientId) {
    const row = get('SELECT * FROM chat_messages WHERE kind = ? AND ref = ? AND author_id = ? AND client_id = ?', kind, ref, authorId, clientId);
    return row ? withMentions([toMessage(row)])[0] : null;
  }

  const addMentions = (messageId, userIds) => {
    for (const userId of userIds) run('INSERT OR IGNORE INTO chat_mentions (message_id, user_id) VALUES (?, ?)', messageId, userId);
  };

  /**
   * Stores a new message, or finds the one this author already stored under this clientId (a retried send).
   * @param {{ kind: string, ref: string, authorId: string, authorName: string, body: string, replyTo?: number | null,
   *   objectId?: string | null, clientId: string, mentions?: string[], now?: number }} fields
   * @returns {{ message: ReturnType<typeof toMessage>, created: boolean }}
   */
  function insertMessage(fields) {
    const { kind, ref, authorId, authorName, body, replyTo = null, objectId = null, clientId, mentions = [], now = Date.now() } = fields;
    return transaction(() => {
      const existing = findByClientId(kind, ref, authorId, clientId);
      if (existing) return { message: existing, created: false };
      const result = run(
        `INSERT INTO chat_messages (kind, ref, author_id, author_name, body, reply_to, object_id, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        kind, ref, authorId, authorName, body, replyTo, objectId, clientId, now,
      );
      const id = Number(result.lastInsertRowid);
      addMentions(id, mentions);
      return { message: getMessage(id), created: true };
    });
  }

  /**
   * A page of a channel, oldest first. `before` is an id (exclusive); `next` is the id to pass as `before` for the page
   * before this one, null at the start of the channel.
   * @param {string} kind
   * @param {string} ref
   * @param {{ before?: number | null, limit?: number }} [options]
   */
  function listMessages(kind, ref, { before = null, limit = 50 } = {}) {
    const rows = all(
      `SELECT * FROM chat_messages WHERE kind = $kind AND ref = $ref AND ($before IS NULL OR id < $before)
        ORDER BY id DESC LIMIT $limit`,
      { kind, ref, before, limit: limit + 1 },
    );
    const page = rows.slice(0, limit).map(toMessage).reverse();
    return { messages: withMentions(page), next: rows.length > limit ? page[0].id : null };
  }

  /** New text for a live message; the mentions follow the text. */
  function editMessage(id, body, mentions, now = Date.now()) {
    transaction(() => {
      run('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL', body, now, id);
      run('DELETE FROM chat_mentions WHERE message_id = ?', id);
      addMentions(id, mentions);
    });
    return getMessage(id);
  }

  /** A tombstone: the text is overwritten at once, mentions and reactions go. The row stays so replies keep their place. */
  function deleteMessage(id, byUserId, now = Date.now()) {
    transaction(() => {
      run("UPDATE chat_messages SET body = '', deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL", now, byUserId, id);
      run('DELETE FROM chat_mentions WHERE message_id = ?', id);
      run('DELETE FROM chat_reactions WHERE message_id = ?', id);
    });
    return getMessage(id);
  }

  const topId = (kind, ref) => Number(get('SELECT MAX(id) AS top FROM chat_messages WHERE kind = ? AND ref = ?', kind, ref).top ?? 0);

  const markerOf = (userId, kind, ref) => {
    const row = get('SELECT last_id FROM chat_reads WHERE user_id = ? AND kind = ? AND ref = ?', userId, kind, ref);
    return row ? Number(row.last_id) : null;
  };

  /** Moves the read marker forward (never back), and never past the channel's newest message. Returns where it is. */
  function markRead(userId, kind, ref, lastId) {
    return transaction(() => {
      const target = Math.min(Math.max(0, Math.trunc(lastId)), topId(kind, ref));
      run(
        `INSERT INTO chat_reads (user_id, kind, ref, last_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, kind, ref) DO UPDATE SET last_id = MAX(chat_reads.last_id, excluded.last_id)`,
        userId, kind, ref, target,
      );
      return markerOf(userId, kind, ref);
    });
  }

  /**
   * Where a person without a marker starts: caught up at the newest message, except that a mention of them is never
   * skipped, so the marker goes just before the first one. Written, so later messages count from there.
   */
  function startMarker(userId, kind, ref) {
    const first = get(
      `SELECT MIN(m.id) AS first FROM chat_mentions cm JOIN chat_messages m ON m.id = cm.message_id
        WHERE cm.user_id = ? AND m.kind = ? AND m.ref = ? AND m.deleted_at IS NULL AND (m.author_id IS NULL OR m.author_id <> ?)`,
      userId, kind, ref, userId,
    ).first;
    const start = first == null ? topId(kind, ref) : Number(first) - 1;
    run('INSERT OR IGNORE INTO chat_reads (user_id, kind, ref, last_id) VALUES (?, ?, ?, ?)', userId, kind, ref, start);
    return markerOf(userId, kind, ref);
  }

  /** Unread messages and mentions after `lastId`: not deleted and not written by the person. */
  function countsAfter(userId, kind, ref, lastId) {
    const unread = Number(get(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE kind = ? AND ref = ? AND id > ? AND deleted_at IS NULL
          AND (author_id IS NULL OR author_id <> ?)`,
      kind, ref, lastId, userId,
    ).n);
    const mentions = unread === 0 ? 0 : Number(get(
      `SELECT COUNT(*) AS n FROM chat_mentions cm JOIN chat_messages m ON m.id = cm.message_id
        WHERE cm.user_id = ? AND m.kind = ? AND m.ref = ? AND m.id > ? AND m.deleted_at IS NULL
          AND (m.author_id IS NULL OR m.author_id <> ?)`,
      userId, kind, ref, lastId, userId,
    ).n);
    return { unread, mentions };
  }

  /** The unread state of one channel for one person. */
  function channelUnread(userId, kind, ref) {
    return transaction(() => {
      const lastId = markerOf(userId, kind, ref) ?? startMarker(userId, kind, ref);
      return { kind, ref, lastId, ...countsAfter(userId, kind, ref, lastId) };
    });
  }

  /**
   * The unread summary over the channels of one kind that a person can read (`refs`, checked by the caller): only the
   * channels with something unread. Channels without a marker get one first (see startMarker).
   * @param {string} userId
   * @param {string} kind
   * @param {string[]} refs
   * @returns {{ kind: string, ref: string, lastId: number, unread: number, mentions: number }[]}
   */
  function unreadSummary(userId, kind, refs) {
    return transaction(() => {
      const markers = new Map(all('SELECT ref, last_id FROM chat_reads WHERE user_id = ? AND kind = ?', userId, kind).map((r) => [r.ref, Number(r.last_id)]));
      const tops = new Map(all('SELECT ref, MAX(id) AS top FROM chat_messages WHERE kind = ? GROUP BY ref', kind).map((r) => [r.ref, Number(r.top)]));
      /** @type {{ kind: string, ref: string, lastId: number, unread: number, mentions: number }[]} */
      const out = [];
      for (const ref of refs) {
        const lastId = markers.get(ref) ?? startMarker(userId, kind, ref);
        if ((tops.get(ref) ?? 0) <= lastId) continue;
        const counts = countsAfter(userId, kind, ref, lastId);
        if (counts.unread > 0) out.push({ kind, ref, lastId, ...counts });
      }
      return out;
    });
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      db.close();
    },
    transaction,
    getMessage,
    findByClientId,
    insertMessage,
    listMessages,
    editMessage,
    deleteMessage,
    topId,
    markRead,
    channelUnread,
    unreadSummary,
  };
}
