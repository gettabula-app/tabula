// Pure kanban maths for the canvas (docs/kanban.md, slice 2): where a dragged card would land, where the keyboard moves
// one, what a lane's count says, what a due chip says, how tall a card is, and when the board draws in low detail.
// No DOM and no store: the callers pass rectangles from the shared layout (shared/containers.mjs).

import { KANBAN, type ContainerLayout, type Rect } from '../../shared/containers';

/** Below this zoom card text becomes bars and a lane header shows only its name (docs/kanban.md, Rendering). */
export const LOW_DETAIL_ZOOM = 0.4;
export const lowDetail = (zoom: number) => zoom < LOW_DETAIL_ZOOM;

/** Card content metrics from the visual design (Anatomy): padding 8 / 12, rows 8 apart. */
export const CARD = {
  padY: 8,
  padX: 12,
  /** Left padding when the card has an accent edge from `fill`. */
  padAccent: 16,
  accent: 4,
  titleSize: 13,
  titleLine: 18,
  titleLines: 3,
  rowGap: 8,
  labelRow: 16,
  metaRow: 24,
} as const;

/** The "+ Add card" row after the last card, and the inline input that replaces it. */
export const ADD_ROW = 40;

export interface CardContent {
  /** Wrapped title lines (only the count matters; at most three are drawn). */
  lines: number;
  labels: boolean;
  /** A due date or an owner: the meta row. */
  meta: boolean;
}

/** A card's height from what it shows. The writer stores it as `h`, so no reader measures text. */
export function cardHeight(c: CardContent): number {
  let h = CARD.padY * 2 + Math.min(Math.max(c.lines, 1), CARD.titleLines) * CARD.titleLine;
  if (c.labels) h += CARD.rowGap + CARD.labelRow;
  if (c.meta) h += CARD.rowGap + CARD.metaRow;
  return h;
}

/** The dashed "No cards" box at the top of an empty lane's body. */
export function emptyBox(lane: Rect): Rect {
  return { x: lane.x + KANBAN.lanePad, y: lane.y + KANBAN.header + KANBAN.lanePad, w: lane.w - KANBAN.lanePad * 2, h: KANBAN.emptyLane };
}

/** The "+ Add card" row: after the last card, or under the empty box. The layout's drop zone (56) always holds it. */
export function addRow(lane: Rect, cards: Rect[]): Rect {
  const last = cards[cards.length - 1];
  const y = last ? last.y + last.h + KANBAN.cardGap : emptyBox(lane).y + KANBAN.emptyLane + KANBAN.cardGap;
  return { x: lane.x + KANBAN.lanePad, y, w: lane.w - KANBAN.lanePad * 2, h: ADD_ROW };
}

const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Where in a lane a point is: its header band, its add-card row, or the rest of the body. */
export function laneRegionAt(lane: Rect, cards: Rect[], p: { x: number; y: number }): 'header' | 'add' | 'body' {
  if (p.y < lane.y + KANBAN.header) return 'header';
  return inside(addRow(lane, cards), p) ? 'add' : 'body';
}

/** How many of a lane's cards (top to bottom) are above the pointer, by their midpoints: the insertion index. */
export function dropIndexAt(cards: Rect[], y: number): number {
  let i = 0;
  while (i < cards.length && cards[i].y + cards[i].h / 2 < y) i++;
  return i;
}

export interface LaneTarget {
  kind: 'lane';
  container: string;
  id: string;
  /** Insertion index among the lane's cards that are not being moved. */
  index: number;
}

/**
 * The lane a dragged card would land in. `containers` are in paint order, topmost last, as the store gives them, so the
 * topmost container under the point wins. Inside a container the lane is the one whose column holds the point, or the
 * nearest column when the point is in a gap or the padding. Moving cards never count, so a card never targets itself.
 */
export function laneTargetAt(
  containers: { id: string; layout: ContainerLayout }[],
  p: { x: number; y: number },
  moving: ReadonlySet<string>,
): LaneTarget | null {
  for (let i = containers.length - 1; i >= 0; i--) {
    const { id, layout } = containers[i];
    const box = layout.rects.get(id);
    if (!box || !inside(box, p) || !layout.lanes.length) continue;
    let best: string | null = null;
    let bestD = Infinity;
    for (const laneId of layout.lanes) {
      const r = layout.rects.get(laneId)!;
      const d = p.x < r.x ? r.x - p.x : p.x > r.x + r.w ? p.x - r.x - r.w : 0;
      if (d < bestD) {
        bestD = d;
        best = laneId;
      }
    }
    if (!best) continue;
    const cards = laneCards(layout, best, moving);
    return { kind: 'lane', container: id, id: best, index: dropIndexAt(cards, p.y) };
  }
  return null;
}

/** The rectangles of a lane's cards, top to bottom, leaving out `skip`. */
export function laneCards(layout: ContainerLayout, laneId: string, skip: ReadonlySet<string> = new Set()): Rect[] {
  return (layout.cards.get(laneId) ?? []).filter((id) => !skip.has(id)).map((id) => layout.rects.get(id)!);
}

