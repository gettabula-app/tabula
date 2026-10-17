import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  PILL_HEIGHT, PILL_WIDTH, TOOLBAR_COLLAPSED_KEY, foldGeometry, phaseAfterSettle, phaseAfterToggle, railControls,
  readToolbarCollapsed, writeToolbarCollapsed,
} from '../src/ui/rail-collapse-logic';
import { mountRailCollapse, type RailCollapse } from '../src/ui/rail-collapse';
import { installFakeBrowser } from './fake-dom';

// TAB-403: the left tool rail folds into a 22 x 64 tab on the window's left edge (src/ui/rail-collapse.ts). The toggle is the rail's
// first row, and the tab is a sibling before the rail in the chrome.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const css = read('../src/ui/rail-collapse.css');
const controller = read('../src/ui/rail-collapse.ts');
const board = read('../src/ui/board.ts');

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

/** The body of every @keyframes rule, found by counting braces so one-line keyframes count too. */
function keyframeBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const m of source.matchAll(/@keyframes [\w-]+\s*\{/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
    }
    bodies.push(source.slice(start, i - 1));
  }
  return bodies;
}

/** The reduced-motion block, up to the touch block. */
const reducedMotion = () => css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'), css.indexOf('@media (pointer: coarse)'));

describe('the saved toolbar state', () => {
  it('is saved under one key on this device', () => {
    expect(TOOLBAR_COLLAPSED_KEY).toBe('tabula.toolbar.collapsed');
  });

  it('reads folded only for the saved value 1, and expanded for anything else', () => {
    expect(readToolbarCollapsed(memoryStore({ [TOOLBAR_COLLAPSED_KEY]: '1' }))).toBe(true);
    expect(readToolbarCollapsed(memoryStore({ [TOOLBAR_COLLAPSED_KEY]: '0' }))).toBe(false);
    expect(readToolbarCollapsed(memoryStore())).toBe(false);
    expect(readToolbarCollapsed(null)).toBe(false);
    expect(readToolbarCollapsed(undefined)).toBe(false);
  });

  it('reads expanded when storage throws (a blocked or sandboxed page), without throwing', () => {
    expect(readToolbarCollapsed(throwing)).toBe(false);
  });

  it('writes 1 when folded and removes the key when expanded, so the default stays the default', () => {
    const store = memoryStore();
    writeToolbarCollapsed(store, true);
    expect(store.data.get(TOOLBAR_COLLAPSED_KEY)).toBe('1');
    writeToolbarCollapsed(store, false);
    expect(store.data.has(TOOLBAR_COLLAPSED_KEY)).toBe(false);
  });

  it('does not throw when storage is blocked or missing; the fold still works for the visit', () => {
    expect(() => writeToolbarCollapsed(throwing, true)).not.toThrow();
    expect(() => writeToolbarCollapsed(null, false)).not.toThrow();
  });
});

describe('the fold phases', () => {
  it('toggles from any phase: open rails fold, folded rails open, and a motion reverses from where it is', () => {
    expect(phaseAfterToggle('expanded')).toBe('collapsing');
    expect(phaseAfterToggle('collapsing')).toBe('expanding');
    expect(phaseAfterToggle('collapsed')).toBe('expanding');
    expect(phaseAfterToggle('expanding')).toBe('collapsing');
  });

  it('settles a motion to its resting phase and leaves a resting phase alone', () => {
    expect(phaseAfterSettle('collapsing')).toBe('collapsed');
    expect(phaseAfterSettle('expanding')).toBe('expanded');
    expect(phaseAfterSettle('collapsed')).toBe('collapsed');
    expect(phaseAfterSettle('expanded')).toBe('expanded');
  });

  it('gives the toggle aria-expanded and makes the rail inert while it is folded or folding', () => {
    expect(railControls('expanded')).toEqual({ toggleExpanded: true, railInert: false });
    expect(railControls('expanding')).toEqual({ toggleExpanded: true, railInert: false });
    expect(railControls('collapsing')).toEqual({ toggleExpanded: false, railInert: true });
    expect(railControls('collapsed')).toEqual({ toggleExpanded: false, railInert: true });
  });
});

