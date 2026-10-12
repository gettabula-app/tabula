const DAY_MS = 24 * 60 * 60 * 1000;
const TABLES = [
  'tickets', 'trackers', 'ticket_events', 'ticket_comments', 'ticket_aliases', 'ticket_links',
  'kanban_tracker_links', 'ticket_projection_outbox', 'notifications', 'ticket_search', 'ticket_counters',
];

export const FINDING_SEVERITY = Object.freeze({
  counter_below_max: 'error',
  key_mismatch: 'error',
  orphan_event: 'error',
  event_missing: 'warn',
  duplicate_active_link: 'error',
  link_without_board_link: 'error',
  link_to_missing_ticket: 'error',
  alias_collision: 'error',
  fts_missing: 'warn',
  outbox_stale: 'warn',
  check_failed: 'error',
});

const nonNegativeInt = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

function readSchema(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all();
  const names = new Set(rows.map((row) => row.name));
  const columns = new Map();
  for (const name of TABLES) {
    if (!names.has(name)) continue;
    const quoted = `"${name.replaceAll('"', '""')}"`;
    columns.set(name, new Set(db.prepare(`PRAGMA table_info(${quoted})`).all().map((row) => row.name)));
  }
  return { names, columns };
}

function has(schema, requirements) {
  return requirements.every(([table, columns = []]) => schema.names.has(table)
    && columns.every((column) => schema.columns.get(table)?.has(column)));
}

/**
 * Inspect tracker counts and referential invariants without reading any ticket or comment content.
 * Every query is an aggregate, indexed lookup or bounded join over an already-open SQLite connection.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ at?: number }} [opts]
 */
