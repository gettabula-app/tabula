// Hosted workspaces (docs/cloud.md): what an instance does when a control plane runs it. Everything here exists only
// when TABULA_CLOUD_TOKEN, TABULA_CLOUD_URL and TABULA_CLOUD_WORKSPACE_ID are set in accounts mode; createCloud() answers
// null otherwise and the rest of the server never mentions it.

import crypto from 'node:crypto';

const LIMITS_KEY = 'cloud.limits';
const AUTO_UPDATES_KEY = 'updates.auto';
const USAGE_DEBOUNCE_MS = 30_000;
const AUTO_UPDATES_BOOT_DELAY_MS = 5_000;
const AUTO_UPDATES_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const CALL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 64 * 1024;
const SEAT_LIMIT_MAX = 100_000;
const BANNER_MAX = 300;
const TRIAL_ENDS_AT_MAX = 40;
const TRIAL_YEAR_MIN = 2000;
const TRIAL_YEAR_MAX = 2100;
const SEAT_ROLES = ['owner', 'admin', 'member'];
const LIMIT_FIELDS = ['seatLimit', 'readOnly', 'banner', 'billing', 'trialEndsAt', 'state'];
const TRIAL_ENDS_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const STATE_RE = /^[a-z0-9_-]{1,32}$/;
const NOT_SINGLE_LINE_RE = /[\p{Cc}\u2028\u2029]/u;
const BEARER_RE = /^bearer +(\S+)$/i;
const NOTIFY_FIELDS = ['template', 'date'];
const NOTIFY_DATE_MAX = 40;
const NOTIFY_DATE_RE = /^\d{1,2} [A-Z][a-z]{2} \d{4}$/;
const ADDRESS_RE = /\S+@\S+/g;

// What the control plane may ask the instance to mail the owners. `setting` remembers the last date notified, so a
// retried job never mails twice. `text` is for the log, file and smtp mail modes; a hosted relay renders its own
// wording from the template name and params.
const NOTIFY_TEMPLATES = {
  'trial-ending': {
    setting: 'cloud.trialEndingNotified',
    subject: (date) => `Your Tabula trial ends on ${date}`,
    text: (date, link) =>
      `The free trial of this Tabula workspace ends on ${date}.\n\nThe subscription then starts automatically with the card on file. The workspace owner can review or cancel it under Admin, Overview, Manage billing:\n\n${link}\n`,
  },
};

// `billing: false` is a workspace that is provided free (education, internal): it has no subscription and no billing portal.
const DEFAULT_LIMITS = Object.freeze({ seatLimit: null, readOnly: false, banner: null, billing: true, trialEndsAt: null, state: null });

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
  if (body.billing !== undefined) {
    if (typeof body.billing !== 'boolean') return { error: 'billing must be a boolean' };
    patch.billing = body.billing;
  }
  if (body.banner !== undefined) {
    if (body.banner !== null && typeof body.banner !== 'string') return { error: 'banner must be a string or null' };
    const text = body.banner === null ? '' : body.banner.trim();
    if (text.length > BANNER_MAX || NOT_SINGLE_LINE_RE.test(text)) {
      return { error: `banner must be at most ${BANNER_MAX} characters on a single line` };
    }
    patch.banner = text || null;
  }
  if (body.trialEndsAt !== undefined) {
    const value = body.trialEndsAt;
    if (value !== null) {
      const match = typeof value === 'string' && value.length <= TRIAL_ENDS_AT_MAX ? TRIAL_ENDS_AT_RE.exec(value) : null;
      const parts = match?.slice(1).map(Number);
      const [year, month, day, hour, minute, second] = parts ?? [];
      const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      const date = Number.isNaN(parsed) ? null : new Date(parsed);
      if (!match || year < TRIAL_YEAR_MIN || year > TRIAL_YEAR_MAX || !date
        || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day
        || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
        return { error: `trialEndsAt must be a valid ISO 8601 UTC date or null` };
      }
    }
    patch.trialEndsAt = value;
  }
  if (body.state !== undefined) {
    if (body.state !== null && (typeof body.state !== 'string' || !STATE_RE.test(body.state))) {
      return { error: 'state must be a string of at most 32 lowercase letters, digits, underscores or hyphens, or null' };
    }
    patch.state = body.state;
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

/** Strict check of a POST /api/internal/notify body: `{ notice: { template, date } }` or `{ error }`. */
export function validateNotify(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'The request body must be a JSON object' };
  for (const key of Object.keys(body)) {
    if (!NOTIFY_FIELDS.includes(key)) return { error: `Unknown field: ${key.slice(0, 40)}` };
  }
  const { template, date } = body;
  if (typeof template !== 'string' || !Object.hasOwn(NOTIFY_TEMPLATES, template)) {
    return { error: `template must be one of ${Object.keys(NOTIFY_TEMPLATES).join(', ')}` };
  }
  if (typeof date !== 'string' || date.length > NOTIFY_DATE_MAX || !NOTIFY_DATE_RE.test(date)) {
    return { error: 'date must look like "7 Nov 2026"' };
  }
  return { notice: { template, date } };
}

