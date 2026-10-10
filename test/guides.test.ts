import { describe, expect, it } from 'vitest';
import {
  EPS, MAX_SIZE_MARKS, MIN_GAP_PX, SNAP_PX, gapsInBand, guidesCover, referenceRects, snapMove, snapResize, snapResizeLocked, startGuides,
  type GapMark, type GuideSession, type Snap,
} from '../src/guides';
import { boxBounds } from '../src/geometry';
import type { BaseObj, ConnectorObj, Obj, Rect } from '../src/types';

const rc = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const BIG = rc(-100000, -100000, 200000, 200000);
const session = (refs: Rect[], movers: Rect[] = [], view: Rect = BIG): GuideSession => startGuides(refs, movers, view);
const transpose = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w });
const POINT_FAR = rc(0, 1000, 0, 0);

/** Moves a mover whose base is `base` so that it sits at (x, y). */
function moveTo(s: GuideSession, x: number, y: number, zoom = 1): Snap {
  return snapMove(s, x - s.base!.x, y - s.base!.y, zoom);
}

const sorted = (gs: GapMark[]) => [...gs].sort((p, q) => p.from - q.from);

describe('alignment', () => {
  const REF = rc(100, 100, 100, 60);
  const OFFS = [0, 20, 40];
  const VALS = [100, 150, 200];

  it('snaps each of the nine value pairs in x', () => {
    for (let iv = 0; iv < 3; iv++) {
      for (let ir = 0; ir < 3; ir++) {
        const s = session([REF], [rc(0, 1000, 40, 20)]);
        const r = moveTo(s, VALS[ir] - 3 - OFFS[iv], 1000);
        expect(r.dx, `mover ${iv} to ref ${ir}`).toBeCloseTo(3);
        expect(r.dy).toBeNull();
      }
    }
  });

  it('snaps each of the nine value pairs in y', () => {
    for (let iv = 0; iv < 3; iv++) {
      for (let ir = 0; ir < 3; ir++) {
        const s = session([transpose(REF)], [transpose(rc(0, 1000, 40, 20))]);
        const r = moveTo(s, 1000, VALS[ir] - 3 - OFFS[iv]);
        expect(r.dy, `mover ${iv} to ref ${ir}`).toBeCloseTo(3);
        expect(r.dx).toBeNull();
      }
    }
  });

  it('uses a threshold of 6 screen px divided by zoom', () => {
    expect(SNAP_PX).toBe(6);
    for (const zoom of [0.5, 1, 4]) {
      const thr = SNAP_PX / zoom;
      const s = session([rc(100, 100, 50, 50)], [POINT_FAR]);
      expect(moveTo(s, 100 - (thr - 0.1), 1000, zoom).dx, `inside at zoom ${zoom}`).toBeCloseTo(thr - 0.1);
      expect(moveTo(s, 100 - (thr + 0.1), 1000, zoom).dx, `outside at zoom ${zoom}`).toBeNull();
    }
  });

  it('prefers the smallest correction', () => {
    const s = session([rc(100, 0, 10, 10), rc(104, 300, 10, 10)], [rc(0, 1000, 20, 20)]);
    expect(moveTo(s, 102.9, 1000).dx).toBeCloseTo(1.1);
  });

  it('breaks ties by pair kind, then by the smaller coordinate, and gives the same answer twice', () => {
    const mover = rc(0, 1000, 40, 20);
    const q = rc(100, 200, 10, 10);
    // centre-to-centre (-3) beats edge-to-edge (+3)
    const centre = session([rc(104, 0, 20, 10), q], [mover]);
    expect(moveTo(centre, 97, 1000).dx).toBeCloseTo(-3);
    // same kind (+3) beats a mixed pair (-3)
    const same = session([q, rc(124, 400, 20, 10)], [mover]);
    expect(moveTo(same, 97, 1000).dx).toBeCloseTo(3);
    // two same-kind pairs: the smaller coordinate wins
    const coord = session([q, rc(114, 600, 20, 10)], [mover]);
    const first = moveTo(coord, 97, 1000);
    expect(first.dx).toBeCloseTo(3);
    expect(moveTo(coord, 97, 1000)).toEqual(first);
  });

  it('draws one line across the moving rectangle and every reference with a value there, one per aligned value', () => {
    const a = rc(100, 0, 60, 50), b = rc(100, 300, 40, 60), c = rc(80, 600, 40, 40);
    const s = session([a, b, c], [rc(0, 200, 60, 40)]);
    const r = moveTo(s, 98, 200);
    expect(r.dx).toBeCloseTo(2);
    expect(r.dy).toBeNull();
    expect(r.guides).toEqual([
      { kind: 'line', x1: 100, y1: 0, x2: 100, y2: 640 },
      { kind: 'line', x1: 130, y1: 0, x2: 130, y2: 240 },
      { kind: 'line', x1: 160, y1: 0, x2: 160, y2: 240 },
    ]);
  });
});

