import { ticketAccess } from './access.mjs';
import { OpsError } from './shared.mjs';
import {
  commentTicket, createTicket, getTicket, listLabels, listStates, listTickets, searchTickets,
  transitionTicket, updateTicket,
} from './tickets.mjs';
import { isSubscribed, subscribeTicket, unsubscribeTicket } from './subscriptions.mjs';

const ACCESS_CHECK = Object.freeze({ id: 'tracker-access-check' });
const COMMENT_PAGE = 50;
const EVENT_PAGE = 50;
const MAX_DETAIL_PAGE = 100;

const actorFor = (user) => ({ type: 'user', userId: user.id, user });
const querySingle = (query, name) => {
  const values = query.getAll(name);
  if (values.length > 1) throw new OpsError('invalid_input', 'Must be supplied once', name);
  return values[0];
};

function allowFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new OpsError('invalid_input', 'Unsupported field', key);
  }
}

function positiveLimit(query, fallback = 20, max = 50) {
  const raw = querySingle(query, 'limit');
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new OpsError('invalid_input', `Must be 1 to ${max}`, 'limit');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OpsError('invalid_input', `Must be 1 to ${max}`, 'limit');
  }
  if (value > max) throw new OpsError('limit_exceeded', `Must be 1 to ${max}`, 'limit');
  return value;
}

