// Vite plugin for the user guide: renders docs/guide/*.md into static pages under /docs/.
// Build: dist/docs/index.html, dist/docs/<slug>/index.html, search.json, 404.html and images.
// Dev: the same pages are rendered live on every request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml as esc, renderMarkdown } from './docs-markdown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(ROOT, 'docs', 'guide');
// One source of truth for screenshots: the README and the guide both use docs/images (written by npm run docs:images).
const IMAGES = path.join(ROOT, 'docs', 'images');
const ENTRY = path.join(ROOT, 'src', 'docs', 'docs.ts');
const BASE = '/docs/';
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const titleCase = (slug) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** English is the source language of docs/guide/*.md; every other language is a folder of the same file names. */
export const SOURCE_LOCALE = 'en';
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Strings the page template shows; a locale's `_ui.json` overrides any of them, missing keys fall back to English. */
export const DEFAULT_UI = {
  menu: 'Menu',
  docs: 'Docs',
  search: 'Search the guide',
  results: 'Search results',
  guide: 'Guide',
  overview: 'Overview',
  language: 'Language',
  notFoundTitle: 'Page not found',
  notFound: 'This page of the guide does not exist. Pick a page from the list, or <a href="{home}">start at the overview</a>.',
  notTranslated: 'This page is not translated into {language} yet. Showing the English page.',
  suffix: 'Tabula docs',
};

const urlBase = (code) => (code === SOURCE_LOCALE ? BASE : `${BASE}${code}/`);

/** The language folders of the guide, for example ['sv']. A folder that shares its name with an English page is not a locale. */
export function listLocales(dir = GUIDE) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const english = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  return entries
    .filter((e) => e.isDirectory() && LOCALE_RE.test(e.name) && e.name !== SOURCE_LOCALE && !english.has(e.name))
    .filter((e) => fs.readdirSync(path.join(dir, e.name)).some((f) => f.endsWith('.md') && !f.startsWith('_')))
    .map((e) => e.name)
    .sort();
}

/** A language's own name, written in that language: 'svenska', 'English'. */
export const languageName = (code, inLocale = code) => {
  try {
    const n = new Intl.DisplayNames([inLocale], { type: 'language' }).of(code) ?? code;
    return n.charAt(0).toLocaleUpperCase(inLocale) + n.slice(1);
  } catch {
    return code;
  }
};

/** The template strings of a locale. */
export function loadUi(code, dir = GUIDE) {
  if (code === SOURCE_LOCALE) return { ...DEFAULT_UI };
  try {
    return { ...DEFAULT_UI, ...JSON.parse(fs.readFileSync(path.join(dir, code, '_ui.json'), 'utf8')) };
  } catch {
    return { ...DEFAULT_UI };
  }
}

const readPages = (dir, base) => {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  } catch {
    // no guide yet
  }
  const pages = new Map();
  for (const name of names.sort()) {
    const slug = name.slice(0, -3);
    const r = renderMarkdown(fs.readFileSync(path.join(dir, name), 'utf8'), { linkBase: base, imageBase: BASE });
    pages.set(slug, { slug, ...r, title: r.title || titleCase(slug), url: slug === 'index' ? base : `${base}${slug}` });
  }
  return pages;
};

