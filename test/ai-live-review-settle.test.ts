import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardApp } from '../src/app';
import type { AiRunsMessage } from '../src/sync';
import { startReview } from '../src/ai-review';
import { mountAiLive, reviewFor, setReview } from '../src/ui/ai-live';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

// TAB-160: an add writes what the person ticked and edited even when the relay's patch (the run is accepted) reaches the app
// before the answer of the resolve request, and the patch has already dropped the review. Driven through the real live layer.

const applied = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../src/ai-apply', async (orig) => ({
  ...(await orig<typeof import('../src/ai-apply')>()),
  applyProposal: (...args: unknown[]) => {
    applied.calls.push(args);
    return { ok: true, created: 0, moved: 0 };
  },
}));
vi.mock('../src/ui/common', async (orig) => ({ ...(await orig<typeof import('../src/ui/common')>()), toast: vi.fn<() => void>() }));

let browser: FakeBrowser;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  browser = installFakeBrowser();
  frames = new Map();
  nextFrame = 0;
  applied.calls = [];
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
  const destroyers: (() => void)[] = [];
  const app = {
    r, store, readOnly: false, user: { id: 'viewer', name: 'Johan', color: '#2F6FED' },
    conn: { onAiRuns: (cb: (m: AiRunsMessage) => void) => ((relay = cb), () => {}) },
    on: () => () => {},
    onDestroy: (cb: () => void) => void destroyers.push(cb),
  } as unknown as BoardApp;
  mountAiLive(app);
  return { app, layer: root.querySelector('.ailive') as FakeElement, send: (m: AiRunsMessage) => relay!(m), destroy: () => destroyers.forEach((d) => d()) };
}

const by = { id: 'remote-ana', name: 'Ana', color: '#7A5AF8' };
const proposal = { kind: 'create' as const, objects: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] };
const ready = { id: 'run1', feature: 'generate', status: 'ready', by, private: false, startedAt: 1, readyAt: 2, target: { ids: [] }, proposal, cut: false };
const accepted = { id: 'run1', feature: 'generate', status: 'accepted', by, resolvedBy: { id: 'viewer', name: 'Johan' }, error: null };

describe('adding a reviewed proposal', () => {
  it('writes the ticked and edited subset when the relay settles the run before the answer arrives', async () => {
    const a = rig();
    a.send({ kind: 'snapshot', runs: [ready] } as AiRunsMessage);
    runFrames();

    const review = startReview(proposal);
    if (review.kind !== 'create') throw new Error('kind');
    review.items[0].keep = false;
    review.items[1].text = 'two, edited';
    setReview(a.app, 'run1', review);
    runFrames();
    expect(reviewFor(a.app, 'run1')).not.toBeNull();

    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => (answer = res))));
    const accept = [...a.layer.querySelectorAll('button')].find((b) => b.textContent === 'Accept');
    if (!accept) throw new Error('no Accept button on the preview');
    accept.click();

    // the relay's patch wins the race: the run is settled, so the review of it is dropped on the next frame
    a.send({ kind: 'patch', run: accepted } as AiRunsMessage);
    runFrames();
    expect(reviewFor(a.app, 'run1')).toBeNull();

    answer(new Response(JSON.stringify({ id: 'run1', action: 'accept', feature: 'generate', proposal, cut: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await vi.waitFor(() => expect(applied.calls).toHaveLength(1));

    const [, written, , proposedBy] = applied.calls[0] as [unknown, { kind: string; objects: { text: string }[] }, unknown, unknown];
    expect(written.objects.map((o) => o.text)).toEqual(['two, edited', 'three']);
    expect(proposedBy).toEqual({ feature: 'generate', by: { id: 'remote-ana', name: 'Ana' } });
    a.destroy();
  });
});
