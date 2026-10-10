import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardApp } from '../src/app';
import type { AiRunsMessage } from '../src/sync';
import { mountAiLive } from '../src/ui/ai-live';
import { firstRunHint } from '../src/ui/board';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

// TAB-214: while an AI preview is on an empty board the "An empty board" hint is hidden (the person has started), and it
// comes back when the preview goes and the board is still empty. Driven through the real live layer and the real hint.

let browser: FakeBrowser;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  browser = installFakeBrowser();
  frames = new Map();
  nextFrame = 0;
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

function rig() {
  const root = browser.mount();
  const cursorLayer = browser.document.createElement('div');
  root.appendChild(cursorLayer);
  Object.defineProperty(root, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect });
  const objects = new Map<string, unknown>();
  const store = {
    cache: new Map<string, unknown>(),
    get: (id: string) => objects.get(id),
    getMeta: () => ({ bodyFont: 'system', headingFont: 'system' }),
    undo: { undo: () => {}, stopCapturing: () => {} },
    transact: (fn?: () => void) => fn?.(),
  };
  const r = {
    root, cursorLayer, cam: { x: 0, y: 0, zoom: 1 }, bounds: () => ({ x: 0, y: 0, w: 1, h: 1 }), isHidden: () => false, contentBounds: () => null,
    toScreen: (p: { x: number; y: number }) => p, setOverlay: () => {}, onCamera: () => () => {},
  };
  const listeners = new Map<string, Set<() => void>>();
  let relay: ((m: AiRunsMessage) => void) | null = null;
  const destroyers: (() => void)[] = [];
  const app = {
    r, store, readOnly: false, user: { id: 'viewer', name: 'Johan', color: '#2F6FED' },
    conn: { onAiRuns: (cb: (m: AiRunsMessage) => void) => ((relay = cb), () => {}) },
    on: (ev: string, fn: () => void) => { (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(fn); return () => listeners.get(ev)!.delete(fn); },
    onDestroy: (cb: () => void) => void destroyers.push(cb),
  } as unknown as BoardApp;
  mountAiLive(app);
  return { app, store, root, layer: root.querySelector('.ailive') as FakeElement, send: (m: AiRunsMessage) => relay!(m), destroy: () => destroyers.forEach((d) => d()) };
}

const by = { id: 'remote-ana', name: 'Ana', color: '#7A5AF8' };
const proposal = { kind: 'create' as const, objects: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] };
const ready = { id: 'run1', feature: 'generate', status: 'ready', by, private: false, startedAt: 1, readyAt: 2, target: { ids: [] }, proposal, cut: false };


const gone = { id: 'run1', feature: 'generate', status: 'discarded', by, resolvedBy: { id: 'viewer', name: 'Johan' }, error: null };

function hintOn(a: ReturnType<typeof rig>) {
  const chrome = browser.document.createElement('div');
  chrome.className = 'chrome';
  a.root.appendChild(chrome);
  firstRunHint(a.app, chrome as unknown as HTMLElement);
  return chrome.querySelector('.empty-hint') as FakeElement;
}

describe('the empty-board hint and an AI preview (TAB-214)', () => {
  it('is hidden while a preview is on the empty board, and back when it is discarded', () => {
    const a = rig();
    const hint = hintOn(a);
    expect(hint.hidden).toBe(false);
    a.send({ kind: 'snapshot', runs: [ready] } as AiRunsMessage);
    runFrames();
    expect(hint.hidden).toBe(true);
    a.send({ kind: 'patch', run: gone } as AiRunsMessage);
    runFrames();
    expect(hint.hidden).toBe(false);
    a.destroy();
  });

  it('stays hidden for a preview that was there before the hint was drawn, and ignores a run still being made', () => {
    const a = rig();
    a.send({ kind: 'snapshot', runs: [ready] } as AiRunsMessage);
    runFrames();
    expect(hintOn(a).hidden).toBe(true);
    const b = rig();
    b.send({ kind: 'snapshot', runs: [{ ...ready, status: 'running', readyAt: null, proposal: null }] } as AiRunsMessage);
    runFrames();
    expect(hintOn(b).hidden).toBe(false);
    a.destroy();
    b.destroy();
  });
});
