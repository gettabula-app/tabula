import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardApp } from '../src/app';
import { bindBoardGestures, type BoardGestureHooks } from '../src/zoom-gestures';
import { wheelZoomFactor } from '../src/zoom-keys';
import { FakeEvent, installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

const as = (el: FakeElement) => el as unknown as Element;

/**
 * One board page as the app mounts it: the board surface with the canvas, the text editor's one box and the kanban card input in it,
 * the tracker's frame overlay in it, and the chrome beside it.
 */
function board() {
  const app = browser.mount();
  const doc = browser.document;
  const make = (tag: string, className?: string) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    return el;
  };
  const surface = make('div', 'board-surface');
  const svg = make('svg', 'canvas');
  const object = make('rect');
  svg.appendChild(object);
  const text = make('textarea', 'text-editor');
  const card = make('div', 'k-input-wrap');
  const cardInput = make('input', 'k-input');
  card.appendChild(cardInput);
  const frames = make('div', 'trk-frame-overlay');
  const frame = make('div', 'trk-frame-wrap');
  frames.appendChild(frame);
  surface.append(svg, text, card, frames);
  const chrome = make('div', 'chrome');
  const rail = make('div', 'rail');
  const tool = make('button');
  rail.appendChild(tool);
  chrome.appendChild(rail);
  app.append(surface, chrome);
  return { doc, surface, svg, object, text, card, cardInput, frame, tool, root: doc.documentElement };
}

/** A DOM event with the fields a browser sets on it: the gesture's scale and point, or a wheel's deltas and modifiers. */
function fire(target: FakeElement, type: string, init: Record<string, unknown> = {}) {
  const event = Object.assign(new FakeEvent(type), init);
  target.dispatchEvent(event);
  return event;
}

function setup(opts: { pinching?: boolean } = {}) {
  const p = board();
  const zoomAt = vi.fn<(x: number, y: number, factor: number) => void>();
  let open: FakeElement[] = [];
  let pinching = opts.pinching ?? false;
  const hooks: BoardGestureHooks = {
    board: { surface: as(p.surface), canvas: as(p.svg) },
    editors: () => open.map((el) => as(el)),
    zoomAt,
    touchPinching: () => pinching,
  };
  const gestures = bindBoardGestures(as(p.root) as unknown as EventTarget, hooks, new AbortController().signal);
  return {
    ...p,
    zoomAt,
    gestures,
    setOpen: (...els: FakeElement[]) => (open = els),
    setPinching: (on: boolean) => (pinching = on),
  };
}

/**
 * The kinds of in-place editor. The text editor has one box for all of them and marks it with its mode and the object's type
 * (src/editor.ts), so each kind is that box marked as the editor marks it; the kanban card title is a second element.
 */
const EDITOR_KINDS = [
  { name: 'sticky note', kind: 'sticky', mode: 'text' },
  { name: 'label', kind: 'connector', mode: 'label' },
  { name: 'frame name', kind: 'frame', mode: 'frame' },
  { name: 'code block', kind: 'code', mode: 'text' },
  { name: 'table cell', kind: 'table', mode: 'cell' },
  { name: 'Markdown block', kind: 'markdown', mode: 'text' },
  { name: 'class', kind: 'uml-class', mode: 'class' },
];

/** The text editor's box, opened for one kind of editor. */
function openKind(s: ReturnType<typeof setup>, kind: { kind: string; mode: string }) {
  s.text.setAttribute('data-kind', kind.kind);
  s.text.setAttribute('data-mode', kind.mode);
  s.setOpen(s.text);
}

