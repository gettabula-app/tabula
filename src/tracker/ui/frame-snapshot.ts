import type { BaseObj } from '../../types';
import type { TrackerTicket } from '../../tracker-types';

interface Snapshot { open: number; inProgress: number }
/** Keyed by the frame object's id, so two frames on one tracker (with different views) never share a snapshot. */
const snapshots = new Map<string, Snapshot>();

/**
 * Publishes the counts over the tickets an element has loaded (the view it shows).
 * `objectId` is the frame object's id. A ticket is open unless its state is completed or canceled; in progress means started.
 */
export function publishTrackerSnapshot(objectId: string, tickets: readonly Pick<TrackerTicket, 'state'>[]): void {
  let open = 0;
  let inProgress = 0;
  for (const ticket of tickets) {
    const category = ticket.state?.category;
    if (category !== 'completed' && category !== 'canceled') open += 1;
    if (category === 'started') inProgress += 1;
  }
  snapshots.set(objectId, { open, inProgress });
}

/** Drops every published snapshot: on sign-out and when the store reports that access to the tracker was lost. */
export function clearTrackerSnapshots(): void {
  snapshots.clear();
}

const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

/** The skeleton lines under the count, as fractions of the card's text width (10px bars, 10% ink tint). */
const SKELETON_WIDTHS = [1, 0.88, 0.74, 0.92] as const;

/**
 * Cheap static overview for board paint, thumbnails, SVG export, and frames whose DOM is not mounted: the element card with its
 * title and counts, and skeleton lines. No text beyond these, and no foreignObject, so the exporter can draw it.
 */
export function renderTrackerSnapshot(frame: BaseObj): string {
  const w = n(frame.w), h = n(frame.h);
  const snapshot = snapshots.get(frame.id);
  // no snapshot means no store (a guest, or no workspace): the copy says how to get tickets, not that there are none
  const countLine = snapshot ? `${snapshot.open} open · ${snapshot.inProgress} in progress` : 'Sign in to a workspace to see tickets.';
  const pieces = [
    `<rect x="0.5" y="0.5" width="${Math.max(0, w - 1)}" height="${Math.max(0, h - 1)}" rx="12" fill="var(--paper, #FFFFFF)" fill-opacity="1" stroke="var(--ink, #111111)" stroke-opacity="0.22" stroke-width="1"/>`,
    `<text x="20" y="44" font-family="var(--font-serif, Georgia, serif)" font-size="28" font-weight="400" fill="var(--ink, #111111)">Tracker</text>`,
    `<text x="20" y="72" font-family="var(--ui, sans-serif)" font-size="15" fill="var(--graphite, #65635F)">${countLine.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</text>`,
  ];
  const textWidth = Math.max(0, w - 40);
  SKELETON_WIDTHS.forEach((fraction, index) => {
    const y = 100 + index * 22;
    if (y + 10 > h - 12) return;
    pieces.push(`<rect x="20" y="${y}" width="${Math.round(textWidth * fraction)}" height="10" rx="3" fill="var(--ink, #111111)" fill-opacity="0.1"/>`);
  });
  return pieces.join('');
}
