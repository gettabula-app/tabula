import { describe, expect, it } from 'vitest';
import { KANBAN, layoutContainer } from '../shared/containers';
import {
  ADD_ROW, addRow, cardHeight, dropIndexAt, dropLine, dueChip, emptyBox, initials, keyboardMove, laneCards, laneCount,
  laneRegionAt, laneTargetAt, localToday, lowDetail, moveAnnouncement,
} from '../src/ui/kanban-logic';

// docs/kanban.md, slice 2: the pure maths behind drawing, dropping and keyboard moves.

const kanban = () => {
  const container = { id: 'c', x: 100, y: 100, layout: 'kanban' };
  const lanes = [
    { id: 'l1', parent: 'c', rank: 'a0@c' },
    { id: 'l2', parent: 'c', rank: 'a1@c' },
    { id: 'l3', parent: 'c', rank: 'a2@c' },
  ];
  const cards = [
    { id: 'a', parent: 'l1', rank: 'a0@l1', h: 40 },
    { id: 'b', parent: 'l1', rank: 'a1@l1', h: 60 },
    { id: 'c1', parent: 'l1', rank: 'a2@l1', h: 40 },
    { id: 'd', parent: 'l2', rank: 'a0@l2', h: 40 },
  ];
  return layoutContainer(container, lanes, cards)!;
};

describe('low detail', () => {
  it('switches below zoom 0.4', () => {
    expect(lowDetail(0.39)).toBe(true);
    expect(lowDetail(0.4)).toBe(false);
    expect(lowDetail(1)).toBe(false);
  });
});

describe('card height', () => {
  it('is padding plus title lines, plus the label and meta rows when there are any', () => {
    expect(cardHeight({ lines: 1, labels: false, meta: false })).toBe(34);
    expect(cardHeight({ lines: 2, labels: false, meta: false })).toBe(52);
    expect(cardHeight({ lines: 1, labels: true, meta: true })).toBe(34 + 24 + 32);
  });

  it('counts at most three title lines and at least one', () => {
    expect(cardHeight({ lines: 9, labels: false, meta: false })).toBe(cardHeight({ lines: 3, labels: false, meta: false }));
    expect(cardHeight({ lines: 0, labels: false, meta: false })).toBe(34);
  });
});

describe('lane regions', () => {
  const L = kanban();
  const lane = L.rects.get('l1')!;
  const cards = laneCards(L, 'l1');

  it('puts the add-card row right after the last card, 40 high, inside the lane', () => {
    const row = addRow(lane, cards);
    const last = cards[cards.length - 1];
    expect(row).toEqual({ x: lane.x + 8, y: last.y + last.h + 8, w: 264, h: ADD_ROW });
    expect(row.y + row.h).toBeLessThanOrEqual(lane.y + lane.h);
  });

  it('puts it under the empty box in an empty lane, still inside the lane', () => {
    const empty = L.rects.get('l3')!;
    const box = emptyBox(empty);
    expect(box).toEqual({ x: empty.x + 8, y: empty.y + 48 + 8, w: 264, h: KANBAN.emptyLane });
    const row = addRow(empty, []);
    expect(row.y).toBe(box.y + box.h + 8);
    expect(row.y + row.h).toBeLessThanOrEqual(empty.y + empty.h);
  });

  it('tells the header, the add row and the body apart', () => {
    const row = addRow(lane, cards);
    expect(laneRegionAt(lane, cards, { x: lane.x + 20, y: lane.y + 10 })).toBe('header');
    expect(laneRegionAt(lane, cards, { x: row.x + 10, y: row.y + 10 })).toBe('add');
    expect(laneRegionAt(lane, cards, { x: lane.x + 20, y: cards[0].y + 5 })).toBe('body');
  });
});

describe('drop index and target', () => {
  const L = kanban();

  it('counts the cards whose midpoint is above the pointer', () => {
    const cards = laneCards(L, 'l1');
    expect(dropIndexAt(cards, cards[0].y - 5)).toBe(0);
    expect(dropIndexAt(cards, cards[0].y + cards[0].h / 2 + 1)).toBe(1);
    expect(dropIndexAt(cards, cards[2].y + cards[2].h)).toBe(3);
    expect(dropIndexAt([], 500)).toBe(0);
  });

  it('finds the lane under the point and the index among the cards that are not moving', () => {
    const b = L.rects.get('b')!;
    // below b's middle with b itself moving: only a is above
    const t = laneTargetAt([{ id: 'c', layout: L }], { x: b.x + 10, y: b.y + b.h - 2 }, new Set(['b']));
    expect(t).toEqual({ kind: 'lane', container: 'c', id: 'l1', index: 1 });
  });

  it('takes the nearest lane in a gap between lanes, and nothing outside the container', () => {
    const l1 = L.rects.get('l1')!;
    const gap = { x: l1.x + l1.w + 3, y: l1.y + 100 };
    expect(laneTargetAt([{ id: 'c', layout: L }], gap, new Set())?.id).toBe('l1');
    expect(laneTargetAt([{ id: 'c', layout: L }], { x: 0, y: 0 }, new Set())).toBeNull();
  });

  it('lets the topmost container win', () => {
    const other = layoutContainer({ id: 'k', x: 100, y: 100, layout: 'kanban' }, [{ id: 'm', parent: 'k', rank: 'a0@k' }], [])!;
    const p = { x: 130, y: 300 };
    expect(laneTargetAt([{ id: 'c', layout: L }, { id: 'k', layout: other }], p, new Set())?.id).toBe('m');
    expect(laneTargetAt([{ id: 'k', layout: other }, { id: 'c', layout: L }], p, new Set())?.id).toBe('l1');
  });

  it('draws the drop line in the gap above the target card, under the last, or at the top of an empty lane', () => {
    const lane = L.rects.get('l1')!;
    const cards = laneCards(L, 'l1');
    expect(dropLine(lane, cards, 1)).toEqual({ x: lane.x + 8, y: cards[1].y - 4 - 1, w: 264, h: 2 });
    expect(dropLine(lane, cards, 3).y).toBe(cards[2].y + cards[2].h + 4 - 1);
    const empty = L.rects.get('l3')!;
    expect(dropLine(empty, [], 0).y).toBe(empty.y + 48 + 8 - 4 - 1);
  });
});

