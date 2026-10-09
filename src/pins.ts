import type { Thread } from './comments';
import { anchorPosition } from './comments';
import type { Obj, Point } from './types';
import { personColor } from './palette';

/** A pin as the overlay draws it. Positions are world coordinates; sizes are screen pixels (scaled by the renderer). */
export interface PinView {
  id: string; x: number; y: number; label: string; color: string; resolved: boolean; count: number; selected: boolean; draft?: boolean;
}

export const PIN_R = 11;
const DRAFT_ID = '__draft__';
const DRAFT_COLOR = '#FFD23F';
const HIT_TOLERANCE = 3;

const initial = (name: string): string => {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
};

/** Pins for the threads the caller may show, plus the draft pin while a composer is open. */
export function pinViews(opts: { threads: Thread[]; get: (id: string) => Obj | undefined; openId: string | null; draft: Point | null; visible: boolean }): PinView[] {
  const out: PinView[] = [];
  if (opts.visible) {
    for (const t of opts.threads) {
      const p = anchorPosition(t.anchor, opts.get);
      out.push({
        id: t.id, x: p.x, y: p.y, label: initial(t.authorName), color: personColor(t.authorColor), resolved: t.resolved,
        count: 1 + t.replies.length, selected: t.id === opts.openId,
      });
    }
  }
  if (opts.draft) {
    out.push({ id: DRAFT_ID, x: opts.draft.x, y: opts.draft.y, label: '+', color: DRAFT_COLOR, resolved: false, count: 0, selected: false, draft: true });
  }
  return out;
}

/** A circle of radius r whose bottom-left quadrant is a square corner; the tip is at (0,0). */
export function pinPath(r: number): string {
  return `M0 0V${-r}A${r} ${r} 0 1 1 ${r} 0Z`;
}

/** Centre of the pin whose tip is at `p`. */
export function pinCenter(p: { x: number; y: number }, r: number): Point {
  return { x: p.x + r, y: p.y - r };
}

/**
 * The topmost pin under `world` (the last in the array wins), or null. Hits the circle with a few
 * screen pixels of tolerance, or the square corner at the tip. The draft pin is never hit.
 */
export function pinAt(pins: PinView[], world: Point, zoom: number): string | null {
  const r = PIN_R / zoom;
  const reach = r + HIT_TOLERANCE / zoom;
  for (let i = pins.length - 1; i >= 0; i--) {
    const p = pins[i];
    if (p.draft || p.id === DRAFT_ID) continue;
    const c = pinCenter(p, r);
    const inCircle = Math.hypot(world.x - c.x, world.y - c.y) <= reach;
    const inTip = world.x >= p.x && world.x <= p.x + r && world.y <= p.y && world.y >= p.y - r;
    if (inCircle || inTip) return p.id;
  }
  return null;
}
