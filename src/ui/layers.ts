import './layers.css';
import type { BoardApp } from '../app';
import type { BaseObj, Id, Obj } from '../types';
import { NAME_MAX, hiddenCount, layerTree, moveAmongSiblings, moveNextTo, type LayerBoard, type LayerNode } from '../layers';
import {
  canDrag, clickSelection, collapsedKey, dropTarget, hiddenText, keyIntent, lineEdge, navigate, parseCollapsed, pastDragStart, renameChange,
  rowName, serializeCollapsed, siblingSlots, subject, toggleLabel, toggleVerb, typeGlyph, type Drop, type IconName,
} from '../layers-ui-logic';
import { h, icon } from './dom';

// The layers panel (TAB-198): a tab of the left drawer listing the board's objects top first, with a row per object.
// The rows come from src/layers.ts, what a click or key does from src/layers-ui-logic.ts; this file draws and wires them.

const GLYPH = 16;
const SELECT_BLOCKED = { hidden: 'Hidden objects cannot be selected. Show it first.', locked: 'Locked objects cannot be selected. Unlock it first.' };

interface Row {
  el: HTMLElement;
  twist: HTMLElement;
  glyph: HTMLElement;
  label: HTMLElement;
  flags: HTMLElement;
  grip: HTMLElement;
  hide: HTMLButtonElement;
  lock: HTMLButtonElement;
  sig: string;
}

interface Drag {
  id: Id;
  x: number;
  y: number;
  active: boolean;
  drop: Drop | null;
  raf: number;
  stop: AbortController;
}

/** Set by Alt+L: the tab that opens next puts focus in its list. */
let focusOnOpen = false;
let focusList: (() => void) | null = null;

const readCollapsed = (boardId: string) => {
  try {
    return parseCollapsed(localStorage.getItem(collapsedKey(boardId)));
  } catch {
    return new Set<Id>();
  }
};

const writeCollapsed = (boardId: string, collapsed: ReadonlySet<Id>) => {
  try {
    if (collapsed.size) localStorage.setItem(collapsedKey(boardId), serializeCollapsed(collapsed));
    else localStorage.removeItem(collapsedKey(boardId));
  } catch {
    // storage can be blocked; the panel then opens everything each time
  }
};

const rowIdOf = (el: Element | EventTarget | null): Id | undefined =>
  (el instanceof Element ? el.closest<HTMLElement>('.layer-row') : null)?.dataset.id;

