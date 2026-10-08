import type { BoardApp } from '../app';
import type { BaseObj, ConnectorObj, Head, Obj, Route, ShapeKind, UmlRelation, VAlign } from '../types';
import { isBox, isConnector } from '../types';
import { isSticker } from '../stickers';
import { h, icon } from './dom';
import { field, segmented, swatches } from './common';
import { FILLS, STROKES, TEXT_COLORS } from '../palette';
import { stickyColorField } from './colors';
import { SHAPE_GROUPS, SHAPE_KINDS, HEADS } from '../shapes';
import { RELATIONS, classHeight } from '../uml';
import { DEFAULTS, styleOf } from '../markup';
import { fontName, getCatalogue, nearestWeight } from '../fonts';
import { openFontPicker } from './fontpicker';
import { toMermaid } from '../mermaid';
import { toast } from './common';

const TYPE_LABEL: Record<string, string> = {
  shape: 'Shape', sticky: 'Sticky note', text: 'Text', frame: 'Frame', icon: 'Icon', path: 'Drawing', connector: 'Connector',
  'uml-class': 'Class', 'uml-actor': 'Actor', 'uml-usecase': 'Use case', 'uml-lifeline': 'Lifeline', 'uml-note': 'Note',
  'uml-package': 'Package', 'uml-state': 'State', 'uml-initial': 'Initial node', 'uml-final': 'Final node', 'uml-component': 'Component',
};

export const HAS_TEXT = (o: Obj) => isBox(o) && ['shape', 'sticky', 'text', 'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-component'].includes(o.type);
export const HAS_FILL = (o: Obj) => isBox(o) && ['shape', 'frame', 'uml-class', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-component', 'uml-final'].includes(o.type);
export const HAS_STROKE = (o: Obj) => isConnector(o) || (isBox(o) && !isSticker(o) && ['shape', 'path', 'icon', 'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-component', 'uml-initial', 'uml-final'].includes(o.type));

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96, 128];
const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extralight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extrabold', 900: 'Black' };

