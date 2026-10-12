// Bounds on the /sync socket (docs/capacity.md, "Sync limits"): frame size, frame rate, document size, sockets per
// person or address, and upgrades per address. Every number is generous on purpose: a real person drawing, typing,
// dragging many objects or pasting a large board stays far below all of them. Pure helpers with injectable clocks;
// server/relay.mjs holds the state and applies them.
import { parseSize } from './config.mjs';

const MiB = 1024 * 1024;

// --- frame size (Room.onMessage, before anything is decoded or applied) ---
// The WebSocket maxPayload is the owner limit. Images are board assets, not document content, so a legitimate update is
// small. Measured (docs/capacity.md): a 5,000-object board with 200-character texts encodes to 2.4 MiB, a drawing-heavy one
// to 16.5 MiB, 5,000 objects at 4,000 characters to 20.6 MiB. An import or a history restore is ONE transaction, hence one
// frame, for an editor too, so editors get more than 4x the largest measured (96 MiB) and owners and open mode 128 MiB.
export const MAX_FRAME_BYTES_OWNER = 128 * MiB;
export const MAX_FRAME_BYTES_OTHER = 96 * MiB;
// Comments rooms hold short threads; nobody needs a big frame there, whatever the role.
export const MAX_FRAME_BYTES_COMMENTS = 1 * MiB;
export const CLOSE_FRAME_TOO_BIG = 1009; // the standard "message too big" code

// --- document size (checked on the encoded state, see createDocSizeGuard) ---
// A very large board is a few MiB encoded and the heaviest measured one 16.5 MiB; 256 MiB leaves 15x over that. TABULA_SYNC_MAX_DOC_BYTES
// overrides it (bytes, or a K/M/G suffix; 0 turns the cap off).
export const DEFAULT_MAX_DOC_BYTES = 256 * MiB;
// The encoded size is measured again only after this much update traffic has been accepted since the last measurement.
export const DOC_RECHECK_BYTES = 1 * MiB;
// A room over its cap still takes small frames (deleting content to get back under, typing) and refuses bigger ones.
export const OVER_CAP_MAX_FRAME_BYTES = 8 * 1024;
export const CLOSE_DOC_TOO_LARGE = 4413; // reason 'document_too_large'

// --- frame rate per socket ---
// SyncStep1 (a state-vector request; each reply is a full state diff) is tight; updates are generous (fast drawing at
// 60 Hz plus a multi-object drag stays far below 200 per second; the burst absorbs a paste that emits one update per object).
export const STEP1_BURST = 20;
export const STEP1_PER_SECOND = 5;
export const UPDATE_BURST = 500;
export const UPDATE_PER_SECOND = 200;
// Frames over the limit are dropped; this long without a break and the socket is closed.
export const ABUSE_CLOSE_MS = 10_000;
// A break this long without any dropped frame ends the run.
export const ABUSE_RESET_MS = 1_000;
export const CLOSE_RATE_LIMITED = 4429; // reason 'rate_limited'

// --- sockets and upgrades ---
// A person has several tabs, two rooms each (board and comments).
export const MAX_SOCKETS_PER_USER = 40;
// Guests and open mode count per client address; schools share one address, so this is wider.
export const MAX_SOCKETS_PER_ADDRESS = 400;
export const CLOSE_TOO_MANY_SOCKETS = 4430; // reason 'too_many_connections'
// Per signed-in account (or guest), after authentication: two rooms times several tabs, plus reconnects.
export const UPGRADES_PER_ACCOUNT_PER_MINUTE = 120;
// Per client address, only for sockets with no session (and open mode, which has none): wide, because a whole class
// behind one NAT reloads together after a relay restart.
export const UPGRADES_PER_ADDRESS_PER_MINUTE = 600;
export const UPGRADE_WINDOW_MS = 60_000;
// Bounds for the in-memory maps; when exceeded, idle entries are swept first.
export const MAX_TRACKED_KEYS = 10_000;

/** Reads the TABULA_SYNC_* overrides. Invalid values throw with a message naming the variable. */
export function loadSyncCaps(env = process.env) {
  const bytes = (name, fallback, { allowZero = false } = {}) => {
    const raw = env[name];
    if (raw == null || String(raw).trim() === '') return fallback;
    const v = parseSize(raw, name);
    if (v === 0 && !allowZero) throw new Error(`${name} must be at least 1`);
    return v;
  };
  const count = (name, fallback) => {
    const raw = env[name];
    if (raw == null || String(raw).trim() === '') return fallback;
    const v = Number(String(raw).trim());
    if (!Number.isSafeInteger(v) || v < 1) throw new Error(`${name} must be a whole number of at least 1 (got "${String(raw).slice(0, 20)}")`);
    return v;
  };
  return {
    maxFrameOwner: bytes('TABULA_SYNC_MAX_FRAME_OWNER', MAX_FRAME_BYTES_OWNER),
    maxFrameOther: bytes('TABULA_SYNC_MAX_FRAME_OTHER', MAX_FRAME_BYTES_OTHER),
    maxFrameComments: bytes('TABULA_SYNC_MAX_FRAME_COMMENTS', MAX_FRAME_BYTES_COMMENTS),
    maxDocBytes: bytes('TABULA_SYNC_MAX_DOC_BYTES', DEFAULT_MAX_DOC_BYTES, { allowZero: true }),
    maxSocketsPerUser: count('TABULA_SYNC_MAX_SOCKETS_PER_USER', MAX_SOCKETS_PER_USER),
    maxSocketsPerAddress: count('TABULA_SYNC_MAX_SOCKETS_PER_ADDRESS', MAX_SOCKETS_PER_ADDRESS),
    upgradesPerMinute: count('TABULA_SYNC_UPGRADES_PER_MINUTE', UPGRADES_PER_ACCOUNT_PER_MINUTE),
    upgradesPerAddressPerMinute: count('TABULA_SYNC_UPGRADES_PER_ADDRESS_PER_MINUTE', UPGRADES_PER_ADDRESS_PER_MINUTE),
  };
}

