/** Where the Add emoji button goes while a note's text is edited. Pure: the caller measures, this decides. */
export interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }

/** The corner placement: the note must be at least this many px on each side on screen, and the button sits this far in from its left and bottom edges. */
export const CORNER_MIN = 140;
export const CORNER_INSET = 8;
/** The tray of the smaller corner button on a mouse: 32 px and its 4 px padding on each side. */
export const CORNER_TRAY_FINE = 40;

export interface EditBarInput {
  /** The text box on screen. */
  box: Rect;
  /** The button's tray. */
  width: number;
  height: number;
  /** The room the button may use (safe areas and the soft keyboard already taken off). */
  edges: { left: number; right: number; top: number; bottom: number };
  /** On a mouse the button is smaller in the corner (so it clears the note's text); the tray's size there. Touch keeps 44 px. */
  cornerTray?: { width: number; height: number };
  /** Whether the tray at (x, top) would sit under the top bars. */
  hits(x: number, top: number): boolean;
}

export type EditBarSide = 'corner' | 'above' | 'below';

/**
 * In the bottom-left corner area of the note, inset from its edges, when the note is big enough on screen to hold it. On a
 * small note (zoomed out, or a narrow box) that would cover its text, so it goes above or below it, on the side with more room
 * and never under the top bars, as before.
 */
export function placeEditBar({ box, width, height, edges, hits, cornerTray }: EditBarInput): { x: number; y: number; side: EditBarSide } {
  const clampY = (y: number) => Math.max(edges.top, Math.min(y, edges.bottom - height));
  if (box.width >= CORNER_MIN && box.height >= CORNER_MIN) {
    const w = cornerTray?.width ?? width;
    const h = cornerTray?.height ?? height;
    const x = Math.max(edges.left, Math.min(box.left + CORNER_INSET, edges.right - w));
    return { x, y: Math.max(edges.top, Math.min(box.bottom - h - CORNER_INSET, edges.bottom - h)), side: 'corner' };
  }
  const x = Math.max(edges.left, Math.min((box.left + box.right - width) / 2, edges.right - width));
  const above = box.top - 8 - height;
  const below = box.bottom + 8;
  const side: EditBarSide = hits(x, above) && !hits(x, below) ? 'below' : hits(x, below) && !hits(x, above) ? 'above'
    : box.top - edges.top >= edges.bottom - box.bottom - height ? 'above' : 'below';
  return { x, y: clampY(side === 'above' ? above : below), side };
}
