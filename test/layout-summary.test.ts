import { describe, expect, it } from 'vitest';
import { AREA, GAP, MAX, boundsOf, findSpot, frameInterior, packBlock, placeBlock, summarizeLayout, type Rect, type Solid } from '../shared/layout-summary';

// TAB-379: where there is room on a board. Pure geometry, so these run without a server.

const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A busy board of 200 objects: a grid of stickies, three frames (one full, one with room, one empty), and a few scattered notes. */
function busy() {
  const solids: Solid[] = [];
  const frames: { id: string; name: string; x: number; y: number; w: number; h: number; children: number }[] = [];
  for (let i = 0; i < 150; i++) solids.push({ id: `s${i}`, x: (i % 15) * 220, y: Math.floor(i / 15) * 220, w: 192, h: 192 });
  const frame = (id: string, x: number, y: number, w: number, h: number, children: number) => {
    solids.push({ id, x, y, w, h });
    frames.push({ id, name: `Frame ${id}`, x, y, w, h, children });
  };
  frame('f-full', 3600, 0, 600, 400, 0);
  frame('f-room', 3600, 600, 900, 700, 0);
  frame('f-empty', 3600, 1500, 700, 500, 0);
  // the full frame is packed with children
  for (let i = 0; i < 12; i++) solids.push({ id: `c${i}`, x: 3624 + (i % 4) * 140, y: 56 + Math.floor(i / 4) * 110, w: 128, h: 100 });
  // the room frame has one note in a corner
  solids.push({ id: 'n1', x: 3624, y: 656, w: 192, h: 192 });
  for (let i = 0; i < 34; i++) solids.push({ id: `x${i}`, x: 4800 + (i % 6) * 300, y: (Math.floor(i / 6)) * 300, w: 200, h: 200 });
  return { solids, frames };
}

describe('findSpot and placeBlock', () => {
  it('finds no spot in a full region and a spot in an empty one', () => {
    const region = { x: 0, y: 0, w: 400, h: 300 };
    expect(findSpot([{ x: 0, y: 0, w: 400, h: 300 }], { w: 100, h: 100 }, { region })).toBeNull();
    expect(findSpot([], { w: 100, h: 100 }, { region })).toEqual({ x: 0, y: 0 });
    expect(findSpot([], { w: 500, h: 100 }, { region })).toBeNull();
  });

  it('keeps the gap to what is already there', () => {
    const solids = [{ x: 0, y: 0, w: 200, h: 200 }];
    const spot = findSpot(solids, { w: 100, h: 100 }, { region: { x: 0, y: 0, w: 1000, h: 1000 } })!;
    expect(spot).not.toBeNull();
    const box = { ...spot, w: 100, h: 100 };
    expect(hits(box, { x: -GAP, y: -GAP, w: 200 + 2 * GAP, h: 200 + 2 * GAP })).toBe(false);
  });

  it('lays a block out in rows and never overlaps its own items', () => {
    const sizes = Array.from({ length: 10 }, () => ({ w: 300, h: 100 }));
    const { offsets, w } = packBlock(sizes);
    expect(w).toBeLessThanOrEqual(1200);
    const overlapping = offsets.flatMap((a, i) => offsets.filter((b, j) => i < j && hits({ ...a, ...sizes[i] }, { ...b, ...sizes[j] })));
    expect(overlapping).toEqual([]);
  });

  it('puts a block beyond the content when no gap fits, and at the origin on an empty board', () => {
    const solids = [{ x: 0, y: 0, w: 500, h: 500 }];
    expect(placeBlock(solids, [{ w: 400, h: 400 }])).toEqual([{ x: 580, y: 0 }]);
    expect(placeBlock([], [{ w: 100, h: 100 }])).toEqual([{ x: 0, y: 0 }]);
  });

  it('returns null for a frame that has no room, so the caller can refuse', () => {
    const frame = { x: 0, y: 0, w: 300, h: 300 };
    expect(placeBlock([{ x: 24, y: 56, w: 252, h: 220 }], [{ w: 100, h: 100 }], { region: frameInterior(frame) })).toBeNull();
  });
});

