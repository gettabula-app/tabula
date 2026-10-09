// The chat REST API (docs/chat.md, API), registered by api.mjs in accounts mode when TABULA_CHAT=on. Writes are
// ordinary API calls, so they get the CSRF header, the body limit, the session and the hosted read-only 402 from
// dispatch. Author, time and order come from the session and the server; a request body names only the text and
// what it points at. A channel the caller cannot read is a 404, never a 403.

import { CHAT_KINDS } from './chat-access.mjs';
import { CHAT_SETTING_KEYS, RETENTION_CHOICES, readChatSettings } from './chat.mjs';
import { checkText, isClientId, isObjectId, resolveMentions } from './chat-text.mjs';

export const CHAT_BODY_LIMIT = 16 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const ID_RE = /^[1-9]\d{0,14}$/;
const SETTINGS_FIELDS = ['viewersMayPost', 'retentionDays'];
const FORMER_MEMBER = 'Former member';

const TEXT_ERRORS = {
  empty: 'A message needs at least one character that is not a space',
  too_long: 'A message can be at most 2000 characters',
  too_many_mentions: 'A message can mention at most 10 people',
};

/**
 * @param {object} deps
 * @param {any} deps.directory
 * @param {() => ReturnType<typeof import('./chat.mjs').openChat>} deps.store the chat database, opened on first use
 * @param {(user: any, kind: unknown, ref: unknown) => import('./chat-access.mjs').ChatAccess | null} deps.access
 * @param {{ publish: Function, read: Function } | null} deps.hub
 * @param {ReturnType<typeof import('./chat-limits.mjs').createChatLimits>} deps.limits
 * @param {Function} deps.compile
 * @param {Function} deps.audit
 * @param {Function} deps.requireAdmin
 * @param {{ HttpError: any, badRequest: Function, forbidden: Function, notFound: Function, conflict: Function }} deps.errors
 */
