import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { needsCardHeightHeal } from '../src/card-height-heal';
import { addCard, newKanban } from '../src/containers';
import { cardContentHeight } from '../src/markup';
import { LOCAL, Store } from '../src/store';
import type { BaseObj, Id } from '../src/types';
import { KANBAN } from '../shared/containers';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';

let browser: FakeBrowser;
let frames: FrameRequestCallback[];
let nextFrameId: number;
const stops: (() => void)[] = [];

beforeEach(() => {
  browser = installFakeBrowser();
  browser.mount().setAttribute('data-app-root', 'board');
  frames = [];
  nextFrameId = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn);
    return ++nextFrameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    if (id > 0) frames.splice(id - 1, 1);
  });
});

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  browser.uninstall();
});

function frame() {
  const next = frames.shift();
  expect(next, 'a scheduled frame').toBeDefined();
  next?.(0);
}

type HealApp = {
  store: Store;
  role: 'owner' | 'editor' | 'commenter' | 'viewer' | null;
  drag: unknown;
  editor: { active: boolean };
  cardInput: { active: Id | null };
  disposers: (() => void)[];
  flow: { isHidden: (card: BaseObj) => boolean };
  user: { id: string };
};

/** Installs the same BoardApp watcher the constructor uses, over the fake browser and a real Yjs Store. */
function appWatcher(store: Store, role: 'owner' | 'editor' | 'commenter' | 'viewer' | null = 'editor') {
  const app = Object.assign(Object.create(BoardApp.prototype) as HealApp, {
    store, role, drag: null, editor: { active: false }, cardInput: { active: null }, disposers: [],
    flow: { isHidden: (card: BaseObj) => Boolean(card.privateStep) }, user: { id: 'me' },
  });
  const start = Reflect.get(BoardApp.prototype, 'watchCardHeights') as (this: HealApp) => () => void;
  const stop = start.call(app);
  stops.push(stop);
  return app;
}

function board(doc = new Y.Doc()) {
  const store = new Store(doc);
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  store.transact(() => store.labels.set('bug', { id: 'bug', name: 'Bug', color: 'pink', order: 0 }));
  store.undo.clear();
  return { store, container: container.id, lane: lanes[0].id };
}

function remoteCard(store: Store, lane: Id, id = 'mcp-card', patch: Partial<BaseObj> = {}) {
  const rank = 'a0@' + lane;
  const card: BaseObj = {
    id, type: 'card', parent: lane, rank, text: 'Ship this milestone', x: 0, y: 0, w: 264, h: KANBAN.cardH,
    rotation: 0, z: 'a0', createdBy: 'agent', labels: ['bug'], due: '2026-10-13', ...patch,
  };
  store.doc.transact(() => store.objects.set(id, new Y.Map(Object.entries(card))), 'mcp:token');
  return id;
}

