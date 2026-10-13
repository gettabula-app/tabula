// Axis lock (docs/guides.md): while the lock key is held, a drag moves along one axis only. The key is Cmd on a Mac and Ctrl elsewhere (Shift stays
// for angles and proportions, Alt for ignoring guides). Pure: the pointer handlers in app.ts feed it the pointer and the key, and apply what it returns.

import type { Point } from './types';

/** How far the pointer moves (screen px) after the lock engages before the axis is decided. */
export const AXIS_LOCK_PX = 6;

export type LockAxis = 'x' | 'y';

export interface AxisLock {
  /** The decided axis, or null while the key is up or the pointer has not moved far enough yet. */
  axis: LockAxis | null;
  /** The pointer (screen px) and the drag offset (world units) at the moment the lock engaged; null while the key is up. */
  from: { pointer: Point; offset: Point } | null;
}

export const noAxisLock = (): AxisLock => ({ axis: null, from: null });

/** Whether this event holds the lock key: Cmd on a Mac, Ctrl elsewhere. */
export function lockKeyHeld(e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

export const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The lock after the pointer moved to `pointer` (screen px) with the drag at `offset` (world units from where it started) and the key `held` or not.
 * Releasing the key forgets everything; pressing it again engages afresh from where the pointer is then. The axis is the one the pointer moved more on
 * since the lock engaged (a tie is horizontal), and stays until release.
 */
export function stepAxisLock(lock: AxisLock, held: boolean, pointer: Point, offset: Point): AxisLock {
  if (!held) return lock.from === null ? lock : noAxisLock();
  const from = lock.from ?? { pointer, offset };
  if (lock.axis) return { axis: lock.axis, from };
  const dx = pointer.x - from.pointer.x;
  const dy = pointer.y - from.pointer.y;
  if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return { axis: null, from };
  return { axis: Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y', from };
}

/**
 * The drag offset to apply: the raw one when the key is up; the offset at engagement while the axis is undecided (the object waits); then only the
 * part along the axis moves, the other part stays where it was at engagement, so engaging or releasing never makes the object jump.
 */
export function lockedOffset(lock: AxisLock, raw: Point): Point {
  if (!lock.from) return raw;
  const o = lock.from.offset;
  if (lock.axis === 'x') return { x: raw.x, y: o.y };
  if (lock.axis === 'y') return { x: o.x, y: raw.y };
  return o;
}
