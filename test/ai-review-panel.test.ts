import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardApp } from '../src/app';
import type { AiRunsMessage } from '../src/sync';
import { STICKY_COLORS } from '../src/palette';
import { mountAiLive, openReview, reviewFor } from '../src/ui/ai-live';
import { toast } from '../src/ui/common';
import '../src/ui/ai-review-panel';
import { FakeElement, FakeEvent, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

// TAB-160: the review panel's keyboard and focus behaviour, and what Add says when nothing is ticked. Driven through the real
// live layer and the real panel against the fake DOM.

vi.mock('../src/ui/common', async (orig) => ({ ...(await orig<typeof import('../src/ui/common')>()), toast: vi.fn<(msg: string) => void>() }));

let browser: FakeBrowser;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const rigs: { destroy: () => void }[] = [];

beforeEach(() => {
  browser = installFakeBrowser();
  frames = new Map();
  nextFrame = 0;
  vi.mocked(toast).mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.set(++nextFrame, cb), nextFrame));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('Element', FakeElement);
  // the caret of a text field, which the fake elements do not have
  const proto = FakeElement.prototype as unknown as Record<string, unknown>;
  proto.selectionStart = 0;
  proto.selectionEnd = 0;
  proto.setSelectionRange = function (this: Record<string, unknown>, a: number, b: number) {
    this.selectionStart = a;
    this.selectionEnd = b;
  };
  const isField = (o: unknown) => o instanceof FakeElement && ['INPUT', 'TEXTAREA'].includes(o.tagName);
  vi.stubGlobal('HTMLInputElement', { [Symbol.hasInstance]: isField });
  vi.stubGlobal('HTMLTextAreaElement', { [Symbol.hasInstance]: isField });
});

