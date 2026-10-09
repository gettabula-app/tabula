import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { LOCAL, Store } from '../src/store';
import type { BaseObj, Id, Obj } from '../src/types';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

type Harness = BoardApp & Record<string, unknown>;

const note = (id: Id, z: string): BaseObj => ({
  id, type: 'sticky', x: 10, y: 20, w: 30, h: 30, rotation: 0, z, text: id, fill: '#FFF3A3',
});
const group = (id: Id, z: string, parent?: Id): Obj => ({
  id, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z, parent,
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
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => browser.uninstall());

function harness(store: Store): Harness {
  const app = Object.create(BoardApp.prototype) as Harness;
  const svg = browser.document.createElement('svg') as FakeElement & { setPointerCapture: (id: number) => void };
  svg.setPointerCapture = vi.fn<(id: number) => void>();
  const overlay = { anchorsFor: null, selection: [], enteredGroup: null, kanban: null };
  Object.assign(app, {
    store, selection: [], scope: null, tool: { kind: 'select' }, drag: null, longPress: null, kbMoving: null,
    listeners: new Map(), spaceDown: false, lastPointer: { x: 0, y: 0 }, pendingFrame: 0, queuedFn: null,
    lifetime: new AbortController(), user: { id: 'me', name: 'Me', color: 'blue' }, clipboard: [],
    conn: { awareness: { setLocalStateField() {} } },
    flow: { isHidden: () => false, isVoting: () => false, activeStep: () => null },
    r: {
      cam: { x: 0, y: 0, zoom: 1 }, svg, root: { classList: { add() {}, remove() {} }, dataset: {}, append() {} },
      overlay, pins: [], setOverlay(patch: object) { Object.assign(overlay, patch); },
      clientToWorld: (x: number, y: number) => ({ x, y }),
    },
    editor: { active: false, commit() {}, start() {} },
    notify() {}, announce() {}, emit() {}, closeThread() {}, setDraftPin() {}, setTool() {},
    isPinching: () => false,
  });
  return app;
}

function bindKeys(app: Harness) {
  (app as unknown as { bindKeys: () => void }).bindKeys();
}

function keydown(event: Partial<KeyboardEvent>) {
  const e = {
    key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: browser.document.body,
    preventDefault: vi.fn<() => void>(), ...event,
  };
  handlers.get('keydown')?.forEach((fn) => fn(e));
}

function objects(store: Store): Obj[] {
  return [...store.cache.values()].map((o) => structuredClone(o)).sort((a, b) => a.id.localeCompare(b.id));
}

function sync(a: Store, b: Store) {
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
}

function groupSelection(store: Store, id: Id, members: readonly Id[]) {
  store.transact(() => {
    store.create(group(id, 'a0'));
    members.forEach((member) => store.update(member, { parent: id }));
  });
}

describe('group deletion and empty-group cleanup', () => {
  it('deletes the last member and its empty group in the same undoable transaction, keeping one-member groups', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(group('g', 'a0'));
      store.create({ ...note('a', 'a1'), parent: 'g' });
      store.create({ ...note('b', 'a2'), parent: 'g' });
    });
    store.undo.clear();

    store.transact(() => store.remove(['a']));
    expect(store.get('g')).toBeDefined();
    expect(store.childrenOf('g').map((o) => o.id)).toEqual(['b']);

    store.undo.clear();
    const localUpdates: unknown[] = [];
    store.doc.on('update', (_update, origin, _doc, transaction) => {
      if (origin === LOCAL) localUpdates.push(transaction);
    });
    store.transact(() => store.remove(['b']));

    expect(store.get('b')).toBeUndefined();
    expect(store.get('g')).toBeUndefined();
    expect(localUpdates).toHaveLength(1);
    expect(store.undo.undoStack).toHaveLength(1);
    store.undo.undo();
    expect(objects(store)).toEqual([{ ...note('b', 'a2'), parent: 'g' }, group('g', 'a0')].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it.each([
    ['Delete', { key: 'Delete', code: 'Delete' }],
    ['Cut', { key: 'x', code: 'KeyX', ctrlKey: true }],
  ] as const)('%s removes a nested group subtree in one undo step', (_name, key) => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(group('outer', 'a0'));
      store.create(group('inner', 'a1', 'outer'));
      store.create({ ...note('a', 'a2'), parent: 'inner' });
      store.create({ ...note('b', 'a3'), parent: 'outer' });
    });
    store.undo.clear();
    const before = objects(store);
    const app = harness(store);
    app.selection = ['outer'];
    bindKeys(app);
    keydown(key);

    expect(objects(store)).toEqual([]);
    expect(store.undo.undoStack).toHaveLength(1);
    const expectedClipboard = key.key === 'x' ? ['outer', 'inner', 'a', 'b'] : [];
    expect(new Set((app['clipboard'] as Obj[]).map((o) => o.id))).toEqual(new Set(expectedClipboard));
    store.undo.undo();
    expect(objects(store)).toEqual(before);
  });

  it.each([
    ['identical selections', 'left', ['a', 'b'], 'right', ['a', 'b']],
    ['a subset selection', 'left', ['a', 'b'], 'right', ['a']],
    ['a superset selection', 'right', ['a', 'b'], 'left', ['a']],
  ] as const)('cleans the losing group after concurrent grouping with %s', (_name, winnerSide, winnerMembers, loserSide, loserMembers) => {
    const left = new Store(new Y.Doc());
    const right = new Store(new Y.Doc());
    left.transact(() => {
      left.create(note('a', 'a1'));
      left.create(note('b', 'a2'));
    });
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc));

    // Yjs resolves concurrent writes to the same map key in favour of the greater client id.
    const winner = winnerSide === 'left' ? left : right;
    const loser = loserSide === 'left' ? left : right;
    winner.doc.clientID = 0xFFFFFFF0;
    loser.doc.clientID = 0xFFFFFF00;
    groupSelection(winner, 'winner-group', winnerMembers);
    groupSelection(loser, 'loser-group', loserMembers);

    sync(left, right);
    sync(left, right);
    for (const store of [left, right]) {
      expect(store.get('winner-group')).toBeDefined();
      expect(store.get('loser-group')).toBeUndefined();
      expect(store.childrenOf('winner-group').map((o) => o.id).sort()).toEqual(['a', 'b']);
      expect([...store.cache.values()].filter((o) => o.type === 'group').every((g) => store.childrenOf(g.id).length > 0)).toBe(true);
    }
  });
});
