// Per-person notifications (docs/notifications.md). Source content is resolved only after the current user passes
// the source's access check. The ledger stores ids and timestamps, never snippets or copied tracker events.

import crypto from 'node:crypto';
import { ticketAccess, recipientActor, boardAccessForDirectory } from './tracker/access.mjs';
import { notificationContent } from './tracker/inbox.mjs';
import { snippetOf } from './chat-notify.mjs';
import { cardFirstLine } from './card-due.mjs';
import { createNotificationPrefs } from './notification-prefs.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_BATCH = 100;
const UNREAD_LIMIT = 200;
const KEEP_PER_USER = 500;
const KINDS = new Set(['chat_mention', 'comment_reply', 'comment_mention', 'board_shared', 'team_joined', 'card_due_soon', 'card_overdue', 'card_assigned']);
// Card kinds read the card's first line at list time, and only while the viewer still has a role on the board and the card exists.
const CARD_KINDS = new Set(['card_due_soon', 'card_overdue', 'card_assigned']);
const MENTION_KINDS = new Set(['chat_mention', 'comment_mention', 'ticket_mentioned']);
const WORKSPACE_REF = 'main';

const userIdOf = (user) => typeof user === 'string' ? user : user?.id;
const newId = () => crypto.randomBytes(16).toString('base64url');
const textOf = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const clip = (value, max = 140) => {
  const plain = Array.from(textOf(value));
  return plain.length > max ? `${plain.slice(0, max - 1).join('')}…` : plain.join('');
};

// The bell's sentence for one list item (src/ui/notifications-logic.ts, rowText), as plain text for the digest email. It uses
// only who, what and the board or team name; never a snippet, a card title or a ticket title (a ticket is named by its key).
const sentenceName = (value, max = 80) => String(value ?? '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, max);
const TICKET_KEY = /^\/t\/([A-Za-z0-9_-]{1,32})$/u;

/** @param {{ kind: string, actor?: { name?: string } | null, board?: { title?: string } | null, team?: { name?: string } | null, target?: string | null }} item */
export function sentenceFor(item) {
  const who = sentenceName(item.actor?.name) || 'Someone';
  const board = sentenceName(item.board?.title, 200);
  const team = sentenceName(item.team?.name, 200);
  switch (item.kind) {
    case 'card_assigned': return `${who} assigned you a card on ${board || 'a board'}`;
    case 'card_due_soon': return `A card is due soon on ${board || 'a board'}`;
    case 'card_overdue': return `A card is overdue on ${board || 'a board'}`;
    case 'chat_mention': {
      const place = team || board;
      return `${who} mentioned you in ${place ? `${place} chat` : 'the workspace chat'}`;
    }
    case 'comment_mention': return `${who} mentioned you in a comment on ${board || 'a board'}`;
    case 'comment_reply': return `${who} replied to your comment on ${board || 'a board'}`;
    case 'board_shared': return `${who} shared ${board || 'a board'} with you`;
    case 'team_joined': return `${who} joined ${team || 'a team'}`;
    default: {
      if (String(item.kind).startsWith('ticket_')) {
        const key = TICKET_KEY.exec(String(item.target ?? ''))?.[1];
        return key ? `Your ticket ${key} changed` : 'Your ticket changed';
      }
      return 'You have a new notification';
    }
  }
}

function timestampOf(item) {
  return Number(item.at ?? item.createdAt ?? item.created_at ?? 0);
}

function compareDesc(a, b) {
  const time = timestampOf(b) - timestampOf(a);
  if (time) return time;
  const left = String(a.id);
  const right = String(b.id);
  return left === right ? 0 : (left < right ? 1 : -1);
}

/** Merge already access-filtered rows into one deterministic newest-first page. */
export function mergeNotificationRows(personalRows, trackerRows, limit = Infinity) {
  return [...personalRows, ...trackerRows].sort(compareDesc).slice(0, limit);
}

function decodeCursor(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw new TypeError('Invalid notification cursor');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || !Number.isSafeInteger(parsed.createdAt) || typeof parsed.id !== 'string' || !parsed.id) throw new Error('bad cursor');
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new TypeError('Invalid notification cursor');
  }
}