const heightOf = (store: Store, id: Id) => {
  const card = store.get(id) as BaseObj;
  return cardContentHeight(card, store.geometry(card).w);
};
const undoSteps = (store: Store) => (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;

describe('card height healing', () => {
  it('uses the remote origin and half-pixel threshold, permits locked height-only repair, and rejects hidden or viewer cards', () => {
    const base = { storedHeight: 72, measuredHeight: 90, role: 'editor' as const, origin: 'mcp:token', locked: false, hidden: false };
    expect(needsCardHeightHeal(base)).toBe(true);
    expect(needsCardHeightHeal({ ...base, storedHeight: 89.6 })).toBe(false);
    expect(needsCardHeightHeal({ ...base, locked: true })).toBe(true);
    expect(needsCardHeightHeal({ ...base, hidden: true })).toBe(false);
    expect(needsCardHeightHeal({ ...base, role: 'viewer' })).toBe(false);
    expect(needsCardHeightHeal({ ...base, origin: LOCAL })).toBe(false);
  });

  it('heals an MCP card with labels and a due date on the next app frame without looping', () => {
    const { store, lane } = board();
    const app = appWatcher(store);
    const id = remoteCard(store, lane);
    const expected = heightOf(store, id);
    let heals = 0;
    store.doc.on('afterTransaction', (transaction) => { if (transaction.origin === 'heal') heals++; });

    expect((store.get(id) as BaseObj).h).toBe(KANBAN.cardH);
    expect(expected).not.toBe(KANBAN.cardH);
    expect(frames).toHaveLength(1);
    frame();

    expect((store.get(id) as BaseObj).h).toBe(expected);
    expect((store.get(id) as BaseObj).locked).toBeUndefined();
    expect(heals).toBe(1);
    expect(frames).toHaveLength(0);
    expect(app.role).toBe('editor');
  });

  it('lets the first editor heal while a second Y.Doc adopts the value without writing back', () => {
    const { store: first, lane } = board();
    const firstApp = appWatcher(first);
    const secondDoc = new Y.Doc();
    const second = new Store(secondDoc);
    const secondApp = appWatcher(second);
    const id = remoteCard(first, lane);
    Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(first.doc), 'provider');
    const expected = heightOf(first, id);
    let firstHeals = 0, secondHeals = 0;
    first.doc.on('afterTransaction', (transaction) => { if (transaction.origin === 'heal') firstHeals++; });
    secondDoc.on('afterTransaction', (transaction) => { if (transaction.origin === 'heal') secondHeals++; });

    frame();
    Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(first.doc, Y.encodeStateVector(secondDoc)), 'provider');
    frame();
    Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(secondDoc, Y.encodeStateVector(first.doc)), 'provider');

    expect((first.get(id) as BaseObj).h).toBe(expected);
    expect((second.get(id) as BaseObj).h).toBe(expected);
    expect(firstHeals).toBe(1);
    expect(secondHeals).toBe(0);
    expect(frames).toHaveLength(0);
    expect(firstApp.role).toBe('editor');
    expect(secondApp.role).toBe('editor');
  });

  it('does not write for a viewer', () => {
    const { store, lane } = board();
    appWatcher(store, 'viewer');
    const id = remoteCard(store, lane);
    let heals = 0;
    store.doc.on('afterTransaction', (transaction) => { if (transaction.origin === 'heal') heals++; });

    frame();

    expect((store.get(id) as BaseObj).h).toBe(KANBAN.cardH);
    expect(heals).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('repairs a locked card height without changing its content or lock', () => {
    const { store, lane } = board();
    appWatcher(store);
    const id = remoteCard(store, lane, 'locked-mcp-card');
    store.transact(() => store.update(id, { locked: true }));
    const before = store.get(id) as BaseObj;

    frame();

    const after = store.get(id) as BaseObj;
    expect(after.h).toBe(heightOf(store, id));
    expect(after.locked).toBe(true);
    expect(after.text).toBe(before.text);
    expect(after.labels).toEqual(before.labels);
    expect(after.due).toBe(before.due);
  });

  it('waits while the app editor is active and then heals', () => {
    const { store, lane } = board();
    const app = appWatcher(store);
    const id = remoteCard(store, lane);
    app.editor.active = true;

    frame();
    expect((store.get(id) as BaseObj).h).toBe(KANBAN.cardH);
    expect(frames).toHaveLength(1);

    app.editor.active = false;
    frame();
    expect((store.get(id) as BaseObj).h).toBe(heightOf(store, id));
  });

  it('leaves a heal out of undo so undoing a later local edit keeps the repaired height', () => {
    const { store, lane } = board();
    appWatcher(store);
    const id = remoteCard(store, lane);
    frame();
    const measured = heightOf(store, id);
    expect((store.get(id) as BaseObj).h).toBe(measured);
    expect(undoSteps(store)).toBe(0);

    expect(addCard(store, lane, 'A local card', { createdBy: 'me' })).not.toBeNull();
    store.undo.stopCapturing();
    store.transact(() => store.update(id, { text: 'A local title' }));
    expect(undoSteps(store)).toBe(2);
    store.undo.undo();

    expect((store.get(id) as BaseObj).text).toBe('Ship this milestone');
    expect((store.get(id) as BaseObj).h).toBe(measured);
  });

  it('heals no more than forty queued cards in one frame', () => {
    const { store, lane } = board();
    appWatcher(store);
    store.doc.transact(() => {
      for (let i = 0; i < 43; i++) {
        const id = 'mcp-' + i;
        const card: BaseObj = {
          id, type: 'card', parent: lane, rank: 'a' + i.toString(36) + '@' + lane, text: 'Ship milestone ' + i,
          x: 0, y: 0, w: 264, h: KANBAN.cardH, rotation: 0, z: 'a0',
        };
        store.objects.set(id, new Y.Map(Object.entries(card)));
      }
    }, 'mcp:token');

    frame();
    expect([...store.cache.values()].filter((o) => o.type === 'card' && o.h !== KANBAN.cardH)).toHaveLength(40);
    frame();
    expect([...store.cache.values()].filter((o) => o.type === 'card' && o.h !== KANBAN.cardH)).toHaveLength(43);
  });
});