const usesSeat = (user) => SEAT_ROLES.includes(user.role) && !user.disabled;

/** Whether applying `patch` ({role?, disabled?}) to `user` takes a seat they do not hold now. */
export const addsSeat = (user, patch) => !usesSeat(user) && usesSeat({ ...user, ...patch });

function describe(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timed out';
  return String(err?.message ?? err).slice(0, 200);
}

function validAutoUpgradeReply(data, value) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const fields = Object.keys(data);
  return fields.length === 2
    && fields.includes('autoUpgrade')
    && fields.includes('securityAlwaysApplied')
    && typeof data.autoUpgrade === 'boolean'
    && data.autoUpgrade === value
    && typeof data.securityAlwaysApplied === 'boolean'
    && data.securityAlwaysApplied;
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

  const storedAutoUpgrade = () => directory.getSetting(AUTO_UPDATES_KEY);
  const autoUpgrade = () => storedAutoUpgrade() !== '0';
  const hasExplicitAutoUpgrade = () => storedAutoUpgrade() !== null;
  let autoUpgradeRevision = 0;
  let autoUpgradeSyncedRevision = -1;
  let autoUpgradeSynced = false;
  let autoUpgradeRetryTimer = null;
  let autoUpgradeRetryIndex = 0;
  let closed = false;

  function updates() {
    const explicit = hasExplicitAutoUpgrade();
    return {
      auto: autoUpgrade(),
      synced: !explicit || (autoUpgradeSyncedRevision === autoUpgradeRevision && autoUpgradeSynced),
      securityAlwaysApplied: true,
    };
  }

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
    billing: limits.billing,
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

  function scheduleAutoUpgradeSync(delay, revision, value) {
    if (closed) return;
    if (autoUpgradeRetryTimer !== null) clearTimer(autoUpgradeRetryTimer);
    autoUpgradeRetryTimer = setTimer(() => {
      autoUpgradeRetryTimer = null;
      void pushAutoUpgrade(revision, value);
    }, delay);
    autoUpgradeRetryTimer?.unref?.();
  }

  async function pushAutoUpgrade(revision, value) {
    try {
      const reply = await post('settings', { autoUpgrade: value });
      if (reply.status !== 200) throw new Error(`answered ${reply.status}`);
      if (reply.text.length > MAX_RESPONSE_CHARS) throw new Error('response too large');
      const data = JSON.parse(reply.text);
      if (!validAutoUpgradeReply(data, value)) throw new Error('invalid answer');
      if (!closed && revision === autoUpgradeRevision && hasExplicitAutoUpgrade() && autoUpgrade() === value) {
        autoUpgradeSyncedRevision = revision;
        autoUpgradeSynced = true;
        autoUpgradeRetryIndex = 0;
      }
    } catch (err) {
      log(`cloud: could not sync automatic updates: ${describe(err)}`);
      if (!closed && revision === autoUpgradeRevision && hasExplicitAutoUpgrade() && autoUpgrade() === value) {
        autoUpgradeSyncedRevision = revision;
        autoUpgradeSynced = false;
        const delay = AUTO_UPDATES_RETRY_MS[Math.min(autoUpgradeRetryIndex, AUTO_UPDATES_RETRY_MS.length - 1)];
        autoUpgradeRetryIndex = Math.min(autoUpgradeRetryIndex + 1, AUTO_UPDATES_RETRY_MS.length - 1);
        scheduleAutoUpgradeSync(delay, revision, value);
      }
    }
  }

  async function setAutoUpgrade(value, actor) {
    const previous = storedAutoUpgrade();
    const nextStored = value ? '1' : '0';
    if (previous === nextStored) return updates();

    const from = previous !== '0';
    const revision = autoUpgradeRevision + 1;
    directory.transaction(() => {
      directory.setSetting(AUTO_UPDATES_KEY, nextStored);
      directory.audit(actor.id, 'updates.auto', { from, to: value });
    });
    if (autoUpgradeRetryTimer !== null) clearTimer(autoUpgradeRetryTimer);
    autoUpgradeRetryTimer = null;
    autoUpgradeRevision = revision;
    autoUpgradeSyncedRevision = revision;
    autoUpgradeSynced = false;
    autoUpgradeRetryIndex = 0;
    try {
      events.emit('usage-changed');
    } catch (err) {
      log(`cloud: a listener for usage-changed failed: ${describe(err)}`);
    }
    await pushAutoUpgrade(revision, value);
    return updates();
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

  const notifying = new Set();

  /**
   * Mails every enabled owner (docs/cloud.md). `mailer` and `baseUrl` come from the caller. Answers `{ sent }`, or
   * `{ sent: 0, duplicate: true }` when this date was notified before (or is being notified right now); throws a
   * CloudError when every mail failed, so the control plane retries. Addresses never reach the log or the audit row.
   */
  async function notify({ template, date }, { mailer, baseUrl }) {
    const { setting, subject, text } = NOTIFY_TEMPLATES[template];
    const pending = `${template} ${date}`;
    if (directory.getSetting(setting) === date || notifying.has(pending)) return { sent: 0, duplicate: true };
    const owners = directory.listOwnerEmails();
    if (owners.length === 0) return { sent: 0 };

    notifying.add(pending);
    try {
      const link = `${baseUrl}/`;
      // The async wrapper turns a mailer that throws at once into a rejection like any other failure.
      const results = await Promise.allSettled(
        owners.map(async (to) =>
          mailer.send({ to, template, params: { link, date }, subject: subject(date), text: text(date, link) }),
        ),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const reason = describe(failures[0].reason).replace(ADDRESS_RE, '<address>');
        log(`cloud: ${failures.length} of ${owners.length} ${template} mails could not be sent: ${reason}`);
      }
      const sent = owners.length - failures.length;
      if (sent === 0) throw new CloudError('The mails could not be sent right now. Try again in a minute.');
      directory.transaction(() => {
        directory.setSetting(setting, date);
        directory.audit(null, 'cloud.notify', { template, count: sent });
      });
      return { sent };
    } finally {
      notifying.delete(pending);
    }
  }

  let usageTimer = null;
  let pushed = null;

  async function pushUsage() {
    try {
      const { seats, guests } = seatUsage();
      const explicit = hasExplicitAutoUpgrade();
      const value = autoUpgrade();
      if (pushed && pushed.seats === seats && pushed.guests === guests && pushed.hasAutoUpgrade === explicit && (!explicit || pushed.autoUpgrade === value)) return;
      const payload = { seats, guests, ...(explicit ? { autoUpgrade: value } : {}) };
      const reply = await post('usage', payload);
      if (!reply.ok) throw new Error(`answered ${reply.status}`);
      pushed = { seats, guests, hasAutoUpgrade: explicit, ...(explicit ? { autoUpgrade: value } : {}) };
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

  if (hasExplicitAutoUpgrade()) scheduleAutoUpgradeSync(AUTO_UPDATES_BOOT_DELAY_MS, autoUpgradeRevision, autoUpgrade());

  return {
    tokenOk,
    limits: () => ({ ...limits }),
    setLimits,
    seatUsage,
    seatsAvailable,
    workspaceView,
    autoUpgrade,
    updates,
    setAutoUpgrade,
    portalUrl,
    notify,
    scheduleUsagePush,
    close() {
      closed = true;
      if (usageTimer !== null) clearTimer(usageTimer);
      usageTimer = null;
      if (autoUpgradeRetryTimer !== null) clearTimer(autoUpgradeRetryTimer);
      autoUpgradeRetryTimer = null;
      events.off('usage-changed', scheduleUsagePush);
    },
  };
}
