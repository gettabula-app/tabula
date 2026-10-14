// The once-a-day email digest of unread notifications (docs/notifications.md, Digest). Opt-in: nothing is sent unless the
// person turned it on. The mail names who, what and the board or team (sentenceFor in notifications.mjs), never any text.
// Prefs live in user_prefs: notify.digest ('1' on), notify.digestHour, notify.tz, notify.digestLastAt (the cutoff: only
// unread rows newer than it are listed) and notify.digestDay (the local date already handled, so one mail a day).

import { sentenceFor } from './notifications.mjs';
import { NotificationPrefsInputError } from './notification-prefs.mjs';

export const DIGEST_KEYS = Object.freeze({
  on: 'notify.digest',
  hour: 'notify.digestHour',
  tz: 'notify.tz',
  lastAt: 'notify.digestLastAt',
  day: 'notify.digestDay',
});
export const DEFAULT_HOUR = 8;
export const DEFAULT_TZ = 'UTC';
export const DIGEST_SUBJECT = 'Your Tabula notifications';
export const DIGEST_TEMPLATE = 'notification-digest';
export const DIGEST_FOOTER = 'You get this email because the daily digest is turned on in Notification settings. Turn it off there at any time.';
export const MAX_LINES = 10;
export const MAX_LINE_CHARS = 120;
export const MAX_MAILS_PER_SWEEP = 200;
export const MAX_ATTEMPTS_PER_DAY = 3;
const LIST_PAGE = 50;
const LIST_CAP = 200;

/** A valid IANA zone name (max 64 characters), or null. */
export function validTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

const zoneFormats = new Map();
function formatterFor(tz) {
  let format = zoneFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    });
    zoneFormats.set(tz, format);
  }
  return format;
}

/** The local calendar date (YYYY-MM-DD) and hour (0-23) of an instant in a zone. */
export function localParts(now, tz) {
  const parts = Object.fromEntries(formatterFor(tz).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
  };
}

/**
 * Whether the digest is due: on, the local hour has reached the chosen hour, and no digest was handled for today's local date.
 * @param {{ on: boolean, hour: number, tz: string, day?: string | null }} prefs
 * @param {number} now
 */
export function isDue(prefs, now) {
  if (!prefs?.on) return false;
  const local = localParts(now, prefs.tz || DEFAULT_TZ);
  if (local.hour < prefs.hour) return false;
  return prefs.day !== local.date;
}

const clipChars = (value, max) => {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

/** One digest line: the bell sentence, plain text, at most 120 characters, with no control characters. */
export function digestLine(item) {
  const text = String(sentenceFor(item)).replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return clipChars(text, MAX_LINE_CHARS);
}

/** Lines for the first ten items, and how many more there are. */
export function digestLines(items) {
  const lines = items.slice(0, MAX_LINES).map(digestLine);
  return { lines, more: Math.max(0, items.length - lines.length) };
}

const hourOf = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 && String(value) !== '' ? n : DEFAULT_HOUR;
};

/** Checks a PUT body: on (boolean), hour (integer 0-23), tz (valid zone). Strict: nothing else, at least one field. */
export function parseDigestPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new NotificationPrefsInputError('Body must be an object');
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new NotificationPrefsInputError('Send at least one digest setting');
  const out = {};
  for (const key of keys) {
    if (key === 'on') {
      if (typeof patch.on !== 'boolean') throw new NotificationPrefsInputError('on must be true or false');
      out.on = patch.on;
    } else if (key === 'hour') {
      if (!Number.isInteger(patch.hour) || patch.hour < 0 || patch.hour > 23) throw new NotificationPrefsInputError('hour must be a whole number from 0 to 23');
      out.hour = patch.hour;
    } else if (key === 'tz') {
      if (!validTimeZone(patch.tz)) throw new NotificationPrefsInputError('tz must be a time zone name');
      out.tz = patch.tz;
    } else {
      throw new NotificationPrefsInputError(`Unknown field: ${key.slice(0, 40)}`);
    }
  }
  return out;
}

/**
 * @param {object} options
 * @param {any} options.directory
 * @param {{ list: Function }} options.notifications
 * @param {{ send: Function }} options.mailer
 * @param {string} options.baseUrl
 * @param {(...args: unknown[]) => void} [options.log]
 * @param {() => number} [options.now]
 */
/**
 * `write(fn)` runs a database write (the relay passes the snapshot barrier's writer, so a backup never sees a half write). The mail
 * itself is sent OUTSIDE it: a slow mail relay must not hold up a backup.
 */
