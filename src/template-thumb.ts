// Template thumbnails, rendered on the fly from objects with the same markup the board draws.

import { buildConnectorLayout, objBounds, unionRects, type ConnectorLayout } from './geometry';
import { SVG_DEFS, objectMarkup, type MarkupCtx } from './markup';
import { DEFAULT_META } from './store';
import { Builder, type BuilderHost, type TemplateDef } from './templates';
import { isBox, isConnector, type Obj, type Rect } from './types';

const DEFAULT_MAX_OBJECTS = 400;
const PAD = 0.04;

const round = (v: number) => Math.round(v * 100) / 100;

/** A throwaway host for building built-in templates: no board, default fonts. */
const THUMB_HOST: BuilderHost = { user: { id: 'thumbnail' }, store: { getMeta: () => DEFAULT_META } };

/**
 * An inline SVG of the objects, fitted to the bounds of their boxes. Colours stay as theme variables,
 * so the thumbnail follows the theme. Above `maxObjects` only frames and stickies are drawn.
 */
export function thumbnailSvg(objects: Obj[], opts: { maxObjects?: number } = {}): string {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const get = (id: string) => byId.get(id);
  const rects = objects.filter(isBox).flatMap((o) => objBounds(get, o) ?? []);
  const b: Rect = unionRects(rects) ?? { x: 0, y: 0, w: 100, h: 100 };
  const pad = Math.max(b.w, b.h, 1) * PAD;
  const simplified = objects.length > (opts.maxObjects ?? DEFAULT_MAX_OBJECTS);
  const shown = simplified ? objects.filter((o) => o.type === 'frame' || o.type === 'sticky') : objects;
  // The template's own connectors only: a thumbnail shows the objects as they would look on an empty board.
  let layout: ConnectorLayout | undefined;
  const ctx: MarkupCtx = { get, layout: () => (layout ??= buildConnectorLayout(get, objects.filter(isConnector))) };
  const body = shown.map((o) => objectMarkup(o, ctx)).join('');
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
    svg = thumbnailSvg(b.objs);
    builtins.set(def.id, svg);
  }
  return svg;
}
