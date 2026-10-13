// Per-member switches for the notification bell (docs/notifications.md, Settings; TAB-164 slice 3). Four groups of kinds, each on
// until switched off. The switches stop new rows only: rows already there stay listed. Tracker rows have their own settings and
// are not in any group. Quiet hours are not built.

export const PREF_KEYS = Object.freeze({
  mentions: 'notify.mentions',
  replies: 'notify.replies',
  cards: 'notify.cards',
  shares: 'notify.shares',
});
export const GROUP_NAMES = Object.freeze(Object.keys(PREF_KEYS));

/** Kind -> group. A kind that is not here (a tracker kind) has no switch and is always allowed. */
export const GROUPS = new Map([
  ['chat_mention', 'mentions'],
  ['comment_mention', 'mentions'],
  ['comment_reply', 'replies'],
  ['card_due_soon', 'cards'],
  ['card_overdue', 'cards'],
  ['card_assigned', 'cards'],
  ['board_shared', 'shares'],
  ['team_joined', 'shares'],
]);

/** The group a kind belongs to, or null when no switch covers it. */
export const groupOf = (kind) => GROUPS.get(kind) ?? null;

/** A patch or body the switches cannot accept: an unknown key, a value that is not a boolean, or an empty patch. */
export class NotificationPrefsInputError extends TypeError {}

/** Checks a patch and returns it as `{ group: boolean }`. Strict: only the four keys, booleans only, at least one key. */
export function parseNotificationPrefsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new NotificationPrefsInputError('Body must be an object');
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new NotificationPrefsInputError('Send at least one switch');
  for (const key of keys) {
    if (!GROUP_NAMES.includes(key)) throw new NotificationPrefsInputError(`Unknown field: ${key.slice(0, 40)}`);
    if (typeof patch[key] !== 'boolean') throw new NotificationPrefsInputError(`${key} must be true or false`);
  }
  return Object.fromEntries(keys.map((key) => [key, patch[key]]));
}

/**
 * @param {{ directory: { getPref: (userId: string, key: string) => string | null, setPref: (userId: string, key: string, value: string) => void } }} options
 */
export function createNotificationPrefs({ directory }) {
  if (!directory || typeof directory.getPref !== 'function' || typeof directory.setPref !== 'function') {
    throw new TypeError('Notification switches need a directory with preferences');
  }
  const on = (userId, group) => directory.getPref(userId, PREF_KEYS[group]) !== '0';

  /** The four switches of a person, each true unless switched off. */
  function get(userId) {
    return Object.fromEntries(GROUP_NAMES.map((group) => [group, on(userId, group)]));
  }

  /** Changes the named switches and returns all four. Throws NotificationPrefsInputError for anything the switches do not accept. */
  function set(userId, patch) {
    const changes = parseNotificationPrefsPatch(patch);
    for (const [group, value] of Object.entries(changes)) directory.setPref(userId, PREF_KEYS[group], value ? '1' : '0');
    return get(userId);
  }

  /** Whether a notification of this kind may be recorded for the person. Kinds with no group are always allowed. */
  function allows(userId, kind) {
    const group = groupOf(kind);
    return group === null ? true : on(userId, group);
  }

  return { get, set, allows };
}
