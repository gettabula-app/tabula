export interface Box { x: number; y: number; w: number; h: number }

export const GROUP_BAR_GAP = 20;

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Places a floating bar centred above a target box, below it when there is no room above. `avoid` lists boxes the
 * bar should not cover (the selection's connectors and arrowheads): the bar goes below when above would cover one
 * and below would not.
 */
export function placeBar(
  target: Box, bar: { w: number; h: number }, view: { w: number; h: number }, lift = 0, margin = 12, topInset = 64, gap = 12,
  avoid: Box[] = [], left = margin,
): { x: number; y: number; below: boolean } {
  const maxX = view.w - bar.w - margin;
  const cx = target.x + target.w / 2 - bar.w / 2;
  const x = maxX >= left ? Math.max(left, Math.min(maxX, cx)) : left;
  const yAbove = target.y - gap - lift - bar.h;
  const yBelow = target.y + target.h + gap;
  const aboveFits = yAbove >= topInset;
  const belowFits = yBelow + bar.h <= view.h - margin;
  const covers = (y: number) => avoid.some((b) => overlaps({ x, y, w: bar.w, h: bar.h }, b));
  if (aboveFits && !(belowFits && covers(yAbove) && !covers(yBelow))) return { x, y: yAbove, below: false };
  if (belowFits) return { x, y: yBelow, below: true };
  return { x, y: Math.max(topInset, Math.min(view.h - bar.h - margin, yBelow)), below: true };
}

/**
 * The top of a panel docked to the bottom edge, or null. A panel whose top is at `top`, the bottom of the top bars,
 * is a side panel and leaves the room under the bar alone.
 */
export function dockTopOf(panel: { top: number } | null, top: number): number | null {
  return panel && panel.top > top + 1 ? panel.top : null;
}

/**
 * Keeps a bar of width `w` at `x` between `left` and `right` px from the window's edges. On a phone the rail runs the full
 * height, so `left` is its clearance there: the bar starts right of it instead of covering it.
 */
export function clampX(x: number, w: number, viewW: number, left: number, right = 12): number {
  const max = viewW - w - right;
  return max < left ? left : Math.max(left, Math.min(max, x));
}

/** Lifts a bar of height `h` at `y` to sit `gap` above a bottom-docked panel (`dock`), no higher than `top`. */
export function clearOfDock(y: number, h: number, dock: number | null, top: number, gap = 12): number {
  return dock === null || y + h + gap <= dock ? y : Math.max(top, dock - gap - h);
}
