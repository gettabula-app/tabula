import type { ConnectorObj, Obj, Point } from './types';

/** A line shorter than this on screen is not created (a click without drag, or a drag that did not go anywhere). */
export const LINE_MIN_SCREEN_PX = 6;
/** Shift snaps a line's angle to steps of this many degrees, relative to the other end. */
export const LINE_ANGLE_STEP_DEG = 15;
/** A line's hit area reaches this far either side of it, in screen px (24 on a coarse pointer). */
export const LINE_HIT_PX = 10;
export const LINE_HIT_PX_COARSE = 24;

/**
 * Whether a connector is a plain line: `line` is set and it still is one (both ends free, straight). A connector that
 * stopped being one (bound, or routed elbow or curved) is an ordinary connector, whatever its stored flag says.
 */
export function lineFlag(c: object): boolean {
  const o = c as { line?: unknown; route?: unknown; from?: { kind?: unknown }; to?: { kind?: unknown } };
  return o.line === true && o.route === 'straight' && o.from?.kind === 'free' && o.to?.kind === 'free';
}

/** The angle of the line from `start` to `end` in whole degrees, 0 to 359, counter-clockwise from +x as the user sees it. */
export function lineAngleDeg(start: Point, end: Point): number {
  const deg = Math.round((Math.atan2(-(end.y - start.y), end.x - start.x) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

/** The label shown while a line is drawn: its length in world px and its angle, e.g. "186 px · 30°". */
export function lineLabel(start: Point, end: Point): string {
  return `${Math.round(Math.hypot(end.x - start.x, end.y - start.y))} px · ${lineAngleDeg(start, end)}°`;
}

/** `point` moved onto the nearest `stepDeg` direction from `start`, at the same distance. */
export function snapAngle(start: Point, point: Point, stepDeg = LINE_ANGLE_STEP_DEG): Point {
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: start.x, y: start.y };
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: start.x + len * Math.cos(a), y: start.y + len * Math.sin(a) };
}

/** `point` forced horizontal or vertical from `start`, whichever way it is further from it. */
export function axisLock(start: Point, point: Point): Point {
  return Math.abs(point.x - start.x) >= Math.abs(point.y - start.y)
    ? { x: point.x, y: start.y }
    : { x: start.x, y: point.y };
}

/** The connector a line is stored as: a line is a connector with both ends free (see ConnectorObj.line). */
export function isLine(o: Obj | undefined): o is ConnectorObj {
  return !!o && o.type === 'connector' && lineFlag(o);
}
