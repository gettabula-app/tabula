#!/usr/bin/env node
// Builds the icon sets Tabula serves itself into dist/icons/ (docs/icons-selfhost.md), from the installed `@iconify/json`.
// Run by `npm run build` after `vite build`, which empties dist/.
//
//   node scripts/build-icons.mjs                    every set whose licence is allowed (about 210 sets)
//   ICON_SETS=curated node scripts/build-icons.mjs  the CURATED_SETS list below only
//   ICON_SETS=demo node scripts/build-icons.mjs     the small plain-JSON demo set below
//
// Output: manifest.json, i/<prefix>.<hash>.json (index), s/<prefix>.<n>.<hash>.json (shards), pin.<hash>.json and
// LICENSES.txt. Relay builds store JSON gzipped as <name>.gz; demo builds write plain .json for static hosts.
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

/** The only sets included in the static demo. Order is the picker and cross-set search priority. */
export const DEMO_SETS = ['lucide', 'fluent-emoji-flat'];

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

/** Common Fluent Emoji names shipped in the demo, in addition to PINNED. All names are Iconify names. */
export const DEMO_EMOJI_NAMES = [
  '1st-place-medal', 'airplane', 'airplane-arrival', 'airplane-departure', 'alien', 'alien-monster', 'ambulance', 'anchor',
  'angry-face', 'anguished-face', 'anxious-face-with-sweat', 'astonished-face', 'avocado', 'baby', 'baby-chick', 'backhand-index-pointing-down',
  'backhand-index-pointing-left', 'backhand-index-pointing-right', 'backhand-index-pointing-up', 'bacon', 'badger', 'bagel', 'baguette-bread', 'balloon',
  'banana', 'basketball', 'bat', 'beaming-face-with-smiling-eyes', 'bear', 'beaver', 'beer-mug', 'bell', 'bicycle', 'bird',
  'birthday-cake', 'black-cat', 'black-heart', 'blackbird', 'blossom', 'blowfish', 'blue-book', 'blue-heart', 'bomb',
  'bone', 'books', 'bookmark', 'bouquet', 'bow-and-arrow', 'bowl-with-spoon', 'brain', 'bread', 'broken-heart', 'brown-heart',
  'bubble-tea', 'bubbles', 'building-construction', 'bullseye', 'burrito', 'butter', 'butterfly', 'cactus', 'calendar', 'call-me-hand',
  'camera', 'candy', 'automobile', 'carp-streamer', 'cat', 'cat-face', 'cat-with-tears-of-joy', 'chair', 'cheese-wedge', 'cherries',
  'cherry-blossom', 'chess-pawn', 'chicken', 'chocolate-bar', 'christmas-tree', 'clapping-hands', 'clinking-beer-mugs', 'clinking-glasses', 'cloud', 'cloud-with-lightning',
  'cloud-with-lightning-and-rain', 'cloud-with-rain', 'cloud-with-snow', 'clown-face', 'cold-face', 'confetti-ball', 'confounded-face', 'confused-face', 'cookie',
  'cooking', 'cow', 'cow-face', 'cowboy-hat-face', 'crab', 'crayon', 'credit-card', 'crescent-moon', 'crocodile', 'croissant',
  'crying-cat', 'crying-face', 'cup-with-straw', 'cupcake', 'cut-of-meat', 'dango', 'deciduous-tree', 'deer', 'dolphin', 'doughnut',
  'downcast-face-with-sweat', 'drooling-face', 'duck', 'dumpling', 'eagle', 'ear-of-corn', 'egg', 'eggplant', 'elephant', 'envelope',
  'exploding-head', 'expressionless-face', 'eyes', 'face-blowing-a-kiss', 'face-exhaling', 'face-holding-back-tears', 'face-in-clouds', 'face-savoring-food', 'face-screaming-in-fear', 'face-vomiting',
  'face-with-diagonal-mouth', 'face-with-hand-over-mouth', 'face-with-head-bandage', 'face-with-medical-mask', 'face-with-monocle', 'face-with-open-eyes-and-hand-over-mouth', 'face-with-open-mouth', 'face-with-peeking-eye', 'face-with-raised-eyebrow', 'face-with-rolling-eyes',
  'face-with-spiral-eyes', 'face-with-steam-from-nose', 'face-with-symbols-on-mouth', 'face-with-tears-of-joy', 'face-with-thermometer', 'face-with-tongue', 'face-without-mouth', 'fearful-face', 'fire', 'fire-engine',
  'fireworks', 'fish', 'flushed-face', 'folded-hands', 'fox', 'french-fries', 'frog', 'frowning-face', 'frowning-face-with-open-mouth', 'game-die',
  'ghost', 'glasses', 'globe-showing-americas', 'globe-showing-asia-australia', 'globe-showing-europe-africa', 'glowing-star', 'goat', 'gorilla', 'grapes',
  'green-apple', 'green-heart', 'grimacing-face', 'grinning-cat', 'grinning-cat-with-smiling-eyes', 'grinning-face', 'grinning-face-with-big-eyes', 'grinning-face-with-smiling-eyes', 'grinning-face-with-sweat', 'grinning-squinting-face',
  'growing-heart', 'guitar', 'hamburger', 'hamster', 'handshake', 'hatching-chick', 'head-shaking-horizontally', 'head-shaking-vertically', 'hear-no-evil-monkey', 'hedgehog',
  'herb', 'hibiscus', 'high-voltage', 'honeybee', 'hot-beverage', 'hot-dog', 'hot-face', 'house', 'hugging-face', 'hundred-points',
  'hushed-face', 'ice-cream', 'index-pointing-at-the-viewer', 'index-pointing-up', 'jack-o-lantern', 'jellyfish', 'joystick', 'kangaroo', 'keyboard', 'kiwi-fruit',
  'koala', 'laptop', 'leaf-fluttering-in-wind', 'lemon', 'light-blue-heart', 'light-bulb', 'lion', 'lizard', 'lobster', 'loudly-crying-face',
  'love-letter', 'magic-wand', 'mango', 'maple-leaf', 'microbe', 'glass-of-milk', 'monkey', 'monkey-face', 'full-moon', 'mouse',
  'mouse-face', 'mushroom', 'nauseated-face', 'nerd-face', 'neutral-face', 'octopus', 'owl', 'panda', 'pancakes', 'party-popper',
  'peach', 'peanuts', 'pear', 'penguin', 'pizza', 'potted-plant', 'popcorn', 'pouting-face', 'purple-heart',
  'rabbit', 'rainbow', 'raised-hand', 'raising-hands', 'red-apple', 'red-heart', 'relieved-face', 'ribbon', 'rocket', 'rolling-on-the-floor-laughing',
  'rose', 'sad-but-relieved-face', 'saluting-face', 'sandwich', 'sauropod', 'shaking-face', 'ewe', 'shield', 'person-shrugging', 'skull',
  'sleeping-face', 'slightly-frowning-face', 'slightly-smiling-face', 'smiling-face-with-halo', 'smiling-face-with-heart-eyes', 'smiling-face-with-hearts', 'smiling-face-with-sunglasses', 'smiling-face-with-tear', 'smirking-face', 'snail',
  'snake', 'sneezing-face', 'snowflake', 'soccer-ball', 'sparkles', 'sparkling-heart', 'speech-balloon', 'spider',
  'star', 'star-struck', 'sun', 'sunflower', 'sushi', 'sweat-droplets', 'taco', 'teddy-bear', 'thinking-face', 'thumbs-down',
  'thumbs-up', 'tiger', 'toilet', 'tomato', 'tongue', 'trophy', 'tulip', 'turtle', 'two-hearts', 'unicorn',
  'victory-hand', 'volcano', 'volleyball', 'person-walking', 'warning', 'watch', 'watermelon', 'water-wave', 'waving-hand', 'whale',
  'white-heart', 'wilted-flower', 'wind-face', 'wine-glass', 'wolf', 'woman', 'winking-face', 'winking-face-with-tongue', 'wrapped-gift', 'writing-hand',
  'yellow-heart', 'zany-face', 'zebra', 'zipper-mouth-face',
];

