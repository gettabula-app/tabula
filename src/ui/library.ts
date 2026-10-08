import type { BoardApp } from '../app';
import type { BaseObj, ConnectorObj, End, Point, ShapeKind, UmlRelation } from '../types';
import { h, icon } from './dom';
import { dialog, toast } from './common';
import { SHAPE_KINDS, SHAPE_GROUPS, defaultSize, shapePreviewSvg } from '../shapes';
import { RELATIONS, UML_ELEMENTS, classHeight, type UmlElementDef } from '../uml';
import { TEMPLATES, insertTemplate } from '../templates';
import { POPULAR_SETS, iconData, iconLoader, iconSets, previewUrl, searchIcons, collectionIcons, type IconSet } from '../icons';
import { layout, parseMermaid } from '../mermaid';
import { objectMarkup } from '../markup';
import { gridView, placeSticker, stickersTab, type StickerDrag } from './stickers';

export type DrawerTab = 'shapes' | 'uml' | 'icons' | 'stickers' | 'templates';

const DND = 'application/x-driftboard';

export function mountLibrary(app: BoardApp, parent: HTMLElement) {
  const drawer = h('aside', { class: 'drawer tray', 'aria-label': 'Library' });
  parent.appendChild(drawer);
  let tab: DrawerTab | null = null;
  let stop = new AbortController();
  const listeners = new Set<(t: DrawerTab | null) => void>();

  const open = (t: DrawerTab | null) => {
    stop.abort();
    stop = new AbortController();
    tab = tab === t ? null : t;
    drawer.classList.toggle('show', !!tab);
    listeners.forEach((l) => l(tab));
    if (!tab) return drawer.replaceChildren();
    const title = { shapes: 'Shapes', uml: 'UML', icons: 'Icons', stickers: 'Stickers', templates: 'Templates' }[tab];
    const body = tab === 'shapes' ? shapesTab(app, () => open(null)) : tab === 'uml' ? umlTab(app) : tab === 'icons' ? iconsTab(app, stop.signal) : tab === 'stickers' ? stickersTab(app, draggable, stop.signal) : templatesTab(app, () => open(null));
    drawer.replaceChildren(
      h('div', { class: 'drawer-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close library', onclick: () => open(null) }, icon('close', 18))),
      body,
    );
  };

  // Drag from the library onto the canvas.
  const svg = app.r.svg;
  svg.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes(DND) && !app.readOnly) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  svg.addEventListener('drop', async (e) => {
    const raw = e.dataTransfer?.getData(DND);
    if (!raw) return;
    e.preventDefault();
    const p = app.r.clientToWorld(e.clientX, e.clientY);
    await dropItem(app, JSON.parse(raw), p);
  });

  return { open, onChange: (fn: (t: DrawerTab | null) => void) => listeners.add(fn), get tab() { return tab; } };
}

type DropItem =
  | { kind: 'shape'; shape: ShapeKind }
  | { kind: 'uml'; index: number }
  | { kind: 'icon'; name: string }
  | StickerDrag;

async function dropItem(app: BoardApp, item: DropItem, p?: Point) {
  if (app.readOnly) return;
  const place = (type: BaseObj['type'], w: number, hh: number, extra: Partial<BaseObj>) =>
    p ? app.placeAt(type, p, w, hh, extra) : app.placeAtCenter(type, w, hh, extra);
  if (item.kind === 'shape') {
    const sz = defaultSize(item.shape);
    place('shape', sz.w, sz.h, { kind: item.shape });
  } else if (item.kind === 'uml') {
    const def = UML_ELEMENTS[item.index];
    const extra = structuredClone(def.defaults || {}) as Partial<BaseObj>;
    const hh = def.type === 'uml-class' ? classHeight(extra as BaseObj) : def.h;
    place(def.type, def.w, hh, extra);
  } else if (item.kind === 'icon') {
    try {
      const d = await iconData(item.name);
      const ratio = d.width / d.height;
      const size = 64;
      place('icon', ratio >= 1 ? size : size * ratio, ratio >= 1 ? size / ratio : size, {
        ref: item.name, body: d.body, viewBox: [d.left, d.top, d.width, d.height], textColor: '#18212B',
      });
    } catch {
      toast('That icon could not be loaded. Check your connection and try again.');
    }
  } else if (item.kind === 'sticker') {
    await placeSticker(app, item.name, p);
  }
}

