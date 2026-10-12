// What the camera frames when it goes to a step's frame. A template puts its title and subtitle above the frame, loose on the
// board: flown to the frame alone they land under the board-name tray, so the view takes in the loose text just above it.
import type { BaseObj, Obj, Rect } from './types';
import { boxBounds, unionRects } from './geometry';

/** How far above the frame, in board units, loose text still counts as its heading (a template's title sits 150 up, 40 tall). */
export const HEADING_REACH = 160;

/** `frame`'s bounds, grown upward to take in the unparented text just above it that overlaps it sideways. */
export function stepViewBounds(frame: BaseObj, objects: Iterable<Obj>): Rect {
  const own = boxBounds(frame);
  const heading: Rect[] = [];
  for (const o of objects) {
    if (o.type !== 'text' || o.parent || o.id === frame.id) continue;
    const b = boxBounds(o as BaseObj);
    const bottom = b.y + b.h;
    if (bottom > own.y || bottom < own.y - HEADING_REACH) continue;
    if (b.x + b.w <= own.x || b.x >= own.x + own.w) continue;
    heading.push(b);
  }
  return unionRects([own, ...heading]) ?? own;
}
