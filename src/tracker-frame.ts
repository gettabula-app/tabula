import type { BaseObj, Point } from './types';
import { newId } from './store';
import type { Store } from './store';

// What a frame with no tickets to show says: a signed-in guest sees the element but gets no tracker; everyone else is told how to get tickets.
let guestAudience = false;
/** Set by the board when the auth state changes (the person is a guest: a guest-link session or a guest account). */
export function setTrackerGuest(guest: boolean): void {
  guestAudience = guest;
}
// the phone's frame is always a snapshot (frame.ts, isPhone): there the Open chip is the way in
const phoneNow = (): boolean => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
let memberAudience = false;
/** Set by the board: the person is signed in to a workspace with a tracker. A frame with no snapshot yet (past the live cap) is then not asking for a sign-in. */
export function setTrackerMember(member: boolean): void {
  memberAudience = member;
}
export const trackerNoTicketsLine = (): string => (guestAudience ? 'Tickets are for workspace members.' : memberAudience ? (phoneNow() ? 'Open this tracker to see its tickets.' : 'Zoom in or select this tracker to see its tickets.') : 'Sign in to a workspace to see tickets.');
const escapeLine = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');


export const TRACKER_FRAME_DEFAULT_SIZE = { w: 720, h: 480 } as const;
export const TRACKER_FRAME_MIN_SIZE = { w: 360, h: 280 } as const;

/** The SVG snapshot hook; the tracker UI can register its own static frame renderer later. */
export type TrackerRenderer = (frame: BaseObj) => string;

/** Safe, static fallback used by board drawing and PNG/SVG export. It contains no ticket data. */
export function trackerPlaceholder(frame: BaseObj): string {
  const w = Number.isFinite(frame.w) ? Math.max(0, frame.w) : 0;
  const h = Number.isFinite(frame.h) ? Math.max(0, frame.h) : 0;
  const ruleY = Math.min(64, h);
  return `<rect x="0" y="0" width="${w}" height="${h}" fill="var(--paper, #F7F5F0)" stroke="var(--ink, #121216)" stroke-width="1"/>` +
    `<text x="24" y="40" font-family="sans-serif" font-size="20" font-weight="700" fill="var(--ink, #121216)">Tracker</text>` +
    `<text x="${Math.max(24, w - 24)}" y="40" text-anchor="end" font-family="sans-serif" font-size="12" fill="var(--graphite, #55555C)">TAB</text>` +
    `<line x1="0" y1="${ruleY}" x2="${w}" y2="${ruleY}" stroke="var(--rule, #55555C)" stroke-width="1"/>` +
    `<text x="24" y="${Math.min(h - 20, 92)}" font-family="sans-serif" font-size="12" fill="var(--graphite, #55555C)">${escapeLine(trackerNoTicketsLine())}</text>`;
}

let trackerRenderer: TrackerRenderer = trackerPlaceholder;

/** Register the designer's frame snapshot renderer. The returned function restores the previous renderer. */
export function registerTrackerRenderer(renderer: TrackerRenderer): () => void {
  const previous = trackerRenderer;
  trackerRenderer = renderer;
  return () => {
    if (trackerRenderer === renderer) trackerRenderer = previous;
  };
}

export function renderTrackerFrame(frame: BaseObj): string {
  return trackerRenderer(frame);
}

/** Create a frame for this workspace's tracker, reusing the workspace tracker ID when another frame already exists. */
export function createTrackerFrame(store: Store, position: Point): BaseObj | null {
  if (store.readOnly) return null;
  const existing = [...store.cache.values()].find((o) => {
    const trackerId = (o as BaseObj).trackerId;
    return o.type === 'tracker' && typeof trackerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(trackerId);
  }) as BaseObj | undefined;
  const frame: BaseObj = {
    id: newId(),
    type: 'tracker',
    x: position.x,
    y: position.y,
    ...TRACKER_FRAME_DEFAULT_SIZE,
    rotation: 0,
    z: store.topZ(),
    trackerId: existing?.trackerId ?? newId(),
    view: 'all',
  };
  store.transact(() => store.create(frame));
  return frame;
}