function draggable(el: HTMLElement, item: DropItem) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData(DND, JSON.stringify(item));
    e.dataTransfer!.effectAllowed = 'copy';
  });
  return el;
}

function shapesTab(app: BoardApp, close: () => void) {
  const input = h('input', { type: 'search', class: 'input shape-search', placeholder: 'Search shapes', 'aria-label': 'Search shapes', autocomplete: 'off' });
  const results = h('div', null);
  const tile = (kind: ShapeKind, label: string) => {
    const active = app.tool.kind === 'shape' && app.tool.shape === kind;
    const b = h('button', {
      class: `tile${active ? ' on' : ''}`, title: `${label}. Click to draw, or drag onto the board.`, 'aria-label': label,
      onclick: () => { app.setTool({ kind: 'shape', shape: kind }); close(); },
      html: `${shapePreviewSvg(kind)}<span>${label}</span>`,
    });
    return draggable(b, { kind: 'shape', shape: kind });
  };
  const render = () => {
    const query = input.value.trim();
    const q = query.toLowerCase();
    const groups = SHAPE_GROUPS.flatMap(([group, label]) => {
      const kinds = SHAPE_KINDS.filter((k) => k.group === group && (k.label.toLowerCase().includes(q) || k.kind.includes(q)));
      return kinds.length ? [h('div', { class: 'list-label' }, label), h('div', { class: 'tiles' }, ...kinds.map((k) => tile(k.kind, k.label)))] : [];
    });
    results.replaceChildren(...(groups.length ? groups : [h('div', { class: 'empty' }, `No shapes match “${query}”.`)]));
  };
  input.addEventListener('input', render);
  render();
  return h('div', { class: 'drawer-body' },
    input,
    results,
    h('p', { class: 'muted small hint' }, 'Hover a shape on the board and drag from a blue dot to connect it. Click a dot to add a connected copy.'),
  );
}

function umlPreview(app: BoardApp, def: UmlElementDef): string {
  const o = { ...app.makeObj(def.type, { x: 0, y: 0, w: def.w, h: def.h }, structuredClone(def.defaults || {})), parent: undefined } as BaseObj;
  if (o.type === 'uml-class') o.h = classHeight(o);
  const s = Math.min(64 / o.w, 52 / o.h, 1.2);
  return `<svg width="72" height="58" viewBox="${-4 / s} ${-3 / s} ${72 / s} ${58 / s}"><g transform="translate(${(64 / s - o.w) / 2} ${(52 / s - o.h) / 2})">${objectMarkup(o, { get: () => undefined })}</g></svg>`;
}

