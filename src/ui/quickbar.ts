import type { BoardApp } from '../app';
import type { Align, BaseObj, ConnectorObj, Obj, Route, VAlign } from '../types';
import { isBox, isConnector } from '../types';
import { h, icon } from './dom';
import { closePopover, field, popover, segmented, swatches } from './common';
import { FILLS, STROKES, TEXT_COLORS } from '../palette';
import { stickyColorField } from './colors';
import { SHAPE_GROUPS, SHAPE_KINDS, shapePreviewSvg } from '../shapes';
import { DEFAULTS, styleOf } from '../markup';
import { HAS_FILL, HAS_STROKE, HAS_TEXT } from './props';
import type { mountProps } from './props';
import { placeBar, type Box } from './quickbar-layout';
import { connectorGeom } from '../geometry';
import { reactionPicker } from './stickers';
import { openSaveTemplate } from './save-template';

type IconName = Parameters<typeof icon>[0];

const isSticky = (o: Obj) => o.type === 'sticky';
const isVAligned = (o: Obj) => o.type === 'shape' || o.type === 'sticky';
// Boxes without a rotate handle; every other single box gets a rotate handle above it, so the bar lifts clear of it.
const NO_ROTATE = ['frame', 'uml-lifeline', 'uml-package', 'path'];