describe('Safari trackpad pinch on the board', () => {
  it('zooms the board around the pinch point by the ratio of the scale steps, and stops the page zoom', () => {
    const s = setup();
    const start = fire(s.svg, 'gesturestart', { scale: 1, clientX: 300, clientY: 200 });
    expect(start.defaultPrevented).toBe(true);
    expect(s.gestures.gesturing()).toBe(true);

    const first = fire(s.svg, 'gesturechange', { scale: 1.1, clientX: 300, clientY: 200 });
    const second = fire(s.svg, 'gesturechange', { scale: 1.21, clientX: 310, clientY: 190 });
    expect(first.defaultPrevented && second.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledTimes(2);
    expect(s.zoomAt.mock.calls[0]![0]).toBe(300);
    expect(s.zoomAt.mock.calls[0]![1]).toBe(200);
    expect(s.zoomAt.mock.calls[0]![2]).toBeCloseTo(1.1);
    expect(s.zoomAt.mock.calls[1]![0]).toBe(310);
    expect(s.zoomAt.mock.calls[1]![2]).toBeCloseTo(1.1);

    const end = fire(s.svg, 'gestureend', { scale: 1.21 });
    expect(end.defaultPrevented).toBe(true);
    expect(s.gestures.gesturing()).toBe(false);
  });

  it('starts each pinch from its own first scale, so a new gesture does not jump', () => {
    const s = setup();
    fire(s.svg, 'gesturestart', { scale: 1, clientX: 0, clientY: 0 });
    fire(s.svg, 'gesturechange', { scale: 2, clientX: 0, clientY: 0 });
    fire(s.svg, 'gestureend', { scale: 2 });
    fire(s.svg, 'gesturestart', { scale: 1, clientX: 0, clientY: 0 });
    fire(s.svg, 'gesturechange', { scale: 1.5, clientX: 0, clientY: 0 });
    expect(s.zoomAt.mock.calls.at(-1)![2]).toBeCloseTo(1.5);
  });

  it('does not zoom the board again while a touch pinch is zooming it, but still stops the page zoom', () => {
    const s = setup({ pinching: true });
    fire(s.svg, 'gesturestart', { scale: 1, clientX: 0, clientY: 0 });
    const change = fire(s.svg, 'gesturechange', { scale: 1.4, clientX: 0, clientY: 0 });
    expect(change.defaultPrevented).toBe(true);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('is left to the page over chrome: not prevented and not zooming the board', () => {
    const s = setup();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      const event = fire(s.tool, type, { scale: 1.3, clientX: 40, clientY: 40 });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('is left to the page over the tracker frames mounted in the board surface, while an editor is open', () => {
    const s = setup();
    s.setOpen(s.text);
    const event = fire(s.frame, 'gesturechange', { scale: 1.3, clientX: 40, clientY: 40 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('over a closed text box in the board surface is left to the page', () => {
    const s = setup();
    const event = fire(s.text, 'gesturechange', { scale: 1.2, clientX: 90, clientY: 80 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it.each(EDITOR_KINDS)('over a $name being edited, zooms the board and is prevented', (kind) => {
    const s = setup();
    openKind(s, kind);
    fire(s.text, 'gesturestart', { scale: 1, clientX: 90, clientY: 80 });
    const event = fire(s.text, 'gesturechange', { scale: 1.2, clientX: 90, clientY: 80 });
    expect(event.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledWith(90, 80, expect.closeTo(1.2));
  });

  it.each(EDITOR_KINDS)('over a toolbar while a $name is being edited, is left to the page', (kind) => {
    const s = setup();
    openKind(s, kind);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      expect(fire(s.tool, type, { scale: 1.3, clientX: 20, clientY: 20 }).defaultPrevented).toBe(false);
    }
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('over a kanban card title being typed, zooms the board and is prevented', () => {
    const s = setup();
    s.setOpen(s.cardInput);
    fire(s.cardInput, 'gesturestart', { scale: 1, clientX: 50, clientY: 60 });
    const event = fire(s.cardInput, 'gesturechange', { scale: 0.8, clientX: 50, clientY: 60 });
    expect(event.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledWith(50, 60, expect.closeTo(0.8));
  });
});

describe('Ctrl/Cmd+wheel over an in-place editor being edited', () => {
  it.each(EDITOR_KINDS)('over a $name being edited, zooms the board by the wheel step and is prevented', (kind) => {
    const s = setup();
    openKind(s, kind);
    const event = fire(s.text, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 120, clientY: 60 });
    expect(event.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledWith(120, 60, wheelZoomFactor({ deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false }));
  });

  it.each(EDITOR_KINDS)('over a $name being edited, a Cmd+wheel zooms the board and is prevented', (kind) => {
    const s = setup();
    openKind(s, kind);
    const event = fire(s.text, 'wheel', { deltaY: 30, deltaMode: 0, ctrlKey: false, metaKey: true, clientX: 10, clientY: 10 });
    expect(event.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledWith(10, 10, wheelZoomFactor({ deltaY: 30, deltaMode: 0, ctrlKey: false, metaKey: true }));
  });

  it.each(EDITOR_KINDS)('over a toolbar while a $name is being edited, is not prevented and does not zoom the board', (kind) => {
    const s = setup();
    openKind(s, kind);
    const event = fire(s.tool, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 20, clientY: 20 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('over a kanban card title being typed, zooms the board and is prevented', () => {
    const s = setup();
    s.setOpen(s.cardInput);
    const event = fire(s.cardInput, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 70, clientY: 30 });
    expect(event.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledWith(70, 30, wheelZoomFactor({ deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false }));
  });

  it('over a text box that is closed, is not prevented and does not zoom the board', () => {
    const s = setup();
    const event = fire(s.text, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 120, clientY: 60 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('after a Safari pinch starts over an open editor, its ctrl+wheel echo is prevented but does not zoom the board a second time', () => {
    const s = setup();
    openKind(s, EDITOR_KINDS[5]!);
    fire(s.text, 'gesturestart', { scale: 1, clientX: 90, clientY: 80 });
    const echo = fire(s.text, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 90, clientY: 80 });
    expect(echo.defaultPrevented).toBe(true);
    expect(s.zoomAt).not.toHaveBeenCalled();
    fire(s.text, 'gestureend', { scale: 1.2 });
    const after = fire(s.text, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 90, clientY: 80 });
    expect(after.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledTimes(1);
  });

  it('plain wheel over an open editor still scrolls the text: not prevented, not zooming', () => {
    const s = setup();
    openKind(s, EDITOR_KINDS[0]!);
    const event = fire(s.text, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 120, clientY: 60 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('over the canvas is left to the canvas wheel handler, which the gestures module does not duplicate', () => {
    const s = setup();
    openKind(s, EDITOR_KINDS[0]!);
    const event = fire(s.object, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 20, clientY: 20 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });
});

describe('the in-place editors open over the board (BoardApp.openEditors)', () => {
  it('are the text box while it is open and the kanban card title while it is being typed', () => {
    const s = board();
    const app = Object.create(BoardApp.prototype) as Record<string, unknown>;
    const editor = { active: false, textarea: as(s.text) };
    const cardInput = { active: null as string | null, element: as(s.card) };
    Object.assign(app, { editor, cardInput });
    const openEditors = (app as unknown as { openEditors(): Element[] }).openEditors.bind(app);

    expect(openEditors()).toEqual([]);

    editor.active = true;
    expect(openEditors()).toHaveLength(1);
    expect(openEditors()[0]).toBe(as(s.text));

    cardInput.active = 'lane-1';
    expect(openEditors()).toHaveLength(2);
    expect(openEditors()[1]).toBe(as(s.card));

    editor.active = false;
    cardInput.active = null;
    expect(openEditors()).toEqual([]);
  });
});
