// When a room should be saved next: a debounce after the latest update, but never later than `maxWaitMs`
// after the first change that is still unsaved, so continuous editing cannot postpone a save forever.
export function saveDelay({ now, firstUnsavedAt, debounceMs, maxWaitMs }) {
  const waited = Math.max(0, now - firstUnsavedAt);
  return Math.max(0, Math.min(debounceMs, maxWaitMs - waited));
}
