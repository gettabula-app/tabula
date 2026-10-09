// Pure kanban maths for the canvas (docs/kanban.md, slice 2): where a dragged card would land, where the keyboard moves
// one, what a lane's count says, what a due chip says, how tall a card is, and when the board draws in low detail.
// No DOM and no store: the callers pass rectangles from the shared layout (shared/containers.mjs).

import { KANBAN, kanbanColor, type ContainerLayout, type Rect } from '../../shared/containers';

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

/** A lane header's ⋯ button (28 square, 8 from the lane's right edge, centred in the header band). Editors only. */
export function laneMenuRect(lane: Rect): Rect {
  return { x: lane.x + lane.w - 8 - 28, y: lane.y + 12, w: 28, h: 28 };
}

/**
 * Where in a lane a point is: its ⋯ button (when `menu`, for editors), its header band, its add-card row, or the rest of
 * the body.
 */
export function laneRegionAt(lane: Rect, cards: Rect[], p: { x: number; y: number }, menu = false): 'menu' | 'header' | 'add' | 'body' {
  if (menu && inside(laneMenuRect(lane), p)) return 'menu';
  if (p.y < lane.y + KANBAN.header) return 'header';
  return inside(addRow(lane, cards), p) ? 'add' : 'body';
}

/** Whether a point is inside a rectangle, edges included. */
export const inRect = inside;

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

// ---------------------------------------------------------------- cards (docs/kanban.md, slice 3)

/** Whether a value is a calendar date as `due` stores it, `YYYY-MM-DD` and a real day. */
export const isDueDate = (v: unknown): v is string => typeof v === 'string' && dayNumber(v) !== null;

/**
 * A sticky's text as a card's title and description (docs/kanban.md, Sticky to card and back): the first line is the
 * title, the rest the description with the blank lines before it dropped. A first line longer than the title limit
 * keeps its first 200 characters as the title and starts the description with the rest, so no text is lost.
 */
export function splitStickyText(text: string | undefined, titleMax = 200): { title: string; desc: string | undefined } {
  const all = (text ?? '').replace(/\r\n?/g, '\n');
  const nl = all.indexOf('\n');
  let first = (nl < 0 ? all : all.slice(0, nl)).trim();
  let rest = nl < 0 ? '' : all.slice(nl + 1).replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (first.length > titleMax) {
    const cut = first.slice(0, titleMax).trimEnd();
    rest = rest ? `${first.slice(cut.length).trim()}\n\n${rest}` : first.slice(cut.length).trim();
    first = cut;
  }
  return { title: first, desc: rest ? rest : undefined };
}

/** A card's title and description as a sticky's text: the description under the title after a blank line. */
export function joinCardText(title: string | undefined, desc: string | undefined): string {
  const t = (title ?? '').trim();
  const d = (desc ?? '').replace(/\s+$/, '');
  return d ? (t ? `${t}\n\n${d}` : d) : t;
}

