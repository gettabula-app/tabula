// Template thumbnails, rendered on the fly from objects with the same markup the board draws.

import { buildConnectorLayout, connectorGeom, objBounds, unionRects, type ConnectorLayout } from './geometry';
import { SVG_DEFS, objectMarkup, type MarkupCtx } from './markup';
import { DEFAULT_META } from './store';
import { Builder, type BuilderHost, type TemplateDef } from './templates';
import { isBox, isConnector, type BaseObj, type ConnectorObj, type Label, type Obj, type Rect } from './types';
import { layoutAll } from '../shared/containers';

const DEFAULT_MAX_OBJECTS = 400;
const PAD = 0.04;

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * What a thumbnail draws for a Markdown block or a table: a quiet box at its own position and size. The content is never read, so
 * no text is measured and no table is laid out: a template can hold many blocks of thousands of characters (the layout of one
 * would take seconds), and a thumbnail only needs to say that something is there.
 */
function placeholderMarkup(o: Obj): string {
  const { x, y, w, h } = o as { x: number; y: number; w: number; h: number };
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return '';
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="4" fill="var(--paper, #FFFFFF)" stroke="color-mix(in srgb, var(--ink, #18212B) 22%, var(--paper, #FFFFFF))" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
}

/** A throwaway host for building built-in templates: no board, default fonts. */
const THUMB_HOST: BuilderHost = { user: { id: 'thumbnail' }, store: { getMeta: () => DEFAULT_META } };

/**
 * The objects as a thumbnail places them (kanban lanes and cards where their layout puts them, with the template's own labels
 * left to the caller) and the bounds of their boxes. Shared by both renderers, so they agree on where things are.
 */
function placeObjects(objects: Obj[]): { objects: Obj[]; get: (id: string) => Obj | undefined; bounds: Rect; laid: ReturnType<typeof layoutAll> } {
  const laid = layoutAll(objects);
  const placed = laid.layouts.size ? objects.map((o) => { const r = laid.rects.get(o.id); return r ? { ...o, ...r } as Obj : o; }) : objects;
  const byId = new Map(placed.map((o) => [o.id, o]));
  const get = (id: string) => byId.get(id);
  const rects = placed.filter(isBox).flatMap((o) => objBounds(get, o) ?? []);
  return { objects: placed, get, bounds: unionRects(rects) ?? { x: 0, y: 0, w: 100, h: 100 }, laid };
}

/**
 * An inline SVG of the objects, fitted to the bounds of their boxes. Colours stay as theme variables,
 * so the thumbnail follows the theme. Above `maxObjects` only frames and stickies are drawn.
 */
export function thumbnailSvg(objects: Obj[], opts: { maxObjects?: number; labels?: readonly { id: string; name: string; color: string }[] } = {}): string {
  // kanbans are drawn where their layout puts them (docs/kanban.md, Templates), with the template's own labels
  const { objects: placed, get, bounds: b, laid } = placeObjects(objects);
  const labels = new Map((opts.labels ?? []).map((l, i): [string, Label] => [l.id, { ...l, order: i }]));
  const pad = Math.max(b.w, b.h, 1) * PAD;
  const simplified = placed.length > (opts.maxObjects ?? DEFAULT_MAX_OBJECTS);
  const shown = simplified ? placed.filter((o) => o.type === 'frame' || o.type === 'sticky') : placed;
  // The template's own connectors only: a thumbnail shows the objects as they would look on an empty board.
  let layout: ConnectorLayout | undefined;
  const ctx: MarkupCtx = {
    get, layout: () => (layout ??= buildConnectorLayout(get, placed.filter(isConnector))),
    containerLayout: (id) => laid.layouts.get(id) ?? null, label: (id) => labels.get(id),
  };
  const body = shown.map((o) => (o.type === 'markdown' || o.type === 'table' ? placeholderMarkup(o) : objectMarkup(o, ctx))).join('');
  const view = `${round(b.x - pad)} ${round(b.y - pad)} ${round(b.w + pad * 2)} ${round(b.h + pad * 2)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"><defs>${SVG_DEFS}</defs>${body}</svg>`;
}

// ---------------------------------------------------------------- block pictures (the stored image of a board)

