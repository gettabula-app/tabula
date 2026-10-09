import type { BoardApp } from '../app';
import type { Align, BaseObj, ConnectorObj, Obj, Route, VAlign } from '../types';
import { isBox, isConnector } from '../types';
import { h, icon } from './dom';
import { closePopover, field, popover, segmented, swatches } from './common';
import { FILLS, STROKES, TEXT_COLORS, colorName } from '../palette';
import { stickyColorField } from './colors';
import { SHAPE_GROUPS, SHAPE_KINDS, shapePreviewSvg } from '../shapes';
import { DEFAULTS, styleOf } from '../markup';
import { safeColor } from '../../shared/colors';
import { downloadCardsCsv } from '../exporters';
import { HAS_FILL, HAS_STROKE, HAS_TEXT } from './props';
import type { mountProps } from './props';
import { clampX, clearOfDock, dockTopOf, placeBar, type Box } from './quickbar-layout';

// the phone layout of styles.css, where the rail runs the full height
const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;
import { connectorGeom } from '../geometry';
import { reactionPicker } from './stickers';
import { aiBarFor, glyph, onAiBarChange } from './ai-bar';
import { openSaveTemplate } from './save-template';

type IconName = Parameters<typeof icon>[0];

const isSticky = (o: Obj) => o.type === 'sticky';
const isVAligned = (o: Obj) => o.type === 'shape' || o.type === 'sticky';
// Boxes without a rotate handle; every other single box gets a rotate handle above it, so the bar lifts clear of it.
const NO_ROTATE = ['frame', 'uml-lifeline', 'uml-package', 'path'];

