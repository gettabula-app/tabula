import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { Store } from '../src/store';
import type { BaseObj, Id, Obj } from '../src/types';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

type Harness = BoardApp & Record<string, unknown>;
const note = (id: Id, z: string, x: number): BaseObj => ({
  id, type: 'sticky', x, y: 20, w: 30, h: 30, rotation: 0, z, text: id, fill: '#FFF3A3',
});
const group = (id: Id, z: string, members: Id[], parent?: Id): Obj[] => [
  { id, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z, parent },
  ...members.map((member, i) => ({ ...note(member, `a${i + 1}`, i * 60), parent: id })),
];

let browser: FakeBrowser;
let handlers: Map<string, ((event: unknown) => void)[]>;

beforeEach(() => {
  browser = installFakeBrowser();
  handlers = new Map();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener() {},
    innerWidth: 1024,
    innerHeight: 768,
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => browser.uninstall());

function harness(store = new Store(new Y.Doc())) {
  const app = Object.create(BoardApp.prototype) as Harness;
  const hit = vi.fn<(...args: unknown[]) => Obj | undefined>(() => store.get('a'));
  const flow = { handleClick: vi.fn<(o: Obj) => boolean>((_o) => false), isHidden: () => false, isVoting: () => false, activeStep: () => null };
  const svg = browser.document.createElement('svg') as FakeElement & { setPointerCapture: (id: number) => void };
  svg.setPointerCapture = vi.fn<(id: number) => void>();
  const overlay = { anchorsFor: null, selection: [], enteredGroup: null, kanban: null };
  Object.assign(app, {
    store, selection: [], scope: null, tool: { kind: 'select' }, drag: null, longPress: null, kbMoving: null,
    listeners: new Map(), spaceDown: false, lastPointer: { x: 0, y: 0 }, pendingFrame: 0, queuedFn: null,
    lifetime: new AbortController(), user: { id: 'me', name: 'Me', color: 'blue' },
    conn: { awareness: { setLocalStateField() {} } }, flow,
    r: {
      cam: { x: 0, y: 0, zoom: 1 }, svg, root: { classList: { add() {}, remove() {} }, dataset: {}, append() {} },
      overlay, pins: [], setOverlay(patch: object) { Object.assign(overlay, patch); },
      clientToWorld: (x: number, y: number) => ({ x, y }),
    },
    editor: { active: false, commit() {}, start() {} },
    notify: vi.fn<(...args: unknown[]) => void>(), announce: vi.fn<(...args: unknown[]) => void>(), emit() {},
    closeThread: vi.fn<(...args: unknown[]) => void>(), setDraftPin: vi.fn<(...args: unknown[]) => void>(), setTool: vi.fn<(...args: unknown[]) => void>(),
    isPinching: () => false,
    hit,
    frameAt: () => undefined,
  });
  return { app, store, hit, flow };
}

const call = (app: Harness, name: string, ...args: unknown[]) => (app[name] as (...xs: unknown[]) => unknown).apply(app, args);
const key = (event: Partial<KeyboardEvent>) => ({
  key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: browser.document.body,
  preventDefault: vi.fn<() => void>(), ...event,
});
const keydown = (event: Partial<KeyboardEvent>) => handlers.get('keydown')?.forEach((fn) => fn(key(event)));
const objects = (store: Store) => [...store.cache.values()].map((o) => structuredClone(o)).sort((a, b) => a.id.localeCompare(b.id));
const sync = (a: Store, b: Store) => {
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
};

describe('group app commands and scope', () => {
  it('groups and ungroups from Ctrl/Cmd+G in one undo step each, restoring the exact document state', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => { store.create(note('a', 'a1', 10)); store.create(note('b', 'a8', 80)); });
    store.undo.clear();
    const before = objects(store);
    const { app } = harness(store);
    app.selection = ['a', 'b'];
    call(app, 'bindKeys');

    keydown({ key: 'g', code: 'KeyG', ctrlKey: true });
    const grouped = objects(store);
    const groupId = app.selection[0];
    expect(store.get(groupId)?.type).toBe('group');
    expect((app.announce as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('Grouped 2 items');
    expect(store.undo.undoStack).toHaveLength(1);

    keydown({ key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(store.get(groupId)).toBeUndefined();
    expect(store.get('a')?.parent).toBeUndefined();
    expect(store.get('b')?.parent).toBeUndefined();
    expect(store.undo.undoStack).toHaveLength(2);

    store.undo.undo();
    expect(objects(store)).toEqual(grouped);
    store.undo.undo();
    expect(objects(store)).toEqual(before);
  });

  it('click selects the group, double-click enters it, and Escape leaves to the parent level', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => group('g', 'a1', ['a', 'b']).forEach((o) => store.create(o)));
    const { app, hit } = harness(store);
    hit.mockImplementation(() => store.get('a'));
    call(app, 'bindKeys');

    const p = { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} };
    call(app, 'onDown', p);
    expect(app.selection).toEqual(['g']);
    expect(app.scope).toBeNull();

    call(app, 'onDblClick', { clientX: 10, clientY: 10 });
    expect(app.scope).toBe('g');
    expect(app.selection).toEqual(['a']);

    keydown({ key: 'Escape', code: 'Escape' });
    expect(app.scope).toBeNull();
    expect(app.selection).toEqual(['g']);

    call(app, 'enterGroup', 'g');
    hit.mockReturnValue(undefined);
    const emptyClick = { clientX: 400, clientY: 400, pointerId: 2, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} };
    call(app, 'onDown', emptyClick);
    call(app, 'onUp', emptyClick);
    expect(app.scope).toBeNull();
    expect(app.selection).toEqual(['g']);
  });

  it('keeps dot-vote clicks on the hit member rather than lifting them to its group', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => group('g', 'a1', ['a', 'b']).forEach((o) => store.create(o)));
    const { app, hit, flow } = harness(store);
    hit.mockImplementation(() => store.get('a'));
    flow.handleClick.mockReturnValue(true);
    call(app, 'onDown', { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} });
    expect(flow.handleClick.mock.calls[0][0]?.id).toBe('a');
    expect(app.selection).toEqual([]);
  });

  it('leaves to the nearest parent scope when selecting a sibling outside the entered group', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'outer' });
      store.create({ ...note('leaf', 'a1', 10), parent: 'inner' });
      store.create({ ...note('sibling', 'a3', 80), parent: 'outer' });
    });
    const { app } = harness(store);
    app.enterGroup('outer');
    app.enterGroup('inner');
    app.setSelection(['sibling']);
    expect(app.scope).toBe('outer');
    expect(app.selection).toEqual(['sibling']);
  });
});