export function checkTrackerData(db, { at = Date.now() } = {}) {
  const counts = new Map();
  const failures = { count: 0 };
  const add = (code, count) => {
    const value = nonNegativeInt(count);
    if (value > 0) counts.set(code, (counts.get(code) ?? 0) + value);
  };

  let schema;
  try {
    schema = readSchema(db);
  } catch {
    return { present: true, summary: null, findings: [{ code: 'check_failed', count: 1 }] };
  }
  if (!schema.names.has('tickets')) return { present: false, summary: null, findings: [] };

  const group = (requirements, query, fallback = 0, onFailure = null) => {
    if (!has(schema, requirements)) return fallback;
    try {
      return query();
    } catch {
      failures.count++;
      onFailure?.();
      return fallback;
    }
  };
  const scalar = (sql, ...params) => nonNegativeInt(db.prepare(sql).get(...params)?.n);
  const addFailureSummary = () => add('check_failed', 1);

  let schemaVersion = 0;
  try {
    schemaVersion = nonNegativeInt(db.prepare('PRAGMA user_version').get()?.user_version);
  } catch {
    addFailureSummary();
  }

  const trackerCount = group([['trackers', ['id']]], () => scalar('SELECT COUNT(*) AS n FROM trackers'), 0, addFailureSummary);
  const ticketCount = group([['tickets', ['id']]], () => scalar('SELECT COUNT(*) AS n FROM tickets'), 0, addFailureSummary);
  const archived = group([['tickets', ['archived_at']]], () => scalar('SELECT COUNT(*) AS n FROM tickets WHERE archived_at IS NOT NULL'), 0, addFailureSummary);

  let events = 0;
  let maxEventId = 0;
  const eventStats = group([['ticket_events', ['id']]], () => {
    const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id FROM ticket_events').get();
    return { count: nonNegativeInt(row?.n), max: nonNegativeInt(row?.max_id) };
  }, null, addFailureSummary);
  if (eventStats) ({ count: events, max: maxEventId } = eventStats);

  const comments = group([['ticket_comments', ['id']]], () => scalar('SELECT COUNT(*) AS n FROM ticket_comments'), 0, addFailureSummary);
  const aliases = group([['ticket_aliases', ['id']]], () => scalar('SELECT COUNT(*) AS n FROM ticket_aliases'), 0, addFailureSummary);
  const links = group([['ticket_links', ['removed_at']]], () => scalar('SELECT COUNT(*) AS n FROM ticket_links WHERE removed_at IS NULL'), 0, addFailureSummary);
  const kanbanLinks = group([['kanban_tracker_links', ['removed_at']]], () => scalar('SELECT COUNT(*) AS n FROM kanban_tracker_links WHERE removed_at IS NULL'), 0, addFailureSummary);
  const outboxPending = group([['ticket_projection_outbox', ['applied_at']]], () => scalar('SELECT COUNT(*) AS n FROM ticket_projection_outbox WHERE applied_at IS NULL'), 0, addFailureSummary);
  const notifications = group([['notifications', ['id']]], () => scalar('SELECT COUNT(*) AS n FROM notifications'), 0, addFailureSummary);

  let ftsQueryFailed = false;
  const ftsRows = group([['ticket_search']], () => scalar('SELECT COUNT(*) AS n FROM ticket_search'), 0, () => {
    ftsQueryFailed = true;
    addFailureSummary();
  });

  const counters = group(
    [['ticket_counters', ['scope', 'prefix', 'next_number']], ['tickets', ['tracker_id', 'prefix', 'number']]],
    () => db.prepare(
      `SELECT c.scope, c.prefix, c.next_number, COALESCE(MAX(t.number), 0) AS max_number
         FROM ticket_counters c
         LEFT JOIN tickets t ON t.tracker_id = c.scope AND t.prefix = c.prefix
        GROUP BY c.scope, c.prefix, c.next_number
        ORDER BY c.scope, c.prefix LIMIT 100`,
    ).all().filter((row) => ['string', 'number'].includes(typeof row.scope) && ['string', 'number'].includes(typeof row.prefix)).map((row) => ({
      scope: String(row.scope),
      prefix: String(row.prefix),
      next: nonNegativeInt(row.next_number),
      maxNumber: nonNegativeInt(row.max_number),
    })),
    [],
    addFailureSummary,
  );

  const summary = {
    schema: schemaVersion,
    trackers: trackerCount,
    tickets: ticketCount,
    archived,
    events,
    maxEventId,
    comments,
    aliases,
    links,
    kanbanLinks,
    outboxPending,
    notifications,
    ftsRows,
    counters,
  };

  const check = (code, requirements, query) => {
    const value = group(requirements, query, 0, addFailureSummary);
    add(code, value);
  };

  check('counter_below_max', [
    ['ticket_counters', ['scope', 'prefix', 'next_number']],
    ['tickets', ['tracker_id', 'prefix', 'number']],
  ], () => scalar(
    `SELECT COUNT(*) AS n FROM ticket_counters c
      WHERE c.next_number <= COALESCE((SELECT MAX(t.number) FROM tickets t
        WHERE t.tracker_id = c.scope AND t.prefix = c.prefix), 0)`,
  ));

  check('key_mismatch', [['tickets', ['key', 'prefix', 'number']]], () => scalar(
    "SELECT COUNT(*) AS n FROM tickets WHERE key != prefix || '-' || number",
  ));

  check('orphan_event', [
    ['ticket_events', ['ticket_id']], ['tickets', ['id']],
  ], () => scalar(
    `SELECT COUNT(*) AS n FROM ticket_events e
      LEFT JOIN tickets t ON t.id = e.ticket_id WHERE t.id IS NULL`,
  ));

  check('event_missing', [
    ['tickets', ['updated_seq']], ['ticket_events', ['id']],
  ], () => scalar(
    `SELECT COUNT(*) AS n FROM tickets t
      LEFT JOIN ticket_events e ON e.id = t.updated_seq WHERE e.id IS NULL`,
  ));

  check('duplicate_active_link', [[
    'ticket_links', ['id', 'board_id', 'kanban_id', 'card_id', 'ticket_id', 'removed_at'],
  ]], () => scalar(
    `SELECT COALESCE(SUM(duplicates), 0) AS n FROM (
       SELECT SUM(n - 1) AS duplicates FROM (
         SELECT COUNT(*) AS n FROM ticket_links WHERE removed_at IS NULL
          GROUP BY board_id, card_id HAVING COUNT(*) > 1
       )
       UNION ALL
       SELECT SUM(n - 1) AS duplicates FROM (
         SELECT COUNT(*) AS n FROM ticket_links WHERE removed_at IS NULL
          GROUP BY kanban_id, ticket_id HAVING COUNT(*) > 1
       )
     )`,
  ));

  check('link_without_board_link', [
    ['ticket_links', ['board_id', 'kanban_id', 'removed_at']],
    ['kanban_tracker_links', ['board_id', 'kanban_id', 'removed_at']],
  ], () => scalar(
    `SELECT COUNT(*) AS n FROM ticket_links l
      WHERE l.removed_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM kanban_tracker_links k
         WHERE k.board_id = l.board_id AND k.kanban_id = l.kanban_id AND k.removed_at IS NULL
      )`,
  ));

  check('link_to_missing_ticket', [
    ['ticket_links', ['ticket_id', 'removed_at']], ['tickets', ['id']],
  ], () => scalar(
    `SELECT COUNT(*) AS n FROM ticket_links l
      LEFT JOIN tickets t ON t.id = l.ticket_id
      WHERE l.removed_at IS NULL AND t.id IS NULL`,
  ));

  check('alias_collision', [
    ['ticket_aliases', ['ticket_id', 'external_id', 'display_key']], ['tickets', ['id', 'key']],
  ], () => scalar(
    `SELECT COUNT(*) AS n FROM ticket_aliases a JOIN tickets canonical
       ON canonical.key = COALESCE(a.display_key, a.external_id) AND canonical.id <> a.ticket_id`,
  ));

  if (has(schema, [['tickets', ['archived_at']]])) {
    const activeTickets = group([['tickets', ['archived_at']]], () => scalar(
      'SELECT COUNT(*) AS n FROM tickets WHERE archived_at IS NULL',
    ), 0, addFailureSummary);
    const canReadFts = schema.names.has('ticket_search');
    if (ftsQueryFailed || !canReadFts) add('fts_missing', Math.max(1, activeTickets - ftsRows));
    else if (ftsRows < activeTickets) add('fts_missing', activeTickets - ftsRows);
  }

  const cutoff = Number.isSafeInteger(at) && at >= 0 ? at - DAY_MS : null;
  if (cutoff !== null) {
    check('outbox_stale', [['ticket_projection_outbox', ['applied_at', 'created_at']]], () => scalar(
      'SELECT COUNT(*) AS n FROM ticket_projection_outbox WHERE applied_at IS NULL AND created_at < ?', cutoff,
    ));
  }

  if (failures.count > 0 && !counts.has('check_failed')) add('check_failed', failures.count);
  return {
    present: true,
    summary,
    findings: [...counts.entries()].filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
  };
}

