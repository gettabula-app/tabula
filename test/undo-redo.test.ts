import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { Store } from '../src/store';
import type { BaseObj, Id, Label } from '../src/types';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

type Harness = BoardApp & Record<string, unknown>;
type KeyEvent = Partial<KeyboardEvent> & { preventDefault: () => void };
const note = (id: Id, z: string, x: number): BaseObj => ({
  id, type: 'sticky', x, y: 20, w: 30, h: 30, rotation: 0, z, text: id, fill: '#FFF3A3',
});

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
});

afterEach(() => browser.uninstall());

function harness(store: Store) {
  const app = Object.create(BoardApp.prototype) as Harness;
  const svg = browser.document.createElement('svg') as FakeElement;
  const overlay = { anchorsFor: null, selection: [], enteredGroup: null, kanban: null };
  Object.assign(app, {
    store, selection: [], scope: null, tool: { kind: 'select' }, drag: null, longPress: null, kbMoving: null,
    listeners: new Map(), spaceDown: false, lastPointer: { x: 0, y: 0 }, pendingFrame: 0, queuedFn: null,
    lifetime: new AbortController(), user: { id: 'me', name: 'Me', color: 'blue' },
    conn: { awareness: { setLocalStateField() {} } },
    flow: { isHidden: () => false, isVoting: () => false, activeStep: () => null, handleClick: () => false },
    r: {
      cam: { x: 0, y: 0, zoom: 1 }, svg, root: { classList: { add() {}, remove() {} }, dataset: {}, append() {} },
      overlay, pins: [], setOverlay(patch: object) { Object.assign(overlay, patch); },
      clientToWorld: (x: number, y: number) => ({ x, y }),
    },
    editor: { active: false, commit() {}, start() {} },
    notify: vi.fn<(message: string) => void>(), announce: vi.fn<(message: string) => void>(), emit() {},
    closeThread: vi.fn<(...args: unknown[]) => void>(), setDraftPin: vi.fn<(...args: unknown[]) => void>(), setTool: vi.fn<(...args: unknown[]) => void>(),
    isPinching: () => false,
    frameAt: () => undefined,
  });

  // Use the same handler the BoardApp constructor registers, while keeping this test harness lightweight like groups-app.test.ts.
  const history = app as unknown as { handleUndoStackPopped: (type: 'undo' | 'redo') => void };
  store.undo.on('stack-item-popped', (event) => history.handleUndoStackPopped.call(app, event.type));
  (app as unknown as { bindKeys: () => void }).bindKeys.call(app);
  return app;
}

const key = (event: Partial<KeyboardEvent> = {}): KeyEvent => ({
  key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  target: browser.document.body as unknown as EventTarget,
  preventDefault: vi.fn<() => void>(), ...event,
});
const keydown = (event: Partial<KeyboardEvent>) => {
  const value = key(event);
  handlers.get('keydown')?.forEach((fn) => fn(value));
};

function plainBoard() {
  const store = new Store(new Y.Doc());
  store.transact(() => store.create(note('sticky', 'a1', 10)));
  store.undo.clear();
  const app = harness(store);
  app.selection = ['sticky'];
  for (const text of ['first', 'second', 'third']) {
    store.undo.stopCapturing();
    store.transact(() => store.update('sticky', { text }));
  }
  return { store, app };
}

const plainSteps = [
  { action: 'undo', text: 'second', undo: 2, redo: 1 },
  { action: 'undo', text: 'first', undo: 1, redo: 2 },
  { action: 'redo', text: 'second', undo: 2, redo: 1 },
  { action: 'undo', text: 'first', undo: 1, redo: 2 },
  { action: 'redo', text: 'second', undo: 2, redo: 1 },
  { action: 'redo', text: 'third', undo: 3, redo: 0 },
] as const;

function expectPlainState(store: Store, step: (typeof plainSteps)[number]) {
  expect(store.undo.undoStack).toHaveLength(step.undo);
  expect(store.undo.redoStack).toHaveLength(step.redo);
  expect((store.get('sticky') as BaseObj | undefined)?.text).toBe(step.text);
}