describe('equal spacing in a column', () => {
  const A = rc(0, 0, 100, 100), B = rc(0, 150, 100, 100);

  it('snaps below the pair to the same gap and marks both gaps', () => {
    const s = session([A, B], [rc(0, -500, 100, 100)]);
    const r = moveTo(s, 0, 296);
    expect(r.dy).toBeCloseTo(4);
    expect(r.dx).toBeCloseTo(0);
    expect(sorted(r.gaps)).toEqual([
      { kind: 'gap', axis: 'y', from: 100, to: 150, at: 50, label: '50' },
      { kind: 'gap', axis: 'y', from: 250, to: 300, at: 50, label: '50' },
    ]);
  });

  it('snaps above the pair', () => {
    const s = session([A, B], [rc(0, -500, 100, 100)]);
    const r = moveTo(s, 0, -146);
    expect(r.dy).toBeCloseTo(-4);
    expect(sorted(r.gaps).map((g) => [g.from, g.to])).toEqual([[-50, 0], [100, 150]]);
  });
});

describe('equal spacing in a row', () => {
  const A = rc(0, 0, 100, 100), B = rc(150, 0, 100, 100);

  it('snaps beside the pair to the same gap and marks both gaps', () => {
    const s = session([A, B], [rc(-500, 0, 100, 100)]);
    const r = moveTo(s, 296, 0);
    expect(r.dx).toBeCloseTo(4);
    expect(sorted(r.gaps)).toEqual([
      { kind: 'gap', axis: 'x', from: 100, to: 150, at: 50, label: '50' },
      { kind: 'gap', axis: 'x', from: 250, to: 300, at: 50, label: '50' },
    ]);
  });

  it('ignores a gap in a row the moving rectangle does not share', () => {
    const s = session([A, rc(1000, 500, 100, 100), rc(1150, 500, 100, 100)], [rc(-500, 0, 100, 100)]);
    const r = moveTo(s, 154, 0);
    expect(r.dx).toBeNull();
    expect(r.gaps).toEqual([]);
  });

  it('skips a container for spacing but still aligns to its edges', () => {
    const container = rc(-50, -50, 500, 300);
    const s = session([container, A, B], [rc(-500, 0, 100, 100)]);
    const spaced = moveTo(s, 296, 0);
    expect(spaced.dx).toBeCloseTo(4);
    expect(spaced.gaps).toHaveLength(2);
    const aligned = moveTo(s, -47, 0);
    expect(aligned.dx).toBeCloseTo(-3);
    const edge = aligned.guides.find((g) => g.x1 === g.x2 && Math.abs(g.x1 + 50) < EPS);
    expect(edge).toMatchObject({ y1: -50, y2: 250 });
  });
});

describe('midway placement', () => {
  const A = rc(0, 0, 100, 100), B = rc(400, 0, 100, 100);

  it('centres between two neighbours and marks both gaps', () => {
    const s = session([A, B], [rc(0, 0, 100, 100)]);
    const r = moveTo(s, 196, 0);
    expect(r.dx).toBeCloseTo(4);
    expect(sorted(r.gaps).map((g) => [g.from, g.to, g.label])).toEqual([[100, 200, '100'], [300, 400, '100']]);
  });

  it('is refused when the gaps would be narrower than the minimum', () => {
    const tight = session([A, rc(206, 0, 100, 100)], [rc(0, 0, 100, 100)]);
    const r = moveTo(tight, 101, 0);
    expect(r.dx).toBeCloseTo(-1);
    expect(r.gaps).toEqual([]);
  });

  it('is refused when it would land on a third object', () => {
    const s = session([A, rc(230, 0, 60, 100), rc(500, 0, 100, 100)], [rc(0, 0, 100, 100)]);
    const r = moveTo(s, 247, 0);
    expect(r.dx).toBeNull();
    expect(r.gaps).toEqual([]);
  });
});