const SUMMARY_FIELDS = [
  'schema', 'trackers', 'tickets', 'archived', 'events', 'maxEventId', 'comments', 'aliases',
  'links', 'kanbanLinks', 'outboxPending', 'notifications', 'ftsRows',
];

/**
 * The one shape a manifest's `tracker` block may have (docs/tracker-s7.md, 4.2). Used by the writer before sealing and
 * by the parser after unsealing, so what is written always round-trips. It never throws: an unusable block gives null
 * (the block is advisory, a bad one must never make a backup unlistable or unrestorable); single bad entries are skipped.
 * @param {unknown} value
 */
export function sanitizeTrackerBlock(value) {
  try {
    const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const block = /** @type {any} */ (value);
    const checkedAt = count(block.checkedAt);
    if (checkedAt === null || !Array.isArray(block.findings)) return null;
    const findings = [];
    for (const finding of block.findings.slice(0, 20)) {
      const n = count(finding?.count);
      if (typeof finding?.code === 'string' && /^[a-z_]{1,40}$/.test(finding.code) && n !== null) findings.push({ code: finding.code, count: n });
    }
    let summary = null;
    const source = block.summary;
    if (source && typeof source === 'object' && !Array.isArray(source) && SUMMARY_FIELDS.every((field) => count(source[field]) !== null) && Array.isArray(source.counters)) {
      const counters = [];
      for (const row of source.counters) {
        if (counters.length >= 100) break;
        const next = count(row?.next);
        const maxNumber = count(row?.maxNumber);
        if (!row || !['string', 'number'].includes(typeof row.scope) || !['string', 'number'].includes(typeof row.prefix) || next === null || maxNumber === null) continue;
        counters.push({ scope: String(row.scope).slice(0, 128), prefix: String(row.prefix).slice(0, 128), next, maxNumber });
      }
      summary = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, source[field]]));
      summary.counters = counters;
    }
    if (summary === null && !findings.some((finding) => finding.code === 'check_failed')) {
      if (findings.length >= 20) findings.pop();
      findings.push({ code: 'check_failed', count: 1 });
    }
    return { checkedAt, summary, findings };
  } catch {
    return null;
  }
}
