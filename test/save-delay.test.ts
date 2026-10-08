import { describe, expect, it } from 'vitest';
import { saveDelay } from '../server/save-delay.mjs';

const DEBOUNCE = 1000;
const MAX_WAIT = 30_000;
const T0 = 1_700_000_000_000;

const delay = (now: number, firstUnsavedAt: number) => saveDelay({ now, firstUnsavedAt, debounceMs: DEBOUNCE, maxWaitMs: MAX_WAIT });

describe('saveDelay (a debounce with a maximum wait)', () => {
  it('is the plain debounce for a change that was just made', () => {
    expect(delay(T0, T0)).toBe(DEBOUNCE);
    expect(delay(T0 + 5000, T0 + 4000)).toBe(DEBOUNCE);
  });

  it('stays the debounce while the first unsaved change is younger than the maximum wait minus the debounce', () => {
    expect(delay(T0 + 10_000, T0)).toBe(DEBOUNCE);
    expect(delay(T0 + 29_000, T0)).toBe(DEBOUNCE);
  });

  it('shortens the delay so the first unsaved change is never older than the maximum wait', () => {
    expect(delay(T0 + 29_500, T0)).toBe(500);
    expect(delay(T0 + 29_999, T0)).toBe(1);
  });

  it('saves at once once the maximum wait is reached or passed', () => {
    expect(delay(T0 + MAX_WAIT, T0)).toBe(0);
    expect(delay(T0 + MAX_WAIT + 12_000, T0)).toBe(0);
  });

  it('keeps continuous editing under the limit: updates every 400 ms still save within 30 seconds', () => {
    // Replays the relay's scheduleSave: each update replaces the pending timer with a new delay.
    let firstUnsavedAt: number | null = null;
    let savedAt: number | null = null;
    for (let now = T0; savedAt === null && now < T0 + 120_000; now += 400) {
      firstUnsavedAt ??= now;
      const due = now + delay(now, firstUnsavedAt);
      if (due <= now + 400) savedAt = due;
    }
    expect(savedAt).not.toBeNull();
    expect((savedAt as number) - T0).toBeLessThanOrEqual(MAX_WAIT);
  });

  it('never returns a negative delay, even if the clock went backwards', () => {
    expect(delay(T0 - 5000, T0)).toBe(DEBOUNCE);
    expect(delay(T0 + MAX_WAIT * 3, T0)).toBe(0);
  });
});
