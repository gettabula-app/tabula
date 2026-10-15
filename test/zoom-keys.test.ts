import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardOwnsGesture, boardOwnsZoomKey, gestureZoomStep, pageIsZoomed, wheelZoomFactor } from '../src/zoom-keys';
import { installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

const as = (el: FakeElement) => el as unknown as Element;

/** The canvas's tab stop with its outline inside, a tool rail, a button, a text field, a dialog and the tracker, all in one page. */
function page() {
  const app = browser.mount();
  const canvas = browser.document.createElement('div');
  canvas.className = 'canvas-focus';
  const outline = browser.document.createElement('ul');
  canvas.appendChild(outline);
  const rail = browser.document.createElement('div');
  rail.className = 'rail';
  const button = browser.document.createElement('button');
  rail.appendChild(button);
  const field = browser.document.createElement('input');
  const dialog = browser.document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const inDialog = browser.document.createElement('div');
  inDialog.setAttribute('tabindex', '-1');
  dialog.appendChild(inDialog);
  const tracker = browser.document.createElement('div');
  tracker.className = 'trk-route-root';
  const menuItem = browser.document.createElement('div');
  menuItem.setAttribute('role', 'menu');
  menuItem.setAttribute('tabindex', '-1');
  for (const el of [canvas, rail, field, dialog, tracker, menuItem]) app.appendChild(el);
  return { app, canvas, outline, rail, button, field, inDialog, tracker, menuItem, body: browser.document.body };
}

describe('boardOwnsZoomKey', () => {
  it('belongs to the board when nothing is focused or focus is on the page body', () => {
    const p = page();
    expect(boardOwnsZoomKey(null, as(p.canvas))).toBe(true);
    expect(boardOwnsZoomKey(as(p.body), as(p.canvas))).toBe(true);
    expect(boardOwnsZoomKey(as(p.body), null)).toBe(true);
  });

  it('belongs to the board when focus is on the canvas tab stop or inside it', () => {
    const p = page();
    expect(boardOwnsZoomKey(as(p.canvas), as(p.canvas))).toBe(true);
    expect(boardOwnsZoomKey(as(p.outline), as(p.canvas))).toBe(true);
  });

  it('leaves the key to the browser for a button, a text field, a dialog, a menu and the tracker', () => {
    const p = page();
    for (const el of [p.button, p.field, p.inDialog, p.menuItem, p.tracker]) {
      expect(boardOwnsZoomKey(as(el), as(p.canvas))).toBe(false);
    }
  });

  it('does not take the key for focus outside the canvas when no canvas is mounted', () => {
    const p = page();
    expect(boardOwnsZoomKey(as(p.button), null)).toBe(false);
    expect(boardOwnsZoomKey(as(p.canvas), null)).toBe(false);
  });
});

describe('boardOwnsGesture', () => {
  function surface() {
    const app = browser.mount();
    const board = browser.document.createElement('div');
    board.className = 'board-surface';
    const svg = browser.document.createElement('svg');
    svg.className = 'canvas';
    const grid = browser.document.createElement('rect');
    svg.appendChild(grid);
    const markdown = browser.document.createElement('textarea');
    markdown.className = 'text-editor';
    const plain = browser.document.createElement('textarea');
    plain.className = 'text-editor';
    board.append(svg, markdown, plain);
    const chrome = browser.document.createElement('div');
    chrome.className = 'chrome';
    const toolbar = browser.document.createElement('button');
    chrome.appendChild(toolbar);
    app.append(board, chrome);
    return { board, svg, grid, markdown, plain, toolbar };
  }

  it('belongs to the board on the canvas and on the board surface itself', () => {
    const s = surface();
    expect(boardOwnsGesture(as(s.svg), as(s.board), null)).toBe(true);
    expect(boardOwnsGesture(as(s.grid), as(s.board), null)).toBe(true);
    expect(boardOwnsGesture(as(s.board), as(s.board), null)).toBe(true);
  });

  it('leaves chrome to the page', () => {
    const s = surface();
    expect(boardOwnsGesture(as(s.toolbar), as(s.board), as(s.markdown))).toBe(false);
  });

  it('leaves plain text editors to the page, and gives the markdown block being edited to the board', () => {
    const s = surface();
    expect(boardOwnsGesture(as(s.plain), as(s.board), as(s.markdown))).toBe(false);
    expect(boardOwnsGesture(as(s.markdown), as(s.board), as(s.markdown))).toBe(true);
    expect(boardOwnsGesture(as(s.markdown), as(s.board), null)).toBe(false);
  });

  it('is false without a target or a surface', () => {
    const s = surface();
    expect(boardOwnsGesture(null, as(s.board), null)).toBe(false);
    expect(boardOwnsGesture(as(s.svg), null, null)).toBe(false);
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
