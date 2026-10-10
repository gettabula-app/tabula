import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { remapObjects } from '../src/custom-templates';
import { boxBounds, center, unionRects } from '../src/geometry';
import { gatherCopyObjects } from '../src/private-select';
import { Store } from '../src/store';
import { mirrorPoint } from '../src/flip';
import type { BaseObj, ConnectorObj, Id, Obj, Rect } from '../src/types';

type AppHarness = BoardApp & Record<string, unknown>;

const shape = (id: Id, x: number, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'shape', kind: 'rect', x, y: 20, w: 80, h: 50, rotation: 0, z: `a${id}`, ...extra,
});

const line = (id: Id, from: ConnectorObj['from'], to: ConnectorObj['to']): ConnectorObj => ({
  id, type: 'connector', z: `z${id}`, route: 'elbow', startHead: 'none', endHead: 'arrow', from, to,
});

function harness(objects: Obj[], selection: Id[]) {
  const store = new Store(new Y.Doc());
  store.transact(() => objects.forEach((o) => store.create(o)));
  store.undo.clear();
  const app = Object.create(BoardApp.prototype) as AppHarness;
  const flow = { isHidden: () => false };
  const bounds = (ids: Iterable<Id>): Rect | null => {
    const rects = [...ids].flatMap((id) => {
      const o = store.getPlaced(id);
      if (!o || o.type === 'connector') return [];
      return [o.type === 'group' ? store.geometry(o) : boxBounds(o)];
    });
    return unionRects(rects);
  };
  Object.assign(app, {
    store, selection, scope: null, flow, r: { contentBounds: bounds },
    notify: vi.fn<(message: string) => void>(), announce: vi.fn<(message: string) => void>(),
  });
  return { app, store };
}

const flipFields = (o: Obj) => ({ x: (o as BaseObj).x, y: (o as BaseObj).y, rotation: (o as BaseObj).rotation, flipX: (o as BaseObj).flipX, flipY: (o as BaseObj).flipY });