/** Floating quick actions above the selection. Rebuilds only on selection and meta changes, so open pickers survive. */
export function mountQuickbar(app: BoardApp, parent: HTMLElement, props: ReturnType<typeof mountProps>) {
  const bar = h('div', { class: 'tray quickbar', role: 'toolbar', 'aria-label': 'Quick actions' });
  parent.appendChild(bar);
  let below = false;
  let shown = false;
  let paints: (() => void)[] = [];
  let lock: HTMLButtonElement | undefined;
  let more: HTMLButtonElement | undefined;

  const visible = () => app.selection.length > 0 && app.tool.kind === 'select' && !app.dragging && !app.editor.active && !app.readOnly;

  function sync() {
    const show = visible();
    bar.classList.toggle('show', show);
    if (!show) {
      if (shown) closePopover();
      shown = false;
      return;
    }
    shown = true;
    position();
  }

  function position() {
    const b = app.r.contentBounds(app.selection);
    if (!b) return;
    const a = app.r.toScreen({ x: b.x, y: b.y });
    const z = app.r.toScreen({ x: b.x + b.w, y: b.y + b.h });
    const sel = app.selected();
    const lift = sel.length === 1 && isBox(sel[0]) && !sel[0].locked && !NO_ROTATE.includes(sel[0].type) ? 28 : 0;
    const p = placeBar({ x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y }, { w: bar.offsetWidth, h: bar.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }, lift, undefined, undefined, undefined, connectorBoxes());
    bar.style.transform = `translate(${p.x}px, ${p.y}px)`;
    below = p.below;
  }

  /** Screen boxes around each segment of the connectors attached to the selection, with room for arrowheads. */
  function connectorBoxes(): Box[] {
    const get = (id: string) => app.store.get(id);
    const ids = new Set<string>();
    for (const o of app.selected()) for (const c of app.store.connectorsOf(o.id)) ids.add(c.id);
    const out: Box[] = [];
    const pad = 8;
    for (const id of ids) {
      const c = app.store.get(id);
      const g = isConnector(c) ? connectorGeom(get, c) : null;
      if (!g) continue;
      const pts = g.pts.map((p) => app.r.toScreen(p));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        out.push({ x: Math.min(a.x, b.x) - pad, y: Math.min(a.y, b.y) - pad, w: Math.abs(a.x - b.x) + 2 * pad, h: Math.abs(a.y - b.y) + 2 * pad });
      }
    }
    return out;
  }

  function refreshStates() {
    const sel = app.selected();
    if (lock) {
      const locked = sel.length > 0 && sel.every((o) => o.locked);
      lock.replaceChildren(icon(locked ? 'unlock' : 'lock', 18));
      lock.title = locked ? 'Unlock' : 'Lock';
      lock.setAttribute('aria-label', locked ? 'Unlock' : 'Lock');
    }
    if (more) {
      more.classList.toggle('on', props.isOpen());
      more.setAttribute('aria-pressed', String(props.isOpen()));
    }
    paints.forEach((f) => f());
  }

  function refresh() {
    if (shown) position();
    refreshStates();
  }

  function open(anchor: HTMLElement, content: HTMLElement) {
    popover(anchor, content, { side: below ? 'bottom' : 'top', className: 'qb-pop' });
  }

  const styleValue = (key: 'fill' | 'stroke') => (): string => {
    const o = app.selected()[0];
    return o ? ((o as BaseObj)[key] ?? styleOf(o)[key]) : 'none';
  };
  const stickyFill = () => (app.selected()[0] as BaseObj | undefined)?.fill ?? DEFAULTS.sticky.fill;

  function swatch(label: string, current: () => string, content: () => HTMLElement) {
    const chip = h('span', { class: 'qb-chip' });
    const b: HTMLButtonElement = h('button', { class: 'icon-btn qb-swatch', title: label, 'aria-label': label, 'aria-haspopup': 'dialog', onclick: () => open(b, content()) }, chip);
    const paint = () => {
      const v = current();
      b.style.setProperty('--c', v);
      chip.classList.toggle('none', v === 'none');
    };
    paint();
    paints.push(paint);
    return b;
  }

  function menu(name: IconName, label: string, content: () => HTMLElement) {
    const b: HTMLButtonElement = h('button', { class: 'icon-btn', title: label, 'aria-label': label, 'aria-haspopup': 'dialog', onclick: () => open(b, content()) }, icon(name, 18));
    return b;
  }

  function action(name: IconName, label: string, onClick: () => void, cls = '') {
    return h('button', { class: `icon-btn${cls ? ` ${cls}` : ''}`, title: label, 'aria-label': label, onclick: onClick }, icon(name, 18));
  }

  function build() {
    paints = [];
    lock = undefined;
    more = undefined;
    const sel = app.selected();
    if (!sel.length) {
      bar.replaceChildren();
      return;
    }
    const first = sel[0];
    const same = sel.every((o) => o.type === first.type);
    const boxes = sel.filter(isBox).length;
    const groups: HTMLElement[][] = [];

    const style: HTMLElement[] = [];
    if (same && first.type === 'sticky') {
      style.push(swatch('Colour', stickyFill, () => field('Colour', stickyColorField(app, stickyFill(), (v) => {
        app.stickyColor = v;
        app.updateSelected({ fill: v }, isSticky);
      }, {
        onLive: (v) => app.store.transact(() => app.selected().filter(isSticky).forEach((o) => app.store.update(o.id, { fill: v }))),
        size: 'lg',
        label: 'Sticky note colour',
      }))));
    }
    if (same && first.type === 'shape') {
      style.push(menu('shapes', 'Shape', () => {
        const cur = (app.selected()[0] as BaseObj).kind;
        return h('div', null, ...SHAPE_GROUPS.flatMap(([group, label]) => [
          h('div', { class: 'list-label' }, label),
          h('div', { class: 'qb-shapes' }, ...SHAPE_KINDS.filter((k) => k.group === group).map((k) => h('button', {
            class: k.kind === cur ? 'on' : '', title: k.label, 'aria-label': k.label, html: shapePreviewSvg(k.kind, { w: 36, h: 28 }, 3),
            onclick: () => app.updateSelected({ kind: k.kind }, (o) => o.type === 'shape'),
          }))),
        ]));
      }));
    }
    if (sel.some(HAS_FILL)) {
      style.push(swatch('Fill', styleValue('fill'), () => field('Fill', swatches(FILLS, styleValue('fill')(), (v) => app.updateSelected({ fill: v }, HAS_FILL), { label: 'Fill colour' }))));
    }
    if (sel.some(HAS_STROKE) && !sel.every((o) => o.type === 'icon' || isConnector(o))) {
      style.push(swatch('Line', styleValue('stroke'), () => field('Line', swatches(STROKES, styleValue('stroke')(), (v) => app.updateSelected({ stroke: v }, HAS_STROKE), { label: 'Line colour' }))));
    }
    if (sel.every(isConnector)) {
      style.push(menu('connector', 'Route', () => field('Route', segmented<Route>([
        { value: 'straight', label: 'Straight' }, { value: 'elbow', label: 'Elbow' }, { value: 'curved', label: 'Curved' },
      ], (app.selected()[0] as ConnectorObj).route, (v) => {
        app.updateSelected({ route: v }, isConnector);
        app.connectorDefaults.route = v;
      }, 'Connector route'))));
    }
    groups.push(style);

    const text: HTMLElement[] = [];
    if (sel.some(HAS_TEXT)) {
      text.push(menu('text', 'Text', () => {
        const s = styleOf(app.selected()[0]);
        const parts: HTMLElement[] = [field('Align', segmented<Align>([
          { value: 'left', label: 'Align left', icon: icon('alignLeft', 16) },
          { value: 'center', label: 'Align centre', icon: icon('alignCenterH', 16) },
          { value: 'right', label: 'Align right', icon: icon('alignRight', 16) },
        ], s.align, (v) => app.updateSelected({ align: v }, HAS_TEXT), 'Text alignment'))];
        if (app.selected().some(isVAligned)) {
          parts.push(field('Vertical', segmented<VAlign>([
            { value: 'top', label: 'Align top', icon: icon('alignTop', 16) },
            { value: 'middle', label: 'Align middle', icon: icon('alignMiddleV', 16) },
            { value: 'bottom', label: 'Align bottom', icon: icon('alignBottom', 16) },
          ], s.valign, (v) => app.updateSelected({ valign: v }, isVAligned), 'Vertical alignment')));
        }
        parts.push(field('Text colour', swatches(TEXT_COLORS.map((c) => ({ name: c, value: c })), s.textColor, (v) => app.updateSelected({ textColor: v }, HAS_TEXT), { label: 'Text colour' })));
        return h('div', null, ...parts);
      }));
    }
    groups.push(text);

    const arrange: HTMLElement[] = [];
    if (boxes >= 2) {
      arrange.push(menu('alignLeft', 'Align', () => {
        const n = app.selected().filter(isBox).length;
        return h('div', { class: 'qb-align' },
          action('alignLeft', 'Align left edges', () => app.align('left')),
          action('alignCenterH', 'Align centres horizontally', () => app.align('centerH')),
          action('alignRight', 'Align right edges', () => app.align('right')),
          action('alignTop', 'Align top edges', () => app.align('top')),
          action('alignMiddleV', 'Align centres vertically', () => app.align('middleV')),
          action('alignBottom', 'Align bottom edges', () => app.align('bottom')),
          n >= 3 ? action('distributeH', 'Distribute horizontally', () => app.distribute('h')) : null,
          n >= 3 ? action('distributeV', 'Distribute vertically', () => app.distribute('v')) : null,
        );
      }));
    }
    groups.push(arrange);
    groups.push([menu('stickers', 'React with a sticker', () => reactionPicker(app))]);

    lock = h('button', { class: 'icon-btn', onclick: () => app.toggleLock() });
    more = h('button', { class: 'icon-btn', title: 'More properties', 'aria-label': 'More properties', onclick: () => props.toggle() }, icon('dots', 18));
    groups.push([
      lock,
      action('dup', 'Duplicate (Ctrl/Cmd+D)', () => app.duplicate()),
      action('templates', 'Save as template', () => openSaveTemplate(app, [...app.selection])),
      action('trash', 'Delete (Del)', () => app.deleteSelection(), 'danger'),
    ]);
    groups.push([more]);

    const parts = groups.filter((g) => g.length).flatMap((g, i) => (i ? [h('span', { class: 'qb-sep', 'aria-hidden': 'true' }), ...g] : g));
    bar.replaceChildren(...parts);
    refreshStates();
  }

  app.on('selection', () => {
    closePopover();
    build();
    sync();
  });
  app.on('meta', () => {
    build();
    sync();
  });
  app.on('objects', refresh);
  app.r.onCamera(() => { closePopover(); refresh(); });
  app.on('drag', sync);
  app.on('editing', sync);
  app.on('tool', sync);
  app.on('readonly', sync);
  props.onToggle(build);

  build();
  sync();
}
