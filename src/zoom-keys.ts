// Which zoom keys, gestures and notices belong to the board, and which belong to the page (the browser's zoom, text fields,
// buttons, dialogs, menus and the tracker). Pure, so the decisions are tested without a browser; the wiring is in app.ts and
// src/zoom-gestures.ts.

/** The device pixel ratio now, or 1 where the browser does not report one. */
export const devicePixelRatioNow = (): number => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

/** The device pixel ratio when this page loaded: a later change of it is browser zoom. */
export const LOAD_PIXEL_RATIO = devicePixelRatioNow();

const PAGE_ELEMENTS = new Set(['BODY', 'HTML']);

/**
 * Whether the board owns a Ctrl/Cmd zoom key (+, =, - and 0): nothing is focused, focus is on the page body, or focus is on the
 * canvas's one tab stop (`canvas`). Anything else (a text field, a button, a toolbar, a dialog, a menu, the tracker) keeps the
 * browser's own key.
 */
export function boardOwnsZoomKey(active: Element | null, canvas: Element | null): boolean {
  if (!active || PAGE_ELEMENTS.has(active.tagName.toUpperCase())) return true;
  return !!canvas && (active === canvas || canvas.contains(active));
}

/**
 * Whether a board gesture (a Safari pinch, or Ctrl/Cmd+wheel over the markdown block being edited) belongs to the board. It does
 * when the target is the board surface (the canvas and the text editor's own surface) or the markdown block's text box while it is
 * in edit state. Other text editors (sticky notes, labels, code, table cells) and all chrome keep the page's own pinch.
 */
export function boardOwnsGesture(target: Element | null, surface: Element | null, markdownEditor: Element | null): boolean {
  if (!target || !surface) return false;
  if (markdownEditor && target === markdownEditor) return true;
  if (target.classList.contains('text-editor')) return false;
  return target === surface || surface.contains(target);
}

/** The zoom factor a Ctrl/Cmd+wheel step makes. Chrome and Firefox report a trackpad pinch this way, with ctrlKey set. */
export function wheelZoomFactor(e: { deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean }): number {
  const k = e.deltaMode === 1 ? 0.05 : 0.0025;
  return Math.exp(-e.deltaY * k * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 3 : 1));
}

/**
 * The zoom factor one Safari gesture step makes: its cumulative `scale` over the last one (gesturestart reports 1). 1 when there is
 * no usable last scale, so the first step of a gesture changes nothing.
 */
export function gestureZoomStep(last: number | undefined, scale: number): number {
  if (last === undefined || !Number.isFinite(last) || !Number.isFinite(scale) || last <= 0 || scale <= 0) return 1;
  return scale / last;
}

/**
 * Whether the page itself is zoomed: pinched (the visual viewport's scale is not 1; without a visual viewport there is no pinch to
 * report), or browser-zoomed (the device pixel ratio has changed since the page loaded).
 */
export function pageIsZoomed(visualScale: number | undefined, pixelRatio: number, loadPixelRatio: number = LOAD_PIXEL_RATIO): boolean {
  return (visualScale !== undefined && visualScale !== 1) || pixelRatio !== loadPixelRatio;
}