describe('BoardApp flip command', () => {
  it('writes one undo step and restores x, y, rotation and flags exactly', () => {
    const original = [
      shape('a', 0, { rotation: 0.4, flipX: false }),
      shape('b', 180, { y: 70, rotation: -0.2 }),
    ];
    const { app, store } = harness(original, ['a', 'b']);
    const before = new Map(original.map((o) => [o.id, flipFields(o)]));
    expect(app.flipSelection('horizontal')).toBe(true);
    expect(store.undo.undoStack).toHaveLength(1);
    expect(app.announce).toHaveBeenCalledWith('Flipped horizontally');
    expect(store.get('a')).toMatchObject({ flipX: true, rotation: -0.4 });
    store.undo.undo();
    for (const id of ['a', 'b']) expect(flipFields(store.get(id)!)).toEqual(before.get(id));
  });

  it.each([
    ['sticky', { id: 'note', type: 'sticky', x: 0, y: 0, w: 50, h: 50, rotation: 0, z: 'a0', text: 'note' } as BaseObj],
    ['text', { id: 'text', type: 'text', x: 0, y: 0, w: 50, h: 50, rotation: 0, z: 'a0', text: 'text' } as BaseObj],
  ])('disables a lone %s with the stated reason and shortcut toast', (_name, object) => {
    const { app, store } = harness([object], [object.id]);
    expect(app.flipReason('horizontal')).toBe("Notes and text can't be flipped");
    expect(app.flipSelection('horizontal')).toBe(false);
    expect(store.get(object.id)).toEqual(object);
    expect(app.notify).toHaveBeenCalledWith("Notes and text can't be flipped");
  });

  it('disables a selection containing a frame', () => {
    const frame: BaseObj = { id: 'frame', type: 'frame', x: 0, y: 0, w: 100, h: 80, rotation: 0, z: 'a0', name: 'Frame' };
    const { app } = harness([frame, shape('shape', 150)], ['frame', 'shape']);
    expect(app.flipReason('vertical')).toMatch(/frames, containers, lanes and cards/i);
  });

  it('keeps flip flags in JSON clipboard copies and the duplicate/paste remap path', () => {
    const original = shape('source', 0, { flipX: true, flipY: false });
    const { app, store } = harness([original], ['source']);
    const clipboard = JSON.parse(JSON.stringify({ driftboard: 1, objects: gatherCopyObjects(store, app.flow, ['source']) })) as { objects: Obj[] };
    expect(clipboard.objects[0]).toMatchObject({ flipX: true, flipY: false });
    const duplicate = remapObjects(clipboard.objects, new Map([['source', 'copy']]), { x: 24, y: 24 }, () => null);
    expect(duplicate[0]).toMatchObject({ id: 'copy', flipX: true, flipY: false });
  });

  it('ignores nonboolean flags at the Store boundary', () => {
    const store = new Store(new Y.Doc());
    store.create({ ...shape('bad', 0), flipX: 'true' } as unknown as BaseObj);
    expect(store.get('bad')).not.toHaveProperty('flipX');
    store.create(shape('good', 100));
    store.update('good', { flipY: 1 });
    expect(store.get('good')).not.toHaveProperty('flipY');
  });

  it('mirrors group leaves about the group bounds and leaves sticky text readable', () => {
    const objects: Obj[] = [
      { id: 'group', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a0' },
      { ...shape('shape', 20, { parent: 'group', rotation: 0.3 }) },
      { id: 'note', type: 'sticky', x: 160, y: 20, w: 60, h: 50, rotation: -0.2, z: 'a3', parent: 'group', text: 'readable' },
    ];
    const { app, store } = harness(objects, ['group']);
    const about = center(store.geometry(store.get('group')!));
    const oldShapeCenter = center(store.get('shape') as BaseObj);
    const oldNoteCenter = center(store.get('note') as BaseObj);
    const expectedShapeCenter = mirrorPoint(oldShapeCenter, 'horizontal', about);
    const expectedNoteCenter = mirrorPoint(oldNoteCenter, 'horizontal', about);
    expect(app.flipSelection('horizontal')).toBe(true);
    expect(store.get('shape')).toMatchObject({ x: expectedShapeCenter.x - 40, rotation: -0.3, flipX: true });
    expect(store.get('note')).toMatchObject({ x: expectedNoteCenter.x - 30, rotation: 0.2 });
    expect(store.get('note')).not.toHaveProperty('flipX');
  });

  it('swaps attached anchor sides only when both endpoint objects are selected', () => {
    const a = shape('a', 0), b = shape('b', 200);
    const c = line('c', { kind: 'bound', id: 'a', anchor: 'left' }, { kind: 'bound', id: 'b', anchor: 'right' });
    const { app, store } = harness([a, b, c], ['a', 'b']);
    app.flipSelection('horizontal');
    expect(store.get('c')).toMatchObject({
      from: { kind: 'bound', id: 'a', anchor: 'right' }, to: { kind: 'bound', id: 'b', anchor: 'left' },
    });
  });

  it('does not write a connector for a single-object flip', () => {
    const a = shape('a', 0);
    const c = line('c', { kind: 'bound', id: 'a', anchor: 'left' }, { kind: 'free', x: 200, y: 45 });
    const { app, store } = harness([a, c], ['a']);
    const before = structuredClone(store.get('c'));
    app.flipSelection('horizontal');
    expect(store.get('c')).toEqual(before);
  });

  it('skips locked objects and leaves the read-only board untouched', () => {
    const unlocked = shape('unlocked', 0);
    const locked = shape('locked', 180, { locked: true });
    const { app, store } = harness([unlocked, locked], ['unlocked', 'locked']);
    app.flipSelection('horizontal');
    expect((store.get('unlocked') as BaseObj).flipX).toBe(true);
    expect(flipFields(store.get('locked')!)).toEqual(flipFields(locked));

    store.setReadOnly(true);
    const before = structuredClone(store.get('unlocked'));
    expect(app.flipSelection('vertical')).toBe(false);
    expect(store.get('unlocked')).toEqual(before);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('flip keyboard shortcuts', () => {
  it('routes Shift+H and Shift+V to flips without changing the tool; plain h and v still select tools', () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    vi.stubGlobal('window', { addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => handlers.set(type, fn) });
    vi.stubGlobal('document', { querySelector: () => null });
    const store = new Store(new Y.Doc());
    const app = Object.create(BoardApp.prototype) as AppHarness;
    const flip = vi.fn<(axis: 'horizontal' | 'vertical') => boolean>();
    const setTool = vi.fn<(tool: { kind: string }) => void>();
    Object.assign(app, { store, lifetime: new AbortController(), drag: null, longPress: null, scope: null, flipSelection: flip, setTool });
    (app as unknown as { bindKeys: () => void }).bindKeys();
    const press = (key: string, shiftKey = false) => handlers.get('keydown')!({
      key, code: `Key${key.toUpperCase()}`, shiftKey, altKey: false, ctrlKey: false, metaKey: false, target: null,
      defaultPrevented: false, preventDefault: vi.fn<() => void>(), stopImmediatePropagation: vi.fn<() => void>(),
    });

    press('H', true);
    press('V', true);
    expect(flip.mock.calls).toEqual([['horizontal'], ['vertical']]);
    expect(setTool).not.toHaveBeenCalled();
    press('h');
    press('v');
    expect(setTool.mock.calls).toEqual([[{ kind: 'hand' }], [{ kind: 'select' }]]);
  });
});
