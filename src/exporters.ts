import { packAssets, unpackAssets, type PackedAsset } from './drift-assets';
import { sha256Hex, type ImportedAsset } from './images';
import type { ImageState } from './image-loader';
import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import * as Y from 'yjs';
import type { BoardApp } from './app';
import type { BaseObj, BoardMeta, Id, Obj, Poll, PollAnswer } from './types';
import { SCHEMA_VERSION, isBox } from './types';
import type { FlowState, Store } from './store';
import type { Comments, Thread } from './comments';
import { answerKey } from './polls';
import { SVG_DEFS, objectMarkup } from './markup';
import { cssUrl, fontName, nearestWeight } from './fonts';

export interface BoardJson {
  format: 'driftboard';
  schemaVersion: number;
  exportedAt: string;
  meta: BoardMeta;
  objects: Obj[];
  flow: FlowState;
  comments?: Thread[];
  polls?: Poll[];
  pollAnswers?: PollAnswer[];
  /** Says what this file leaves out, when it leaves something out. */
  note?: string;
}

export function toJson(app: BoardApp, ids?: Id[], comments: Thread[] = app.conn.comments.list()): BoardJson {
  // A container's lanes and cards have no positions of their own, so the copy carries the laid-out ones.
  const objs = (ids ? app.store.ordered().filter((o) => ids.includes(o.id)) : app.store.ordered()).map((o) => app.store.placed(o));
  const json: BoardJson = {
    format: 'driftboard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    meta: app.store.getMeta(),
    objects: objs,
    flow: app.store.getFlow(),
  };
  if (comments.length && !ids) json.comments = comments;
  // the readable snapshot names pictures by hash and does not carry them: a .drift file does (docs/images.md)
  if (objs.some((o) => o.type === 'image')) json.note = 'Images are referenced by their asset hash and their bytes are not included in this file. Export a .drift file to keep them.';
  if (!ids) {
    const { polls, answers } = app.flow.polls.snapshot();
    if (polls.length) json.polls = polls;
    if (answers.length) json.pollAnswers = answers;
  }
  return json;
}

/** `.drift` = zip of a readable snapshot plus the full CRDT state (history preserved). */
export async function toDrift(app: BoardApp): Promise<Uint8Array> {
  const files: Zippable = {
    // Comments travel in comments.yjs, not in the readable snapshot.
    'board.json': strToU8(JSON.stringify(toJson(app, undefined, []), null, 2)),
    'doc.yjs': Y.encodeStateAsUpdate(app.store.doc),
  };
  if (app.conn.comments.list().length > 0) files['comments.yjs'] = Y.encodeStateAsUpdate(app.conn.comments.doc);
  // the pictures, beside the board (docs/images.md): the file is the one format that round-trips a board completely
  const mimes = new Map<string, string>();
  for (const o of app.store.cache.values()) {
    const b = o as BaseObj;
    if (b.type === 'image' && typeof b.asset === 'string') mimes.set(b.asset, b.mime ?? 'image/png');
  }
  const packed: PackedAsset[] = [];
  for (const [key, mime] of mimes) {
    const blob = await app.images.blobOf(key);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    packed.push({ key, mime, bytes, sha: await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) });
  }
  for (const [name, data] of Object.entries(packAssets(packed) ?? {})) files[name] = name.startsWith('assets/') ? [data, { level: 0 }] : data;
  return zipSync(files, { level: 6 });
}

export interface ImportedBoard { json: BoardJson; update?: Uint8Array; comments?: Uint8Array; /** The pictures of the file by the `asset` reference they stand for. */ assets?: Record<string, ImportedAsset> }

export async function readBoardFile(file: File): Promise<ImportedBoard> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // zip magic: PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf);
    const assets = unpackAssets(files);
    if (!files['board.json']) throw new Error('This file is not a Tabula board (board.json is missing).');
    return {
      json: validate(JSON.parse(strFromU8(files['board.json']))),
      update: files['doc.yjs'],
      comments: files['comments.yjs'],
      ...(Object.keys(assets).length ? { assets } : {}),
    };
  }
  return { json: validate(JSON.parse(strFromU8(buf))) };
}

/** The name a board gets when it is imported from a file: the one it was saved with, else the file's name. */
export function importedBoardName(imported: ImportedBoard, fileName: string): string {
  return imported.json.meta?.name || fileName.replace(/\.\w+$/, '');
}

/**
 * Puts an imported board into an empty one: the saved sync state if the file has it, else the readable snapshot.
 * `importedBy` is the account (or device) that imports the file: it owns the new board, so the file's comments are
 * marked imported by it. `null` restores this device's own backup copy, whose comments stay as they were.
 */
