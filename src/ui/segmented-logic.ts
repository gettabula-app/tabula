/**
 * Pure geometry for the segmented control's selected marker (segmented() in ./common.ts). No DOM here.
 * The numbers match .segmented in styles.css: 4px padding inside the row and 4px between segments.
 */

export const SEG_GAP = 4;
export const SEG_PAD = 4;

/** How far ahead a fling carries the pointer when a drag is released: 0.12 s at px/ms velocity. */
export const FLING_MS = 120;

/** Width of one segment in a row `width` px wide with `count` equal segments. */
export function segmentWidth(width: number, count: number, gap: number, pad: number): number {
  return (width - 2 * pad - gap * (count - 1)) / count;
}

/**
 * Index of the segment nearest to x, where x is px from the row's left edge.
 * Segments are compared by their centres, so the boundary sits in the middle of each gap.
 * In rtl the row is mirrored: segment 0 sits at the right edge. Always returns 0..count-1.
 */
export function nearestSegment(x: number, width: number, count: number, gap: number, pad: number, rtl: boolean): number {
  if (count <= 1 || !(width > 0) || !Number.isFinite(x)) return 0;
  const px = rtl ? width - x : x;
  const seg = segmentWidth(width, count, gap, pad);
  const raw = Math.round((px - pad - seg / 2) / (seg + gap));
  return Math.min(count - 1, Math.max(0, raw));
}

/**
 * Physical translateX in px that moves the marker from segment 0 onto `index`.
 * Positive to the right in ltr, negative in rtl (where index 0 is at the right).
 */
export function segmentOffset(index: number, segWidth: number, gap: number, rtl: boolean): number {
  const offset = index * (segWidth + gap);
  return rtl ? 0 - offset : offset;
}

/**
 * Release velocity in px/ms from the pointer samples taken in the windowMs before endT.
 * A pointer that stopped moving before release has no recent samples, so the velocity is 0.
 */
export function releaseVelocity(samples: readonly { t: number; x: number }[], endT: number, windowMs = 80): number {
  const recent = samples.filter((s) => s.t >= endT - windowMs && s.t <= endT);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/**
 * The segment a released drag should land on: the nearest to where the dragged marker's centre would be
 * FLING_MS later at its release velocity, clamped to the row. releaseX is that centre, px from the row's left edge.
 */
export function projectTarget(releaseX: number, velocityPxPerMs: number, width: number, count: number, gap: number, pad: number, rtl: boolean): number {
  const projected = releaseX + velocityPxPerMs * FLING_MS;
  const clamped = Math.min(width, Math.max(0, projected));
  return nearestSegment(clamped, width, count, gap, pad, rtl);
}
