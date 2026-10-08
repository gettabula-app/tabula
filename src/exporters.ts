import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import * as Y from 'yjs';
import type { BoardApp } from './app';
import type { BaseObj, BoardMeta, Id, Obj } from './types';
import { SCHEMA_VERSION, isBox } from './types';
import type { FlowState } from './store';
import type { Thread } from './comments';
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
}

export function toJson(app: BoardApp, ids?: Id[], comments: Thread[] = app.conn.comments.list()): BoardJson {
  const objs = ids ? app.store.ordered().filter((o) => ids.includes(o.id)) : app.store.ordered();
  const json: BoardJson = {
    format: 'driftboard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    meta: app.store.getMeta(),
    objects: objs,
    flow: app.store.getFlow(),
  };
  if (comments.length && !ids) json.comments = comments;
  return json;
}

/** `.drift` = zip of a readable snapshot plus the full CRDT state (history preserved). */
export function toDrift(app: BoardApp): Uint8Array {
  const files: Record<string, Uint8Array> = {
    // Comments travel in comments.yjs, not in the readable snapshot.
    'board.json': strToU8(JSON.stringify(toJson(app, undefined, []), null, 2)),
    'doc.yjs': Y.encodeStateAsUpdate(app.store.doc),
  };
  if (app.conn.comments.list().length > 0) files['comments.yjs'] = Y.encodeStateAsUpdate(app.conn.comments.doc);
  return zipSync(files, { level: 6 });
}

export interface ImportedBoard { json: BoardJson; update?: Uint8Array; comments?: Uint8Array }

export async function readBoardFile(file: File): Promise<ImportedBoard> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // zip magic: PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf);
    if (!files['board.json']) throw new Error('This file is not a Tabula board (board.json is missing).');
    return {
      json: validate(JSON.parse(strFromU8(files['board.json']))),
      update: files['doc.yjs'],
      comments: files['comments.yjs'],
    };
  }
  return { json: validate(JSON.parse(strFromU8(buf))) };
}

function validate(j: unknown): BoardJson {
  const b = j as BoardJson;
  if (!b || b.format !== 'driftboard' || !Array.isArray(b.objects)) throw new Error('This file is not a Tabula board.');
  if (b.comments && !Array.isArray(b.comments)) throw new Error('This file is not a Tabula board.');
  if (b.schemaVersion > SCHEMA_VERSION) throw new Error('This board was made with a newer version of Tabula. Update the app to open it.');
  return b;
}

export function download(data: Blob | Uint8Array | string, name: string, type = 'application/octet-stream') {
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

export function exportSvg(app: BoardApp, ids?: Id[], opts: { fontCss?: string; background?: boolean } = {}): { svg: string; w: number; h: number } {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.ordered();
  const b = app.r.contentBounds(objs.map((o) => o.id)) ?? { x: 0, y: 0, w: 100, h: 100 };
  const pad = 40;
  const x = b.x - pad, y = b.y - pad - 10, w = b.w + pad * 2, h = b.h + pad * 2 + 10;
  const ctx = { ...app.r.ctx, editingId: null };
  const body = objs.map((o) => objectMarkup(o, ctx)).join('\n');
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

function gatherForExport(app: BoardApp, ids: Id[]): Obj[] {
  const set = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (app.store.get(id)?.type === 'frame') for (const c of app.store.childrenOf(id)) if (!set.has(c.id)) { set.add(c.id); stack.push(c.id); }
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
  const { svg, w, h } = exportSvg(app, ids, { fontCss });
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
export function insertImported(app: BoardApp, json: BoardJson) {
  const objs = json.objects.filter((o) => o && typeof o.id === 'string' && typeof o.type === 'string');
  const boxes = objs.filter(isBox);
  if (!objs.length) return;
  const minX = Math.min(...boxes.map((o) => o.x)), minY = Math.min(...boxes.map((o) => o.y));
  const content = app.r.contentBounds();
  const target = content ? { x: content.x + content.w + 200, y: content.y } : app.r.viewport();
  const inserted = app.insertObjects(objs, { x: target.x - (isFinite(minX) ? minX : 0), y: target.y - (isFinite(minY) ? minY : 0) });
  const b = app.r.contentBounds(inserted.map((o) => o.id));
  if (b) app.r.flyTo(b);
}
