// DEV ONLY (the stored picture of a board on the Boards cards). The block picture of what everyone may see of a board, as a string an
// <img> can show: no theme variables (an image cannot read the page's styles) and no color-mix() (some renderers draw it black).
import { blockThumbnailSvg } from './template-thumb';
import { resolveColorMix, resolveCssVars } from './exporters';
import { previewSourceObjects, type PreviewFlow } from './preview-source';
import type { Obj } from './types';

/** An attribute colour `color-mix(in srgb, #HEX P%, transparent)`: the colour at P per cent opacity (fill="" or stroke="" only). */
const ATTR_MIX = /(fill|stroke)="color-mix\(in srgb,\s*(#[0-9a-f]{3,6})\s+(\d+(?:\.\d+)?)%,\s*transparent\)"/gi;

/**
 * Resolves a picture for an <img>: variables take their fallbacks, a translucent colour attribute becomes its colour with a
 * `fill-opacity` or `stroke-opacity` (resolveColorMix alone would drop the opacity of an attribute), and the other mixes of two
 * colours become plain colours. Exports the result as resolveCssVars and resolveColorMix do for files.
 */
export function inlineForImage(svg: string): string {
  const withColours = resolveCssVars(svg).replace(ATTR_MIX, (_all, attr: string, hex: string, pct: string) => {
    const opacity = Math.round(Number(pct)) / 100;
    return `${attr}="${hex}" ${attr}-opacity="${opacity}"`;
  });
  return resolveColorMix(withColours);
}

/** The stored picture of a board: the block picture of its objects as everyone may see them (previewSourceObjects), ready for an <img>. */
export function previewSvgFor(objects: readonly Obj[], flow: PreviewFlow): string {
  return inlineForImage(blockThumbnailSvg(previewSourceObjects(objects, flow)));
}

/** What a picture needs from a board's store (src/store.ts Store has all three). */
export interface PreviewStore {
  ordered(): Obj[];
  cache: ReadonlyMap<string, Obj>;
  getFlow(): PreviewFlow;
}

/**
 * The objects in the order the canvas paints them: frames first, then by z (Store.ordered), so a frame drawn around a note is drawn under
 * it in the picture as well. The picture draws in the order it is given, and the store's cache is in load order, not paint order. An
 * object that `ordered` leaves out (a child of a container that is gone) is still drawn, last.
 */
export function paintOrder(store: Pick<PreviewStore, 'ordered' | 'cache'>): Obj[] {
  const ordered = store.ordered();
  const seen = new Set(ordered.map((o) => o.id));
  const rest = [...store.cache.values()].filter((o) => !seen.has(o.id));
  return rest.length ? [...ordered, ...rest] : ordered;
}

/** The stored picture of a board from its store: what everyone may see of it, in paint order. Used by the board's writer and by the seed. */
export function storePreviewSvg(store: PreviewStore): string {
  return previewSvgFor(paintOrder(store), store.getFlow());
}
