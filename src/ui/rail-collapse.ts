import './rail-collapse.css';
import { closePopover } from './common';
import { h, icon } from './dom';
import {
  foldGeometry, phaseAfterSettle, phaseAfterToggle, railControls, readToolbarCollapsed, writeToolbarCollapsed, type RailPhase,
} from './rail-collapse-logic';

// TAB-403: the left tool rail folds into a small tab on the window's left edge, and opens again. The toggle is the rail's first row
// ("Hide toolbar", a left-pointing chevron, in the rail's own flow); the tab is the same control while folded. The tab is a sibling
// before the rail in the chrome, so the rail's clip never cuts it off. Both call toggleToolbar. Tools keep working while folded: only
// the UI hides. The fold is an overlay, so it never moves the canvas.

/** The motion's length in ms (the CSS in rail-collapse.css holds the same numbers); the reduced-motion crossfade is 120 ms. */
const MOTION_MS: Record<'collapsing' | 'expanding', number> = { collapsing: 240, expanding: 200 };
const REDUCED_MS = 120;
/** The timer that settles a motion when no animationend comes (no animation ran, or it was cancelled), after the motion's own length. */
const SETTLE_SLACK_MS = 60;

export interface RailCollapse {
  /** The phase the rail is in now, read from data-rail-phase on the chrome. */
  readonly phase: RailPhase;
  /** Folds an open rail, or opens a folded one. Focus moves to the other control. */
  toggle(): void;
  /** Re-measures the tab (after a resize or a layout change). */
  place(): void;
  destroy(): void;
  readonly toggleButton: HTMLButtonElement;
  readonly pillButton: HTMLButtonElement;
}

/** The helper both controls call: the rail's toggle row and the tab. */
export function toggleToolbar(collapse: RailCollapse): void {
  collapse.toggle();
}

/** The browser's localStorage, or null where it is blocked (it can throw on access, for example in a sandboxed frame). */
function savedStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Builds the toggle (the rail's first row) and the tab (before the rail in the chrome), and applies the saved state without a
 * motion. The rail and the chrome are the board's; the chrome must already hold the rail.
 */
export function mountRailCollapse(chrome: HTMLElement, rail: HTMLElement, options: { store?: Storage | null } = {}): RailCollapse {
  const store = options.store === undefined ? savedStore() : options.store;
  if (!rail.id) rail.id = 'tool-rail';

  const toggleButton = h('button', {
    class: 'rail-toggle', type: 'button', 'aria-controls': rail.id, 'aria-expanded': 'true',
    'aria-label': 'Hide toolbar', 'data-tip': 'Hide toolbar',
  }, icon('chevron', 14));
  // The two joins are the concave corners where the tab meets the window's edge. They are painted in the tab's own surface colour, so
  // they belong to the tab: aria-hidden, and they take no pointer.
  const pillButton = h('button', {
    class: 'rail-pill', type: 'button', 'aria-controls': rail.id, 'aria-expanded': 'false',
    'aria-label': 'Show toolbar', 'data-tip': 'Show toolbar',
  },
  h('span', { class: 'rail-pill-chev', 'aria-hidden': 'true' }, icon('chevron', 12)),
  h('span', { class: 'rail-pill-join top', 'aria-hidden': 'true' }),
  h('span', { class: 'rail-pill-join bottom', 'aria-hidden': 'true' }));
  rail.prepend(toggleButton);
  rail.before(pillButton);

  let phase: RailPhase = readToolbarCollapsed(store) ? 'collapsed' : 'expanded';
  let timer = 0;

  /** Writes the phase to the board and to the controls. The CSS keys every motion and display off data-rail-phase. */
  const enter = (next: RailPhase) => {
    window.clearTimeout(timer);
    phase = next;
    chrome.dataset.railPhase = next;
    const { toggleExpanded, railInert } = railControls(next);
    toggleButton.setAttribute('aria-expanded', String(toggleExpanded));
    rail.inert = railInert;
  };

  /** Copies the rail's geometry into the CSS variables the keyframes read, and centres the tab on the rail. */
  const measure = () => {
    const c = chrome.getBoundingClientRect();
    const r = rail.getBoundingClientRect();
    const safeLeft = Number.parseFloat(getComputedStyle(chrome).getPropertyValue('--safe-left')) || 0;
    const g = foldGeometry(r, c, safeLeft);
    rail.style.setProperty('--rc-x', `${g.x}px`);
    rail.style.setProperty('--rc-t', `${g.t}px`);
    rail.style.setProperty('--rc-r', `${g.r}px`);
    rail.style.setProperty('--rc-b', `${g.b}px`);
    pillButton.style.top = `${g.pillTop}px`;
  };

  /** Re-measures in a resting phase only: during a motion the rail is mid-transform, so its box is not its resting box. */
  const refresh = () => {
    if (phase === 'collapsed' || phase === 'expanded') measure();
  };

  const settle = () => {
    const next = phaseAfterSettle(phase);
    if (next !== phase) {
      enter(next);
      // refresh() skips a resize that arrived during the motion, so measure now that the phase is resting
      refresh();
    }
  };

  const armSettle = () => {
    window.clearTimeout(timer);
    if (phase !== 'collapsing' && phase !== 'expanding') return;
    const ms = prefersReducedMotion() ? REDUCED_MS : MOTION_MS[phase];
    timer = window.setTimeout(settle, ms + SETTLE_SLACK_MS);
  };

  const toggle = () => {
    const next = phaseAfterToggle(phase);
    if (next === 'collapsing') {
      closePopover();
      measure();
      enter('collapsing');
      writeToolbarCollapsed(store, true);
      pillButton.focus({ preventScroll: true });
    } else {
      measure();
      enter('expanding');
      writeToolbarCollapsed(store, false);
      toggleButton.focus({ preventScroll: true });
    }
    armSettle();
  };

  const onAnimationEnd = (event: AnimationEvent) => {
    if (event.target !== rail || !event.animationName.startsWith('rc-rail-')) return;
    settle();
  };
  rail.addEventListener('animationend', onAnimationEnd);
  toggleButton.addEventListener('click', () => toggleToolbar(collapse));
  pillButton.addEventListener('click', () => toggleToolbar(collapse));

  // The board moves the rail when its top bars change size (--panel-top), and that can happen after this window's resize event,
  // so the tab is measured one frame later, and again whenever the rail itself changes size.
  let frame = 0;
  const scheduleMeasure = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  };
  window.addEventListener('resize', scheduleMeasure);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
  observer?.observe(rail);
  // --panel-top moves the rail without resizing it, so no resize event or ResizeObserver fires; the chrome's style is watched instead.
  const styleObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(scheduleMeasure);
  styleObserver?.observe(chrome, { attributes: true, attributeFilter: ['style'] });

  const collapse: RailCollapse = {
    get phase() { return phase; },
    toggle,
    place: refresh,
    destroy() {
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      styleObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      rail.removeEventListener('animationend', onAnimationEnd);
    },
    toggleButton,
    pillButton,
  };

  // Applied straight to the resting state. The first layout pass sets the chrome's panel top, which the rail's top follows, so the
  // tab is placed after that frame.
  enter(phase);
  requestAnimationFrame(refresh);

  return collapse;
}
