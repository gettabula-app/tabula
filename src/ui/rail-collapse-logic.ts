// TAB-403: the left tool rail can fold into a small tab on the window's left edge, and open again. This file has no DOM:
// the saved key and how it is read and written, the phases and what each means for aria and inert, and the geometry of the fold.
// The DOM part is src/ui/rail-collapse.ts.

/** The saved state on this device. It is not synced to the account: no route stores arbitrary per-person keys (see TAB-403). */
export const TOOLBAR_COLLAPSED_KEY = 'tabula.toolbar.collapsed';

/** The tab's visible size. Its width grows by the window's left safe inset, so a notch never covers it. */
export const PILL_WIDTH = 22;
export const PILL_HEIGHT = 64;

/** `expanded` and `collapsed` are resting states; `collapsing` and `expanding` are the motions between them. */
export type RailPhase = 'expanded' | 'collapsing' | 'collapsed' | 'expanding';

type ReadStore = { getItem(key: string): string | null };
type WriteStore = { setItem(key: string, value: string): void; removeItem(key: string): void };

/** The saved state. Missing, unreadable or unavailable storage means expanded, the default on every device. */
export function readToolbarCollapsed(store: ReadStore | null | undefined): boolean {
  try {
    return store?.getItem(TOOLBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Saves the state. Storage that is blocked or full leaves the fold working for this visit only. */
export function writeToolbarCollapsed(store: WriteStore | null | undefined, collapsed: boolean): void {
  try {
    if (collapsed) store?.setItem(TOOLBAR_COLLAPSED_KEY, '1');
    else store?.removeItem(TOOLBAR_COLLAPSED_KEY);
  } catch {
    // The state still applies on the page; only the saved copy is lost.
  }
}

/** The phase a toggle moves to. A rail caught mid-motion reverses from where it is. */
export function phaseAfterToggle(phase: RailPhase): RailPhase {
  return phase === 'expanded' || phase === 'expanding' ? 'collapsing' : 'expanding';
}

/** The resting phase a finished motion settles to. */
export function phaseAfterSettle(phase: RailPhase): RailPhase {
  if (phase === 'collapsing') return 'collapsed';
  if (phase === 'expanding') return 'expanded';
  return phase;
}

/**
 * What a phase means for the controls: the toggle's aria-expanded, and whether the rail is inert. A rail that is folding or
 * folded takes no focus and no pointer, and the tab is the control that is focusable instead.
 */
export function railControls(phase: RailPhase): { toggleExpanded: boolean; railInert: boolean } {
  const folded = phase === 'collapsing' || phase === 'collapsed';
  return { toggleExpanded: !folded, railInert: folded };
}

export type Box = { left: number; top: number; width: number; height: number };

/**
 * The fold's numbers from the rail and the chrome as they are laid out now. `x` moves the rail's left edge to the window's edge.
 * `t`, `r` and `b` inset the rail's clip to the tab's footprint, measured from the rail's own box. `pillTop` centres the tab on
 * the rail's centre, in the chrome's coordinates. Clip insets never go negative, so a very short rail still clips to a tab.
 */
export function foldGeometry(rail: Box, chrome: Box, safeLeft: number) {
  const pillWidth = PILL_WIDTH + Math.max(0, safeLeft);
  const offset = (rail.height - PILL_HEIGHT) / 2;
  return {
    x: chrome.left - rail.left,
    t: Math.max(0, offset),
    r: Math.max(0, rail.width - pillWidth),
    b: Math.max(0, rail.height - offset - PILL_HEIGHT),
    pillTop: rail.top - chrome.top + offset,
    pillWidth,
  };
}
