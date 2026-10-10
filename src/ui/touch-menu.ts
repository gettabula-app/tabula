// TAB-253: a touch long press on a selected item, group or selection opens the same menu a right-click does (context-menu.ts), which
// carries Group and Ungroup. Phones have no right button, and while the Comments and Chat tray is open the quick bar that also
// carries them is hidden (TAB-243). The pointer wiring for locked items and cards stays in app.ts; this listens beside it.
import type { BoardApp } from '../app';
import type { Obj } from '../types';
import { openContextMenu } from './context-menu';

export const TOUCH_MENU_MS = 500;
export const TOUCH_MENU_SLOP = 10;

/** True once the finger has travelled far enough that the press is a drag or a pan, not a hold. */
export function movedPastSlop(dx: number, dy: number, slop = TOUCH_MENU_SLOP): boolean {
  return Math.hypot(dx, dy) > slop;
}

/** Whether `target` is one of the selected objects or sits inside a selected group. */
export function isInSelection(target: Obj, selection: readonly string[], parentOf: (id: string) => Obj | undefined): boolean {
  const seen = new Set<string>();
  for (let at: Obj | undefined = target; at && !seen.has(at.id); at = at.parent ? parentOf(at.parent) : undefined) {
    if (selection.includes(at.id)) return true;
    seen.add(at.id);
  }
  return false;
}

/** The same ids in the same order. */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function mountTouchMenu(app: BoardApp) {
  const svg = app.r.svg;
  let press: { id: number; x: number; y: number; timer: number } | null = null;
  let firedAt = 0;
  // the selection and place of the press that opened the menu, kept until the finger lifts
  let held: { x: number; y: number; selection: string[]; pointer: number } | null = null;
  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const fire = () => {
    const at = press;
    cancel();
    if (!at || app.readOnly || app.tool.kind !== 'select' || app.dragging) return;
    const target = app.hit(app.r.clientToWorld(at.x, at.y));
    if (!target || target.locked) return;
    if (!isInSelection(target, app.selection, (id) => app.store.get(id))) {
      if (app.selection.length) return;
      app.setSelection([target.id]);
    }
    firedAt = Date.now();
    held = { x: at.x, y: at.y, selection: [...app.selection], pointer: at.id };
    openContextMenu(app, at.x, at.y, true);
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    // a second finger is a pinch
    if (press) return cancel();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: window.setTimeout(fire, TOUCH_MENU_MS) };
  };
  const move = (e: PointerEvent) => {
    if (press && e.pointerId === press.id && movedPastSlop(e.clientX - press.x, e.clientY - press.y)) cancel();
  };
  const end = (e: PointerEvent) => {
    if (press && e.pointerId === press.id) cancel();
    const at = held;
    if (!at || e.pointerId !== at.pointer) return;
    held = null;
    // lifting the finger is a click to the board, which narrows a multi-selection to the item under it and so closes the menu
    // (app.ts, onUp, 'move'): the menu is for the selection the press was made on, so it is put back and opened again
    if (!sameSelection(app.selection, at.selection)) {
      app.setSelection(at.selection);
      openContextMenu(app, at.x, at.y, true);
    }
  };
  // Android also sends contextmenu after a hold: the menu is open already, so the second one is dropped
  const dupe = (e: Event) => {
    if (Date.now() - firedAt < 1000 && e.target instanceof Node && svg.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  svg.addEventListener('pointerdown', down);
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  window.addEventListener('contextmenu', dupe, true);
  app.onDestroy(() => {
    cancel();
    svg.removeEventListener('pointerdown', down);
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', end);
    svg.removeEventListener('pointercancel', end);
    window.removeEventListener('contextmenu', dupe, true);
  });
}
