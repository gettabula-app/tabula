import { ticketAccess } from './access.mjs';
import { actorInfo, getDb, invalid, limitExceeded, OpsError, utcStartOfDay, validCalendarDate } from './shared.mjs';

const COMMENT_COUNT_LIMIT = 10_000;
const INDEX_BYTES_LIMIT = 64 * 1024;
const PAGE_MAX = 50;

export function buildFtsQuery(query) {
  const terms = query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

function titleFtsQuery(query) {
  const terms = query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  return terms.length ? `title : (${terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ')})` : '';
}

function boundedText(value, maxBytes) {
  let bytes = 0;
  let out = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += character;
  }
  return out;
}

function fitComments(db, ticketId, maxBytes) {
  const rows = db.prepare(
    `SELECT body FROM ticket_comments WHERE ticket_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(ticketId, COMMENT_COUNT_LIMIT);
  const selected = [];
  let bytes = 0;
  for (const row of rows) {
    const body = String(row.body);
    const size = Buffer.byteLength(body, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    selected.push(body);
  }
  return selected.reverse().join('\n\n');
}

/** Rebuild one FTS row from canonical ticket data; invoke in the source mutation transaction. */
export function refreshTicketSearch(dbOrContext, ticketId) {
  const db = getDb(dbOrContext?.db || dbOrContext?.directory
    ? { db: dbOrContext.db, directory: dbOrContext.directory }
    : { db: dbOrContext });
  const ticket = db.prepare('SELECT id, key, title, description FROM tickets WHERE id = ?').get(ticketId);
  db.prepare('DELETE FROM ticket_search WHERE ticket_id = ?').run(ticketId);
  if (!ticket) return;
  const aliases = db.prepare(
    'SELECT external_id, display_key FROM ticket_aliases WHERE ticket_id = ? ORDER BY provider, external_id',
  ).all(ticketId);
  const aliasText = aliases.flatMap((row) => [row.display_key, row.external_id]).filter(Boolean).join(' ');
  let remaining = INDEX_BYTES_LIMIT;
  const title = boundedText(ticket.title, remaining);
  remaining -= Buffer.byteLength(title, 'utf8');
  const identifiers = boundedText(ticket.key, remaining);
  remaining -= Buffer.byteLength(identifiers, 'utf8');
  const description = boundedText(ticket.description, remaining);
  remaining -= Buffer.byteLength(description, 'utf8');
  const indexedAliases = boundedText(aliasText, remaining);
  remaining -= Buffer.byteLength(indexedAliases, 'utf8');
  db.prepare(
    `INSERT INTO ticket_search (ticket_id, title, description, comments, identifiers, aliases)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ticketId, title, description, fitComments(db, ticketId, remaining), identifiers, indexedAliases);
}

function invalidFilter(token, message = `Invalid filter: ${token}`) {
  throw new OpsError('invalid_filter', message, token);
}

function resolveMember(db, token) {
  const rows = db.prepare(
    `SELECT id FROM users WHERE disabled = 0 AND role IN ('owner', 'admin', 'member')
      AND (name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) ORDER BY id`,
  ).all(token, token);
  if (rows.length > 1) invalidFilter(token, `Ambiguous assignee filter: ${token}`);
  return rows[0]?.id ?? null;
}

