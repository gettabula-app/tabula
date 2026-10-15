// The picture of a board for its Boards card (TAB-375 slice 3 demo, client render). The picture is drawn by the app's own drawing export
// (src/exporters.ts exportSvg) from a DETACHED board: a store built only from the objects the server sends for a picture
// (GET /api/boards/:id/preview-source, already filtered for everyone). The live store of the board is never read here, and no text, name,
// link, image or colour outside those objects can reach the picture. Then the SVG goes through the whitelist (src/preview-svg-safe.ts).
//
// Two pictures: the export (the default) and the blocks (src/template-thumb.ts blockThumbnailSvg: colour blocks, no words). The blocks are
// the fallback when the export fails, when the board is too large, and when it is empty.
import * as Y from 'yjs';
import { Store } from './store';
import { exportSvg, resolveColorMix, resolveCssVars, type ExportSource } from './exporters';
import { blockThumbnailSvg } from './template-thumb';
import { buildConnectorLayout, objBounds, unionRects } from './geometry';
import { safeObj } from './safe-obj';
import { sanitizePictureSvg, SvgSyntaxError, type PictureFrame } from './preview-svg-safe';
import type { MarkupCtx } from './markup';
import type { BaseObj, Id, Obj, Rect } from './types';
import { isConnector } from './types';

export const PICTURE_W = 480;
export const PICTURE_H = 300;
/** Above this many objects the blocks picture is drawn instead of the export (a very large board would take too long to draw). */
export const PICTURE_MAX_OBJECTS = 400;
/**
 * Object types drawn as they are. Everything else is drawn as a plain block: cards, trackers, tables, code, markdown, links, UML, and the
 * kanban containers and lanes. A container is drawn by the app only with its layout, which the picture does not carry (the server's
 * preview source leaves it out), and a lane only with its name; both would show placeholder words, so they are blocks at their places.
 */
const DRAWN_TYPES = new Set(['shape', 'sticky', 'text', 'frame', 'connector', 'image', 'path', 'group']);
const HEX = /^#[0-9a-fA-F]{6}$/;
const BLOCK_FILL = '#EEF1F4';
const BLOCK_EDGE = '#C9CFD8';

/** An attribute colour `color-mix(in srgb, #HEX P%, transparent)` (fill="" or stroke=""): resolveColorMix alone would drop its opacity. */
const ATTR_MIX = /(fill|stroke)="color-mix\(in srgb,\s*(#[0-9a-f]{3,6})\s+(\d+(?:\.\d+)?)%,\s*transparent\)"/gi;

/**
 * Resolves a picture for drawing: theme variables take their fallbacks, a translucent colour attribute becomes its colour with an
 * opacity (fill-opacity or stroke-opacity), and the other mixes of two colours become plain colours.
 */
export function inlineForImage(svg: string): string {
  const withColours = resolveCssVars(svg).replace(ATTR_MIX, (_all, attr: string, hex: string, pct: string) => {
    const opacity = Math.round(Number(pct)) / 100;
    return `${attr}="${hex}" ${attr}-opacity="${opacity}"`;
  });
  return resolveColorMix(withColours);
}

/** The object as the detached board holds it: drawn types as they are, the others as plain blocks of their own place and size. */
export function pictureObject(o: Obj): Obj {
  if (isConnector(o) || DRAWN_TYPES.has(o.type)) return o;
  const b = o as BaseObj;
  const fill = typeof b.fill === 'string' && HEX.test(b.fill) ? b.fill : BLOCK_FILL;
  // no parent: a block is a box at its own place (the server laid kanban cards and lanes out already)
  return {
    id: b.id, type: 'shape', kind: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, rotation: b.rotation ?? 0, z: b.z,
    fill, stroke: BLOCK_EDGE, strokeWidth: 1,
  } as unknown as Obj;
}

/** A view of [x, y, w, h] around the rectangle at the picture's 16:10, with 4 % padding: the picture is letterboxed, never cropped. */
export function fitPicture(b: Rect | null): [number, number, number, number] {
  const r = b ?? { x: 0, y: 0, w: 100, h: 100 };
  const pad = Math.max(r.w, r.h, 1) * 0.04;
  let vw = r.w + pad * 2;
  let vh = r.h + pad * 2;
  if (vw / vh > PICTURE_W / PICTURE_H) vh = (vw * PICTURE_H) / PICTURE_W;
  else vw = (vh * PICTURE_W) / PICTURE_H;
  return [r.x + r.w / 2 - vw / 2, r.y + r.h / 2 - vh / 2, vw, vh];
}

/**
 * A detached board: a real Store holding `objects` (and nothing else), with the renderer bounds and drawing context that the export
 * reads. Connector layouts and bounds are computed the way the live renderer computes them; there are no labels, comments, owners,
 * filters, selections, presence or AI marks, because the picture is not given any.
 */
