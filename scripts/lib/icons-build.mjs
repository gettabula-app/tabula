// The pure parts of the icon build (docs/icons-selfhost.md): the licence rule, the body gate, alias resolution,
// the shard packer and the per-set index. Nothing here touches the file system, so the tests import it directly.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

export const SHARD_ICONS = 96;
export const SHARD_BYTES = 64 * 1024;
export const GZIP_LEVEL = 9;

const gzipAsync = promisify(zlib.gzip);

/** Gzip with the header's OS byte fixed, so the same input gives the same bytes on every platform. */
export async function gzip(data, level = GZIP_LEVEL) {
  const out = await gzipAsync(data, { level });
  out[9] = 3;
  return out;
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const shortHash = (data) => sha256(data).slice(0, 8);

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
};

/** Minified JSON with every object's keys sorted, as a Buffer. Same input, same bytes. */
export const canonicalJson = (v) => Buffer.from(JSON.stringify(sortKeys(v)));

// ---------------------------------------------------------------- licences

// Keep in step with src/icon-licences.ts; test/icons-build.test.ts runs both over one table.
const TIERS = new Map([
  ['CC0-1.0', 'public'], ['Unlicense', 'public'], ['0BSD', 'public'],
  ['MIT', 'notice'], ['ISC', 'notice'], ['Apache-2.0', 'notice'], ['BSD-2-Clause', 'notice'], ['BSD-3-Clause', 'notice'], ['OFL-1.1', 'notice'],
  ['CC-BY-3.0', 'attribution'], ['CC-BY-4.0', 'attribution'],
]);

/** 'public', 'notice' or 'attribution' for an allowed SPDX id, null for everything else (an id that is not a single id included). */
export function licenceTier(spdx, title) {
  if (typeof spdx !== 'string' || !spdx) return null;
  if (/-NC/i.test(spdx) || /non-?commercial|[\s-]NC\b/i.test(typeof title === 'string' ? title : '')) return null;
  return TIERS.get(spdx) ?? null;
}

/** Whether a set may be hosted: `{ ok: true, tier }` or `{ ok: false, reason }`. Sets Iconify marks hidden never pass. */
export function checkSet(info) {
  if (info?.hidden) return { ok: false, reason: 'Iconify marks the set hidden' };
  const lic = info?.license;
  const tier = licenceTier(lic?.spdx, lic?.title);
  if (!tier) return { ok: false, reason: `licence ${lic?.spdx ? `"${lic.spdx}"` : 'missing'} is not on the allowlist` };
  return { ok: true, tier };
}

/** Sets whose artwork is brand logos: the licence covers the drawing, not the mark. */
export const isLogoSet = (prefix, info) => info?.category === 'Logos' || prefix.startsWith('devicon');

// ---------------------------------------------------------------- body gate

