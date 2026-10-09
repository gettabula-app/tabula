import type { BaseObj, GridType, Id, Obj, Point, Rect } from './types';
import { isBox, isConnector } from './types';
import { isContainerType } from '../shared/containers';
import type { Store } from './store';
import type { ImageState } from './image-loader';
import { boxBounds, buildConnectorLayout, center, connectorGeom, movedConnectors, objBounds, rectsIntersect, rotate, sideAnchor, type ConnectorLayout } from './geometry';
import { SVG_DEFS, objectMarkup, type MarkupCtx } from './markup';
import { clearMeasureCache, escapeXml } from './text';
import { onFontLoaded } from './fonts';
import { WIRE } from './palette';
import { PIN_R, pinCenter, pinPath, type PinView } from './pins';
import type { GapMark, Guide } from './guides';

const SVGNS = 'http://www.w3.org/2000/svg';

export interface Camera { x: number; y: number; zoom: number }

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot' | 'from' | 'to';

export interface Handle { id: HandleId; p: Point }

export interface RemoteSel { ids: Id[]; color: string }

export interface Overlay {
  selection: Id[];
  hover: Id | null;
  lockedHover: Id | null;
  anchorsFor: Id | null;
  anchorHot: string | null;     // `${id}:${side}` under the pointer
  marquee: Rect | null;
  guides: Guide[];
  preview: string;              // world-space markup of an object being drawn
  remote: RemoteSel[];
  votes: Map<Id, { mine: number; total: number | null }>;
  dropTarget: Id | null;        // frame highlighted while dragging into it
  ai: string;                   // world-space markup of the AI previews on the board (ghosts), above the objects and below selections
}

export const emptyOverlay = (): Overlay => ({
  selection: [], hover: null, lockedHover: null, anchorsFor: null, anchorHot: null, marquee: null,
  guides: [], preview: '', remote: [], votes: new Map(), dropTarget: null, ai: '',
});

const GUIDE = 'var(--guide, #D6247F)';

