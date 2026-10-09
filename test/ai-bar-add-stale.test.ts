import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardApp } from '../src/app';
import type { AiRunsMessage } from '../src/sync';
import { nothingToAdd } from '../src/ai-live-logic';
import { mountAiBar } from '../src/ui/ai-bar';
import { mountAiLive } from '../src/ui/ai-live';
import { toast } from '../src/ui/common';
import { FakeElement, installFakeBrowser, need, type FakeBrowser } from './fake-dom';

// TAB-213, the bar's own entry: Add to board on the person's own cluster preview, after the stickies it would move changed.
// The live tray's Accept is pinned in test/ai-live-stale-add.test.ts; both ask takeReview the same question. Driven through
// the real bar (a run started from its chip and Run button, answered by a stubbed /api/ai/run) and the real live layer.

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

const group = { kind: 'group' as const, groups: [{ title: 'Went well', ids: ['a', 'b'] }, { title: 'To fix', ids: ['c'] }] };
const ME = { id: 'viewer', name: 'Johan', color: '#2F6FED' };
const config = { enabled: true, features: ['summarise', 'cluster', 'generate'], keySource: 'workspace', model: 'claude-haiku-5-5', personalKeys: false, hasSecret: false, myKey: null };

beforeEach(() => {
  browser = installFakeBrowser();
  frames = new Map();
  nextFrame = 0;
  applied.calls = [];
  vi.mocked(toast).mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.set(++nextFrame, cb), nextFrame));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('Element', FakeElement);
  // the bar watches its size and the DOM around it; nothing here resizes or restacks
  class NoObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('ResizeObserver', NoObserver);
  vi.stubGlobal('MutationObserver', NoObserver);
  // the bar is behind a flag (`?aibar`, or this key)
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'driftboard:flag:aibar' ? '1' : null), setItem: () => undefined, removeItem: () => undefined });
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

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function rig() {
  const root = browser.mount();
  const chrome = browser.document.createElement('div');
  chrome.className = 'chrome';
  browser.document.body.appendChild(chrome);
  const cursorLayer = browser.document.createElement('div');
  root.appendChild(cursorLayer);
  Object.defineProperty(root, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect });
  const cache = new Map<string, Record<string, unknown>>(
    ['a', 'b', 'c'].map((id, i) => [id, { id, type: 'sticky', x: i * 220, y: 0, w: 192, h: 192, text: `sticky ${id}`, parent: '' }]),
  );
  const store = {
    cache,
    get: (id: string) => cache.get(id),
    getMeta: () => ({ bodyFont: 'system', headingFont: 'system' }),
    undo: { undo: () => {}, stopCapturing: () => {} },
    transact: (fn?: () => void) => fn?.(),
  };
  const r = {
    root, cursorLayer, cam: { x: 0, y: 0, zoom: 1 }, bounds: () => ({ x: 0, y: 0, w: 1, h: 1 }), isHidden: () => false, contentBounds: () => null,
    toScreen: (p: { x: number; y: number }) => p, setOverlay: () => {}, onCamera: () => () => {}, viewport: () => ({ x: 0, y: 0, w: 800, h: 600 }),
  };
  let relay: ((m: AiRunsMessage) => void) | null = null;
  const listeners = new Map<string, (() => void)[]>();
  const app = {
    r, store, readOnly: false, user: ME, selection: ['a', 'b', 'c'], flow: { isHidden: () => false }, editor: { active: false }, conn: { id: 'board1', onAiRuns: (cb: (m: AiRunsMessage) => void) => ((relay = cb), () => {}) },
    on: (name: string, fn: () => void) => (listeners.set(name, [...(listeners.get(name) ?? []), fn]), () => {}),
    onDestroy: () => {},
  } as unknown as BoardApp;

  const calls: string[] = [];
  const fetchMock = vi.fn<(url: string) => Promise<Response>>((url) => {
    calls.push(url);
    if (url === '/api/ai/config') return Promise.resolve(json(config));
    if (url === '/api/ai/run') {
      const body = sse('progress', { n: 1, runId: 'run1' }) + sse('result', { runId: 'run1', proposal: group, cut: false });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    return Promise.resolve(json({ error: 'not_found' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);

  mountAiLive(app);
  mountAiBar(app, chrome as unknown as HTMLElement);
  await vi.waitFor(() => expect(chrome.querySelector('.aibar')).not.toBeNull());
  runFrames();

  const click = (sel: string) => need(chrome, sel).click();
  const buttonNamed = (name: string) => {
    const b = chrome.querySelectorAll('button').find((x) => x.textContent === name);
    if (!b) throw new Error(`no "${name}" button`);
    return b;
  };
  // the person's own cluster run on the three selected stickies, answered, and its ready run delivered by the relay
  click('.chip[data-id="cluster"]');
  buttonNamed('Run').click();
  await vi.waitFor(() => expect(chrome.querySelector('.aibar')!.getAttribute('data-ui')).toBe('preview'));
  relay!({ kind: 'snapshot', runs: [{ id: 'run1', feature: 'cluster', status: 'ready', by: ME, private: false, startedAt: 1, readyAt: 2, target: { ids: ['a', 'b', 'c'] }, proposal: group, cut: false }] } as AiRunsMessage);
  runFrames();

  return {
    app, calls, fetchMock,
    edit: (id: string, patch: Record<string, unknown> | null) => {
      if (patch) Object.assign(cache.get(id)!, patch);
      else cache.delete(id);
      (listeners.get('objects') ?? []).forEach((fn) => fn());
      runFrames();
    },
    add: () => buttonNamed('Add to board').click(),
  };
}

const toasted = () => vi.mocked(toast).mock.calls.map((c) => c[0] as string);

describe('Add to board on the bar, after the stickies changed (TAB-213)', () => {
  it('has nothing to add when every sticky changed: no ask to the relay, no write, the right sentence', async () => {
    const t = await rig();
    expect(t.calls).toEqual(['/api/ai/config', '/api/ai/run']);
    t.edit('a', { text: 'edited elsewhere' });
    t.edit('b', { locked: true });
    t.edit('c', null);
    t.add();
    expect(toasted()).toEqual([nothingToAdd(3)]);
    expect(toasted()[0]).toBe('Every sticky left in this proposal changed since it came, so nothing was moved.');
    expect(t.calls).toEqual(['/api/ai/config', '/api/ai/run']); // never reached /api/ai/runs/run1/resolve
    expect(applied.calls).toHaveLength(0);
  });

  it('moves what is unchanged and says how many were left, when only some changed', async () => {
    const t = await rig();
    t.edit('b', { text: 'edited elsewhere' });
    t.fetchMock.mockImplementation((url) => {
      t.calls.push(url);
      return Promise.resolve(json({ id: 'run1', action: 'accept', feature: 'cluster', proposal: group, cut: false }));
    });
    t.add();
    await vi.waitFor(() => expect(applied.calls).toHaveLength(1));
    expect((applied.calls[0][1] as { groups: unknown[] }).groups).toEqual([{ title: 'Went well', ids: ['a'] }, { title: 'To fix', ids: ['c'] }]);
    expect(toasted().at(-1)).toBe('Moved 2 stickies into 2 groups. 1 sticky that changed since the proposal came was left where it is.');
    expect(t.calls.at(-1)).toBe('/api/ai/runs/run1/resolve');
  });
});
