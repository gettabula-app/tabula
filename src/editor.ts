import type { BoardApp } from './app';
import type { BaseObj, ConnectorObj, Id, Obj } from './types';
import { isBox, isConnector } from './types';
import { center, connectorGeom, rotate } from './geometry';
import { LABEL_FONT, labelBox, labelPill, layoutText, styleOf, textHeight } from './markup';
import { fontFamily } from './fonts';
import { CANVAS_INK } from './palette';
import { classHeight, formatClass, parseClass } from './uml';
import { KANBAN, LIMITS } from '../shared/containers';
import { safeColor } from '../shared/colors';

type EditMode = 'text' | 'class' | 'frame' | 'label';

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
  private mode: EditMode = 'text';
  private unsubCam: (() => void) | null = null;
  private original = '';
  private selectionStart = 0;
  private selectionEnd = 0;
  private blurHeld = false;

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
      if (e.key === 'Tab') {
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

  get textMode(): boolean {
    return this.active && this.mode === 'text';
  }

  get textarea() {
    return this.ta;
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
    this.selectionStart = this.selectionEnd = 0;
    this.ta.dataset.mode = this.mode;
    this.ta.style.display = 'block';
    this.app.r.setEditing(id);
    this.app.store.undo.stopCapturing();
    this.reposition();
    this.unsubCam = this.app.r.onCamera(() => this.reposition());
    requestAnimationFrame(() => {
      this.ta.focus();
      this.ta.select();
      this.rememberSelection();
    });
    this.app.emit('editing');
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
      });
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
    if (o.type === 'text') this.reposition();
    else if (this.mode === 'text') {
      // re-centre vertically as lines are added
      requestAnimationFrame(() => this.reposition());
    }
  }

  commit() {
    const id = this.id;
    if (!id) return;
    this.id = null;
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
    if (o && o.type === 'text' && !v.trim()) this.app.store.transact(() => this.app.store.remove([o.id]));
    this.app.r.setEditing(null);
    this.app.store.undo.stopCapturing();
    this.app.emit('editing');
  }
}
