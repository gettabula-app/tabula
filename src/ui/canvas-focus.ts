import './canvas-focus.css';
import type { BoardApp } from '../app';
import type { Obj } from '../types';
import { isConnector } from '../types';
import { objBounds } from '../geometry';
import { boardLabel, describeObject } from '../canvas-describe';
import { nearestInDirection, readingOrder, stepInOrder, type NavDirection, type NavItem, type OutlineEntry } from '../canvas-nav';
import { announce } from './announce';
import { h } from './dom';

/** Past this many objects only the ones around the current one are in the page; the position in the set stays true. */
export const OUTLINE_WINDOW = 300;
/** How far inside the view the current object is kept when focus moves to it. */
const VIEW_MARGIN = 24;
/** The ring's outer edge is this far from the object: 2 px of paper gap, then 2 px of ink (docs/canvas-keyboard.md, The focus ring). */
export const RING_OFFSET = 4;
/** The thinnest box (screen px) the ring draws around a connector's line. */
const LINE_MIN = 16;

const ARROWS: Record<string, NavDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
let serial = 0;

export interface CanvasFocus {
  el: HTMLElement;
  current(): string | null;
  /** The outline in reading order, for tests and the visible panel later. */
  order(): readonly OutlineEntry[];
  destroy(): void;
}

/**
 * The canvas as a keyboard and screen reader user meets it (docs/canvas-keyboard.md, slice 1): one tab stop whose hidden outline
 * (a listbox of the objects in reading order) stands for the picture. Focus stays on one element and `aria-activedescendant`
 * names the current object; the arrows move to the nearest object, Page Down and Page Up follow reading order, Home and End go to
 * the ends, Esc lets go of the current object, and Tab leaves. Moving focus never selects or changes anything. With a selection
 * on the current object the arrows keep nudging it, as they always have.
 */
