// Which zoom keys, gestures and notices belong to the board, and which belong to the page (the browser's zoom, text fields,
// buttons, dialogs, menus and the tracker). Pure, so the decisions are tested without a browser; the wiring is in app.ts and
// src/zoom-gestures.ts.

/** The device pixel ratio now, or 1 where the browser does not report one. */
export const devicePixelRatioNow = (): number => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

/** The device pixel ratio when this page loaded: a later change of it is browser zoom. */
export const LOAD_PIXEL_RATIO = devicePixelRatioNow();

/** The two parts of the board a gesture can land on: the board surface (`.board-surface`) and the canvas (the SVG) in it. */
export interface BoardElements {
  surface: Element;
  canvas: Element;
}

/** Whether `el` is `root` or inside it. */
function within(el: Element, root: Element): boolean {
  return el === root || root.contains(el);
}

/**
 * Whether focus is in something that takes typed text or a choice: an input, a select, a textarea, or an editable area (or something
 * inside one). The page keeps its own Ctrl/Cmd keys there.
 */
export function takesTyping(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
}

/**
 * Whether the board owns a Ctrl/Cmd zoom key (+, =, - and 0). It does unless focus is in something that takes typing, or a dialog,
 * a popover or the tracker is open over the board (`overlayOpen`). Focus on the page body, the canvas, a toolbar button or anything
 * else that takes no typing is the board's, so the key zooms the board there.
 */
export function boardOwnsZoomKey(active: Element | null, overlayOpen: boolean): boolean {
  if (overlayOpen) return false;
  return !active || !takesTyping(active);
}

/** Whether `target` is one of the open in-place editors' elements, or inside one. */
export function inOpenEditor(target: Element, editors: readonly Element[]): boolean {
  return editors.some((editor) => within(target, editor));
}

/**
 * Whether a board gesture (a Safari pinch, or Ctrl/Cmd+wheel) belongs to the board: over the board surface itself, over the canvas,
 * or over an in-place editor that is open (`editors`: the text box of a sticky, label, frame name, code block, table cell, Markdown
 * block or class, and a kanban card's title being typed). Chrome mounted over the surface (toolbars, dialogs, the tracker's frames,
 * the code buttons) and an editor that is closed keep the page's own gesture.
 */
export function boardOwnsGesture(target: Element | null, board: BoardElements | null, editors: readonly Element[]): boolean {
  if (!target || !board) return false;
  if (target === board.surface || within(target, board.canvas)) return true;
  return inOpenEditor(target, editors);
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