describe('alignment versus spacing', () => {
  const A = rc(0, 0, 100, 100), B = rc(150, 0, 100, 100);
  const mover = rc(0, 0, 100, 100);
  // spacing target for the mover's left edge is 300 (250 + 50); a reference far away offers an alignment line
  const at = (zOffset: number, rawLo: number) => {
    const s = session([A, B, rc(zOffset, 1000, 20, 20)], [mover]);
    return moveTo(s, rawLo, 0);
  };

  it('lets spacing win with a correction up to 2 px worse', () => {
    expect(at(301, 302).dx).toBeCloseTo(-2);
  });

  it('lets alignment win when it is closer by more than that', () => {
    expect(at(304.5, 305).dx).toBeCloseTo(-0.5);
  });

  it('gives a tie to spacing', () => {
    expect(at(302, 304).dx).toBeCloseTo(-4);
  });

  it('reports both when they land on the same position', () => {
    const r = at(300, 302);
    expect(r.dx).toBeCloseTo(-2);
    expect(r.guides.some((g) => g.x1 === g.x2 && Math.abs(g.x1 - 300) < EPS)).toBe(true);
    expect(r.gaps.filter((g) => g.axis === 'x')).toHaveLength(2);
  });
});

describe('grid fallback', () => {
  it('returns null on an axis with nothing in range and reports nothing for it', () => {
    const s = session([rc(100, 100, 50, 50)], [rc(0, 0, 10, 10)]);
    const r = snapMove(s, 1000, 1000, 1);
    expect(r).toEqual({ dx: null, dy: null, guides: [], gaps: [], sizes: [] });
  });

  it('returns nothing when there is no moving box', () => {
    const s = session([rc(0, 0, 10, 10)]);
    expect(snapMove(s, 5, 5, 1)).toEqual({ dx: null, dy: null, guides: [], gaps: [], sizes: [] });
  });
});

describe('marker cap', () => {
  it('shows the two next to the object and the four nearest others', () => {
    const refs: Rect[] = [];
    for (let i = 0; i < 10; i++) refs.push(rc(i * 30, 0, 10, 50));
    refs.push(rc(400, 0, 10, 50), rc(460, 0, 10, 50));
    const s = session(refs, [rc(0, 0, 10, 50)]);
    const r = moveTo(s, 428, 0);
    expect(r.dx).toBeCloseTo(2);
    expect(r.gaps).toHaveLength(6);
    const others = r.gaps.filter((g) => g.to !== 430 && g.from !== 440);
    expect(others.map((g) => g.from).sort((p, q) => p - q)).toEqual([160, 190, 220, 250]);
  });
});

describe('minimum gap', () => {
  it('has no spacing candidate or marker for touching objects or gaps under 4 screen px', () => {
    expect(MIN_GAP_PX).toBe(4);
    const touching = session([rc(0, 0, 100, 100), rc(100, 0, 100, 100)], [rc(0, 0, 100, 100)]);
    const t = moveTo(touching, 203, 0);
    expect(t.dx).toBeCloseTo(-3);
    expect(t.gaps).toEqual([]);

    const narrow = session([rc(0, 0, 100, 100), rc(102, 0, 100, 100)], [rc(0, 0, 100, 100)]);
    const n = moveTo(narrow, 206, 0);
    expect(n.dx).toBeCloseTo(-4);
    expect(n.gaps).toEqual([]);
  });

  it('scales with zoom', () => {
    const s = session([rc(0, 0, 100, 100), rc(103, 0, 100, 100)], [rc(0, 0, 100, 100)]);
    const r = moveTo(s, 206.4, 0, 2);
    expect(r.dx).toBeCloseTo(-0.4);
    expect(r.gaps.map((g) => g.label)).toEqual(['3', '3']);
  });
});

