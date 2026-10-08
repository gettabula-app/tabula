import { describe, expect, it } from 'vitest';
import type { BoardApp } from '../src/app';
import { snapTo } from '../src/geometry';
import { PLACE_OFFSET, nextClick, placeClicked, type ClickRun } from '../src/ui/place-click';

const centre = { x: 400, y: 300 };
const size = { w: 120, h: 120 };
const room = 220;

describe('nextClick', () => {
  it('puts the first object on the viewport centre', () => {
    expect(nextClick(null, centre, size, room)).toEqual({ at: centre, centre, n: 0 });
  });

  it('steps each further object right and down from the last one, by the step Duplicate uses', () => {
    expect(PLACE_OFFSET).toBe(24);
    const run: ClickRun = { x: 340, y: 240, centre, n: 0 };
    expect(nextClick(run, centre, size, room)).toEqual({ at: { x: 340 + 24 + 60, y: 240 + 24 + 60 }, centre, n: 1 });
  });

  it('keeps the centre the run started at, so a slow drift of the view cannot extend it', () => {
    const run: ClickRun = { x: 364, y: 264, centre, n: 1 };
    const moved = { x: centre.x + 10, y: centre.y - 10 };
    expect(nextClick(run, moved, size, room).centre).toBe(centre);
  });

  it('starts over at the centre once the view has moved a step away', () => {
    const run: ClickRun = { x: 340, y: 240, centre, n: 0 };
    const panned = { x: centre.x + 24, y: centre.y };
    expect(nextClick(run, panned, size, room)).toEqual({ at: panned, centre: panned, n: 0 });
  });

  it('starts over at the centre when the next step would go past the room', () => {
    const last: ClickRun = { x: 340, y: 240, centre, n: 9 };
    expect(nextClick({ ...last, n: 8 }, centre, size, room).n).toBe(9);
    expect(nextClick(last, centre, size, room)).toEqual({ at: centre, centre, n: 0 });
  });

  it('moves at least one cell on every grid size when snapping is on', () => {
    for (const grid of [8, 12, 16, 20, 24, 32, 40, 48]) {
      let x = snapTo(centre.x - 60, grid);
      for (let i = 0; i < 8; i++) {
        const next = snapTo(nextClick({ x, y: x, centre, n: i }, centre, size, 1000).at.x - 60, grid);
        expect(next, `grid ${grid}, step ${i}`).toBeGreaterThan(x);
        x = next;
      }
    }
  });
});

interface Placed { id: string; type: string; x: number; y: number; w: number; h: number }

/** Just enough of the board: a viewport, a store of placed objects and placeAt with a 24 px grid. */
function fakeApp(vp = { x: 150, y: 0, w: 500, h: 600 }, snap = true) {
  const objects = new Map<string, Placed>();
  let next = 0;
  const app = {
    r: { viewport: () => vp },
    store: { get: (id: string) => objects.get(id) },
    placeAt(type: string, p: { x: number; y: number }, w: number, h: number) {
      const o = { id: `o${next++}`, type, x: snap ? snapTo(p.x - w / 2, 24) : p.x - w / 2, y: snap ? snapTo(p.y - h / 2, 24) : p.y - h / 2, w, h };
      objects.set(o.id, o);
      return o;
    },
  };
  return { app: app as unknown as BoardApp, objects, vp };
}

describe('placeClicked', () => {
  it('fans out a run of clicks instead of stacking them', () => {
    const { app } = fakeApp();
    const spots = [0, 1, 2].map(() => placeClicked(app, 'icon', 120, 120));
    expect(spots.map((o) => [o.x, o.y])).toEqual([[336, 240], [360, 264], [384, 288]]);
  });

  it('works without snapping', () => {
    const { app } = fakeApp(undefined, false);
    const [a, b] = [placeClicked(app, 'icon', 120, 120), placeClicked(app, 'icon', 120, 120)];
    expect([b.x - a.x, b.y - a.y]).toEqual([24, 24]);
  });

  it('starts over at the centre after the last object is deleted (undo) or moved', () => {
    const { app, objects } = fakeApp();
    const first = placeClicked(app, 'icon', 120, 120);
    objects.delete(placeClicked(app, 'icon', 120, 120).id);
    expect(placeClicked(app, 'icon', 120, 120)).toMatchObject({ x: first.x, y: first.y });
    const last = placeClicked(app, 'icon', 120, 120);
    objects.get(last.id)!.x += 5;
    expect(placeClicked(app, 'icon', 120, 120)).toMatchObject({ x: first.x, y: first.y });
  });

  it('starts over at the new centre after the view moves a step or more', () => {
    const { app, vp } = fakeApp();
    placeClicked(app, 'icon', 120, 120);
    vp.x += 200;
    expect(placeClicked(app, 'icon', 120, 120)).toMatchObject({ x: 552, y: 240 });
  });

  it('keeps a run to a third of the shorter side of the view', () => {
    const { app } = fakeApp({ x: 0, y: 0, w: 500, h: 300 });
    const xs = Array.from({ length: 6 }, () => placeClicked(app, 'icon', 120, 120).x);
    expect(xs).toEqual([192, 216, 240, 264, 288, 192]);
  });

  it('keeps runs of different boards apart', () => {
    const a = fakeApp();
    const b = fakeApp();
    placeClicked(a.app, 'icon', 120, 120);
    expect(placeClicked(b.app, 'icon', 120, 120)).toMatchObject({ x: 336, y: 240 });
  });
});