function encodeCursor(item) {
  return Buffer.from(JSON.stringify({ createdAt: item.at, id: item.id })).toString('base64url');
}

function currentUser(directory, user) {
  const id = userIdOf(user);
  if (typeof id !== 'string' || !id) return null;
  const found = directory.getUser(id);
  return found && !found.disabled ? found : null;
}

function cursorSql(prefix, cursor) {
  if (!cursor) return { sql: '', params: [] };
  return {
    sql: `AND (created_at < ? OR (created_at = ? AND '${prefix}' || id < ?))`,
    params: [cursor.createdAt, cursor.createdAt, cursor.id],
  };
}

function sourceId(prefix, id) {
  return `${prefix}_${id}`;
}

function cursorState(cursor) {
  return { cursor, done: false };
}

function objectOf(value) {
  if (value && typeof value.toJSON === 'function') return value.toJSON();
  return value && typeof value === 'object' ? value : null;
}

function threadValue(doc, threadId) {
  const thread = doc?.getMap?.('threads')?.get?.(threadId);
  return objectOf(thread);
}

/**
 * The comment a mention row points at: the latest comment in the thread by the person who wrote the mention, preferring
 * one that names the recipient. The ledger keeps only the thread, so this is the best match, not a certain one.
 */
function mentionSnippet(roomAccess, boardId, threadId, actorId, recipientId, nameOf) {
  if (!roomAccess?.read || !actorId) return null;
  try {
    return roomAccess.read(`${boardId}~comments`, (doc) => {
      const thread = threadValue(doc, threadId);
      if (!thread) return null;
      const token = `@{${recipientId}}`;
      const candidates = [[threadId, thread], ...Object.entries(thread.replies ?? {}).map(([id, value]) => [String(id), objectOf(value)])]
        .filter(([, c]) => c && c.authorId === actorId && typeof c.text === 'string')
        .sort((a, b) => Number(b[1].createdAt ?? 0) - Number(a[1].createdAt ?? 0) || (a[0] < b[0] ? 1 : -1));
      const named = candidates.find(([, c]) => c.text.includes(token));
      const pick = (named ?? candidates[0])?.[1];
      return pick ? snippetOf(pick.text, nameOf) : null;
    });
  } catch {
    return null;
  }
}

