// The DOM that sits over code blocks (docs/code-blocks.md): per block in view, the focusable code area (a labelled region the keyboard scrolls) and the
// two header buttons, Wrap lines and Copy code. They are real buttons over the canvas, not part of the drawing, so no export or print ever has them.
// Copy takes the plain source from the board, never the highlighted markup and never the line numbers.
import './code-controls.css';
import type { BoardApp } from '../app';
import { CODE, codeBoxHeight, layoutCode } from '../code-layout';
import { CODE_STRINGS, codeAccessibleName } from '../code-strings';
import { codeMaxScroll } from '../code-ui-logic';
import { codeScroll, onCodeScroll, setCodeScroll } from '../code-view';
import { center, rotate } from '../geometry';
import { safeObj } from '../safe-obj';
import type { BaseObj } from '../types';
import { announce } from './announce';
import { toast } from './common';
import { h, icon } from './dom';

/** How long the check mark stays on the Copy button. */
export const COPIED_MS = 1500;
/** Below this zoom the code is too small to read and the buttons would not be hit: they are not drawn. */
const MIN_ZOOM = 0.4;
/** Most blocks that get their DOM at once (a board of hundreds still pays for what it shows). */
const MAX_BLOCKS = 40;
const BAR_W = 28 * 2 + 8;
const toldLong = new Set<string>();

interface Item {
  el: HTMLElement;
  area: HTMLElement;
  bar: HTMLElement;
  copy: HTMLButtonElement;
  wrap: HTMLButtonElement;
  copiedTimer: number;
  box: { o: BaseObj };
}

