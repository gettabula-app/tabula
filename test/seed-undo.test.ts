import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { applyImported } from '../src/exporters';
import { fitCamera, PHONE_FIT_MARGIN, RAIL_RIGHT_EDGE } from '../src/render';

const note = (id: string, text: string) => ({ id, type: 'sticky', x: 0, y: 0, w: 200, h: 200, z: id, rotation: 0, text, updatedAt: 1 }) as never;

describe('seeding a board is not an undo step', () => {
  it('leaves a seeded board intact when Undo runs, while a person\'s edit is still undoable', () => {
    const store = new Store(new Y.Doc());
    store.seed(() => {
      store.create(note('a', 'Seeded one'));
      store.create(note('b', 'Seeded two'));
    });
    expect(store.undo.undoStack).toHaveLength(0);
    store.undo.undo();
    expect([...store.cache.keys()].sort()).toEqual(['a', 'b']);

    store.transact(() => { store.create(note('c', 'Mine')); });
    store.undo.stopCapturing();
    expect(store.undo.undoStack).toHaveLength(1);
    store.undo.undo();
    expect([...store.cache.keys()].sort()).toEqual(['a', 'b']);
  });

  it('shows why: the same writes through transact empty the board on Undo', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => { store.create(note('a', 'Written like a person')); });
    store.undo.undo();
    expect(store.cache.size).toBe(0);
  });

  it('does not seed a read-only store', () => {
    const store = new Store(new Y.Doc());
    store.setReadOnly(true);
    store.seed(() => { store.create(note('a', 'x')); });
    expect(store.cache.size).toBe(0);
  });
});

describe('an imported board', () => {
  it('is not an undo step either', () => {
    const doc = new Y.Doc();
    const store = new Store(doc);
    const json = { format: 'driftboard', schemaVersion: 1, meta: { name: 'Imported' }, objects: [note('a', 'From a file'), note('b', 'Also')], flow: {} };
    applyImported({ doc, store, comments: {} as never }, { json, assets: undefined } as never, null);
    expect(store.cache.size).toBe(2);
    store.undo.undo();
    expect(store.cache.size).toBe(2);
  });
});

describe('first view on a phone', () => {
  const phone = { w: 390, h: 844 };
  const insets = { top: 64, right: 16, bottom: 72, left: 80 };
  const content = { x: 0, y: 0, w: 900, h: 700 };

  it('keeps wide content between the tool rail and the right edge with a 16 px margin', () => {
    const cam = fitCamera(phone, { ...insets, left: RAIL_RIGHT_EDGE, right: 0 }, content, PHONE_FIT_MARGIN, 1);
    const left = (content.x - cam.x) * cam.zoom;
    const right = (content.x + content.w - cam.x) * cam.zoom;
    expect(left).toBeGreaterThanOrEqual(RAIL_RIGHT_EDGE + PHONE_FIT_MARGIN - 0.5);
    expect(right).toBeLessThanOrEqual(phone.w - PHONE_FIT_MARGIN + 0.5);
    expect(cam.zoom).toBeCloseTo((phone.w - RAIL_RIGHT_EDGE - 2 * PHONE_FIT_MARGIN) / content.w, 5);
  });

  it('the old 120 px breathing room left almost no width on a phone', () => {
    const old = fitCamera(phone, insets, content, 120, 1);
    expect(old.zoom).toBeLessThan(0.1);
  });

  it('does not zoom in past 100% for small content', () => {
    const cam = fitCamera(phone, { ...insets, left: RAIL_RIGHT_EDGE, right: 0 }, { x: 0, y: 0, w: 100, h: 100 }, PHONE_FIT_MARGIN, 1);
    expect(cam.zoom).toBe(1);
  });
});
