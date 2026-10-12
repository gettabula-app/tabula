import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';

const frame = (id: string, z: string, x: number, w = 300): BaseObj => ({ id, type: 'frame', x, y: 0, w, h: 400, rotation: 0, z, name: id });

function board(zs: [string, string][]) {
  const store = new Store(new Y.Doc());
  store.transact(() => zs.forEach(([id, z], i) => store.create(frame(id, z, i * 320))));
  return store;
}

const order = (store: Store) => store.ordered().map((o) => o.id);

describe('a new frame\'s key (a frame drawn inside a template column)', () => {
  const template: [string, string][] = [['a', 'a2'], ['b', 'a3'], ['c', 'a5'], ['d', 'a7'], ['e', 'a9']];

  it('paints above the frame it is drawn inside, not under it', () => {
    const store = board(template);
    const rect = { x: 340, y: 100, w: 260, h: 200 }; // inside frame b (x 320..620)
    const z = store.frameZFor(rect);
    expect(z > 'a3' && z < 'a5').toBe(true);
    store.transact(() => store.create({ ...frame('new', z, 340, 260), y: 100, h: 200 }));
    expect(order(store).indexOf('new')).toBe(order(store).indexOf('b') + 1);
  });

  it('is last when drawn inside the topmost frame, and sorts correctly past a9 and into the next digit', () => {
    const store = board(template);
    let z = store.frameZFor({ x: 4 * 320 + 10, y: 10, w: 100, h: 100 });
    expect(z > 'a9').toBe(true);
    store.transact(() => store.create({ ...frame('n1', z, 4 * 320 + 10, 100), y: 10, h: 100 }));
    z = store.frameZFor({ x: 4 * 320 + 20, y: 20, w: 50, h: 50 }); // inside n1 and e
    store.transact(() => store.create({ ...frame('n2', z, 4 * 320 + 20, 50), y: 20, h: 50 }));
    expect(order(store).slice(-3)).toEqual(['e', 'n1', 'n2']);
  });

  it('goes to the back on empty canvas, whichever case the keys are in', () => {
    const store = board([['a', 'a2'], ['m', 'Zz'], ['b', 'a5']]);
    const z = store.frameZFor({ x: 5000, y: 5000, w: 100, h: 100 });
    expect(z < 'Zz').toBe(true);
    // the mixed-case board still orders as it did: uppercase keys sort below lowercase ones
    expect(order(store)).toEqual(['m', 'a', 'b']);
  });

  it('a frame drawn around others stays behind them', () => {
    const store = board(template);
    const z = store.frameZFor({ x: -10, y: -10, w: 2000, h: 500 });
    expect(z < 'a2').toBe(true);
  });
});