export function detachedSource(objects: readonly Obj[], images: ReadonlyMap<Id, string>): ExportSource {
  const store = new Store(new Y.Doc());
  store.seed(() => {
    for (const o of objects) store.create(o);
  });
  const safeGet = (id: string): Obj | undefined => {
    const o = store.getPlaced(id);
    return o && safeObj(o);
  };
  let layout: ReturnType<typeof buildConnectorLayout> | null = null;
  const connectorLayout = () => {
    layout ??= buildConnectorLayout(safeGet, store.shown().filter(isConnector).map(safeObj));
    return layout;
  };
  const boundsOf = (o: Obj): Rect | null => objBounds(safeGet, safeObj(store.placed(o)), connectorLayout(), (obj) => store.geometry(obj));
  const ctx: MarkupCtx = {
    get: (id) => store.getPlaced(id),
    isHidden: () => false,
    imageState: (o) => {
      const url = images.get(o.id);
      return url ? { kind: 'ok', url } : { kind: 'failed', why: 'missing' };
    },
    // a link card is a block here: its picture and icon are never fetched for a picture
    linkAsset: () => ({ kind: 'failed', why: 'missing' }),
    layout: () => connectorLayout(),
    containerLayout: (id) => store.containerLayout(id),
    dragging: () => false,
    label: () => undefined,
    ownerColor: () => undefined,
    commentCount: () => 0,
    filterChips: () => null,
    dimmed: () => false,
    editingId: null,
    tableSelection: null,
    zoom: 1,
    editable: false,
    addingLane: null,
    dropLane: null,
    openControl: null,
    still: true,
  };
  return {
    store,
    r: {
      ctx,
      contentBounds: (ids) => {
        const list = ids ? [...ids].map((id) => store.get(id)).filter((o): o is Obj => o !== undefined) : store.shown();
        return unionRects(list.flatMap((o) => boundsOf(o) ?? []));
      },
    },
  };
}

/** The export's picture of the objects, as the whitelist allows it, on the 480 x 300 frame. Throws when the export cannot be read. */
export function exportPictureSvg(objects: readonly Obj[], images: ReadonlyMap<Id, string> = new Map()): string {
  const source = detachedSource(objects.map(pictureObject), images);
  const frame: PictureFrame = { viewBox: fitPicture(source.r.contentBounds()), width: PICTURE_W, height: PICTURE_H, background: '#FFFFFF' };
  const { svg } = exportSvg(source, undefined, { fontCss: '', background: false, images });
  return sanitizePictureSvg(inlineForImage(svg), frame);
}

/** The blocks' picture of the objects (no words), as the whitelist allows it. */
export function blockPictureSvg(objects: readonly Obj[]): string {
  const svg = inlineForImage(blockThumbnailSvg([...objects]));
  const view = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(/\s+/).map(Number);
  if (!view || view.length !== 4 || view.some((v) => !Number.isFinite(v))) throw new SvgSyntaxError('the blocks have no view');
  return sanitizePictureSvg(svg, { viewBox: view as [number, number, number, number], width: PICTURE_W, height: PICTURE_H, background: '#FFFFFF' });
}

export type PictureMode = 'export' | 'blocks';

/**
 * The picture to store for these objects, and which drawing made it. `export` is used unless the board is empty, too large, or the export
 * cannot be drawn; then the blocks are used (its `reason` says why).
 */
export function buildPictureSvg(objects: readonly Obj[], opts: { mode?: PictureMode; images?: ReadonlyMap<Id, string> } = {}): { svg: string; mode: PictureMode; reason: string | null } {
  if (opts.mode === 'blocks') return { svg: blockPictureSvg(objects), mode: 'blocks', reason: 'the blocks are chosen' };
  if (objects.length === 0) return { svg: blockPictureSvg(objects), mode: 'blocks', reason: 'empty' };
  if (objects.length > PICTURE_MAX_OBJECTS) return { svg: blockPictureSvg(objects), mode: 'blocks', reason: 'large' };
  try {
    return { svg: exportPictureSvg(objects, opts.images), mode: 'export', reason: null };
  } catch (err) {
    return { svg: blockPictureSvg(objects), mode: 'blocks', reason: `the export failed: ${(err as Error).message.slice(0, 120)}` };
  }
}

// ---------------------------------------------------------------- the pictures of the board's images

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const HASH = /^[0-9a-f]{64}$/;
const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
};