const rgbOf = (hex: string): [number, number, number] | null => {
  const m = /^#([\da-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/**
 * The colour a card takes from a sticky: the palette key when the sticky has one of the sticky swatches (so the accent
 * follows the theme like a label), else the colour itself through `kanbanColor`; none when it is not a usable colour.
 */
export function cardFillFromSticky(fill: string | undefined, swatches: readonly { name: string; fill: string }[]): string | undefined {
  if (typeof fill !== 'string') return undefined;
  const s = swatches.find((x) => x.fill.toLowerCase() === fill.trim().toLowerCase());
  if (s) return s.name.toLowerCase();
  return kanbanColor(fill) ?? undefined;
}

/**
 * The colour a sticky takes from a card (docs/kanban.md): a palette key gives its sticky swatch; a sticky swatch or one
 * of the board's own sticky colours is kept; any other colour gives the nearest sticky swatch; no colour gives `fallback`.
 */
export function stickyFillFromCard(fill: string | undefined, swatches: readonly { name: string; fill: string }[], custom: readonly string[], fallback: string): string {
  const c = kanbanColor(fill);
  if (!c) return fallback;
  const byKey = swatches.find((x) => x.name.toLowerCase() === c);
  if (byKey) return byKey.fill;
  const own = [...swatches.map((x) => x.fill), ...custom].find((x) => x.toLowerCase() === c.toLowerCase());
  if (own) return own;
  const rgb = rgbOf(c);
  if (!rgb) return fallback;
  let best = fallback;
  let bestD = Infinity;
  for (const s of swatches) {
    const q = rgbOf(s.fill);
    if (!q) continue;
    const d = (q[0] - rgb[0]) ** 2 + (q[1] - rgb[1]) ** 2 + (q[2] - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s.fill;
    }
  }
  return best;
}

/**
 * Stickies in reading order, for making a kanban from them (docs/kanban.md, Making one): rows top to bottom, each row
 * left to right. A box starts a new row when its middle is below the current row's first middle by more than half the
 * typical height, so stickies roughly in a line count as one row.
 */
export function readingOrder<T extends { id: string; x: number; y: number; w: number; h: number }>(items: readonly T[]): T[] {
  if (items.length < 2) return [...items];
  const hs = items.map((o) => o.h).sort((a, b) => a - b);
  const tol = hs[Math.floor(hs.length / 2)] / 2;
  const byY = [...items].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x || (a.id < b.id ? -1 : 1));
  const rows: T[][] = [];
  let rowY = -Infinity;
  for (const o of byY) {
    const cy = o.y + o.h / 2;
    if (!rows.length || cy - rowY > tol) {
      rows.push([o]);
      rowY = cy;
    } else rows[rows.length - 1].push(o);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1)));
}

export interface OwnerOption {
  /** `id:<user id>` for a person, `name:<name>` for a name with no account. */
  key: string;
  id?: string;
  name: string;
  me?: boolean;
}

/**
 * Who the owner picker offers (docs/kanban.md, Owners): the viewer, the people in the room now and everyone already
 * named as an owner on this board, each once; nothing from a directory. People by id, names without an id by name
 * (ignoring case, and left out when a person of that name is listed). The viewer first, then by name.
 */
export function ownerOptions(
  me: { id: string; name: string } | null,
  present: readonly { id: string; name: string }[],
  assigned: readonly { ownerId?: string; ownerName?: string }[],
): OwnerOption[] {
  const people = new Map<string, OwnerOption>();
  const add = (id: string, name: string, isMe = false) => {
    if (!id || people.has(id)) return;
    people.set(id, { key: `id:${id}`, id, name: name.trim() || 'Someone', me: isMe || undefined });
  };
  if (me) add(me.id, me.name, true);
  for (const p of present) add(p.id, p.name);
  for (const a of assigned) if (a.ownerId) add(a.ownerId, a.ownerName ?? '');
  const names = new Map<string, OwnerOption>();
  const taken = new Set([...people.values()].map((p) => p.name.toLowerCase()));
  for (const a of assigned) {
    const n = (a.ownerName ?? '').trim();
    if (a.ownerId || !n || taken.has(n.toLowerCase()) || names.has(n.toLowerCase())) continue;
    names.set(n.toLowerCase(), { key: `name:${n}`, name: n });
  }
  const all = [...people.values(), ...names.values()];
  return all.sort((a, b) => (a.me ? -1 : b.me ? 1 : a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1)));
}

/** The picker key of a card's current owner, or '' for none. */
export function ownerKey(card: { ownerId?: string; ownerName?: string }): string {
  if (card.ownerId) return `id:${card.ownerId}`;
  const n = (card.ownerName ?? '').trim();
  return n ? `name:${n}` : '';
}

// ---------------------------------------------------------------- lanes and discipline (docs/kanban.md, slice 4)

export type Stage = 'todo' | 'doing' | 'done';

