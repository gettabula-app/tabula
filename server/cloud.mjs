// Hosted workspaces (docs/cloud.md): what an instance does when a control plane runs it. Everything here exists only
// when TABULA_CLOUD_TOKEN, TABULA_CLOUD_URL and TABULA_CLOUD_WORKSPACE_ID are set in accounts mode; createCloud() answers
// null otherwise and the rest of the server never mentions it.

import crypto from 'node:crypto';

const LIMITS_KEY = 'cloud.limits';
const USAGE_DEBOUNCE_MS = 30_000;
const CALL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 64 * 1024;
const SEAT_LIMIT_MAX = 100_000;
const BANNER_MAX = 300;
const SEAT_ROLES = ['owner', 'admin', 'member'];
const LIMIT_FIELDS = ['seatLimit', 'readOnly', 'banner'];
const NOT_SINGLE_LINE_RE = /[\p{Cc}\u2028\u2029]/u;
const BEARER_RE = /^bearer +(\S+)$/i;

const DEFAULT_LIMITS = Object.freeze({ seatLimit: null, readOnly: false, banner: null });

/** A call to the control plane failed. The message is safe to show; the reason went to the log. */
export class CloudError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CloudError';
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function checkLimits(body) {
  const patch = {};
  for (const key of Object.keys(body)) {
    if (!LIMIT_FIELDS.includes(key)) return { error: `Unknown field: ${key.slice(0, 40)}` };
  }
  if (body.seatLimit !== undefined) {
    const n = body.seatLimit;
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= SEAT_LIMIT_MAX)) {
      return { error: `seatLimit must be a whole number from 1 to ${SEAT_LIMIT_MAX}, or null` };
    }
    patch.seatLimit = n;
  }
  if (body.readOnly !== undefined) {
    if (typeof body.readOnly !== 'boolean') return { error: 'readOnly must be a boolean' };
    patch.readOnly = body.readOnly;
  }
  if (body.banner !== undefined) {
    if (body.banner !== null && typeof body.banner !== 'string') return { error: 'banner must be a string or null' };
    const text = body.banner === null ? '' : body.banner.trim();
    if (text.length > BANNER_MAX || NOT_SINGLE_LINE_RE.test(text)) {
      return { error: `banner must be at most ${BANNER_MAX} characters on a single line` };
    }
    patch.banner = text || null;
  }
  return { patch };
}

/** Strict check of a PUT /api/internal/limits body: `{ patch }` (only the fields that were sent) or `{ error }`. */
export function validateLimits(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'The request body must be a JSON object' };
  const checked = checkLimits(body);
  if (checked.patch && Object.keys(checked.patch).length === 0) return { error: 'Nothing to change' };
  return checked;
}

const usesSeat = (user) => SEAT_ROLES.includes(user.role) && !user.disabled;

/** Whether applying `patch` ({role?, disabled?}) to `user` takes a seat they do not hold now. */
export const addsSeat = (user, patch) => !usesSeat(user) && usesSeat({ ...user, ...patch });

function describe(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timed out';
  return String(err?.message ?? err).slice(0, 200);
}

/**
 * `config` is `config.cloud`. `fetch`, the timer functions and `log` are injectable for tests.
 * Emits `limits-changed` on `events` after the limits change (the relay re-evaluates open sockets on it) and
 * listens for `usage-changed`.
 */
export function createCloud({
  config,
  directory,
  events,
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  log = (...args) => console.error(...args),
}) {
  if (!config) return null;

  const tokenDigest = sha256(config.token);

  function loadLimits() {
    try {
      const stored = JSON.parse(directory.getSetting(LIMITS_KEY) ?? 'null');
      if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        const checked = checkLimits(stored);
        if (checked.patch) return { ...DEFAULT_LIMITS, ...checked.patch };
      }
    } catch {
      /* unreadable settings fall back to no limits */
    }
    return { ...DEFAULT_LIMITS };
  }

  let limits = loadLimits();

  // Both sides are hashed first so the comparison takes the same time whatever length the caller sent.
  function tokenOk(header) {
    const presented = typeof header === 'string' ? (BEARER_RE.exec(header.trim())?.[1] ?? '') : '';
    return crypto.timingSafeEqual(sha256(presented), tokenDigest);
  }

  function setLimits(patch) {
    const next = { ...limits, ...patch };
    directory.transaction(() => {
      directory.setSetting(LIMITS_KEY, JSON.stringify(next));
      directory.audit(null, 'cloud.limits', next);
    });
    limits = next;
    try {
      events.emit('limits-changed', { ...next });
    } catch (err) {
      log(`cloud: a listener for limits-changed failed: ${describe(err)}`);
    }
    return { ...next };
  }

  const seatUsage = () => directory.seatUsage();
  const seatsAvailable = () => limits.seatLimit === null || seatUsage().seats < limits.seatLimit;

  const workspaceView = () => ({
    readOnly: limits.readOnly,
    banner: limits.banner,
    seatLimit: limits.seatLimit,
    seatsUsed: seatUsage().seats,
  });

  // The timeout covers reading the answer too: a control plane that stalls mid-body must not hold the request.
  async function post(path, payload) {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${config.url}/v1/workspaces/${encodeURIComponent(config.workspaceId)}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = (await res.text?.()) ?? '';
      return { ok: res.ok, status: res.status, text };
    } finally {
      clearTimer(timer);
    }
  }

  async function portalUrl() {
    const unavailable = new CloudError('Billing is not available right now. Try again in a minute.');
    let reply;
    try {
      reply = await post('portal', {});
    } catch (err) {
      log(`cloud: portal request failed: ${describe(err)}`);
      throw unavailable;
    }
    if (!reply.ok) {
      log(`cloud: portal request answered ${reply.status}`);
      throw unavailable;
    }
    let url;
    try {
      if (reply.text.length > MAX_RESPONSE_CHARS) throw new Error('response too large');
      const data = JSON.parse(reply.text);
      url = typeof data?.url === 'string' && new URL(data.url).protocol === 'https:' ? data.url : null;
    } catch {
      url = null;
    }
    if (!url) {
      log('cloud: portal request did not answer with an https url');
      throw unavailable;
    }
    return url;
  }

  let usageTimer = null;
  let pushed = null;

  async function pushUsage() {
    try {
      const { seats, guests } = seatUsage();
      if (pushed && pushed.seats === seats && pushed.guests === guests) return;
      const reply = await post('usage', { seats, guests });
      if (!reply.ok) throw new Error(`answered ${reply.status}`);
      pushed = { seats, guests };
    } catch (err) {
      log(`cloud: could not push usage: ${describe(err)}`);
    }
  }

  // Trailing debounce: a burst of changes becomes one push, 30 seconds after the last one, with the counts as they are then.
  function scheduleUsagePush() {
    if (usageTimer !== null) clearTimer(usageTimer);
    usageTimer = setTimer(() => {
      usageTimer = null;
      void pushUsage();
    }, USAGE_DEBOUNCE_MS);
    usageTimer?.unref?.();
  }

  events.on('usage-changed', scheduleUsagePush);

  return {
    tokenOk,
    limits: () => ({ ...limits }),
    setLimits,
    seatUsage,
    seatsAvailable,
    workspaceView,
    portalUrl,
    scheduleUsagePush,
    close() {
      if (usageTimer !== null) clearTimer(usageTimer);
      usageTimer = null;
      events.off('usage-changed', scheduleUsagePush);
    },
  };
}
