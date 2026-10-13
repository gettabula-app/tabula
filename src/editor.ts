import type { BoardApp } from './app';
import type { BaseObj, ConnectorObj, Id, Obj } from './types';
import { isBox, isConnector } from './types';
import { center, connectorGeom, rotate } from './geometry';
import { LABEL_FONT, labelBox, labelPill, layoutText, markdownBoxHeight, styleOf, textHeight } from './markup';
import { fontFamily } from './fonts';
import { MD_PAD } from './markdown-layout';
import { TABLE_PAD_X, TABLE_PAD_Y, layoutTable } from './table-layout';
import { MAX_CELL_CHARS, insertRowPatch, setCellPatch, tableModel } from '../shared/tables';
import { CANVAS_INK } from './palette';
import { classHeight, formatClass, parseClass } from './uml';
import { KANBAN, LIMITS } from '../shared/containers';
import { safeColor } from '../shared/colors';

type EditMode = 'text' | 'class' | 'frame' | 'label' | 'cell';

/** Objects whose edited text is a name, not their text. */
const NAMED = (type: string) => type === 'frame' || type === 'container' || type === 'lane';

/**
 * Colours for the edit box. The class and label editors sit in a white box with dark ink
 * (styles.css) unless the object has its own colours; an empty string keeps that default.
 */
export function editColours(o: Obj, mode: EditMode): { color: string; background: string } {
  if (mode === 'text') return { color: styleOf(o).textColor, background: '' };
  if (mode === 'frame') return { color: 'var(--ink)', background: '' };
  // stored colours become inline styles here (`background` would load a url()), so only the colour grammar (TAB-203)
  if (mode === 'label') {
    // the renderer draws a label in the connector's own colour
    const stroke = safeColor((o as ConnectorObj).stroke, null);
    return { color: stroke && stroke !== 'none' && stroke !== CANVAS_INK ? stroke : '', background: '' };
  }
  const b = o as BaseObj;
  const fill = safeColor(b.fill, null);
  return { color: safeColor(b.textColor, null) ?? '', background: fill && fill !== 'none' ? fill : '' };
}

/**
 * In-place text editing: a textarea laid over the object in world space
 * (scaled with the camera), writing to the board on every keystroke so
 * collaborators see typing live.
 */
export class TextEditor {
  private ta: HTMLTextAreaElement;
  private id: Id | null = null;
  /** The table cell being edited (mode 'cell'): its row and column ids. */
  private cell: { rowId: string; colId: string } | null = null;
  private mode: EditMode = 'text';
  private unsubCam: (() => void) | null = null;
  private original = '';
  private selectionStart = 0;
  private selectionEnd = 0;
  private blurHeld = false;
  private bottomInset = 0;