/**
 * The 2px drop line for an insertion at `index` among `cards` (the lane's cards that are not moving): centred in the 8px
 * gap above the card at that index, under the last card, or at the top of an empty lane's body.
 */
export function dropLine(lane: Rect, cards: Rect[], index: number): Rect {
  const x = lane.x + KANBAN.lanePad;
  const w = lane.w - KANBAN.lanePad * 2;
  const half = KANBAN.cardGap / 2;
  const at = Math.min(Math.max(index, 0), cards.length);
  let y: number;
  if (!cards.length) y = lane.y + KANBAN.header + KANBAN.lanePad - half;
  else if (at < cards.length) y = cards[at].y - half;
  else y = cards[at - 1].y + cards[at - 1].h + half;
  return { x, y: y - 1, w, h: 2 };
}

export type MoveKey = 'up' | 'down' | 'left' | 'right';

export interface KeyboardMove {
  lane: string;
  /** Insertion index among the target lane's cards without the moving one. */
  index: number;
  /** 1-based place after the move, and the lane's card count after it, for the announcement. */
  position: number;
  total: number;
}

/**
 * Where Alt+arrow moves a card: up and down within its lane, left and right to the neighbouring lane at the same index
 * when it has that many cards, else at its end. Null at an edge (nothing to do).
 */
export function keyboardMove(layout: ContainerLayout, cardId: string, key: MoveKey): KeyboardMove | null {
  const li = layout.lanes.findIndex((l) => layout.cards.get(l)?.includes(cardId));
  if (li < 0) return null;
  const own = layout.cards.get(layout.lanes[li])!;
  const i = own.indexOf(cardId);
  if (key === 'up' || key === 'down') {
    const to = key === 'up' ? i - 1 : i + 1;
    if (to < 0 || to >= own.length) return null;
    return { lane: layout.lanes[li], index: to, position: to + 1, total: own.length };
  }
  const lj = key === 'left' ? li - 1 : li + 1;
  if (lj < 0 || lj >= layout.lanes.length) return null;
  const other = layout.cards.get(layout.lanes[lj]) ?? [];
  const index = Math.min(i, other.length);
  return { lane: layout.lanes[lj], index, position: index + 1, total: other.length + 1 };
}

/** What the live region says after a move. */
export const moveAnnouncement = (lane: string, position: number, total: number) => `Moved to ${lane || 'lane'}, position ${position} of ${total}`;

export interface LaneCount {
  text: string;
  /** `at`: exactly at the limit; `over`: past it (the warning look). */
  state: '' | 'at' | 'over';
  title: string;
  block: boolean;
}

/** A lane header's count: `n`, or `n / limit` with a WIP limit (display only in this slice; docs/kanban.md, WIP limits). */
export function laneCount(lane: { wip?: number; wipMode?: string }, n: number): LaneCount {
  const limit = Number.isInteger(lane.wip) && lane.wip! >= 1 && lane.wip! <= 99 ? lane.wip! : null;
  const block = limit !== null && lane.wipMode === 'block';
  if (limit === null) return { text: String(n), state: '', title: `${n} ${n === 1 ? 'card' : 'cards'}`, block: false };
  const state = n > limit ? 'over' : n === limit ? 'at' : '';
  const title = state === 'over' ? 'Over the limit' : block ? 'Limit, blocks drops' : 'Limit';
  return { text: `${n} / ${limit}`, state, title, block };
}

export interface DueChip {
  text: string;
  kind: 'normal' | 'soon' | 'overdue' | 'done';
}

const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Days since 1970 of a `YYYY-MM-DD` date, read as a calendar date with no time zone. Null for anything else. */
function dayNumber(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  return d.getUTCMonth() === Number(m[2]) - 1 ? Math.round(t / DAY) : null;
}

/** The viewer's local date as `YYYY-MM-DD`. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The due chip (docs/kanban.md, Due dates): "Today", "Tomorrow", "3 days ago" or "Fri 12 Oct". Overdue when the date is
 * before today and the lane is not done; today and tomorrow are "soon"; in a done lane it is plain, with a check.
 */
export function dueChip(due: string | undefined, today: string, done: boolean): DueChip | null {
  const d = due ? dayNumber(due) : null;
  const t = dayNumber(today);
  if (d === null || t === null) return null;
  const diff = d - t;
  const date = new Date(d * DAY);
  const long = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  if (done) return { text: long, kind: 'done' };
  if (diff === 0) return { text: 'Today', kind: 'soon' };
  if (diff === 1) return { text: 'Tomorrow', kind: 'soon' };
  if (diff < 0) return { text: diff === -1 ? 'Yesterday' : diff >= -6 ? `${-diff} days ago` : long, kind: 'overdue' };
  return { text: long, kind: 'normal' };
}

/** Initials for an owner badge: the first letters of the first and last word, upper case. */
export function initials(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : '';
  return (first + last).toUpperCase();
}