/** Floating quick actions above the selection. Rebuilds only on selection and meta changes, so open pickers survive. */
export function mountQuickbar(app: BoardApp, parent: HTMLElement, props: ReturnType<typeof mountProps>) {
  const bar = h('div', { class: 'tray quickbar', role: 'region', 'aria-label': 'Quick actions' });
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
    // Below the top bars, and above the properties panel when a phone docks it to the bottom edge.
    const top = parseFloat(getComputedStyle(bar).getPropertyValue('--panel-top')) || 72;
    const dock = dockTopOf(props.el.classList.contains('show') ? props.el.getBoundingClientRect() : null, top);
    const view = { w: window.innerWidth, h: dock ?? window.innerHeight };
    const p = placeBar({ x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y }, { w: bar.offsetWidth, h: bar.offsetHeight }, view, lift, undefined, top, undefined, [...connectorBoxes(), ...aiBarBox()]);
    const railClear = isPhone() ? parseFloat(getComputedStyle(bar).getPropertyValue('--rail-clear')) || 76 : 12;
    bar.style.transform = `translate(${clampX(p.x, bar.offsetWidth, view.w, railClear)}px, ${clearOfDock(p.y, bar.offsetHeight, dock, top)}px)`;
    below = p.below;
  }

  /** The AI bar (or its button) is one more thing the quick bar keeps off: it flips above the selection instead of landing under it. */
  function aiBarBox(): Box[] {
    const r = aiBarFor(app)?.rect();
    if (!r) return [];
    const origin = parent.getBoundingClientRect();
    return [{ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }];
  }

  /** Screen boxes around each segment of the connectors attached to the selection, with room for arrowheads. */
  function connectorBoxes(): Box[] {
    const get = (id: string) => app.store.getPlaced(id);
    const ids = new Set<string>();
    for (const o of app.selected()) for (const c of app.store.connectorsOf(o.id)) ids.add(c.id);
    const out: Box[] = [];
    const pad = 8;
    for (const id of ids) {
      const c = app.store.get(id);
      const g = isConnector(c) ? connectorGeom(get, c, app.r.connectorLayout()) : null;
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
    // styleOf resolves the stored colour through the colour grammar: it becomes a custom property below (TAB-203)
    return o ? styleOf(o)[key] : 'none';
  };
  const stickyFill = () => safeColor((app.selected()[0] as BaseObj | undefined)?.fill, DEFAULTS.sticky.fill);

  function swatch(label: string, current: () => string, content: () => HTMLElement) {
    const chip = h('span', { class: 'qb-chip' });
    const b: HTMLButtonElement = h('button', { class: 'icon-btn qb-swatch', 'aria-label': label, 'aria-haspopup': 'dialog', onclick: () => open(b, content()) }, chip);
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
    const b: HTMLButtonElement = h('button', { class: 'icon-btn', 'aria-label': label, 'aria-haspopup': 'dialog', onclick: () => open(b, content()) }, icon(name, 18));
    return b;
  }

  function action(name: IconName, label: string, onClick: () => void, cls = '', key?: string) {
    return h('button', { class: `icon-btn${cls ? ` ${cls}` : ''}`, 'aria-label': label, 'data-tip-key': key, onclick: onClick }, icon(name, 18));
  }

  /**
   * Kanban entries (docs/kanban.md, States): a card gets Open as the primary action, then Owner, Due and Labels (each
   * opens the card dialog on that field) and Turn into sticky; stickies get Turn into card and, two or more, Make kanban;
   * a kanban gets its Labels.
   */
  function kanbanActions(sel: Obj[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    const cards = sel.filter((o) => o.type === 'card');
    const stickies = sel.filter(isSticky);
    if (cards.length === 1 && sel.length === 1) {
      const id = cards[0].id;
      out.push(
        h('button', { class: 'icon-btn qb-text on', type: 'button', 'aria-label': 'Open card', 'data-tip-key': 'enter', onclick: () => app.openCardDialog(id) }, 'Open'),
        action('user', 'Owner', () => app.openCardDialog(id, 'owner')),
        action('calendar', 'Due date', () => app.openCardDialog(id, 'due')),
        action('tag', 'Labels', () => app.openCardDialog(id, 'labels')),
      );
    }
    if (cards.length && cards.length === sel.length) out.push(action('sticky', cards.length === 1 ? 'Turn into sticky' : 'Turn into stickies', () => app.turnIntoStickies(), '', 'k'));
    if (stickies.length && app.canTurnIntoCards()) out.push(action('card', stickies.length === 1 ? 'Turn into card' : 'Turn into cards', () => app.turnIntoCards(), '', 'k'));
    if (stickies.length >= 2 && app.kanbanCreation) out.push(action('kanban', 'Make kanban from selection', () => app.makeKanbanFromSelection()));
    if (sel.length === 1 && sel[0].type === 'container') {
      const id = sel[0].id;
      // slice 4: Add lane and Filter, as the design's quick-action bar for a kanban, and its ⋯ menu (the bar's own ⋯ is
      // the properties panel)
      // slice 5: Open as list, the primary action on a phone (docs/kanban.md, Visual design, Phone)
      out.push(isPhone()
        ? h('button', { class: 'icon-btn qb-text on', type: 'button', 'aria-label': 'Open as list', onclick: () => app.openKanbanList(id) }, 'Open as list')
        : action('kanban', 'Open as list', () => app.openKanbanList(id)));
      out.push(
        action('plus', 'Add lane', () => app.addLaneTo(id)),
        action('filter', 'Filter cards', () => app.openContainerControl(id, 'filter')),
        action('tag', 'Labels', () => app.openLabels?.()),
        action('download', 'Export cards (CSV)', () => downloadCardsCsv(app, [id])),
        action('menu', 'Kanban menu', () => app.openContainerControl(id, 'menu')),
      );
    }
    if (sel.length === 1 && sel[0].type === 'lane') {
      const id = sel[0].id;
      out.push(action('menu', 'Lane menu', () => app.openLaneMenu(id)));
    }
    return out;
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
    groups.push(kanbanActions(sel));

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
            class: k.kind === cur ? 'on' : '', 'data-tip': k.label, 'aria-label': k.label, html: shapePreviewSvg(k.kind, { w: 36, h: 28 }, 3),
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

    // Images (docs/images.md): back to the natural size, and a description for screen readers and the summary
    const pictures = sel.filter((o): o is BaseObj => o.type === 'image');
    const picture: HTMLElement[] = [];
    if (pictures.length) {
      picture.push(h('button', {
        class: 'icon-btn qb-text', 'aria-label': 'Actual size', 'data-tip': 'Reset to the natural size',
        onclick: () => app.store.transact(() => pictures.forEach((o) => {
          if (o.nw && o.nh) app.store.update(o.id, { x: Math.round(o.x + o.w / 2 - o.nw / 2), y: Math.round(o.y + o.h / 2 - o.nh / 2), w: o.nw, h: o.nh });
        })),
      }, '100%'));
      if (pictures.length === 1) {
        picture.push(menu('text', 'Alt text', () => {
          const input = h('input', { class: 'input', maxlength: 300, value: pictures[0].alt ?? '', 'aria-label': 'Alt text', placeholder: 'Describe the picture', autocomplete: 'off' });
          const save = () => app.updateSelected({ alt: input.value.trim() || undefined }, (o) => o.type === 'image');
          input.addEventListener('change', save);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              save();
              closePopover();
            }
          });
          return field('Alt text', input);
        }));
      }
    }
    groups.push(picture);

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
        parts.push(field('Text colour', swatches(TEXT_COLORS.map((c) => ({ name: colorName(c), value: c })), s.textColor, (v) => app.updateSelected({ textColor: v }, HAS_TEXT), { label: 'Text colour' })));
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
    // opens the AI bar with Cluster armed on these stickies; it runs nothing
    if (aiBarFor(app) && sel.filter(isSticky).length >= 2) {
      arrange.push(h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Cluster with AI', 'data-tip': 'Cluster with AI',
        onclick: () => aiBarFor(app)?.open({ arm: 'cluster', context: 'selection' }),
      }, glyph('spark', 18)));
    }
    groups.push(arrange);
    groups.push([menu('stickers', 'React with a sticker', () => reactionPicker(app))]);

    lock = h('button', { class: 'icon-btn', onclick: () => app.toggleLock() });
    more = h('button', { class: 'icon-btn', 'aria-label': 'More properties', onclick: () => props.toggle() }, icon('dots', 18));
    groups.push([
      lock,
      action('dup', 'Duplicate', () => app.duplicate(), '', 'mod+d'),
      action('templates', 'Save as template', () => openSaveTemplate(app, [...app.selection])),
      action('trash', 'Delete', () => app.deleteSelection(), 'danger', 'delete'),
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
  // the AI bar mounting adds or takes away Cluster; its moving makes the quick bar find its place again
  onAiBarChange(app, (why) => {
    if (why === 'layout') {
      if (shown) position();
      return;
    }
    build();
    sync();
  });
  // the panel's top moves when it opens, closes or is rebuilt at another height, and the bar keeps clear of it
  new ResizeObserver(() => { if (shown) position(); }).observe(props.el);

  build();
  sync();
}