/*
 * A block picture shows the shape of a board without its words: no text, no names, no notes' content. Stickies are colour blocks
 * with grey bars for their lines, frames and lanes are outlines and columns, cards and shapes are blocks, connectors are lines.
 * It is the only picture that a board may have on the Boards home for other people to see: nothing user-written reaches the
 * markup. Only numbers (rounded here), our own colour tokens, and a plain hex colour from the object (SAFE_HEX) are written; any
 * other colour falls back to ours. No name, text, alt text, font, id or link is written: text is read only as a has-content flag, and
 * kind only to pick a shape's outline.
 */

const BLOCK_W = 480;
const BLOCK_H = 300;
const SAFE_HEX = /^#[0-9a-fA-F]{6}$/u;
/** A connector's route: move commands and numbers only, as geometry.ts writes them. NaN or Infinity never match. */
const SAFE_PATH = /^[MLHVCSQTAZ0-9eE.,\s+-]*$/u;

const PAPER = 'var(--paper, #FFFFFF)';
const ink = (pct: number) => `color-mix(in srgb, var(--ink, #18212B) ${pct}%, transparent)`;
const OUTLINE = ink(28);
const BAR = ink(24);
const LINK = ink(45);
const LANE = `color-mix(in srgb, var(--ink, #18212B) 4%, ${PAPER})`;
const QUIET = `color-mix(in srgb, var(--ink, #18212B) 8%, ${PAPER})`;
const STICKY_GREY = '#E2E6EB';
const OUTLINED = `stroke="${OUTLINE}" stroke-width="1" vector-effect="non-scaling-stroke"`;

/** Rows of grey bars that stand in for lines of text: [top, width] as fractions of the box's height and width. */
type Row = readonly [number, number];
const STICKY_ROWS: readonly Row[] = [[0.38, 0.64], [0.56, 0.44]];
const TEXT_ROWS: readonly Row[] = [[0.2, 0.8], [0.4, 0.6]];
const BLOCK_ROWS: readonly Row[] = [[0.12, 0.9], [0.32, 0.8], [0.52, 0.86], [0.72, 0.55]];
const SHAPE_ROWS: readonly Row[] = [[0.42, 0.6]];

/** A colour from the object only when it is a plain hex colour; anything else (a name, a url, a function) gets our fallback. */
const colour = (raw: unknown, fallback: string): string => (typeof raw === 'string' && SAFE_HEX.test(raw) ? raw : fallback);

function rect(x: number, y: number, w: number, h: number, attrs: string): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ${attrs}/>`;
}

/** Grey bars across a box, the way a sticky's lines are set: `inset` is the left margin as a fraction of the width. */
function bars(x: number, y: number, w: number, h: number, unit: number, rows: readonly Row[], inset: number): string {
  const bh = Math.min(unit * 0.014, h * 0.08);
  if (!(bh > 0)) return '';
  return rows.map(([top, width]) => rect(x + w * inset, y + h * top, w * width, bh, `rx="${round(bh / 2)}" fill="${BAR}"`)).join('');
}

function shapeBlock(o: BaseObj, unit: number, hasText: boolean): string {
  const { x, y, w, h } = o;
  const attrs = `fill="${colour(o.fill, PAPER)}" ${OUTLINED}`;
  let geometry: string;
  if (o.kind === 'ellipse') {
    geometry = `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}" ${attrs}/>`;
  } else if (o.kind === 'diamond') {
    const pts = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]].map(([px, py]) => `${round(px)},${round(py)}`);
    geometry = `<polygon points="${pts.join(' ')}" ${attrs}/>`;
  } else {
    geometry = rect(x, y, w, h, `rx="4" ${attrs}`);
  }
  return geometry + (hasText ? bars(x, y, w, h, unit, SHAPE_ROWS, 0.2) : '');
}

