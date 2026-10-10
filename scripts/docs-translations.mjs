#!/usr/bin/env node
// What is the state of the guide's translations? For each language folder docs/guide/<code>/ it reports
//   missing    English pages with no translation (the guide shows the English page with a notice),
//   stale      translated pages whose English source changed since they were translated (docs/guide/<code>/.sources.json
//              keeps the hash of the English file each page was translated from),
//   orphan     translated pages whose English page is gone,
//   drift      pages whose structure no longer matches the English: other headings, bullet, code, table or image counts,
//              links to other pages or images that differ, or a #link that points at no heading of its page.
//
//   node scripts/docs-translations.mjs [--locale sv] [--strict] [--json]
//   node scripts/docs-translations.mjs --stamp <page.md>... [--locale sv]    records the English hash: the page was translated or reviewed
//   node scripts/docs-translations.mjs --stamp-all [--locale sv]
//
// Without --strict it only reports (exit 0). With --strict a stale, orphan or drifting page fails (exit 1); missing pages do not,
// they are a visible fallback, not an error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLocales, loadUi } from './vite-docs.mjs';
import { renderMarkdown } from './docs-markdown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(ROOT, 'docs', 'guide');
const SOURCES = '.sources.json';

/** Hash of an English page as it is now (line ends normalised): what a translation records it was made from. */
export const hashSource = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

const pagesOf = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();
  } catch {
    return [];
  }
};

const readSources = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, SOURCES), 'utf8'));
  } catch {
    return {};
  }
};

const count = (html, re) => (html.match(re) ?? []).length;

/** What a translation must keep from its English page. */
export function shape(src, base) {
  const r = renderMarkdown(src, { linkBase: base, imageBase: '/docs/' });
  const attr = (name) => [...r.html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1].replace(/&amp;/g, '&'));
  const hrefs = attr('href');
  const pageLinks = hrefs.filter((h) => h.startsWith(base)).map((h) => h.slice(base.length).split('#')[0] || 'index');
  return {
    headings: r.headings.map((h) => h.level).join(''),
    items: count(r.html, /<li[ >]/g),
    code: count(r.html, /<pre[ >]/g),
    tables: count(r.html, /<table[ >]/g),
    images: attr('src').sort(),
    pageLinks: pageLinks.sort(),
    ids: new Set(r.headings.map((h) => h.id)),
    fragments: hrefs.filter((h) => h.startsWith('#')).map((h) => h.slice(1)),
    foreign: hrefs.filter((h) => h.startsWith(base) && h.includes('#')).map((h) => ({ page: h.slice(base.length).split('#')[0] || 'index', id: h.split('#')[1] })),
    title: r.title,
  };
}