describe('the fold geometry', () => {
  // The phone rail on 390 x 844: left 12, top 72, 56 px wide, 748 px tall. Its tab sits at top 414.
  const rail = { left: 12, top: 72, width: 56, height: 748 };
  const chrome = { left: 0, top: 0, width: 390, height: 844 };

  it('is a 22 x 64 tab', () => {
    expect(PILL_WIDTH).toBe(22);
    expect(PILL_HEIGHT).toBe(64);
  });

  it('centres the 22 x 64 tab on the rail, and clips the rail to the tab\'s footprint', () => {
    const g = foldGeometry(rail, chrome, 0);
    expect(g.pillWidth).toBe(PILL_WIDTH);
    expect(g.pillTop).toBe(414);
    expect(g.pillTop + PILL_HEIGHT / 2).toBe(rail.top + rail.height / 2);
    expect(g.x).toBe(-12);
    expect(g.r).toBe(rail.width - PILL_WIDTH);
    expect(g.t).toBe(342);
    expect(g.b).toBe(342);
  });

  it('moves the rail to the window edge from wherever the chrome starts, and grows the tab by the left safe inset', () => {
    const g = foldGeometry({ ...rail, left: 46 }, { ...chrome, left: 0 }, 34);
    expect(g.x).toBe(-46);
    expect(g.pillWidth).toBe(PILL_WIDTH + 34);
    expect(g.r).toBe(rail.width - (PILL_WIDTH + 34));
  });

  it('places the tab in the chrome\'s coordinates, not the window\'s', () => {
    const g = foldGeometry({ ...rail, left: 46, top: 120 }, { left: 34, top: 48, width: 390, height: 844 }, 0);
    expect(g.x).toBe(-12);
    expect(g.pillTop).toBe(414);
  });

  it('never returns a negative clip inset, even for a rail shorter than the tab', () => {
    const g = foldGeometry({ ...rail, height: 40 }, chrome, 0);
    expect(g.t).toBe(0);
    expect(g.b).toBe(0);
  });
});

describe('the fold stylesheet', () => {
  it('animates only clip-path, transform and opacity (never width, height, left or top)', () => {
    const bodies = keyframeBodies(css);
    expect(bodies.length).toBeGreaterThanOrEqual(7);
    for (const body of bodies) {
      const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(properties.length).toBeGreaterThan(0);
      for (const property of properties) expect(['clip-path', 'transform', 'opacity']).toContain(property);
    }
    // transitions hold only opacity (or none)
    const transitions = [...css.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const value of transitions) expect(value === 'none' || value.startsWith('opacity')).toBe(true);
  });

  it('slides the rail only inside its two rail keyframes, and only to the measured window edge', () => {
    const translates = css.match(/translateX\(var\(--rc-x\)\)/g) ?? [];
    expect(translates).toHaveLength(2);
    // nothing else in the fold translates: the tab, its chevron and the tools do not move
    expect(css.replace(/translateX\(var\(--rc-x\)\)|translateX\(0px\)/g, '')).not.toMatch(/translate/);
  });

  it('fills backwards only: a finished animation must leave no clip or transform behind', () => {
    expect(css).not.toMatch(/\b(both|forwards)\b/);
    expect(css).toMatch(/rc-rail-collapse 240ms var\(--ease-in-out[^)]*\)\) backwards/);
    expect(css).toMatch(/rc-rail-expand 200ms var\(--ease-out[^)]*\)\) backwards/);
  });

  it('draws the tab 22 px wide (plus the safe inset) and 64 px high, flush on the left, with square left corners and rounded right corners', () => {
    expect(css).toMatch(/\.chrome > \.rail-pill \{[^}]*width: calc\(22px \+ var\(--safe-left\)\); height: 64px;/);
    expect(css).toMatch(/\.chrome > \.rail-pill \{[^}]*left: 0; top: 0;/);
    expect(css).toMatch(/\.chrome > \.rail-pill \{[^}]*border-radius: 0 var\(--radius-md\) var\(--radius-md\) 0;/);
    expect(css).toMatch(/\.chrome > \.rail-pill \{[^}]*background: var\(--tray\)/);
    expect(css).toMatch(/\.chrome > \.rail-pill \{[^}]*box-shadow: var\(--shadow\)/);
  });

  it('never clips the tab, so its concave joins can paint outside its own box', () => {
    const rule = css.match(/\.chrome > \.rail-pill \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toMatch(/overflow/);
  });

  it('keeps the focus ring inside the window: the tab is flush with the edge, so its outline is drawn 2 px inside', () => {
    expect(css).toMatch(/\.chrome > \.rail-pill:focus-visible \{ outline-offset: -2px; \}/);
  });

  it('gives the tab a hit area of 26 x 64 on a mouse (::before inset 0 -2 px), past its box on each side', () => {
    const rule = css.match(/\.chrome > \.rail-pill::before \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/inset:\s*0 -2px;/);
  });

  it('draws two 8 x 8 concave joins, one above and one below the tab, painted in the tab\'s surface colour with a 1 px tray-line hairline along the curve', () => {
    expect(css).toMatch(/\.chrome > \.rail-pill > \.rail-pill-join \{ position: absolute; left: 0; width: 8px; height: 8px; pointer-events: none; \}/);
    expect(css).toMatch(/\.chrome > \.rail-pill > \.rail-pill-join\.top \{ top: -8px; background: radial-gradient\(circle at 100% 0, transparent 6\.6px, var\(--tray-line\) 7px, var\(--tray-line\) 7\.6px, var\(--tray\) 8px\); \}/);
    expect(css).toMatch(/\.chrome > \.rail-pill > \.rail-pill-join\.bottom \{ bottom: -8px; background: radial-gradient\(circle at 100% 100%, transparent 6\.6px, var\(--tray-line\) 7px, var\(--tray-line\) 7\.6px, var\(--tray\) 8px\); \}/);
  });

  it('changes the joins to the tab\'s hover colour when the tab is hovered, so they never show a different surface', () => {
    expect(css).toMatch(/\.chrome > \.rail-pill:hover \{ background: var\(--tray-2\); \}/);
    expect(css).toMatch(/\.chrome > \.rail-pill:hover > \.rail-pill-join\.top \{ background: radial-gradient\(circle at 100% 0, transparent 6\.6px, var\(--tray-line\) 7px, var\(--tray-line\) 7\.6px, var\(--tray-2\) 8px\); \}/);
    expect(css).toMatch(/\.chrome > \.rail-pill:hover > \.rail-pill-join\.bottom \{ background: radial-gradient\(circle at 100% 100%, transparent 6\.6px, var\(--tray-line\) 7px, var\(--tray-line\) 7\.6px, var\(--tray-2\) 8px\); \}/);
  });

  it('gives reduced motion a 120 ms opacity crossfade and no clip or slide', () => {
    const reduced = reducedMotion();
    expect(reduced).toMatch(/rc-rail-fade-out 120ms/);
    expect(reduced).toMatch(/rc-rail-fade-in 120ms/);
    expect(reduced).not.toMatch(/rc-rail-collapse|rc-rail-expand|clip-path|translate/);
  });

  it('keeps the tab 22 px wide on touch (the global 44 px minimum is reset for it) and makes its hit area 44 px wide', () => {
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).toMatch(/\.chrome > \.rail-pill \{ min-width: 0 !important; min-height: 0 !important; \}/);
    expect(coarse).toMatch(/\.chrome > \.rail-pill::before \{ content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 44px; \}/);
  });

  it('keeps the toggle row 28 px high, and 44 px high to a finger', () => {
    expect(css).toMatch(/\.chrome > \.rail > \.rail-toggle \{[^}]*height: 28px;/);
    expect(css.slice(css.indexOf('@media (pointer: coarse)'))).toMatch(/\.chrome > \.rail > \.rail-toggle \{ height: 44px;/);
  });
});

