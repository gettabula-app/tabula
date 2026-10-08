// Vite plugin for the user guide: renders docs/guide/*.md into static pages under /docs/.
// Build: dist/docs/index.html, dist/docs/<slug>/index.html, search.json, 404.html and images.
// Dev: the same pages are rendered live on every request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml as esc, renderMarkdown } from './docs-markdown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(ROOT, 'docs', 'guide');
const IMAGES = path.join(GUIDE, 'images');
const ENTRY = path.join(ROOT, 'src', 'docs', 'docs.ts');
const BASE = '/docs/';
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const titleCase = (slug) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Reads and renders every page; sidebar order follows the links in index.md, the rest follows alphabetically. */
export function loadPages(dir = GUIDE) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  } catch {
    // no guide yet
  }
  const pages = new Map();
  for (const name of names.sort()) {
    const slug = name.slice(0, -3);
    const r = renderMarkdown(fs.readFileSync(path.join(dir, name), 'utf8'), { linkBase: BASE });
    pages.set(slug, { slug, ...r, title: r.title || titleCase(slug), url: slug === 'index' ? BASE : `${BASE}${slug}` });
  }
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

function document({ title, body, pages, current, script, styles }) {
  const nav = pages.map((p) => {
    const here = p.slug === current;
    return `<li><a href="${esc(p.url)}"${here ? ' aria-current="page"' : ''}>${esc(p.slug === 'index' ? 'Overview' : p.title)}</a></li>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Tabula docs</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600,700&display=swap">
${styles.map((href) => `<link rel="stylesheet" href="${esc(href)}">`).join('\n')}
<script type="module" src="${esc(script)}"></script>
</head>
<body>
<header class="docs-header">
<button class="docs-menu" type="button" aria-controls="docs-nav" aria-expanded="false">Menu</button>
<a class="docs-mark" href="/">Tabula</a>
<span class="docs-label">Docs</span>
<div class="docs-search">
<input id="docs-search" type="search" placeholder="Search the guide" aria-label="Search the guide" autocomplete="off" spellcheck="false">
<ul id="docs-results" role="listbox" aria-label="Search results" hidden></ul>
</div>
</header>
<div class="docs-layout">
<nav id="docs-nav" class="docs-nav" aria-label="Guide"><ul>${nav}</ul></nav>
<main class="docs-main">
${body}
</main>
</div>
</body>
</html>
`;
}

const notFoundBody = `<h1>Page not found</h1>\n<p>This page of the guide does not exist. Pick a page from the list, or <a href="${BASE}">start at the overview</a>.</p>`;

const searchIndex = (pages) => pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings.map((h) => ({ text: h.text, id: h.id })), text: p.text }));

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
      const pages = loadPages();
      const emit = (fileName, source) => this.emitFile({ type: 'asset', fileName, source });
      const render = (title, body, current) => document({ title, body, pages, current, script: `/${scriptFile}`, styles });
      for (const p of pages) {
        emit(p.slug === 'index' ? 'docs/index.html' : `docs/${p.slug}/index.html`, render(p.title, p.html, p.slug));
      }
      emit('docs/404.html', render('Page not found', notFoundBody, ''));
      emit('docs/search.json', JSON.stringify(searchIndex(pages)));
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
        const sendPage = async (status, title, body, current, pages) => {
          const html = document({ title, body, pages, current, script: '/src/docs/docs.ts', styles: [] });
          send(status, 'text/html; charset=utf-8', await server.transformIndexHtml(req.url, html));
        };

        const rel = pathname.slice(BASE.length).replace(/\/+$/, '');
        const pages = loadPages();
        if (rel === 'search.json') return send(200, 'application/json', JSON.stringify(searchIndex(pages)));
        if (rel.startsWith('images/')) {
          const name = rel.slice('images/'.length);
          const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
          const file = path.join(IMAGES, name);
          if (type && name === path.basename(name) && fs.existsSync(file)) return send(200, type, fs.readFileSync(file));
          return send(404, 'text/plain; charset=utf-8', 'Not found');
        }
        const page = pages.find((p) => (rel === '' ? p.slug === 'index' : p.slug === rel && rel !== 'index'));
        if (page) return sendPage(200, page.title, page.html, page.slug, pages);
        return sendPage(404, 'Page not found', notFoundBody, '', pages);
      });
    },
  };
}
