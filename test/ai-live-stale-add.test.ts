import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardApp } from '../src/app';
import type { AiRunsMessage } from '../src/sync';
import { leftOutNote, nothingToAdd } from '../src/ai-live-logic';
import { mountAiLive, takeReview } from '../src/ui/ai-live';
import { toast } from '../src/ui/common';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

// TAB-213: Accept (or Add to board) without opening the review still skips the stickies that changed since the proposal came,
// as the panel does, and says so. Driven through the real live layer; the add itself is a spy.

const applied = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../src/ai-apply', async (orig) => ({
  ...(await orig<typeof import('../src/ai-apply')>()),
  applyProposal: (...args: unknown[]) => {
    applied.calls.push(args);
    return { ok: true, created: 0, moved: 0 };
  },
}));
vi.mock('../src/ui/common', async (orig) => ({ ...(await orig<typeof import('../src/ui/common')>()), toast: vi.fn<(msg: string) => void>() }));

let browser: FakeBrowser;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  browser = installFakeBrowser();
  frames = new Map();
  nextFrame = 0;
  applied.calls = [];
  vi.mocked(toast).mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.set(++nextFrame, cb), nextFrame));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('Element', FakeElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  browser.uninstall();
});

function runFrames() {
  for (let i = 0; i < 100 && frames.size; i++) {
    const batch = [...frames.values()];
    frames.clear();
    for (const cb of batch) cb(0);
  }
}

const by = { id: 'remote-ana', name: 'Ana', color: '#7A5AF8' };
const group = { kind: 'group' as const, groups: [{ title: 'Went well', ids: ['a', 'b'] }, { title: 'To fix', ids: ['c'] }] };
const create = { kind: 'create' as const, objects: [{ text: 'one' }, { text: 'two' }] };
const run = (proposal: unknown) => ({ id: 'run1', feature: 'cluster', status: 'ready', by, private: false, startedAt: 1, readyAt: 2, target: { ids: [] }, proposal, cut: false });

function rig(proposal: unknown) {
  const root = browser.mount();
  const cursorLayer = browser.document.createElement('div');
  root.appendChild(cursorLayer);
  Object.defineProperty(root, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect });
  const objects = new Map<string, Record<string, unknown>>(
    ['a', 'b', 'c'].map((id, i) => [id, { id, type: 'sticky', x: i * 220, y: 0, w: 192, h: 192, text: `sticky ${id}`, parent: '' }]),
  );
  const store = {
    get: (id: string) => objects.get(id),
    getMeta: () => ({ bodyFont: 'system', headingFont: 'system' }),
    undo: { undo: () => {}, stopCapturing: () => {} },
    transact: (fn?: () => void) => fn?.(),
  };
  const r = {
    root, cursorLayer, cam: { x: 0, y: 0, zoom: 1 }, bounds: () => ({ x: 0, y: 0, w: 1, h: 1 }), isHidden: () => false, contentBounds: () => null,
    toScreen: (p: { x: number; y: number }) => p, setOverlay: () => {}, onCamera: () => () => {},
  };
  let relay: ((m: AiRunsMessage) => void) | null = null;
  const listeners = new Map<string, (() => void)[]>();
  const app = {
    r, store, readOnly: false, user: { id: 'viewer', name: 'Johan', color: '#2F6FED' },
    conn: { onAiRuns: (cb: (m: AiRunsMessage) => void) => ((relay = cb), () => {}) },
    on: (name: string, fn: () => void) => (listeners.set(name, [...(listeners.get(name) ?? []), fn]), () => {}),
    onDestroy: () => {},
  } as unknown as BoardApp;
  mountAiLive(app);
  relay!({ kind: 'snapshot', runs: [run(proposal)] } as AiRunsMessage);
  runFrames();
  const fetchMock = vi.fn<() => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify({ id: 'run1', action: 'accept', feature: 'cluster', proposal, cut: false }), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    app,
    fetchMock,
    /** Someone else changes a sticky after the proposal arrived. */
    edit: (id: string, patch: Record<string, unknown> | null) => {
      if (patch) Object.assign(objects.get(id)!, patch);
      else objects.delete(id);
      (listeners.get('objects') ?? []).forEach((fn) => fn());
      runFrames();
    },
    accept: () => {
      const button = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Accept');
      if (!button) throw new Error('no Accept button on the preview');
      button.click();
    },
  };
}