/** Bracket over a gap: a line with an end tick on each side and the distance on a canvas-coloured pill. */
function gapMarkup(g: GapMark, px: (v: number) => number): string {
  const horizontal = g.axis === 'x';
  const mid = (g.from + g.to) / 2;
  const tick = px(4);
  const a = horizontal ? { x: g.from, y: g.at } : { x: g.at, y: g.from };
  const b = horizontal ? { x: g.to, y: g.at } : { x: g.at, y: g.to };
  const ticks = horizontal
    ? `M${a.x} ${a.y - tick}V${a.y + tick}M${b.x} ${b.y - tick}V${b.y + tick}`
    : `M${a.x - tick} ${a.y}H${a.x + tick}M${b.x - tick} ${b.y}H${b.x + tick}`;
  const c = horizontal ? { x: mid, y: g.at } : { x: g.at, y: mid };
  const w = px(12 + g.label.length * 7), h = px(16);
  return `<g><path d="M${a.x} ${a.y}L${b.x} ${b.y}${ticks}" stroke="${GUIDE}" stroke-width="${px(1)}" fill="none"/>` +
    `<rect x="${c.x - w / 2}" y="${c.y - h / 2}" width="${w}" height="${h}" rx="${px(8)}" fill="var(--canvas, #EEF1F4)" stroke="${GUIDE}" stroke-width="${px(1)}"/>` +
    `<text x="${c.x}" y="${c.y + px(4)}" font-size="${px(11)}" font-weight="600" fill="var(--canvas-ink, #18212B)" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${g.label}</text></g>`;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

/** Handles for a single selected object, in world coordinates. */
export function handlesFor(o: Obj, get: (id: string) => Obj | undefined, zoom: number, layout?: ConnectorLayout): Handle[] {
  if (isConnector(o)) {
    const g = connectorGeom(get, o, layout);
    return g ? [{ id: 'from', p: g.start }, { id: 'to', p: g.end }] : [];
  }
  // a container's size, and where its lanes and cards are, come from its layout: there is nothing to resize or turn
  if (o.locked || o.type === 'path' || isContainerType(o.type)) return [];
  const c = center(o);
  const r = o.rotation || 0;
  const L = (x: number, y: number) => rotate({ x: o.x + x, y: o.y + y }, c, r);
  const all: Handle[] = [
    { id: 'nw', p: L(0, 0) }, { id: 'n', p: L(o.w / 2, 0) }, { id: 'ne', p: L(o.w, 0) },
    { id: 'e', p: L(o.w, o.h / 2) }, { id: 'se', p: L(o.w, o.h) }, { id: 's', p: L(o.w / 2, o.h) },
    { id: 'sw', p: L(0, o.h) }, { id: 'w', p: L(0, o.h / 2) },
  ];
  let hs = all;
  if (o.type === 'text') hs = all.filter((h) => h.id === 'e' || h.id === 'w');
  if (o.type === 'uml-initial' || o.type === 'uml-final') hs = all.filter((h) => h.id.length === 2);
  if (o.type !== 'frame' && o.type !== 'uml-lifeline' && o.type !== 'uml-package') {
    hs = [...hs, { id: 'rot', p: L(o.w / 2, -24 / zoom) }];
  }
  return hs;
}

export class Renderer {
  readonly root: HTMLDivElement;
  readonly svg: SVGSVGElement;
  readonly world: SVGGElement;
  private objLayer: SVGGElement;
  private overlayLayer: SVGGElement;
  private gridRect: SVGRectElement;
  private gridDefs: SVGDefsElement;
  readonly cursorLayer: HTMLDivElement;

  cam: Camera = { x: -200, y: -120, zoom: 1 };
  overlay: Overlay = emptyOverlay();
  pins: PinView[] = [];
  editingId: string | null = null;
  isHidden: (o: BaseObj) => boolean = () => false;
  /** What there is to draw for an image object (src/image-loader.ts); until set, an image shows its placeholder. */
  imageState: (o: BaseObj) => ImageState = () => ({ kind: 'loading' });
  /** Read-only boards show the selection outline but no handles, since they cannot be dragged. */
  readOnly = false;
  gridType: GridType = 'dots';
  gridSize = 24;

  private els = new Map<Id, SVGGElement>();
  private dirty = new Set<Id>();
  private allDirty = true;
  private boundsCache = new Map<Id, Rect | null>();
  private layoutCache: ConnectorLayout | null = null;
  private lastLayout: ConnectorLayout | null = null;
  private frameQueued = false;
  private destroyed = false;
  private stopFonts: () => void = () => {};
  private resizeObserver: ResizeObserver;
  private overlayDirty = true;
  private camDirty = true;
  private cameraListeners = new Set<() => void>();
  readonly ctx: MarkupCtx;

  constructor(private store: Store, parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'board-surface';
    this.svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    this.svg.classList.add('canvas');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', 'Whiteboard canvas');
    this.svg.innerHTML = `<defs>${SVG_DEFS}</defs><defs class="grid-defs"></defs><rect class="grid-bg" x="0" y="0" width="100%" height="100%" fill="url(#grid-pattern)"/><g class="world"><g class="objects"></g><g class="overlay"></g></g>`;
    this.gridDefs = this.svg.querySelector('.grid-defs')!;
    this.gridRect = this.svg.querySelector('.grid-bg')!;
    this.world = this.svg.querySelector('.world')!;
    this.objLayer = this.svg.querySelector('.objects')!;
    this.overlayLayer = this.svg.querySelector('.overlay')!;
    this.cursorLayer = document.createElement('div');
    this.cursorLayer.className = 'cursor-layer';
    this.root.append(this.svg, this.cursorLayer);
    parent.appendChild(this.root);

    this.ctx = {
      get: (id) => this.store.getPlaced(id),
      isHidden: (o) => this.isHidden(o),
      imageState: (o) => this.imageState(o),
      editingId: null,
      layout: () => this.connectorLayout(),
    };

    store.onChange((changed) => {
      this.layoutCache = null;
      for (const id of changed) {
        this.markDirty(id);
        for (const c of store.connectorsOf(id)) this.markDirty(c.id);
      }
      this.overlayDirty = true;
      this.schedule();
    });
    this.stopFonts = onFontLoaded(() => {
      clearMeasureCache();
      this.invalidateAll();
    });
    this.resizeObserver = new ResizeObserver(() => {
      this.camDirty = true;
      this.schedule();
    });
    this.resizeObserver.observe(this.root);
  }

  /** For renderers that are not the board's own (the version preview): stop listening and leave the page. */
  destroy() {
    this.destroyed = true;
    this.stopFonts();
    this.resizeObserver.disconnect();
    this.cameraListeners.clear();
    this.root.remove();
  }

  markDirty(id: Id) {
    this.dirty.add(id);
    this.boundsCache.delete(id);
  }

  /** Redraws these objects at the next frame (an image whose bytes arrived). */
  invalidateObjects(ids: Iterable<Id>) {
    for (const id of ids) this.markDirty(id);
    this.schedule();
  }

  invalidateAll() {
    this.allDirty = true;
    this.layoutCache = null;
    this.boundsCache.clear();
    this.overlayDirty = true;
    this.schedule();
  }

  onCamera(fn: () => void) {
    this.cameraListeners.add(fn);
    return () => this.cameraListeners.delete(fn);
  }

  setCamera(c: Partial<Camera>) {
    this.cam = { ...this.cam, ...c };
    this.cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom));
    this.camDirty = true;
    this.overlayDirty = true;
    this.schedule();
    this.cameraListeners.forEach((l) => l());
  }

  setOverlay(patch: Partial<Overlay>) {
    Object.assign(this.overlay, patch);
    this.overlayDirty = true;
    this.schedule();
  }

  setPins(pins: PinView[]) {
    this.pins = pins;
    this.overlayDirty = true;
    this.schedule();
  }

  setEditing(id: string | null) {
    const prev = this.editingId;
    this.editingId = id;
    this.ctx.editingId = id;
    if (prev) this.markDirty(prev);
    if (id) this.markDirty(id);
    this.overlayDirty = true;
    this.schedule();
  }

  size() {
    const r = this.root.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1, left: r.left, top: r.top };
  }

  toWorld(sx: number, sy: number): Point {
    return { x: sx / this.cam.zoom + this.cam.x, y: sy / this.cam.zoom + this.cam.y };
  }

  toScreen(p: Point): Point {
    return { x: (p.x - this.cam.x) * this.cam.zoom, y: (p.y - this.cam.y) * this.cam.zoom };
  }

  /** Client (event) coordinates to world coordinates. */
  clientToWorld(cx: number, cy: number): Point {
    const s = this.size();
    return this.toWorld(cx - s.left, cy - s.top);
  }

  viewport(): Rect {
    const s = this.size();
    return { x: this.cam.x, y: this.cam.y, w: s.w / this.cam.zoom, h: s.h / this.cam.zoom };
  }

  zoomAt(screen: Point, factor: number) {
    const before = this.toWorld(screen.x, screen.y);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    this.setCamera({ zoom, x: before.x - screen.x / zoom, y: before.y - screen.y / zoom });
  }

  /** Screen area covered by floating chrome; fitting keeps content clear of it. */
  insets = { top: 64, right: 16, bottom: 72, left: 80 };

  private fitCam(r: Rect, pad: number, maxZoom: number): Camera {
    const s = this.size();
    const i = this.insets;
    const aw = Math.max(80, s.w - i.left - i.right - pad * 2);
    const ah = Math.max(80, s.h - i.top - i.bottom - pad * 2);
    const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min(aw / Math.max(r.w, 1), ah / Math.max(r.h, 1))));
    const cx = i.left + pad + aw / 2, cy = i.top + pad + ah / 2;
    return { zoom, x: r.x + r.w / 2 - cx / zoom, y: r.y + r.h / 2 - cy / zoom };
  }

  /** Fit a world rect into view with padding (screen px). */
  fit(r: Rect, pad = 80, maxZoom = 2) {
    this.setCamera(this.fitCam(r, pad, maxZoom));
  }

  /** Smoothly animate the camera to fit a rect. */
  flyTo(r: Rect, pad = 80, maxZoom = 1.5) {
    this.flyToCamera(this.fitCam(r, pad, maxZoom));
  }

  /** Smoothly centre the view on a world point at a zoom level. */
  flyToCenter(p: Point, zoom: number) {
    const s = this.size();
    this.flyToCamera({ zoom, x: p.x - s.w / 2 / zoom, y: p.y - s.h / 2 / zoom });
  }

  flyToCamera(target: Camera) {
    const start = { ...this.cam };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return this.setCamera(target);
    const t0 = performance.now(), dur = 420;
    const s = this.size();
    const cx0 = start.x + s.w / 2 / start.zoom, cy0 = start.y + s.h / 2 / start.zoom;
    const cx1 = target.x + s.w / 2 / target.zoom, cy1 = target.y + s.h / 2 / target.zoom;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      // interpolate zoom geometrically for a natural feel
      const zoom = start.zoom * Math.pow(target.zoom / start.zoom, e);
      const cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
      this.setCamera({ zoom, x: cx - s.w / 2 / zoom, y: cy - s.h / 2 / zoom });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Where each connector end sits among the ends on the same side of its shape. Built on first use after a store change
   * and reused until the next one, so drawing, hit-testing and handles all read the same layout.
   */
  connectorLayout(): ConnectorLayout {
    if (!this.layoutCache) {
      const next = buildConnectorLayout((id) => this.store.getPlaced(id), this.store.ordered().filter(isConnector));
      // A connector that joins, leaves or reorders a side moves the others on it, even though they did not change.
      if (this.lastLayout) for (const id of movedConnectors(this.lastLayout, next)) this.markDirty(id);
      this.layoutCache = this.lastLayout = next;
    }
    return this.layoutCache;
  }

  bounds(o: Obj): Rect | null {
    this.connectorLayout(); // first, so connectors whose slot moved lose their cached bounds
    if (this.boundsCache.has(o.id)) return this.boundsCache.get(o.id)!;
    const b = objBounds((id) => this.store.getPlaced(id), this.store.placed(o), this.connectorLayout());
    this.boundsCache.set(o.id, b);
    return b;
  }

  contentBounds(ids?: Iterable<Id>): Rect | null {
    let rs: Rect[] = [];
    const list = ids ? [...ids].map((id) => this.store.get(id)).filter(Boolean) as Obj[] : this.store.ordered();
    for (const o of list) {
      const b = this.bounds(o);
      if (b) rs.push(b);
    }
    if (!rs.length) return null;
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    rs = [];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  schedule() {
    if (this.frameQueued || this.destroyed) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      if (!this.destroyed) this.flush();
    });
  }

  /** Render synchronously (used before export or measuring). */
  flush() {
    if (this.camDirty) this.applyCamera();
    this.renderObjects();
    if (this.overlayDirty) this.renderOverlay();
  }

  private applyCamera() {
    const { x, y, zoom } = this.cam;
    this.world.setAttribute('transform', `matrix(${zoom} 0 0 ${zoom} ${-x * zoom} ${-y * zoom})`);
    this.renderGrid();
    this.camDirty = false;
    this.root.style.setProperty('--zoom', String(zoom));
  }

  private renderGrid() {
    const { x, y, zoom } = this.cam;
    if (this.gridType === 'none') {
      this.gridRect.setAttribute('fill', 'transparent');
      return;
    }
    this.gridRect.setAttribute('fill', 'url(#grid-pattern)');
    let step = this.gridSize;
    while (step * zoom < 10) step *= 5;
    while (step * zoom > 100 && step / 5 >= 1) step /= 5;
    const s = step * zoom;
    const ox = -x * zoom, oy = -y * zoom;
    const mod = (a: number, m: number) => ((a % m) + m) % m;
    if (this.gridType === 'dots') {
      const r = Math.min(1.6, Math.max(0.8, s / 22));
      this.gridDefs.innerHTML = `<pattern id="grid-pattern" width="${s}" height="${s}" patternUnits="userSpaceOnUse" x="${mod(ox - s / 2, s)}" y="${mod(oy - s / 2, s)}"><circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="var(--grid-dot)"/></pattern>`;
    } else if (this.gridType === 'lines') {
      const S = s * 5;
      this.gridDefs.innerHTML =
        `<pattern id="grid-minor" width="${s}" height="${s}" patternUnits="userSpaceOnUse" x="${mod(ox, s)}" y="${mod(oy, s)}"><path d="M0 0H${s}M0 0V${s}" fill="none" stroke="var(--grid-line)" stroke-width="1"/></pattern>` +
        `<pattern id="grid-pattern" width="${S}" height="${S}" patternUnits="userSpaceOnUse" x="${mod(ox, S)}" y="${mod(oy, S)}"><rect width="${S}" height="${S}" fill="url(#grid-minor)"/><path d="M0 0H${S}M0 0V${S}" fill="none" stroke="var(--grid-major)" stroke-width="1"/></pattern>`;
    } else {
      const W = s * Math.sqrt(3), H = s;
      this.gridDefs.innerHTML = `<pattern id="grid-pattern" width="${W}" height="${H}" patternUnits="userSpaceOnUse" x="${mod(ox, W)}" y="${mod(oy, H)}"><path d="M0 0L${W} ${H}M0 ${H}L${W} 0M0 0V${H}" fill="none" stroke="var(--grid-line)" stroke-width="1"/></pattern>`;
    }
  }

  private renderObjects() {
    const vp = this.viewport();
    const margin = 200 / this.cam.zoom;
    const view = { x: vp.x - margin, y: vp.y - margin, w: vp.w + margin * 2, h: vp.h + margin * 2 };
    const ordered = this.store.ordered();
    const visible = new Set<Id>();
    let prev: SVGGElement | null = null;
    for (const raw of ordered) {
      const o = this.store.placed(raw);
      const b = this.bounds(o);
      if (!b || !rectsIntersect(b, view)) continue;
      visible.add(o.id);
      let el = this.els.get(o.id);
      const fresh = !el;
      if (!el) {
        el = document.createElementNS(SVGNS, 'g') as SVGGElement;
        el.dataset.id = o.id;
        this.els.set(o.id, el);
      }
      if (fresh || this.allDirty || this.dirty.has(o.id)) {
        el.innerHTML = objectMarkup(o, this.ctx);
      }
      // keep DOM order equal to paint order
      const expectedNext: ChildNode | null = prev ? prev.nextSibling : this.objLayer.firstChild;
      if (expectedNext !== el) this.objLayer.insertBefore(el, expectedNext);
      prev = el;
    }
    for (const [id, el] of this.els) {
      if (!visible.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
    this.dirty.clear();
    this.allDirty = false;
  }

  private renderOverlay() {
    this.overlayDirty = false;
    const z = this.cam.zoom;
    const px = (v: number) => v / z;
    const get = (id: string) => this.store.getPlaced(id);
    const ov = this.overlay;
    let out = ov.ai;

    // remote selections
    for (const r of ov.remote) {
      for (const id of r.ids) {
        const o = get(id);
        const b = o && this.bounds(o);
        if (b) out += `<rect x="${b.x - px(3)}" y="${b.y - px(3)}" width="${b.w + px(6)}" height="${b.h + px(6)}" fill="none" stroke="${escapeXml(r.color)}" stroke-width="${px(1.5)}" stroke-dasharray="${px(4)} ${px(3)}" rx="${px(3)}"/>`;
      }
    }

    if (ov.dropTarget) {
      const f = get(ov.dropTarget);
      if (isBox(f)) out += `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="6" fill="${WIRE}" fill-opacity="0.04" stroke="${WIRE}" stroke-width="${px(2)}"/>`;
    }

    // hover outline
    if (ov.hover && !ov.selection.includes(ov.hover)) {
      const o = get(ov.hover);
      if (o) out += this.outline(o, px(1.5), 0.6);
    }
    if (ov.lockedHover) {
      const lo = get(ov.lockedHover);
      const lb = lo?.locked && this.bounds(lo);
      if (lb) out += `<g transform="translate(${lb.x + lb.w} ${lb.y})"><circle r="${px(11)}" fill="#18212B" stroke="#fff" stroke-width="${px(1.5)}"/><g transform="translate(${-px(7)} ${-px(7)}) scale(${px(14) / 24})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/></g></g>`;
    }

    // selection
    const sel = ov.selection.map(get).filter(Boolean) as Obj[];
    for (const o of sel) out += this.outline(o, px(1.5), 1);
    if (sel.length > 1) {
      const b = this.contentBounds(ov.selection);
      if (b) out += `<rect x="${b.x - px(6)}" y="${b.y - px(6)}" width="${b.w + px(12)}" height="${b.h + px(12)}" fill="none" stroke="${WIRE}" stroke-width="${px(1)}" stroke-dasharray="${px(5)} ${px(4)}"/>`;
    }
    if (sel.length === 1 && sel[0].id !== this.editingId && !this.readOnly) {
      const o = sel[0];
      const hs = handlesFor(o, get, z, this.connectorLayout());
      const rot = hs.find((h) => h.id === 'rot');
      if (rot && isBox(o)) {
        const top = rotate({ x: o.x + o.w / 2, y: o.y }, center(o), o.rotation || 0);
        out += `<path d="M${top.x} ${top.y}L${rot.p.x} ${rot.p.y}" stroke="${WIRE}" stroke-width="${px(1)}"/>`;
      }
      for (const h of hs) {
        if (h.id === 'rot') out += `<circle cx="${h.p.x}" cy="${h.p.y}" r="${px(5)}" fill="#fff" stroke="${WIRE}" stroke-width="${px(1.5)}"/>`;
        else if (h.id === 'from' || h.id === 'to') out += `<circle cx="${h.p.x}" cy="${h.p.y}" r="${px(5.5)}" fill="#fff" stroke="${WIRE}" stroke-width="${px(2)}"/>`;
        else out += `<rect x="${h.p.x - px(4.5)}" y="${h.p.y - px(4.5)}" width="${px(9)}" height="${px(9)}" rx="${px(2)}" fill="#fff" stroke="${WIRE}" stroke-width="${px(1.5)}"/>`;
      }
    }

    // connection anchors on hover
    if (ov.anchorsFor) {
      const o = get(ov.anchorsFor);
      if (isBox(o) && o.type !== 'path') {
        for (const side of ['top', 'right', 'bottom', 'left'] as const) {
          const a = sideAnchor(o, side);
          const hot = ov.anchorHot === `${o.id}:${side}`;
          const p = { x: a.p.x + a.dir.x * px(14), y: a.p.y + a.dir.y * px(14) };
          out += `<circle class="anchor" cx="${p.x}" cy="${p.y}" r="${px(hot ? 7 : 5)}" fill="${hot ? WIRE : '#fff'}" stroke="${WIRE}" stroke-width="${px(1.5)}"/>`;
        }
      }
    }

    // snap guides and equal-gap brackets
    for (const g of ov.guides) out += g.kind === 'line' ? `<path d="M${g.x1} ${g.y1}L${g.x2} ${g.y2}" stroke="${GUIDE}" stroke-width="${px(1)}"/>` : gapMarkup(g, px);

    // drawing preview
    if (ov.preview) out += `<g opacity="0.85">${ov.preview}</g>`;

    // marquee
    if (ov.marquee) {
      const m = ov.marquee;
      out += `<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="${WIRE}" fill-opacity="0.06" stroke="${WIRE}" stroke-width="${px(1)}"/>`;
    }

    // vote badges
    for (const [id, v] of ov.votes) {
      const o = get(id);
      if (!isBox(o)) continue;
      const b = boxBounds(o);
      let x = b.x + b.w - px(10);
      const y = b.y + px(10);
      if (v.total !== null && v.total > 0) {
        const label = String(v.total);
        const w = px(14 + label.length * 7);
        out += `<g><rect x="${x - w + px(4)}" y="${y - px(10)}" width="${w}" height="${px(20)}" rx="${px(10)}" fill="#18212B"/><text x="${x - w / 2 + px(4)}" y="${y + px(4.5)}" font-size="${px(12)}" font-weight="700" fill="#FFD23F" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${label}</text></g>`;
        x -= w + px(4);
      }
      if (v.mine > 0 && v.mine <= 4) {
        for (let i = 0; i < v.mine; i++) {
          out += `<circle cx="${x - i * px(14)}" cy="${y}" r="${px(5.5)}" fill="${WIRE}" stroke="#fff" stroke-width="${px(1.5)}"/>`;
        }
      } else if (v.mine > 4) {
        // Many dots from one person: one pill with a count instead of a long row.
        const label = `${v.mine}`;
        const w = px(26 + label.length * 7);
        out += `<g><rect x="${x - w + px(5.5)}" y="${y - px(9)}" width="${w}" height="${px(18)}" rx="${px(9)}" fill="${WIRE}" stroke="#fff" stroke-width="${px(1.5)}"/>` +
          `<circle cx="${x - w + px(15)}" cy="${y}" r="${px(3.5)}" fill="#fff"/>` +
          `<text x="${x - w + px(22)}" y="${y + px(4.2)}" font-size="${px(12)}" font-weight="700" fill="#fff" font-family="Switzer, system-ui, sans-serif">${label}</text></g>`;
      }
    }

    // pins last, so they sit above selections and handles; overlay only, never in exports
    for (const p of this.pins) out += this.pinMarkup(p, px);

    this.overlayLayer.innerHTML = out;
  }

  private pinMarkup(p: PinView, px: (v: number) => number) {
    const R = px(PIN_R);
    const c = pinCenter({ x: 0, y: 0 }, R);
    const color = escapeXml(p.color);
    let body: string;
    if (p.draft) body = `<path d="${pinPath(R)}" fill="${color}" stroke="#18212B" stroke-width="${px(1.5)}" stroke-dasharray="${px(3)} ${px(2)}"/>`;
    else if (p.resolved) body = `<path d="${pinPath(R)}" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="${px(1.5)}"/>`;
    else body = `<path d="${pinPath(R)}" fill="${color}" stroke="#fff" stroke-width="${px(1.5)}"/>`;
    // a faded pin is pale, so its label takes the dark ink for contrast
    const ink = p.draft || p.resolved ? '#18212B' : '#fff';
    const ring = p.selected ? `<circle cx="${c.x}" cy="${c.y}" r="${px(PIN_R + 3)}" fill="none" stroke="${WIRE}" stroke-width="${px(2)}"/>` : '';
    const label = `<text x="${c.x}" y="${c.y + px(4)}" font-size="${px(11)}" font-weight="700" fill="${ink}" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${escapeXml(p.label)}</text>`;
    let badge = '';
    if (p.count > 1) {
      const bx = c.x + R * Math.SQRT1_2, by = c.y - R * Math.SQRT1_2;
      badge = `<circle cx="${bx}" cy="${by}" r="${px(7)}" fill="#18212B"/><text x="${bx}" y="${by + px(3.2)}" font-size="${px(9)}" font-weight="700" fill="#fff" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${p.count}</text>`;
    }
    return `<g transform="translate(${p.x} ${p.y})">${ring}${body}${label}${badge}</g>`;
  }

  private outline(o: Obj, sw: number, opacity: number) {
    if (isConnector(o)) {
      const g = connectorGeom((id) => this.store.getPlaced(id), o, this.connectorLayout());
      if (!g) return '';
      return `<path d="${g.d}" fill="none" stroke="${WIRE}" stroke-width="${sw * 2.5}" stroke-opacity="${0.25 * opacity}"/>`;
    }
    const b = o;
    const c = center(b);
    const deg = ((b.rotation || 0) * 180) / Math.PI;
    if (b.type === 'path') {
      const r = boxBounds(b);
      return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${WIRE}" stroke-width="${sw}" opacity="${opacity}"/>`;
    }
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" transform="rotate(${deg} ${c.x} ${c.y})" fill="none" stroke="${WIRE}" stroke-width="${sw}" opacity="${opacity}"/>`;
  }
}