/** Reads and renders every page; sidebar order follows the links in index.md, the rest follows alphabetically. */
export function loadPages(dir = GUIDE) {
  const pages = readPages(dir, BASE);
  const order = [];
  if (pages.has('index')) {
    order.push('index');
    const src = fs.readFileSync(path.join(dir, 'index.md'), 'utf8');
    for (const m of src.matchAll(/\]\(\s*(?:\.\/)?([a-z0-9-]+)\.md(?:#[^)]*)?\)/g)) {
      if (pages.has(m[1]) && !order.includes(m[1])) order.push(m[1]);
    }
  }
  for (const slug of pages.keys()) if (!order.includes(slug)) order.push(slug);
  return order.map((slug) => pages.get(slug));
}

/**
 * The pages of one language, in the English order. A page with no translation is the English page, marked `fallback`,
 * at the language's own URL: nobody reaches a 404 by switching language.
 */
export function loadLocalePages(code, dir = GUIDE) {
  const english = loadPages(dir);
  if (code === SOURCE_LOCALE) return english.map((p) => ({ ...p, locale: SOURCE_LOCALE, fallback: false }));
  const base = urlBase(code);
  const own = readPages(path.join(dir, code), base);
  // the English text is rendered again with this language's link base, so its links stay inside the language
  const sourceAtBase = readPages(dir, base);
  return english.map((en) => {
    const mine = own.get(en.slug);
    if (mine) return { ...mine, locale: code, fallback: false };
    return { ...sourceAtBase.get(en.slug), locale: code, fallback: true };
  });
}

/** The template of every page. `site` is { code, ui, locales: [{ code, name, base }] } and `page` the page being shown, if any. */
function document({ title, body, pages, current, script, styles, site = englishSite([]), page = null, translated = [] }) {
  const { code, ui, locales } = site;
  const nav = pages.map((p) => {
    const here = p.slug === current;
    return `<li><a href="${esc(p.url)}"${here ? ' aria-current="page"' : ''}${p.fallback ? ' lang="en"' : ''}>${esc(p.slug === 'index' ? ui.overview : p.title)}</a></li>`;
  }).join('');
  const slug = page?.slug ?? null;
  const at = (loc) => (slug === null || slug === 'index' ? loc.base : `${loc.base}${slug}`);
  const lang = locales.length > 1
    ? `<nav class="docs-lang" aria-label="${esc(ui.language)}"><ul>${locales.map((loc) => `<li><a href="${esc(at(loc))}" hreflang="${esc(loc.code)}" lang="${esc(loc.code)}"${loc.code === code ? ' aria-current="true"' : ''}>${esc(loc.name)}</a></li>`).join('')}</ul></nav>`
    : '';
  // hreflang pairs only for a page that really exists in each language, plus x-default for the English source
  const alternates = page && !page.fallback && translated.length > 1
    ? translated.map((loc) => `<link rel="alternate" hreflang="${esc(loc.code)}" href="${esc(at(loc))}">`).join('\n')
      + `\n<link rel="alternate" hreflang="x-default" href="${esc(at(locales.find((l) => l.code === SOURCE_LOCALE) ?? locales[0]))}">`
    : '';
  const english = locales.find((l) => l.code === SOURCE_LOCALE);
  const canonical = page?.fallback && english ? `<link rel="canonical" href="${esc(at(english))}">` : '';
  const here = locales.find((l) => l.code === code);
  const banner = page?.fallback
    ? `<p class="docs-fallback" role="note">${esc(ui.notTranslated.replace('{language}', here?.name ?? code))}</p>\n`
    : '';
  const content = page?.fallback ? `<div lang="en">\n${body}\n</div>` : body;
  return `<!doctype html>
<html lang="${esc(code)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(ui.suffix)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${canonical ? `${canonical}\n` : ''}${alternates ? `${alternates}\n` : ''}<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600,700&display=swap">
${styles.map((href) => `<link rel="stylesheet" href="${esc(href)}">`).join('\n')}
<script type="module" src="${esc(script)}"></script>
</head>
<body>
<header class="docs-header">
<button class="docs-menu" type="button" aria-controls="docs-nav" aria-expanded="false">${esc(ui.menu)}</button>
<a class="docs-mark" href="/">Tabula</a>
<span class="docs-label">${esc(ui.docs)}</span>
<div class="docs-search">
<input id="docs-search" type="search" placeholder="${esc(ui.search)}" aria-label="${esc(ui.search)}" autocomplete="off" spellcheck="false" data-search="${esc(here?.base ?? BASE)}search.json">
<ul id="docs-results" role="listbox" aria-label="${esc(ui.results)}" hidden></ul>
</div>
${lang}
</header>
<div class="docs-layout">
<nav id="docs-nav" class="docs-nav" aria-label="${esc(ui.guide)}"><ul>${nav}</ul></nav>
<main class="docs-main">
${banner}${content}
</main>
</div>
</body>
</html>
`;
}

/** The language switcher and string data of one language; `all` is every language of the guide, English first. */
function siteFor(code, all, dir = GUIDE) {
  return { code, ui: loadUi(code, dir), locales: all };
}
const allLocales = (dir = GUIDE) => [SOURCE_LOCALE, ...listLocales(dir)].map((code) => ({ code, name: languageName(code), base: urlBase(code) }));
const englishSite = (all) => ({ code: SOURCE_LOCALE, ui: { ...DEFAULT_UI }, locales: all });

const notFoundBody = (ui, home) => `<h1>${esc(ui.notFoundTitle)}</h1>\n<p>${ui.notFound.replace('{home}', esc(home))}</p>`;

const searchIndex = (pages) => pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings.map((h) => ({ text: h.text, id: h.id })), text: p.text }));

/** Everything one language's pages need: the pages, the template strings and the switcher with its hreflang pairs. */
function localeSetOf(dir = GUIDE) {
  const locales = allLocales(dir);
  const byLocale = new Map(locales.map((l) => [l.code, loadLocalePages(l.code, dir)]));
  const translatedOf = (slug) => locales.filter((l) => byLocale.get(l.code)?.some((p) => p.slug === slug && !p.fallback));
  return { locales, byLocale, translatedOf };
}