function addParsedFilter(db, actor, token, now, clauses, params, canSee) {
  const colon = token.indexOf(':');
  if (colon < 1) invalidFilter(token);
  const field = token.slice(0, colon).toLowerCase();
  const value = token.slice(colon + 1).trim();
  if (!value && field !== 'is') invalidFilter(token);
  switch (field) {
    case 'assignee': {
      if (!canSee) {
        clauses.push('0 = 1');
        return;
      }
      if (value.toLowerCase() === 'me') {
        const userId = actorInfo(actor).userId;
        if (!userId) clauses.push('0 = 1');
        else { clauses.push('t.assignee_user_id = ?'); params.push(userId); }
        return;
      }
      if (value.length > 200) invalidFilter(token);
      const userId = resolveMember(db, value);
      if (!userId) clauses.push('0 = 1');
      else { clauses.push('t.assignee_user_id = ?'); params.push(userId); }
      return;
    }
    case 'state':
      clauses.push(`EXISTS (
        SELECT 1 FROM ticket_states fs WHERE fs.id = t.state_id AND fs.archived_at IS NULL
          AND (fs.state_key = ? COLLATE NOCASE OR fs.name = ? COLLATE NOCASE)
      )`);
      params.push(value, value);
      return;
    case 'label':
      clauses.push(`EXISTS (
        SELECT 1 FROM ticket_labels fl JOIN labels fLabel ON fLabel.id = fl.label_id
        WHERE fl.ticket_id = t.id AND fLabel.archived_at IS NULL AND fLabel.name = ? COLLATE NOCASE
      )`);
      params.push(value);
      return;
    case 'due': {
      // Slice 1 limitation: workspace time zones are not modeled yet, so due:today uses UTC.
      const today = new Date(now).toISOString().slice(0, 10);
      if (value === 'overdue') {
        clauses.push(`t.due_date < ? AND t.archived_at IS NULL AND fs.category NOT IN ('completed', 'canceled')`);
        params.push(today);
        return;
      }
      if (value === 'today') {
        clauses.push('t.due_date = ?');
        params.push(today);
        return;
      }
      if (value.startsWith('before-')) {
        const date = value.slice('before-'.length);
        if (!validCalendarDate(date)) invalidFilter(token);
        clauses.push('t.due_date < ?');
        params.push(date);
        return;
      }
      invalidFilter(token);
      break;
    }
    case 'has':
      if (value !== 'link') invalidFilter(token);
      clauses.push('0 = 1');
      return;
    case 'is':
      if (value !== 'archived') invalidFilter(token);
      clauses.push('t.archived_at IS NOT NULL');
      return;
    case 'created': {
      if (!value.startsWith('after-')) invalidFilter(token);
      const date = value.slice('after-'.length);
      if (!validCalendarDate(date)) invalidFilter(token);
      clauses.push('t.created_at >= ?');
      params.push(utcStartOfDay(date));
      return;
    }
    case 'project':
    case 'milestone':
      invalidFilter(token, `${field} filters are not available yet`);
      return;
    default:
      invalidFilter(token);
  }
}

function visible(actor) {
  try {
    ticketAccess(actor, { id: 'visibility-check' });
    return true;
  } catch {
    return false;
  }
}

function parseCursor(cursor, query, filters) {
  if (cursor == null) return null;
  if (typeof cursor !== 'string' || cursor.length > 2048) throw invalid('cursor', 'Invalid cursor');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.query !== query || JSON.stringify(value.filters) !== JSON.stringify(filters) ||
      !Number.isInteger(value.rank) || value.rank < 0 || value.rank > 4 ||
      !Number.isFinite(value.updatedAt) || typeof value.id !== 'string') throw new Error('bad cursor');
    return value;
  } catch {
    throw invalid('cursor', 'Invalid or mismatched cursor');
  }
}

function makeCursor(row, query, filters) {
  return Buffer.from(JSON.stringify({ query, filters, rank: row.rank_bucket, updatedAt: row.updated_at, id: row.id })).toString('base64url');
}