export function mountCanvasFocus(app: BoardApp, anchor: HTMLElement): CanvasFocus {
  const id = ++serial;
  const helpId = `canvas-help-${id}`;
  const list = h('ul', { class: 'canvas-outline', role: 'listbox', 'aria-label': 'Objects', 'aria-multiselectable': 'true' });
  const help = h('p', { id: helpId, class: 'canvas-outline-help' },
    'Arrow keys move between objects. Page Down and Page Up read in order. Home and End go to the first and last. Tab leaves the whiteboard.');
  const target = h('div', {
    class: 'canvas-focus', role: 'application', tabindex: '0', 'aria-label': boardLabel(0), 'aria-describedby': helpId,
  }, list);
  const ring = h('div', { class: 'canvas-ring', 'aria-hidden': 'true', hidden: true });
  const host = anchor.parentNode;
  host?.insertBefore(target, anchor.nextSibling);
  host?.insertBefore(help, target.nextSibling);
  const root = app.r.root as HTMLElement | undefined;
  root?.appendChild(ring);

  let entries: OutlineEntry[] = [];
  let items: NavItem[] = [];
  let objects = new Map<string, Obj>();
  let currentId: string | null = null;
  let keyboard = false;
  let told = false;
  let timer = 0;
  const optionId = (objectId: string) => `canvas-opt-${id}-${objectId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  function collect() {
    // a board without objects to read (the tests' stand-in) has an empty outline
    if (typeof app.store.shown !== 'function' || typeof app.r.connectorLayout !== 'function') {
      entries = [];
      items = [];
      objects = new Map();
      return;
    }
    const layout = app.r.connectorLayout();
    const get = (oid: string) => app.store.getPlaced(oid);
    objects = new Map();
    items = [];
    for (const o of app.store.shown()) {
      if (app.flow.isHidden(o as never)) continue;
      objects.set(o.id, o);
      // a connector's visible extent includes its arrowheads and label, which the renderer already measures
      const b = isConnector(o) ? app.r.contentBounds([o.id]) : objBounds(get, o, layout, (obj) => app.store.geometry(obj));
      if (!b) continue;
      const base = { id: o.id, cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, parent: o.parent ?? null };
      if (isConnector(o)) items.push({ ...base, connector: { from: o.from.kind === 'bound' ? o.from.id : null, to: o.to.kind === 'bound' ? o.to.id : null } });
      else items.push(base);
    }
    entries = readingOrder(items);
  }

  /** Rebuilds the options: all of them, or the window of 300 around the current object. */
  function paintOutline() {
    const total = entries.length;
    target.setAttribute('aria-label', boardLabel(total));
    const at = currentId ? entries.findIndex((e) => e.id === currentId) : -1;
    const start = total <= OUTLINE_WINDOW ? 0 : Math.max(0, Math.min(total - OUTLINE_WINDOW, (at < 0 ? 0 : at) - (OUTLINE_WINDOW >> 1)));
    const selected = new Set(app.selection);
    const ctx = { get: (oid: string) => objects.get(oid), childCount: (oid: string) => entries.filter((e) => objects.get(e.id)?.parent === oid).length };
    list.replaceChildren(...entries.slice(start, start + OUTLINE_WINDOW).map((e, i) => {
      const o = objects.get(e.id)!;
      const d = describeObject(o, ctx);
      const li = h('li', {
        role: 'option', id: optionId(e.id), 'aria-selected': String(selected.has(e.id)), 'aria-posinset': String(start + i + 1),
        'aria-setsize': String(total), 'aria-level': String(e.level + 1),
      }, d.name);
      if (d.description) li.setAttribute('aria-description', d.description);
      return li;
    }));
    paintCurrent();
  }

  function paintCurrent() {
    if (currentId && entries.some((e) => e.id === currentId)) target.setAttribute('aria-activedescendant', optionId(currentId));
    else {
      currentId = null;
      target.removeAttribute('aria-activedescendant');
    }
    placeRing();
  }

  function placeRing() {
    const item = currentId ? items.find((i) => i.id === currentId) : undefined;
    if (!item || !keyboard || document.activeElement !== target) {
      ring.hidden = true;
      return;
    }
    let a = app.r.toScreen({ x: item.cx - item.w / 2, y: item.cy - item.h / 2 });
    let b = app.r.toScreen({ x: item.cx + item.w / 2, y: item.cy + item.h / 2 });
    if (item.connector) {
      // a straight line has no height to ring: its box is at least this thick, centred on it
      const grow = (lo: number, hi: number) => (hi - lo < LINE_MIN ? (LINE_MIN - (hi - lo)) / 2 : 0);
      const gx = grow(a.x, b.x), gy = grow(a.y, b.y);
      a = { x: a.x - gx, y: a.y - gy };
      b = { x: b.x + gx, y: b.y + gy };
    }
    // 4 px outside the object; a connector's line gets a rounded box around its bounds
    const out = RING_OFFSET;
    ring.hidden = false;
    ring.classList.toggle('is-line', !!item.connector);
    ring.style.transform = `translate(${a.x - out}px, ${a.y - out}px)`;
    ring.style.width = `${Math.max(8, b.x - a.x) + out * 2}px`;
    ring.style.height = `${Math.max(8, b.y - a.y) + out * 2}px`;
  }

  /** Pans the camera the least needed to bring the object inside the view. */
  function bringIntoView(objectId: string) {
    const item = items.find((i) => i.id === objectId);
    if (!item) return;
    const size = app.r.size();
    const a = app.r.toScreen({ x: item.cx - item.w / 2, y: item.cy - item.h / 2 });
    const b = app.r.toScreen({ x: item.cx + item.w / 2, y: item.cy + item.h / 2 });
    const inset = app.r.insets;
    const left = inset.left + VIEW_MARGIN, right = size.w - inset.right - VIEW_MARGIN;
    const top = inset.top + VIEW_MARGIN, bottom = size.h - inset.bottom - VIEW_MARGIN;
    const dx = a.x < left ? left - a.x : b.x > right ? right - b.x : 0;
    const dy = a.y < top ? top - a.y : b.y > bottom ? bottom - b.y : 0;
    // an object bigger than the view keeps its top-left in view instead of jumping
    const sx = b.x - a.x > right - left ? left - a.x : dx;
    const sy = b.y - a.y > bottom - top ? top - a.y : dy;
    if (!sx && !sy) return;
    const cam = app.r.cam;
    app.r.flyToCamera({ ...cam, x: cam.x - sx / cam.zoom, y: cam.y - sy / cam.zoom });
  }

  function setCurrent(next: string | null) {
    if (next === currentId) return;
    currentId = next;
    keyboard = true;
    paintOutline();
    if (next) bringIntoView(next);
    // the window follows the current object on a big board
    const el = next ? document.getElementById(optionId(next)) : null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }

  /** The first object to be current: the selected one, else the nearest the centre of the view. */
  function entryObject(): string | null {
    const selected = app.selection.find((s) => entries.some((e) => e.id === s));
    if (selected) return selected;
    if (!items.length) return null;
    const size = app.r.size();
    const centre = { x: app.r.cam.x + size.w / 2 / app.r.cam.zoom, y: app.r.cam.y + size.h / 2 / app.r.cam.zoom };
    const objectsOnly = items.filter((i) => !i.connector);
    const pool = objectsOnly.length ? objectsOnly : items;
    let best = pool[0];
    for (const i of pool) if (Math.hypot(i.cx - centre.x, i.cy - centre.y) < Math.hypot(best.cx - centre.x, best.cy - centre.y)) best = i;
    return best.id;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.target !== target || e.ctrlKey || e.metaKey || e.altKey) return;
    const direction = ARROWS[e.key];
    let next: string | null | undefined;
    if (direction) {
      // a selected current object is nudged by the arrows, as it always was
      if (currentId && app.selection.includes(currentId)) return;
      if (!currentId) next = entryObject();
      else {
        next = nearestInDirection(items, currentId, direction);
        if (!next) {
          announce(`No object ${direction === 'up' || direction === 'down' ? direction === 'up' ? 'above' : 'below' : `to the ${direction}`}`, { key: 'canvas-edge' });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    } else if (e.key === 'PageDown') next = stepInOrder(entries, currentId, 1);
    else if (e.key === 'PageUp') next = stepInOrder(entries, currentId, -1);
    else if (e.key === 'Home') next = entries[0]?.id ?? null;
    else if (e.key === 'End') next = entries.at(-1)?.id ?? null;
    else if (e.key === 'Escape' && currentId) {
      // one step back: let go of the current object (a selection is cleared by the next Esc, as before)
      currentId = null;
      paintCurrent();
      e.preventDefault();
      e.stopPropagation();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    keyboard = true;
    if (next) setCurrent(next);
    else paintCurrent();
  }

  function onFocus() {
    collect();
    if (!currentId) currentId = entryObject();
    keyboard = target.matches?.(':focus-visible') ?? true;
    paintOutline();
    if (!told) {
      told = true;
      announce(entries.length ? 'Arrow keys move between objects.' : 'The whiteboard is empty.', { key: 'canvas-first' });
    }
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('focus', onFocus);
  target.addEventListener('blur', () => placeRing());
  // a pointer on the board puts the ring away: it is for keyboard use
  const onPointer = () => { keyboard = false; placeRing(); };
  root?.addEventListener('pointerdown', onPointer, true);

  function schedule() {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      collect();
      paintOutline();
    }, 100);
  }
  const offs = [app.on('objects', schedule), app.on('selection', schedule), app.on('flow', schedule), app.r.onCamera(placeRing)];
  collect();
  paintOutline();

  return {
    el: target,
    current: () => currentId,
    order: () => entries,
    destroy() {
      window.clearTimeout(timer);
      offs.forEach((off) => off());
      root?.removeEventListener('pointerdown', onPointer, true);
      target.remove();
      help.remove();
      ring.remove();
    },
  };
}
