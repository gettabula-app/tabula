import type { BoardApp } from './app';
import type { BaseObj, ConnectorObj, Id, Obj } from './types';
import { isBox, isConnector } from './types';
import { center, connectorGeom, rotate } from './geometry';
import { LABEL_FONT, labelBox, labelPill, layoutText, styleOf, textHeight } from './markup';
import { fontFamily } from './fonts';
import { CANVAS_INK } from './palette';
import { classHeight, formatClass, parseClass } from './uml';

type EditMode = 'text' | 'class' | 'frame' | 'label';

/**
 * Colours for the edit box. The class and label editors sit in a white box with dark ink
 * (styles.css) unless the object has its own colours; an empty string keeps that default.
 */
export function editColours(o: Obj, mode: EditMode): { color: string; background: string } {
  if (mode === 'text') return { color: styleOf(o).textColor, background: '' };
  if (mode === 'frame') return { color: 'var(--ink)', background: '' };
  if (mode === 'label') {
    // the renderer draws a label in the connector's own colour
    const stroke = (o as ConnectorObj).stroke;
    return { color: stroke && stroke !== 'none' && stroke !== CANVAS_INK ? stroke : '', background: '' };
  }
  const b = o as BaseObj;
  return { color: b.textColor ?? '', background: b.fill && b.fill !== 'none' ? b.fill : '' };
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

  constructor(private app: BoardApp) {
    this.ta = document.createElement('textarea');
    this.ta.className = 'text-editor';
    this.ta.spellcheck = true;
    this.ta.setAttribute('aria-label', 'Edit text');
    this.ta.addEventListener('input', () => this.onInput());
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
    this.ta.addEventListener('blur', () => this.commit());
    app.r.root.appendChild(this.ta);
  }

  get active() {
    return this.id !== null;
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
    } else if (o.type === 'frame') {
      this.mode = 'frame';
      this.original = o.name ?? '';
    } else {
      this.mode = 'text';
      this.original = o.text ?? '';
    }
    this.ta.value = this.original;
    this.ta.dataset.mode = this.mode;
    this.ta.style.display = 'block';
    this.app.r.setEditing(id);
    this.app.store.undo.stopCapturing();
    this.reposition();
    this.unsubCam = this.app.r.onCamera(() => this.reposition());
    requestAnimationFrame(() => {
      this.ta.focus();
      this.ta.select();
    });
    this.app.emit('editing');
  }

  reposition() {
    const id = this.id;
    const o = id ? this.app.store.get(id) : undefined;
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
      const g = connectorGeom((x) => this.app.store.get(x), o);
      if (!g) return;
      const pill = labelPill(ta.value);
      const w = Math.max(pill.w, 24) + 2, h = pill.h; // 2 units of slack so the textarea never wraps sooner than the label
      this.place(g.mid.x - w / 2, g.mid.y - h / 2, w, h, 0, z);
      ta.style.fontFamily = fontFamily('satoshi');
      ta.style.fontWeight = String(LABEL_FONT.weight);
      ta.style.fontSize = `${LABEL_FONT.size}px`;
      ta.style.lineHeight = `${LABEL_FONT.line}px`;
      ta.style.padding = `${LABEL_FONT.padY}px ${LABEL_FONT.padX}px`;
      ta.style.textAlign = 'center';
      return;
    }
    const b = o as BaseObj;
    const centred = b.type === 'shape' || b.type === 'sticky';
    let box = { x: 0, y: 0, w: b.w, h: b.h };
    let fontSize = st.fontSize;
    if (centred) box = labelBox(b);
    if (b.type === 'frame') {
      box = { x: 0, y: -34, w: Math.max(b.w, 200), h: 28 };
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
    ta.style.fontSize = `${fontSize}px`;
    ta.style.lineHeight = '1.3';
    const c = center(b);
    const tl = rotate({ x: b.x + box.x, y: b.y + box.y }, c, b.rotation || 0);
    this.place(tl.x, tl.y, box.w, box.h, b.rotation || 0, z);
    // same layout as the renderer, so the text stays where it is drawn
    if (centred) {
      const lay = layoutText(ta.value || ' ', box, st, { shrink: true, valign: st.valign });
      ta.style.fontSize = `${lay.size}px`;
      ta.style.lineHeight = `${lay.lineHeight}px`;
      ta.style.paddingTop = `${Math.max(0, lay.top - box.y)}px`;
    } else if (b.type !== 'text' && b.type !== 'uml-class' && b.type !== 'uml-note' && b.type !== 'frame') {
      ta.style.paddingTop = '0px';
      const content = ta.scrollHeight;
      ta.style.paddingTop = `${Math.max(0, (box.h - content) / 2)}px`;
    } else ta.style.paddingTop = '0px';
  }

  private place(x: number, y: number, w: number, h: number, rot: number, z: number) {
    const s = this.app.r.toScreen({ x, y });
    const ta = this.ta;
    ta.style.width = `${w}px`;
    ta.style.height = `${h}px`;
    ta.style.transform = `translate(${s.x}px, ${s.y}px) rotate(${rot}rad) scale(${z})`;
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
      s.transact(() => s.update(o.id, { name: v }));
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
