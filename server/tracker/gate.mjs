export const TRACKER_RESTORE_GATE_KEY = 'tracker.restore_gate';
const TRACKER_RESTORE_GATE_TTL_MS = 1000;
const gateCache = new WeakMap();

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

function cacheKey(target) {
  const db = dbOf(target);
  return db && (typeof db === 'object' || typeof db === 'function') ? db : target;
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

/** Serialize the stable settings value used by parseRestoreGate, including by staged restore transactions. */
/** @param {{ since: number, reason?: string, floor: 'pending' | 'known' }} input */
export function restoreGateValue({ since, reason = 'restore', floor } = {}) {
  const gate = parseRestoreGate({ since, reason, floor });
  if (!gate) throw new TypeError('Invalid tracker restore gate');
  return JSON.stringify(gate);
}

/** Invalidate the short-lived gate cache after a setting mutation. */
export function invalidateTrackerGateCache(target) {
  const key = cacheKey(target);
  if (key && (typeof key === 'object' || typeof key === 'function')) gateCache.delete(key);
}

/** Read the restore gate with a short cache for the socket guard's per-message check. */
export function trackerGateState(directory, { now = Date.now } = {}) {
  const key = cacheKey(directory);
  if (!key || (typeof key !== 'object' && typeof key !== 'function')) return { closed: false, floor: null };
  const instant = now();
  const cached = gateCache.get(key);
  if (cached && instant >= cached.at && instant - cached.at < TRACKER_RESTORE_GATE_TTL_MS) return cached.state;
  const gate = readRestoreGate(directory);
  const state = gate ? { closed: true, floor: gate.floor, since: gate.since, reason: gate.reason } : { closed: false, floor: null };
  gateCache.set(key, { at: instant, state });
  return state;
}

/** Set the live restore gate. Staged restore code uses restoreGateValue and writes its own open transaction. */
/** @param {{ since: number, reason?: string, floor: 'pending' | 'known' }} value */
export function setRestoreGate(directory, value) {
  const serialized = restoreGateValue(value);
  transaction(directory, () => {
    if (typeof directory?.setSetting === 'function') directory.setSetting(TRACKER_RESTORE_GATE_KEY, serialized);
    else dbOf(directory).prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(TRACKER_RESTORE_GATE_KEY, serialized);
  });
  invalidateTrackerGateCache(directory);
  return parseRestoreGate(serialized);
}

/** Mark an existing, valid gate's floor known after the owner's explicit epoch jump. */
export function markGateFloorKnown(directory) {
  const gate = readRestoreGate(directory);
  if (!gate) return false;
  transaction(directory, () => {
    const value = restoreGateValue({ ...gate, floor: 'known' });
    if (typeof directory?.setSetting === 'function') directory.setSetting(TRACKER_RESTORE_GATE_KEY, value);
    else dbOf(directory).prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(TRACKER_RESTORE_GATE_KEY, value);
  });
  invalidateTrackerGateCache(directory);
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
  if (cleared) invalidateTrackerGateCache(directory);
  return cleared;
}
