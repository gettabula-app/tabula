import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountPageZoomChip, type PageZoomEnv } from '../src/ui/common';
import { control, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

/** A page whose zoom the test sets: the pinch scale (undefined without a visual viewport) and the pixel ratio, loaded at 2. */
function page(opts: { platform?: string; storage?: Map<string, string> | null } = {}) {
  const view = { visualScale: undefined as number | undefined, pixelRatio: 2 };
  const watchers = new Set<() => void>();
  const store = opts.storage === undefined ? new Map<string, string>() : opts.storage;
  const env: PageZoomEnv = {
    reading: () => ({ ...view }),
    loadPixelRatio: 2,
    watch: (fn) => {
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
    platform: opts.platform ?? 'MacIntel',
    storage: store === null ? null : {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
  };
  const host = browser.mount();
  const stop = mountPageZoomChip(host as unknown as HTMLElement, env);
  const note = host.querySelector('.page-zoom-note') as FakeElement;
  /** The viewport changed (a pinch, or a browser zoom): the notice is told, as the window's and visual viewport's resize events tell it. */
  const resize = () => {
    for (const fn of watchers) fn();
  };
  return { host, note, stop, view, resize, store: store ?? new Map<string, string>(), watchers };
}

describe('page-zoom notice', () => {
  it('is hidden at 100%', () => {
    const p = page();
    expect(p.note.hidden).toBe(true);
  });

  it('shows when the page is pinched, naming Cmd+0 on a Mac', () => {
    const p = page({ platform: 'MacIntel' });
    p.view.visualScale = 1.5;
    p.resize();
    expect(p.note.hidden).toBe(false);
    expect(textOf(p.note)).toContain('Page is zoomed — press ⌘0');
  });

  it('names Ctrl+0 elsewhere', () => {
    const p = page({ platform: 'Win32' });
    p.view.visualScale = 0.8;
    p.resize();
    expect(p.note.hidden).toBe(false);
    expect(textOf(p.note)).toContain('Page is zoomed — press Ctrl+0');
  });

  it('shows when the device pixel ratio has changed since the page loaded (browser zoom)', () => {
    const p = page();
    p.view.pixelRatio = 1.5;
    p.resize();
    expect(p.note.hidden).toBe(false);
  });

  it('does not show without a visual viewport when the pixel ratio has not changed', () => {
    const p = page();
    p.resize();
    expect(p.note.hidden).toBe(true);
  });

  it('goes away when the page is back at 100%', () => {
    const p = page();
    p.view.visualScale = 1.5;
    p.resize();
    p.view.visualScale = 1;
    p.resize();
    expect(p.note.hidden).toBe(true);
  });

  it('is dismissed with its close button, and stays dismissed for the session', () => {
    const p = page();
    p.view.visualScale = 2;
    p.resize();
    expect(p.note.hidden).toBe(false);
    const close = control(p.note, 'Dismiss');
    expect(close.getAttribute('aria-label')).toBe('Dismiss');
    close.click();
    expect(p.note.hidden).toBe(true);
    expect(p.store.get('tabula.pageZoomNoticeDismissed')).toBe('1');

    p.view.visualScale = 1;
    p.resize();
    p.view.visualScale = 1.7;
    p.resize();
    expect(p.note.hidden).toBe(true);
  });

  it('stays dismissed when the board is mounted again in the same session', () => {
    const shared = new Map<string, string>([['tabula.pageZoomNoticeDismissed', '1']]);
    const p = page({ storage: shared });
    p.view.visualScale = 2;
    p.resize();
    expect(p.note.hidden).toBe(true);
  });

  it('is shown again in a new session', () => {
    const p = page({ storage: new Map() });
    p.view.visualScale = 2;
    p.resize();
    expect(p.note.hidden).toBe(false);
  });

  it('still goes away when the dismissal cannot be remembered', () => {
    const p = page({ storage: null });
    p.view.visualScale = 2;
    p.resize();
    control(p.note, 'Dismiss').click();
    expect(p.note.hidden).toBe(true);
  });

  it('reads the pinch from window.visualViewport and repaints on its resize by default', () => {
    const win = window as unknown as { visualViewport?: unknown };
    const listeners: (() => void)[] = [];
    const vv = { scale: 1, addEventListener: (_type: string, fn: () => void) => void listeners.push(fn), removeEventListener() {} };
    win.visualViewport = vv;
    try {
      const host = browser.mount();
      const stop = mountPageZoomChip(host as unknown as HTMLElement);
      const note = host.querySelector('.page-zoom-note') as FakeElement;
      expect(note.hidden).toBe(true);
      vv.scale = 1.8;
      for (const fn of listeners) fn();
      expect(note.hidden).toBe(false);
      vv.scale = 1;
      for (const fn of listeners) fn();
      expect(note.hidden).toBe(true);
      stop();
    } finally {
      delete win.visualViewport;
    }
  });

  it('is removed, and stops watching the viewport, when the board goes away', () => {
    const p = page();
    expect(p.watchers.size).toBe(1);
    p.stop();
    expect(p.watchers.size).toBe(0);
    expect(p.host.querySelector('.page-zoom-note')).toBeNull();
  });
});