/** The frame limit for a socket: comments rooms are small; owners (and open mode, which has no roles) get the large board limit. */
export const frameLimitFor = (caps, ws, authEnabled, kind = 'board') => (kind === 'comments' ? caps.maxFrameComments
  : !authEnabled || ws.role === 'owner' ? caps.maxFrameOwner : caps.maxFrameOther);

function bucket(burst, perSecond, now) {
  let tokens = burst;
  let last = now();
  return (cost = 1) => {
    const t = now();
    tokens = Math.min(burst, tokens + Math.max(0, t - last) * perSecond / 1000);
    last = t;
    if (tokens < cost) return false;
    tokens -= cost;
    return true;
  };
}

/**
 * Rate limiter for the sync frames of one socket. take('step1' | 'update') returns 'ok', 'drop' (skip this frame) or
 * 'close' (the socket has been over its limit without a break for ABUSE_CLOSE_MS).
 */
export function createSyncFrameLimiter({ now = Date.now, step1 = [STEP1_BURST, STEP1_PER_SECOND], update = [UPDATE_BURST, UPDATE_PER_SECOND] } = {}) {
  const buckets = { step1: bucket(step1[0], step1[1], now), update: bucket(update[0], update[1], now) };
  let overSince = null;
  let lastDrop = 0;
  return {
    take(kind) {
      const t = now();
      if ((buckets[kind] ?? buckets.update)()) {
        if (overSince !== null && t - lastDrop >= ABUSE_RESET_MS) overSince = null;
        return 'ok';
      }
      if (overSince === null || t - lastDrop >= ABUSE_RESET_MS) overSince = t;
      lastDrop = t;
      return t - overSince >= ABUSE_CLOSE_MS ? 'close' : 'drop';
    },
  };
}

/**
 * Sockets per key (a user id or a client address). acquire() is false at the cap; release() is idempotent per token.
 * Bounded: entries exist only while sockets do.
 */
export function createConnectionCounter(max) {
  const counts = new Map();
  return {
    acquire(key) {
      const n = counts.get(key) ?? 0;
      if (n >= max) return null;
      counts.set(key, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const c = (counts.get(key) ?? 1) - 1;
        if (c <= 0) counts.delete(key);
        else counts.set(key, c);
      };
    },
    count: (key) => counts.get(key) ?? 0,
    get size() { return counts.size; },
  };
}

/** Upgrades per key in a fixed window. allow() is false once the window's count is used; the map is swept when large. */
export function createUpgradeLimiter({ max = UPGRADES_PER_ACCOUNT_PER_MINUTE, windowMs = UPGRADE_WINDOW_MS, now = Date.now, maxKeys = MAX_TRACKED_KEYS } = {}) {
  const windows = new Map();
  const sweep = (t) => {
    for (const [k, w] of windows) if (t < w.startedAt || t - w.startedAt >= windowMs) windows.delete(k);
  };
  return {
    allow(key) {
      const t = now();
      const w = windows.get(key);
      if (!w || t < w.startedAt || t - w.startedAt >= windowMs) {
        if (windows.size >= maxKeys) {
          sweep(t);
          // Still full of live windows (a distributed flood): fail open for a new key rather than lock out everybody.
          if (windows.size >= maxKeys) return true;
        }
        windows.set(key, { startedAt: t, count: 1 });
        return true;
      }
      if (w.count >= max) return false;
      w.count++;
      return true;
    },
    get size() { return windows.size; },
  };
}

/**
 * Document size cap for one room. The encoded size is measured (measure() should return Y.encodeStateAsUpdate(doc).length)
 * at most once per DOC_RECHECK_BYTES of accepted updates, and early when a single frame could cross the cap.
 * admit(frameBytes) is true when the frame may be applied; call accepted(frameBytes) after applying it.
 * A room already over the cap (or a frame that would put it over) still takes frames up to OVER_CAP_MAX_FRAME_BYTES.
 */
export function createDocSizeGuard({ max, measure, recheckBytes = DOC_RECHECK_BYTES, smallFrame = OVER_CAP_MAX_FRAME_BYTES }) {
  let known = null; // encoded size at the last measurement
  let since = 0; // update bytes accepted after it
  const refresh = () => { known = measure(); since = 0; };
  return {
    admit(frameBytes) {
      if (!max) return true;
      if (known === null || since >= recheckBytes) refresh();
      // Small frames always pass (deleting, typing). since over-counts (an update's bytes are not its growth), so only a
      // frame that could cross the cap is worth an exact measurement.
      if (frameBytes <= smallFrame) return true;
      if (known + since + frameBytes > max) refresh();
      return known + frameBytes <= max;
    },
    accepted(frameBytes) { since += frameBytes; },
    get over() { return max > 0 && known !== null && known > max; },
    reset() { known = null; since = 0; },
  };
}
