// Template thumbnails, rendered on the fly from objects with the same markup the board draws.

import { buildConnectorLayout, connectorGeom, objBounds, unionRects, type ConnectorLayout } from './geometry';
import { SVG_DEFS, objectMarkup, type MarkupCtx } from './markup';
import { BARS, BAR_INK, INK_VAR, OUTLINE_INK, PAPER_VAR, QUIET_FILL, STICKY_GREY, barRects, frameColours, radiusOf, resolveColour, type BarSpec } from './palette';
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

/** The objects as the pictures place them: kanban lanes and cards at their layout's place. For a picture drawn from the same objects elsewhere. */
export function placedObjects(objects: Obj[]): Obj[] {
  return placeObjects(objects).objects;
}

/** The objects of a built-in template, from a throwaway build (no board, default fonts). */
export function templateObjects(def: TemplateDef): Obj[] {
  const b = new Builder(THUMB_HOST, 0, 0);
  def.build(b);
  return b.objs;
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
 * A block picture shows the shape of a board without its words: no text, no names, no notes' content. Stickies are solid soft colour
 * blocks with grey bars for their lines; frames, containers and lanes are tinted in their own colour with a thin darker edge (neutral
 * when they have none); cards and shapes are blocks; connectors are lines. The tints, bars and corner radii are the numbers of
 * src/palette.ts, which the schematic tile (ui/board-preview.ts) draws from too, so the two are one family.
 * It is the only picture that a board may have on the Boards home for other people to see: nothing user-written reaches the markup.
 * Only numbers (rounded here), our own colour tokens, and a plain hex colour from the object (or a sticky colour name, written as its
 * hex) are written; any other colour falls back to ours. No name, text, alt text, font, id or link is written: text is read only as a
 * has-content flag, and kind only to pick a shape's outline.
 */

const BLOCK_W = 480;
const BLOCK_H = 300;
/** A connector's route: move commands and numbers only, as geometry.ts writes them. NaN or Infinity never match. */
const SAFE_PATH = /^[MLHVCSQTAZ0-9eE.,\s+-]*$/u;

const PAPER = PAPER_VAR;
const OUTLINED = `stroke="${OUTLINE_INK}" stroke-width="1" vector-effect="non-scaling-stroke"`;
const LINK = `color-mix(in srgb, ${INK_VAR} 45%, transparent)`;

function rect(x: number, y: number, w: number, h: number, attrs: string): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ${attrs}/>`;
}

/** Grey bars across a box: the sticky's, the text's or a block's rows, with the same weight in the schematic tile. */
function bars(x: number, y: number, w: number, h: number, unit: number, spec: BarSpec): string {
  return barRects(x, y, w, h, unit, spec).map((b) => rect(b.x, b.y, b.w, b.h, `rx="${round(b.rx)}" fill="${BAR_INK}"`)).join('');
}

function shapeBlock(o: BaseObj, unit: number, hasText: boolean): string {
  const { x, y, w, h } = o;
  const attrs = `fill="${resolveColour(o.fill) ?? PAPER}" ${OUTLINED}`;
  let geometry: string;
  if (o.kind === 'ellipse') {
    geometry = `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}" ${attrs}/>`;
  } else if (o.kind === 'diamond') {
    const pts = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]].map(([px, py]) => `${round(px)},${round(py)}`);
    geometry = `<polygon points="${pts.join(' ')}" ${attrs}/>`;
  } else {
    geometry = rect(x, y, w, h, `rx="${round(radiusOf(unit))}" ${attrs}`);
  }
  return geometry + (hasText ? bars(x, y, w, h, unit, BARS.shape) : '');
}

function connectorBlock(c: ConnectorObj, get: (id: string) => Obj | undefined, layout: ConnectorLayout | undefined): string {
  const g = connectorGeom(get, c, layout);
  if (!g || !SAFE_PATH.test(g.d)) return '';
  return `<path d="${g.d}" fill="none" stroke="${resolveColour(c.stroke) ?? LINK}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
}

/** One object as a block. Unknown types and UML draw as a quiet box; groups and paths draw nothing. */
function blockOf(o: Obj, get: (id: string) => Obj | undefined, unit: number, layout: ConnectorLayout | undefined): string {
  if (isConnector(o)) return connectorBlock(o, get, layout);
  if (!isBox(o)) return '';
  const { x, y, w, h } = o;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return '';
  const hasText = typeof o.text === 'string' && o.text.trim() !== '';
  const r = round(radiusOf(unit));
  switch (o.type) {
    case 'sticky': return rect(x, y, w, h, `rx="${r}" fill="${resolveColour(o.fill) ?? STICKY_GREY}"`) + bars(x, y, w, h, unit, BARS.sticky);
    case 'text': return hasText ? bars(x, y, w, h, unit, BARS.text) : '';
    case 'markdown':
    case 'table':
    case 'code': return bars(x, y, w, h, unit, BARS.block);
    case 'frame':
    case 'container':
    case 'lane':
    case 'tracker': {
      const c = frameColours(o.fill);
      return rect(x, y, w, h, `rx="${r}" fill="${c.fill}" stroke="${c.edge}" stroke-width="1" vector-effect="non-scaling-stroke"`);
    }
    case 'card': return rect(x, y, w, h, `rx="${r}" fill="${resolveColour(o.fill) ?? PAPER}" ${OUTLINED}`) + bars(x, y, w, h, unit, BARS.card);
    case 'shape': return shapeBlock(o, unit, hasText);
    case 'group':
    case 'path': return '';
    default: return rect(x, y, w, h, `rx="${r}" fill="${QUIET_FILL}"`);
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
    svg = blockThumbnailSvg(templateObjects(def));
    blockBuiltins.set(def.id, svg);
  }
  return svg;
}
