// Resizing a text object (TAB-233). A text box has two sizes: the width it wraps at, and the size of its type. The side
// handles change the wrap width (the height follows the lines); the corner handles scale the type and the width together,
// so the lines break where they did, anchored at the opposite corner; the keyboard does both (Alt+Shift+arrows). All the
// arithmetic is here, free of the DOM, so the pointer, the keys and the tests share it.

import type { BaseObj, Point } from './types';
import { styleOf, textHeight } from './markup';

export const FONT_MIN = 6;
export const FONT_MAX = 400;
export const WRAP_MIN = 8;
/** How far the wrap width moves for one key press, in world units. */
export const WRAP_KEY_STEP = 8;

export type Corner = 'nw' | 'ne' | 'se' | 'sw';
export const isCorner = (h: string): h is Corner => h === 'nw' || h === 'ne' || h === 'se' || h === 'sw';

/** The corner opposite to a handle, and the handle's own corner, in the box's own coordinates (origin at its top left). */
function corners(o: Pick<BaseObj, 'w' | 'h'>, handle: Corner): { anchor: Point; moving: Point } {
  const x = handle.includes('e') ? o.w : 0, y = handle.includes('s') ? o.h : 0;
  return { anchor: { x: o.w - x, y: o.h - y }, moving: { x, y } };
}

/** How many times larger the box becomes when its `handle` corner is dragged to `lp` (a point in the box's own coordinates): the pull along the diagonal from the fixed corner. */
export function cornerFactor(o: Pick<BaseObj, 'w' | 'h'>, handle: Corner, lp: Point): number {
  const { anchor, moving } = corners(o, handle);
  const vx = moving.x - anchor.x, vy = moving.y - anchor.y;
  const len2 = vx * vx + vy * vy;
  return len2 === 0 ? 1 : ((lp.x - anchor.x) * vx + (lp.y - anchor.y) * vy) / len2;
}

/** The type size and wrap width after scaling by `factor`: the size is a whole number of points within limits, and the width follows the size exactly, so the lines break where they did. */
export function scaledText(o: BaseObj, factor: number): { fontSize: number; w: number } {
  const size = styleOf(o).fontSize;
  const wanted = Number.isFinite(factor) ? size * factor : size;
  const fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(wanted)));
  return { fontSize, w: Math.max(WRAP_MIN, (o.w * fontSize) / size) };
}

/** The box (left, top, right, bottom in its own coordinates) of a text of width `w` and height `h` with the corner opposite `handle` where it was. */
export function cornerBox(o: Pick<BaseObj, 'w' | 'h'>, handle: Corner, w: number, h: number): { l: number; t: number; r: number; b: number } {
  const { anchor } = corners(o, handle);
  const l = handle.includes('e') ? anchor.x : anchor.x - w;
  const t = handle.includes('s') ? anchor.y : anchor.y - h;
  return { l, t, r: l + w, b: t + h };
}

export type TextKey = 'left' | 'right' | 'up' | 'down';

/** What Alt+Shift+arrow does to a text: left and right narrow and widen the wrap, up and down enlarge and shrink the type by one. Null when nothing would change. */
export function keyResize(o: BaseObj, key: TextKey): Partial<BaseObj> | null {
  const size = styleOf(o).fontSize;
  let patch: { w?: number; fontSize?: number };
  if (key === 'left' || key === 'right') {
    const w = Math.max(WRAP_MIN, o.w + (key === 'right' ? WRAP_KEY_STEP : -WRAP_KEY_STEP));
    if (w === o.w) return null;
    patch = { w };
  } else {
    const fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, size + (key === 'up' ? 1 : -1)));
    if (fontSize === size) return null;
    // the width follows the type, as the corner handles do, so the lines keep breaking where they did
    patch = { fontSize, w: (o.w * fontSize) / size };
  }
  return { ...patch, h: textHeight({ ...o, ...patch }) };
}
