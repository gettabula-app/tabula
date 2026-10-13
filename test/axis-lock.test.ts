import { describe, expect, it } from 'vitest';
import { AXIS_LOCK_PX, lockKeyHeld, lockedOffset, noAxisLock, stepAxisLock } from '../src/axis-lock';

const at = (x: number, y: number) => ({ x, y });

describe('the axis lock', () => {
  it('uses Cmd on a Mac and Ctrl elsewhere, and neither of the other', () => {
    expect(lockKeyHeld({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(lockKeyHeld({ metaKey: false, ctrlKey: true }, true)).toBe(false); // Ctrl-click is the context menu on a Mac
    expect(lockKeyHeld({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(lockKeyHeld({ metaKey: true, ctrlKey: false }, false)).toBe(false);
  });

  it('does nothing while the key is up', () => {
    const s = stepAxisLock(noAxisLock(), false, at(50, 50), at(5, 5));
    expect(s).toEqual(noAxisLock());
    expect(lockedOffset(s, at(40, 3))).toEqual(at(40, 3));
  });

  it('waits for 6 px of pointer movement after the key goes down, then decides by the larger axis', () => {
    let s = stepAxisLock(noAxisLock(), true, at(100, 100), at(10, 0));
    expect(s.axis).toBeNull();
    s = stepAxisLock(s, true, at(100 + AXIS_LOCK_PX - 1, 100), at(14, 0));
    expect(s.axis).toBeNull();
    expect(lockedOffset(s, at(14, 0))).toEqual(at(10, 0)); // the object waits where it was
    s = stepAxisLock(s, true, at(100 + AXIS_LOCK_PX, 100 + 2), at(16, 2));
    expect(s.axis).toBe('x');
    const v = stepAxisLock(stepAxisLock(noAxisLock(), true, at(0, 0), at(0, 0)), true, at(1, 9), at(1, 9));
    expect(v.axis).toBe('y');
  });

  it('calls a tie horizontal', () => {
    const s = stepAxisLock(stepAxisLock(noAxisLock(), true, at(0, 0), at(0, 0)), true, at(5, 5), at(5, 5));
    expect(s.axis).toBe('x');
  });

  it('keeps the decided axis however the pointer wanders, and moves the object along it only', () => {
    let s = stepAxisLock(stepAxisLock(noAxisLock(), true, at(0, 0), at(20, 30)), true, at(10, 1), at(30, 31));
    expect(s.axis).toBe('x');
    s = stepAxisLock(s, true, at(12, 200), at(32, 230));
    expect(s.axis).toBe('x');
    expect(lockedOffset(s, at(32, 230))).toEqual(at(32, 30)); // y stays where it was when the lock engaged
    const v = stepAxisLock(stepAxisLock(noAxisLock(), true, at(0, 0), at(20, 30)), true, at(1, 10), at(21, 40));
    expect(lockedOffset(v, at(80, 40))).toEqual(at(20, 40));
  });

  it('forgets everything on release and engages afresh on the next press', () => {
    let s = stepAxisLock(stepAxisLock(noAxisLock(), true, at(0, 0), at(0, 0)), true, at(10, 0), at(10, 0));
    expect(s.axis).toBe('x');
    s = stepAxisLock(s, false, at(10, 40), at(10, 40));
    expect(s).toEqual(noAxisLock());
    s = stepAxisLock(s, true, at(10, 40), at(10, 40));
    expect(s.axis).toBeNull();
    s = stepAxisLock(s, true, at(10, 52), at(10, 52));
    expect(s.axis).toBe('y');
  });
});
