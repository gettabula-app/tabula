import type { BoardApp } from '../app';
import { center } from '../geometry';
import { isBox } from '../types';
import type { BaseObj, ObjType, Point } from '../types';

/** How far each further click placement moves right and down. The same 24 that Duplicate uses. */
export const PLACE_OFFSET = 24;

/** The last click placement: the object's top left as placed, and the viewport centre its run of clicks started at. */
export interface ClickRun { x: number; y: number; centre: Point; n: number }

/**
 * Where a click in a drawer puts an object of `size`: the viewport centre, or one step right and down from the last
 * click placement while that one is still where it was put and the view has not moved a step away. A run stops at
 * `room`, how far it may drift from the centre, and starts over there. The step is taken from the placed object's own
 * top left, which sits on the grid when snapping is on, so a step of 24 moves one cell on every grid size up to 48.
 */
export function nextClick(run: ClickRun | null, centre: Point, size: { w: number; h: number }, room: number, step = PLACE_OFFSET): { at: Point; centre: Point; n: number } {
  const near = run && Math.abs(centre.x - run.centre.x) < step && Math.abs(centre.y - run.centre.y) < step;
  if (run && near && (run.n + 1) * step <= room) {
    return { at: { x: run.x + step + size.w / 2, y: run.y + step + size.h / 2 }, centre: run.centre, n: run.n + 1 };
  }
  return { at: centre, centre, n: 0 };
}

const runs = new WeakMap<BoardApp, ClickRun & { id: string }>();

/** Places an object for a click in the Icons or Stickers drawer. Dragging onto the board places it exactly where it is dropped, as before. */
export function placeClicked(app: BoardApp, type: ObjType, w: number, h: number, extra: Partial<BaseObj> = {}): BaseObj {
  const vp = app.r.viewport();
  const last = runs.get(app);
  const there = last ? app.store.get(last.id) : undefined;
  const run = last && isBox(there) && there.x === last.x && there.y === last.y ? last : null;
  const next = nextClick(run, center(vp), { w, h }, Math.min(vp.w, vp.h) / 3);
  const o = app.placeAt(type, next.at, w, h, extra);
  runs.set(app, { id: o.id, x: o.x, y: o.y, centre: next.centre, n: next.n });
  return o;
}
