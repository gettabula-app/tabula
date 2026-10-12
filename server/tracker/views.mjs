import { ticketAccess } from './access.mjs';
import { listTickets } from './tickets.mjs';
import {
  actorInfo, cleanText, forbidden, getDb, inTransaction, invalid, limitExceeded, newId, notFound, requireWritable,
} from './shared.mjs';

const VIEW_LIMIT = 100;
const QUERY_BYTES_LIMIT = 8 * 1024;
const DEFAULT_SORT = 'updated_desc';
const SORTS = new Set([DEFAULT_SORT]);
const TRACKER_CHECK = Object.freeze({ id: 'tracker-access-check' });

function requireRead(actor) {
  ticketAccess(actor, TRACKER_CHECK);
}

function requireWrite(actor) {
  if (ticketAccess(actor, TRACKER_CHECK) !== 'write') throw forbidden('This tracker is read-only for this actor.');
}

function validateFilters(db, actor, filter) {
  if (filter === undefined) return [];
  if (!Array.isArray(filter) || filter.some((token) => typeof token !== 'string')) {
    throw invalid('filter', 'Must be a list of filter tokens');
  }
  if (filter.length > 20) throw limitExceeded('Search allows at most 20 filters', 'filter');
  const normalized = filter.map((token) => token.trim());
  // Run the same command path that accepts list_tickets filters. Its parser executes before any page is returned;
  // this call is intentionally read-only and the result is discarded.
  listTickets({ db, actor, filters: normalized, limit: 1 });
  return normalized;
}

function viewQuery(filter, sort = DEFAULT_SORT) {
  const query = { filter, sort };
  const json = JSON.stringify(query);
  if (Buffer.byteLength(json, 'utf8') > QUERY_BYTES_LIMIT) throw limitExceeded('Saved view query is limited to 8 KB', 'filter');
  return json;
}

function parseQuery(row) {
  try {
    const query = JSON.parse(row.query_json);
    if (!query || typeof query !== 'object' || Array.isArray(query) || !Array.isArray(query.filter) || !SORTS.has(query.sort)) {
      throw new Error('bad saved view query');
    }
    return query;
  } catch {
    throw invalid('viewId', 'Saved view query is invalid');
  }
}