/** The longest side an embedded image is drawn at: the picture frame is 480 x 300, so a larger image is never shown larger. */
export const IMAGE_MAX_SIDE = 480;
/** What an embedded image may weigh after it is shrunk. Three full ones stay far under the picture's source limit. */
export const IMAGE_SHRUNK_MAX_BYTES = 150_000;
/** The encoder quality of a shrunk image. */
export const IMAGE_SHRINK_QUALITY = 0.7;

export interface ShrunkImage { bytes: Uint8Array; type: string }
/** Re-encodes an image at most IMAGE_MAX_SIDE across. Null when it cannot be done: the image is then left out. */
export type ImageShrink = (bytes: Uint8Array, type: string) => Promise<ShrunkImage | null>;

export interface ImageEmbedOptions {
  /** Milliseconds for all the images together. */
  budgetMs?: number;
  /** Most images a picture draws; the rest are placeholders. */
  maxImages?: number;
  /** Bytes per image as the asset route sends it. */
  maxBytes?: number;
  now?: () => number;
  /** Re-encodes each image before it is embedded (strips its metadata too). The default draws it through a canvas in the browser. */
  shrink?: ImageShrink;
}

/**
 * The body of a response, read at most `maxBytes` long; null when it is longer, or when there is no body. The stream is read and stopped at
 * the cap, so a body that lies about its length (or has none) cannot get past it.
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The browser's shrink: the image decoded, drawn at most IMAGE_MAX_SIDE across on white, and encoded as WebP, else JPEG, at quality 0.7.
 * Null when no canvas can draw it, or neither encoding comes out under IMAGE_SHRUNK_MAX_BYTES (Safari has no WebP encoder: PNG is refused).
 */
export async function shrinkInBrowser(bytes: Uint8Array, type: string): Promise<ShrunkImage | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    for (const encoding of ['image/webp', 'image/jpeg']) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, encoding, IMAGE_SHRINK_QUALITY));
      if (blob && blob.type === encoding && blob.size <= IMAGE_SHRUNK_MAX_BYTES) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), type: encoding };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    source.close();
  }
}

/**
 * The board's pictures for the export, as data: URLs by object id. Only image objects with a bare asset hash and a bitmap type are fetched,
 * from the same-origin asset route of this board (the browser's cookie authorises it; redirects, other types and oversized bodies are
 * refused). A user SVG is never fetched or drawn. Nothing else is fetched: link previews and icons are geometry only.
 */
export async function embedImages(
  objects: readonly Obj[],
  boardId: string,
  fetchAsset: (url: string, signal: AbortSignal) => Promise<Response>,
  opts: ImageEmbedOptions = {},
): Promise<Map<Id, string>> {
  const budget = opts.budgetMs ?? 5000;
  const maxImages = opts.maxImages ?? 10;
  const maxBytes = opts.maxBytes ?? 1_048_576;
  const shrink = opts.shrink ?? shrinkInBrowser;
  const now = opts.now ?? Date.now;
  const out = new Map<Id, string>();
  const candidates = objects.filter((o) => o.type === 'image'
    && typeof (o as BaseObj).asset === 'string' && HASH.test((o as BaseObj).asset!)
    && (IMAGE_TYPES as readonly string[]).includes(String((o as BaseObj).mime ?? '')));
  const byHash = new Map<string, Id[]>();
  for (const o of candidates) {
    const hash = (o as BaseObj).asset!;
    const list = byHash.get(hash);
    if (list) list.push(o.id);
    else if (byHash.size < maxImages) byHash.set(hash, [o.id]);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const deadline = now() + budget;
    for (const [hash, ids] of byHash) {
      if (now() >= deadline || controller.signal.aborted) break;
      const type = String((candidates.find((o) => (o as BaseObj).asset === hash) as BaseObj | undefined)?.mime ?? '');
      let res: Response;
      try {
        res = await fetchAsset(`/api/boards/${encodeURIComponent(boardId)}/assets/${hash}`, controller.signal);
      } catch {
        continue;
      }
      if (!res.ok || res.redirected || res.type === 'opaqueredirect') continue;
      const declared = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (declared !== type) continue;
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > maxBytes) continue;
      // the declared length is not trusted: the body is streamed and stopped at the cap
      const bytes = await readCappedBody(res, maxBytes);
      if (!bytes || bytes.length === 0 || !MAGIC[type]!(bytes)) continue;
      const shrunk = await shrink(bytes, type).catch(() => null);
      const check = shrunk && Object.hasOwn(MAGIC, shrunk.type) ? MAGIC[shrunk.type] : undefined;
      if (!shrunk || shrunk.bytes.length === 0 || shrunk.bytes.length > IMAGE_SHRUNK_MAX_BYTES || !check || !check(shrunk.bytes)) continue;
      const url = `data:${shrunk.type};base64,${base64(shrunk.bytes)}`;
      for (const id of ids) out.set(id, url);
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
