import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardApp } from '../src/app';
import { installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

// The board's window keydown listener (BoardApp.bindKeys), driven through the fake browser the other BoardApp tests use.
let browser: FakeBrowser;
let handlers: Map<string, ((event: unknown) => void)[]>;

beforeEach(() => {
  browser = installFakeBrowser();
  handlers = new Map();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener() {},
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    innerWidth: 1024,
    innerHeight: 768,
  });
});

afterEach(() => {
  browser.uninstall();
});

/** The board with its canvas tab stop, a toolbar button, and a camera whose zoom the spy keeps (100% to start at 2x). */
function board(zoom = 2) {
  const doc = browser.document;
  const canvas = doc.createElement('div');
  canvas.className = 'canvas-focus';
  const button = doc.createElement('button');
  doc.body.append(canvas, button);
  const cam = { x: 0, y: 0, zoom };
  const app = Object.create(BoardApp.prototype) as Record<string, unknown>;
  Object.assign(app, {
    links: { noteKey() {}, open() {}, pasteUrl: () => false },
    tablesController: { key: () => false, copy: () => false },
    selection: [], scope: null, drag: null, longPress: null, spaceDown: false,
    lifetime: new AbortController(),
    editor: { active: false, reposition() {} },
    r: {
      cam,
      size: () => ({ left: 0, top: 0, w: 800, h: 600 }),
      zoomAt: (_screen: { x: number; y: number }, factor: number) => {
        cam.zoom = Math.min(32, Math.max(0.02, cam.zoom * factor));
      },
      root: doc.createElement('div'),
    },
  });
  // readOnly is a getter on the class: a view-only board, which these keys do not change
  Object.defineProperty(app, 'readOnly', { value: false });
  (app as unknown as { bindKeys: () => void }).bindKeys();
  return { canvas, button, cam, doc };
}

/** A keydown as the window hears it, from `target`, with `focus` as the focused element. */
function press(key: string, target: FakeElement, opts: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) {
  const event = {
    key, code: '', ctrlKey: !!opts.ctrl, metaKey: !!opts.meta, shiftKey: !!opts.shift, altKey: false,
    target, preventDefault: vi.fn<() => void>(), stopImmediatePropagation: vi.fn<() => void>(), stopPropagation: vi.fn<() => void>(),
  };
  for (const fn of handlers.get('keydown') ?? []) fn(event);
  return event;
}

describe('Ctrl/Cmd zoom keys on the board', () => {
  it('reset the board to 100% from the canvas, and are prevented', () => {
    const b = board(2);
    b.doc.activeElement = b.canvas;
    const e = press('0', b.canvas, { ctrl: true });
    expect(b.cam.zoom).toBe(1);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('reset from the page body too, and from no focus at all', () => {
    const b = board(2);
    b.doc.activeElement = b.doc.body;
    const e = press('0', b.doc.body, { meta: true });
    expect(b.cam.zoom).toBe(1);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('leave Ctrl/Cmd+0 to the browser with focus on a button: not prevented, the board keeps its zoom', () => {
    const b = board(2);
    b.doc.activeElement = b.button;
    const e = press('0', b.button, { ctrl: true });
    expect(b.cam.zoom).toBe(2);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('zoom the board in and out from the canvas, and are prevented', () => {
    const b = board(1);
    b.doc.activeElement = b.canvas;
    const plus = press('=', b.canvas, { ctrl: true });
    expect(b.cam.zoom).toBeCloseTo(1.25);
    const minus = press('-', b.canvas, { meta: true });
    expect(b.cam.zoom).toBeCloseTo(1);
    expect(plus.preventDefault).toHaveBeenCalledOnce();
    expect(minus.preventDefault).toHaveBeenCalledOnce();
  });

  it('leave zoom in and out to the browser with focus on a button', () => {
    const b = board(1);
    b.doc.activeElement = b.button;
    const plus = press('=', b.button, { ctrl: true });
    const minus = press('-', b.button, { ctrl: true });
    expect(b.cam.zoom).toBe(1);
    expect(plus.preventDefault).not.toHaveBeenCalled();
    expect(minus.preventDefault).not.toHaveBeenCalled();
  });

  it('leave the keys to the browser while a tracker is open over the board', () => {
    const b = board(2);
    const tracker = b.doc.createElement('div');
    tracker.className = 'trk-fullscreen-portal';
    b.doc.body.appendChild(tracker);
    b.doc.activeElement = b.doc.body;
    const e = press('0', b.doc.body, { ctrl: true });
    expect(b.cam.zoom).toBe(2);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('leave Ctrl/Cmd+0 to the browser while the page itself is zoomed, which is what the page-zoom notice asks for', () => {
    const b = board(2);
    vi.stubGlobal('window', { ...(globalThis.window as object), visualViewport: { scale: 2 } });
    b.doc.activeElement = b.canvas;
    const e = press('0', b.canvas, { ctrl: true });
    expect(b.cam.zoom).toBe(2);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
