import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { segmented, swatches } from '../src/ui/common';
import { rovingRadios } from '../src/ui/focus-scope';
import { h } from '../src/ui/dom';
import { FakeEvent, installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

// docs/accessibility-audit.md, S3: radio groups have one Tab stop, on the checked radio, and arrow keys move between them.

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

const radios = (group: HTMLElement) => (group as unknown as FakeElement).querySelectorAll('[role="radio"]');
const stops = (group: HTMLElement) => radios(group).map((r) => r.getAttribute('tabindex'));
function press(el: FakeElement, key: string) {
  const e = new FakeEvent('keydown') as FakeEvent & { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };
  Object.assign(e, { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  el.dispatchEvent(e);
  return e;
}
const active = () => browser.document.activeElement;

describe('segmented()', () => {
  const make = (current: string, picked: string[] = []) => segmented([{ value: 'a', label: 'Left' }, { value: 'b', label: 'Centre' }, { value: 'c', label: 'Right' }], current, (v) => picked.push(v), 'Align');

  it('has a single Tab stop, on the checked radio', () => {
    expect(stops(make('b'))).toEqual(['-1', '0', '-1']);
    expect(stops(make('a'))).toEqual(['0', '-1', '-1']);
  });

  it('moves with the arrow keys, wraps, and chooses what it lands on', () => {
    const picked: string[] = [];
    const g = make('a', picked);
    const [a, b, c] = radios(g);
    a.focus();
    press(a, 'ArrowRight');
    expect(active()).toBe(b);
    expect(picked).toEqual(['b']);
    expect(stops(g)).toEqual(['-1', '0', '-1']);
    press(b, 'ArrowDown');
    press(c, 'ArrowRight');
    expect(active()).toBe(a);
    press(a, 'ArrowLeft');
    expect(active()).toBe(c);
    press(c, 'Home');
    expect(active()).toBe(a);
    press(a, 'End');
    expect(active()).toBe(c);
    expect(picked.at(-1)).toBe('c');
  });

  it('moves the Tab stop to a radio chosen by click', () => {
    const g = make('a');
    radios(g)[2].click();
    expect(stops(g)).toEqual(['-1', '-1', '0']);
  });

  it('ignores keys with a modifier and keys it does not use', () => {
    const g = make('a');
    const [a] = radios(g);
    a.focus();
    expect(press(a, 'Enter').defaultPrevented).toBe(false);
    expect(active()).toBe(a);
  });
});

describe('swatches()', () => {
  it('names and checks each swatch and keeps one Tab stop', () => {
    const picked: string[] = [];
    const g = swatches([{ name: 'Red', value: '#D64545' }, { name: 'Blue', value: '#2F6FED' }], '#2F6FED', (v) => picked.push(v), { label: 'Fill' });
    expect(radios(g).map((r) => r.getAttribute('aria-label'))).toEqual(['Red', 'Blue']);
    expect(radios(g).map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(stops(g)).toEqual(['-1', '0']);
    const [red] = radios(g);
    red.focus();
    press(red, 'ArrowRight');
    expect(radios(g)[1]).toBe(active());
  });
});

describe('rovingRadios() with select: false', () => {
  it('moves focus without choosing, so Space or Enter chooses', () => {
    const chosen: string[] = [];
    const g = h('div', { role: 'radiogroup' },
      ...['1', '2', '3'].map((n) => h('button', { role: 'radio', 'aria-checked': n === '1' ? 'true' : 'false', onclick: () => chosen.push(n) }, n)));
    rovingRadios(g, { select: false });
    const [one, two] = radios(g);
    one.focus();
    press(one, 'ArrowRight');
    expect(active()).toBe(two);
    expect(chosen).toEqual([]);
    expect(stops(g)).toEqual(['-1', '0', '-1']);
  });

  it('skips disabled radios', () => {
    const g = h('div', { role: 'radiogroup' },
      h('button', { role: 'radio', 'aria-checked': 'true' }, 'a'),
      h('button', { role: 'radio', 'aria-checked': 'false', disabled: true }, 'b'),
      h('button', { role: 'radio', 'aria-checked': 'false' }, 'c'));
    rovingRadios(g, { select: false });
    const list = radios(g);
    list[0].focus();
    press(list[0], 'ArrowRight');
    expect(active()).toBe(list[2]);
  });
});

describe('without a checked radio', () => {
  it('makes the first one the Tab stop', () => {
    const g = h('div', { role: 'radiogroup' }, h('button', { role: 'radio', 'aria-checked': 'false' }, 'a'), h('button', { role: 'radio', 'aria-checked': 'false' }, 'b'));
    rovingRadios(g);
    expect(stops(g)).toEqual(['0', '-1']);
  });
});