const DEMO_ICONS = { 'fluent-emoji-flat': DEMO_EMOJI_NAMES };

const DEMO_RAW_BUDGET = 3 * 1024 * 1024;
const DEMO_FILE_BUDGET = 1024 * 1024;

const FIXED_TIME = new Date('2020-01-01T00:00:00Z');
const PREFIX_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CACHE_KEY_RE = /^[0-9a-f]{16}$/;
const sourceFiles = [fileURLToPath(import.meta.url), path.join(here, 'lib', 'icons-build.mjs')];

const readJson = async (file) => JSON.parse(await fs.promises.readFile(file, 'utf8'));

/** Resolve ICONS_OUT like the build CLI: relative paths are rooted at the repository, not the caller's cwd. */
export function iconOutputDir(value = process.env.ICONS_OUT) {
  return path.resolve(root, value || 'dist/icons');
}

function subsetData(prefix, data, names, pinned) {
  const included = new Set([...names, ...[...pinned].filter((full) => full.startsWith(`${prefix}:`)).map((full) => full.slice(prefix.length + 1))]);
  const add = (name, trail = new Set()) => {
    if (data.icons?.[name]) return;
    if (trail.has(name)) throw new Error(`${prefix}:${name} has a cyclic alias`);
    const alias = data.aliases?.[name];
    if (!alias) throw new Error(`${prefix}:${name} is missing from the demo icon set`);
    trail.add(name);
    included.add(alias.parent);
    add(alias.parent, trail);
  };
  for (const name of included) add(name);
  const icons = Object.fromEntries([...included].filter((name) => data.icons?.[name]).map((name) => [name, data.icons[name]]));
  const aliases = Object.fromEntries([...included].filter((name) => data.aliases?.[name]).map((name) => [name, data.aliases[name]]));
  const categories = Object.fromEntries(Object.entries(data.categories || {}).map(([category, list]) => [category, list.filter((name) => included.has(name))]).filter(([, list]) => list.length));
  return { ...data, icons, aliases, categories };
}

