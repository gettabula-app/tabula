export const TRACKER_RESTORE_GATE_KEY = 'tracker.restore_gate';

export function parseRestoreGate(value) {
  let data;
  try { data = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Number.isFinite(data.since) || data.since < 0
    || typeof data.reason !== 'string' || !/^[a-z0-9_]{1,32}$/i.test(data.reason)
    || !['pending', 'known'].includes(data.floor)) return null;
  return { since: data.since, reason: data.reason, floor: data.floor };
}

function dbOf(target) {
  return target?.db ?? target;
}

function getSetting(target, key) {
  try {
    if (typeof target?.getSetting === 'function') return target.getSetting(key);
    return dbOf(target).prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function transaction(target, fn) {
  if (typeof target?.transaction === 'function') return target.transaction(fn);
  const db = dbOf(target);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readRestoreGate(directory) {
  const raw = getSetting(directory, TRACKER_RESTORE_GATE_KEY);
  return raw == null ? null : parseRestoreGate(raw);
}

/** Mark an existing, valid gate's floor known after the owner's explicit epoch jump. */
export function markGateFloorKnown(directory) {
  const gate = readRestoreGate(directory);
  if (!gate) return false;
  transaction(directory, () => {
    const value = JSON.stringify({ ...gate, floor: 'known' });
    if (typeof directory?.setSetting === 'function') directory.setSetting(TRACKER_RESTORE_GATE_KEY, value);
    else dbOf(directory).prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(TRACKER_RESTORE_GATE_KEY, value);
  });
  return true;
}

/**
 * Clear the restore gate only after its floor, projection reconcile and FTS index are ready.
 * @param {any} directory
 * @param {any} [state]
 * @param {any} [audit]
 */
export function maybeClearGate(directory, { floorKnown, reconcileDone, ftsReady, now = Date.now } = {}, audit = () => {}) {
  if (floorKnown !== true || reconcileDone !== true || ftsReady !== true) return false;
  let cleared = false;
  transaction(directory, () => {
    const gate = readRestoreGate(directory);
    if (!gate) return;
    const closedSeconds = Math.max(0, Math.floor((now() - gate.since) / 1000));
    dbOf(directory).prepare('DELETE FROM settings WHERE key = ?').run(TRACKER_RESTORE_GATE_KEY);
    audit('tracker.gate_cleared', { closedSeconds });
    cleared = true;
  });
  return cleared;
}