describe('resize', () => {
  const rect = rc(100, 100, 200, 100);
  const refs = [
    rc(98, 3000, 0, 10), rc(304, 2000, 0, 10), rc(200, 4000, 0, 10),
    rc(5000, 98, 10, 0), rc(6000, 204, 10, 0), rc(7000, 150, 10, 0),
  ];
  const cases: [string, number | null, number | null][] = [
    ['e', 4, null], ['w', -2, null], ['n', null, -2], ['s', null, 4],
    ['ne', 4, -2], ['nw', -2, -2], ['se', 4, 4], ['sw', -2, 4],
  ];

  it('snaps only the edges the handle moves, never the opposite edge or the centre', () => {
    const s = session(refs);
    const got = cases.map(([handle]) => {
      const r = snapResize(s, rect, handle, 1);
      return [handle, r.dx, r.dy];
    });
    expect(got).toEqual(cases);
  });

  it('matches the moving edge to an existing gap', () => {
    const s = session([rc(0, 0, 100, 100), rc(150, 0, 100, 100)]);
    const r = snapResize(s, rc(305, 0, 200, 100), 'w', 1);
    expect(r.dx).toBeCloseTo(-5);
    expect(r.dy).toBeNull();
    expect(sorted(r.gaps).map((g) => [g.from, g.to, g.label])).toEqual([[100, 150, '50'], [250, 300, '50']]);
  });

  it('matches the moving edge to the gap on the fixed side', () => {
    const s = session([rc(0, 0, 100, 100), rc(300, 0, 100, 100)]);
    const r = snapResize(s, rc(150, 0, 96, 100), 'e', 1);
    expect(r.dx).toBeCloseTo(4);
    expect(sorted(r.gaps).map((g) => [g.from, g.to, g.label])).toEqual([[100, 150, '50'], [250, 300, '50']]);
  });

  it('has no midway placement: the far edge stays where it is', () => {
    const s = session([rc(0, 0, 100, 100), rc(400, 0, 100, 100)]);
    const r = snapResize(s, rc(150, 0, 50, 100), 'e', 1);
    expect(r.dx).toBeNull();
    expect(r.gaps).toEqual([]);
  });

  it('does nothing below the minimum size and discards a snap that would go below it', () => {
    const s = session([rc(103, 3000, 0, 10)]);
    expect(snapResize(s, rc(100, 100, 5, 50), 'e', 1).dx).toBeNull();
    expect(snapResize(s, rc(100, 100, 10, 50), 'w', 1).dx).toBeNull();
    expect(snapResize(s, rc(100, 100, 20, 50), 'w', 1).dx).toBeCloseTo(3);
  });
});

describe('resize size matching', () => {
  it('matches width and height using the sorted size indexes', () => {
    const width = snapResize(session([rc(500, 500, 120, 70)]), rc(0, 0, 116, 40), 'e', 1);
    expect(width.dx).toBeCloseTo(4);
    expect(width.sizes.map((m) => [m.axis, m.from, m.to, m.label])).toEqual([
      ['x', 0, 120, '120'], ['x', 500, 620, '120'],
    ]);

    const height = snapResize(session([rc(500, 500, 70, 120)]), rc(0, 0, 40, 116), 's', 1);
    expect(height.dy).toBeCloseTo(4);
    expect(height.sizes.map((m) => [m.axis, m.from, m.to, m.label])).toEqual([
      ['y', 0, 120, '120'], ['y', 500, 620, '120'],
    ]);
  });

  it('lets a size match win a correction tie with alignment', () => {
    const s = session([rc(97, 500, 20, 10), rc(1000, 600, 103, 10)]);
    const snap = snapResize(s, rc(0, 0, 100, 40), 'e', 1);
    // Alignment would move the edge left by 3; the equal width moves it right by 3.
    expect(snap.dx).toBeCloseTo(3);
    expect(snap.sizes.some((m) => m.axis === 'x' && m.from === 0 && m.to === 103)).toBe(true);
  });

  it('does not let a size match resize below MIN_SIZE', () => {
    const snap = snapResize(session([rc(1000, 1000, 7, 10)]), rc(0, 0, 9, 20), 'e', 1);
    expect(snap.dx).toBeNull();
    expect(snap.sizes).toEqual([]);
  });

  it('reports the resized dimension and every equal reference up to the nearest-three cap', () => {
    const refs = [400, 100, 300, 200, 500].map((y) => rc(600, y, 120, 20));
    const snap = snapResize(session(refs), rc(0, 0, 119, 40), 'e', 1);
    expect(snap.dx).toBeCloseTo(1);
    expect(MAX_SIZE_MARKS).toBe(3);
    expect(snap.sizes).toHaveLength(1 + MAX_SIZE_MARKS);
    expect(snap.sizes[0]).toMatchObject({ kind: 'size', axis: 'x', from: 0, to: 120, label: '120' });
    // Reference marks are ordered by distance from the resized object.
    expect(snap.sizes.slice(1).map((m) => m.at)).toEqual([128, 228, 328]);
  });
});

