// When a room should be saved next: a debounce after the latest update, but never later than `maxWaitMs`
// after the first change that is still unsaved, so continuous editing cannot postpone a save forever.
export function saveDelay({ now, firstUnsavedAt, debounceMs, maxWaitMs }) {
  const waited = Math.max(0, now - firstUnsavedAt);
  return Math.max(0, Math.min(debounceMs, maxWaitMs - waited));
}

export const DEFAULT_SAVE_MAX_WAIT_MS = 30_000;

/**
 * The longest a change may stay unsaved. Test-only TABULA_TEST_SAVE_MAX_WAIT_MS lets child-relay tests exercise the max-wait
 * save without waiting 30 seconds; it can only shorten the wait: zero, negative, fractional, non-numeric or anything above the
 * default keeps the default, so a stray value in production can never delay saves.
 * @param {Record<string, string | undefined>} [env]
 */
export function saveMaxWaitMs(env = process.env) {
  const requested = Number(env.TABULA_TEST_SAVE_MAX_WAIT_MS);
  return Number.isSafeInteger(requested) && requested > 0 && requested <= DEFAULT_SAVE_MAX_WAIT_MS ? requested : DEFAULT_SAVE_MAX_WAIT_MS;
}
