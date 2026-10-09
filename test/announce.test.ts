import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../src/ui/announce';
import { dialog } from '../src/ui/common';
import { h } from '../src/ui/dom';
import { installFakeBrowser, need, type FakeBrowser, type FakeElement } from './fake-dom';

// docs/accessibility-audit.md, S4: the visually hidden live region that says what changed on the board.

let browser: FakeBrowser;
const region = () => need(browser.document.body, '.sr-only');
const said = () => region().textContent.replace(/ /g, '');

beforeEach(() => {
  vi.useFakeTimers();
  browser = installFakeBrowser();
  vi.stubGlobal('window', { setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a), clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1024, innerHeight: 800 });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  browser.uninstall();
});

describe('announce()', () => {
  it('writes into one polite status region that is created once', () => {
    announce('Deleted 2 objects');
    expect(region().getAttribute('role')).toBe('status');
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(region().getAttribute('aria-atomic')).toBe('true');
    expect(said()).toBe('Deleted 2 objects');
    announce('Undone');
    expect(browser.document.body.querySelectorAll('.sr-only')).toHaveLength(1);
    expect(said()).toBe('Undone');
  });

  it('changes the text when the same words are said twice, so they are read again', () => {
    announce('Undone');
    const first = region().textContent;
    announce('Undone');
    expect(region().textContent).not.toBe(first);
    expect(said()).toBe('Undone');
  });

  it('says only the last of a burst under one key, after the delay', () => {
    announce('3 of 5 dots left', { key: 'dots', delay: 500 });
    announce('2 of 5 dots left', { key: 'dots', delay: 500 });
    expect(browser.document.body.querySelector('.sr-only')).toBeNull();
    vi.advanceTimersByTime(499);
    expect(browser.document.body.querySelector('.sr-only')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(said()).toBe('2 of 5 dots left');
  });

  it('joins messages under one key when asked to merge', () => {
    announce('Ana joined', { key: 'presence', delay: 700, merge: true });
    announce('Ben left', { key: 'presence', delay: 700, merge: true });
    vi.advanceTimersByTime(700);
    expect(said()).toBe('Ana joined. Ben left');
  });

  it('keeps separate keys apart', () => {
    announce('Sync: Live', { key: 'sync', delay: 100 });
    announce('Timer started', { key: 'timer', delay: 100 });
    vi.advanceTimersByTime(100);
    expect(said()).toBe('Timer started');
  });

  it('is not made inert by an open dialog, so it still announces', () => {
    announce('Ready');
    const live = region() as FakeElement;
    dialog('One', h('p', null, 'x'));
    expect(live.inert).toBe(false);
  });
});