export function applyImported(target: { doc: Y.Doc; store: Store; comments: Comments }, imported: ImportedBoard, importedBy: string | null) {
  const { json, update, comments } = imported;
  if (update) Y.applyUpdate(target.doc, update);
  else {
    target.doc.transact(() => {
      for (const [k, v] of Object.entries(json.meta || {})) target.store.meta.set(k, v);
      for (const o of json.objects as Obj[]) target.store.create(o);
      for (const [k, v] of Object.entries(json.flow || {})) target.store.flow.set(k, v);
      for (const p of json.polls ?? []) target.store.polls.set(p.id, p);
      for (const a of json.pollAnswers ?? []) target.store.pollAnswers.set(answerKey(a.pollId, a.userId), a);
    });
  }
  if (importedBy === null) {
    // toDrift keeps comments in comments.yjs only, so a backup has no readable comments to fall back to.
    if (comments) Y.applyUpdate(target.comments.doc, comments);
  } else if (comments) target.comments.importUpdate(comments, importedBy);
  else if (json.comments) target.comments.importThreads(json.comments, importedBy);
}

function validate(j: unknown): BoardJson {
  const b = j as BoardJson;
  if (!b || b.format !== 'driftboard' || !Array.isArray(b.objects)) throw new Error('This file is not a Tabula board.');
  if (b.comments && !Array.isArray(b.comments)) throw new Error('This file is not a Tabula board.');
  if ((b.polls && !Array.isArray(b.polls)) || (b.pollAnswers && !Array.isArray(b.pollAnswers))) throw new Error('This file is not a Tabula board.');
  if (b.schemaVersion > SCHEMA_VERSION) throw new Error('This board was made with a newer version of Tabula. Update the app to open it.');
  return b;
}

type SaveFile = (data: Blob | Uint8Array | string, name: string) => void;
let nativeSave: SaveFile | null = null;

/** The desktop app replaces the browser download with a native Save dialog (`desktop.ts`). */
export function setNativeSave(save: SaveFile | null) {
  nativeSave = save;
}

export function download(data: Blob | Uint8Array | string, name: string, type = 'application/octet-stream') {
  if (nativeSave) {
    nativeSave(data, name);
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeName = (s: string) => (s || 'board').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'board';

// ---------------------------------------------------------------- SVG / PNG

function usedFonts(objs: Obj[]): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>([['satoshi', new Set([500])]]);
  for (const o of objs) {
    const b = o as BaseObj;
    if (!b.font || b.font === 'system') continue;
    const s = m.get(b.font) ?? new Set<number>();
    s.add(nearestWeight(b.font, b.fontWeight || 400));
    if (o.type === 'uml-class') s.add(nearestWeight(b.font, 700));
    m.set(b.font, s);
  }
  return m;
}

/** Exports are drawn on white, so theme variables are replaced by their fallbacks. */
export function resolveCssVars(svg: string): string {
  return svg.replace(/var\(--[\w-]+,\s*([^)]+)\)/g, (_, fallback: string) => fallback.trim());
}

/** The pictures of the image objects among `objs`, as data URLs by object id: what an export draws in place of a live link. */
export async function imageDataUrls(app: BoardApp, objs: Obj[]): Promise<Map<Id, string>> {
  const out = new Map<Id, string>();
  for (const o of objs) {
    if (o.type !== 'image') continue;
    const url = await app.images.dataUrl(o as BaseObj);
    if (url) out.set(o.id, url);
  }
  return out;
}