describe('aspect-locked resize', () => {
  it('keeps the ratio and opposite corner fixed when the nearer y correction wins', () => {
    const s = session([rc(104, 1000, 10, 10), rc(1000, 152, 10, 10)]);
    const proposed = rc(0, 100, 100, 50);
    const snap = snapResizeLocked(s, proposed, 'se', 1, 2);
    expect(snap.snappedAxis).toBe('y');
    expect(snap.rect).toEqual(rc(0, 100, 104, 52));
    expect(snap.rect.w / snap.rect.h).toBe(2);
  });

  it('snaps a locked corner to an equal size', () => {
    const s = session([rc(1000, 1000, 120, 30)]);
    const snap = snapResizeLocked(s, rc(0, 0, 116, 58), 'se', 1, 2);
    expect(snap.snappedAxis).toBe('x');
    expect(snap.rect).toEqual(rc(0, 0, 120, 60));
    expect(snap.sizes).toEqual([
      { kind: 'size', axis: 'x', from: 0, to: 120, at: 68, label: '120' },
      { kind: 'size', axis: 'x', from: 1000, to: 1120, at: 1038, label: '120' },
    ]);
  });

  it('leaves the proposal unchanged and reports no marks when nothing is in range', () => {
    const proposed = rc(0, 0, 100, 50);
    const snap = snapResizeLocked(session([rc(1000, 1000, 300, 300)]), proposed, 'se', 1, 2);
    expect(snap.rect).toEqual(proposed);
    expect(snap.snappedAxis).toBeNull();
    expect(snap.guides).toEqual([]);
    expect(snap.gaps).toEqual([]);
    expect(snap.sizes).toEqual([]);
  });
});

describe('multi-select', () => {
  it('snaps the union of the movers as one rectangle', () => {
    const movers = [rc(0, 0, 50, 50), rc(100, 20, 50, 50), rc(200, 0, 50, 50)];
    const s = session([rc(253, 500, 10, 10)], movers);
    expect(s.base).toEqual(rc(0, 0, 250, 70));
    const r = snapMove(s, 0, 0, 1);
    expect(r.dx).toBeCloseTo(3);
    expect(r.dy).toBeNull();
  });

  it('never uses a mover as its own reference', () => {
    const objs: Obj[] = [box('a', 0, 0), box('b', 200, 0)];
    const refs = referenceRects(objs, new Set(['a', 'b']), () => false);
    expect(refs).toEqual([]);
    const s = session(refs, objs.map((o) => boxBounds(o as BaseObj)));
    expect(snapMove(s, 1, 1, 1).dx).toBeNull();
  });
});

function box(id: string, x: number, y: number, extra: Partial<BaseObj> = {}): BaseObj {
  return { id, type: 'shape', kind: 'rect', x, y, w: 100, h: 60, rotation: 0, z: 'a0', ...extra };
}

describe('references', () => {
  it('uses the axis-aligned bounds of a rotated box', () => {
    const turned = box('r', 0, 0, { w: 100, h: 100, rotation: Math.PI / 4 });
    const [ref] = referenceRects([turned], new Set(), () => false);
    expect(ref).toEqual(boxBounds(turned));
    expect(ref.w).toBeGreaterThan(140);
    const s = session([ref], [rc(0, 1000, 0, 0)]);
    expect(moveTo(s, ref.x + ref.w + 3, 1000).dx).toBeCloseTo(-3);
  });

  it('leaves out connectors, hidden objects and the moving set, and keeps locked objects, frames and paths', () => {
    const connector: ConnectorObj = {
      id: 'c', type: 'connector', z: 'a1', from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 5, y: 5 },
      route: 'straight', startHead: 'none', endHead: 'arrow',
    };
    const objs: Obj[] = [
      box('a', 0, 0), connector, box('hidden', 500, 0), box('moving', 1000, 0), box('locked', 1500, 0, { locked: true }),
      box('frame', 2000, 0, { type: 'frame' }), box('path', 2500, 0, { type: 'path', points: [0, 0, 10, 10] }),
    ];
    const refs = referenceRects(objs, new Set(['moving']), (o) => o.id === 'hidden');
    expect(refs.map((r) => r.x)).toEqual([0, 1500, 2000, 2500]);
  });
});