/** The lane stages, in menu order (docs/kanban.md, Lanes). Only `done` changes how cards draw. */
export const STAGES: readonly { key: Stage; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' },
];

export const isStage = (v: unknown): v is Stage => v === 'todo' || v === 'doing' || v === 'done';

/** Whether a lane's change of stage changes how its cards draw: their due chips read differently in a done lane. */
export const stageRedrawsCards = (before: unknown, after: unknown) => (before === 'done') !== (after === 'done');

/**
 * Where Move left or Move right puts a lane: the index among the other lanes (left to right) to insert it at, or null at
 * an edge, where there is nothing to do.
 */
export function laneMoveIndex(lanes: readonly string[], laneId: string, dir: 'left' | 'right'): number | null {
  const i = lanes.indexOf(laneId);
  if (i < 0) return null;
  const to = dir === 'left' ? i - 1 : i + 1;
  return to < 0 || to >= lanes.length ? null : to;
}

/** A WIP limit as typed: a whole number from 1 to 99, '' for no limit, or null when it is neither. */
export function parseWip(text: string): number | '' | null {
  const t = text.trim();
  if (!t) return '';
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 99 ? n : null;
}

/** The toast when a block lane refuses a drop (docs/kanban.md, Visual design: "Review is full: 2 of 2"). */
export const wipFullMessage = (lane: string | undefined, count: number, limit: number) => `${lane?.trim() || 'This lane'} is full: ${count} of ${limit}`;

/** The label on a block lane that refuses the cards dragged over it ("Full · 2 / 2"). */
export const wipFullLabel = (count: number, limit: number) => `Full · ${count} / ${limit}`;

// ---------------------------------------------------------------- filters (docs/kanban.md, Filters)

export type DueBucket = 'overdue' | 'today' | 'week' | 'none';

export const DUE_BUCKETS: readonly { key: DueBucket; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'none', label: 'None' },
];

/**
 * One person's filter on one kanban: personal, never written to the board (docs/kanban.md, Filters). Each part that is
 * set must match; within labels and within due, any one is enough.
 */
export interface KanbanFilter {
  mine: boolean;
  /** Label ids, any of. */
  labels: string[];
  /** Due buckets, any of. */
  due: DueBucket[];
  /** Words in the title or the description, ignoring case. */
  text: string;
}

export const EMPTY_FILTER: KanbanFilter = Object.freeze({ mine: false, labels: [], due: [], text: '' }) as KanbanFilter;

const TEXT_MAX = 200;