function umlTab(app: BoardApp) {
  const tiles = UML_ELEMENTS.map((def, i) => {
    const b = h('button', {
      class: 'tile uml', title: `${def.label}. Click to draw, or drag onto the board.`, 'aria-label': def.label,
      onclick: () => app.setTool({ kind: 'uml', def }),
      html: `${umlPreview(app, def)}<span>${def.label}</span>`,
    });
    return draggable(b, { kind: 'uml', index: i });
  });
  const rels = (Object.keys(RELATIONS) as UmlRelation[]).map((k) => {
    const r = RELATIONS[k];
    const from: End = { kind: 'free', x: 4, y: 10 }, to: End = { kind: 'free', x: 92, y: 10 };
    const c: ConnectorObj = { id: 'p', type: 'connector', z: 'a', from, to, route: 'straight', startHead: r.startHead, endHead: r.endHead, dash: r.dash, strokeWidth: 1.5, stroke: 'currentColor' };
    return h('button', {
      class: 'rel-row', title: `Draw a ${r.label.toLowerCase()} connector`,
      onclick: () => app.setTool({ kind: 'connector', relation: k }),
      html: `<svg width="96" height="20" viewBox="0 0 96 20">${objectMarkup(c, { get: () => undefined }).replace(/var\(--paper, #fff\)/g, 'var(--tray)')}</svg><span>${r.label}</span>`,
    });
  });
  return h('div', { class: 'drawer-body' },
    h('div', { class: 'tiles uml-tiles' }, ...tiles),
    h('div', { class: 'list-label' }, 'Relationships'),
    h('p', { class: 'muted small' }, 'Pick one, then drag from one element to another.'),
    h('div', { class: 'rels' }, ...rels),
    h('div', { class: 'list-label' }, 'Text to diagram'),
    h('button', { class: 'btn wide', onclick: () => openMermaidImport(app) }, icon('mermaid', 16), 'Import Mermaid'),
  );
}

export function openMermaidImport(app: BoardApp) {
  const ta = h('textarea', { class: 'input code', rows: 14, spellcheck: 'false', 'aria-label': 'Mermaid source' });
  ta.value = 'classDiagram\n  class Order {\n    -id: UUID\n    -total: Money\n    +submit(): void\n  }\n  class LineItem {\n    -quantity: int\n  }\n  class Payment {\n    <<interface>>\n    +charge(amount): Receipt\n  }\n  Order *-- LineItem : contains\n  Order --> Payment';
  const err = h('div', { class: 'error', role: 'alert' });
  dialog('Import Mermaid', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Paste a flowchart, classDiagram, stateDiagram-v2 or sequenceDiagram. It becomes editable shapes and connectors.'),
    ta, err,
  ), [
    { label: 'Cancel' },
    {
      label: 'Add to board', primary: true,
      onClick: () => {
        try {
          const parsed = parseMermaid(ta.value);
          // Place the diagram in empty space to the right of the board's content.
          const content = app.r.contentBounds();
          const vp = app.r.viewport();
          const objs = layout(parsed, { x: 0, y: 0 }, {
            box: (type, x, y, w, hh, extra) => ({ ...app.makeObj(type, { x, y, w, h: hh }, extra), parent: undefined }),
            connector: (from, to, extra) => ({ ...app.connectorFrom(from, to), ...extra }),
          });
          const boxes = objs.filter((o): o is BaseObj => o.type !== 'connector');
          const minX = Math.min(...boxes.map((o) => o.x)), minY = Math.min(...boxes.map((o) => o.y));
          const target = content ? { x: content.x + content.w + 200, y: content.y } : { x: vp.x + 120, y: vp.y + 120 };
          const dx = Math.round(target.x - minX), dy = Math.round(target.y - minY);
          for (const o of objs) {
            if (o.type === 'connector') {
              const c = o as ConnectorObj;
              if (c.from.kind === 'free') c.from = { ...c.from, x: c.from.x + dx, y: c.from.y + dy };
              if (c.to.kind === 'free') c.to = { ...c.to, x: c.to.x + dx, y: c.to.y + dy };
            } else {
              (o as BaseObj).x += dx;
              (o as BaseObj).y += dy;
            }
          }
          const zs = app.store.topZs(objs.length);
          objs.forEach((o, i) => (o.z = zs[i]));
          app.store.undo.stopCapturing();
          app.store.transact(() => objs.forEach((o) => app.store.create(o)));
          app.setSelection(objs.map((o) => o.id));
          const b = app.r.contentBounds(objs.map((o) => o.id));
          if (b) app.r.flyTo(b, 80, 1.2);
          toast(`Added ${objs.filter((o) => o.type !== 'connector').length} elements`);
          return true;
        } catch (e) {
          err.textContent = (e as Error).message;
          return false;
        }
      },
    },
  ]);
}