export function createDigest({ directory, notifications, mailer, baseUrl, log = () => {}, now = Date.now, write = (fn) => fn() }) {
  const db = directory?.db;
  if (!db || typeof db.prepare !== 'function') throw new TypeError('The digest needs a directory database');
  const nowValue = () => {
    const value = typeof now === 'function' ? now() : now;
    return Number.isSafeInteger(value) ? value : Date.now();
  };
  const link = `${String(baseUrl).replace(/\/+$/u, '')}/#/`;
  /** Failed attempts today, per person: `${userId}|${date}` -> count. Kept in memory; a restart only resets the count. */
  const attempts = new Map();

  function get(userId) {
    const on = directory.getPref(userId, DIGEST_KEYS.on) === '1';
    const hour = hourOf(directory.getPref(userId, DIGEST_KEYS.hour) ?? DEFAULT_HOUR);
    const tz = validTimeZone(directory.getPref(userId, DIGEST_KEYS.tz)) ?? DEFAULT_TZ;
    return { on, hour, tz };
  }

  function stateOf(userId) {
    const lastAt = Number(directory.getPref(userId, DIGEST_KEYS.lastAt));
    return {
      ...get(userId),
      lastAt: Number.isSafeInteger(lastAt) && lastAt > 0 ? lastAt : 0,
      day: directory.getPref(userId, DIGEST_KEYS.day),
    };
  }

  /**
   * Changes the digest settings. Turning it on never sends at once: the cutoff becomes now, so the first mail lists only what
   * arrives after; and when the chosen hour has already passed today, today is marked handled.
   */
  function set(userId, patch) {
    const changes = parseDigestPatch(patch);
    const before = get(userId);
    const at = nowValue();
    if (changes.on === true && !before.on) {
      const tz = changes.tz ?? before.tz;
      const hour = changes.hour ?? before.hour;
      directory.setPref(userId, DIGEST_KEYS.lastAt, String(at));
      if (localParts(at, tz).hour >= hour) directory.setPref(userId, DIGEST_KEYS.day, localParts(at, tz).date);
    }
    if ('on' in changes) directory.setPref(userId, DIGEST_KEYS.on, changes.on ? '1' : '0');
    if ('hour' in changes) directory.setPref(userId, DIGEST_KEYS.hour, String(changes.hour));
    if ('tz' in changes) directory.setPref(userId, DIGEST_KEYS.tz, changes.tz);
    return get(userId);
  }

  /** The unread rows newer than the cutoff, newest first, through the same access-filtered list the bell uses. */
  function unreadSince(user, cutoff) {
    const items = [];
    let before = null;
    while (items.length < LIST_CAP) {
      const page = notifications.list({ user, limit: LIST_PAGE, before, unreadOnly: true });
      for (const item of page.items) {
        if (item.at <= cutoff) return items;
        items.push(item);
      }
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    return items;
  }

  function mailFor(count, lines, more) {
    const head = count === 1 ? 'You have 1 new notification' : `You have ${count} new notifications`;
    const bullets = lines.map((line) => `- ${line}`);
    const tail = more > 0 ? [`and ${more} more`] : [];
    const text = [head + ':', '', ...bullets, ...tail, '', `Open Tabula: ${link}`, '', DIGEST_FOOTER, ''].join('\n');
    return {
      subject: DIGEST_SUBJECT,
      text,
      template: DIGEST_TEMPLATE,
      params: { link, count, lines, more },
    };
  }

  /**
   * Sends the due digests. At most one mail per person per local day and MAX_MAILS_PER_SWEEP per sweep; a failed mail is retried
   * at the next sweep, up to MAX_ATTEMPTS_PER_DAY times that day. Resolves to the counts, for tests and the log.
   */
  async function sweep() {
    const at = nowValue();
    const result = { sent: 0, empty: 0, failed: 0, skipped: 0 };
    const people = db.prepare(`SELECT DISTINCT user_id FROM user_prefs WHERE key = '${DIGEST_KEYS.on}' AND value = '1'`).all();
    for (const { user_id: userId } of people) {
      if (result.sent >= MAX_MAILS_PER_SWEEP) break;
      try {
        const user = directory.getUser(userId);
        if (!user || user.disabled || !user.email || user.role === 'guest' || user.guest === true) { result.skipped += 1; continue; }
        const prefs = stateOf(userId);
        if (!isDue(prefs, at)) continue;
        const today = localParts(at, prefs.tz).date;
        const key = `${userId}|${today}`;
        if ((attempts.get(key) ?? 0) >= MAX_ATTEMPTS_PER_DAY) { result.skipped += 1; continue; }
        const items = unreadSince(user, prefs.lastAt);
        if (items.length === 0) {
          await write(() => {
            directory.setPref(userId, DIGEST_KEYS.day, today);
            directory.setPref(userId, DIGEST_KEYS.lastAt, String(at));
          });
          result.empty += 1;
          continue;
        }
        const { lines, more } = digestLines(items);
        const message = mailFor(items.length, lines, more);
        try {
          await mailer.send({ to: user.email, ...message });
        } catch (err) {
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          result.failed += 1;
          log(`digest: could not send a digest (${items.length} items, ${err?.name ?? 'Error'})`);
          continue;
        }
        await write(() => {
          directory.setPref(userId, DIGEST_KEYS.day, today);
          directory.setPref(userId, DIGEST_KEYS.lastAt, String(at));
        });
        attempts.delete(key);
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        log(`digest: sweep failed for one person (${err?.name ?? 'Error'})`);
      }
    }
    if (attempts.size > 10_000) attempts.clear();
    return result;
  }

  return { sweep, get, set, prefs: { get, set } };
}
