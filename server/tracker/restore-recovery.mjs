import { drainTicketProjection, reconcileTrackerProjection } from './projection.mjs';
import { refreshTicketSearch } from './search.mjs';
import { TICKET_SEARCH_DDL } from '../directory.mjs';
import { maybeClearGate, readRestoreGate } from './gate.mjs';

const BATCH_SIZE = 500;
const BOARDS_PER_SECOND = 50;
const RESTORE_STATUS_KEY = 'restore.status';
const RECONCILE_DONE_KEY = 'tracker.reconcile_done';
const FTS_READY_KEY = 'tracker.fts_ready';
const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeCount = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

function setting(directory, key) {
  try { return directory.getSetting(key); } catch { return null; }
}

function hasTable(db, name) {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function ftsCounts(directory) {
  const db = directory.db;
  const active = safeCount(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE archived_at IS NULL').get()?.n);
  let rows = 0;
  let countFailed = false;
  if (hasTable(db, 'ticket_search')) {
    try { rows = safeCount(db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get()?.n); } catch { countFailed = true; }
  }
  let integrity = false;
  if (hasTable(db, 'ticket_search') && !countFailed) {
    try {
      directory.transaction(() => db.prepare("INSERT INTO ticket_search(ticket_search) VALUES ('integrity-check')").run());
      integrity = true;
    } catch {
      integrity = false;
    }
  }
  return { active, rows, integrity: integrity && !countFailed };
}

async function rebuildFts(directory, refreshSearch, sleep) {
  const db = directory.db;
  directory.transaction(() => {
    if (hasTable(db, 'ticket_search')) db.exec('DROP TABLE ticket_search');
    db.exec(TICKET_SEARCH_DDL);
  });

  let cursor = null;
  while (true) {
    const ids = db.prepare(
      `SELECT id FROM tickets WHERE archived_at IS NULL AND (? IS NULL OR id > ?)
        ORDER BY id LIMIT ?`,
    ).all(cursor, cursor, BATCH_SIZE).map((row) => row.id);
    if (!ids.length) break;
    directory.transaction(() => {
      for (const id of ids) refreshSearch(db, id);
    });
    cursor = ids.at(-1);
    // Let the relay serve sockets and health checks between batches: a big rebuild must not stall the event loop.
    await sleep(0);
  }
  const result = ftsCounts(directory);
  if (!result.integrity || result.rows < result.active) throw new Error('fts_rebuild_failed');
  return result;
}

function readRecord(directory) {
  try {
    const value = JSON.parse(setting(directory, RESTORE_STATUS_KEY) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function updateRestoreRecord(directory, { counts, ftsRepaired }) {
  let record = null;
  directory.transaction(() => {
    record = readRecord(directory);
    if (!record || record.kind !== 'workspace' || record.result !== 'done' || !record.tracker) return;
    const repaired = { ...record.tracker.repaired };
    if (ftsRepaired > 0) repaired.fts_missing = safeCount(ftsRepaired);
    record.tracker = { ...record.tracker, ...counts, repaired };
    directory.setSetting(RESTORE_STATUS_KEY, JSON.stringify(record));
  });
  return record;
}

/**
 * Resume the post-restore FTS and board reconciliation work while tracker writes remain gated.
 * All progress flags are settings, so another process start safely resumes incomplete work.
 * @param {any} [options]
 */
export function createTrackerRestoreRecovery({
  directory,
  roomAccess,
  baseUrl = 'http://localhost',
  now = Date.now,
  sleep = DEFAULT_SLEEP,
  log = () => {},
  reconcile = reconcileTrackerProjection,
  drain = drainTicketProjection,
  refreshSearch = refreshTicketSearch,
  clearGate = maybeClearGate,
} = {}) {
  if (!directory?.db || typeof directory.db.prepare !== 'function') throw new TypeError('Tracker restore recovery requires an open directory');
  let running = null;

  async function run() {
    const gate = readRestoreGate(directory);
    if (!gate || !hasTable(directory.db, 'tickets')) return { skipped: true };

    directory.db.prepare('DELETE FROM settings WHERE key = ? OR key = ?').run(RECONCILE_DONE_KEY, FTS_READY_KEY);
    let ftsReady = false;
    let ftsRepaired = 0;
    try {
      const before = ftsCounts(directory);
      if (before.rows < before.active || !before.integrity) {
        const after = await rebuildFts(directory, refreshSearch, sleep);
        ftsRepaired = Math.max(1, before.active - before.rows);
        ftsReady = after.rows >= after.active && after.integrity;
      } else {
        ftsReady = true;
      }
      if (ftsReady) directory.setSetting(FTS_READY_KEY, '1');
    } catch {
      log('tracker restore recovery: fts_rebuild_failed=1');
    }

    const counts = { boardsReconciled: 0, cardsStripped: 0, cardsRepaired: 0, unlinked: 0, boardsFailed: 0 };
    let boards = [];
    let listFailed = false;
    try {
      boards = directory.db.prepare(
        'SELECT DISTINCT board_id FROM kanban_tracker_links WHERE removed_at IS NULL ORDER BY board_id',
      ).all().map((row) => row.board_id).filter((boardId) => typeof boardId === 'string');
    } catch {
      counts.boardsFailed = 1;
      listFailed = true;
      log('tracker restore recovery: board_list_failed=1');
    }

    let windowStart = now();
    let inWindow = 0;
    for (const boardId of boards) {
      let instant = now();
      if (instant < windowStart || instant - windowStart >= 1000) {
        windowStart = instant;
        inWindow = 0;
      }
      if (inWindow >= BOARDS_PER_SECOND) {
        await sleep(Math.max(1, windowStart + 1000 - instant));
        instant = now();
        windowStart = instant;
        inWindow = 0;
      }
      inWindow++;

      try {
        const beforeLinks = safeCount(directory.db.prepare(
          'SELECT COUNT(*) AS n FROM ticket_links WHERE board_id = ? AND removed_at IS NULL',
        ).get(boardId)?.n);
        const result = reconcile({ directory, roomAccess, boardId, baseUrl, now: now(), mode: 'sql-wins' }) ?? {};
        counts.cardsStripped += safeCount(result.stripped);
        counts.cardsRepaired += safeCount(result.repaired);
        const afterLinks = safeCount(directory.db.prepare(
          'SELECT COUNT(*) AS n FROM ticket_links WHERE board_id = ? AND removed_at IS NULL',
        ).get(boardId)?.n);
        counts.unlinked += Math.max(0, beforeLinks - afterLinks);

        let attempts = 0;
        let pending = true;
        while (pending && attempts < 1000) {
          const resultOfDrain = drain({ directory, roomAccess, boardId, baseUrl, now: now() }) ?? {};
          pending = resultOfDrain.projectionPending === true;
          if (pending && safeCount(resultOfDrain.applied) === 0) break;
          attempts++;
        }
        if (pending) throw new Error('projection_pending');
        counts.boardsReconciled++;
      } catch {
        counts.boardsFailed++;
        log(`tracker restore recovery: boards_failed=${counts.boardsFailed}`);
      }
    }

    // A board that fails to open is counted (restore record) and picks up its correction when it is next opened; it does not freeze the whole tracker.
    const reconcileDone = !listFailed;
    if (reconcileDone) directory.setSetting(RECONCILE_DONE_KEY, '1');
    const currentGate = readRestoreGate(directory);
    const gateCleared = clearGate(directory, {
      floorKnown: currentGate?.floor === 'known',
      reconcileDone,
      ftsReady,
      now,
    }, (action, detail) => directory.audit(null, action, detail));

    updateRestoreRecord(directory, { counts, ftsRepaired });
    // One audit row with the count only, never board ids.
    if (counts.boardsFailed > 0) directory.audit(null, 'tracker.restore_boards_failed', { count: counts.boardsFailed });
    return { ...counts, ftsReady, ftsRepaired, floor: currentGate?.floor ?? gate.floor, gateCleared };
  }

  function start() {
    if (running) return running;
    running = run().catch(() => {
      log('tracker restore recovery: failed=1');
      return { failed: true };
    }).finally(() => { running = null; });
    return running;
  }

  return { run, start, isRunning: () => running !== null };
}