export function mountCodeControls(app: BoardApp): () => void {
  // (a board UI mounted over a stand-in app, as some tests do, has no canvas to put these over)
  if (!app.r?.root || !app.r.cam) return () => {};
  const layer = h('div', { class: 'code-ctl-layer' });
  app.r.root.appendChild(layer);
  const items = new Map<string, Item>();
  let frame = 0;
  let hot: string | null = null;

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); });
  };

  const stopBoard = (e: Event) => e.stopPropagation();

  function copyOf(id: string, item: Item) {
    const o = app.store.get(id) as BaseObj | undefined;
    const text = typeof o?.text === 'string' ? o.text : '';
    const done = () => {
      window.clearTimeout(item.copiedTimer);
      item.copy.classList.add('done');
      item.copy.replaceChildren(icon('check', 16));
      announce(CODE_STRINGS.copied);
      item.copiedTimer = window.setTimeout(() => {
        item.copy.classList.remove('done');
        item.copy.replaceChildren(icon('copy', 16));
      }, COPIED_MS);
    };
    const fail = () => toast('Clipboard is not available');
    try {
      if (!navigator.clipboard?.writeText) return fail();
      navigator.clipboard.writeText(text).then(done, fail);
    } catch { fail(); }
  }

  function toggleWrap(id: string) {
    const o = app.store.get(id) as BaseObj | undefined;
    if (!o || app.readOnly || o.locked) return;
    const wrap = o.wrap !== true;
    app.store.undo.stopCapturing();
    app.store.transact(() => app.store.update(id, { wrap, h: codeBoxHeight({ ...o, wrap }) }));
    app.store.undo.stopCapturing();
  }

  function build(id: string): Item {
    const copy = h('button', { class: 'code-btn', type: 'button', 'aria-label': CODE_STRINGS.copy, 'data-tip': CODE_STRINGS.copy, 'data-act': 'copy' }, icon('copy', 16));
    const wrap = h('button', { class: 'code-btn', type: 'button', 'aria-label': CODE_STRINGS.wrap, 'aria-pressed': 'false', 'data-tip': CODE_STRINGS.wrap, 'data-act': 'wrap' }, icon('wrap', 16));
    const bar = h('div', { class: 'code-bar' }, wrap, copy);
    const area = h('div', { class: 'code-area', tabindex: '0', role: 'region' });
    const el = h('div', { class: 'code-ctl', 'data-id': id }, area, bar);
    const item: Item = { el, area, bar, copy, wrap, copiedTimer: 0, box: { o: {} as BaseObj } };
    // a press on a button is not a press on the board, and keeps the focus where it was (the textarea, while the code is being typed)
    for (const b of [copy, wrap]) {
      b.addEventListener('pointerdown', (e) => { stopBoard(e); e.preventDefault(); });
      b.addEventListener('mousedown', (e) => { stopBoard(e); e.preventDefault(); });
      b.addEventListener('dblclick', stopBoard);
      b.addEventListener('keydown', stopBoard);
      b.addEventListener('keyup', stopBoard);
    }
    copy.addEventListener('click', () => copyOf(id, item));
    wrap.addEventListener('click', () => toggleWrap(id));
    area.addEventListener('keydown', (e) => {
      if (e.target !== area) return;
      const o = app.store.get(id) as BaseObj | undefined;
      if (!o) return;
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (app.readOnly || o.locked) return;
        app.setSelection([id]);
        app.editor.start(id);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const L = layoutCode(safeObj(o) as BaseObj);
      const max = codeMaxScroll(L, o.wrap === true);
      const at = codeScroll(id);
      const step = L.charW * 4;
      const to = e.key === 'ArrowLeft' ? at - step : e.key === 'ArrowRight' ? at + step : e.key === 'Home' ? 0 : e.key === 'End' ? max : null;
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      setCodeScroll(id, to, max);
    });
    layer.appendChild(el);
    return item;
  }

  function sync() {
    const r = app.r;
    const z = r.cam.zoom;
    const size = r.size();
    const margin = 80;
    const seen = new Set<string>();
    const editing = app.editor.active ? app.r.editingId : null;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    let count = 0;
    for (const raw of app.store.shown()) {
      if (raw.type !== 'code' || count >= MAX_BLOCKS) continue;
      const o = safeObj(app.store.placed(raw)) as BaseObj;
      if (r.isHidden(o)) continue;
      const a = r.toScreen({ x: o.x, y: o.y });
      const b = r.toScreen({ x: o.x + o.w, y: o.y + o.h });
      if (b.x < -margin || a.x > size.w + margin || b.y < -margin || a.y > size.h + margin) continue;
      count++;
      seen.add(o.id);
      let item = items.get(o.id);
      if (!item) {
        item = build(o.id);
        items.set(o.id, item);
      }
      item.box.o = o;
      const L = layoutCode(o);
      // highlighting is off for code this long: the note is drawn quietly, and said once, politely, for a person who does not see it
      if (L.long && !toldLong.has(o.id)) {
        toldLong.add(o.id);
        announce(CODE_STRINGS.longNote);
      }
      const c = center(o);
      const rot = o.rotation || 0;
      const tl = r.toScreen(rotate({ x: o.x, y: o.y }, c, rot));
      item.el.style.transform = `translate(${tl.x}px, ${tl.y}px) rotate(${rot}rad)`;
      const ed = editing === o.id;
      item.el.classList.toggle('editing', ed);
      item.el.classList.toggle('sel', app.selection.includes(o.id));
      item.el.classList.toggle('hot', hot === o.id);
      item.el.classList.toggle('far', z < MIN_ZOOM);
      item.el.classList.toggle('touch', coarse);
      const name = codeAccessibleName(o);
      if (item.area.getAttribute('aria-label') !== name) item.area.setAttribute('aria-label', name);
      Object.assign(item.area.style, {
        left: `${L.textX * z}px`, top: `${L.top * z}px`, width: `${L.textW * z}px`, height: `${Math.max(0, (o.h - L.top - CODE.PAD_Y) * z)}px`,
      });
      // the buttons are as big as the drawing around them: 28px at 100%, and the header they sit in is 36
      const barX = (o.w - 12) * z - BAR_W * z;
      const barY = (L.hasHeader ? (CODE.HEADER - 28) / 2 : 8) * z;
      item.bar.style.transform = `translate(${barX}px, ${barY}px) scale(${z})`;
      item.wrap.setAttribute('aria-pressed', String(o.wrap === true));
      item.wrap.classList.toggle('on', o.wrap === true);
      item.wrap.disabled = app.readOnly || o.locked === true;
    }
    for (const [id, item] of items) {
      if (seen.has(id)) continue;
      window.clearTimeout(item.copiedTimer);
      item.el.remove();
      items.delete(id);
      if (hot === id) hot = null;
    }
  }

  // hover: the buttons show while the pointer is over the block they belong to (the board's own hit-test is for objects, this is a view of the pointer)
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const p = app.r.clientToWorld(e.clientX, e.clientY);
    let next: string | null = null;
    for (const [id, item] of items) {
      const o = item.box.o;
      const q = rotate(p, center(o), -(o.rotation || 0));
      if (q.x >= o.x && q.x <= o.x + o.w && q.y >= o.y && q.y <= o.y + o.h) next = id;
    }
    if (next === hot) return;
    items.get(hot ?? '')?.el.classList.remove('hot');
    hot = next;
    items.get(next ?? '')?.el.classList.add('hot');
  };
  const onLeave = () => {
    items.get(hot ?? '')?.el.classList.remove('hot');
    hot = null;
  };
  app.r.root.addEventListener('pointermove', onMove);
  app.r.root.addEventListener('pointerleave', onLeave);

  onCodeScroll((id) => app.r.invalidateObjects([id]));
  const offCamera = app.r.onCamera(schedule);
  const offs = (['objects', 'selection', 'editing', 'readonly', 'drag', 'meta'] as const).map((ev) => app.on(ev, schedule));
  schedule();

  return () => {
    offCamera();
    for (const off of offs) off();
    onCodeScroll(null);
    app.r.root.removeEventListener('pointermove', onMove);
    app.r.root.removeEventListener('pointerleave', onLeave);
    for (const item of items.values()) window.clearTimeout(item.copiedTimer);
    layer.remove();
    if (frame) cancelAnimationFrame(frame);
  };
}
