#!/usr/bin/env node
// Builds the icon sets Tabula serves itself into dist/icons/ (docs/icons-selfhost.md), from the installed `@iconify/json`.
// Run by `npm run build` after `vite build`, which empties dist/.
//
//   node scripts/build-icons.mjs                    every set whose licence is allowed (about 210 sets)
//   ICON_SETS=curated node scripts/build-icons.mjs  the CURATED_SETS list below only
//
// Output: manifest.json, i/<prefix>.<hash>.json (index), s/<prefix>.<n>.<hash>.json (shards), pin.<hash>.json and
// LICENSES.txt. Every JSON file is stored gzipped as <name>.gz; the relay serves it under the name without .gz.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GZIP_LEVEL, SHARD_BYTES, SHARD_ICONS, buildSet, canonicalJson, checkSet, gzip, licensesText, pinFile, sha256 } from './lib/icons-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** The sets `ICON_SETS=curated` builds, in the order the picker and cross-set search rank them. */
export const CURATED_SETS = [
  'lucide', 'tabler', 'ph', 'mdi', 'material-symbols', 'carbon', 'heroicons', 'logos', 'simple-icons', 'fluent-emoji-flat', 'twemoji', 'devicon',
  'noto', 'bi', 'ri', 'ion', 'iconoir', 'octicon', 'circle-flags',
];

/** Sets that pass the licence rule but are never hosted, besides every set in EXCLUDED_CATEGORY. */
export const EXCLUDED_SETS = ['fa6-solid', 'fa6-regular', 'fa6-brands'];

/** Iconify's category for sets nobody maintains (Font Awesome 4 to 6, older Heroicons and others): none of them are hosted. */
export const EXCLUDED_CATEGORY = 'Archive / Unmaintained';

// Keep equal to REACTIONS in src/stickers.ts; test/stickers.test.ts compares them.
export const PINNED = [
  'fluent-emoji-flat:thumbs-up', 'fluent-emoji-flat:red-heart', 'fluent-emoji-flat:party-popper', 'fluent-emoji-flat:face-with-tears-of-joy',
  'fluent-emoji-flat:eyes', 'fluent-emoji-flat:fire', 'fluent-emoji-flat:rocket', 'fluent-emoji-flat:sparkles',
  'fluent-emoji-flat:clapping-hands', 'fluent-emoji-flat:thinking-face', 'fluent-emoji-flat:hundred-points', 'fluent-emoji-flat:check-mark-button',
  'fluent-emoji-flat:cross-mark', 'fluent-emoji-flat:raising-hands', 'fluent-emoji-flat:folded-hands', 'fluent-emoji-flat:star-struck',
];

const FIXED_TIME = new Date('2020-01-01T00:00:00Z');
const PREFIX_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CACHE_KEY_RE = /^[0-9a-f]{16}$/;
const sourceFiles = [fileURLToPath(import.meta.url), path.join(here, 'lib', 'icons-build.mjs')];

const readJson = async (file) => JSON.parse(await fs.promises.readFile(file, 'utf8'));

/**
 * Runs `task` over `items`, `size` at a time. After a failure no new item starts, and the pool settles only once the
 * tasks already running have finished, then throws the first error: a failed build must not leave writes going on in
 * `out` behind its caller's back (a caller that cleans up after the error would race them).
 */
export async function runPool(items, size, task) {
  const out = Array.from({ length: items.length });
  let next = 0;
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (failure === null && next < items.length) {
      const i = next++;
      try {
        out[i] = await task(items[i], i);
      } catch (e) {
        failure ??= { error: e };
      }
    }
  }));
  if (failure) throw failure.error;
  return out;
}

async function writeFixed(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, data);
  await fs.promises.utimes(file, FIXED_TIME, FIXED_TIME);
}

const fixDirTimes = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) fixDirTimes(path.join(dir, e.name));
  fs.utimesSync(dir, FIXED_TIME, FIXED_TIME);
};

/** Copies a tree, hard-linking files where the file system allows it (the cache and dist/ are normally on one volume). */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) {
      copyTree(src, dst);
      continue;
    }
    try {
      fs.linkSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
      fs.utimesSync(dst, FIXED_TIME, FIXED_TIME);
    }
  }
  fs.utimesSync(to, FIXED_TIME, FIXED_TIME);
}

/**
 * Builds the icon files into `out`.
 * `sets` is 'all' (every allowed set, minus `exclude`) or an explicit list, where a set that is not allowed stops the build.
 * `priority` sets come first in the manifest; the rest follow by prefix. With a `cacheDir`, output is kept per
 * (source version, set selection, limits, build code) and an unchanged rebuild is a copy.
 * @param {{ source?: string, out?: string, sets?: 'all' | string[], exclude?: string[], priority?: string[], pinned?: string[], shardIcons?: number, shardBytes?: number, cacheDir?: string | null, log?: (message: string) => void }} [options]
 * @returns {Promise<{ cached: boolean, sets: { p: string, n: number }[], skipped?: { hidden: number, licence: number, archived: number }, ms: number }>}
 */