/** The state of one language against the English pages. */
export function checkLocale(code, dir = GUIDE) {
  const english = pagesOf(dir);
  const own = pagesOf(path.join(dir, code));
  const sources = readSources(path.join(dir, code));
  const result = { code, total: english.length, translated: 0, missing: /** @type {string[]} */ ([]), stale: /** @type {string[]} */ ([]), orphan: /** @type {string[]} */ ([]), drift: /** @type {{ file: string; problems: string[] }[]} */ ([]), unstamped: /** @type {string[]} */ ([]) };
  const enShapes = new Map();
  const shapeOf = (file, enSrc) => enShapes.get(file) ?? enShapes.set(file, shape(enSrc, '/docs/')).get(file);
  const mine = new Map();
  for (const f of own) mine.set(f, shape(fs.readFileSync(path.join(dir, code, f), 'utf8'), `/docs/${code}/`));
  for (const file of english) {
    if (!own.includes(file)) {
      result.missing.push(file);
      continue;
    }
    result.translated++;
    const enSrc = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!(file in sources)) result.unstamped.push(file);
    else if (sources[file] !== hashSource(enSrc)) result.stale.push(file);
    const en = shapeOf(file, enSrc);
    const tr = mine.get(file);
    const problems = [];
    if (en.headings !== tr.headings) problems.push(`headings differ (English ${en.headings || 'none'}, translation ${tr.headings || 'none'})`);
    if (en.items !== tr.items) problems.push(`${tr.items} list items, English has ${en.items}`);
    if (en.code !== tr.code) problems.push(`${tr.code} code blocks, English has ${en.code}`);
    if (en.tables !== tr.tables) problems.push(`${tr.tables} tables, English has ${en.tables}`);
    if (en.images.join('|') !== tr.images.join('|')) problems.push('images differ');
    if (en.pageLinks.join('|') !== tr.pageLinks.join('|')) problems.push(`links to other pages differ (English: ${en.pageLinks.join(', ') || 'none'}; translation: ${tr.pageLinks.join(', ') || 'none'})`);
    for (const f of tr.fragments) if (!tr.ids.has(f)) problems.push(`#${f} points at no heading of this page`);
    for (const { page, id } of tr.foreign) {
      const target = mine.get(`${page}.md`) ?? (english.includes(`${page}.md`) ? shapeOf(`${page}.md`, fs.readFileSync(path.join(dir, `${page}.md`), 'utf8')) : null);
      if (target && !target.ids.has(id)) problems.push(`link ${page}#${id} points at no heading of that page`);
    }
    if (problems.length) result.drift.push({ file, problems });
  }
  for (const file of own) if (!english.includes(file)) result.orphan.push(file);
  return result;
}

/** Records the current English hash for translated pages. */
export function stamp(code, files, dir = GUIDE) {
  const target = path.join(dir, code);
  const sources = readSources(target);
  for (const file of files) {
    const en = path.join(dir, file);
    if (!fs.existsSync(en) || !fs.existsSync(path.join(target, file))) throw new Error(`${file}: both ${file} and ${code}/${file} must exist`);
    sources[file] = hashSource(fs.readFileSync(en, 'utf8'));
  }
  const sorted = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(target, SOURCES), `${JSON.stringify(sorted, null, 2)}\n`);
  return Object.keys(sorted).length;
}

export function main(argv, dir = GUIDE, out = console) {
  const args = { locale: null, strict: false, json: false, stamp: [], stampAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') args.strict = true;
    else if (a === '--json') args.json = true;
    else if (a === '--stamp-all') args.stampAll = true;
    else if (a === '--locale') args.locale = argv[++i];
    else if (a === '--stamp') while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.stamp.push(path.basename(argv[++i]));
    else throw new Error(`unknown option ${a}`);
  }
  const locales = args.locale ? [args.locale] : listLocales(dir);
  if (args.stamp.length || args.stampAll) {
    for (const code of locales) {
      const files = args.stampAll ? pagesOf(path.join(dir, code)).filter((f) => pagesOf(dir).includes(f)) : args.stamp;
      out.log(`${code}: ${stamp(code, files, dir)} pages stamped with the current English`);
    }
    return 0;
  }
  const results = locales.map((code) => checkLocale(code, dir));
  if (args.json) out.log(JSON.stringify(results, null, 2));
  else {
    if (!results.length) out.log('No language folders in docs/guide: nothing to check.');
    for (const r of results) {
      out.log(`${r.code} (${loadUi(r.code, dir).docs}): ${r.translated} of ${r.total} pages translated`);
      for (const f of r.missing) out.log(`  missing   ${f}  (shows English with a notice)`);
      for (const f of r.stale) out.log(`  STALE     ${f}  (the English changed since it was translated)`);
      for (const f of r.unstamped) out.log(`  unstamped ${f}  (no English hash recorded: run --stamp ${f} once it is reviewed)`);
      for (const f of r.orphan) out.log(`  ORPHAN    ${f}  (no English page)`);
      for (const d of r.drift) for (const p of d.problems) out.log(`  DRIFT     ${d.file}: ${p}`);
    }
  }
  const bad = results.some((r) => r.stale.length || r.orphan.length || r.drift.length || r.unstamped.length);
  return args.strict && bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
