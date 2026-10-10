/** A rectangle in window pixels. */
export type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Where a popover goes when it must not cover its anchor, as for the menu a long press opens: the finger is still down on
 * the anchor, so an item under it would be pressed on release. The popover goes below the anchor, or above it when there is
 * more room there, and is shortened (the caller scrolls it) to the room that side has. `safe` is the window's insets and `gap`
 * the space kept to the anchor and to the window edge.
 */
export function placeBesideAnchor(
  anchor: Rect, size: { width: number; height: number }, view: { width: number; height: number },
  safe: { top: number; right: number; bottom: number; left: number }, gap = 8,
): { left: number; top: number; maxHeight: number } {
  const roomBelow = view.height - safe.bottom - gap - (anchor.bottom + gap);
  const roomAbove = anchor.top - gap - (safe.top + gap);
  const below = size.height <= roomBelow || roomBelow >= roomAbove;
  const maxHeight = Math.max(0, Math.floor(below ? roomBelow : roomAbove));
  const height = Math.min(size.height, maxHeight);
  const top = below ? anchor.bottom + gap : anchor.top - gap - height;
  const left = Math.max(gap + safe.left, Math.min(view.width - safe.right - size.width - gap, anchor.left));
  return { left, top, maxHeight };
}