function filesIn(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(file, base) : [{ path: path.relative(base, file).replaceAll('\\', '/'), data: fs.readFileSync(file) }];
  });
}

async function measureOutput(dir) {
  const files = filesIn(dir).map((file) => ({ ...file, raw: file.data.length }));
  for (const file of files) file.gzip = (await gzip(file.data)).length;
  return {
    files,
    raw: files.reduce((n, file) => n + file.raw, 0),
    gzip: files.reduce((n, file) => n + file.gzip, 0),
    count: files.length,
  };
}

function assertDemoBudget(measure) {
  const tooLarge = measure.files.find((file) => file.raw > DEMO_FILE_BUDGET);
  if (tooLarge) throw new Error(`demo icon file ${tooLarge.path} is ${(tooLarge.raw / 1048576).toFixed(2)} MB; per-file limit is 1 MB`);
  if (measure.raw > DEMO_RAW_BUDGET) throw new Error(`demo icons are ${(measure.raw / 1048576).toFixed(2)} MB raw; total limit is 3 MB`);
}

function logDemo(measure, sets, ms, log) {
  for (const set of sets) {
    const prefix = set.p;
    const files = measure.files.filter((file) => file.path.startsWith(`s/${prefix}.`) || file.path.startsWith(`i/${prefix}.`));
    const raw = files.reduce((n, file) => n + file.raw, 0);
    const zipped = files.reduce((n, file) => n + file.gzip, 0);
    log(`icons: demo set ${prefix}, ${set.n.toLocaleString('en')} icons, ${(raw / 1048576).toFixed(2)} MB raw, ${(zipped / 1048576).toFixed(2)} MB gzip`);
  }
  const icons = sets.reduce((n, set) => n + set.n, 0);
  log(`icons: demo ${sets.length} sets, ${icons.toLocaleString('en')} icons, ${(measure.raw / 1048576).toFixed(2)} MB raw, ${(measure.gzip / 1048576).toFixed(2)} MB gzip in ${(ms / 1000).toFixed(1)} s`);
}

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
 * @param {{ source?: string, out?: string, sets?: 'all' | string[], exclude?: string[], priority?: string[], pinned?: string[], shardIcons?: number, shardBytes?: number, cacheDir?: string | null, plain?: boolean, includeIcons?: Record<string, string[]>, log?: (message: string) => void }} [options]
 * @returns {Promise<{ cached: boolean, sets: { p: string, n: number }[], skipped?: { hidden: number, licence: number, archived: number }, ms: number }>}
 */