describe('region', () => {
  const view = rc(0, 0, 1000, 800);

  it('drops references outside the viewport grown by half its size on every side', () => {
    const s = session([rc(1400, 100, 10, 10), rc(1600, 100, 10, 10), rc(100, 1300, 10, 10), rc(-520, 100, 10, 10)], [], view);
    expect(s.rects.map((r) => r.x)).toEqual([1400]);
  });

  it('covers a viewport inside the margin and not one outside it', () => {
    const s = session([], [], view);
    expect(guidesCover(s, view)).toBe(true);
    expect(guidesCover(s, rc(-400, -300, 1800, 1400))).toBe(true);
    expect(guidesCover(s, rc(-600, 0, 1000, 800))).toBe(false);
    expect(guidesCover(s, rc(-100, -100, 3000, 2000))).toBe(false);
  });
});

describe('gapsInBand', () => {
  it('returns the free gaps of a row', () => {
    const s = session([rc(0, 0, 100, 100), rc(150, 20, 100, 60), rc(300, 0, 100, 100), rc(0, 500, 10, 10)]);
    expect(gapsInBand(s, 'x', 0, 100)).toEqual([{ from: 100, to: 150, size: 50 }, { from: 250, to: 300, size: 50 }]);
    expect(gapsInBand(s, 'x', 200, 300)).toEqual([]);
    expect(gapsInBand(s, 'y', 0, 100, 60)).toEqual([{ from: 100, to: 500, size: 400 }]);
    expect(gapsInBand(s, 'y', 0, 100, 500)).toEqual([]);
  });
});