  constructor(private app: BoardApp) {
    this.ta = document.createElement('textarea');
    this.ta.className = 'text-editor';
    this.ta.spellcheck = true;
    this.ta.setAttribute('aria-label', 'Edit text');
    this.ta.addEventListener('input', () => {
      this.rememberSelection();
      this.onInput();
    });
    this.ta.addEventListener('keyup', () => this.rememberSelection());
    this.ta.addEventListener('pointerup', () => this.rememberSelection());
    this.ta.addEventListener('select', () => this.rememberSelection());
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.commit();
      }
      if (e.key === 'Enter' && !e.shiftKey && (this.mode === 'frame' || this.mode === 'label')) {
        e.preventDefault();
        this.commit();
      }
      if (e.key === 'Tab' && this.mode === 'cell' && this.active) {
        // a table cell: Tab and Shift+Tab move to the next and previous cell (Tab on the last cell adds a row); Enter is a new line in the cell
        e.preventDefault();
        this.moveCell(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Tab' && this.isMarkdown()) {
        // in Markdown a Tab indents (nested lists); Esc or Ctrl/Cmd+Enter leaves
        e.preventDefault();
        this.insertAtCursor('  ');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commit();
      }
      e.stopPropagation();
    });
    this.ta.addEventListener('blur', () => {
      this.rememberSelection();
      if (!this.blurHeld) this.commit();
    });
    app.r.root.appendChild(this.ta);
  }

  get active() {
    return this.id !== null;
  }

  private isMarkdown(): boolean {
    return this.active && this.app.store.get(this.id ?? undefined)?.type === 'markdown';
  }

  get textMode(): boolean {
    return this.active && this.mode === 'text';
  }

  get textarea() {
    return this.ta;
  }

  /** The edited object's own box on screen (a note's whole face, not the text box inside it); null for a connector label. */
  objectScreenRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number } | null {
    const o = this.app.store.getPlaced(this.id ?? undefined) as BaseObj | undefined;
    if (!o || isConnector(o) || (o.rotation ?? 0) !== 0) return null;
    if (o.type === 'markdown') {
      // the source box can be taller than the drawn block: the corner button belongs to the box that is being typed in
      const r = this.ta.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }
    const a = this.app.r.toScreen({ x: o.x, y: o.y });
    const b = this.app.r.toScreen({ x: o.x + o.w, y: o.y + o.h });
    const root = this.app.r.root.getBoundingClientRect();
    const left = root.left + a.x;
    const top = root.top + a.y;
    return { left, top, right: root.left + b.x, bottom: root.top + b.y, width: b.x - a.x, height: b.y - a.y };
  }

  /** Room kept clear at the bottom of the text (px on screen) for the corner button; 0 when it is elsewhere. */
  setBottomInset(px: number) {
    if (this.bottomInset === px) return;
    this.bottomInset = px;
    if (this.active) this.reposition();
  }

  private rememberSelection() {
    this.selectionStart = this.ta.selectionStart;
    this.selectionEnd = this.ta.selectionEnd;
  }

  holdBlur(on: boolean) {
    this.blurHeld = on;
  }

  focus() {
    if (!this.active) return;
    this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(this.selectionStart, this.selectionEnd);
  }

  insertAtCursor(text: string) {
    if (!this.textMode) return;
    const start = Math.min(this.selectionStart, this.ta.value.length);
    const end = Math.min(Math.max(start, this.selectionEnd), this.ta.value.length);
    this.ta.setRangeText(text, start, end, 'end');
    this.ta.dispatchEvent(new Event('input', { bubbles: true }));
    this.ta.focus({ preventScroll: true });
    const caret = start + text.length;
    this.ta.setSelectionRange(caret, caret);
    this.rememberSelection();
  }

  start(id: Id) {
    if (this.app.readOnly) return;
    if (this.id) this.commit();
    const o = this.app.store.get(id);
    if (!o || o.locked) return;
    this.id = id;
    if (isConnector(o)) {
      this.mode = 'label';
      this.original = o.label ?? '';
    } else if (o.type === 'uml-class') {
      this.mode = 'class';
      this.original = formatClass(o);
    } else if (NAMED(o.type)) {
      this.mode = 'frame';
      this.original = (o as BaseObj).name ?? '';
    } else {
      this.mode = 'text';
      this.original = o.text ?? '';
    }
    this.ta.value = this.original;
    const markdown = o.type === 'markdown';
    // a Markdown block opens with the caret at the end of its source (select-all would let one keystroke replace it)
    this.selectionStart = this.selectionEnd = markdown ? this.original.length : 0;
    this.ta.dataset.mode = this.mode;
    this.ta.dataset.kind = o.type;
    this.ta.placeholder = markdown ? 'Write Markdown: # heading, **bold**, - [ ] task, | table |' : '';
    this.ta.style.display = 'block';
    this.app.r.setEditing(id);
    this.app.store.undo.stopCapturing();
    this.reposition();
    this.unsubCam = this.app.r.onCamera(() => this.reposition());
    requestAnimationFrame(() => {
      this.ta.focus();
      if (markdown) this.ta.setSelectionRange(this.original.length, this.original.length);
      else this.ta.select();
      this.rememberSelection();
    });
    this.app.emit('editing');
  }

  /** Edits one cell of a table in place (docs/tables.md): the textarea sits over the cell, and every keystroke writes that cell's own key. */
  startCell(id: Id, rowId: string, colId: string) {
    if (this.app.readOnly) return;
    if (this.id) this.commit();
    const o = this.app.store.get(id);
    if (!o || o.locked || o.type !== 'table') return;
    const model = tableModel(o as unknown as Record<string, unknown>);
    if (!model.rows.includes(rowId) || !model.cols.includes(colId)) return;
    this.id = id;
    this.cell = { rowId, colId };
    this.mode = 'cell';
    this.original = model.cell(rowId, colId);
    this.ta.value = this.original;
    this.selectionStart = this.selectionEnd = this.original.length;
    this.ta.dataset.mode = 'cell';
    this.ta.dataset.kind = 'table';
    this.ta.placeholder = '';
    this.ta.style.display = 'block';
    this.app.r.setEditing(id);
    this.app.store.undo.stopCapturing();
    this.reposition();
    this.unsubCam = this.app.r.onCamera(() => this.reposition());
    // focused at once, so a Tab or a keystroke right after a move goes into this cell, not to the page behind it
    this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(this.original.length, this.original.length);
    this.rememberSelection();
    requestAnimationFrame(() => {
      if (this.id !== id || this.cell?.rowId !== rowId || this.cell?.colId !== colId) return;
      this.ta.focus();
      this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
      this.rememberSelection();
    });
    this.app.emit('editing');
  }

  /** The cell being edited, when a table cell is. */
  get editingCell(): { id: Id; rowId: string; colId: string } | null {
    return this.id && this.cell && this.mode === 'cell' ? { id: this.id, ...this.cell } : null;
  }

  /** Leaves this cell and edits the one `step` away in reading order (rows, then columns); a Tab past the last cell adds a row. */
  private moveCell(step: 1 | -1) {
    const here = this.editingCell;
    if (!here) return;
    const obj = this.app.store.get(here.id) as unknown as Record<string, unknown> | undefined;
    if (!obj) return;
    const model = tableModel(obj);
    const r = model.rows.indexOf(here.rowId);
    const c = model.cols.indexOf(here.colId);
    const at = r * model.cols.length + c + step;
    this.commit();
    if (at < 0) return;
    if (at >= model.rows.length * model.cols.length) {
      const rowId = this.newTableId();
      const patch = insertRowPatch(obj, model.rows.length - 1, rowId);
      if (!patch) return;
      this.app.store.transact(() => this.app.store.update(here.id, patch as never));
      this.growTable(here.id);
      this.startCell(here.id, rowId, model.cols[0]);
      return;
    }
    this.startCell(here.id, model.rows[Math.floor(at / model.cols.length)], model.cols[at % model.cols.length]);
  }

  private newTableId(): string {
    return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  }

  /** Fits the table object to its columns and rows after a change. */
  private growTable(id: Id) {
    const o = this.app.store.get(id);
    if (!o || o.type !== 'table') return;
    this.app.fitTable(id);
  }

  reposition() {
    const id = this.id;
    const o = this.app.store.getPlaced(id ?? undefined);
    if (!o) return;
    const r = this.app.r;
    const z = r.cam.zoom;
    const ta = this.ta;
    const st = styleOf(o);
    ta.style.fontFamily = fontFamily(st.font);
    ta.style.fontWeight = String(st.fontWeight);
    const colours = editColours(o, this.mode);
    ta.style.color = colours.color;
    ta.style.background = colours.background;
    ta.style.textAlign = st.align;
    ta.style.padding = ''; // the label editor sets all four sides; the other modes set only the top

    if (isConnector(o)) {
      // the same pill as the rendered label, sized to the text as it is typed (wide enough for the caret when empty)
      const g = connectorGeom((x) => this.app.store.getPlaced(x), o, r.connectorLayout());
      if (!g) return;
      const pill = labelPill(ta.value);
      const w = Math.max(pill.w, 24) + 2, h = pill.h; // 2 units of slack so the textarea never wraps sooner than the label
      ta.style.fontFamily = fontFamily('satoshi');
      ta.style.fontWeight = String(LABEL_FONT.weight);
      const scale = this.setEditorFont(LABEL_FONT.size);
      ta.style.lineHeight = `${LABEL_FONT.line / scale}px`;
      ta.style.padding = `${LABEL_FONT.padY / scale}px ${LABEL_FONT.padX / scale}px`;
      ta.style.textAlign = 'center';
      this.place(g.mid.x - w / 2, g.mid.y - h / 2, w, h, 0, z, scale);
      return;
    }
    const b = o as BaseObj;
    if (this.mode === 'cell' && b.type === 'table' && this.cell) {
      // the textarea is the cell: same box, same padding and font as the drawn text, on the canvas colour so the cell's own text is not seen twice
      const layout = layoutTable(b as unknown as Record<string, unknown>, { font: st.font, size: st.fontSize, weight: st.fontWeight });
      const cell = layout.cells.find((x) => x.rowId === this.cell!.rowId && x.colId === this.cell!.colId);
      if (!cell) { this.commit(); return; }
      const header = (b.headerRow === true && cell.row === 0) || (b.headerCol === true && cell.col === 0);
      ta.style.fontWeight = header ? '700' : String(st.fontWeight);
      ta.style.textAlign = 'left';
      ta.style.color = 'var(--ink)';
      ta.style.background = 'var(--canvas, #fff)';
      const scale = this.setEditorFont(st.fontSize);
      ta.style.lineHeight = '1.45';
      ta.style.padding = `${TABLE_PAD_Y / scale}px ${TABLE_PAD_X / scale}px`;
      const c = center(b);
      const tl = rotate({ x: b.x + cell.x, y: b.y + cell.y }, c, b.rotation || 0);
      this.place(tl.x, tl.y, cell.w, cell.h, b.rotation || 0, z, scale);
      return;
    }
    if (b.type === 'markdown') {
      // the source in a monospace face over the block, as tall as it needs (the rendered block keeps its own height under it)
      ta.style.fontFamily = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      ta.style.fontWeight = '400';
      ta.style.textAlign = 'left';
      ta.style.color = 'var(--ink)';
      ta.style.background = 'var(--canvas, #fff)';
      const scale = this.setEditorFont(st.fontSize * 0.92);
      ta.style.lineHeight = '1.45';
      ta.style.padding = `${MD_PAD / scale}px`;
      ta.style.paddingBottom = `${(MD_PAD + this.bottomInset / (z * scale)) / scale}px`;
      ta.style.height = 'auto';
      const need = ta.scrollHeight * scale;
      const c = center(b);
      const tl = rotate({ x: b.x, y: b.y }, c, b.rotation || 0);
      this.place(tl.x, tl.y, b.w, Math.max(b.h, need), b.rotation || 0, z, scale);
      return;
    }
    const centred = b.type === 'shape' || b.type === 'sticky';
    let box = { x: 0, y: 0, w: b.w, h: b.h };
    let fontSize = st.fontSize;
    if (centred) box = labelBox(b);
    if (NAMED(b.type)) {
      // a frame's name sits above it; a container's and a lane's sit in their header band
      box = b.type === 'lane' ? { x: KANBAN.lanePad, y: 8, w: b.w - KANBAN.lanePad * 2, h: 32 }
        : b.type === 'container' ? { x: KANBAN.pad, y: 10, w: Math.max(200, b.w / 2), h: 28 }
        : { x: 0, y: -34, w: Math.max(b.w, 200), h: 28 };
      fontSize = st.fontSize;
      ta.style.textAlign = 'left';
    }
    if (b.type === 'uml-class') {
      box = { x: 0, y: 0, w: Math.max(b.w, 240), h: Math.max(b.h, 160) };
      fontSize = 14;
      ta.style.textAlign = 'left';
      ta.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    }
    if (b.type === 'uml-note') ta.style.textAlign = 'left';
    if (b.type === 'uml-actor') box = { x: -60, y: b.h - 22, w: b.w + 120, h: 26 };
    if (b.type === 'uml-lifeline') box = { x: 6, y: 4, w: b.w - 12, h: 36 };
    if (b.type === 'uml-package') {
      box = { x: 4, y: 0, w: Math.max(160, b.w * 0.6), h: 24 };
      ta.style.textAlign = 'left';
    }
    const centredLayout = centred ? layoutText(ta.value || ' ', box, st, { shrink: true, valign: st.valign }) : null;
    if (centredLayout) fontSize = centredLayout.size;
    const scale = this.setEditorFont(fontSize);
    // room kept clear at the bottom for the corner button: screen px, so divided by the overlay's scale
    if (this.bottomInset) ta.style.paddingBottom = `${this.bottomInset / (z * scale)}px`;
    ta.style.lineHeight = centredLayout ? `${centredLayout.lineHeight / scale}px` : '1.3';
    ta.style.paddingTop = centredLayout ? `${Math.max(0, centredLayout.top - box.y) / scale}px` : '0px';
    ta.style.setProperty('--touch-editor-class-padding', `${8 / scale}px`);
    const c = center(b);
    const tl = rotate({ x: b.x + box.x, y: b.y + box.y }, c, b.rotation || 0);
    this.place(tl.x, tl.y, box.w, box.h, b.rotation || 0, z, scale);
    // same layout as the renderer, so the text stays where it is drawn
    if (!centred) {
      if (b.type !== 'text' && b.type !== 'uml-class' && b.type !== 'uml-note' && !NAMED(b.type)) {
        ta.style.paddingTop = '0px';
        const content = ta.scrollHeight * scale;
        ta.style.paddingTop = `${Math.max(0, (box.h - content) / 2) / scale}px`;
      } else ta.style.paddingTop = '0px';
    }
  }

  /** The touch CSS enforces 16 CSS px; scale the overlay back to the board font's visual size. */
  private setEditorFont(size: number) {
    const scale = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? Math.min(1, size / 16) : 1;
    this.ta.style.fontSize = `${size}px`;
    this.ta.style.setProperty('--touch-input-font-size', `${size}px`);
    return scale;
  }

  private place(x: number, y: number, w: number, h: number, rot: number, z: number, scale = 1) {
    const s = this.app.r.toScreen({ x, y });
    const ta = this.ta;
    ta.style.width = `${w / scale}px`;
    ta.style.height = `${h / scale}px`;
    ta.style.transform = `translate(${s.x}px, ${s.y}px) rotate(${rot}rad) scale(${z * scale})`;
  }

  private onInput() {
    const id = this.id;
    const o = id ? this.app.store.get(id) : undefined;
    if (!o) return;
    const v = this.ta.value;
    const s = this.app.store;
    if (this.mode === 'text') {
      s.transact(() => {
        s.update(o.id, { text: v });
        if (o.type === 'text') s.update(o.id, { h: textHeight({ ...(o as BaseObj), text: v }) });
        if (o.type === 'markdown') s.update(o.id, { h: markdownBoxHeight({ ...(o as BaseObj), text: v }) });
      });
    } else if (this.mode === 'cell' && this.cell) {
      const patch = setCellPatch(o as unknown as Record<string, unknown>, this.cell.rowId, this.cell.colId, v);
      if (patch) {
        s.transact(() => s.update(o.id, patch as never));
        this.app.fitTable(o.id);
      } else if (this.original !== v) this.ta.value = [...v].slice(0, MAX_CELL_CHARS).join(''); // past the cell limit: the text stays at the limit
    } else if (this.mode === 'frame') {
      // lane and kanban names have limits (docs/kanban.md, Limits: 60 and 80 characters); a frame's name has none
      const max = o.type === 'lane' ? LIMITS.laneName : o.type === 'container' ? LIMITS.containerName : Infinity;
      const name = v.length > max ? v.slice(0, max) : v;
      if (name !== v) this.ta.value = name;
      s.transact(() => s.update(o.id, { name }));
    } else if (this.mode === 'label') {
      s.transact(() => s.update(o.id, { label: v || undefined }));
      this.reposition(); // the pill grows and wraps with the text
    }
    if (o.type === 'text' || o.type === 'markdown' || this.mode === 'cell') this.reposition();
    else if (this.mode === 'text') {
      // re-centre vertically as lines are added
      requestAnimationFrame(() => this.reposition());
    }
  }

  commit() {
    const id = this.id;
    if (!id) return;
    this.id = null;
    this.cell = null;
    this.unsubCam?.();
    this.unsubCam = null;
    const o = this.app.store.get(id);
    const v = this.ta.value;
    this.ta.style.display = 'none';
    this.blurHeld = false;
    this.ta.blur();
    if (o && this.mode === 'class' && isBox(o)) {
      const parsed = parseClass(v);
      this.app.store.transact(() => {
        this.app.store.update(o.id, { ...parsed, stereotype: parsed.stereotype });
        const next = { ...o, ...parsed } as BaseObj;
        this.app.store.update(o.id, { h: Math.max(classHeight(next), 60) });
      });
    }
    // An empty text object is removed when editing ends.
    if (o && (o.type === 'text' || o.type === 'markdown') && !v.trim()) this.app.store.transact(() => this.app.store.remove([o.id]));
    this.app.r.setEditing(null);
    this.app.store.undo.stopCapturing();
    this.app.emit('editing');
  }
}
