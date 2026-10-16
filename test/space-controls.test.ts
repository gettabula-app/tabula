import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlTakesSpace, keyTarget } from '../src/key-targets';
import { installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

// TAB-407: Space and Enter belong to the focused control (a rail button, a link, a field, a menu item, a focused region), and Space
// pans the board only when focus is on the board itself or on nothing interactive. The rule is pure, so it is tested here on DOM elements.

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

const as = (el: FakeElement) => el as unknown as Element;

/** An element as the page mounts it: a tag, a class, attributes, and whether it is editable (its isContentEditable). */
function make(tag: string, opts: { className?: string; attrs?: Record<string, string>; editable?: boolean } = {}): FakeElement {
  const el = browser.document.createElement(tag);
  if (opts.className) el.className = opts.className;
  for (const [name, value] of Object.entries(opts.attrs ?? {})) el.setAttribute(name, value);
  if (opts.editable) (el as unknown as { isContentEditable: boolean }).isContentEditable = true;
  return el;
}

/**
 * The board as the app mounts it: the surface with the canvas (the SVG) and the canvas's tab stop in it, a sticky on it, a rail button
 * beside it, and the page body. Built inside each test, after the fake browser is in place.
 */
function scene() {
  const app = browser.mount();
  const surface = make('div', { className: 'board-surface' });
  const canvas = make('svg', { className: 'canvas' });
  const focus = make('div', { className: 'canvas-focus', attrs: { role: 'application', tabindex: '0' } });
  const sticky = make('div', { className: 'sticky' });
  const stickyLabel = make('span');
  sticky.appendChild(stickyLabel);
  surface.appendChild(canvas);
  surface.appendChild(focus);
  surface.appendChild(sticky);
  app.appendChild(surface);
  const rail = make('div', { className: 'rail-tools' });
  const railButton = make('button', { className: 'rail-btn', attrs: { 'aria-label': 'Frame' } });
  const railIcon = make('span');
  railButton.appendChild(railIcon);
  rail.appendChild(railButton);
  app.appendChild(rail);
  return { surface, canvas, focus, sticky, stickyLabel, railButton, railIcon, body: browser.document.body };
}

type Scene = ReturnType<typeof scene>;

// each row: what the focused element is, and whether it takes Space. The element is made inside the test, never at collection time.
const rows: Array<[string, (s: Scene) => FakeElement | null, boolean]> = [
  ['a button', () => make('button'), true],
  ['a link with an address', () => make('a', { attrs: { href: '#notes' } }), true],
  ['a link without an address', () => make('a'), false],
  ['a text input', () => make('input'), true],
  ['a select', () => make('select'), true],
  ['a textarea', () => make('textarea'), true],
  ['a disclosure summary', () => make('summary'), true],
  ['a div with role button', () => make('div', { attrs: { role: 'button' } }), true],
  ['a div with role menuitem', () => make('div', { attrs: { role: 'menuitem' } }), true],
  ['a div with role menuitemradio', () => make('div', { attrs: { role: 'menuitemradio' } }), true],
  ['a div with role tab', () => make('div', { attrs: { role: 'tab' } }), true],
  ['a div with role switch', () => make('div', { attrs: { role: 'switch' } }), true],
  ['a div with role slider', () => make('div', { attrs: { role: 'slider' } }), true],
  ['a div with tabindex 0', () => make('div', { attrs: { tabindex: '0' } }), true],
  ['a div with tabindex -1', () => make('div', { attrs: { tabindex: '-1' } }), false],
  ['a plain div', () => make('div'), false],
  ['a contenteditable element', () => make('div', { attrs: { contenteditable: 'true' } }), true],
  ['an element that is content editable', () => make('div', { editable: true }), true],
  ['a contenteditable=false element', () => make('div', { attrs: { contenteditable: 'false' } }), false],
  ['a span inside a button', (s) => s.railIcon, true],
  ['the rail button itself', (s) => s.railButton, true],
  ['the canvas tab stop (the pan target)', (s) => s.focus, false],
  ['the board surface', (s) => s.surface, false],
  ['the canvas SVG', (s) => s.canvas, false],
  ['a sticky on the board', (s) => s.sticky, false],
  ['a span inside a sticky on the board', (s) => s.stickyLabel, false],
  ['the page body', (s) => s.body, false],
  ['nothing focused', () => null, false],
];

describe('controlTakesSpace', () => {
  it.each(rows)('%s', (_what, pick, expected) => {
    const s = scene();
    const el = pick(s);
    expect(controlTakesSpace(el ? as(el) : null)).toBe(expected);
  });

  it('is true for a span inside a focusable region, such as a scrolling list', () => {
    const region = make('div', { attrs: { tabindex: '0' } });
    const inner = make('span');
    region.appendChild(inner);
    browser.mount().appendChild(region);
    expect(controlTakesSpace(as(inner))).toBe(true);
  });

  it('is true for a control inside the board surface, such as a code button over the canvas', () => {
    const s = scene();
    const copy = make('button', { className: 'code-copy' });
    s.surface.appendChild(copy);
    expect(controlTakesSpace(as(copy))).toBe(true);
  });

  it('is false for a plain element that sits on the page body, outside any control', () => {
    const outside = make('p');
    browser.document.body.appendChild(outside);
    expect(controlTakesSpace(as(outside))).toBe(false);
  });
});

describe('keyTarget and a host without DOM classes', () => {
  it('never throws on a target that is not a DOM element, and counts it as no control', () => {
    const bare = { tagName: 'DIV' } as unknown as Element; // a fake element: no classList, getAttribute or parentNode
    expect(() => controlTakesSpace(bare)).not.toThrow();
    expect(controlTakesSpace(bare)).toBe(false);
    expect(controlTakesSpace({} as unknown as Element)).toBe(false);
    expect(controlTakesSpace(null)).toBe(false);
  });
  it('uses the target when it has a tag name, else the focused element when it has one', () => {
    const target = { tagName: 'BUTTON' } as unknown as Element;
    expect(keyTarget({ target })).toBe(target);
    const active = document.activeElement;
    expect(keyTarget({ target: null })).toBe(active && typeof active.tagName === 'string' ? active : null);
    expect(keyTarget({ target: {} })).toBe(active && typeof active.tagName === 'string' ? active : null);
  });
});