export function mountProps(app: BoardApp, parent: HTMLElement) {
  const panel = h('aside', { class: 'props tray', 'aria-label': 'Selection properties' });
  parent.appendChild(panel);
  let open = false;
  const toggled: (() => void)[] = [];
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(render, 30);
  };
  app.on('selection', schedule);
  app.on('meta', schedule);
  app.on('objects', () => {
    // never rebuild while the user is typing in the panel
    if (panel.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    schedule();
  });

  function render() {
    const sel = app.selected();
    const show = open && sel.length > 0 && !app.readOnly;
    panel.classList.toggle('show', show);
    if (!show) {
      panel.replaceChildren();
      return;
    }
    const first = sel[0];
    const same = sel.every((o) => o.type === first.type);
    const title = sel.length === 1 ? (isSticker(first) ? 'Sticker' : TYPE_LABEL[first.type] ?? 'Object') : `${sel.length} selected`;
    const s = styleOf(first);
    const up = (patch: Record<string, unknown>, filter?: (o: Obj) => boolean) => app.updateSelected(patch, filter);
    const blocks: (HTMLElement | null)[] = [];

    // ---- type-specific
    if (same && first.type === 'sticky') {
      const isSticky = (o: Obj) => o.type === 'sticky';
      blocks.push(field('Colour', stickyColorField(app, (first as BaseObj).fill ?? DEFAULTS.sticky.fill, (v) => {
        app.stickyColor = v;
        up({ fill: v }, isSticky);
      }, {
        // live preview while the colour picker is open
        onLive: (v) => app.store.transact(() => app.selected().filter(isSticky).forEach((o) => app.store.update(o.id, { fill: v }))),
      })));
    }
    if (same && first.type === 'shape') {
      const sel2 = h('select', { class: 'input', 'aria-label': 'Shape', onchange: (e: Event) => up({ kind: (e.target as HTMLSelectElement).value as ShapeKind }) },
        ...SHAPE_GROUPS.map(([group, label]) => h('optgroup', { label }, ...SHAPE_KINDS.filter((k) => k.group === group).map((k) => h('option', { value: k.kind, selected: (first as BaseObj).kind === k.kind }, k.label)))));
      blocks.push(field('Shape', sel2));
    }
    if (same && first.type === 'frame' && sel.length === 1) {
      const name = h('input', { class: 'input', value: (first as BaseObj).name ?? '', 'aria-label': 'Frame name' });
      name.addEventListener('change', () => up({ name: name.value }));
      blocks.push(field('Name', name));
    }
    if (same && first.type === 'uml-class') {
      const cur = (first as BaseObj).stereotype ?? '';
      const st = h('select', { class: 'input', 'aria-label': 'Stereotype', onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value || undefined;
        app.store.transact(() => {
          for (const o of app.selected()) if (isBox(o)) {
            app.store.update(o.id, { stereotype: v });
            app.store.update(o.id, { h: classHeight({ ...o, stereotype: v }) });
          }
        });
      } }, ...[['', 'Class'], ['interface', 'Interface'], ['abstract', 'Abstract'], ['enumeration', 'Enumeration'], ['entity', 'Entity'], ['service', 'Service']].map(([v, l]) => h('option', { value: v, selected: cur === v }, l)));
      blocks.push(field('Kind', st));
      if (sel.length === 1) blocks.push(h('button', { class: 'btn wide', onclick: () => app.editor.start(first.id) }, 'Edit name and members'));
    }

    if (sel.every(isConnector)) blocks.push(...connectorFields(app, sel as ConnectorObj[]));

    // ---- fill & stroke
    if (sel.some(HAS_FILL)) {
      blocks.push(field('Fill', swatches(FILLS, (first as BaseObj).fill ?? s.fill, (v) => up({ fill: v }, HAS_FILL), { label: 'Fill colour' })));
    }
    if (sel.some(HAS_STROKE)) {
      const isIcon = same && first.type === 'icon';
      blocks.push(field(isIcon ? 'Colour' : 'Line', swatches(STROKES.filter((c) => !isIcon || c.value !== 'none'), isIcon ? (first as BaseObj).textColor ?? s.stroke : first.stroke ?? s.stroke, (v) => {
        if (isIcon) up({ textColor: v });
        else up({ stroke: v }, HAS_STROKE);
      }, { label: 'Line colour' })));
      if (!isIcon) {
        blocks.push(h('div', { class: 'row2' },
          field('Width', segmented([1, 2, 3, 4, 6].map((w) => ({ value: w, label: `${w}px`, icon: h('span', { class: 'line-sample', style: `--w:${w}px` }) })), first.strokeWidth ?? s.strokeWidth, (v) => up({ strokeWidth: v }, HAS_STROKE), 'Line width')),
        ));
        if (!sel.every((o) => o.type === 'path')) {
          blocks.push(field('Style', segmented([
            { value: 'solid', label: 'Solid', icon: h('span', { class: 'dash-sample solid' }) },
            { value: 'dashed', label: 'Dashed', icon: h('span', { class: 'dash-sample dashed' }) },
            { value: 'dotted', label: 'Dotted', icon: h('span', { class: 'dash-sample dotted' }) },
          ], first.dash ?? 'solid', (v) => up({ dash: v }, HAS_STROKE), 'Line style')));
        }
      }
    }

    // ---- text
    if (sel.some(HAS_TEXT)) {
      const fb = h('button', { class: 'input font-btn', style: `font-family:"${fontName(s.font)}", system-ui`, 'aria-label': `Font: ${fontName(s.font)}` }, fontName(s.font), icon('chevron', 16));
      fb.addEventListener('click', () => {
        const used = [...new Set([...app.store.cache.values()].map((o) => (o as BaseObj).font).filter(Boolean))] as string[];
        openFontPicker(fb, s.font, (slug) => up({ font: slug, fontWeight: nearestWeight(slug, s.fontWeight) }, HAS_TEXT), { pinned: used });
      });
      blocks.push(field('Font', fb));
      const entry = getCatalogue().find((f) => f.slug === s.font);
      const weights = entry?.weights ?? [400, 500, 700];
      const size = h('select', { class: 'input', 'aria-label': 'Font size', onchange: (e: Event) => up({ fontSize: Number((e.target as HTMLSelectElement).value) }, HAS_TEXT) },
        ...[...new Set([...FONT_SIZES, s.fontSize])].sort((a, b) => a - b).map((n) => h('option', { value: n, selected: n === s.fontSize }, `${n}`)));
      const weight = h('select', { class: 'input', 'aria-label': 'Font weight', onchange: (e: Event) => up({ fontWeight: Number((e.target as HTMLSelectElement).value) }, HAS_TEXT) },
        ...weights.map((w) => h('option', { value: w, selected: w === nearestWeight(s.font, s.fontWeight) }, WEIGHT_NAMES[w] ?? String(w))));
      blocks.push(h('div', { class: 'row2' }, field('Size', size), field('Weight', weight)));
      blocks.push(field('Align', segmented([
        { value: 'left', label: 'Align left', icon: icon('alignLeft', 16) },
        { value: 'center', label: 'Align centre', icon: icon('alignCenterH', 16) },
        { value: 'right', label: 'Align right', icon: icon('alignRight', 16) },
      ], s.align, (v) => up({ align: v }, HAS_TEXT), 'Text alignment')));
      if (sel.some((o) => o.type === 'shape' || o.type === 'sticky')) {
        blocks.push(field('Vertical', segmented<VAlign>([
          { value: 'top', label: 'Align top', icon: icon('alignTop', 16) },
          { value: 'middle', label: 'Align middle', icon: icon('alignMiddleV', 16) },
          { value: 'bottom', label: 'Align bottom', icon: icon('alignBottom', 16) },
        ], s.valign, (v) => up({ valign: v }, (o) => o.type === 'shape' || o.type === 'sticky'), 'Vertical alignment')));
      }
      blocks.push(field('Text colour', swatches(TEXT_COLORS.map((c) => ({ name: c, value: c })), s.textColor, (v) => up({ textColor: v }, HAS_TEXT), { label: 'Text colour' })));
    }

    // ---- opacity
    const op = h('input', { type: 'range', min: '10', max: '100', step: '5', value: String(Math.round((first.opacity ?? 1) * 100)), class: 'range', 'aria-label': 'Opacity' });
    op.addEventListener('input', () => up({ opacity: Number(op.value) / 100 >= 1 ? undefined : Number(op.value) / 100 }));
    blocks.push(field('Opacity', op));

    // ---- arrange
    const boxes = sel.filter(isBox).length;
    if (boxes >= 2) {
      blocks.push(field('Align', h('div', { class: 'btn-row' },
        btn('alignLeft', 'Align left edges', () => app.align('left')),
        btn('alignCenterH', 'Align centres horizontally', () => app.align('centerH')),
        btn('alignRight', 'Align right edges', () => app.align('right')),
        btn('alignTop', 'Align top edges', () => app.align('top')),
        btn('alignMiddleV', 'Align centres vertically', () => app.align('middleV')),
        btn('alignBottom', 'Align bottom edges', () => app.align('bottom')),
        boxes >= 3 ? btn('distributeH', 'Distribute horizontally', () => app.distribute('h')) : null,
        boxes >= 3 ? btn('distributeV', 'Distribute vertically', () => app.distribute('v')) : null,
      )));
    }
    const locked = sel.every((o) => o.locked);
    blocks.push(h('div', { class: 'btn-row arrange' },
      btn('front', 'Bring to front ( ] )', () => app.bringToFront()),
      btn('back', 'Send to back ( [ )', () => app.sendToBack()),
      btn('dup', 'Duplicate (Ctrl/Cmd+D)', () => app.duplicate()),
      btn(locked ? 'unlock' : 'lock', locked ? 'Unlock' : 'Lock', () => app.toggleLock()),
      sel.some((o) => o.type === 'uml-class' || o.type === 'shape') ? btn('mermaid', 'Copy as Mermaid', () => {
        const ids = new Set(app.selection);
        const objs = [...app.store.cache.values()].filter((o) => ids.has(o.id) || (isConnector(o) && o.from.kind === 'bound' && o.to.kind === 'bound' && ids.has(o.from.id) && ids.has(o.to.id)));
        navigator.clipboard.writeText(toMermaid(objs)).then(() => toast('Mermaid copied to the clipboard'), () => toast('Clipboard is not available'));
      }) : null,
      btn('trash', 'Delete (Del)', () => app.deleteSelection(), 'danger'),
    ));

    panel.replaceChildren(h('div', { class: 'props-head' }, h('h2', null, title), h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close properties', onclick: () => toggle() }, icon('close', 18))), ...blocks.filter(Boolean) as HTMLElement[]);
  }
  function toggle() {
    open = !open;
    render();
    toggled.forEach((f) => f());
  }
  render();
  return { toggle, isOpen: () => open, onToggle: (fn: () => void) => { toggled.push(fn); } };
}

function btn(name: Parameters<typeof icon>[0], label: string, onClick: () => void, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title: label, 'aria-label': label, onclick: onClick }, icon(name, 18));
}