function replySnippet(roomAccess, boardId, threadId, actorId) {
  if (!roomAccess?.read) return null;
  try {
    return roomAccess.read(`${boardId}~comments`, (doc) => {
      const thread = threadValue(doc, threadId);
      if (!thread) return null;
      const repliesValue = doc.getMap('threads').get(threadId)?.get?.('replies');
      const replies = objectOf(repliesValue) ?? thread.replies ?? {};
      const entries = replies instanceof Map ? [...replies.entries()] : Object.entries(replies);
      const latest = entries
        .map(([id, value]) => [String(id), objectOf(value)] )
        .filter(([, reply]) => reply && typeof reply.text === 'string')
        .sort((a, b) => Number(b[1].createdAt ?? 0) - Number(a[1].createdAt ?? 0) || (a[0] < b[0] ? 1 : -1))[0];
      if (!latest) return null;
      // Prefer the reply that created this row while it still exists; otherwise the latest reply is still useful context.
      const authored = actorId && entries
        .map(([id, value]) => [String(id), objectOf(value)])
        .filter(([, reply]) => reply?.authorId === actorId && typeof reply.text === 'string')
        .sort((a, b) => Number(b[1].createdAt ?? 0) - Number(a[1].createdAt ?? 0) || (a[0] < b[0] ? 1 : -1))[0];
      const reply = authored ? authored[1] : latest[1];
      return clip(reply.text);
    });
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {any} options.directory
 * @param {boolean} [options.trackerEnabled]
 * @param {Function|object|null} [options.chatStore]
 * @param {Function|null} [options.chatAccess]
 * @param {{ read?: Function }|null} [options.roomAccess]
 * @param {{ notify?: Function }|null} [options.hub]
 * @param {Function} [options.now]
 * @param {Function|null} [options.boardAccess]
 * @param {{ allows: Function }} [options.prefs] the per-member switches (notification-prefs.mjs); one is made from the directory when absent
 */
export function createNotifications({
  directory,
  trackerEnabled = false,
  chatStore = null,
  chatAccess = null,
  roomAccess = null,
  hub = null,
  now = Date.now,
  boardAccess = boardAccessForDirectory(directory),
  prefs = null,
}) {
  const db = directory?.db;
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Notifications need a directory database');
  const switches = prefs ?? createNotificationPrefs({ directory });

  const nowValue = () => {
    const value = typeof now === 'function' ? now() : now;
    return Number.isSafeInteger(value) ? value : Date.now();
  };
  const chatDb = () => typeof chatStore === 'function' ? chatStore() : chatStore;

  function canOpenTeam(user, teamId) {
    const team = directory.getTeam(teamId);
    return Boolean(team && (directory.getTeamRole(teamId, user.id) !== null || ['owner', 'admin'].includes(user.role)));
  }

  function canOpenUserRow(user, row) {
    if (row.kind === 'chat_mention') {
      const kind = row.board_id ? 'board' : row.team_id ? 'team' : 'workspace';
      const ref = row.board_id ?? row.team_id ?? WORKSPACE_REF;
      if (chatAccess?.(user, kind, ref)?.read !== true) return false;
      const message = chatDb()?.getMessage?.(Number(row.ref));
      return message !== null && message !== undefined;
    }
    if (row.kind === 'comment_reply' || row.kind === 'comment_mention') {
      if (!row.board_id || directory.boardRole(row.board_id, user.id) === null) return false;
      let exists = false;
      try {
        roomAccess?.read?.(`${row.board_id}~comments`, (doc) => { exists = Boolean(threadValue(doc, row.ref)); });
      } catch {
        return false;
      }
      return exists;
    }
    if (row.kind === 'board_shared') return Boolean(row.board_id && directory.boardRole(row.board_id, user.id) !== null);
    if (row.kind === 'team_joined') return Boolean(row.team_id && canOpenTeam(user, row.team_id));
    if (CARD_KINDS.has(row.kind)) return cardOf(user, row) !== null;
    return false;
  }

  /** The card a card row points at: `{ snippet }` when the viewer may open it and it is still on the board, else null. */
  function cardOf(user, row) {
    if (!row.board_id || !roomAccess?.read || directory.boardRole(row.board_id, user.id) === null) return null;
    let firstLine = null;
    let found = false;
    try {
      roomAccess.read(row.board_id, (doc) => {
        firstLine = cardFirstLine(doc, row.ref);
        found = firstLine !== null;
      });
    } catch {
      return null;
    }
    return found ? { snippet: clip(firstLine) || null } : null;
  }

  function targetForUserRow(row) {
    if (row.kind === 'chat_mention') {
      const kind = row.board_id ? 'board' : row.team_id ? 'team' : 'workspace';
      const ref = row.board_id ?? row.team_id ?? WORKSPACE_REF;
      return `#/chat/${kind}/${encodeURIComponent(ref)}`;
    }
    if (row.board_id) return `#/b/${encodeURIComponent(row.board_id)}`;
    return '#/';
  }

  function userRowItem(user, row) {
    // A card row reads its card once: the same read proves access and supplies the snippet.
    const card = CARD_KINDS.has(row.kind) ? cardOf(user, row) : undefined;
    if (card === null || (card === undefined && !canOpenUserRow(user, row))) return null;
    const actorUser = row.actor_id ? directory.getUser(row.actor_id) : null;
    const boardRow = row.board_id ? directory.getBoard(row.board_id) : null;
    const teamRow = row.team_id ? directory.getTeam(row.team_id) : null;
    let snippet = null;
    if (CARD_KINDS.has(row.kind)) {
      snippet = card?.snippet ?? null;
    } else if (row.kind === 'chat_mention') {
      const message = chatDb()?.getMessage?.(Number(row.ref));
      if (!message) return null;
      if (message.deletedAt === null) {
        const nameOf = (id) => directory.getUser(id)?.name ?? null;
        snippet = snippetOf(message.body, nameOf);
      }
    } else if (row.kind === 'comment_reply' && row.board_id) {
      snippet = replySnippet(roomAccess, row.board_id, row.ref, row.actor_id);
    } else if (row.kind === 'comment_mention' && row.board_id) {
      const nameOf = (id) => directory.getUser(id)?.name ?? null;
      snippet = mentionSnippet(roomAccess, row.board_id, row.ref, row.actor_id, user.id, nameOf);
    }
    return {
      id: sourceId('n', row.id),
      kind: row.kind,
      at: Number(row.created_at),
      read: row.read_at != null,
      actor: actorUser ? { id: actorUser.id, name: actorUser.name } : null,
      board: boardRow ? { id: boardRow.id, title: boardRow.title } : null,
      team: teamRow ? { id: teamRow.id, name: teamRow.name } : null,
      snippet,
      target: targetForUserRow(row),
    };
  }

  function ticketItem(user, row) {
    const current = currentUser(directory, user);
    if (!current) return null;
    try {
      ticketAccess(recipientActor(current), { id: row.ticket_id }, { boardAccess });
    } catch {
      return null;
    }
    const content = notificationContent(db, row);
    if (!content) return null;
    const event = row.event_id == null ? null : db.prepare(
      'SELECT actor_type, actor_id, details_json FROM ticket_events WHERE id = ? AND ticket_id = ?',
    ).get(row.event_id, row.ticket_id);
    let actorId = event?.actor_type === 'user' ? event.actor_id : null;
    if (event?.actor_type === 'mcp_token') {
      try {
        const details = JSON.parse(event.details_json ?? '{}');
        if (typeof details.ownerUserId === 'string') actorId = details.ownerUserId;
      } catch { /* malformed event detail has no named actor */ }
    }
    const actorUser = actorId ? directory.getUser(actorId) : null;
    return {
      id: sourceId('t', row.id),
      kind: `ticket_${row.kind}`,
      at: Number(row.created_at),
      read: row.read_at != null,
      actor: actorUser ? { id: actorUser.id, name: actorUser.name } : null,
      board: null,
      team: null,
      snippet: content.preview ?? content.detail?.text ?? null,
      target: `/t/${encodeURIComponent(content.ticket.key)}`,
    };
  }

  /**
   * Stores one row for a person and pings their open tabs. Returns null, and records nothing, when the person has switched that
   * kind's group off (docs/notifications.md, Settings). Every writer goes through here.
   * @param {Record<string, any>} fields @param {{ notify?: boolean }} [options]
   */
  function record(fields, { notify = true } = {}) {
    const userId = fields?.userId;
    if (typeof userId !== 'string' || !userId) throw new TypeError('Notification needs a recipient');
    if (!KINDS.has(fields.kind)) throw new TypeError('Unknown notification kind');
    if (!switches.allows(userId, fields.kind)) return null;
    const ref = fields.ref == null ? null : String(fields.ref);
    if (fields.kind === 'chat_mention' && ref !== null) {
      const exists = db.prepare(
        `SELECT 1 FROM user_notifications WHERE user_id = ? AND kind = 'chat_mention' AND ref = ?
          AND board_id IS ? AND team_id IS ? LIMIT 1`,
      ).get(userId, ref, fields.boardId ?? null, fields.teamId ?? null);
      if (exists) return { id: null, created: false };
    }
    const id = newId();
    db.prepare(
      `INSERT INTO user_notifications (id, user_id, kind, actor_id, board_id, team_id, ref, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      fields.kind,
      fields.actorId ?? null,
      fields.boardId ?? null,
      fields.teamId ?? null,
      ref,
      fields.createdAt ?? nowValue(),
      fields.readAt ?? null,
    );
    if (notify) ping(userId);
    return { id, created: true };
  }

  function fetchUserRows(userId, state, { unreadOnly = false, limit = PAGE_BATCH } = {}) {
    const cursor = cursorSql('n_', state.cursor);
    const rows = db.prepare(
      `SELECT id, kind, actor_id, board_id, team_id, ref, created_at, read_at
         FROM user_notifications
        WHERE user_id = ? AND (? = 0 OR read_at IS NULL) ${cursor.sql}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(userId, unreadOnly ? 1 : 0, ...cursor.params, limit);
    if (rows.length) {
      const last = rows[rows.length - 1];
      state.cursor = { createdAt: Number(last.created_at), id: sourceId('n', last.id) };
    }
    if (rows.length < limit) state.done = true;
    return rows;
  }

  function fetchTrackerRows(userId, state, { unreadOnly = false, limit = PAGE_BATCH } = {}) {
    if (!trackerEnabled) {
      state.done = true;
      return [];
    }
    const cursor = cursorSql('t_', state.cursor);
    const rows = db.prepare(
      `SELECT n.id, n.ticket_id, n.event_id, n.kind, n.created_at, n.read_at
         FROM notifications n JOIN tickets t ON t.id = n.ticket_id
        WHERE n.user_id = ? AND n.suppressed_at IS NULL AND (? = 0 OR n.read_at IS NULL) ${cursor.sql.replaceAll('created_at', 'n.created_at').replaceAll("'t_' || id", "'t_' || n.id")}
        ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    ).all(userId, unreadOnly ? 1 : 0, ...cursor.params, limit);
    if (rows.length) {
      const last = rows[rows.length - 1];
      state.cursor = { createdAt: Number(last.created_at), id: sourceId('t', last.id) };
    }
    if (rows.length < limit) state.done = true;
    return rows;
  }

  function readCounts(user) {
    const current = currentUser(directory, user);
    if (!current) return { unread: 0, unreadMentions: 0 };
    const personalState = cursorState(null);
    const trackerState = cursorState(null);
    let visible = [];
    while (visible.length < UNREAD_LIMIT && (!personalState.done || !trackerState.done)) {
      const personal = fetchUserRows(current.id, personalState, { unreadOnly: true });
      const tracker = fetchTrackerRows(current.id, trackerState, { unreadOnly: true });
      const accessiblePersonal = personal.map((row) => userRowItem(current, row)).filter(Boolean);
      const accessibleTracker = tracker.map((row) => ticketItem(current, row)).filter(Boolean);
      visible = mergeNotificationRows(visible, mergeNotificationRows(accessiblePersonal, accessibleTracker), UNREAD_LIMIT);
      if (!personal.length && !tracker.length) break;
    }
    return {
      unread: visible.length,
      unreadMentions: visible.filter((item) => MENTION_KINDS.has(item.kind)).length,
    };
  }

  /** @param {{ user?: any, limit?: number, before?: string | null, unreadOnly?: boolean }} [options] */
  function list({ user, limit = 30, before = null, unreadOnly = false } = {}) {
    const userId = userIdOf(user);
    if (typeof userId !== 'string' || !userId) throw new TypeError('Notifications need a user');
    const current = currentUser(directory, userId);
    if (!current) return { items: [], nextCursor: null, ...readCounts(userId) };
    const cursor = decodeCursor(before);
    const numericLimit = Number(limit);
    const requestedLimit = Number.isFinite(numericLimit) ? Math.floor(numericLimit) : 30;
    const pageLimit = Math.max(1, Math.min(50, requestedLimit));
    const personalState = cursorState(cursor);
    const trackerState = cursorState(cursor);
    let visible = [];
    while (visible.length <= pageLimit && (!personalState.done || !trackerState.done)) {
      const personal = fetchUserRows(current.id, personalState, { unreadOnly });
      const tracker = fetchTrackerRows(current.id, trackerState, { unreadOnly });
      const accessiblePersonal = personal.map((row) => userRowItem(current, row)).filter(Boolean);
      const accessibleTracker = tracker.map((row) => ticketItem(current, row)).filter(Boolean);
      visible = mergeNotificationRows(visible, mergeNotificationRows(accessiblePersonal, accessibleTracker));
      if (!personal.length && !tracker.length) break;
    }
    const hasMore = visible.length > pageLimit;
    const items = visible.slice(0, pageLimit);
    return {
      items,
      nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
      ...readCounts(current.id),
    };
  }

  function ping(user) {
    const userId = userIdOf(user);
    if (typeof userId !== 'string' || !userId) return { unread: 0, unreadMentions: 0 };
    const counts = readCounts(userId);
    try { hub?.notify?.(userId, counts); } catch { /* live delivery cannot undo a stored notification */ }
    return counts;
  }

  /** @param {{ user?: any, ids?: string[], all?: boolean }} [options] */
  function markRead({ user, ids = [], all = false } = {}) {
    const userId = userIdOf(user);
    if (typeof userId !== 'string' || !userId) throw new TypeError('Notifications need a user');
    const at = nowValue();
    let updated = 0;
    if (all) {
      updated += Number(db.prepare('UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId).changes);
      if (trackerEnabled) updated += Number(db.prepare('UPDATE notifications SET read_at = ?, next_email_at = NULL WHERE user_id = ? AND read_at IS NULL').run(at, userId).changes);
    } else {
      const personalIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.startsWith('n_')).map((id) => id.slice(2)).filter(Boolean))];
      const trackerIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.startsWith('t_')).map((id) => id.slice(2)).filter(Boolean))];
      for (let start = 0; start < personalIds.length; start += 100) {
        const batch = personalIds.slice(start, start + 100);
        updated += Number(db.prepare(`UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${batch.map(() => '?').join(', ')})`).run(at, userId, ...batch).changes);
      }
      for (let start = 0; start < trackerIds.length; start += 100) {
        const batch = trackerIds.slice(start, start + 100);
        updated += Number(db.prepare(`UPDATE notifications SET read_at = ?, next_email_at = NULL WHERE user_id = ? AND read_at IS NULL AND id IN (${batch.map(() => '?').join(', ')})`).run(at, userId, ...batch).changes);
      }
    }
    const counts = ping(userId);
    return { updated, ...counts };
  }

  /** @param {string} userId @param {string} kind @param {string} ref @param {number} lastId */
  function markChatReadThrough(userId, kind, ref, lastId) {
    if (typeof userId !== 'string' || !userId || !Number.isSafeInteger(Number(lastId))) return { updated: 0, ...readCounts(userId) };
    const messageId = Math.max(0, Number(lastId));
    const channel = kind === 'board'
      ? { sql: 'board_id = ? AND team_id IS NULL', params: [ref] }
      : kind === 'team'
        ? { sql: 'team_id = ? AND board_id IS NULL', params: [ref] }
        : kind === 'workspace'
          ? { sql: 'board_id IS NULL AND team_id IS NULL', params: [] }
          : null;
    if (!channel) return { updated: 0, ...readCounts(userId) };
    const result = Number(db.prepare(
      `UPDATE user_notifications SET read_at = ?
        WHERE user_id = ? AND kind = 'chat_mention' AND read_at IS NULL
          AND ${channel.sql} AND CAST(ref AS INTEGER) <= ?`,
    ).run(nowValue(), userId, ...channel.params, messageId).changes);
    const counts = result ? ping(userId) : readCounts(userId);
    return { updated: result, ...counts };
  }

  function prune(at = nowValue()) {
    const cutoff = at - 90 * DAY_MS;
    const oldPersonal = Number(db.prepare('DELETE FROM user_notifications WHERE created_at < ?').run(cutoff).changes);
    const oldTracker = Number(db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff).changes);
    const excess = db.prepare(
      `WITH merged AS (
         SELECT 'n' AS source, id, user_id, created_at, (read_at IS NOT NULL) AS read_order, 'n_' || id AS item_id
           FROM user_notifications
         UNION ALL
         SELECT 't' AS source, id, user_id, created_at, (read_at IS NOT NULL OR suppressed_at IS NOT NULL) AS read_order, 't_' || id AS item_id
           FROM notifications
       ), ranked AS (
         SELECT source, id, ROW_NUMBER() OVER (
           PARTITION BY user_id ORDER BY read_order, created_at DESC, item_id DESC
         ) AS position
           FROM merged
       )
       SELECT source, id FROM ranked WHERE position > ?`,
    ).all(KEEP_PER_USER);
    let overflow = 0;
    for (const source of ['n', 't']) {
      const ids = excess.filter((row) => row.source === source).map((row) => row.id);
      const table = source === 'n' ? 'user_notifications' : 'notifications';
      for (let start = 0; start < ids.length; start += 500) {
        const batch = ids.slice(start, start + 500);
        overflow += Number(db.prepare(`DELETE FROM ${table} WHERE id IN (${batch.map(() => '?').join(', ')})`).run(...batch).changes);
      }
    }
    const old = oldPersonal + oldTracker;
    return { old, overflow, deleted: old + overflow };
  }

  return { record, list, unread: readCounts, markRead, markChatReadThrough, prune, ping, prefs: switches };
}