/** A filter read back from storage (or anything else): only what a filter can hold, else the empty filter. */
export function cleanFilter(v: unknown): KanbanFilter {
  if (!v || typeof v !== 'object') return { ...EMPTY_FILTER, labels: [], due: [] };
  const o = v as Record<string, unknown>;
  const labels = Array.isArray(o.labels) ? [...new Set(o.labels.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 30) : [];
  const keys = DUE_BUCKETS.map((b) => b.key) as string[];
  const due = Array.isArray(o.due) ? [...new Set(o.due.filter((x): x is DueBucket => typeof x === 'string' && keys.includes(x)))] : [];
  const text = typeof o.text === 'string' ? o.text.slice(0, TEXT_MAX) : '';
  return { mine: o.mine === true, labels, due, text };
}

/** How many parts of a filter are on: Mine, each label, each due bucket, and the text. Zero means no filter. */
export const filterParts = (f: KanbanFilter) => (f.mine ? 1 : 0) + f.labels.length + f.due.length + (f.text.trim() ? 1 : 0);

export interface FilterViewer {
  id: string;
  name: string;
  /** Accounts mode: Mine means the owner's account id; in open mode the owner's name counts too. */
  accounts: boolean;
}

/** The ISO week (Monday to Sunday) of a day number, as the Monday's day number. */
const mondayOf = (day: number) => day - ((new Date(day * DAY).getUTCDay() + 6) % 7);

/** Which due buckets a card is in: overdue as its chip says (never in a done lane), today, this week (Monday to Sunday), none. */
export function dueBuckets(due: string | undefined, today: string, done: boolean): Set<DueBucket> {
  const out = new Set<DueBucket>();
  const d = due ? dayNumber(due) : null;
  const t = dayNumber(today);
  if (d === null) {
    out.add('none');
    return out;
  }
  if (t === null) return out;
  if (d < t && !done) out.add('overdue');
  if (d === t) out.add('today');
  if (mondayOf(d) === mondayOf(t)) out.add('week');
  return out;
}

export interface FilterCard {
  text?: string;
  desc?: string;
  ownerId?: string;
  ownerName?: string;
  due?: string;
  labels?: string[];
}

/**
 * Whether a card matches a filter. `known` is the board's label ids: a filter label that was deleted since matches
 * nothing and counts as not set. The empty filter matches every card.
 */
export function cardMatches(card: FilterCard, f: KanbanFilter, ctx: { viewer: FilterViewer; today: string; done: boolean; known?: ReadonlySet<string> }): boolean {
  if (f.mine) {
    const { viewer } = ctx;
    const byId = !!card.ownerId && card.ownerId === viewer.id;
    const byName = !viewer.accounts && !!viewer.name.trim() && (card.ownerName ?? '').trim().toLowerCase() === viewer.name.trim().toLowerCase();
    if (!byId && !byName) return false;
  }
  const labels = ctx.known ? f.labels.filter((id) => ctx.known!.has(id)) : f.labels;
  if (labels.length && !(card.labels ?? []).some((id) => labels.includes(id))) return false;
  if (f.due.length) {
    const b = dueBuckets(card.due, ctx.today, ctx.done);
    if (!f.due.some((k) => b.has(k))) return false;
  }
  const q = f.text.trim().toLowerCase();
  if (q && !`${card.text ?? ''}\n${card.desc ?? ''}`.toLowerCase().includes(q)) return false;
  return true;
}

export interface FilterChip {
  /** `mine`, `label:<id>`, `due:<bucket>` or `text`. */
  key: string;
  text: string;
}

/** The chips that show an active filter on the kanban's header, in popover order. Deleted labels have none. */
export function filterChips(f: KanbanFilter, labelName: (id: string) => string | undefined): FilterChip[] {
  const out: FilterChip[] = [];
  if (f.mine) out.push({ key: 'mine', text: 'Mine' });
  for (const id of f.labels) {
    const name = labelName(id);
    if (name) out.push({ key: `label:${id}`, text: name });
  }
  for (const b of DUE_BUCKETS) if (f.due.includes(b.key)) out.push({ key: `due:${b.key}`, text: b.key === 'none' ? 'No due date' : b.label });
  const t = f.text.trim();
  if (t) out.push({ key: 'text', text: `“${t.length > 24 ? `${t.slice(0, 23)}…` : t}”` });
  return out;
}

/** The filter without the part a chip shows. */
export function withoutChip(f: KanbanFilter, key: string): KanbanFilter {
  if (key === 'mine') return { ...f, mine: false };
  if (key === 'text') return { ...f, text: '' };
  if (key.startsWith('label:')) return { ...f, labels: f.labels.filter((id) => id !== key.slice(6)) };
  if (key.startsWith('due:')) return { ...f, due: f.due.filter((b) => b !== key.slice(4)) };
  return f;
}

/** "2 of 9 match", or "No filter" when nothing is set. */
export const matchText = (f: KanbanFilter, matching: number, total: number) => (filterParts(f) ? `${matching} of ${total} match` : 'No filter');

/** Where a kanban's filter is kept in this browser (docs/kanban.md, Filters): per board and per kanban, never in the board. */
export const filterStorageKey = (board: string, container: string) => `tabula:filter:${board}:${container}`;