function likePrefix(value) {
  return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function makeRankedCte({ query, filters, actor, db, now, useFts }) {
  const termsQuery = buildFtsQuery(query);
  const titleQuery = titleFtsQuery(query);
  const rawQuery = query.trim();
  const canSee = visible(actor);
  const clauses = [canSee ? '1 = 1' : '0 = 1'];
  const filterParams = [];
  for (const token of filters) addParsedFilter(db, actor, token, now, clauses, filterParams, canSee);
  if (!filters.some((filter) => filter.toLowerCase() === 'is:archived')) clauses.push('t.archived_at IS NULL');
  const rank = useFts ? `CASE
    WHEN lower(t.key) = lower(?) OR EXISTS (
      SELECT 1 FROM ticket_aliases exactAlias WHERE exactAlias.ticket_id = t.id
        AND (lower(exactAlias.external_id) = lower(?) OR lower(COALESCE(exactAlias.display_key, '')) = lower(?))
    ) THEN 0
    WHEN lower(t.title) LIKE lower(?) ESCAPE '\\' THEN 1
    WHEN title_matches.rowid IS NOT NULL THEN 2
    ELSE 3 END` : '0';
  const rankParams = useFts ? [rawQuery, rawQuery, rawQuery, likePrefix(rawQuery)] : [];
  const ftsCtes = useFts
    ? 'matched AS (SELECT rowid, ticket_id FROM ticket_search WHERE ticket_search MATCH ?), title_matches AS (SELECT rowid FROM ticket_search WHERE ticket_search MATCH ?),'
    : '';
  const ftsParams = useFts ? [termsQuery, titleQuery] : [];
  const joins = useFts ? 'JOIN matched ON matched.ticket_id = t.id JOIN ticket_search ON ticket_search.rowid = matched.rowid LEFT JOIN title_matches ON title_matches.rowid = matched.rowid' : '';
  const sql = `WITH ${ftsCtes} ranked AS (
    SELECT t.id, t.key, t.title, t.description, t.state_id, t.assignee_user_id, t.project_id, t.milestone_id,
      t.due_date, t.created_at, t.updated_at, t.updated_seq, t.archived_at,
      fs.state_key, fs.name AS state_name, fs.category, au.name AS assignee_name,
      ${rank} AS rank_bucket${useFts ? ', ticket_search.rowid AS search_rowid' : ', NULL AS search_rowid'}
    FROM tickets t
    JOIN ticket_states fs ON fs.id = t.state_id
    LEFT JOIN users au ON au.id = t.assignee_user_id
    ${joins}
    WHERE ${clauses.join(' AND ')}
  )`;
  return { sql, params: [...ftsParams, ...rankParams, ...filterParams], rawQuery, termsQuery, useFts };
}

/** @param {any} options */
export function searchTickets({ directory, db: dbArg, actor, query = '', filters = [], limit = 20, cursor = null, now = Date.now() } = {}) {
  const db = getDb({ directory, db: dbArg });
  if (typeof query !== 'string') throw invalid('query', 'Must be text');
  if (Array.from(query).length > 512) throw limitExceeded('Search query is limited to 512 characters', 'query');
  if (!Array.isArray(filters) || filters.some((filter) => typeof filter !== 'string')) throw invalid('filters', 'Filters must be a list of text tokens');
  if (filters.length > 20) throw limitExceeded('Search allows at most 20 filters', 'filters');
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw invalid('limit', `Must be 1 to ${PAGE_MAX}`);
  const normalizedQuery = query.trim();
  const normalizedFilters = filters.map((filter) => filter.trim());
  const terms = buildFtsQuery(normalizedQuery);
  const cte = makeRankedCte({ query: normalizedQuery, filters: normalizedFilters, actor, db, now, useFts: Boolean(terms) });
  const parsedCursor = parseCursor(cursor, normalizedQuery, normalizedFilters);
  const total = Number(db.prepare(`${cte.sql} SELECT COUNT(*) AS n FROM ranked`).get(...cte.params).n);

  const pageClause = parsedCursor
    ? 'AND (rank_bucket > ? OR (rank_bucket = ? AND (updated_at < ? OR (updated_at = ? AND id > ?))))'
    : '';
  const pageParams = parsedCursor
    ? [parsedCursor.rank, parsedCursor.rank, parsedCursor.updatedAt, parsedCursor.updatedAt, parsedCursor.id]
    : [];
  const rows = db.prepare(
    `${cte.sql}
     SELECT ranked.*, ${cte.useFts ? "snippet(ticket_search, -1, '<mark>', '</mark>', '…', 16)" : 'NULL'} AS snippet
     FROM ranked ${cte.useFts ? 'JOIN ticket_search ON ticket_search.rowid = ranked.search_rowid' : ''}
     ${cte.useFts ? 'WHERE ticket_search MATCH ?' : ''}
     ${pageClause}
     ORDER BY rank_bucket ASC, updated_at DESC, id ASC LIMIT ?`,
  ).all(...cte.params, ...(cte.useFts ? [cte.termsQuery] : []), ...pageParams, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    entries: page.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      state: { key: row.state_key, name: row.state_name, category: row.category },
      assignee: row.assignee_user_id ? { userId: row.assignee_user_id, name: row.assignee_name } : null,
      project: null,
      due: row.due_date,
      archivedAt: row.archived_at,
      updatedAt: row.updated_at,
      updatedSeq: row.updated_seq,
      snippet: row.snippet,
    })),
    total,
    next: hasMore && page.length ? makeCursor(page[page.length - 1], normalizedQuery, normalizedFilters) : null,
  };
}

/** @param {any} options */
export function listTickets(options = {}) {
  return searchTickets({ ...options, query: '' });
}

export const SEARCH_LIMITS = Object.freeze({ queryCodePoints: 512, filters: 20, page: PAGE_MAX, comments: COMMENT_COUNT_LIMIT, textBytes: INDEX_BYTES_LIMIT });