function connectorFields(app: BoardApp, sel: ConnectorObj[]): HTMLElement[] {
  const c = sel[0];
  const up = (p: Partial<ConnectorObj>) => app.updateSelected(p, isConnector);
  const out: HTMLElement[] = [];
  out.push(field('Route', segmented<Route>([
    { value: 'straight', label: 'Straight' }, { value: 'elbow', label: 'Elbow' }, { value: 'curved', label: 'Curved' },
  ], c.route, (v) => {
    up({ route: v });
    app.connectorDefaults.route = v;
  }, 'Connector route')));
  const headSel = (cur: Head, key: 'startHead' | 'endHead', label: string) => h('select', {
    class: 'input', 'aria-label': label,
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value as Head;
      up({ [key]: v, relation: undefined });
      app.connectorDefaults[key] = v;
    },
  }, ...HEADS.map((x) => h('option', { value: x.head, selected: x.head === cur }, x.label)));
  out.push(h('div', { class: 'row2' }, field('Start', headSel(c.startHead, 'startHead', 'Start arrowhead')), field('End', headSel(c.endHead, 'endHead', 'End arrowhead'))));
  const rel = h('select', {
    class: 'input', 'aria-label': 'UML relationship',
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value as UmlRelation | '';
      if (!v) return up({ relation: undefined });
      const r = RELATIONS[v];
      up({ relation: v, startHead: r.startHead, endHead: r.endHead, dash: r.dash });
    },
  }, h('option', { value: '' }, 'None'), ...Object.entries(RELATIONS).map(([k, r]) => h('option', { value: k, selected: c.relation === k }, r.label)));
  out.push(field('UML relationship', rel));
  if (sel.length === 1) {
    const lab = h('input', { class: 'input', value: c.label ?? '', placeholder: 'Add a label', 'aria-label': 'Connector label' });
    lab.addEventListener('change', () => up({ label: lab.value || undefined }));
    out.push(field('Label', lab));
  }
  out.push(h('button', { class: 'btn wide', onclick: () => {
    app.store.transact(() => {
      for (const o of sel) app.store.update(o.id, { from: o.to, to: o.from, startHead: o.endHead, endHead: o.startHead });
    });
  } }, 'Reverse direction'));
  return out;
}