describe('undo and redo', () => {
  it('moves one stack item per direct UndoManager call on a plain board', () => {
    const { store, app } = plainBoard();
    expect(store.undo.undoStack).toHaveLength(3);
    expect(store.undo.redoStack).toHaveLength(0);

    for (const step of plainSteps) {
      expect(() => step.action === 'undo' ? store.undo.undo() : store.undo.redo()).not.toThrow();
      expectPlainState(store, step);
      expect(app.scope).toBeNull();
      expect(app.selection).toEqual(['sticky']);
    }
    expect((app.announce as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message))
      .toEqual(['Undone', 'Undone', 'Redone', 'Undone', 'Redone', 'Redone']);
  });

  it('moves one stack item per app keyboard shortcut on a plain board', () => {
    const { store, app } = plainBoard();
    expect(store.undo.undoStack).toHaveLength(3);

    for (const step of plainSteps) {
      expect(() => keydown({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: step.action === 'redo' })).not.toThrow();
      expectPlainState(store, step);
      expect(app.scope).toBeNull();
      expect(app.selection).toEqual(['sticky']);
    }
  });

  it('selects top-level ancestors as group membership changes across undo and redo', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(note('a', 'a1', 10));
      store.create(note('b', 'a4', 70));
      store.create(note('c', 'a8', 130));
    });
    store.undo.stopCapturing();
    const app = harness(store);
    app.selection = ['a', 'b', 'c'];

    keydown({ key: 'g', code: 'KeyG', ctrlKey: true });
    const groupId = app.selection[0];
    expect(store.get(groupId)?.type).toBe('group');
    expect(store.undo.undoStack).toHaveLength(2);
    for (const id of ['a', 'b', 'c']) expect(store.get(id)?.parent).toBe(groupId);

    store.undo.stopCapturing();
    store.transact(() => store.update('a', { text: 'edited' }));
    expect(store.undo.undoStack).toHaveLength(3);
    expect(store.undo.redoStack).toHaveLength(0);

    const expectStacks = (undo: number, redo: number) => {
      expect(store.undo.undoStack).toHaveLength(undo);
      expect(store.undo.redoStack).toHaveLength(redo);
    };
    const expectSelection = (ids: string[]) => {
      expect(app.scope).toBeNull();
      expect(new Set(app.selection)).toEqual(new Set(ids));
    };
    const expectUngrouped = () => {
      expect(store.get(groupId)).toBeUndefined();
      for (const id of ['a', 'b', 'c']) expect(store.get(id)?.parent).toBeUndefined();
    };
    const expectGrouped = () => {
      expect(store.get(groupId)?.type).toBe('group');
      for (const id of ['a', 'b', 'c']) expect(store.get(id)?.parent).toBe(groupId);
    };

    expect(() => store.undo.undo()).not.toThrow();
    expect((store.get('a') as BaseObj | undefined)?.text).toBe('a');
    expectGrouped();
    expectStacks(2, 1);
    expectSelection([groupId]);

    expect(() => store.undo.undo()).not.toThrow();
    expectUngrouped();
    expectStacks(1, 2);
    expectSelection(['a', 'b', 'c']);

    expect(() => store.undo.undo()).not.toThrow();
    for (const id of ['a', 'b', 'c']) expect(store.get(id)).toBeUndefined();
    expectStacks(0, 3);
    expectSelection([]);

    expect(() => store.undo.redo()).not.toThrow();
    expectUngrouped();
    for (const id of ['a', 'b', 'c']) expect((store.get(id) as BaseObj | undefined)?.text).toBe(id);
    expectStacks(1, 2);
    expectSelection(['a', 'b', 'c']);

    expect(() => store.undo.redo()).not.toThrow();
    expectGrouped();
    expectStacks(2, 1);
    expectSelection([groupId]);

    expect(() => store.undo.redo()).not.toThrow();
    expectGrouped();
    expect((store.get('a') as BaseObj | undefined)?.text).toBe('edited');
    expectStacks(3, 0);
    expectSelection([groupId]);
  });

  it('collects ids changed inside nested object maps during the observer phase', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => store.create(note('sticky', 'a1', 10)));
    store.undo.clear();
    const app = harness(store);
    const details = new Y.Map<unknown>();
    store.transact(() => {
      details.set('value', 'before');
      store.objects.get('sticky')!.set('details', details);
    });
    store.undo.stopCapturing();
    store.transact(() => details.set('value', 'after'));
    app.selection = [];

    expect(() => store.undo.undo()).not.toThrow();
    expect(details.get('value')).toBe('before');
    expect(app.selection).toEqual(['sticky']);
    expect(store.takeUndoChanged()).toEqual(new Set());
  });

  it('keeps meta-only and labels-only undo steps free of stale object ids', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => store.create(note('sticky', 'a1', 10)));
    store.undo.clear();
    const app = harness(store);
    app.selection = ['sticky'];

    store.transact(() => store.update('sticky', { text: 'edited' }));
    expect(() => store.undo.undo()).not.toThrow();
    expect(app.selection).toEqual(['sticky']);

    app.setSelection(['sticky']);
    store.setMeta({ name: 'Planning' });
    expect(() => store.undo.undo()).not.toThrow();
    expect(store.getMeta().name).toBe('Untitled board');
    expect(app.selection).toEqual([]);
    expect(store.undo.undoStack).toHaveLength(0);
    expect(store.undo.redoStack).toHaveLength(1);

    app.setSelection(['sticky']);
    const label: Label = { id: 'team', name: 'Team', color: 'red', order: 0 };
    store.transact(() => store.labels.set(label.id, label));
    expect(() => store.undo.undo()).not.toThrow();
    expect(store.labels.has(label.id)).toBe(false);
    expect(app.selection).toEqual([]);
    expect(store.undo.undoStack).toHaveLength(0);
    expect(store.undo.redoStack).toHaveLength(1);
  });

  it('shows why the old stack-item handler throws after Yjs ends the event phase', () => {
    // A bare document with no Store observer: the Store now reads `changes` inside its own observer (card height repair), which
    // Yjs caches, so only an observer-free document shows what the old handler hit.
    const doc = new Y.Doc();
    const objects = doc.getMap<Y.Map<unknown>>('objects');
    const manager = new Y.UndoManager([objects], { captureTimeout: 0 });
    doc.transact(() => objects.set('sticky', new Y.Map([['text', 'a1']])));
    manager.clear();
    doc.transact(() => objects.get('sticky')!.set('text', 'edited'));

    // This is the old app handler's changedParentTypes walk, kept as a characterization of the Yjs failure.
    manager.on('stack-item-popped', (event: {
      type: 'undo' | 'redo';
      changedParentTypes?: Map<unknown, Array<{ path?: (string | number)[]; changes?: { keys?: Map<string, unknown> } }>>;
    }) => {
      const changed = new Set<string>();
      for (const [type, events] of event.changedParentTypes ?? []) {
        for (const item of events) {
          if (type === objects) {
            for (const id of item.changes?.keys?.keys() ?? []) changed.add(id);
          } else if (item.path?.length) changed.add(String(item.path[0]));
        }
      }
    });

    expect(() => manager.undo()).toThrow('You must not compute changes after the event-handler fired.');
  });
});
