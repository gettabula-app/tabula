/**
 * Pure helpers for the segmented control's drag and slide (segmented() in ./common.ts). No DOM here.
 * The marker's own box is never computed from a count: it is measured from the selected button.
 */

/** How far ahead a fling carries the pointer when a drag is released: 0.12 s at px/ms velocity. */
export const FLING_MS = 120;

/**
 * Index of the centre nearest to x. The centres are the selected-button centres measured from the row's left edge, in px, so
 * buttons of different widths (and rtl, where the first button is at the right) need no special case. Always 0..count-1.
 */
export function nearestCentre(x: number, centres: readonly number[]): number {
  if (centres.length <= 1 || !Number.isFinite(x)) return 0;
  let best = 0;
  for (let i = 1; i < centres.length; i++) if (Math.abs(centres[i] - x) < Math.abs(centres[best] - x)) best = i;
  return best;
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
 * FLING_MS later at its release velocity, clamped to the first and last centre. releaseX is that centre, px from the row's left edge.
 */
export function projectTarget(releaseX: number, velocityPxPerMs: number, centres: readonly number[]): number {
  if (!centres.length) return 0;
  const projected = releaseX + velocityPxPerMs * FLING_MS;
  return nearestCentre(Math.min(centres[centres.length - 1], Math.max(centres[0], projected)), centres);
}

/** A pick as the control records it just before its onPick runs: the index before the click, the index it chose, when, and whether a key made it. */
export interface PickRecord { from: number; to: number; at: number; kbd: boolean }

/**
 * The index a freshly built control's marker should start from so it slides to currentIndex, or null when it should not slide.
 * It resumes only for a pointer pick that moved from another segment, read within windowMs of the pick.
 * Keyboard picks never resume: they do not animate.
 */
export function resumeFrom(prev: PickRecord | undefined, now: number, currentIndex: number, windowMs = 400): number | null {
  if (!prev || prev.kbd) return null;
  if (now - prev.at > windowMs) return null;
  if (prev.to !== currentIndex || prev.from === currentIndex || prev.from < 0) return null;
  return prev.from;
}