export function createChatRoutes({ directory, store, access, hub, limits, compile, audit, requireAdmin, errors }) {
  const { HttpError, badRequest, forbidden, notFound, conflict } = errors;
  const hidden = () => notFound('Channel not found');

  /** The channel named in a URL, or 404. */
  function channelFor(user, kind, ref) {
    if (!CHAT_KINDS.includes(kind)) throw hidden();
    const can = access(user, kind, ref);
    if (!can?.read) throw hidden();
    return can;
  }

  /** A message by the id in a URL, with the caller's access to its channel; 404 when either is missing. */
  function messageFor(user, rawId) {
    const message = ID_RE.test(rawId) ? store().getMessage(Number(rawId)) : null;
    const can = message ? access(user, message.kind, message.ref) : null;
    if (!message || !can?.read) throw notFound('Message not found');
    return { message, can };
  }

  // dispatch answers 402 before a handler runs; the check here covers a switch that flipped while the body arrived
  const requireWrite = (can) => {
    if (can.write) return;
    if (can.readOnly) throw new HttpError(402, 'read_only', 'This workspace is read-only. Ask the workspace owner to check billing.');
    if (can.role === 'viewer') throw new HttpError(403, 'read_only_viewer', 'Viewers cannot post in this chat');
    throw forbidden('You cannot post in this chat');
  };

  function limited(res, wait) {
    res.setHeader('retry-after', String(wait));
    const err = new HttpError(429, 'rate_limited', 'Slow down a moment');
    err.extra = { retryAfter: wait };
    return err;
  }

  /** Normalised text with its mentions resolved for this channel, or the 400 that says why not. */
  function textFor(value, kind, ref) {
    const checked = checkText(value);
    if ('error' in checked) throw new HttpError(400, checked.error, TEXT_ERRORS[checked.error]);
    const mayRead = (userId) => access(directory.getUser(userId), kind, ref)?.read === true;
    const resolved = resolveMentions(checked.text, mayRead);
    if ('error' in resolved) throw new HttpError(400, resolved.error, TEXT_ERRORS[resolved.error]);
    return resolved;
  }

  /** A message as the API and the socket show it: live names, no text once deleted. */
  function viewer() {
    const names = new Map();
    const nameOf = (id) => {
      if (!names.has(id)) names.set(id, directory.getUser(id)?.name ?? null);
      return names.get(id);
    };
    return (m) => {
      const deleted = m.deletedAt !== null;
      const authorName = m.authorId ? (nameOf(m.authorId) ?? m.authorName) : (m.authorName || FORMER_MEMBER);
      return {
        id: m.id,
        kind: m.kind,
        ref: m.ref,
        authorId: m.authorId,
        authorName,
        clientId: m.clientId,
        text: deleted ? '' : m.body,
        replyTo: m.replyTo,
        objectId: m.objectId,
        mentions: deleted ? [] : m.mentions.map((id) => ({ id, name: nameOf(id) })),
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        deleted,
        deletedBy: deleted ? (m.deletedBy !== null && m.deletedBy === m.authorId ? 'author' : 'moderator') : null,
      };
    };
  }
  const view = (m) => viewer()(m);

  const publish = (kind, ref, frame, options) => {
    try {
      hub?.publish(kind, ref, frame, options);
    } catch (err) {
      console.error('chat: could not deliver an event:', err?.code ?? err?.message ?? 'error');
    }
  };

  function parseLimit(raw) {
    if (raw === null || raw === '') return PAGE_DEFAULT;
    if (!/^\d{1,4}$/.test(raw)) throw badRequest('limit must be a whole number');
    return Math.min(Math.max(Number(raw), 1), PAGE_MAX);
  }

  return [
    // The channel's metadata for the interface (docs/chat.md, Mentions): what the caller may do in it, and the people
    // who can read it (the `@` list). Names only, never email; a hidden channel is the same 404 as everywhere else.
    // Counted before the access check, so asking about channels one cannot read is slowed down the same way; a 429 says
    // nothing about any channel.
    compile('GET', 'chat/:kind/:ref', {}, ({ res, user, params }) => {
      const { kind, ref } = params;
      const wait = limits.channelInfo(user.id);
      if (wait) throw limited(res, wait);
      const can = channelFor(user, kind, ref);
      const people = directory
        .listUsers()
        .filter((u) => !u.disabled && access(u, kind, ref)?.read === true)
        .map((u) => ({ id: u.id, name: u.name }));
      return [200, {
        kind,
        ref,
        access: { write: can.write, moderate: can.moderate, role: can.role, readOnly: can.readOnly },
        people,
      }];
    }),

    compile('GET', 'chat/:kind/:ref/messages', {}, ({ user, params, query }) => {
      channelFor(user, params.kind, params.ref);
      const before = query.get('before');
      if (before !== null && before !== '' && !ID_RE.test(before)) throw badRequest('before must be a message id');
      const page = store().listMessages(params.kind, params.ref, { before: before ? Number(before) : null, limit: parseLimit(query.get('limit')) });
      const show = viewer();
      return [200, { messages: page.messages.map(show), next: page.next }];
    }),

    compile('POST', 'chat/:kind/:ref/messages', { body: true, maxBody: CHAT_BODY_LIMIT }, ({ res, user, params, body }) => {
      const { kind, ref } = params;
      const can = channelFor(user, kind, ref);
      if (!isClientId(body.clientId)) throw badRequest('clientId must be 8 to 64 letters, digits, - or _');
      // A retried send answers with what was stored the first time, whatever else changed since.
      const stored = store().findByClientId(kind, ref, user.id, body.clientId);
      if (stored) return [200, { message: view(stored) }];
      requireWrite(can);
      const { text, mentions } = textFor(body.text, kind, ref);
      let replyTo = null;
      if (body.replyTo !== undefined && body.replyTo !== null) {
        const target = Number.isSafeInteger(body.replyTo) && body.replyTo > 0 ? store().getMessage(body.replyTo) : null;
        if (!target || target.kind !== kind || target.ref !== ref) throw badRequest('replyTo must be a message in this channel');
        replyTo = target.id;
      }
      let objectId = null;
      if (body.objectId !== undefined && body.objectId !== null) {
        if (kind !== 'board' || !isObjectId(body.objectId)) throw badRequest('objectId must be the id of an object on this board');
        objectId = body.objectId;
      }
      // Counted once the request is known to be good, so a refused one never adds to the wait.
      const wait = limits.post(user.id, `${kind}/${ref}`);
      if (wait) throw limited(res, wait);
      const { message, created } = store().insertMessage({
        kind, ref, authorId: user.id, authorName: user.name, body: text, replyTo, objectId, clientId: body.clientId, mentions,
      });
      const shown = view(message);
      if (created) publish(kind, ref, { t: 'message', kind, ref, message: shown }, { authorId: user.id });
      return [created ? 201 : 200, { message: shown }];
    }),

    compile('PATCH', 'chat/messages/:id', { body: true, maxBody: CHAT_BODY_LIMIT }, ({ res, user, params, body }) => {
      const { message, can } = messageFor(user, params.id);
      if (message.authorId !== user.id) throw new HttpError(403, 'not_author', 'Only the author can edit a message');
      if (message.deletedAt !== null) throw conflict('deleted', 'This message was deleted');
      requireWrite(can);
      const { text, mentions } = textFor(body.text, message.kind, message.ref);
      if (text === message.body) return [200, { message: view(message) }];
      const wait = limits.change(user.id);
      if (wait) throw limited(res, wait);
      const edited = store().editMessage(message.id, text, mentions);
      const shown = view(edited);
      publish(message.kind, message.ref, { t: 'edit', kind: message.kind, ref: message.ref, message: shown }, { authorId: user.id });
      return [200, { message: shown }];
    }),

    compile('DELETE', 'chat/messages/:id', {}, ({ res, user, params }) => {
      const { message, can } = messageFor(user, params.id);
      const own = message.authorId === user.id;
      if (!own && !can.moderate) throw forbidden('Only the author or a moderator can delete a message');
      if (message.deletedAt !== null) return [204];
      const wait = limits.change(user.id);
      if (wait) throw limited(res, wait);
      store().deleteMessage(message.id, user.id);
      // A moderator's delete is on the record; an author removing their own words is not. Ids only, never text.
      if (!own) audit(user, 'chat.delete', { kind: message.kind, ref: message.ref, messageId: message.id, authorId: message.authorId });
      const by = own ? 'author' : 'moderator';
      publish(message.kind, message.ref, { t: 'delete', kind: message.kind, ref: message.ref, id: message.id, by }, { authorId: message.authorId });
      return [204];
    }),

    // A read marker is the person's own state, not workspace content, so it works while the workspace is read-only.
    compile('PUT', 'chat/:kind/:ref/read', { body: true, readOnlyOk: true }, ({ res, user, params, body }) => {
      const { kind, ref } = params;
      const wait = limits.read(user.id);
      if (wait) throw limited(res, wait);
      channelFor(user, kind, ref);
      if (!Number.isSafeInteger(body.lastId) || body.lastId < 0) throw badRequest('lastId must be a message id');
      const lastId = store().markRead(user.id, kind, ref, body.lastId);
      try {
        hub?.read(user.id, kind, ref, lastId);
      } catch (err) {
        console.error('chat: could not mirror a read marker:', err?.code ?? err?.message ?? 'error');
      }
      return [200, { kind, ref, lastId }];
    }),

    compile('GET', 'chat/unread', {}, ({ res, user }) => {
      const wait = limits.unread(user.id);
      if (wait) throw limited(res, wait);
      return [200, { channels: unreadSummary({ directory, store, user }) }];
    }),

    compile('GET', 'admin/chat', {}, ({ user }) => {
      requireAdmin(user);
      return [200, readChatSettings(directory)];
    }),
    compile('PUT', 'admin/chat', { body: true }, ({ user, body }) => {
      requireAdmin(user);
      for (const key of Object.keys(body)) {
        if (!SETTINGS_FIELDS.includes(key)) throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
      }
      const patch = {};
      if (body.viewersMayPost !== undefined) {
        if (typeof body.viewersMayPost !== 'boolean') throw badRequest('viewersMayPost must be a boolean');
        patch.viewersMayPost = body.viewersMayPost;
      }
      if (body.retentionDays !== undefined) {
        if (!RETENTION_CHOICES.includes(body.retentionDays)) throw badRequest('retentionDays must be 365, 90, 30 or null (forever)');
        patch.retentionDays = body.retentionDays;
      }
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      directory.transaction(() => {
        if (patch.viewersMayPost !== undefined) directory.setSetting(CHAT_SETTING_KEYS.viewersMayPost, patch.viewersMayPost ? '1' : '0');
        if (patch.retentionDays !== undefined) directory.setSetting(CHAT_SETTING_KEYS.retentionDays, patch.retentionDays ?? 'forever');
        audit(user, 'chat.settings', patch);
      });
      return [200, readChatSettings(directory)];
    }),
  ];
}

/** The unread summary of a person: board channels they can read with something unread. Shared with the hub. */
export function unreadSummary({ directory, store, user }) {
  const refs = directory.listBoardsFor(user).map((b) => b.id);
  return store().unreadSummary(user.id, 'board', refs);
}