export async function buildIcons({
  source = path.join(root, 'node_modules', '@iconify', 'json'), out = path.join(root, 'dist', 'icons'), sets = 'all',
  exclude = EXCLUDED_SETS, priority = CURATED_SETS, pinned = PINNED, shardIcons = SHARD_ICONS, shardBytes = SHARD_BYTES,
  cacheDir = null, log = () => {},
} = {}) {
  const t0 = Date.now();
  const version = (await readJson(path.join(source, 'package.json'))).version;
  const key = sha256(JSON.stringify([
    version, sets, exclude, EXCLUDED_CATEGORY, priority, pinned, shardIcons, shardBytes, GZIP_LEVEL,
    sourceFiles.map((f) => fs.readFileSync(f, 'utf8')),
  ])).slice(0, 16);
  fs.rmSync(out, { recursive: true, force: true });

  if (cacheDir && fs.existsSync(path.join(cacheDir, key, 'manifest.json.gz'))) {
    copyTree(path.join(cacheDir, key), out);
    const manifest = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(out, 'manifest.json.gz'))));
    log(`icons: ${manifest.sets.length} sets from cache in ${Date.now() - t0} ms`);
    return { cached: true, sets: manifest.sets, ms: Date.now() - t0 };
  }

  const staging = cacheDir ? path.join(cacheDir, `${key}.tmp-${process.pid}`) : out;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  if (cacheDir) for (const e of fs.readdirSync(cacheDir)) if (e.includes('.tmp-') && path.join(cacheDir, e) !== staging) fs.rmSync(path.join(cacheDir, e), { recursive: true, force: true });

  const jsonDir = path.join(source, 'json');
  const available = fs.readdirSync(jsonDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  for (const p of available) if (!PREFIX_RE.test(p)) throw new Error(`unexpected set prefix "${p}"`);
  let chosen;
  if (sets === 'all') {
    chosen = available.filter((p) => !exclude.includes(p));
  } else {
    for (const p of sets) if (!available.includes(p)) throw new Error(`${p}: not in ${path.relative(root, source) || source}`);
    chosen = [...sets];
  }
  const rank = (p) => { const i = priority.indexOf(p); return i < 0 ? Infinity : i; };
  chosen.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));

  // collections.json holds every set's info and is small; it saves parsing the big sets that would be skipped
  let listed = {};
  try {
    listed = await readJson(path.join(source, 'collections.json'));
  } catch { /* the set files are the truth */ }
  const pinnedSet = new Set(pinned);
  const skipped = { hidden: 0, licence: 0, archived: 0 };
  const built = await runPool(chosen, 6, async (prefix) => {
    const skip = (info) => { skipped[info?.hidden ? 'hidden' : 'licence']++; return null; };
    if (sets === 'all' && listed[prefix] && !checkSet(listed[prefix]).ok) return skip(listed[prefix]);
    if (sets === 'all' && listed[prefix]?.category === EXCLUDED_CATEGORY) { skipped.archived++; return null; }
    const data = await readJson(path.join(jsonDir, `${prefix}.json`));
    if (sets === 'all' && data.info?.category === EXCLUDED_CATEGORY) { skipped.archived++; return null; }
    const verdict = checkSet(data.info);
    if (!verdict.ok) {
      if (sets !== 'all') throw new Error(`${prefix}: ${verdict.reason} (licence ${data.info?.license?.spdx ?? 'missing'})`);
      return skip(data.info);
    }
    const set = buildSet(prefix, data, { shardIcons, shardBytes, pinned: pinnedSet });
    let gz = 0;
    for (const f of set.files) {
      const zipped = await gzip(f.data);
      gz += f.shard ? zipped.length : 0;
      await writeFixed(path.join(staging, `${f.path}.gz`), zipped);
    }
    set.entry.gz = gz;
    return set;
  });

  const done = built.filter(Boolean);
  const pins = Object.assign({}, ...done.map((s) => s.pins));
  const manifest = { sets: done.map((s) => s.entry), v: 1 };
  const extra = [];
  if (Object.keys(pins).length) {
    const pin = pinFile(pins);
    extra.push(pin);
    manifest.pin = { f: pin.path.split('.')[1], names: pinned.filter((n) => pins[n]) };
  }
  extra.push({ path: 'manifest.json', data: canonicalJson(manifest) });
  for (const f of extra) await writeFixed(path.join(staging, `${f.path}.gz`), await gzip(f.data));
  await writeFixed(path.join(staging, 'LICENSES.txt'), licensesText(manifest.sets, `@iconify/json ${version}`));
  fixDirTimes(staging);

  if (cacheDir) {
    const final = path.join(cacheDir, key);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(staging, final);
    for (const e of fs.readdirSync(cacheDir)) if (e !== key && CACHE_KEY_RE.test(e)) fs.rmSync(path.join(cacheDir, e), { recursive: true, force: true });
    copyTree(final, out);
  }

  const count = manifest.sets.reduce((n, s) => n + s.n, 0);
  const gzBytes = manifest.sets.reduce((n, s) => n + s.gz, 0);
  log(`icons: ${manifest.sets.length} sets, ${count.toLocaleString('en')} icons, ${(gzBytes / 1048576).toFixed(1)} MB gzip in ${((Date.now() - t0) / 1000).toFixed(1)} s`
    + ` (skipped ${skipped.hidden} hidden, ${skipped.licence} by licence, ${skipped.archived} unmaintained${sets === 'all' ? `, ${exclude.length} excluded` : ''})`);
  return { cached: false, sets: manifest.sets, skipped, ms: Date.now() - t0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.env.ICON_SETS || 'all';
  if (mode !== 'all' && mode !== 'curated') {
    console.error(`ICON_SETS must be "all" or "curated", not "${mode}"`);
    process.exit(1);
  }
  try {
    await buildIcons({
      sets: mode === 'curated' ? CURATED_SETS : 'all',
      cacheDir: path.join(root, 'node_modules', '.cache', 'tabula-icons'),
      log: (m) => console.log(m),
    });
  } catch (e) {
    console.error(`icons: ${e.message}`);
    process.exit(1);
  }
}