const toasted = () => vi.mocked(toast).mock.calls.map((c) => c[0] as string);

describe('Accept without opening the review', () => {
  it('moves what is unchanged, leaves the sticky someone edited, and says so', async () => {
    const t = rig(group);
    t.edit('b', { text: 'edited by someone else' });
    t.accept();
    await vi.waitFor(() => expect(applied.calls).toHaveLength(1));
    const written = applied.calls[0][1] as { groups: { title: string; ids: string[] }[] };
    expect(written.groups).toEqual([{ title: 'Went well', ids: ['a'] }, { title: 'To fix', ids: ['c'] }]);
    expect(toasted().at(-1)).toBe('Moved Ana\'s 2 stickies into 2 groups. 1 sticky that changed since the proposal came was left where it is.');
  });

  it('counts a sticky that was deleted, moved, locked or retyped as changed too, and a group left empty is dropped', async () => {
    const t = rig(group);
    t.edit('a', null);
    t.edit('b', { x: 999 });
    t.accept();
    await vi.waitFor(() => expect(applied.calls).toHaveLength(1));
    expect((applied.calls[0][1] as { groups: unknown[] }).groups).toEqual([{ title: 'To fix', ids: ['c'] }]);
    expect(toasted().at(-1)).toBe('Moved Ana\'s 1 sticky into 1 group. 2 stickies that changed since the proposal came were left where they are.');
  });

  it('has nothing to add when every sticky changed: no write, the right sentence, and no preview left to click', () => {
    const t = rig(group);
    t.edit('a', { text: 'x' });
    t.edit('b', { locked: true });
    t.edit('c', { type: 'shape' });
    // the ghosts, and the tray with them, are gone: what is drawn is what would be added, and that is nothing
    expect([...browser.document.querySelectorAll('button')].some((b) => b.textContent === 'Accept')).toBe(false);
    // the bar's Add asks takeReview the same question before it asks the relay
    const taken = takeReview(t.app, 'run1', group);
    expect(taken.stale).toBe(3);
    expect(taken.choose(group)).toBeNull();
    expect(nothingToAdd(taken.stale)).toBe('Every sticky left in this proposal changed since it came, so nothing was moved.');
    expect(t.fetchMock).not.toHaveBeenCalled();
    expect(applied.calls).toHaveLength(0);
  });

  it('is the review the panel would start with, so an opened review and this one agree', () => {
    const t = rig(group);
    t.edit('b', { w: 300 });
    const taken = takeReview(t.app, 'run1', group);
    expect(taken.stale).toBe(1);
    expect(taken.choose(group)).toEqual({ kind: 'group', groups: [{ title: 'Went well', ids: ['a'] }, { title: 'To fix', ids: ['c'] }] });
  });

  it('adds everything with no note when nothing changed, and leaves a create proposal alone', async () => {
    const g = rig(group);
    g.accept();
    await vi.waitFor(() => expect(applied.calls).toHaveLength(1));
    expect((applied.calls[0][1] as { groups: { ids: string[] }[] }).groups.map((x) => x.ids)).toEqual([['a', 'b'], ['c']]);
    expect(toasted().at(-1)).toBe('Moved Ana\'s 3 stickies into 2 groups.');
  });

  it('does not touch a create proposal: there is nothing in it to go stale', async () => {
    const t = rig(create);
    t.accept();
    await vi.waitFor(() => expect(applied.calls).toHaveLength(1));
    expect((applied.calls[0][1] as { objects: unknown[] }).objects).toHaveLength(2);
    expect(toasted().at(-1)).toBe('Added Ana\'s 2 stickies.');
  });
});

describe('the sentences', () => {
  it('say how many were left, and nothing when none', () => {
    expect(leftOutNote(0)).toBe('');
    expect(leftOutNote(1)).toBe(' 1 sticky that changed since the proposal came was left where it is.');
    expect(leftOutNote(4)).toBe(' 4 stickies that changed since the proposal came were left where they are.');
    expect(nothingToAdd(0)).toBe('Nothing is selected to add.');
  });
});
