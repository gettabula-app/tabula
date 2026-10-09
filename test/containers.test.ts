import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STICKY_COLORS } from '../src/palette';
import {
  KANBAN, LABEL_COLORS, LIMITS, hasLayout, isMixedRank, layoutAll, layoutContainer, needsNormalising, normaliseRanks, orphanHome, planInsert,
  rankBetween, ranksBetween, sortedChildren, splitRank, unknownFeatures, wipCheck,
  featureKey, featuresOf, isFeatureKey,
} from '../shared/containers';

// docs/kanban.md: the shared module the browser and the MCP server both run. No Store, no DOM.

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: T[], seed: number): T[] {
  const next = rng(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type Obj = Record<string, unknown> & { id: string; type: string; parent?: string; rank?: string };
const container = (extra: Record<string, unknown> = {}) => ({ id: 'c', type: 'container', layout: 'kanban', x: 100, y: 50, z: 'a0', ...extra });
const lane = (id: string, key: string, extra: Record<string, unknown> = {}): Obj => ({ id, type: 'lane', parent: 'c', rank: `${key}@c`, ...extra });
const card = (id: string, laneId: string, key: string, extra: Record<string, unknown> = {}): Obj => ({ id, type: 'card', parent: laneId, rank: `${key}@${laneId}`, h: 72, ...extra });
const keyOf = (rank: string) => splitRank(rank)!.key;
const ids = (list: { id: string }[]) => list.map((o) => o.id);

describe('ranks', () => {
  it('writes the parent into the rank and orders by key', () => {
    expect(rankBetween(null, null, 'L')).toBe('a0@L');
    const b = rankBetween('a0@L', null, 'L');
    const m = rankBetween('a0@L', b, 'L');
    expect(b.endsWith('@L') && m.endsWith('@L')).toBe(true);
    expect(keyOf('a0@L') < keyOf(m) && keyOf(m) < keyOf(b)).toBe(true);
  });

  it('takes neighbours as stored ranks, bare keys or nothing', () => {
    expect(keyOf(rankBetween('a0', 'a2@X', 'L')) > 'a0').toBe(true);
    expect(keyOf(rankBetween(undefined, 'a0@X', 'L')) < 'a0').toBe(true);
    expect(rankBetween('not a key', null, 'L')).toBe('a0@L');
  });

  it('reads a rank back only when it is one', () => {
    expect(splitRank('a0@L1')).toEqual({ key: 'a0', parent: 'L1' });
    for (const bad of [undefined, null, 5, '', 'a0', '@L', 'a0@', 'zz@L', 'a0 @L']) expect(splitRank(bad)).toBeNull();
  });

  it('gives n ascending ranks for a batch, all for the same parent', () => {
    const batch = ranksBetween('a0@L', 'a1@L', 5, 'M');
    expect(batch).toHaveLength(5);
    const keys = batch.map(keyOf);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(5);
    expect(keys[0] > 'a0' && keys[4] < 'a1').toBe(true);
    expect(batch.every((r) => r.endsWith('@M'))).toBe(true);
    expect(ranksBetween(null, null, 0, 'L')).toEqual([]);
  });

  it('stays strictly ordered through a thousand random inserts', () => {
    const next = rng(7);
    let list: string[] = [];
    for (let n = 0; n < 1000; n++) {
      const at = Math.floor(next() * (list.length + 1));
      list = [...list.slice(0, at), rankBetween(list[at - 1] ?? null, list[at] ?? null, 'L'), ...list.slice(at)];
    }
    const keys = list.map(keyOf);
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
  });

  it('flags a rank that does not name the parent', () => {
    expect(isMixedRank({ id: 'x', parent: 'L', rank: 'a0@L' })).toBe(false);
    expect(isMixedRank({ id: 'x', parent: 'L', rank: 'a0@M' })).toBe(true);
    expect(isMixedRank({ id: 'x', parent: 'L' })).toBe(true);
    expect(isMixedRank({ id: 'x', rank: 'a0@L' })).toBe(true);
    expect(isMixedRank({ id: 'x', parent: 'L', rank: 'junk' })).toBe(true);
  });

  describe('sortedChildren', () => {
    it('sorts by key, ties by id', () => {
      const list = [card('c', 'L', 'a1'), card('b', 'L', 'a0'), card('a', 'L', 'a0')];
      expect(ids(sortedChildren(list))).toEqual(['a', 'b', 'c']);
    });

    it('puts mixed ranks last, by updatedAt then id', () => {
      const list = [
        card('wrong', 'L', 'a0', { rank: 'a0@other', updatedAt: 5 }),
        card('plain', 'L', 'a5'),
        card('none', 'L', 'a0', { rank: undefined, updatedAt: 2 }),
        card('junk', 'L', 'a0', { rank: 'junk', updatedAt: 2 }),
        card('first', 'L', 'a1'),
      ];
      expect(ids(sortedChildren(list))).toEqual(['first', 'plain', 'junk', 'none', 'wrong']);
    });

    it('does not change its input', () => {
      const list = [card('b', 'L', 'a1'), card('a', 'L', 'a0')];
      sortedChildren(list);
      expect(ids(list)).toEqual(['b', 'a']);
    });
  });

  describe('normaliseRanks', () => {
    it('gives fresh spaced keys in the current order', () => {
      const list = [card('c', 'L', 'a0'), card('a', 'L', 'a0'), card('b', 'L', 'a0V')];
      const patches = normaliseRanks(list, 'L');
      expect(patches.map((p) => p.id)).toEqual(ids(sortedChildren(list)));
      const keys = patches.map((p) => keyOf(p.rank));
      for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
      expect(patches.every((p) => p.parent === 'L' && p.rank.endsWith('@L'))).toBe(true);
      expect(needsNormalising(patches.map((p) => ({ ...p })))).toBe(false);
    });

    it('repairs a mixed rank and keeps it last', () => {
      const list = [card('x', 'L', 'a0', { rank: 'a0@gone', updatedAt: 1 }), card('y', 'L', 'a1')];
      const patches = normaliseRanks(list, 'L');
      expect(patches.map((p) => p.id)).toEqual(['y', 'x']);
      expect(patches.every((p) => !isMixedRank(p))).toBe(true);
    });

    it('handles nothing', () => {
      expect(normaliseRanks([], 'L')).toEqual([]);
    });
  });

  describe('needsNormalising', () => {
    it('is false for distinct keys with the right suffix', () => {
      expect(needsNormalising([card('a', 'L', 'a0'), card('b', 'L', 'a1')])).toBe(false);
      expect(needsNormalising([])).toBe(false);
    });

    it('is true for two equal keys, even when sorted apart by other keys', () => {
      expect(needsNormalising([card('a', 'L', 'a0'), card('z', 'L', 'a1'), card('b', 'L', 'a0')])).toBe(true);
    });

    it('is true for a mixed rank', () => {
      expect(needsNormalising([card('a', 'L', 'a0'), card('b', 'L', 'a1', { rank: 'a1@M' })])).toBe(true);
    });
  });

  describe('planInsert', () => {
    const lane1 = [card('a', 'L', 'a0'), card('b', 'L', 'a1'), card('c', 'L', 'a2')];

    it('puts a card between its neighbours', () => {
      const { ranks, repairs } = planInsert(lane1, 'L', 1, 1);
      expect(repairs).toEqual([]);
      const placed = [...lane1, { id: 'n', parent: 'L', rank: ranks[0] }];
      expect(ids(sortedChildren(placed))).toEqual(['a', 'n', 'b', 'c']);
    });

    it('puts several in order at the start, the end and the middle', () => {
      for (const [index, expected] of [[0, ['n1', 'n2', 'a', 'b', 'c']], [3, ['a', 'b', 'c', 'n1', 'n2']], [2, ['a', 'b', 'n1', 'n2', 'c']]] as const) {
        const { ranks } = planInsert(lane1, 'L', index, 2);
        const placed = [...lane1, { id: 'n1', parent: 'L', rank: ranks[0] }, { id: 'n2', parent: 'L', rank: ranks[1] }];
        expect(ids(sortedChildren(placed))).toEqual([...expected]);
      }
    });

    it('clamps the index and handles an empty lane', () => {
      expect(planInsert(lane1, 'L', 99, 1).ranks[0] > lane1[2].rank!).toBe(true);
      expect(planInsert(lane1, 'L', -4, 1).ranks[0] < lane1[0].rank!).toBe(true);
      expect(planInsert(lane1, 'L', Number.NaN, 1).ranks[0] < lane1[0].rank!).toBe(true);
      expect(planInsert([], 'L', 0, 1)).toEqual({ ranks: ['a0@L'], repairs: [] });
    });

    it('normalises first when two neighbours have the same key', () => {
      const tied = [card('a', 'L', 'a0'), card('b', 'L', 'a0'), card('c', 'L', 'a1')];
      const { ranks, repairs } = planInsert(tied, 'L', 1, 1);
      expect(repairs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
      const patched = new Map(repairs.map((r) => [r.id, r.rank]));
      const placed = [
        ...tied.map((c) => ({ ...c, rank: patched.get(c.id) })),
        { id: 'n', parent: 'L', rank: ranks[0] },
      ];
      expect(needsNormalising(placed)).toBe(false);
      expect(ids(sortedChildren(placed))).toEqual(['a', 'n', 'b', 'c']);
    });

    it('adopts a mixed card into the lane it is written to', () => {
      const mixed = [card('a', 'L', 'a0'), card('m', 'L', 'a1', { rank: 'a1@elsewhere' })];
      const { repairs } = planInsert(mixed, 'L', 0, 1);
      expect(repairs.find((r) => r.id === 'm')).toMatchObject({ parent: 'L' });
      expect(repairs.every((r) => r.rank.endsWith('@L'))).toBe(true);
    });
  });
});

describe('layoutContainer', () => {
  it('uses the spec\'s and the visual design\'s constants', () => {
    expect(KANBAN).toEqual({
      laneW: 280, laneGap: 16, pad: 12, header: 48, cardGap: 8, minBody: 160,
      containerHeader: 48, lanePad: 8, dropZone: 56, addLaneGap: 8, addLaneW: 32, emptyLane: 56, cardH: 72,
    });
  });

  // The container sits at (100, 50): its header takes 48 and the padding 12, so the lanes start at y = 110.
  it('puts lanes left to right by rank, below the container header', () => {
    const L = layoutContainer(container(), [lane('b', 'a1'), lane('a', 'a0'), lane('c', 'a2')], [])!;
    expect(L.layout).toBe('kanban');
    expect(L.lanes).toEqual(['a', 'b', 'c']);
    expect(['a', 'b', 'c'].map((id) => L.rects.get(id)!.x)).toEqual([112, 408, 704]);
    for (const id of ['a', 'b', 'c']) expect(L.rects.get(id)).toMatchObject({ y: 110, w: 280 });
  });

  it('sizes the container to its header, lanes and add-lane column, with every lane as tall as the tallest', () => {
    const L = layoutContainer(container(), [lane('a', 'a0'), lane('b', 'a1'), lane('c', 'a2')], [])!;
    // wide: 12 + 3 * 280 + 2 * 16 + 8 + 32 + 12. tall: 48 + 12 + (48 + 160) + 12
    expect(L.rects.get('c')).toEqual({ x: 704, y: 110, w: 280, h: 208 });
    expect(L.rects.get('a')!.h).toBe(208);
    expect(L.rects.get('c')).not.toBe(L.rects.get('a'));
    expect({ w: L.w, h: L.h }).toEqual({ w: 936, h: 280 });
    expect(L.rects.get('c')!.y + 208 + 12).toBe(50 + L.h);
    expect(L.addLane).toEqual({ x: 992, y: 118, w: 32, h: 32 });
    expect(L.addLane.x + 32 + 12).toBe(100 + L.w);
    expect(L.addLane.x).toBe(L.rects.get('c')!.x + 280 + 8);
  });

  it('clamps the lane width to 200..480 and falls back to 280', () => {
    const widthOf = (laneW: unknown) => layoutContainer(container({ laneW }), [lane('a', 'a0')], [])!.rects.get('a')!.w;
    expect(widthOf(100)).toBe(200);
    expect(widthOf(999)).toBe(480);
    expect(widthOf(320)).toBe(320);
    expect(widthOf(Number.NaN)).toBe(280);
    expect(widthOf(undefined)).toBe(280);
    expect(widthOf('wide')).toBe(280);
  });

  it('stacks cards by rank at the stored heights, 8 inside the lane on each side', () => {
    const cards = [card('k2', 'a', 'a1', { h: 100 }), card('k1', 'a', 'a0', { h: 60 }), card('k3', 'a', 'a2', { h: 0 })];
    const L = layoutContainer(container(), [lane('a', 'a0')], cards)!;
    expect(L.cards.get('a')).toEqual(['k1', 'k2', 'k3']);
    // the lane starts at y = 110 and its header takes 48, then 8 of padding
    expect(L.rects.get('k1')).toEqual({ x: 120, y: 166, w: 264, h: 60 });
    expect(L.rects.get('k2')).toEqual({ x: 120, y: 234, w: 264, h: 100 });
    expect(L.rects.get('k3')).toEqual({ x: 120, y: 342, w: 264, h: 72 });
  });

  it('grows every lane to the tallest plus a drop zone of 56', () => {
    const tall = Array.from({ length: 6 }, (_, i) => card(`t${i}`, 'a', `a${i}`, { h: 80 }));
    const L = layoutContainer(container(), [lane('a', 'a0'), lane('b', 'a1')], [...tall, card('s', 'b', 'a0')])!;
    const last = L.rects.get('t5')!;
    // 8 padding, six cards and six gaps of 8, the drop zone, 8 padding
    expect(L.rects.get('a')!.h).toBe(48 + 8 + 6 * (80 + 8) + 56 + 8);
    expect(L.rects.get('b')!.h).toBe(L.rects.get('a')!.h);
    expect(last.y + last.h + 8 + 56 + 8).toBe(L.rects.get('a')!.y + L.rects.get('a')!.h);
    expect(L.h).toBe(48 + 12 + L.rects.get('a')!.h + 12);
    expect(L.rects.get('a')!.h).toBeGreaterThan(48 + 160);
  });

  it('keeps an empty lane at the minimum body, and an empty container at one lane wide', () => {
    const L = layoutContainer(container(), [lane('a', 'a0')], [])!;
    expect(L.rects.get('a')!.h).toBe(48 + 160);
    expect(L.cards.get('a')).toEqual([]);
    const none = layoutContainer(container(), [], [])!;
    expect(none.w).toBe(12 + 280 + 8 + 32 + 12);
    expect(none.lanes).toEqual([]);
    expect([...none.rects.keys()]).toEqual(['c']);
    expect(none.addLane).toEqual({ x: 100 + 12 + 280 + 8, y: 118, w: 32, h: 32 });
  });

  it('puts a card whose lane is gone at the end of the first lane, by rank and id', () => {
    const cards = [card('own', 'a', 'a5'), card('o2', 'gone', 'a1'), card('o1', 'gone', 'a1'), card('mine', 'b', 'a0')];
    const L = layoutContainer(container(), [lane('b', 'a1'), lane('a', 'a0')], cards)!;
    expect(L.cards.get('a')).toEqual(['own', 'o1', 'o2']);
    expect(L.cards.get('b')).toEqual(['mine']);
  });

  it('puts a card with a bad rank suffix last in its lane', () => {
    const cards = [card('late', 'a', 'a0', { rank: 'a0@other', updatedAt: 1 }), card('x', 'a', 'a1'), card('y', 'a', 'a2')];
    expect(layoutContainer(container(), [lane('a', 'a0')], cards)!.cards.get('a')).toEqual(['x', 'y', 'late']);
  });

  it('lists the paint order: lanes first, then each lane\'s cards', () => {
    const L = layoutContainer(container(), [lane('a', 'a0'), lane('b', 'a1')], [card('b1', 'b', 'a0'), card('a1', 'a', 'a0'), card('a2', 'a', 'a1')])!;
    expect(L.order).toEqual(['a', 'b', 'a1', 'a2', 'b1']);
  });

  it('gives the same answer whatever order its input comes in', () => {
    const lanes = [lane('a', 'a0'), lane('b', 'a1'), lane('c', 'a1')];
    const cards = [
      card('k1', 'a', 'a0'), card('k2', 'a', 'a0'), card('k3', 'b', 'a2', { h: 90 }), card('k4', 'c', 'a0'),
      card('k5', 'gone', 'a3'), card('k6', 'b', 'a0', { rank: 'a0@x', updatedAt: 3 }), card('k7', 'b', 'a1'),
    ];
    const reference = JSON.stringify(layoutContainer(container(), lanes, cards), (_k, v) => (v instanceof Map ? [...v] : v));
    for (let seed = 1; seed <= 20; seed++) {
      const L = layoutContainer(container(), shuffled(lanes, seed), shuffled(cards, seed + 100));
      expect(JSON.stringify(L, (_k, v) => (v instanceof Map ? [...v] : v))).toBe(reference);
    }
  });

  it('is not laid out for a layout it does not know', () => {
    expect(layoutContainer(container({ layout: 'timeline' }), [lane('a', 'a0')], [])).toBeNull();
    expect(layoutContainer(container({ layout: undefined }), [], [])).toBeNull();
    expect(layoutContainer(container({ layout: 'constructor' }), [], [])).toBeNull();
    expect(hasLayout('kanban') && !hasLayout('toString') && !hasLayout(undefined)).toBe(true);
  });

  it('puts the container where it is stored and ignores stored sizes', () => {
    const L = layoutContainer(container({ x: -40, y: 7.5, w: 1, h: 1 }), [lane('a', 'a0')], [])!;
    expect(L.rects.get('c')).toMatchObject({ x: -40, y: 7.5, w: L.w, h: L.h });
    const moved = layoutContainer(container({ x: 0, y: 0 }), [lane('a', 'a0')], [card('k', 'a', 'a0')])!;
    expect(moved.rects.get('k')).toEqual({ x: 12 + 8, y: 48 + 12 + 48 + 8, w: 264, h: 72 });
  });
});

describe('orphanHome and layoutAll', () => {
  it('is the container lowest in paint order that has a layout we know', () => {
    expect(orphanHome([])).toBeNull();
    expect(orphanHome([container({ id: 'b', z: 'a1' }), container({ id: 'a', z: 'a2' })])).toBe('b');
    expect(orphanHome([container({ id: 'b', z: 'a1' }), container({ id: 'a', z: 'a1' })])).toBe('a');
    expect(orphanHome([container({ id: 'x', z: 'a0', layout: 'timeline' }), container({ id: 'b', z: 'a1' })])).toBe('b');
    expect(orphanHome([container({ id: 'x', layout: 'timeline' })])).toBeNull();
  });

  const board = (): Obj[] => [
    container(),
    lane('a', 'a0'), lane('b', 'a1'),
    card('k1', 'a', 'a0'), card('k2', 'b', 'a0'),
    container({ id: 'd', x: 2000, z: 'a1' }),
    { id: 'dl', type: 'lane', parent: 'd', rank: 'a0@d' },
    { id: 'sticky', type: 'sticky', x: 5, y: 5, w: 10, h: 10 },
    { id: 'loose', type: 'card', x: 9, y: 9, w: 192, h: 40 },
    { id: 'framed', type: 'card', parent: 'frame', rank: 'a0@frame' },
    { id: 'frame', type: 'frame' },
  ];

  it('lays out every container and only what is inside one', () => {
    const { layouts, rects } = layoutAll(board());
    expect([...layouts.keys()].sort()).toEqual(['c', 'd']);
    expect([...rects.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'dl', 'k1', 'k2']);
    expect(rects.get('k1')).toEqual(layoutContainer(container(), [lane('a', 'a0'), lane('b', 'a1')], [card('k1', 'a', 'a0'), card('k2', 'b', 'a0')])!.rects.get('k1'));
    expect(rects.get('dl')!.x).toBe(2000 + KANBAN.pad);
  });

  it('shows the cards of a deleted lane in the first lane of the home container, once', () => {
    const objects = board().filter((o) => o.id !== 'b');
    const { layouts } = layoutAll(objects);
    expect(layouts.get('c')!.cards.get('a')).toEqual(['k1', 'k2']);
    expect(layouts.get('d')!.cards.get('dl')).toEqual([]);
  });

  it('leaves cards alone when there is no container to take them', () => {
    const objects = board().filter((o) => o.type !== 'container' && o.type !== 'lane');
    const { layouts, rects } = layoutAll(objects);
    expect(layouts.size).toBe(0);
    expect(rects.size).toBe(0);
  });

  it('gives the same answer whatever order the objects come in', () => {
    const flat = (r: Map<string, unknown>) => JSON.stringify([...r].sort(([a], [b]) => (a < b ? -1 : 1)));
    const reference = flat(layoutAll(board()).rects);
    for (let seed = 1; seed <= 10; seed++) expect(flat(layoutAll(shuffled(board(), seed)).rects)).toBe(reference);
  });
});

describe('wipCheck', () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}` }));

  it('has no limit unless it is an integer from 1 to 99', () => {
    for (const wip of [undefined, 0, -1, 1.5, 100, Number.NaN]) {
      expect(wipCheck({ wip, wipMode: 'block' }, cards(5), ['new'])).toMatchObject({ ok: true, over: false, limit: null });
    }
    expect(wipCheck({ wip: LIMITS.wipMax }, [], [])).toMatchObject({ limit: 99 });
  });

  it('warns by default: the drop is allowed and the lane reports it is over', () => {
    expect(wipCheck({ wip: 3 }, cards(3), ['n'])).toEqual({ ok: true, over: true, count: 4, limit: 3, mode: 'warn' });
    expect(wipCheck({ wip: 3, wipMode: 'sideways' }, cards(3), ['n']).mode).toBe('warn');
    expect(wipCheck({ wip: 3 }, cards(2), ['n'])).toMatchObject({ ok: true, over: false, count: 3 });
  });

  it('refuses a drop that would pass the limit in block mode, and allows one that fills it', () => {
    expect(wipCheck({ wip: 3, wipMode: 'block' }, cards(3), ['n'])).toEqual({ ok: false, over: true, count: 4, limit: 3, mode: 'block' });
    expect(wipCheck({ wip: 3, wipMode: 'block' }, cards(2), ['n'])).toMatchObject({ ok: true, over: false, count: 3 });
    expect(wipCheck({ wip: 3, wipMode: 'block' }, cards(1), ['n1', 'n2', 'n3'])).toMatchObject({ ok: false, count: 4 });
  });

  it('never counts a card that is already in the lane, so moving within it is allowed', () => {
    expect(wipCheck({ wip: 3, wipMode: 'block' }, cards(3), ['k0', 'k2'])).toMatchObject({ ok: true, over: false, count: 3 });
  });

  it('does not trap the cards of a lane that is already over its limit', () => {
    const over = cards(5);
    expect(wipCheck({ wip: 3, wipMode: 'block' }, over, ['k4'])).toMatchObject({ ok: true, over: true, count: 5 });
    expect(wipCheck({ wip: 3, wipMode: 'block' }, over, [])).toMatchObject({ ok: true });
    expect(wipCheck({ wip: 3, wipMode: 'block' }, over, ['n'])).toMatchObject({ ok: false, count: 6 });
  });

  it('counts a card moved twice once', () => {
    expect(wipCheck({ wip: 3, wipMode: 'block' }, cards(2), ['n', 'n'])).toMatchObject({ ok: true, count: 3 });
  });
});

describe('features', () => {
  it('writes one meta key per feature, so concurrent writers cannot overwrite each other', () => {
    expect(featureKey('containers')).toBe('feature:containers');
    expect(isFeatureKey('feature:tables') && isFeatureKey('features') && !isFeatureKey('name') && !isFeatureKey('gridType')).toBe(true);
  });

  it('lists the features of a board\'s meta, sorted', () => {
    expect(featuresOf({ name: 'x', 'feature:tables': true, 'feature:containers': true })).toEqual(['containers', 'tables']);
    expect(featuresOf({ 'feature:a': false, 'feature:b': null, 'feature:c': 0 })).toEqual(['c']);
    expect(featuresOf({})).toEqual([]);
    expect(featuresOf(undefined)).toEqual([]);
  });

  it('still reads the first form, an array under `features`', () => {
    expect(featuresOf({ features: ['containers'] })).toEqual(['containers']);
    expect(featuresOf({ features: ['containers'], 'feature:tables': true })).toEqual(['containers', 'tables']);
    expect(unknownFeatures({ features: ['containers'] })).toEqual([]);
    expect(unknownFeatures({ features: ['containers', 'holograms'] })).toEqual(['holograms']);
  });

  it('names the features this code does not know', () => {
    expect(unknownFeatures({})).toEqual([]);
    expect(unknownFeatures({ 'feature:containers': true })).toEqual([]);
    expect(unknownFeatures({ 'feature:containers': true, 'feature:holograms': true })).toEqual(['holograms']);
    expect(unknownFeatures({ 'feature:containers': 'yes' })).toEqual([]);
    expect(unknownFeatures({ 'feature:holograms': 1 })).toEqual(['holograms']);
  });

  it('fails closed: what it cannot read counts as a feature it does not know', () => {
    for (const features of ['containers', 7, true, false, {}, { containers: true }]) {
      expect(unknownFeatures({ features })).toEqual(['features']);
    }
    expect(unknownFeatures({ features: ['containers', 5] })).toEqual(['features']);
    expect(unknownFeatures({ 'feature:': true })).toEqual(['']);
    expect(unknownFeatures({ features: null })).toEqual([]);
  });
});

describe('the Docker image', () => {
  it('copies shared/ next to server/, which imports it', () => {
    const server = readFileSync(new URL('../server/board-ops.mjs', import.meta.url), 'utf8');
    expect(server).toContain("from '../shared/containers.mjs'");
    const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const runtime = docker.slice(docker.lastIndexOf('FROM '));
    expect(runtime).toMatch(/^COPY shared \.\/shared$/m);
    expect(runtime).toMatch(/^COPY server \.\/server$/m);
  });
});

describe('label colours', () => {
  it('are the names of the sticky swatches, so chips look the same in every theme', () => {
    expect([...LABEL_COLORS]).toEqual(STICKY_COLORS.map((c) => c.name.toLowerCase()));
  });
});