function integerQuery(query, name) {
  const raw = querySingle(query, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new OpsError('invalid_input', 'Must be a non-negative whole number', name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new OpsError('invalid_input', 'Must be a non-negative whole number', name);
  return value;
}

function ticketReference(directory, value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 128) {
    throw new OpsError('invalid_input', 'Must be a ticket key or alias', 'key');
  }
  const key = value.trim();
  const direct = directory.db.prepare('SELECT key FROM tickets WHERE key = ? COLLATE NOCASE').get(key);
  if (direct) return { key: direct.key };
  const alias = directory.db.prepare(
    `SELECT t.key FROM ticket_aliases a JOIN tickets t ON t.id = a.ticket_id
      WHERE lower(a.external_id) = lower(?) OR lower(COALESCE(a.display_key, '')) = lower(?)
      ORDER BY a.provider, a.external_id LIMIT 1`,
  ).get(key, key);
  if (!alias) throw new OpsError('not_found', 'Ticket not found');
  return { key: alias.key, resolvedKey: alias.key };
}

function commentView(row) {
  return { id: row.id, author: row.author, body: row.body, createdAt: row.createdAt };
}

function parseJson(value) {
  try { return value == null ? null : JSON.parse(value); } catch { return null; }
}

function eventView(row) {
  return {
    eventSeq: row.id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    actor: { type: row.actor_type, id: row.actor_id },
    source: row.source,
    createdAt: row.created_at,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    details: parseJson(row.details_json),
  };
}

function commentPage(directory, ticketId, { before, limit = COMMENT_PAGE } = {}) {
  const db = directory.db;
  let beforeRow = null;
  if (before !== undefined) {
    if (typeof before !== 'string' || !before || before.length > 128) {
      throw new OpsError('invalid_input', 'Must be a comment id', 'before');
    }
    beforeRow = db.prepare(
      'SELECT id, created_at FROM ticket_comments WHERE id = ? AND ticket_id = ? AND deleted_at IS NULL',
    ).get(before, ticketId);
    if (!beforeRow) throw new OpsError('invalid_input', 'Must identify a comment on this ticket', 'before');
  }
  const rows = db.prepare(
    `SELECT id, author_snapshot AS author, body, created_at AS createdAt FROM ticket_comments
      WHERE ticket_id = ? AND deleted_at IS NULL
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(ticketId, beforeRow?.created_at ?? null, beforeRow?.created_at ?? null, beforeRow?.created_at ?? null, beforeRow?.id ?? null, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextBefore = hasMore ? page.at(-1)?.id ?? null : null;
  return {
    items: page.reverse().map(commentView),
    nextBefore,
  };
}

function eventPage(directory, ticketId, { before, limit = EVENT_PAGE } = {}) {
  const db = directory.db;
  let beforeId = null;
  if (before !== undefined) {
    if (!/^\d+$/.test(before)) throw new OpsError('invalid_input', 'Must be an event id', 'before');
    beforeId = Number(before);
    if (!Number.isSafeInteger(beforeId) || beforeId < 1) throw new OpsError('invalid_input', 'Must be an event id', 'before');
    if (!db.prepare('SELECT 1 FROM ticket_events WHERE id = ? AND ticket_id = ?').get(beforeId, ticketId)) {
      throw new OpsError('invalid_input', 'Must identify an event on this ticket', 'before');
    }
  }
  const rows = db.prepare(
    `SELECT id, event_type, schema_version, actor_type, actor_id, source, created_at,
            before_json, after_json, details_json FROM ticket_events
      WHERE ticket_id = ? AND (? IS NULL OR id < ?)
      ORDER BY id DESC LIMIT ?`,
  ).all(ticketId, beforeId, beforeId, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextBefore = hasMore ? String(page.at(-1)?.id ?? '') || null : null;
  return {
    items: page.reverse().map(eventView),
    nextBefore,
  };
}

function assigneeForId(directory, value, path = 'assigneeId') {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) throw new OpsError('invalid_input', 'Must be an active workspace member id or null', path);
  const member = directory.db.prepare(
    "SELECT email FROM users WHERE id = ? AND role IN ('owner', 'admin', 'member') AND disabled = 0",
  ).get(value);
  if (!member) throw new OpsError('invalid_input', 'Must identify an active workspace member', path);
  return member.email;
}

function normalizeAssignee(directory, body, path = '') {
  const hasName = Object.hasOwn(body, 'assignee');
  const hasId = Object.hasOwn(body, 'assigneeId');
  if (hasName && hasId) throw new OpsError('invalid_input', 'Use either assignee or assigneeId, not both', `${path}assigneeId`);
  const normalized = { ...body };
  if (hasId) {
    normalized.assignee = assigneeForId(directory, body.assigneeId, `${path}assigneeId`);
    delete normalized.assigneeId;
  }
  return normalized;
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/u).filter(Boolean);
  if (!parts.length) return '?';
  const raw = parts.length === 1 ? Array.from(parts[0])[0] : `${Array.from(parts[0])[0]}${Array.from(parts.at(-1))[0]}`;
  return Array.from(raw.toLocaleUpperCase()).slice(0, 2).join('');
}

function actorName(db, row) {
  if (row.actor_type === 'user') {
    return db.prepare('SELECT name FROM users WHERE id = ?').get(row.actor_id)?.name ?? 'Former member';
  }
  if (row.actor_type === 'mcp_token') {
    const ownerUserId = parseJson(row.details_json)?.ownerUserId;
    return ownerUserId ? db.prepare('SELECT name FROM users WHERE id = ?').get(ownerUserId)?.name ?? 'MCP token' : 'MCP token';
  }
  if (row.actor_type === 'system') return 'System';
  return 'Integration';
}

function withCurrentTicketOnConflict(directory, actor, key, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof OpsError && error.code === 'conflict') {
      try { error.ticket = getTicket({ directory, actor, key }); } catch { /* keep the original conflict */ }
    }
    throw error;
  }
}

function feedEvents(directory, actor, since) {
  const db = directory.db;
  const seq = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS seq FROM ticket_events').get().seq);
  if (since === undefined || since === 0) return { events: [], seq };

  const events = [];
  let cursor = since;
  while (events.length < 201) {
    const rows = db.prepare(
      `SELECT e.id, e.ticket_id, e.event_type, e.actor_type, e.actor_id, e.created_at,
              e.details_json, t.key AS ticket_key
         FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
        WHERE e.id > ? ORDER BY e.id LIMIT 256`,
    ).all(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Number(row.id);
      try {
        ticketAccess(actor, { id: row.ticket_id });
      } catch {
        continue;
      }
      events.push({
        id: Number(row.id),
        ticketKey: row.ticket_key,
        eventType: row.event_type,
        at: row.created_at,
        actor: { type: row.actor_type, id: row.actor_id, name: actorName(db, row) },
      });
      if (events.length >= 201) break;
    }
    if (rows.length < 256) break;
  }
  return { events: events.slice(0, 200), seq };
}

/** @param {any} options */
export function createTrackerRoutes({ directory, compile, audit, cloud = null, now = Date.now } = {}) {
  const currentReadOnly = () => cloud?.limits().readOnly === true;
  const routes = [];

  routes.push(compile('GET', 'tracker/meta', { tracker: true }, ({ user }) => {
    const actor = actorFor(user);
    const tracker = directory.db.prepare('SELECT id, prefix FROM trackers ORDER BY created_at, id LIMIT 1').get();
    const states = listStates({ directory, actor }).map(({ id, key, name, category, position }) => ({ id, key, name, category, position }));
    const labels = listLabels({ directory, actor }).map(({ id, name, color }) => ({ id, name, color }));
    const members = directory.db.prepare(
      "SELECT id, name FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0 ORDER BY name COLLATE NOCASE, id",
    ).all().map((member) => ({ userId: member.id, name: member.name, initials: initials(member.name) }));
    return [200, {
      enabled: true,
      trackerId: tracker?.id ?? null,
      prefix: tracker?.prefix ?? null,
      states,
      labels,
      members,
      me: { userId: user.id, canWrite: ticketAccess(actor, ACCESS_CHECK) === 'write' && !currentReadOnly() },
    }];
  }));

  routes.push(compile('GET', 'tracker/tickets', { tracker: true }, ({ user, query }) => {
    const actor = actorFor(user);
    const updatedSince = integerQuery(query, 'updatedSince');
    if (updatedSince !== undefined) {
      const seq = Number(directory.db.prepare('SELECT COALESCE(MAX(updated_seq), 0) AS seq FROM tickets').get().seq);
      const rows = directory.db.prepare(
        'SELECT key FROM tickets WHERE updated_seq > ? ORDER BY updated_seq, id LIMIT 201',
      ).all(updatedSince);
      const more = rows.length > 200;
      const tickets = rows.slice(0, 200).map((row) => getTicket({ directory, actor, key: row.key }));
      return [200, { tickets, seq, ...(more ? { more: true } : {}) }];
    }
    const rawQuery = querySingle(query, 'q');
    const limit = positiveLimit(query);
    const cursor = querySingle(query, 'cursor') ?? null;
    const options = { directory, actor, filters: query.getAll('filter'), limit, cursor, now: now() };
    const result = rawQuery === undefined
      ? listTickets(options)
      : searchTickets({ ...options, query: rawQuery });
    return [200, { tickets: result.entries, nextCursor: result.next }];
  }));

  routes.push(compile('POST', 'tracker/tickets', { tracker: true, trackerMutation: true, body: true }, ({ user, body }) => {
    allowFields(body, new Set(['title', 'description', 'state', 'priority', 'assignee', 'assigneeId', 'labels', 'due', 'parent', 'idempotencyKey']));
    if (typeof body.idempotencyKey !== 'string' || Array.from(body.idempotencyKey).length < 8 || Array.from(body.idempotencyKey).length > 64) {
      throw new OpsError('invalid_input', 'Must be 8 to 64 characters', 'idempotencyKey');
    }
    const input = normalizeAssignee(directory, body);
    const ticket = directory.transaction(() => {
      const created = createTicket({
        ...input, directory, actor: actorFor(user), source: 'api', readOnly: currentReadOnly, now: now(),
      });
      audit(user, 'tracker.ticket.create', { ticketId: created.id });
      return created;
    });
    return [201, { ticket }];
  }));

  routes.push(compile('GET', 'tracker/tickets/:key', { tracker: true }, ({ user, params }) => {
    const actor = actorFor(user);
    const ref = ticketReference(directory, params.key);
    const ticket = getTicket({ directory, actor, key: ref.key });
    const comments = commentPage(directory, ticket.id).items;
    const events = eventPage(directory, ticket.id).items;
    return [200, {
      ticket,
      comments,
      events,
      subscribed: isSubscribed({ directory, actor, key: ticket.key }),
      ...(ref.resolvedKey ? { resolvedKey: ref.resolvedKey } : {}),
    }];
  }));

  routes.push(compile('GET', 'tracker/tickets/:key/comments', { tracker: true }, ({ user, params, query }) => {
    const actor = actorFor(user);
    const { key } = ticketReference(directory, params.key);
    const ticket = getTicket({ directory, actor, key });
    const page = commentPage(directory, ticket.id, { before: querySingle(query, 'before'), limit: positiveLimit(query, COMMENT_PAGE, MAX_DETAIL_PAGE) });
    return [200, { comments: page.items, nextBefore: page.nextBefore }];
  }));

  routes.push(compile('GET', 'tracker/tickets/:key/events', { tracker: true }, ({ user, params, query }) => {
    const actor = actorFor(user);
    const { key } = ticketReference(directory, params.key);
    const ticket = getTicket({ directory, actor, key });
    const page = eventPage(directory, ticket.id, { before: querySingle(query, 'before'), limit: positiveLimit(query, EVENT_PAGE, MAX_DETAIL_PAGE) });
    return [200, { events: page.items, nextBefore: page.nextBefore }];
  }));

  routes.push(compile('PATCH', 'tracker/tickets/:key', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    const allowed = new Set(['title', 'description', 'priority', 'assignee', 'assigneeId', 'labels', 'due', 'parent', 'archived', 'ifUpdatedSeq']);
    allowFields(body, allowed);
    const normalized = normalizeAssignee(directory, body);
    const { key } = ticketReference(directory, params.key);
    const patch = Object.fromEntries(
      ['title', 'description', 'priority', 'assignee', 'labels', 'due', 'parent', 'archived']
        .filter((field) => Object.hasOwn(normalized, field)).map((field) => [field, normalized[field]]),
    );
    const actor = actorFor(user);
    const ticket = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
        const updated = updateTicket({
          directory, actor, key, patch, ifUpdatedSeq: body.ifUpdatedSeq,
          source: 'api', readOnly: currentReadOnly, now: now(),
        });
        audit(user, 'tracker.ticket.update', { ticketId: updated.id });
        return updated;
      }));
    return [200, { ticket }];
  }));

  routes.push(compile('POST', 'tracker/tickets/:key/transition', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['state']));
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const ticket = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const changed = transitionTicket({ directory, actor, key, state: body.state, source: 'api', readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.ticket.transition', { ticketId: changed.id });
      return changed;
    }));
    return [200, { ticket }];
  }));

  routes.push(compile('POST', 'tracker/tickets/:key/comments', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['body', 'clientId']));
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const result = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const comment = commentTicket({ directory, actor, key, body: body.body, clientId: body.clientId, source: 'api', readOnly: currentReadOnly, now: now() });
      const ticket = getTicket({ directory, actor, key });
      audit(user, 'tracker.ticket.comment', { ticketId: ticket.id, commentId: comment.id });
      return { comment: commentView({ id: comment.id, author: comment.author, body: comment.body, createdAt: comment.createdAt }), ticket };
    }));
    return [201, result];
  }));

  routes.push(compile('PUT', 'tracker/tickets/:key/subscription', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const subscribed = directory.transaction(() => {
      const wasSubscribed = isSubscribed({ directory, actor, key });
      subscribeTicket({ directory, actor, key, now: now(), readOnly: currentReadOnly });
      if (!wasSubscribed) audit(user, 'tracker.ticket.subscribe', { ticketId: getTicket({ directory, actor, key }).id });
      return true;
    });
    return [200, { subscribed }];
  }));

  routes.push(compile('DELETE', 'tracker/tickets/:key/subscription', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const subscribed = directory.transaction(() => {
      const wasSubscribed = isSubscribed({ directory, actor, key });
      unsubscribeTicket({ directory, actor, key, readOnly: currentReadOnly });
      if (wasSubscribed) audit(user, 'tracker.ticket.unsubscribe', { ticketId: getTicket({ directory, actor, key }).id });
      return false;
    });
    return [200, { subscribed }];
  }));

  routes.push(compile('GET', 'tracker/feed', { tracker: true }, ({ user, query }) => {
    const since = integerQuery(query, 'since');
    return [200, feedEvents(directory, actorFor(user), since)];
  }));

  return routes;
}