afterEach(() => {
  for (const r of rigs.splice(0)) r.destroy();
  const proto = FakeElement.prototype as unknown as Record<string, unknown>;
  delete proto.selectionStart;
  delete proto.selectionEnd;
  delete proto.setSelectionRange;
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
const run = (proposal: unknown) => ({ id: 'run1', feature: 'generate', status: 'ready', by, private: false, startedAt: 1, readyAt: 2, target: { ids: [] }, proposal, cut: false });
const create = { kind: 'create' as const, objects: [{ text: 'one' }, { text: 'two' }, { text: 'three' }], frame: { title: 'Summary' } };
const group = { kind: 'group' as const, groups: [{ title: 'Went well', ids: ['a', 'b'] }, { title: 'To fix', ids: ['c'] }] };

function rig(proposal: unknown) {
  const root = browser.mount();
  const chrome = browser.document.createElement('div');
  chrome.className = 'chrome';
  browser.document.body.appendChild(chrome);
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
  const destroyers: (() => void)[] = [];
  const app = {
    r, store, readOnly: false, user: { id: 'viewer', name: 'Johan', color: '#2F6FED' },
    conn: { onAiRuns: (cb: (m: AiRunsMessage) => void) => ((relay = cb), () => {}) },
    on: (name: string, fn: () => void) => (listeners.set(name, [...(listeners.get(name) ?? []), fn]), () => {}),
    onDestroy: (cb: () => void) => void destroyers.push(cb),
  } as unknown as BoardApp;
  mountAiLive(app);
  relay!({ kind: 'snapshot', runs: [run(proposal)] } as AiRunsMessage);
  runFrames();
  const actions = { accept: vi.fn<() => void>(), discard: vi.fn<() => void>() };
  openReview(app, 'run1', actions);
  const panel = need(chrome, '.aireview');
  const made = {
    app, panel, actions, objects,
    changed: () => (listeners.get('objects') ?? []).forEach((fn) => fn()),
    destroy: () => destroyers.forEach((d) => d()),
  };
  rigs.push(made);
  return made;
}

const key = (el: FakeElement, k: string) => {
  const e = Object.assign(new FakeEvent('keydown'), { key: k });
  el.dispatchEvent(e);
  return e;
};
const tick = (box: FakeElement, on: boolean) => {
  Object.assign(box, { checked: on });
  box.dispatchEvent(new FakeEvent('change'));
};
// the fake selector engine splits on spaces, so a label with a space is found by filtering
const label = (panel: FakeElement, l: string): FakeElement => {
  const found = panel.querySelectorAll('[aria-label]').find((e) => e.getAttribute('aria-label') === l);
  if (!found) throw new Error(`no control labelled "${l}"`);
  return found;
};
const addButton = (panel: FakeElement) => need(panel, '.aireview-actions .primary');

describe('Add with nothing ticked', () => {
  it('says so and writes nothing, instead of doing nothing', () => {
    const t = rig(create);
    expect(textOf(addButton(t.panel))).toBe('Add all (3)');
    for (const n of [1, 2, 3]) tick(label(t.panel, `Keep sticky ${n}`), false);
    expect(textOf(addButton(t.panel))).toBe('Add selected (0)');
    expect(addButton(t.panel).getAttribute('aria-disabled')).toBe('true');
    addButton(t.panel).click();
    expect(toast).toHaveBeenCalledWith('Nothing is selected to add.');
    expect(t.actions.accept).not.toHaveBeenCalled();
    tick(label(t.panel, 'Keep sticky 2'), true);
    addButton(t.panel).click();
    expect(t.actions.accept).toHaveBeenCalledTimes(1);
    t.destroy();
  });
});

describe('the colour swatches of a sticky', () => {
  const swatches = (panel: FakeElement) => label(panel, 'Sticky 1 colour').querySelectorAll('button');

  it('are one tab stop, and the arrow keys move and choose, wrapping at the ends', () => {
    const t = rig(create);
    const all = swatches(t.panel);
    expect(all).toHaveLength(STICKY_COLORS.length);
    expect(all.map((b) => b.getAttribute('tabindex'))).toEqual(all.map((_, i) => (i === 0 ? '0' : '-1')));
    all[0].focus();

    const right = key(all[0], 'ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(browser.document.activeElement).toBe(all[1]);
    expect(all.map((b) => b.getAttribute('aria-checked'))).toEqual(all.map((_, i) => String(i === 1)));
    expect(all.map((b) => b.getAttribute('tabindex'))).toEqual(all.map((_, i) => (i === 1 ? '0' : '-1')));
    const review = reviewFor(t.app, 'run1');
    if (review?.kind !== 'create') throw new Error('review');
    expect(review.items[0].color).toBe(STICKY_COLORS[1].name);

    key(all[1], 'ArrowLeft');
    key(all[0], 'ArrowLeft');
    expect(browser.document.activeElement).toBe(all[all.length - 1]);
    key(all[all.length - 1], 'ArrowDown');
    expect(browser.document.activeElement).toBe(all[0]);
    key(all[0], 'ArrowUp');
    expect(browser.document.activeElement).toBe(all[all.length - 1]);
    t.destroy();
  });

  it('leave other keys alone', () => {
    const t = rig(create);
    const first = swatches(t.panel)[0];
    expect(key(first, 'a').defaultPrevented).toBe(false);
    expect(key(first, 'Tab').defaultPrevented).toBe(false);
    t.destroy();
  });
});

describe('the panel when a sticky changes under it', () => {
  it('keeps focus and the caret on the same field when it is rebuilt', () => {
    const t = rig(group);
    const title = label(t.panel, 'Group 1 title');
    title.focus();
    (title as unknown as { setSelectionRange: (a: number, b: number) => void }).setSelectionRange(2, 4);
    expect(browser.document.activeElement).toBe(title);

    // someone edits sticky b: it is marked "Changed since", which rebuilds the list
    t.objects.get('b')!.text = 'edited elsewhere';
    t.changed();
    runFrames();
    expect(textOf(t.panel)).toContain('Changed since');

    const again = label(t.panel, 'Group 1 title');
    expect(again).not.toBe(title);
    expect(again.isConnected).toBe(true);
    expect(browser.document.activeElement).toBe(again);
    const caret = again as unknown as { selectionStart: number; selectionEnd: number };
    expect([caret.selectionStart, caret.selectionEnd]).toEqual([2, 4]);
    t.destroy();
  });

  it('does not steal focus from outside the list', () => {
    const t = rig(group);
    const close = label(t.panel, 'Close the review');
    close.focus();
    t.objects.get('b')!.text = 'edited elsewhere';
    t.changed();
    runFrames();
    expect(textOf(t.panel)).toContain('Changed since');
    expect(browser.document.activeElement).toBe(close);
    t.destroy();
  });
});