describe('group operations across two Y.Docs', () => {
  it('merges grouping against deleting a member', () => {
    const left = new Store(new Y.Doc()), right = new Store(new Y.Doc());
    left.transact(() => { left.create(note('a', 'a1', 10)); left.create(note('b', 'a8', 80)); });
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc));
    const { app } = harness(left);
    app.selection = ['a', 'b'];
    expect(app.groupSelection()).toBe(true);
    right.transact(() => right.remove(['b']));
    sync(left, right);
    const groupId = app.selection[0];
    for (const store of [left, right]) {
      expect(store.get('b')).toBeUndefined();
      expect(store.childrenOf(groupId).map((o) => o.id)).toEqual(['a']);
    }
  });

  it('merges ungrouping against moving a member', () => {
    const left = new Store(new Y.Doc()), right = new Store(new Y.Doc());
    left.transact(() => group('g', 'a4', ['a', 'b']).forEach((o) => left.create(o)));
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc));
    const { app } = harness(left);
    app.selection = ['g'];
    expect(app.ungroupSelection()).toBe(true);
    right.transact(() => right.update('a', { x: 222 }));
    sync(left, right);
    for (const store of [left, right]) {
      expect(store.get('g')).toBeUndefined();
      expect(store.get('a')?.x).toBe(222);
      expect(store.get('a')?.parent).toBeUndefined();
    }
  });
});