describe('summarizeLayout on a busy board', () => {
  const { solids, frames } = busy();
  const layout = summarizeLayout({ solids, frames });

  it('is bounded: at most 6 free areas, 12 occupied regions and 20 frames', () => {
    expect(layout.free.length).toBeLessThanOrEqual(MAX.free);
    expect(layout.occupied.length).toBeLessThanOrEqual(MAX.occupied);
    expect(layout.frames.length).toBeLessThanOrEqual(MAX.frames);
    expect(JSON.stringify(layout).length).toBeLessThan(6_000);
  });

  it('reports free areas that touch no object, none closer than the gap', () => {
    expect(layout.free.length).toBeGreaterThanOrEqual(3);
    for (const area of layout.free) {
      for (const s of solids) {
        const own = area.where === `inside frame ${s.id}`;
        if (own) continue;
        expect({ where: area.where, id: s.id, hit: hits(area, s) }).toMatchObject({ hit: false });
      }
    }
  });

  it('offers room right of and below everything, inside the frame that has room, and none inside the full one', () => {
    const wheres = layout.free.map((a) => a.where);
    expect(wheres).toContain('right of all content');
    expect(wheres).toContain('below all content');
    expect(wheres).toContain('inside frame f-room');
    expect(wheres).not.toContain('inside frame f-full');
    const inside = layout.free.find((a) => a.where === 'inside frame f-room')!;
    const interior = frameInterior(frames[1]);
    expect(inside.x).toBeGreaterThanOrEqual(interior.x);
    expect(inside.y).toBeGreaterThanOrEqual(interior.y);
    expect(inside.x + inside.w).toBeLessThanOrEqual(interior.x + interior.w);
    expect(inside.y + inside.h).toBeLessThanOrEqual(interior.y + interior.h);
  });

  it('is deterministic', () => {
    expect(summarizeLayout({ solids, frames })).toEqual(layout);
  });

  it('lists frames with their own bounds and child counts, never more than they were given', () => {
    expect(layout.frames.map((f) => f.id)).toEqual(['f-full', 'f-room', 'f-empty']);
    expect(layout.frames[0]).toMatchObject({ x: 3600, y: 0, w: 600, h: 400 });
  });

  it('answers an empty board with the origin and no frames', () => {
    expect(summarizeLayout({ solids: [], frames: [] })).toEqual({ frames: [], occupied: [], free: [{ x: 0, y: 0, ...AREA.right, where: 'empty board' }] });
  });

  it('counts a withheld note as space: no free area touches it, and the output holds no id for it', () => {
    const secret = { x: 1000, y: 5000, w: 192, h: 192 };
    const withNote = summarizeLayout({ solids: [...solids, secret], frames });
    for (const area of withNote.free) expect(hits(area, secret)).toBe(false);
    expect(JSON.stringify(withNote)).not.toContain('"id":"secret');
    // the note is below the content, so "below all content" moves down past it
    const below = withNote.free.find((a) => a.where === 'below all content')!;
    expect(below.y).toBeGreaterThanOrEqual(secret.y + secret.h);
  });

  it('reports the occupied map in coarse cells, never at the exact size of one small note', () => {
    const lone = summarizeLayout({ solids: [{ x: 0, y: 0, w: 20, h: 20 }, { x: 5000, y: 5000, w: 192, h: 192 }], frames: [] });
    for (const r of lone.occupied) {
      expect(r.w % 160).toBe(0);
      expect(r.h % 160).toBe(0);
    }
    expect(lone.occupied.some((r) => r.w === 192 && r.h === 192)).toBe(false);
  });

  it('stays cheap on a huge sparse board', () => {
    const sparse: Solid[] = Array.from({ length: 5000 }, (_, i) => ({ id: `o${i}`, x: (i % 100) * 5000, y: Math.floor(i / 100) * 5000, w: 192, h: 192 }));
    const started = Date.now();
    const out = summarizeLayout({ solids: sparse, frames: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.free.length).toBeGreaterThan(0);
    expect(boundsOf(sparse)).not.toBeNull();
  });
});