export function exportSvg(app: BoardApp, ids?: Id[], opts: { fontCss?: string; background?: boolean; images?: Map<Id, string> } = {}): { svg: string; w: number; h: number } {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.ordered();
  const b = app.r.contentBounds(objs.map((o) => o.id)) ?? { x: 0, y: 0, w: 100, h: 100 };
  const pad = 40;
  const x = b.x - pad, y = b.y - pad - 10, w = b.w + pad * 2, h = b.h + pad * 2 + 10;
  // The ctx carries the canvas's own connector layout, whole-board even when only some objects are exported, so a
  // connector in the file ends where it does on the board, beside connectors that are not in it.
  const images = opts.images;
  const ctx = {
    ...app.r.ctx,
    editingId: null,
    // an image is its data URL here, or a placeholder when its bytes were not found: never a link that only works on screen
    imageState: (o: BaseObj): ImageState => { const url = images?.get(o.id); return url ? { kind: 'ok', url } : { kind: 'failed', why: 'missing' }; },
  };
  const body = objs.map((o) => objectMarkup(app.store.placed(o), ctx)).join('\n');
  let style = opts.fontCss ?? '';
  if (!opts.fontCss) {
    style = [...usedFonts(objs)].map(([slug, ws]) => `@import url("${cssUrl(slug, [...ws])}");`).join('\n');
  }
  const bg = opts.background === false ? '' : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#FFFFFF"/>`;
  const svg = resolveCssVars(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x} ${y} ${w} ${h}"><defs>${SVG_DEFS}<style><![CDATA[
${style.replace(/]]>/g, '')}
]]></style></defs>${bg}${body}</svg>`);
  return { svg, w, h };
}

/** The SVG of the board (or of `ids`) with its pictures inlined, so the file stands on its own. */
export async function exportSvgFile(app: BoardApp, ids?: Id[]): Promise<string> {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.ordered();
  return exportSvg(app, ids, { images: await imageDataUrls(app, objs) }).svg;
}

function gatherForExport(app: BoardApp, ids: Id[]): Obj[] {
  const set = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (app.store.get(id)?.type === 'frame') for (const c of app.store.childrenOf(id)) if (!set.has(c.id)) { set.add(c.id); stack.push(c.id); }
    for (const cid of app.store.containerLayout(id)?.order ?? []) set.add(cid);
  }
  // include connectors between exported items
  for (const o of app.store.cache.values()) {
    if (o.type !== 'connector' || set.has(o.id)) continue;
    const c = o as Extract<Obj, { type: 'connector' }>;
    const a = c.from.kind === 'free' || set.has(c.from.id);
    const z = c.to.kind === 'free' || set.has(c.to.id);
    if (a && z && (c.from.kind === 'bound' || c.to.kind === 'bound')) set.add(o.id);
  }
  return app.store.ordered().filter((o) => set.has(o.id));
}

/** fetch that gives up after `ms`, so an unreachable font never stalls an export. */
async function fetchWithin(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function toDataUrl(url: string): Promise<string> {
  const res = await fetchWithin(url);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * Fonts referenced by a board, inlined as data URLs so the rasteriser (which
 * cannot load external resources) draws the real typefaces. The data stays in
 * this browser; only the resulting pixels are exported.
 */
async function inlineFontCss(objs: Obj[]): Promise<string> {
  const parts: string[] = [];
  for (const [slug, ws] of usedFonts(objs)) {
    try {
      const css = await (await fetchWithin(cssUrl(slug, [...ws]))).text();
      const name = fontName(slug).toLowerCase();
      // The endpoint sometimes returns faces of other families too; keep only ours.
      const faces = (css.match(/@font-face\s*{[^}]*}/g) || []).filter((f) => f.toLowerCase().includes(`'${name}'`) || f.toLowerCase().includes(`"${name}"`));
      for (const face of faces) {
        const woff2 = face.match(/url\(['"]?([^'")]+?)['"]?\)\s*format\(['"]woff2['"]\)/);
        if (!woff2) continue;
        const href = woff2[1].startsWith('//') ? 'https:' + woff2[1] : woff2[1];
        const data = await toDataUrl(href);
        parts.push(face.replace(/src:[^;]+;/, `src: url(${data}) format('woff2');`));
      }
    } catch {
      /* offline and not cached: falls back to system fonts */
    }
  }
  return parts.join('\n');
}

export async function exportPng(app: BoardApp, ids?: Id[], scale = 2): Promise<Blob> {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.ordered();
  const fontCss = await inlineFontCss(objs);
  const { svg, w, h } = exportSvg(app, ids, { fontCss, images: await imageDataUrls(app, objs) });
  const max = 16000;
  const s = Math.min(scale, max / w, max / h);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the board image.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * s);
    canvas.height = Math.ceil(h * s);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Objects from an imported board, re-inserted into the current board with fresh ids. */
export function insertImported(app: BoardApp, json: BoardJson, assets?: Record<string, ImportedAsset>) {
  const objs = json.objects.filter((o) => o && typeof o.id === 'string' && typeof o.type === 'string');
  const boxes = objs.filter(isBox);
  if (!objs.length) return;
  const minX = Math.min(...boxes.map((o) => o.x)), minY = Math.min(...boxes.map((o) => o.y));
  const content = app.r.contentBounds();
  const target = content ? { x: content.x + content.w + 200, y: content.y } : app.r.viewport();
  const inserted = app.insertObjects(objs, { x: target.x - (isFinite(minX) ? minX : 0), y: target.y - (isFinite(minY) ? minY : 0) });
  if (assets && Object.keys(assets).length) void app.images.adopt(assets, new Set(inserted.map((o) => o.id)));
  const b = app.r.contentBounds(inserted.map((o) => o.id));
  if (b) app.r.flyTo(b);
}
