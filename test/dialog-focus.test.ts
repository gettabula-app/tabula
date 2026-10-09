import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialog, popover } from '../src/ui/common';
import { h } from '../src/ui/dom';
import { FakeElement, installFakeBrowser, need, type FakeBrowser } from './fake-dom';

// docs/accessibility-audit.md, C2 and S1: dialog() and popover() keep Tab inside, make the page behind a dialog inert, name
// themselves, and give focus back to what opened them. Rendered into the fake DOM (test/fake-dom.ts); window events are
// collected here so a key press can be sent to the listeners the way the browser would.

let browser: FakeBrowser;
let listeners: Map<string, ((e: unknown) => void)[]>;
const body = () => browser.document.body;
const active = () => browser.document.activeElement;

function press(key: string, shiftKey = false) {
  const e = { key, shiftKey, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { /* the capture listeners run first, as in the browser */ } };
  for (const phase of ['keydown-capture', 'keydown']) for (const fn of listeners.get(phase) ?? []) fn(e);
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  browser = installFakeBrowser();
  listeners = new Map();
  const add = (type: string, fn: (e: unknown) => void, capture?: boolean | AddEventListenerOptions) => {
    const k = capture === true ? `${type}-capture` : type;
    listeners.set(k, [...(listeners.get(k) ?? []), fn]);
  };
  const remove = (type: string, fn: (e: unknown) => void, capture?: boolean | AddEventListenerOptions) => {
    const k = capture === true ? `${type}-capture` : type;
    listeners.set(k, (listeners.get(k) ?? []).filter((f) => f !== fn));
  };
  vi.stubGlobal('window', { setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a), clearTimeout, addEventListener: add, removeEventListener: remove, innerWidth: 1024, innerHeight: 800 });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  browser.uninstall();
});

const page = () => {
  const app = h('div', { id: 'app' }, h('button', { id: 'opener' }, 'Menu'));
  const toast = h('div', { class: 'toast' });
  body().append(app as unknown as FakeElement, toast as unknown as FakeElement);
  return { app: app as unknown as FakeElement, toast: toast as unknown as FakeElement, opener: need(app as unknown as FakeElement, '#opener') };
};

describe('dialog()', () => {
  it('names itself from its heading and starts on the first field', () => {
    const { opener } = page();
    opener.focus();
    const field = h('input', { 'aria-label': 'Name' });
    const d = dialog('Rename', h('div', null, field), [{ label: 'Save', primary: true }]);
    const box = d.box as unknown as FakeElement;
    const heading = need(box, 'h2');
    expect(box.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(box.getAttribute('aria-label')).toBeNull();
    expect(active()).toBe(field);
  });

  it('starts on its Close button when it has no field or main button', () => {
    page();
    const d = dialog('Icon credits', h('p', null, 'Credits'));
    expect(active()).toBe(need(d.box as unknown as FakeElement, 'button[aria-label="Close"]'));
  });

  it('wraps Tab at the last control and Shift+Tab at the first', () => {
    page();
    const d = dialog('Pick', h('div', null, h('input', { 'aria-label': 'A' })), [{ label: 'Cancel' }, { label: 'OK', primary: true }]);
    const box = d.box as unknown as FakeElement;
    const close = need(box, 'button[aria-label="Close"]');
    const ok = box.querySelectorAll('button').find((b) => b.textContent === 'OK')!;
    ok.focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(active()).toBe(close);
    expect(press('Tab', true).defaultPrevented).toBe(true);
    expect(active()).toBe(ok);
    // in the middle the browser's own Tab is left alone
    box.querySelector('input')!.focus();
    expect(press('Tab').defaultPrevented).toBe(false);
  });

  it('brings focus back in when Tab is pressed from outside', () => {
    const { opener } = page();
    const d = dialog('Pick', h('p', null, 'x'), [{ label: 'OK', primary: true }]);
    opener.focus();
    press('Tab');
    expect(d.box.contains(active() as unknown as Node)).toBe(true);
  });

  it('makes the page behind it inert, except the toast, and undoes only its own', () => {
    const { app, toast } = page();
    const first = dialog('One', h('p', null, 'x'));
    const firstBack = first.box.parentNode as unknown as FakeElement;
    expect(app.inert).toBe(true);
    expect(toast.inert).toBe(false);
    expect(firstBack.inert).toBe(false);
    const second = dialog('Two', h('p', null, 'y'));
    expect(firstBack.inert).toBe(true);
    second.close();
    expect(firstBack.inert).toBe(false);
    expect(app.inert).toBe(true);
    first.close();
    expect(app.inert).toBe(false);
  });

  it('gives focus back to the control that opened it, on Escape and on close()', () => {
    const { opener } = page();
    opener.focus();
    dialog('One', h('p', null, 'x'));
    expect(active()).not.toBe(opener);
    press('Escape');
    expect(active()).toBe(opener);
    const d = dialog('Two', h('p', null, 'x'));
    d.close();
    expect(active()).toBe(opener);
  });

  it('does not restore focus to an opener that is gone', () => {
    const { app, opener } = page();
    opener.focus();
    const d = dialog('One', h('p', null, 'x'));
    app.removeChild(opener);
    d.close();
    expect(active()).not.toBe(opener);
  });
});

describe('popover()', () => {
  const menu = () => h('div', { class: 'menu' }, h('button', { class: 'menu-item' }, 'One'), h('button', { class: 'menu-item' }, 'Two'));

  it('is named after its opener and marks the opener expanded while open', () => {
    const { opener } = page();
    opener.setAttribute('aria-label', 'Board menu');
    const p = popover(opener as unknown as HTMLElement, menu());
    expect(p.el.getAttribute('aria-label')).toBe('Board menu');
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog');
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    p.close();
    expect(opener.getAttribute('aria-expanded')).toBe('false');
  });

  it('takes an explicit label, and always has some name', () => {
    const { opener } = page();
    expect(popover(opener as unknown as HTMLElement, menu(), { label: 'Object actions' }).el.getAttribute('aria-label')).toBe('Object actions');
    opener.textContent = '';
    expect(popover(opener as unknown as HTMLElement, menu()).el.getAttribute('aria-label')).toBe('Options');
  });

  it('moves focus to its first control, keeps Tab inside, and returns focus on Escape', () => {
    const { opener } = page();
    opener.focus();
    const p = popover(opener as unknown as HTMLElement, menu());
    const items = (p.el as unknown as FakeElement).querySelectorAll('button');
    expect(active()).toBe(items[0]);
    items[1].focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(active()).toBe(items[0]);
    expect(press('Tab', true).defaultPrevented).toBe(true);
    expect(active()).toBe(items[1]);
    press('Escape');
    expect(p.el.isConnected).toBe(false);
    expect(active()).toBe(opener);
  });

  it('does not take focus back when it closes while focus is already somewhere else', () => {
    const { app, opener } = page();
    const other = h('button', { id: 'other' }, 'Other');
    app.append(other as unknown as FakeElement);
    const p = popover(opener as unknown as HTMLElement, menu());
    (other as unknown as FakeElement).focus();
    p.close();
    expect(active()).toBe(other);
  });

  it('leaves Tab to the dialog when a popover opened from inside it is not holding focus', () => {
    page();
    const d = dialog('Pick', h('p', null, 'x'), [{ label: 'OK', primary: true }]);
    const ok = (d.box as unknown as FakeElement).querySelectorAll('button').find((b) => b.textContent === 'OK')!;
    ok.focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(active()).not.toBe(ok);
  });
});
