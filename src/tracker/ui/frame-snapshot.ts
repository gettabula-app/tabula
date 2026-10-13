import type { BaseObj } from '../../types';
import type { TrackerTicket, TrackerView } from '../../tracker-types';

interface Snapshot { tab: TrackerView; rows: Array<{ key: string; title: string; state: string }>; count: number }
/** Keyed by the frame object's id, so two frames on one tracker (with different views) never share a snapshot. */
const snapshots = new Map<string, Snapshot>();
const TAB_LABEL: Record<TrackerView, string> = { inbox: 'Inbox', my: 'My issues', all: 'All issues', board: 'Board', projects: 'Projects' };

/** Publishes what an element shows: its own tab (view) and its first rows. `objectId` is the frame object's id. */
export function publishTrackerSnapshot(objectId: string, tab: TrackerView, tickets: readonly TrackerTicket[], count: number): void {
  snapshots.set(objectId, {
    tab,
    rows: tickets.slice(0, 12).map((ticket) => ({ key: ticket.key, title: ticket.title, state: ticket.state.name })),
    count: Math.max(0, Math.floor(count)),
  });
}

/** Drops every published snapshot: on sign-out and when the store reports that access to the tracker was lost. */
export function clearTrackerSnapshots(): void {
  snapshots.clear();
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

/** Cheap static overview for board paint, thumbnails, SVG export, and frames whose DOM is not mounted. */
export function renderTrackerSnapshot(frame: BaseObj): string {
  const w = n(frame.w), h = n(frame.h);
  const snapshot = snapshots.get(frame.id);
  // the element's own tab: what its shell last showed, else the view stored on the object
  const tab = snapshot?.tab ?? (frame.view === 'inbox' || frame.view === 'my' || frame.view === 'all' || frame.view === 'board' || frame.view === 'projects' ? frame.view : 'all');
  const rows = snapshot?.rows ?? [];
  const left = 28, top = 94, line = 40;
  const pieces = [
    `<rect x="0" y="0" width="${w}" height="${h}" fill="var(--paper, #FFFFFF)" stroke="var(--ink, #18212B)" stroke-width="1"/>`,
    `<text x="28" y="42" font-family="var(--ui, sans-serif)" font-size="24" font-weight="650" fill="var(--ink, #18212B)">Tracker</text>`,
    `<text x="${Math.max(left, w - left)}" y="42" text-anchor="end" font-family="var(--ui, sans-serif)" font-size="13" fill="var(--graphite, #5B6672)">${xml(TAB_LABEL[tab])}</text>`,
    `<line x1="0" y1="64" x2="${w}" y2="64" stroke="var(--rule, #D5DBE2)" stroke-width="1"/>`,
  ];
  const shown = rows.slice(0, Math.min(12, Math.max(0, Math.floor((h - top - 28) / line))));
  shown.forEach((row, index) => {
    const y = top + index * line;
    pieces.push(`<line x1="${left}" y1="${y + 13}" x2="${w - left}" y2="${y + 13}" stroke="var(--rule, #D5DBE2)" stroke-width=".65"/>`);
    pieces.push(`<text x="${left}" y="${y}" font-family="var(--ui, sans-serif)" font-size="12" font-weight="650" fill="var(--ink, #18212B)">${xml(row.key)}</text>`);
    pieces.push(`<text x="${left + 92}" y="${y}" font-family="var(--ui, sans-serif)" font-size="13" fill="var(--ink, #18212B)">${xml(row.title.slice(0, 96))}</text>`);
    pieces.push(`<text x="${w - left}" y="${y}" text-anchor="end" font-family="var(--ui, sans-serif)" font-size="11" fill="var(--graphite, #5B6672)">${xml(row.state)}</text>`);
  });
  // no snapshot means no store (a guest, or no workspace): the copy says how to get tickets, not that there are none
  if (!shown.length) pieces.push(`<text x="${left}" y="${top}" font-family="var(--ui, sans-serif)" font-size="13" fill="var(--graphite, #5B6672)">${snapshot ? 'No issues in this view' : 'Sign in to a workspace to see tickets.'}</text>`);
  pieces.push(`<text x="${w - left}" y="${h - 22}" text-anchor="end" font-family="var(--ui, sans-serif)" font-size="12" fill="var(--graphite, #5B6672)">${snapshot ? `${snapshot.count} issues` : 'Overview'}</text>`);
  return pieces.join('');
}