const GATE_PATTERNS = [
  ['<script', /<\s*script/i],
  ['<foreignObject', /<\s*foreignObject/i],
  ['<iframe', /<\s*iframe/i],
  ['<object', /<\s*object/i],
  ['<embed', /<\s*embed/i],
  ['an on* attribute', /\son[a-z]+\s*=/i],
  ['javascript:', /javascript:/i],
  ['<image', /<\s*image\b/i],
  ['<style', /<\s*style/i],
  ['data:image', /data:image/i],
  ['an external href', /href\s*=\s*["']?\s*(?:https?:)?\/\//i],
  ['url(http', /url\(\s*["']?\s*https?:/i],
  ['an animation of href', /<\s*(?:animate|set)\b[^>]*attributeName\s*=\s*["']?\s*(?:xlink:)?href/i],
];
const GATE_ANY = new RegExp(GATE_PATTERNS.map(([, re]) => `(?:${re.source})`).join('|'), 'i');

/** The first pattern a body matches (anything executable or external), or null for an ordinary body. */
export function gateBody(body) {
  if (!GATE_ANY.test(body)) return null;
  return GATE_PATTERNS.find(([, re]) => re.test(body))?.[0] ?? 'a blocked pattern';
}

// ---------------------------------------------------------------- aliases

const num = (n) => String(Math.round(n * 1000) / 1000);

/**
 * Follows an alias to the icon it ends at, merging the flips, quarter turns and own sizes on the way.
 * Returns null for a chain that never reaches an icon.
 */
function followAlias(name, icons, aliases) {
  let cur = aliases[name];
  if (!cur) return null;
  const t = { hFlip: false, vFlip: false, rotate: 0 };
  for (let depth = 0; depth < 8 && cur; depth++) {
    t.hFlip = t.hFlip !== !!cur.hFlip;
    t.vFlip = t.vFlip !== !!cur.vFlip;
    t.rotate = (t.rotate + (cur.rotate || 0)) % 4;
    for (const k of ['width', 'height', 'left', 'top']) if (t[k] === undefined && cur[k] !== undefined) t[k] = cur[k];
    if (icons[cur.parent]) return { ...t, parent: cur.parent };
    cur = aliases[cur.parent];
  }
  return null;
}

/** An alias that changes the drawing or the box needs a body of its own. */
const needsOwnBody = (t) => t.hFlip || t.vFlip || t.rotate || t.width !== undefined || t.height !== undefined || t.left !== undefined || t.top !== undefined;

function transformed(rec, d, t) {
  let width = t.width ?? rec.width ?? d.width;
  let height = t.height ?? rec.height ?? d.height;
  let left = t.left ?? rec.left ?? d.left;
  let top = t.top ?? rec.top ?? d.top;
  const cx = left + width / 2, cy = top + height / 2;
  const parts = [];
  if (t.rotate) parts.push(`rotate(${t.rotate * 90} ${num(cx)} ${num(cy)})`);
  if (t.hFlip) parts.push(`translate(${num(2 * cx)} 0) scale(-1 1)`);
  if (t.vFlip) parts.push(`translate(0 ${num(2 * cy)}) scale(1 -1)`);
  if (t.rotate % 2) {
    [width, height] = [height, width];
    left = cx - width / 2;
    top = cy - height / 2;
  }
  return { body: parts.length ? `<g transform="${parts.join(' ')}">${rec.body}</g>` : rec.body, width, height, left, top };
}

// ---------------------------------------------------------------- one set

const entryOf = (rec, d) => {
  const e = { b: rec.body };
  if (rec.width !== d.width) e.w = rec.width;
  if (rec.height !== d.height) e.h = rec.height;
  if (rec.left !== d.left) e.l = rec.left;
  if (rec.top !== d.top) e.t = rec.top;
  return Object.keys(e).length === 1 ? rec.body : e;
};

/** Browse order: a set with categories in its own category order, then the rest; otherwise name order. */
export function browseOrder(names, categories) {
  const known = new Set(names);
  const seen = new Set();
  const out = [];
  for (const list of Object.values(categories || {})) {
    for (const n of list) {
      if (known.has(n) && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  for (const n of [...names].sort()) if (!seen.has(n)) out.push(n);
  return out;
}

/** Closes a shard at `shardIcons` icons or `shardBytes` of raw JSON; one body larger than the limit gets a shard of its own. */
export function packShards(order, sizeOf, { shardIcons = SHARD_ICONS, shardBytes = SHARD_BYTES } = {}) {
  const shards = [];
  let cur = [];
  let bytes = 0;
  for (const name of order) {
    const size = sizeOf(name);
    if (cur.length && (cur.length >= shardIcons || bytes + size > shardBytes)) {
      shards.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(name);
    bytes += size;
  }
  if (cur.length) shards.push(cur);
  return shards;
}

/**
 * Turns one set file of `@iconify/json` into its files. Throws on a body the gate rejects.
 * `pinned` is the set of `prefix:name` bodies to return in full (the reactions).
 * Returns the manifest entry (without `gz`), the files with their uncompressed content, and the pinned bodies.
 */
export function buildSet(prefix, data, { shardIcons = SHARD_ICONS, shardBytes = SHARD_BYTES, pinned = new Set() } = {}) {
  const info = data.info || {};
  const verdict = checkSet(info);
  if (!verdict.ok) throw new Error(`${prefix}: ${verdict.reason}`);
  const d = { width: data.width ?? 16, height: data.height ?? 16, left: data.left ?? 0, top: data.top ?? 0 };
  const icons = data.icons || {};
  const aliases = data.aliases || {};

  const recs = new Map();
  for (const [name, ic] of Object.entries(icons)) {
    if (typeof ic.body !== 'string') throw new Error(`${prefix}:${name} has no body`);
    const hit = gateBody(ic.body);
    if (hit) throw new Error(`${prefix}:${name} matches ${hit}`);
    recs.set(name, { body: ic.body, width: ic.width ?? d.width, height: ic.height ?? d.height, left: ic.left ?? d.left, top: ic.top ?? d.top });
  }
  const pointers = [];
  for (const name of Object.keys(aliases)) {
    if (recs.has(name)) continue;
    const t = followAlias(name, icons, aliases);
    if (!t) continue;
    if (needsOwnBody(t)) recs.set(name, transformed(recs.get(t.parent), d, t));
    else pointers.push([name, t.parent]);
  }

  const order = browseOrder([...recs.keys()], data.categories);
  const entries = new Map(order.map((n) => [n, entryOf(recs.get(n), d)]));
  const shardNames = packShards(order, (n) => n.length + 6 + JSON.stringify(entries.get(n)).length, { shardIcons, shardBytes });

  const files = [];
  const sh = [];
  let raw = 0;
  shardNames.forEach((names, n) => {
    const shard = { h: d.height, i: Object.fromEntries(names.map((name) => [name, entries.get(name)])), w: d.width };
    if (d.left) shard.l = d.left;
    if (d.top) shard.t = d.top;
    const buf = canonicalJson(shard);
    const hash = shortHash(buf);
    raw += buf.length;
    sh.push([hash, names.length]);
    files.push({ path: `s/${prefix}.${n}.${hash}.json`, data: buf, shard: true });
  });

  const pos = new Map(order.map((n, i) => [n, i]));
  const a = pointers.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([alias, parent]) => [alias, pos.get(parent)]);
  const aliasPos = new Map(a);
  const c = {};
  for (const [cat, list] of Object.entries(data.categories || {})) {
    const idx = [...new Set(list.map((n) => pos.get(n) ?? aliasPos.get(n)).filter((i) => i !== undefined))];
    if (idx.length) c[cat] = idx;
  }
  const index = { a, n: order, sh };
  if (Object.keys(c).length) index.c = c;
  const indexBuf = canonicalJson(index);
  const idx = shortHash(indexBuf);
  files.push({ path: `i/${prefix}.${idx}.json`, data: indexBuf });

  const pins = {};
  for (const full of pinned) {
    if (!full.startsWith(`${prefix}:`)) continue;
    const name = full.slice(prefix.length + 1);
    const rec = recs.get(name) ?? (aliases[name] && recs.get(followAlias(name, icons, aliases)?.parent));
    if (!rec) throw new Error(`pinned icon ${full} is not in the set`);
    pins[full] = { b: rec.body, h: rec.height, w: rec.width, ...(rec.left ? { l: rec.left } : {}), ...(rec.top ? { t: rec.top } : {}) };
  }

  const entry = {
    p: prefix, name: info.name || prefix, n: order.length,
    ...(info.category ? { cat: info.category } : {}),
    ...(isLogoSet(prefix, info) ? { tm: true } : {}),
    lic: { id: info.license.spdx, title: info.license.title || info.license.spdx, ...(info.license.url ? { url: info.license.url } : {}), tier: verdict.tier },
    ...(info.author?.name ? { au: { name: info.author.name, ...(info.author.url ? { url: info.author.url } : {}) } } : {}),
    idx, sh: shardNames.length, raw,
  };
  return { entry, files, pins };
}

/** Uncompressed `pin.<hash>.json`: the reactions' bodies, each with its full box. */
export function pinFile(pins) {
  const buf = canonicalJson(pins);
  return { path: `pin.${shortHash(buf)}.json`, data: buf };
}

export const NOTICE_LOGOS = 'Logos and brand marks in the sets marked (logos) remain trademarks of their owners. The licence covers the artwork, not the right to use a mark.';

/** The plain-text credits for every hosted set. */
export function licensesText(sets, source) {
  const lines = [
    'Icon sets hosted by Tabula',
    '',
    `Tabula serves these sets from its own server${source ? ` (data from ${source})` : ''}. Each set keeps the licence its authors chose.`,
    'MIT, ISC, Apache-2.0, BSD and OFL-1.1 sets: the copyright and licence notice belongs with copies of the icons.',
    'CC BY sets: credit the author, link the licence and say if you changed the icons, when you publish them.',
    NOTICE_LOGOS,
    '',
  ];
  const key = (s) => `${s.name.toLowerCase()}\0${s.p}`;
  for (const s of [...sets].sort((x, y) => (key(x) < key(y) ? -1 : 1))) {
    lines.push(`${s.name} (${s.p})${s.tm ? ' (logos)' : ''}`);
    lines.push(`  Author:  ${s.au ? `${s.au.name}${s.au.url ? ` <${s.au.url}>` : ''}` : 'unknown'}`);
    lines.push(`  Licence: ${s.lic.title === s.lic.id ? s.lic.id : `${s.lic.title} (${s.lic.id})`}${s.lic.url ? ` <${s.lic.url}>` : ''}`);
    lines.push(`  Icons:   ${s.n}`);
    lines.push('');
  }
  return lines.join('\n');
}