describe('keyboard moves', () => {
  const L = kanban();

  it('moves up and down within the lane and stops at its ends', () => {
    expect(keyboardMove(L, 'b', 'up')).toEqual({ lane: 'l1', index: 0, position: 1, total: 3 });
    expect(keyboardMove(L, 'b', 'down')).toEqual({ lane: 'l1', index: 2, position: 3, total: 3 });
    expect(keyboardMove(L, 'a', 'up')).toBeNull();
    expect(keyboardMove(L, 'c1', 'down')).toBeNull();
  });

  it('moves to the neighbouring lane at the same index when it can, else at the end', () => {
    expect(keyboardMove(L, 'a', 'right')).toEqual({ lane: 'l2', index: 0, position: 1, total: 2 });
    expect(keyboardMove(L, 'c1', 'right')).toEqual({ lane: 'l2', index: 1, position: 2, total: 2 });
    expect(keyboardMove(L, 'd', 'right')).toEqual({ lane: 'l3', index: 0, position: 1, total: 1 });
    expect(keyboardMove(L, 'a', 'left')).toBeNull();
    expect(keyboardMove(L, 'nope', 'left')).toBeNull();
  });

  it('says where the card went', () => {
    expect(moveAnnouncement('Doing', 2, 5)).toBe('Moved to Doing, position 2 of 5');
  });
});

describe('lane counts', () => {
  it('shows the count, or count over limit with the at and over states', () => {
    expect(laneCount({}, 4)).toMatchObject({ text: '4', state: '' });
    expect(laneCount({ wip: 3 }, 2)).toMatchObject({ text: '2 / 3', state: '', block: false });
    expect(laneCount({ wip: 3 }, 3)).toMatchObject({ text: '3 / 3', state: 'at' });
    expect(laneCount({ wip: 3 }, 4)).toMatchObject({ text: '4 / 3', state: 'over', title: 'Over the limit' });
    expect(laneCount({ wip: 2, wipMode: 'block' }, 1)).toMatchObject({ block: true });
  });

  it('ignores a limit out of range', () => {
    expect(laneCount({ wip: 0 }, 4).text).toBe('4');
    expect(laneCount({ wip: 100 }, 4).text).toBe('4');
  });
});

describe('due chips', () => {
  const today = '2026-10-09';

  it('says today, tomorrow, days ago and a date', () => {
    expect(dueChip('2026-10-09', today, false)).toEqual({ text: 'Today', kind: 'soon' });
    expect(dueChip('2026-10-10', today, false)).toEqual({ text: 'Tomorrow', kind: 'soon' });
    expect(dueChip('2026-10-06', today, false)).toEqual({ text: '3 days ago', kind: 'overdue' });
    expect(dueChip('2026-10-08', today, false)).toEqual({ text: 'Yesterday', kind: 'overdue' });
    expect(dueChip('2026-10-12', today, false)).toEqual({ text: 'Mon 12 Oct', kind: 'normal' });
    expect(dueChip('2026-09-01', today, false)).toEqual({ text: 'Tue 1 Sep', kind: 'overdue' });
  });

  it('is never overdue in a done lane', () => {
    expect(dueChip('2026-10-07', today, true)).toEqual({ text: 'Wed 7 Oct', kind: 'done' });
  });

  it('ignores what is not a date', () => {
    expect(dueChip(undefined, today, false)).toBeNull();
    expect(dueChip('2026-02-30', today, false)).toBeNull();
    expect(dueChip('tomorrow', today, false)).toBeNull();
  });

  it('reads the viewer local date', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Johan Saldes')).toBe('JS');
    expect(initials('ana maria novak')).toBe('AN');
    expect(initials('Lea')).toBe('L');
    expect(initials('  ')).toBe('?');
  });
});