/** Renders every page of every language and calls `emit(fileName, source)` for each file of the built guide. */
function renderAllLocales(set, dir, script, styles, emit) {
  for (const loc of set.locales) {
    const pages = set.byLocale.get(loc.code);
    const site = siteFor(loc.code, set.locales, dir);
    const render = (title, body, current, page = null) => document({ title, body, pages, current, script, styles, site, page, translated: page ? set.translatedOf(page.slug) : [] });
    for (const p of pages) emit(`${loc.base.slice(1)}${p.slug === 'index' ? '' : `${p.slug}/`}index.html`, render(p.title, p.html, p.slug, p));
    if (loc.code === SOURCE_LOCALE) emit('docs/404.html', render(site.ui.notFoundTitle, notFoundBody(site.ui, loc.base), ''));
    emit(`${loc.base.slice(1)}search.json`, JSON.stringify(searchIndex(pages)));
  }
}

/** The files of the built guide as [fileName, source] pairs, for a guide folder; used by the tests. */
export function buildDocsFiles(dir = GUIDE, script = '/docs.js', styles = []) {
  const files = [];
  renderAllLocales(localeSetOf(dir), dir, script, styles, (name, source) => files.push([name, source]));
  return files;
}

export default function docsPlugin() {
  let scriptRef = '';
  let building = false;
  const imageFiles = () => {
    try {
      return fs.readdirSync(IMAGES).filter((f) => IMAGE_TYPES[path.extname(f).toLowerCase()]);
    } catch {
      return [];
    }
  };

  const localeSet = (dir = GUIDE) => localeSetOf(dir);
  const renderAll = renderAllLocales;

  return {
    name: 'tabula-docs',

    configResolved(config) {
      building = config.command === 'build';
    },

    buildStart() {
      if (!building) return;
      scriptRef = this.emitFile({ type: 'chunk', id: ENTRY, name: 'docs' });
      for (const f of imageFiles()) this.addWatchFile(path.join(IMAGES, f));
    },

    generateBundle(_options, bundle) {
      const scriptFile = this.getFileName(scriptRef);
      const chunk = bundle[scriptFile];
      const styles = [...(chunk?.viteMetadata?.importedCss ?? [])].map((f) => `/${f}`);
      const emit = (fileName, source) => this.emitFile({ type: 'asset', fileName, source });
      renderAll(localeSet(), GUIDE, `/${scriptFile}`, styles, emit);
      for (const f of imageFiles()) emit(`docs/images/${f}`, fs.readFileSync(path.join(IMAGES, f)));
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let pathname;
        try {
          pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        } catch {
          return next();
        }
        if (pathname !== '/docs' && !pathname.startsWith(BASE)) return next();

        const send = (status, type, body) => {
          res.statusCode = status;
          res.setHeader('content-type', type);
          res.setHeader('cache-control', 'no-store');
          res.end(body);
        };

        let rel = pathname.slice(BASE.length).replace(/\/+$/, '');
        if (rel.startsWith('images/')) {
          const name = rel.slice('images/'.length);
          const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
          const file = path.join(IMAGES, name);
          if (type && name === path.basename(name) && fs.existsSync(file)) return send(200, type, fs.readFileSync(file));
          return send(404, 'text/plain; charset=utf-8', 'Not found');
        }
        const set = localeSet();
        // a leading language folder selects the language: /docs/sv/kanban
        const first = rel.split('/')[0];
        const code = set.locales.some((l) => l.code === first && l.code !== SOURCE_LOCALE) ? first : SOURCE_LOCALE;
        if (code !== SOURCE_LOCALE) rel = rel.slice(first.length).replace(/^\/+/, '');
        const pages = set.byLocale.get(code);
        const site = siteFor(code, set.locales);
        if (rel === 'search.json') return send(200, 'application/json', JSON.stringify(searchIndex(pages)));
        const page = pages.find((p) => (rel === '' ? p.slug === 'index' : p.slug === rel && rel !== 'index'));
        const sendPage = async (status, title, body, current, pg) => {
          const html = document({ title, body, pages, current, script: '/src/docs/docs.ts', styles: [], site, page: pg, translated: pg ? set.translatedOf(pg.slug) : [] });
          send(status, 'text/html; charset=utf-8', await server.transformIndexHtml(req.url, html));
        };
        if (page) return sendPage(200, page.title, page.html, page.slug, page);
        return sendPage(404, site.ui.notFoundTitle, notFoundBody(site.ui, urlBase(code)), '', null);
      });
    },
  };
}