function iconsTab(app: BoardApp, signal: AbortSignal) {
  const input = h('input', { type: 'search', class: 'input', placeholder: 'Search 200,000+ icons', 'aria-label': 'Search icons' });
  const setSel = h('select', { class: 'input', 'aria-label': 'Icon set' }, h('option', { value: '' }, 'All icon sets'));
  const grid = h('div', { class: 'icon-grid', role: 'list' });
  const note = h('p', { class: 'muted small' });
  let sets: Record<string, IconSet> = {};
  let setsState: 'idle' | 'loading' | 'ready' = 'idle';

  const show = (names: string[]) => {
    if (!names.length) {
      grid.replaceChildren(h('div', { class: 'empty' }, input.value ? `No icons match “${input.value}”. Try a broader word.` : 'Search for an icon.'));
      return;
    }
    grid.replaceChildren(...names.map((n) => draggable(h('button', {
      class: 'icon-tile', title: `${n}. Click to add, or drag onto the board.`, 'aria-label': n, role: 'listitem',
      onclick: () => dropItem(app, { kind: 'icon', name: n }),
    }, h('img', { src: previewUrl(n), alt: '', loading: 'lazy', width: 28, height: 28 })), { kind: 'icon', name: n })));
    const prefixes = [...new Set(names.map((n) => n.split(':')[0]))];
    const attrib = prefixes.filter((p) => sets[p]?.attribution);
    note.textContent = attrib.length
      ? `Some results (${attrib.join(', ')}) are licensed CC BY and need attribution when you publish.`
      : 'Icons are from open-source sets via Iconify. Placed icons are stored in the board and work offline.';
  };

  const loader = iconLoader((s) => {
    const q = input.value.trim();
    const prefix = setSel.value || undefined;
    loadSets();
    return q ? searchIcons(q, prefix, 96, s) : prefix ? collectionIcons(prefix, 160, s) : searchIcons('arrow', 'lucide', 48, s);
  }, gridView(grid, show), signal);

  let t = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(loader.reload, 250);
  });
  signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  setSel.addEventListener('change', loader.reload);
  const loadSets = () => {
    if (setsState !== 'idle') return;
    setsState = 'loading';
    iconSets(signal).then((s) => {
      if (signal.aborted) return;
      setsState = 'ready';
      sets = s;
      const popular = POPULAR_SETS.filter((p) => s[p]);
      const others = Object.values(s).filter((x) => !popular.includes(x.prefix)).sort((a, b) => a.name.localeCompare(b.name));
      setSel.append(
        h('optgroup', { label: 'Popular' }, ...popular.map((p) => h('option', { value: p }, `${s[p].name} (${s[p].license})`))),
        h('optgroup', { label: 'All sets' }, ...others.map((x) => h('option', { value: x.prefix }, `${x.name} (${x.license})`))),
      );
    }).catch(() => {
      setsState = 'idle';
    });
  };
  loadSets();
  loader.reload();
  requestAnimationFrame(() => input.focus());
  return h('div', { class: 'drawer-body' }, input, setSel, grid, note);
}

function templatesTab(app: BoardApp, close: () => void) {
  const cats = [...new Set(TEMPLATES.map((t) => t.category))];
  return h('div', { class: 'drawer-body' },
    h('p', { class: 'muted small' }, 'Each template adds frames and a facilitation flow with timed steps, private writing and dot voting.'),
    ...cats.flatMap((c) => [
      h('div', { class: 'list-label' }, c),
      ...TEMPLATES.filter((t) => t.category === c).map((t) => h('button', {
        class: 'template-row',
        onclick: () => {
          insertTemplate(app, t);
          close();
          toast(`${t.name} added. Start the session from the bar at the bottom.`);
        },
      }, h('span', { class: 'tpl-name' }, t.name), h('span', { class: 'tpl-desc' }, t.description))),
    ]),
  );
}
