// The kanban's list sheet without the DOM (docs/kanban.md, Phone and touch; slice 5): what each role may do in it, the
// lane tabs, the Move to… choices and the drop index of a row dragged by its handle. Tested on its own
// (test/container-sheet.test.ts); src/ui/container-sheet.ts draws it.

import { laneCount, type LaneCount } from './kanban-logic';

/** What the sheet offers (docs/kanban.md, Permissions): viewers read and filter, commenters also open cards read-only. */
export interface SheetRights {
  /** Move, add, turn into sticky: owners and editors. */
  edit: boolean;
  /** Open the card dialog: editors, and commenters read-only. */
  open: boolean;
}

export function sheetRights(readOnly: boolean, commentsReadOnly: boolean): SheetRights {
  return { edit: !readOnly, open: !readOnly || !commentsReadOnly };
}

export interface SheetLane {
  id: string;
  name?: string;
  wip?: number;
  wipMode?: string;
}

export interface SheetTab {
  id: string;
  name: string;
  count: LaneCount;
  /** What a screen reader hears: the name, the count and, over a limit, that it is over. */
  label: string;
}

/** A lane's name as the sheet shows it. */
export const laneName = (lane: { name?: string } | undefined) => lane?.name?.trim() || 'Lane';

/** The lane tabs, with counts as the lane headers show them (`n / limit`, over the limit marked). */
export function sheetTabs(lanes: readonly SheetLane[], count: (id: string) => number): SheetTab[] {
  return lanes.map((l) => {
    const n = count(l.id);
    const c = laneCount(l, n);
    const what = c.text.includes('/') ? `${n} of ${l.wip} cards` : `${n} ${n === 1 ? 'card' : 'cards'}`;
    return { id: l.id, name: laneName(l), count: c, label: `${laneName(l)}, ${what}${c.state === 'over' ? ', over the limit' : ''}` };
  });
}

/** The lane the sheet shows: the one asked for when it is still there, else the first. */
export function activeLane(lanes: readonly string[], wanted: string | null | undefined): string | null {
  return wanted && lanes.includes(wanted) ? wanted : lanes[0] ?? null;
}

export interface MoveChoice {
  id: string;
  name: string;
  /** "Current", "Full" or the lane's count. */
  end: string;
  current: boolean;
  /** A full block lane: it cannot be picked, and `reason` says why. */
  disabled: boolean;
  reason: string | null;
  over: boolean;
}

/**
 * The lanes Move to… offers (docs/kanban.md, Visual design, Phone): every lane, the card's own marked "Current", a lane
 * that refuses the card (a full block lane, through `refusal`) disabled with the reason.
 */
export function moveChoices(lanes: readonly SheetLane[], current: string, count: (id: string) => number, refusal: (id: string) => string | null): MoveChoice[] {
  return lanes.map((l) => {
    const n = count(l.id);
    const c = laneCount(l, n);
    const isCurrent = l.id === current;
    const reason = isCurrent ? null : refusal(l.id);
    return {
      id: l.id, name: laneName(l), current: isCurrent, disabled: !!reason, reason, over: c.state === 'over',
      end: isCurrent ? 'Current' : reason ? 'Full' : c.text,
    };
  });
}

/** Where Move to… puts a card in a lane: at the top, or after the lane's other cards. */
export function moveToIndex(laneCards: readonly string[], cardId: string, position: 'top' | 'bottom'): number {
  return position === 'top' ? 0 : laneCards.filter((id) => id !== cardId).length;
}

/**
 * The index among the other rows where a row dragged by its handle lands: before the first row whose middle is below
 * the pointer. `mids` are the middles of the rows that are not dragged, top to bottom.
 */
export function rowDropIndex(mids: readonly number[], y: number): number {
  const i = mids.findIndex((m) => y < m);
  return i < 0 ? mids.length : i;
}

/** "4 lanes · 9 cards" */
export function sheetSummary(lanes: number, cards: number): string {
  return `${lanes} ${lanes === 1 ? 'lane' : 'lanes'} · ${cards} ${cards === 1 ? 'card' : 'cards'}`;
}