export async function buildIcons({
  source = path.join(root, 'node_modules', '@iconify', 'json'), out = path.join(root, 'dist', 'icons'), sets = 'all',
  exclude = EXCLUDED_SETS, priority = CURATED_SETS, pinned = PINNED, shardIcons = SHARD_ICONS, shardBytes = SHARD_BYTES,
  cacheDir = null, plain = false, includeIcons = {}, log = () => {},
} = {}) {
  const t0 = Date.now();
  const version = (await readJson(path.join(source, 'package.json'))).version;
  const key = sha256(JSON.stringify([
    version, sets, exclude, EXCLUDED_CATEGORY, priority, pinned, shardIcons, shardBytes, GZIP_LEVEL, plain, includeIcons,
    sourceFiles.map((f) => fs.readFileSync(f, 'utf8')),
  ])).slice(0, 16);
  fs.rmSync(out, { recursive: true, force: true });

  const manifestName = plain ? 'manifest.json' : 'manifest.json.gz';
  if (cacheDir && fs.existsSync(path.join(cacheDir, key, manifestName))) {
    copyTree(path.join(cacheDir, key), out);
    const bytes = fs.readFileSync(path.join(out, manifestName));
    const manifest = JSON.parse(plain ? bytes : zlib.gunzipSync(bytes));
    if (plain) {
      const measured = await measureOutput(out);
      assertDemoBudget(measured);
      logDemo(measured, manifest.sets, Date.now() - t0, log);
    } else {
      log(`icons: ${manifest.sets.length} sets from cache in ${Date.now() - t0} ms`);
    }
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
    let data = await readJson(path.join(jsonDir, `${prefix}.json`));
    if (includeIcons[prefix]) data = subsetData(prefix, data, includeIcons[prefix], pinnedSet);
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
      await writeFixed(path.join(staging, plain ? f.path : `${f.path}.gz`), plain ? f.data : zipped);
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
  for (const f of extra) await writeFixed(path.join(staging, plain ? f.path : `${f.path}.gz`), plain ? f.data : await gzip(f.data));
  await writeFixed(path.join(staging, 'LICENSES.txt'), licensesText(manifest.sets, `@iconify/json ${version}`));
  fixDirTimes(staging);

  if (cacheDir) {
    const final = path.join(cacheDir, key);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(staging, final);
    for (const e of fs.readdirSync(cacheDir)) if (e !== key && CACHE_KEY_RE.test(e)) fs.rmSync(path.join(cacheDir, e), { recursive: true, force: true });
    copyTree(final, out);
  }

  if (plain) {
    const measured = await measureOutput(out);
    assertDemoBudget(measured);
    logDemo(measured, manifest.sets, Date.now() - t0, log);
  } else {
    const count = manifest.sets.reduce((n, s) => n + s.n, 0);
    const gzBytes = manifest.sets.reduce((n, s) => n + s.gz, 0);
    log(`icons: ${manifest.sets.length} sets, ${count.toLocaleString('en')} icons, ${(gzBytes / 1048576).toFixed(1)} MB gzip in ${((Date.now() - t0) / 1000).toFixed(1)} s`
      + ` (skipped ${skipped.hidden} hidden, ${skipped.licence} by licence, ${skipped.archived} unmaintained${sets === 'all' ? `, ${exclude.length} excluded` : ''})`);
  }
  return { cached: false, sets: manifest.sets, skipped, ms: Date.now() - t0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.env.ICON_SETS || 'all';
  if (!['all', 'curated', 'demo'].includes(mode)) {
    console.error(`ICON_SETS must be "all", "curated" or "demo", not "${mode}"`);
    process.exit(1);
  }
  try {
    await buildIcons({
      sets: mode === 'demo' ? DEMO_SETS : mode === 'curated' ? CURATED_SETS : 'all',
      out: iconOutputDir(),
      plain: mode === 'demo',
      includeIcons: mode === 'demo' ? DEMO_ICONS : {},
      cacheDir: mode === 'demo' ? null : path.join(root, 'node_modules', '.cache', 'tabula-icons'),
      log: (m) => console.log(m),
    });
  } catch (e) {
    console.error(`icons: ${e.message}`);
    process.exit(1);
  }
}