function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('invariants over random layouts', () => {
  it('reports lines at the moving values and equal gaps next to the moving rectangle', () => {
    const rnd = prng(42);
    const refs: Rect[] = [];
    for (let i = 0; i < 70; i++) refs.push(rc(Math.floor(rnd() * 30) * 40, Math.floor(rnd() * 12) * 70, 20 + Math.floor(rnd() * 4) * 20, 20 + Math.floor(rnd() * 3) * 20));
    const base = rc(0, 0, 40, 40);
    const s = session(refs, [base]);
    const bad: string[] = [];
    const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
    let snapped = 0, withGaps = 0;
    for (let n = 0; n < 600; n++) {
      const zoom = [0.5, 1, 2][n % 3];
      const dx = rnd() * 1300, dy = rnd() * 900;
      const r = snapMove(s, dx, dy, zoom);
      const thr = SNAP_PX / zoom;
      const tag = `query ${n}`;
      if (r.dx !== null && Math.abs(r.dx) > thr + 1e-9) bad.push(`${tag} dx beyond threshold`);
      if (r.dy !== null && Math.abs(r.dy) > thr + 1e-9) bad.push(`${tag} dy beyond threshold`);
      const fin = rc(base.x + dx + (r.dx ?? 0), base.y + dy + (r.dy ?? 0), base.w, base.h);
      if (r.dx !== null || r.dy !== null) snapped++;
      for (const g of r.guides) {
        const vertical = g.x1 === g.x2;
        const corr = vertical ? r.dx : r.dy;
        const values = vertical ? [fin.x, fin.x + fin.w / 2, fin.x + fin.w] : [fin.y, fin.y + fin.h / 2, fin.y + fin.h];
        if (corr === null) bad.push(`${tag} line on an axis that did not snap`);
        else if (!values.some((v) => near(v, vertical ? g.x1 : g.y1))) bad.push(`${tag} line not at a moving value`);
      }
      for (const axis of ['x', 'y'] as const) {
        const marks = r.gaps.filter((g) => g.axis === axis);
        if (!marks.length) continue;
        withGaps++;
        if ((axis === 'x' ? r.dx : r.dy) === null) bad.push(`${tag} ${axis} gaps on an axis that did not snap`);
        if (marks.length > 6) bad.push(`${tag} ${axis} has ${marks.length} markers`);
        const lo = axis === 'x' ? fin.x : fin.y, hi = lo + (axis === 'x' ? fin.w : fin.h);
        const adjacent = marks.filter((g) => near(g.to, lo) || near(g.from, hi));
        if (!adjacent.length) bad.push(`${tag} ${axis} markers with none next to the object`);
        for (const g of marks) {
          if (g.to - g.from < MIN_GAP_PX / zoom - 1e-9) bad.push(`${tag} ${axis} marker under the minimum gap`);
          if (!adjacent.some((a) => near(a.to - a.from, g.to - g.from))) bad.push(`${tag} ${axis} marker not equal to a gap next to the object`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(snapped).toBeGreaterThan(50);
    expect(withGaps).toBeGreaterThan(0);
  });
});

describe('performance', () => {
  it('uses bounded binary-search probes for the new 1000-reference size index', () => {
    const refs = Array.from({ length: 1000 }, (_, i) => rc(5000 + i * 10, 5000 + i * 10, 20 + i, 12 + i));
    const s = session(refs);
    let sizeProbes = 0;
    s.wi.vals = new Proxy(s.wi.vals, {
      get(target, property) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/u.test(property)) sizeProbes++;
        return Reflect.get(target, property, target);
      },
    }) as Float64Array;
    for (let i = 0; i < 1000; i++) {
      const width = 400 + (i % 5) * 0.1;
      snapResize(s, rc(0, 0, width, 40), 'e', 1);
    }
    // Existing spacing queries still make their band pass; this bounds the added size lookup and mark search itself.
    expect(sizeProbes).toBeLessThan(50_000);
  });

  it('answers thousands of queries on 1000 rectangles well inside a frame budget', () => {
    const rnd = prng(7);
    const refs: Rect[] = [];
    for (let row = 0; row < 25; row++) {
      for (let col = 0; col < 40; col++) refs.push(rc(col * 140 + Math.floor(rnd() * 3) * 5, row * 110 + Math.floor(rnd() * 3) * 5, 80 + Math.floor(rnd() * 5) * 10, 50 + Math.floor(rnd() * 4) * 10));
    }
    const view = rc(-100, -100, 40 * 140 + 200, 25 * 110 + 200);
    const s = session(refs, [rc(0, 0, 100, 60)], view);
    expect(s.rects).toHaveLength(1000);

    // Count reference visits and sorted-index candidate checks directly, independent of runner speed.
    let rectVisits = 0;
    s.rects = new Proxy(s.rects, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/u.test(property)) rectVisits++;
        return Reflect.get(target, property, receiver);
      },
    });
    let indexChecks = 0;
    for (const index of [s.xi, s.yi, s.wi, s.hi]) {
      const vals = index.vals;
      index.vals = new Proxy(vals, {
        get(target, property) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/u.test(property)) indexChecks++;
          return Reflect.get(target, property, target);
        },
      }) as Float64Array;
    }

    let snapped = 0;
    for (let n = 0; n < 2000; n++) {
      const r = snapMove(s, rnd() * 5600, rnd() * 2750, 1);
      if (r.dx !== null || r.dy !== null) snapped++;
    }
    const handles = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    for (let n = 0; n < 2000; n++) {
      const rect = rc(rnd() * 5000, rnd() * 2500, 40 + rnd() * 300, 40 + rnd() * 200);
      const r = snapResize(s, rect, handles[n % 8], 1);
      if (r.dx !== null || r.dy !== null) snapped++;
    }
    expect(snapped).toBeGreaterThan(100);
    // 4,000 queries can do at most 14,000 full reference scans (move/resize axes and result marking),
    // plus a margin for the few references returned by the sorted-index lookups.
    expect(rectVisits).toBeLessThan(16_000_000);
    // Binary searches over 3,000 sorted edge/centre values stay below this; a linear scan per query does not.
    expect(indexChecks).toBeLessThan(2_000_000);
  });
});
