// The pure parts of the tracker element's board drag (slice 2 of the tracker element): where a pointer is, how far the lane strip
// should scroll, the element's scale on the board, and how many lanes fit at the element's width. Coordinates are client pixels
// unless a function says otherwise. Nothing here touches the DOM, so the rules are unit-tested (test/tracker-board-drag.test.ts).

export interface BoardRect { left: number; top: number; right: number; bottom: number }
export interface BoardLane { key: string; rect: BoardRect }
export interface BoardPoint { x: number; y: number }

/** A pointer must move this far before a card starts to drag (smaller moves are a click). */
export const DRAG_THRESHOLD_PX = 4;
/** A touch must rest this long on a card before it drags; a quicker move scrolls the lanes. */
export const LONG_PRESS_MS = 300;
/** Within this distance of the lane strip's edge, the strip scrolls during a drag. */
export const AUTO_SCROLL_EDGE_PX = 32;
/** The most the strip scrolls in one frame. */
export const AUTO_SCROLL_MAX_PX = 16;

const LANE_PADDING_PX = 24; // the lane strip's left and right padding together
const LANE_GAP_PX = 12;
const LANE_MIN_PX = 200;

/** The key of the first lane that contains the point (edges included), or null when the point is over no lane. */
export function laneAtPoint(point: BoardPoint, lanes: ReadonlyArray<BoardLane>): string | null {
  for (const lane of lanes) {
    const { left, right, top, bottom } = lane.rect;
    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return lane.key;
  }
  return null;
}

/** The rectangle shared by two rectangles (a lane clipped to the strip that shows it). Empty when they do not overlap. */
export function clipRect(rect: BoardRect, clip: BoardRect): BoardRect {
  return {
    left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
    top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom),
  };
}

/**
 * How far the lane strip scrolls, in client pixels per frame, for a pointer at `pointerX`: negative near (or past) the left edge,
 * positive near (or past) the right edge, 0 in the middle. It ramps up linearly inside the edge band, up to AUTO_SCROLL_MAX_PX.
 */
export function autoScrollDelta(pointerX: number, rect: { left: number; right: number }, edge = AUTO_SCROLL_EDGE_PX): number {
  if (!(edge > 0)) return 0;
  const fromLeft = pointerX - rect.left;
  const fromRight = rect.right - pointerX;
  if (fromLeft < edge && fromLeft <= fromRight) {
    return -AUTO_SCROLL_MAX_PX * Math.min(1, (edge - fromLeft) / edge);
  }
  if (fromRight < edge) return AUTO_SCROLL_MAX_PX * Math.min(1, (edge - fromRight) / edge);
  return 0;
}

/**
 * The scale the board applies to the element: its on-screen width over its layout width. A pointer delta in screen pixels divided
 * by this is a delta in the element's own layout units. Falls back to 1 when either width is unknown (a detached or hidden shell).
 */
export function scaleOf(rect: { width: number }, offsetWidth: number): number {
  if (!(offsetWidth > 0) || !(rect.width > 0)) return 1;
  return rect.width / offsetWidth;
}

/** The lanes that fit side by side at the element's layout width: three from 720, two from 480, one below that. */
export function columnsFor(width: number): number {
  if (width >= 720) return 3;
  if (width >= 480) return 2;
  return 1;
}

/** One lane's width at the element's layout width: the strip's room less the gaps, split by the columns, never under 200px. */
export function laneWidthFor(width: number): number {
  const columns = columnsFor(width);
  return Math.max(LANE_MIN_PX, Math.floor((width - LANE_PADDING_PX - LANE_GAP_PX * (columns - 1)) / columns));
}
