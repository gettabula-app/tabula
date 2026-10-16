import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../src/api';
import { createRestartNotice } from '../src/restart-notice';
import { mountRestartNote } from '../src/ui/restart-note';
import { installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

// docs/cloud.md, Restart: the one note for a planned restart. It is a status region that takes no focus, has a Dismiss button,
// recounts its sentence every 30 s on the page's own clock, and never puts server text into the page as markup.

let browser: FakeBrowser;
let clockMs: number;
let handle: { update(workspace: Workspace | null | undefined): void; dispose(): void } | null = null;

const MINUTE_TEXT = (n: number) => `The server restarts in about ${n} ${n === 1 ? 'minute' : 'minutes'}. Your changes are kept and the page reconnects by itself.`;
const SOON = 'The server restarts in less than a minute. Your changes are kept and the page reconnects by itself.';

function workspace(restart?: { secondsLeft: number; id: string } | null): Workspace {
  return { readOnly: false, banner: null, seatLimit: null, seatsUsed: 1, restart };
}

function mount() {
  handle = mountRestartNote(browser.document.body as unknown as HTMLElement, createRestartNotice({ now: () => clockMs, storage: null }));
  return handle;
}

const note = () => browser.document.body.querySelector<FakeElement>('.restart-note');
const sentence = (el: FakeElement | null) => textOf(el?.querySelector('.restart-note-text'));

/** Moves the page clock and the fake timers together, one second at a time. */
function elapse(seconds: number) {
  for (let s = 0; s < seconds; s++) {
    clockMs += 1000;
    vi.advanceTimersByTime(1000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  browser = installFakeBrowser();
  clockMs = 1_000_000;
  handle = null;
});
afterEach(() => {
  handle?.dispose();
  vi.useRealTimers();
  browser.uninstall();
});

describe('restart note', () => {
  it('mounts once as a polite status region, hidden until a restart is planned', () => {
    mount();
    const el = note();
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('status');
    expect(el?.getAttribute('aria-live')).toBe('polite');
    expect(el?.hidden).toBe(true);
    expect(sentence(el)).toBe('');
    expect(browser.document.body.querySelectorAll('.restart-note')).toHaveLength(1);
  });

  it('shows the sentence for the planned restart, as text', () => {
    mount();
    handle?.update(workspace({ secondsLeft: 120, id: 'r1' }));
    expect(note()?.hidden).toBe(false);
    expect(sentence(note())).toBe(MINUTE_TEXT(2));
  });

  it('has a Dismiss button; dismissing hides the note, and the same id stays hidden on the next answer', () => {
    mount();
    handle?.update(workspace({ secondsLeft: 300, id: 'r1' }));
    const button = note()?.querySelector<FakeElement>('button');
    expect(button?.getAttribute('aria-label')).toBe('Dismiss');
    expect(button?.getAttribute('type')).toBe('button');
    button?.click();
    expect(note()?.hidden).toBe(true);
    handle?.update(workspace({ secondsLeft: 290, id: 'r1' }));
    expect(note()?.hidden).toBe(true);
    handle?.update(workspace({ secondsLeft: 290, id: 'r2' }));
    expect(note()?.hidden).toBe(false);
  });

  it('takes no focus when it appears', () => {
    const before = browser.document.activeElement;
    mount();
    handle?.update(workspace({ secondsLeft: 300, id: 'r1' }));
    expect(browser.document.activeElement).toBe(before);
  });

  it('recounts on the page clock every 30 s, without a server call, and stops once it is hidden', () => {
    mount();
    handle?.update(workspace({ secondsLeft: 120, id: 'r1' }));
    elapse(30); // 90 s left: still two minutes when rounded up
    expect(sentence(note())).toBe(MINUTE_TEXT(2));
    elapse(30); // 60 s left
    expect(sentence(note())).toBe(MINUTE_TEXT(1));
    elapse(60); // the restart time: less than a minute
    expect(sentence(note())).toBe(SOON);
    elapse(150); // 150 s past the restart time: the server has let the notice go
    expect(note()?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not write an unchanged sentence again', () => {
    mount();
    handle?.update(workspace({ secondsLeft: 300, id: 'r1' }));
    const span = note()?.querySelector<FakeElement>('.restart-note-text');
    const before = span?.childNodes[0];
    elapse(30); // still five minutes: the same text node is kept
    expect(span?.childNodes[0]).toBe(before);
  });

  it('never puts a server id, or anything from the server, into the page as markup', () => {
    mount();
    handle?.update(workspace({ secondsLeft: 300, id: '<img onerror=x>' }));
    const el = note();
    expect(el?.querySelector('img')).toBeNull();
    expect(el?.innerHTML).toBe('');
    expect(sentence(el)).toBe(MINUTE_TEXT(5));
    expect(textOf(el)).not.toContain('<img');
  });

  it('is removed by dispose, stops its timer, and ignores later answers', () => {
    mount();
    handle?.update(workspace({ secondsLeft: 300, id: 'r1' }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    handle?.dispose();
    expect(note()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => handle?.update(workspace({ secondsLeft: 300, id: 'r2' }))).not.toThrow();
    expect(note()).toBeNull();
  });
});

describe('focus after Dismiss', () => {
  /** The board's tab stop as canvas-focus.ts mounts it, in the fake page. */
  function addBoardStop(): FakeElement {
    const stop = browser.document.createElement('div');
    stop.className = 'canvas-focus';
    stop.setAttribute('tabindex', '0');
    browser.document.body.appendChild(stop);
    return stop;
  }

  /** A restart is shown, and its Dismiss button is focused, as a keyboard user leaves it. */
  function focusedDismiss(): FakeElement {
    mount();
    handle?.update(workspace({ secondsLeft: 300, id: 'r1' }));
    const button = note()!.querySelector<FakeElement>('button')!;
    button.focus();
    return button;
  }

  it('moves focus to the board tab stop when Dismiss is pressed on the focused button', () => {
    const stop = addBoardStop();
    const button = focusedDismiss();
    button.click();
    expect(note()?.hidden).toBe(true);
    expect(browser.document.activeElement).toBe(stop);
  });

  it('with no board and no main region on the page, Dismiss moves no focus itself', () => {
    // a real browser lands on the body one frame after a focused control is hidden, as it does for any hidden control; this fake
    // page does not blur hidden elements, so here the check is only that the code itself leaves focus where it was
    const button = focusedDismiss();
    button.click();
    expect(note()?.hidden).toBe(true);
    expect(browser.document.activeElement).toBe(button);
  });

  it('falls back to the first main region, given tabindex -1 when it has none', () => {
    const main = browser.document.createElement('main');
    browser.document.body.appendChild(main);
    const heading = browser.document.createElement('h1');
    browser.document.body.appendChild(heading);
    focusedDismiss().click();
    expect(browser.document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });

  it('falls back to a heading when the page has no main region', () => {
    const heading = browser.document.createElement('h1');
    browser.document.body.appendChild(heading);
    focusedDismiss().click();
    expect(browser.document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('leaves focus where it was when Dismiss is pressed without focus on the button, or the note hides by itself', () => {
    addBoardStop();
    const other = browser.document.createElement('button');
    browser.document.body.appendChild(other);
    mount();
    handle?.update(workspace({ secondsLeft: 300, id: 'r1' }));
    other.focus();
    note()!.querySelector<FakeElement>('button')!.click();
    expect(note()?.hidden).toBe(true);
    expect(browser.document.activeElement).toBe(other);

    // a new restart, which then runs out of its own accord while focus is still elsewhere
    handle?.update(workspace({ secondsLeft: 120, id: 'r2' }));
    expect(note()?.hidden).toBe(false);
    elapse(300);
    expect(note()?.hidden).toBe(true);
    expect(browser.document.activeElement).toBe(other);
  });
});

describe('restart note source', () => {
  it('styles the note as a fixed, width-limited box with no animation or transition, and a hidden rule of its own', () => {
    const css = readFileSync(new URL('../src/ui/restart-note.css', import.meta.url), 'utf8');
    const rule = /\.restart-note \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('position: fixed');
    expect(rule).toContain('max-width: calc(100% - 24px)');
    expect(rule).toContain('z-index: 55');
    expect(css).not.toMatch(/animation|transition|@keyframes/);
    expect(css).toContain('.restart-note[hidden] { display: none; }');
  });

  it('gives the Dismiss button a 44px target on coarse pointers', () => {
    const css = readFileSync(new URL('../src/ui/restart-note.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.restart-note-dismiss \{ width: 44px; height: 44px; \}\s*\}/);
  });

  it('sets the server-independent text only as text, never as markup', () => {
    const source = readFileSync(new URL('../src/ui/restart-note.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('innerHTML');
    expect(source).toContain('text.textContent = view.text');
  });
});
