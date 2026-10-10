export interface PopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PopoverInsets { top: number; right: number; bottom: number; left: number }

export interface PopoverPlacement { left: number; top: number; maxHeight: number | null }

/** Places a floating panel inside the viewport; a top panel may be constrained against a larger surface it must clear. */
export function placePopover(
  anchor: PopoverRect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  safe: PopoverInsets,
  side: 'right' | 'bottom' | 'top' | 'left',
  avoidAbove?: PopoverRect,
  /** A bottom panel keeps below the anchor and scrolls inside the room left, instead of sliding up over the anchor. */
  fitBelow = false,
): PopoverPlacement {
  const edge = 8;
  const gap = side === 'top' ? 10 : 8;
  let left = anchor.left;
  let top = anchor.bottom + gap;
  let maxHeight: number | null = null;
  let height = panel.height;

  if (side === 'right') {
    left = anchor.right + 10;
    top = anchor.top;
  } else if (side === 'left') {
    left = anchor.left - panel.width - 10;
    top = anchor.top;
  } else if (side === 'top') {
    const upperEdge = avoidAbove?.top ?? anchor.top;
    maxHeight = Math.max(0, upperEdge - safe.top - edge - gap);
    height = Math.min(height, maxHeight);
    left = anchor.left + anchor.width / 2 - panel.width / 2;
    top = upperEdge - height - gap;
  }

  left = Math.max(edge + safe.left, Math.min(viewport.width - safe.right - panel.width - edge, left));
  if (side === 'bottom' && fitBelow) {
    maxHeight = Math.max(0, viewport.height - safe.bottom - edge - top);
    height = Math.min(height, maxHeight);
  }
  if (side !== 'top') {
    top = Math.max(edge + safe.top, Math.min(viewport.height - safe.bottom - height - edge, top));
  }
  return { left, top, maxHeight };
}