/** The panel for the drawer: the body, and the "N hidden" count that goes beside the drawer's title. `signal` ends it. */
export function layersTab(app: BoardApp, signal: AbortSignal): { body: HTMLElement; count: HTMLElement } {
  const boardId = app.conn.id;
  const collapsed = readCollapsed(boardId);
  const board: LayerBoard = {
    visible: (o) => !app.flow.isHidden(o as BaseObj),
    isLaidOut: (o) => app.store.isLaidOut(o),
    layoutOrder: (id) => app.store.containerLayout(id)?.order ?? [],
  };
  const list = h('div', { class: 'layers-list', role: 'tree', 'aria-label': 'Layers', 'aria-multiselectable': 'true' });
  const empty = h('p', { class: 'layers-empty' }, 'Nothing on this board yet.');
  const count = h('span', { class: 'layers-count' });
  const line = h('div', { class: 'layer-line', 'aria-hidden': 'true' });
  const body = h('div', { class: 'drawer-body layers' }, list, empty);

  const rows = new Map<Id, Row>();
  let nodes: LayerNode[] = [];
  let current: Id | null = null;
  let raf = 0;
  let stale = false;
  let reveal = false;
  let renaming: { finish: (commit: boolean, back: boolean) => void } | null = null;
  let drag: Drag | null = null;
  let suppressClick = false;

  const nodeOf = (id: Id | undefined) => nodes.find((n) => n.id === id);
  const isLaidOut = (o: Obj) => app.store.isLaidOut(o);
  const objects = () => [...app.store.cache.values()];
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(render);
  };

  // ---------------------------------------------------------------- rows

  function makeTool(what: 'hide' | 'lock') {
    return h('button', { type: 'button', class: `layer-tool ${what}`, tabindex: '-1', 'data-tool': what });
  }

  function makeRow(id: Id): Row {
    const twist = h('span', { class: 'layer-twist', 'aria-hidden': 'true' });
    const glyph = h('span', { class: 'layer-glyph', 'aria-hidden': 'true' });
    const label = h('span', { class: 'layer-label' });
    const flags = h('span', { class: 'layer-flags', 'aria-hidden': 'true' });
    const hide = makeTool('hide');
    const lock = makeTool('lock');
    const grip = h('span', { class: 'layer-grip', 'aria-hidden': 'true' }, icon('menu', GLYPH));
    const el = h('div', { class: 'layer-row', role: 'treeitem', 'data-id': id, tabindex: '-1' },
      twist, glyph, label, flags, h('span', { class: 'layer-tools' }, hide, lock), grip);
    return { el, twist, glyph, label, flags, grip, hide, lock, sig: '' };
  }

  const setGlyph = (el: HTMLElement, name: IconName) => {
    if (el.dataset.g === name) return;
    el.dataset.g = name;
    el.replaceChildren(icon(name, GLYPH));
  };

  function paintTool(btn: HTMLButtonElement, what: 'hide' | 'lock', node: LayerNode, ro: boolean) {
    const on = what === 'hide' ? node.hidden : node.locked;
    btn.classList.toggle('on', on);
    btn.hidden = ro;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', toggleLabel(what, node));
    btn.setAttribute('data-tip', toggleVerb(what, node));
    setGlyph(btn, what === 'hide' ? (on ? 'eyeOff' : 'eye') : on ? 'lock' : 'unlock');
  }

  function paint(row: Row, node: LayerNode, ctx: { kind: string | undefined; selected: boolean; ro: boolean; isCurrent: boolean; pos: number; size: number }) {
    const sig = [node.label, node.type, ctx.kind, node.depth, node.hidden, node.locked, node.expandable, node.expanded, node.movable, ctx.selected, ctx.ro, ctx.isCurrent, ctx.pos, ctx.size].join('\u0000');
    if (sig === row.sig) return;
    row.sig = sig;
    const { el } = row;
    el.style.setProperty('--depth', String(node.depth));
    el.setAttribute('aria-level', String(node.depth + 1));
    el.setAttribute('aria-posinset', String(ctx.pos));
    el.setAttribute('aria-setsize', String(ctx.size));
    el.setAttribute('aria-selected', String(ctx.selected));
    if (node.expandable) el.setAttribute('aria-expanded', String(node.expanded));
    else el.removeAttribute('aria-expanded');
    el.setAttribute('aria-label', rowName(node));
    el.tabIndex = ctx.isCurrent ? 0 : -1;
    el.classList.toggle('selected', ctx.selected);
    el.classList.toggle('is-hidden', node.hidden);
    el.classList.toggle('is-locked', node.locked);
    el.classList.toggle('can-drag', canDrag(node, ctx.ro));
    row.twist.classList.toggle('has-kids', node.expandable);
    row.twist.classList.toggle('open', node.expanded);
    setGlyph(row.glyph, typeGlyph(node.type, ctx.kind));
    row.label.textContent = node.label;
    row.grip.hidden = !canDrag(node, ctx.ro);
    paintTool(row.hide, 'hide', node, ctx.ro);
    paintTool(row.lock, 'lock', node, ctx.ro);
    row.flags.replaceChildren(...(ctx.ro ? [node.hidden && icon('eyeOff', GLYPH), node.locked && icon('lock', GLYPH)].filter((x): x is HTMLSpanElement => !!x) : []));
  }

  function render() {
    raf = 0;
    if (signal.aborted) return;
    // a rebuild would drop the field being typed in and the row being dragged; it runs once they end
    if (renaming || drag?.active) {
      stale = true;
      return;
    }
    stale = false;
    const all = objects();
    const before = nodes;
    nodes = layerTree(all, board, collapsed);
    const ro = app.readOnly;
    list.classList.toggle('ro', ro);
    const text = hiddenText(hiddenCount(all, board));
    count.textContent = text ?? '';
    count.hidden = !text;
    list.hidden = !nodes.length;
    empty.hidden = nodes.length > 0;

    const selected = new Set(app.selection);
    if (!current || !nodes.some((n) => n.id === current)) current = nodes.find((n) => selected.has(n.id))?.id ?? nodes[0]?.id ?? null;
    const slots = siblingSlots(nodes);
    const focusedId = rowIdOf(document.activeElement);
    const focusedAt = before.findIndex((n) => n.id === focusedId);

    const live = new Set<Id>();
    for (const node of nodes) {
      live.add(node.id);
      let row = rows.get(node.id);
      if (!row) rows.set(node.id, (row = makeRow(node.id)));
      const slot = slots.get(node.id)!;
      paint(row, node, { kind: (app.store.get(node.id) as BaseObj | undefined)?.kind, selected: selected.has(node.id), ro, isCurrent: node.id === current, pos: slot.pos, size: slot.size });
    }
    for (const [id, row] of rows) {
      if (live.has(id)) continue;
      row.el.remove();
      rows.delete(id);
    }
    // only rows that are out of place move: moving one that has focus would drop its focus
    let cursor = list.firstElementChild;
    for (const node of nodes) {
      const el = rows.get(node.id)!.el;
      if (el === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(el, cursor);
    }

    if (focusedId && !list.contains(document.activeElement)) {
      const back = rows.get(focusedId) ?? rows.get(nodes[Math.min(Math.max(focusedAt, 0), nodes.length - 1)]?.id ?? '');
      back?.el.focus({ preventScroll: true });
    }
    if (reveal) {
      reveal = false;
      const first = nodes.find((n) => selected.has(n.id));
      if (first) rows.get(first.id)?.el.scrollIntoView({ block: 'nearest' });
    }
  }

  const focusRow = (id: Id | null | undefined) => {
    if (id) rows.get(id)?.el.focus();
  };

  const setCurrent = (id: Id) => {
    if (id === current) return;
    for (const prev of [current, id]) if (prev && rows.get(prev)) rows.get(prev)!.sig = '';
    if (current) rows.get(current)?.el.setAttribute('tabindex', '-1');
    current = id;
    rows.get(id)?.el.setAttribute('tabindex', '0');
  };

  const setOpen = (id: Id, open: boolean) => {
    if (open) collapsed.delete(id);
    else collapsed.add(id);
    writeCollapsed(boardId, collapsed);
    render();
  };

  // the board's state, not the last drawn row's: a key pressed within a frame of the last change still sees it
  const flagsOf = (id: Id) => {
    const o = app.store.get(id) as { hidden?: boolean; locked?: boolean } | undefined;
    return { hidden: o?.hidden === true, locked: o?.locked === true };
  };

  const selectRow = (id: Id, additive: boolean, say: boolean) => {
    if (!app.store.get(id)) return;
    const flags = flagsOf(id);
    const next = clickSelection(app.selection, { id, ...flags }, additive);
    if (next) app.setSelection(next);
    else if (say) app.announce(flags.hidden ? SELECT_BLOCKED.hidden : SELECT_BLOCKED.locked);
  };

  // ---------------------------------------------------------------- rename

  function startRename(id: Id) {
    const row = rows.get(id);
    const node = nodeOf(id);
    if (app.readOnly || renaming || !row || !node) return;
    const stored = (app.store.get(id) as { name?: unknown } | undefined)?.name;
    const explicit = typeof stored === 'string' && stored ? stored : undefined;
    const input = h('input', {
      type: 'text', class: 'layer-edit', value: explicit ?? node.label, maxlength: String(NAME_MAX),
      'aria-label': `Name of ${subject(node)}`, autocomplete: 'off', spellcheck: 'false',
    });
    let done = false;
    const finish = (commit: boolean, back: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      const change = commit ? renameChange(explicit, node.label, input.value) : { write: false as const };
      input.remove();
      row.label.hidden = false;
      if (change.write) app.rename(id, change.name);
      if (back) focusRow(id);
      if (stale) schedule();
    };
    renaming = { finish };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(e.key === 'Enter', true);
      }
    });
    input.addEventListener('blur', () => finish(true, false));
    row.label.hidden = true;
    row.label.after(input);
    input.focus();
    input.select();
  }

  // ---------------------------------------------------------------- drag

  const dropAt = (x: number, y: number, id: Id): Drop | null => {
    const over = document.elementFromPoint(x, y)?.closest<HTMLElement>('.layer-row');
    if (!over || !list.contains(over)) return null;
    const rect = over.getBoundingClientRect();
    return dropTarget(nodes, id, over.dataset.id ?? '', (y - rect.top) / rect.height);
  };

  const paintLine = (drop: Drop | null) => {
    if (!drop) return line.remove();
    const { row, edge } = lineEdge(nodes, drop);
    const el = rows.get(row)?.el;
    const target = nodeOf(drop.target);
    if (!el || !target) return line.remove();
    line.style.top = `${el.offsetTop + (edge === 'bottom' ? el.offsetHeight : 0)}px`;
    line.style.left = `${el.offsetLeft + 8 + target.depth * 16}px`;
    if (!line.isConnected) body.appendChild(line);
  };

  const updateDrag = (d: Drag) => {
    d.drop = dropAt(d.x, d.y, d.id);
    paintLine(d.drop);
  };

  function endDrag(commit: boolean) {
    const d = drag;
    if (!d) return;
    drag = null;
    d.stop.abort();
    cancelAnimationFrame(d.raf);
    line.remove();
    list.classList.remove('dragging');
    rows.get(d.id)?.el.classList.remove('dragged');
    if (d.active) {
      // the click that follows the release must not select the row under the pointer
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    if (d.active && commit && d.drop) {
      const patches = moveNextTo(objects(), d.id, d.drop.target, d.drop.where, isLaidOut);
      if (patches && app.restack(patches)) app.announce(`Moved ${nodeOf(d.id)?.label ?? 'object'} ${d.drop.where} ${nodeOf(d.drop.target)?.label ?? 'object'}`);
    }
    if (stale) schedule();
  }

  const beginDrag = (d: Drag) => {
    d.active = true;
    list.classList.add('dragging');
    rows.get(d.id)?.el.classList.add('dragged');
    const tick = () => {
      if (drag !== d) return;
      const r = body.getBoundingClientRect();
      const dy = d.y < r.top + 24 ? -10 : d.y > r.bottom - 24 ? 10 : 0;
      if (dy) {
        body.scrollTop += dy;
        updateDrag(d);
      }
      d.raf = requestAnimationFrame(tick);
    };
    d.raf = requestAnimationFrame(tick);
  };

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary || drag || renaming || app.readOnly) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, input, .layer-twist')) return;
    const id = rowIdOf(t);
    const node = nodeOf(id);
    // a finger scrolls the list; only the grip drags
    if (!id || !node || !canDrag(node, app.readOnly) || (e.pointerType === 'touch' && !t.closest('.layer-grip'))) return;
    const d: Drag = { id, x: e.clientX, y: e.clientY, active: false, drop: null, raf: 0, stop: new AbortController() };
    drag = d;
    const { signal: s } = d.stop;
    const origin = { x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', (m) => {
      if (m.pointerId !== e.pointerId) return;
      d.x = m.clientX;
      d.y = m.clientY;
      if (!d.active) {
        if (!pastDragStart(d.x - origin.x, d.y - origin.y)) return;
        beginDrag(d);
      }
      updateDrag(d);
    }, { signal: s });
    window.addEventListener('pointerup', (u) => {
      if (u.pointerId !== e.pointerId) return;
      if (d.active) {
        d.x = u.clientX;
        d.y = u.clientY;
        updateDrag(d);
      }
      endDrag(true);
    }, { signal: s });
    window.addEventListener('pointercancel', (c) => {
      if (c.pointerId === e.pointerId) endDrag(false);
    }, { signal: s });
    window.addEventListener('keydown', (k) => {
      if (k.key !== 'Escape' || !d.active) return;
      k.preventDefault();
      k.stopPropagation();
      endDrag(false);
    }, { capture: true, signal: s });
    window.addEventListener('blur', () => endDrag(false), { signal: s });
  });

  // ---------------------------------------------------------------- click, double-click, focus

  list.addEventListener('click', (e) => {
    if (suppressClick) {
      e.stopPropagation();
      return;
    }
    const t = e.target as HTMLElement;
    const id = rowIdOf(t);
    const node = nodeOf(id);
    if (!id || !node) return;
    const tool = t.closest<HTMLElement>('.layer-tool');
    if (tool) {
      if (app.readOnly) return;
      if (tool.dataset.tool === 'hide') app.setHidden([id], !flagsOf(id).hidden);
      else app.setLocked(id, !flagsOf(id).locked);
      return;
    }
    if (t.closest('.layer-twist') && node.expandable) {
      setOpen(id, !node.expanded);
      return;
    }
    selectRow(id, e.shiftKey || e.ctrlKey || e.metaKey, false);
  });

  list.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement;
    const id = rowIdOf(t);
    if (id && t.closest('.layer-label')) startRename(id);
  });

  list.addEventListener('focusin', (e) => {
    const id = rowIdOf(e.target);
    if (id) setCurrent(id);
  });

  // ---------------------------------------------------------------- keyboard

  list.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.isComposing || t instanceof HTMLInputElement) return;
    const id = rowIdOf(t);
    const node = nodeOf(id);
    const intent = keyIntent(e.key, { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
    if (!id || !node || !intent) return;
    // Enter and Space press a focused toggle; the board's Enter (edit text) and Space (pan) must not see them
    if ((intent === 'select' || intent === 'selectMore') && t.closest('button')) {
      e.stopPropagation();
      return;
    }
    const edits = intent === 'rename' || intent === 'hide' || intent === 'lock' || intent === 'moveUp' || intent === 'moveDown';
    // on a board nobody can change, H and L keep their tool meaning and the arrows their nudge
    if (edits && app.readOnly) return;
    // the board's own shortcuts (H hand, L connector, arrows nudge, Space pans) must not see keys the panel uses
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && edits) return;
    switch (intent) {
      case 'select':
      case 'selectMore':
        selectRow(id, intent === 'selectMore', true);
        break;
      case 'rename':
        startRename(id);
        break;
      case 'hide':
        app.setHidden([id], !flagsOf(id).hidden);
        break;
      case 'lock':
        app.setLocked(id, !flagsOf(id).locked);
        break;
      case 'moveUp':
      case 'moveDown': {
        const up = intent === 'moveUp';
        const patches = moveAmongSiblings(nodes, objects(), id, up ? -1 : 1, isLaidOut);
        if (patches && app.restack(patches)) app.announce(`Moved ${node.label} ${up ? 'up' : 'down'}`);
        break;
      }
      default: {
        const go = navigate(nodes, id, intent);
        if (!go) break;
        if ('focus' in go) focusRow(go.focus);
        else setOpen('expand' in go ? go.expand : go.collapse, 'expand' in go);
      }
    }
  });

  // ---------------------------------------------------------------- board events

  const offs = [
    app.on('objects', schedule),
    app.on('selection', () => {
      reveal = true;
      schedule();
    }),
    app.on('readonly', schedule),
    app.on('flow', schedule),
  ];
  focusList = () => focusRow(current);
  signal.addEventListener('abort', () => {
    offs.forEach((off) => off());
    cancelAnimationFrame(raf);
    renaming?.finish(true, false);
    endDrag(false);
    focusList = null;
  }, { once: true });

  render();
  // the body is not on the page yet: scroll to the selection and take focus once it is
  requestAnimationFrame(() => {
    if (signal.aborted) return;
    reveal = true;
    render();
    if (focusOnOpen) focusRow(current);
    focusOnOpen = false;
  });
  return { body, count };
}

const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

/**
 * Alt+L: opens the layers panel and puts focus in it; from elsewhere on the page it moves focus in; from inside the panel
 * it closes it. Text fields keep the key. Runs before the board's own keys, whose L would pick the connector.
 */
export function bindLayersKey(app: BoardApp, library: { open: (tab: 'layers') => void; readonly tab: string | null }) {
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyL' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (isTextField(e.target) || document.querySelector('.modal-back')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const inside = e.target instanceof Element && !!e.target.closest('.layers-list');
    if (library.tab !== 'layers') {
      focusOnOpen = true;
      library.open('layers');
    } else if (!inside) focusList?.();
    else library.open('layers');
  }, { capture: true, signal: app.lifetime.signal });
}
