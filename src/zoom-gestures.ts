import { boardOwnsGesture, gestureZoomStep, wheelZoomFactor } from './zoom-keys';

/** Safari's trackpad pinch: WebKit's gesture events, which lib.dom does not type. `scale` is cumulative from gesturestart. */
export type GestureEventLike = Event & { scale: number; clientX: number; clientY: number };

export interface BoardGestureHooks {
  /** The board surface (`.board-surface`): the canvas and the text editor are in it; the chrome over it is not. */
  surface: Element;
  /** The text box of the markdown block in edit state, or null. */
  markdownEditor: () => Element | null;
  /** Zooms the board around a point in the viewport. */
  zoomAt: (clientX: number, clientY: number, factor: number) => void;
  /** Whether a two-finger touch pinch is zooming now (the board's own pointer handling), so a gesture must not zoom it again. */
  touchPinching: () => boolean;
}

export interface BoardGestures {
  /** True between gesturestart and gestureend. */
  gesturing: () => boolean;
}

/**
 * Trackpad pinches zoom the board, not the page, when they land on the board: Safari's gesture events, and Ctrl/Cmd+wheel over the
 * markdown block being edited (the text box would otherwise zoom the page). The board's own wheel is app.ts's `onWheel`. Gestures
 * over other chrome are left alone, so the page's zoom works there. `doc` is where the page's own pinch is stopped for the board.
 */
export function bindBoardGestures(doc: EventTarget, hooks: BoardGestureHooks, signal: AbortSignal): BoardGestures {
  const { surface } = hooks;
  const opts = { passive: false, signal };
  const owned = (e: Event) => boardOwnsGesture(e.target as Element | null, surface, hooks.markdownEditor());
  let gesturing = false;
  let last: number | undefined;

  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    doc.addEventListener(type, (e) => {
      if (owned(e)) e.preventDefault();
    }, opts);
  }
  surface.addEventListener('gesturestart', (e) => {
    if (!owned(e)) return;
    gesturing = true;
    last = (e as GestureEventLike).scale;
  }, opts);
  surface.addEventListener('gesturechange', (e) => {
    if (!owned(e)) return;
    const g = e as GestureEventLike;
    const factor = gestureZoomStep(last, g.scale);
    last = g.scale;
    if (factor !== 1 && !hooks.touchPinching()) hooks.zoomAt(g.clientX, g.clientY, factor);
  }, opts);
  surface.addEventListener('gestureend', () => {
    gesturing = false;
    last = undefined;
  }, opts);
  // Ctrl/Cmd+wheel over the markdown block's text box: the text box would otherwise zoom the page. Plain wheel still scrolls the text.
  surface.addEventListener('wheel', (e) => {
    const w = e as WheelEvent;
    const editor = hooks.markdownEditor();
    if (!editor || w.target !== editor || !(w.ctrlKey || w.metaKey)) return;
    w.preventDefault();
    // a Safari pinch over this text box is already zooming the board through its gesture events; its wheel echo must not zoom it twice
    if (!gesturing) hooks.zoomAt(w.clientX, w.clientY, wheelZoomFactor(w));
  }, opts);
  return { gesturing: () => gesturing };
}
