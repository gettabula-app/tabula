// Mentions in comments (TAB-53). A comment is plain text; a mention is the token `@{<userId>}`, the same token chat uses
// (chat-text.mjs). A mention records one `comment_mention` row for each person it names who can open the board. The
// ledger row carries ids only (the thread is the ref); the text is read again when the row is shown, and only for a
// person who passes the access check then.

import { mentionIds, MAX_MENTIONS } from './chat-text.mjs';

/** The people a comment names, as recorded: distinct, never the author, at most MAX_MENTIONS. */
export function commentMentionIds(text, authorId) {
  if (typeof text !== 'string') return [];
  return mentionIds(text).filter((id) => id !== authorId).slice(0, MAX_MENTIONS);
}

/** Whether a person may get a mention on this board: they exist and have a role on it, so they can open it. */
export function canReceiveMention(directory, boardId, userId) {
  return directory.getUser(userId) != null && directory.boardRole(boardId, userId) !== null;
}

/** Whether this comment names `recipientId` in a way that produces a mention row for them. */
export function mentionsRecipient({ directory, boardId, text, authorId, recipientId }) {
  return commentMentionIds(text, authorId).includes(recipientId) && canReceiveMention(directory, boardId, recipientId);
}

/**
 * Records a comment_mention row for each person the comment names who can open the board. Never throws: a failed
 * notification must not undo an accepted comment.
 * @param {{ directory: any, notifications: any, log?: (...args: unknown[]) => void, boardId: string, threadId: string, authorId: string, text: unknown }} options
 */
export function recordCommentMentions({ directory, notifications, log = () => {}, boardId, threadId, authorId, text }) {
  if (!notifications || typeof notifications.record !== 'function') return;
  for (const userId of commentMentionIds(text, authorId)) {
    try {
      if (!canReceiveMention(directory, boardId, userId)) continue;
      notifications.record({ userId, kind: 'comment_mention', actorId: authorId, boardId, ref: threadId });
    } catch (err) {
      log('comments: could not store a mention notification', err?.message);
    }
  }
}

/**
 * The keys of a comments document as it is now: threadId -> the ids of its replies. Used to find the comments a write
 * added when the write did not go through the comment guard (the MCP path).
 * @param {any} doc
 */
export function commentIndex(doc) {
  const index = new Map();
  doc.getMap('threads').forEach((thread, threadId) => {
    const replies = typeof thread?.get === 'function' ? thread.get('replies') : null;
    index.set(String(threadId), new Set(replies?.keys ? [...replies.keys()].map(String) : []));
  });
  return index;
}

/**
 * The comments by `actorId` that are new since `index` was taken: a new thread (replyId null) and each new reply.
 * Imported and legacy comments are not new comments by the actor, so they are left out.
 * @param {Map<string, Set<string>>} index
 * @param {any} doc
 * @param {string} actorId
 * @returns {Array<{ threadId: string, replyId: string | null, text: unknown }>}
 */
export function commentsAddedSince(index, doc, actorId) {
  const added = [];
  const mine = (c) => c && typeof c === 'object' && c.authorId === actorId && c.imported !== true && c.legacy !== true;
  doc.getMap('threads').forEach((thread, threadId) => {
    if (typeof thread?.get !== 'function') return;
    const key = String(threadId);
    const seen = index.get(key);
    const replies = thread.get('replies');
    const keys = replies?.keys ? [...replies.keys()].map(String) : [];
    const fresh = keys.filter((k) => !seen?.has(k));
    if (seen && !fresh.length) return;
    const json = thread.toJSON();
    if (!seen && mine(json)) added.push({ threadId: key, replyId: null, text: json.text });
    for (const replyId of fresh) {
      const reply = json.replies?.[replyId];
      if (mine(reply)) added.push({ threadId: key, replyId, text: reply.text });
    }
  });
  return added;
}