function connectorBlock(c: ConnectorObj, get: (id: string) => Obj | undefined, layout: ConnectorLayout | undefined): string {
  const g = connectorGeom(get, c, layout);
  if (!g || !SAFE_PATH.test(g.d)) return '';
  return `<path d="${g.d}" fill="none" stroke="${colour(c.stroke, LINK)}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
}

/** One object as a block. Unknown types and UML draw as a quiet box; groups and paths draw nothing. */
function blockOf(o: Obj, get: (id: string) => Obj | undefined, unit: number, layout: ConnectorLayout | undefined): string {
  if (isConnector(o)) return connectorBlock(o, get, layout);
  if (!isBox(o)) return '';
  const { x, y, w, h } = o;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return '';
  const hasText = typeof o.text === 'string' && o.text.trim() !== '';
  switch (o.type) {
    case 'sticky': return rect(x, y, w, h, `rx="${round(Math.min(6, w * 0.05))}" fill="${colour(o.fill, STICKY_GREY)}"`) + bars(x, y, w, h, unit, STICKY_ROWS, 0.18);
    case 'text': return hasText ? bars(x, y, w, h, unit, TEXT_ROWS, 0.04) : '';
    case 'markdown':
    case 'table':
    case 'code': return bars(x, y, w, h, unit, BLOCK_ROWS, 0.06);
    case 'frame':
    case 'container':
    case 'tracker': return rect(x, y, w, h, `rx="6" fill="${colour(o.fill, 'none')}" ${OUTLINED}`);
    case 'lane': return rect(x, y, w, h, `rx="4" fill="${LANE}" ${OUTLINED}`);
    case 'card': return rect(x, y, w, h, `rx="4" fill="${colour(o.fill, PAPER)}" ${OUTLINED}`) + bars(x, y, w, h, unit, TEXT_ROWS, 0.1);
    case 'shape': return shapeBlock(o, unit, hasText);
    case 'group':
    case 'path': return '';
    default: return rect(x, y, w, h, `rx="4" fill="${QUIET}"`);
  }
}

/**
 * The block picture of a board: the same fitting as thumbnailSvg, on a 480 x 300 (16:10) frame. The padded bounds are grown to that
 * ratio around their centre and the frame is filled with the paper colour first, so a board is letterboxed, never cropped. Carries
 * no names, words or user strings (see the note above). Deterministic: the same objects give the same string.
 */
export function blockThumbnailSvg(objects: Obj[], opts: { maxObjects?: number } = {}): string {
  const { objects: placed, get, bounds: b } = placeObjects(objects);
  const simplified = placed.length > (opts.maxObjects ?? DEFAULT_MAX_OBJECTS);
  const shown = simplified ? placed.filter((o) => o.type === 'frame' || o.type === 'sticky') : placed;
  const pad = Math.max(b.w, b.h, 1) * PAD;
  let vw = b.w + pad * 2;
  let vh = b.h + pad * 2;
  if (vw / vh > BLOCK_W / BLOCK_H) vh = (vw * BLOCK_H) / BLOCK_W;
  else vw = (vh * BLOCK_W) / BLOCK_H;
  const vx = b.x + b.w / 2 - vw / 2;
  const vy = b.y + b.h / 2 - vh / 2;
  const unit = Math.max(vw, vh);
  const connectors = placed.filter(isConnector);
  const layout = connectors.length ? buildConnectorLayout(get, connectors) : undefined;
  const body = shown.map((o) => blockOf(o, get, unit, layout)).join('');
  const view = `${round(vx)} ${round(vy)} ${round(vw)} ${round(vh)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BLOCK_W}" height="${BLOCK_H}" viewBox="${view}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">`
    + `<rect x="${round(vx)}" y="${round(vy)}" width="${round(vw)}" height="${round(vh)}" fill="${PAPER}"/>${body}</svg>`;
}

const builtins = new Map<string, string>();

/** Thumbnail of a built-in template, from a throwaway build of its objects. Memoised per template. */
export function builtinThumbnail(def: TemplateDef): string {
  let svg = builtins.get(def.id);
  if (svg === undefined) {
    const b = new Builder(THUMB_HOST, 0, 0);
    def.build(b);
    svg = thumbnailSvg(b.objs, { labels: b.labels });
    builtins.set(def.id, svg);
  }
  return svg;
}

const blockBuiltins = new Map<string, string>();

/** Block picture of a built-in template (see blockThumbnailSvg), from a throwaway build of its objects. Memoised per template. */
export function builtinBlockThumbnail(def: TemplateDef): string {
  let svg = blockBuiltins.get(def.id);
  if (svg === undefined) {
    const b = new Builder(THUMB_HOST, 0, 0);
    def.build(b);
    svg = blockThumbnailSvg(b.objs);
    blockBuiltins.set(def.id, svg);
  }
  return svg;
}
