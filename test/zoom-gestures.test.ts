import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindBoardGestures, type BoardGestureHooks } from '../src/zoom-gestures';
import { wheelZoomFactor } from '../src/zoom-keys';
import { FakeEvent, installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

const as = (el: FakeElement) => el as unknown as Element;

/** One board page as the app mounts it: the board surface (canvas, a markdown block's text box, a sticky's text box) beside the chrome. */
function board() {
  const app = browser.mount();
  const doc = browser.document;
  const surface = doc.createElement('div');
  surface.className = 'board-surface';
  const svg = doc.createElement('svg');
  svg.className = 'canvas';
  const object = doc.createElement('rect');
  svg.appendChild(object);
  const markdown = doc.createElement('textarea');
  markdown.className = 'text-editor';
  const sticky = doc.createElement('textarea');
  sticky.className = 'text-editor';
  surface.append(svg, markdown, sticky);
  const chrome = doc.createElement('div');
  chrome.className = 'chrome';
  const rail = doc.createElement('div');
  rail.className = 'rail';
  const tool = doc.createElement('button');
  rail.appendChild(tool);
  chrome.appendChild(rail);
  app.append(surface, chrome);
  return { doc, surface, svg, object, markdown, sticky, chrome, rail, tool, root: doc.documentElement };
}

/** A DOM event with the fields a browser sets on it: the gesture's scale and point, or a wheel's deltas and modifiers. */
function fire(target: FakeElement, type: string, init: Record<string, unknown> = {}) {
  const event = Object.assign(new FakeEvent(type), init);
  target.dispatchEvent(event);
  return event;
}

function setup(opts: { editing?: boolean; pinching?: boolean } = {}) {
  const p = board();
  const zoomAt = vi.fn<(x: number, y: number, factor: number) => void>();
  let editing = opts.editing ?? false;
  let pinching = opts.pinching ?? false;
  const hooks: BoardGestureHooks = {
    surface: as(p.surface),
    markdownEditor: () => (editing ? as(p.markdown) : null),
    zoomAt,
    touchPinching: () => pinching,
  };
  const gestures = bindBoardGestures(as(p.root) as unknown as EventTarget, hooks, new AbortController().signal);
  return {
    ...p,
    zoomAt,
    gestures,
    setEditing: (on: boolean) => (editing = on),
    setPinching: (on: boolean) => (pinching = on),
  };
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

  it('is left to the page over a plain text editor, even while it is being edited', () => {
    const s = setup({ editing: true });
    const event = fire(s.sticky, 'gesturechange', { scale: 1.3, clientX: 40, clientY: 40 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('over the markdown block being edited, zooms the board and is prevented', () => {
    const s = setup({ editing: true });
    fire(s.markdown, 'gesturestart', { scale: 1, clientX: 90, clientY: 80 });
    const event = fire(s.markdown, 'gesturechange', { scale: 1.2, clientX: 90, clientY: 80 });
    expect(event.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledWith(90, 80, expect.closeTo(1.2));
  });

  it('over the markdown block that is not being edited, is left to the page', () => {
    const s = setup({ editing: false });
    const event = fire(s.markdown, 'gesturechange', { scale: 1.2, clientX: 90, clientY: 80 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });
});

describe('Ctrl/Cmd+wheel over the markdown block being edited', () => {
  it('zooms the board by the wheel step and is prevented', () => {
    const s = setup({ editing: true });
    const event = fire(s.markdown, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 120, clientY: 60 });
    expect(event.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledWith(120, 60, wheelZoomFactor({ deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false }));
  });

  it('after a Safari pinch starts over it, its ctrl+wheel echo is prevented but does not zoom the board a second time', () => {
    const s = setup({ editing: true });
    fire(s.markdown, 'gesturestart', { scale: 1, clientX: 90, clientY: 80 });
    const echo = fire(s.markdown, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 90, clientY: 80 });
    expect(echo.defaultPrevented).toBe(true);
    expect(s.zoomAt).not.toHaveBeenCalled();
    fire(s.markdown, 'gestureend', { scale: 1.2 });
    const after = fire(s.markdown, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 90, clientY: 80 });
    expect(after.defaultPrevented).toBe(true);
    expect(s.zoomAt).toHaveBeenCalledTimes(1);
  });

  it('plain wheel over it still scrolls the text: not prevented, not zooming', () => {
    const s = setup({ editing: true });
    const event = fire(s.markdown, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 120, clientY: 60 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('over a toolbar is not prevented and does not zoom the board', () => {
    const s = setup({ editing: true });
    const event = fire(s.tool, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 20, clientY: 20 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });

  it('over the canvas is left to the canvas wheel handler, which the gestures module does not duplicate', () => {
    const s = setup({ editing: true });
    const event = fire(s.object, 'wheel', { deltaY: -12, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 20, clientY: 20 });
    expect(event.defaultPrevented).toBe(false);
    expect(s.zoomAt).not.toHaveBeenCalled();
  });
});
