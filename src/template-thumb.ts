// Template thumbnails, rendered on the fly from objects with the same markup the board draws.

import { buildConnectorLayout, objBounds, unionRects, type ConnectorLayout } from './geometry';
import { SVG_DEFS, objectMarkup, type MarkupCtx } from './markup';
import { DEFAULT_META } from './store';
import { Builder, type BuilderHost, type TemplateDef } from './templates';
import { isBox, isConnector, type BaseObj, type Label, type Obj, type Rect } from './types';
import { layoutAll } from '../shared/containers';
import { TRACKER_FRAME_DEFAULT_SIZE, trackerPlaceholder } from './tracker-frame';

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
 * An inline SVG of the objects, fitted to the bounds of their boxes. Colours stay as theme variables,
 * so the thumbnail follows the theme. Above `maxObjects` only frames and stickies are drawn.
 */
export function thumbnailSvg(objects: Obj[], opts: { maxObjects?: number; labels?: readonly { id: string; name: string; color: string }[] } = {}): string {
  // kanbans are drawn where their layout puts them (docs/kanban.md, Templates), with the template's own labels
  const laid = layoutAll(objects);
  if (laid.layouts.size) objects = objects.map((o) => { const r = laid.rects.get(o.id); return r ? { ...o, ...r } as Obj : o; });
  const labels = new Map((opts.labels ?? []).map((l, i): [string, Label] => [l.id, { ...l, order: i }]));
  const byId = new Map(objects.map((o) => [o.id, o]));
  const get = (id: string) => byId.get(id);
  const rects = objects.filter(isBox).flatMap((o) => objBounds(get, o) ?? []);
  const b: Rect = unionRects(rects) ?? { x: 0, y: 0, w: 100, h: 100 };
  const pad = Math.max(b.w, b.h, 1) * PAD;
  const simplified = objects.length > (opts.maxObjects ?? DEFAULT_MAX_OBJECTS);
  const shown = simplified ? objects.filter((o) => o.type === 'frame' || o.type === 'sticky') : objects;
  // The template's own connectors only: a thumbnail shows the objects as they would look on an empty board.
  let layout: ConnectorLayout | undefined;
  const ctx: MarkupCtx = {
    get, layout: () => (layout ??= buildConnectorLayout(get, objects.filter(isConnector))),
    containerLayout: (id) => laid.layouts.get(id) ?? null, label: (id) => labels.get(id),
  };
  const body = shown.map((o) => (o.type === 'markdown' || o.type === 'table' ? placeholderMarkup(o) : objectMarkup(o, ctx))).join('');
  const view = `${round(b.x - pad)} ${round(b.y - pad)} ${round(b.w + pad * 2)} ${round(b.h + pad * 2)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"><defs>${SVG_DEFS}</defs>${body}</svg>`;
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

/**
 * The Tracker entry of the Templates picker: the static frame placeholder (its name and a line, never ticket data), at the size a new
 * tracker is put on a board. Not memoised: the line it says depends on whether the person is a guest.
 */
export function trackerThumbnail(): string {
  const { w, h } = TRACKER_FRAME_DEFAULT_SIZE;
  const frame = { id: 'tracker-thumbnail', type: 'tracker', x: 0, y: 0, w, h, rotation: 0 } as unknown as BaseObj;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${trackerPlaceholder(frame)}</svg>`;
}