function viewJson(row) {
  const query = parseQuery(row);
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    filter: query.filter,
    sort: query.sort,
    shared: Boolean(row.is_shared),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actorUserId(actor) {
  return actorInfo(actor).userId;
}

function viewRow(db, viewId) {
  if (typeof viewId !== 'string' || !viewId.trim()) return null;
  return db.prepare('SELECT * FROM saved_views WHERE id = ?').get(viewId.trim()) ?? null;
}

function accessibleView(db, actor, viewId) {
  const row = viewRow(db, viewId);
  const userId = actorUserId(actor);
  if (!row || (row.owner_user_id !== userId && !row.is_shared)) throw notFound('Saved view not found', 'viewId');
  return row;
}

/** @param {any} options */
export function createSavedView({ directory, db: dbArg, actor, name, filter = [], shared = false, sort = DEFAULT_SORT, readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  requireWrite(actor);
  if (typeof shared !== 'boolean') throw invalid('shared', 'Must be true or false');
  if (!SORTS.has(sort)) throw invalid('sort', `Must be ${DEFAULT_SORT}`);
  const cleanName = cleanText(name, { path: 'name', min: 1, max: 80, singleLine: true });
  const db = getDb({ directory, db: dbArg });
  const filters = validateFilters(db, actor, filter);
  const queryJson = viewQuery(filters, sort);
  const ownerId = actorUserId(actor);
  if (!ownerId) throw invalid('actor', 'A saved view requires a workspace member account');
  return inTransaction({ directory, db }, () => {
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM saved_views WHERE owner_user_id = ?').get(ownerId).n) >= VIEW_LIMIT) {
      throw limitExceeded(`A member can have at most ${VIEW_LIMIT} saved views`, 'name');
    }
    const id = newId();
    db.prepare(
      `INSERT INTO saved_views (id, owner_user_id, name, query_json, is_shared, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ownerId, cleanName, queryJson, shared ? 1 : 0, now, now);
    return viewJson(viewRow(db, id));
  });
}

/** @param {any} options */
export function listSavedViews({ directory, db: dbArg, actor } = {}) {
  requireRead(actor);
  const db = getDb({ directory, db: dbArg });
  const userId = actorUserId(actor);
  return db.prepare(
    `SELECT * FROM saved_views WHERE owner_user_id = ? OR is_shared = 1
      ORDER BY name COLLATE NOCASE, id`,
  ).all(userId).map(viewJson);
}

/** @param {any} options */
export function getSavedView({ directory, db: dbArg, actor, viewId, limit = 20, cursor = null, now = Date.now() } = {}) {
  requireRead(actor);
  const db = getDb({ directory, db: dbArg });
  const row = accessibleView(db, actor, viewId);
  const query = parseQuery(row);
  const result = listTickets({ db, actor, filters: query.filter, limit, cursor, now });
  return { view: viewJson(row), tickets: result.entries, nextCursor: result.next };
}

/** @param {any} options */
export function updateSavedView({ directory, db: dbArg, actor, viewId, patch, readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  requireWrite(actor);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('patch', 'Must be an object');
  const allowed = new Set(['name', 'filter', 'shared', 'sort']);
  for (const field of Object.keys(patch)) if (!allowed.has(field)) throw invalid(`patch.${field}`, 'Unsupported saved view field');
  if (patch.shared !== undefined && typeof patch.shared !== 'boolean') throw invalid('patch.shared', 'Must be true or false');
  if (patch.sort !== undefined && !SORTS.has(patch.sort)) throw invalid('patch.sort', `Must be ${DEFAULT_SORT}`);
  const db = getDb({ directory, db: dbArg });
  return inTransaction({ directory, db }, () => {
    const row = accessibleView(db, actor, viewId);
    if (row.owner_user_id !== actorUserId(actor)) {
      throw forbidden('Only the owner can update a saved view.');
    }
    const prior = parseQuery(row);
    const name = patch.name === undefined ? row.name : cleanText(patch.name, { path: 'patch.name', min: 1, max: 80, singleLine: true });
    const filter = patch.filter === undefined ? prior.filter : validateFilters(db, actor, patch.filter);
    const sort = patch.sort === undefined ? prior.sort : patch.sort;
    const queryJson = viewQuery(filter, sort);
    const shared = patch.shared === undefined ? row.is_shared : (patch.shared ? 1 : 0);
    if (name === row.name && queryJson === row.query_json && shared === row.is_shared) return viewJson(row);
    db.prepare('UPDATE saved_views SET name = ?, query_json = ?, is_shared = ?, updated_at = ? WHERE id = ?')
      .run(name, queryJson, shared, now, row.id);
    return viewJson(viewRow(db, row.id));
  });
}

/** @param {any} options */
export function deleteSavedView({ directory, db: dbArg, actor, viewId, readOnly = () => false } = {}) {
  requireWritable(readOnly);
  requireWrite(actor);
  const db = getDb({ directory, db: dbArg });
  return inTransaction({ directory, db }, () => {
    const row = accessibleView(db, actor, viewId);
    if (row.owner_user_id !== actorUserId(actor)) {
      throw forbidden('Only the owner can delete a saved view.');
    }
    db.prepare('DELETE FROM saved_views WHERE id = ?').run(row.id);
    return { id: row.id, deleted: true };
  });
}

export const SAVED_VIEW_LIMITS = Object.freeze({ nameCodePoints: 80, queryBytes: QUERY_BYTES_LIMIT, perUser: VIEW_LIMIT, sort: [...SORTS] });
