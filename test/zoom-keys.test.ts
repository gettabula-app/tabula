import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardOwnsGesture, boardOwnsZoomKey, gestureZoomStep, pageIsZoomed, takesTyping, wheelZoomFactor } from '../src/zoom-keys';
import { installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

const as = (el: FakeElement) => el as unknown as Element;

/** An element with a class, or with attributes, as the page mounts it. */
function make(tag: string, opts: { className?: string; attrs?: Record<string, string>; editable?: boolean } = {}): FakeElement {
  const el = browser.document.createElement(tag);
  if (opts.className) el.className = opts.className;
  for (const [name, value] of Object.entries(opts.attrs ?? {})) el.setAttribute(name, value);
  if (opts.editable) (el as unknown as { isContentEditable: boolean }).isContentEditable = true;
  return el;
}

/** What focus can be on: a canvas tab stop, a toolbar button, a text field, a select, a textarea, an editable area, a dialog, a menu and the tracker. */
function page() {
  const app = browser.mount();
  const canvas = make('div', { className: 'canvas-focus' });
  const button = make('button');
  const field = make('input');
  const select = make('select');
  const textarea = make('textarea');
  const editable = make('div', { editable: true });
  const inEditable = make('span', { editable: true });
  editable.appendChild(inEditable);
  const dialog = make('div', { attrs: { role: 'dialog' } });
  const inDialog = make('div', { attrs: { tabindex: '-1' } });
  dialog.appendChild(inDialog);
  const menuItem = make('div', { attrs: { role: 'menu', tabindex: '-1' } });
  const tracker = make('div', { className: 'trk-route-root' });
  for (const el of [canvas, button, field, select, textarea, editable, dialog, menuItem, tracker]) app.appendChild(el);
  return { app, canvas, button, field, select, textarea, editable, inEditable, inDialog, menuItem, tracker, body: browser.document.body };
}

describe('takesTyping', () => {
  it('is true for a text field, a select, a textarea and an editable area, and for what is inside one', () => {
    const p = page();
    for (const el of [p.field, p.select, p.textarea, p.editable, p.inEditable]) expect(takesTyping(as(el))).toBe(true);
  });

  it('is false for a button, the canvas and the page body', () => {
    const p = page();
    for (const el of [p.button, p.canvas, p.body]) expect(takesTyping(as(el))).toBe(false);
  });
});

describe('boardOwnsZoomKey', () => {
  it('belongs to the board with nothing focused, on the page body, on the canvas, and on a toolbar button', () => {
    const p = page();
    expect(boardOwnsZoomKey(null, false)).toBe(true);
    expect(boardOwnsZoomKey(as(p.body), false)).toBe(true);
    expect(boardOwnsZoomKey(as(p.canvas), false)).toBe(true);
    expect(boardOwnsZoomKey(as(p.button), false)).toBe(true);
  });

  it('is left to the browser in a text field, a select, a textarea and an editable area', () => {
    const p = page();
    for (const el of [p.field, p.select, p.textarea, p.editable, p.inEditable]) {
      expect(boardOwnsZoomKey(as(el), false)).toBe(false);
    }
  });

  it('is left to the browser while a dialog, a popover or the tracker is open, whatever has focus', () => {
    const p = page();
    for (const el of [p.button, p.body, p.inDialog, p.menuItem, p.tracker]) {
      expect(boardOwnsZoomKey(as(el), true)).toBe(false);
    }
    expect(boardOwnsZoomKey(null, true)).toBe(false);
  });
});

describe('boardOwnsGesture', () => {
  /** The board as the app mounts it: the surface with the canvas, the one text editor's box, the kanban card input, the tracker's frame overlay and the code buttons; and the chrome beside it. */
  function mountBoard() {
    const app = browser.mount();
    const surface = make('div', { className: 'board-surface' });
    const canvas = make('svg', { className: 'canvas' });
    const object = make('rect');
    canvas.appendChild(object);
    const text = make('textarea', { className: 'text-editor' });
    const card = make('div', { className: 'k-input-wrap' });
    const cardInput = make('input', { className: 'k-input' });
    card.appendChild(cardInput);
    const frames = make('div', { className: 'trk-frame-overlay' });
    const frame = make('div', { className: 'trk-frame-wrap' });
    frames.appendChild(frame);
    const codeButtons = make('div', { className: 'code-ctl-layer' });
    const codeButton = make('button');
    codeButtons.appendChild(codeButton);
    surface.append(canvas, text, card, frames, codeButtons);
    const chrome = make('div', { className: 'chrome' });
    const toolbar = make('button');
    chrome.appendChild(toolbar);
    app.append(surface, chrome);
    const parts = { surface: as(surface), canvas: as(canvas) };
    return { parts, object, text, card, cardInput, frame, codeButton, toolbar };
  }

  it('belongs to the board on the canvas and on the board surface itself', () => {
    const s = mountBoard();
    expect(boardOwnsGesture(s.parts.canvas, s.parts, [])).toBe(true);
    expect(boardOwnsGesture(as(s.object), s.parts, [])).toBe(true);
    expect(boardOwnsGesture(s.parts.surface, s.parts, [])).toBe(true);
  });

  it('belongs to an open in-place editor, its element and what is inside it', () => {
    const s = mountBoard();
    expect(boardOwnsGesture(as(s.text), s.parts, [as(s.text)])).toBe(true);
    expect(boardOwnsGesture(as(s.card), s.parts, [as(s.card)])).toBe(true);
    expect(boardOwnsGesture(as(s.cardInput), s.parts, [as(s.card)])).toBe(true);
  });

  it('leaves a closed editor, the tracker frames, the code buttons and the chrome to the page', () => {
    const s = mountBoard();
    const open = [as(s.text), as(s.card)];
    expect(boardOwnsGesture(as(s.text), s.parts, [])).toBe(false);
    expect(boardOwnsGesture(as(s.card), s.parts, [as(s.text)])).toBe(false);
    expect(boardOwnsGesture(as(s.frame), s.parts, open)).toBe(false);
    expect(boardOwnsGesture(as(s.codeButton), s.parts, open)).toBe(false);
    expect(boardOwnsGesture(as(s.toolbar), s.parts, open)).toBe(false);
  });

  it('is false without a target or a board', () => {
    const s = mountBoard();
    expect(boardOwnsGesture(null, s.parts, [])).toBe(false);
    expect(boardOwnsGesture(as(s.object), null, [])).toBe(false);
  });
});

describe('gestureZoomStep', () => {
  it('is the ratio of consecutive Safari scales', () => {
    expect(gestureZoomStep(1, 1.25)).toBeCloseTo(1.25);
    expect(gestureZoomStep(1.25, 1.0)).toBeCloseTo(0.8);
  });

  it('changes nothing for the first step or an unusable scale', () => {
    expect(gestureZoomStep(undefined, 1.3)).toBe(1);
    expect(gestureZoomStep(0, 1.3)).toBe(1);
    expect(gestureZoomStep(1, 0)).toBe(1);
    expect(gestureZoomStep(Number.NaN, 1.3)).toBe(1);
    expect(gestureZoomStep(1, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in for a wheel step up and out for one down, and a Ctrl pinch step faster than a plain Ctrl wheel', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false })).toBeCloseTo(Math.exp(0.25));
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false, metaKey: false })).toBeCloseTo(Math.exp(-0.25));
    expect(wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true, metaKey: false })).toBeCloseTo(Math.exp(10 * 0.0025 * 3));
    expect(wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true, metaKey: true })).toBeCloseTo(Math.exp(10 * 0.0025));
  });
});

describe('pageIsZoomed', () => {
  it('is true when the page is pinched or browser-zoomed', () => {
    expect(pageIsZoomed(1.5, 2, 2)).toBe(true);
    expect(pageIsZoomed(undefined, 1.25, 2)).toBe(true);
  });

  it('is false at 100% and without a visual viewport to report a pinch', () => {
    expect(pageIsZoomed(1, 2, 2)).toBe(false);
    expect(pageIsZoomed(undefined, 2, 2)).toBe(false);
  });
});
