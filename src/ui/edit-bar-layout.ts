/** Where the Add emoji button goes while a note's text is edited. Pure: the caller measures, this decides. */
export interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }

/** The visible gap between the note's edge and the button's edge, at the left and at the bottom. */
export const CORNER_INSET = 8;
/** The corner placement needs a note at least this many px on each side on screen: 160 for a mouse, 180 for a finger. */
export const CORNER_MIN_FINE = 160;
export const CORNER_MIN_TOUCH = 180;
/** The corner button: 32 px for a mouse, 44 px for a finger. In the corner the tray around it has no padding, so its edge is the button's edge. */
export const CORNER_BUTTON_FINE = 32;
export const CORNER_BUTTON_TOUCH = 44;
/** The editor keeps this clear at the bottom of the text while the corner button is shown: the button, the 8 px gap and 4 px more. */
export const cornerTextInset = (fine: boolean): number => (fine ? CORNER_BUTTON_FINE : CORNER_BUTTON_TOUCH) + CORNER_INSET + 4;

export interface EditBarInput {
  /** The text box on screen (inside the note for a sticky). */
  box: Rect;
  /** The note itself on screen: its edges are what the gap is measured from. Defaults to the text box. */
  note?: Rect;
  /** The tray's size where it is (above or below the text). */
  width: number;
  height: number;
  /** The room the button may use (safe areas and the soft keyboard already taken off). */
  edges: { left: number; right: number; top: number; bottom: number };
  /** A mouse or trackpad (a fine pointer) rather than a finger. */
  fine: boolean;
  /** Whether the tray at (x, top) would sit under the top bars. */
  hits(x: number, top: number): boolean;
}

export type EditBarSide = 'corner' | 'above' | 'below';

/**
 * In the bottom-left corner of the note, 8 px from its left and bottom edges, when the note is big enough on screen to hold it
 * without covering its text (160 px a side for a mouse, 180 for a finger). On a smaller note it goes above or below the text,
 * on the side with more room and never under the top bars.
 */
export function placeEditBar({ box, note = box, width, height, edges, fine, hits }: EditBarInput): { x: number; y: number; side: EditBarSide; size: number } {
  const clampY = (y: number, h: number) => Math.max(edges.top, Math.min(y, edges.bottom - h));
  const min = fine ? CORNER_MIN_FINE : CORNER_MIN_TOUCH;
  if (note.width >= min && note.height >= min) {
    const size = fine ? CORNER_BUTTON_FINE : CORNER_BUTTON_TOUCH;
    const x = Math.max(edges.left, Math.min(note.left + CORNER_INSET, edges.right - size));
    return { x, y: clampY(note.bottom - size - CORNER_INSET, size), side: 'corner', size };
  }
  const x = Math.max(edges.left, Math.min((box.left + box.right - width) / 2, edges.right - width));
  const above = box.top - 8 - height;
  const below = box.bottom + 8;
  const side: EditBarSide = hits(x, above) && !hits(x, below) ? 'below' : hits(x, below) && !hits(x, above) ? 'above'
    : box.top - edges.top >= edges.bottom - box.bottom - height ? 'above' : 'below';
  return { x, y: clampY(side === 'above' ? above : below, height), side, size: 0 };
}
