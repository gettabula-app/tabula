import { actorInfo, getDb, invalid } from './shared.mjs';

const EVENT_TYPES = new Set([
  'created', 'updated', 'transitioned', 'commented', 'comment_edited', 'comment_deleted',
  'archived', 'restored', 'related', 'unrelated', 'unlinked',
]);
const CHANGE_FIELDS = new Set(['title', 'description', 'state', 'priority', 'assignee', 'labels', 'due', 'parent', 'project', 'milestone', 'relations', 'archived']);
const DETAIL_FIELDS = new Set(['commentId', 'length', 'ownerUserId', 'tokenName', 'relatedTicketKey', 'relationKind', 'batchId', 'reason']);

function changedFields(value, path) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid(path, 'Must be an object of changed fields');
  for (const field of Object.keys(value)) if (!CHANGE_FIELDS.has(field)) throw invalid(`${path}.${field}`, 'Unsupported event field');
  return JSON.stringify(value);
}

function detailsJson(details, ownerUserId, tokenName) {
  const payload = {};
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    for (const [key, value] of Object.entries(details)) if (DETAIL_FIELDS.has(key)) payload[key] = value;
  }
  if (ownerUserId) payload.ownerUserId = ownerUserId;
  if (tokenName) payload.tokenName = tokenName;
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > 16 * 1024) throw invalid('details', 'Event details are too large');
  return json;
}

/**
 * Event details as a REST or MCP reader may see them. The token name is kept in the stored record for the workspace's own
 * records and is never sent to a client (TAB-330, the security ticket on what members see).
 */
export function publicEventDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details) || !('tokenName' in details)) return details;
  const copy = { ...details };
  delete copy.tokenName;
  return copy;
}

/** Append one schema-versioned ticket event. Call inside the ticket mutation transaction. */
/** @param {any} options */
export function appendTicketEvent({
  directory,
  db,
  ticketId,
  eventType,
  actor,
  source = 'app',
  idempotencyKey = null,
  createdAt = Date.now(),
  before = null,
  after = null,
  details = {},
}) {
  if (!EVENT_TYPES.has(eventType)) throw invalid('eventType', 'Unsupported ticket event type');
  if (typeof ticketId !== 'string' || !ticketId) throw invalid('ticketId', 'Must identify a ticket');
  if (typeof source !== 'string' || !source.trim() || source.length > 40) throw invalid('source', 'Invalid event source');
  if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 64)) {
    throw invalid('idempotencyKey', 'Must be 8 to 64 characters');
  }
  const info = actorInfo(actor);
  if (info.type !== 'system' && !info.id) throw invalid('actor.id', 'Actor id is required');
  const conn = getDb({ directory, db });
  const result = conn.prepare(
    `INSERT INTO ticket_events
      (ticket_id, event_type, schema_version, actor_type, actor_id, source, idempotency_key,
       created_at, before_json, after_json, details_json)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ticketId,
    eventType,
    info.type,
    info.id,
    source,
    idempotencyKey,
    createdAt,
    changedFields(before, 'before'),
    changedFields(after, 'after'),
    detailsJson(details, info.type === 'mcp_token' ? info.userId : null, info.type === 'mcp_token' ? info.tokenName : null),
  );
  return Number(result.lastInsertRowid);
}

export const TICKET_EVENT_TYPES = Object.freeze([...EVENT_TYPES]);