describe('the controls', () => {
  it('names the toggle "Hide toolbar" and the tab "Show toolbar", and both call the one toggle function', () => {
    expect(controller).toMatch(/'aria-label': 'Hide toolbar'/);
    expect(controller).toMatch(/'aria-label': 'Show toolbar'/);
    expect(controller).toMatch(/toggleButton\.addEventListener\('click', \(\) => toggleToolbar\(collapse\)\);/);
    expect(controller).toMatch(/pillButton\.addEventListener\('click', \(\) => toggleToolbar\(collapse\)\);/);
  });

  it('puts the toggle first inside the rail, and the tab before the rail', () => {
    expect(controller).toMatch(/rail\.prepend\(toggleButton\);/);
    expect(controller).toMatch(/rail\.before\(pillButton\);/);
  });

  it('gives the tab two aria-hidden join spans, and places the tab by its top only (its left is the CSS edge)', () => {
    expect(controller).toMatch(/h\('span', \{ class: 'rail-pill-join top', 'aria-hidden': 'true' \}\)/);
    expect(controller).toMatch(/h\('span', \{ class: 'rail-pill-join bottom', 'aria-hidden': 'true' \}\)/);
    expect(controller).toMatch(/pillButton\.style\.top = `\$\{g\.pillTop\}px`;/);
    expect(controller).not.toMatch(/pillButton\.style\.left/);
  });
});

describe('the board mounts the fold', () => {
  it('mounts it on the rail after the chrome holds the rail, and skips the demo', () => {
    expect(board).toMatch(/chrome\.append\(topLeft, topRight, rail, penTray, stickyTray, mini\.el, zoomTray\);\s*\n[\s\S]*?const railCollapse = demo \? null : mountRailCollapse\(chrome, rail\);/);
  });

  it('keeps the toggle usable on a read-only board', () => {
    expect(board).toMatch(/b === railCollapse\?\.toggleButton\) return;/);
  });
});

describe('the controller where the observers are missing', () => {
  // The unit-test environments have no MutationObserver or ResizeObserver (guest-ui, ai-board-menu and tracker-entry-menu mount the
  // board without them), so mounting must not depend on either.
  it('mounts, folds and destroys without throwing when MutationObserver and ResizeObserver are missing', () => {
    const browser = installFakeBrowser();
    try {
      vi.stubGlobal('MutationObserver', undefined);
      vi.stubGlobal('ResizeObserver', undefined);
      // the controller schedules its re-measure through the bare requestAnimationFrame, stubbed the way test/guest-ui.test.ts does
      vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
      vi.stubGlobal('cancelAnimationFrame', () => undefined);
      expect(typeof MutationObserver).toBe('undefined');
      expect(typeof ResizeObserver).toBe('undefined');

      const chrome = document.createElement('div');
      const rail = document.createElement('nav');
      chrome.append(rail);
      let collapse!: RailCollapse;
      expect(() => { collapse = mountRailCollapse(chrome, rail, { store: null }); }).not.toThrow();
      expect(() => collapse.toggle()).not.toThrow();
      expect(collapse.phase).toBe('collapsing');
      expect(() => collapse.destroy()).not.toThrow();
    } finally {
      browser.uninstall();
    }
  });
});
