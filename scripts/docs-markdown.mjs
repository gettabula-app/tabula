// Renderer for the small Markdown subset the user guide is written in (see docs/guide/).
// Everything is escaped; raw HTML in the source is shown as text, never interpreted.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

/** Plain text of an HTML fragment this module produced. */
const plainOf = (html) => unescapeHtml(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

export function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
}

/**
 * Returns the URL to use, or null when it must be dropped: only http(s), relative paths and #fragments pass.
 * Relative `x.md` and `x.md#y` become `${linkBase}x` and `${linkBase}x#y`; `index.md` becomes `linkBase`.
 */
// Where relative images resolve; set per renderMarkdown call (the renderer is synchronous). A translated page lives under /docs/sv/ but its screenshots stay in /docs/images/.
let imageBase = null;

function safeUrl(raw, linkBase, kind) {
  const url = raw.trim();
  if (!url || url.includes('\\') || [...url].some((ch) => ch <= ' ' || ch === '\u007f')) return null;
  if (url.startsWith('//')) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme) return /^https?$/i.test(scheme[1]) ? url : null;
  if (url.startsWith('#')) return kind === 'link' ? url : null;
  if (kind === 'image') return url.startsWith('/') ? url : (imageBase ?? linkBase) + url.replace(/^\.\//, '');
  const md = /^(?:\.\/)?([^#?]*?)\.md(#.*)?$/.exec(url);
  if (!md) return url;
  return (md[1] === 'index' ? linkBase : linkBase + md[1]) + (md[2] ?? '');
}

/** Index of the `]` that closes the `[` at `start`, allowing nested brackets, or -1. */
function closingBracket(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

function inline(s, linkBase) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*[\]()!#|<>_-]/.test(s[i + 1])) {
      out += escapeHtml(s[i + 1]);
      i += 2;
    } else if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, end))}</code>`;
        i = end + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (c === '!' && s[i + 1] === '[' || c === '[') {
      const image = c === '!';
      const open = image ? i + 1 : i;
      const close = closingBracket(s, open);
      const m = close > 0 && s[close + 1] === '(' ? /^\(([^)]*)\)/.exec(s.slice(close + 1)) : null;
      if (!m) {
        out += escapeHtml(c);
        i++;
        continue;
      }
      const label = s.slice(open + 1, close);
      const url = safeUrl(m[1], linkBase, image ? 'image' : 'link');
      if (image) {
        const alt = plainOf(inline(label, linkBase));
        out += url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">` : escapeHtml(alt);
      } else if (url) {
        const external = /^https?:/i.test(url);
        out += `<a href="${escapeHtml(url)}"${external ? ' rel="noopener noreferrer"' : ''}>${inline(label, linkBase)}</a>`;
      } else {
        out += inline(label, linkBase);
      }
      i = close + 1 + m[0].length;
    } else if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        out += `<strong>${inline(s.slice(i + 2, end), linkBase)}</strong>`;
        i = end + 2;
      } else {
        out += '**';
        i += 2;
      }
    } else if (c === '*' && s[i + 1] && !/\s/.test(s[i + 1])) {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1 && !/\s/.test(s[end - 1])) {
        out += `<em>${inline(s.slice(i + 1, end), linkBase)}</em>`;
        i = end + 1;
      } else {
        out += '*';
        i++;
      }
    } else {
      out += escapeHtml(c);
      i++;
    }
  }
  return out;
}

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)(-|\d+\.)\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const splitRow = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
};

const startsBlock = (line, next) =>
  !line.trim() || FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || /^\s*>/.test(line)
  || (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));

export function renderMarkdown(src, { linkBase = '/docs/', imageBase: images = null } = {}) {
  imageBase = images;
  // Comments go before parsing, but never inside fenced code.
  const lines = [];
  let fenced = false;
  let inComment = false;
  for (const raw of String(src).replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw;
    if (!fenced) {
      if (inComment) {
        const end = line.indexOf('-->');
        if (end < 0) continue;
        inComment = false;
        line = line.slice(end + 3);
      }
      line = line.replace(/<!--[\s\S]*?-->/g, '');
      const open = line.indexOf('<!--');
      if (open >= 0) {
        inComment = true;
        line = line.slice(0, open);
      }
    }
    if (FENCE.test(raw)) fenced = !fenced;
    lines.push(line);
  }

  let title = '';
  const headings = [];
  const text = [];
  const used = new Set();
  const uniqueId = (base) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const inl = (s) => inline(s, linkBase);

  function renderList(items, ordered) {
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${items.map((it) => {
      const body = inl(it.text);
      text.push(plainOf(body));
      const kids = it.children.length ? renderList(it.children, it.childOrdered) : '';
      return `<li>${body}${kids}</li>`;
    }).join('')}</${tag}>`;
  }

  function renderBlocks(ls) {
    const html = [];
    let i = 0;
    while (i < ls.length) {
      const line = ls[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < ls.length && !FENCE.test(ls[i])) body.push(ls[i++]);
        i++;
        const lang = fence[1].trim().replace(/[^\w-]/g, '');
        html.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
        text.push(body.join('\n'));
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        const level = heading[1].length;
        const body = inl(heading[2]);
        const plain = plainOf(body);
        text.push(plain);
        i++;
        if (level === 1 && !title) {
          title = plain;
          html.push(`<h1>${body}</h1>`);
        } else {
          const lvl = Math.max(level, 2);
          const id = uniqueId(slugify(plain));
          headings.push({ level: lvl, text: plain, id });
          html.push(`<h${lvl} id="${id}">${body} <a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${lvl}>`);
        }
        continue;
      }
      if (/^\s*>/.test(line)) {
        const inner = [];
        while (i < ls.length && /^\s*>/.test(ls[i])) inner.push(ls[i++].replace(/^\s*> ?/, ''));
        html.push(`<blockquote>${renderBlocks(inner)}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < ls.length && TABLE_SEP.test(ls[i + 1]) && ls[i + 1].includes('-')) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < ls.length && ls[i].trim() && ls[i].includes('|')) rows.push(splitRow(ls[i++]));
        const cell = (tag, c) => {
          const body = inl(c);
          text.push(plainOf(body));
          return `<${tag}>${body}</${tag}>`;
        };
        const thead = `<thead><tr>${head.map((c) => cell('th', c)).join('')}</tr></thead>`;
        const tbody = `<tbody>${rows.map((r) => `<tr>${head.map((_, n) => cell('td', r[n] ?? '')).join('')}</tr>`).join('')}</tbody>`;
        html.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
        continue;
      }
      const first = LIST_ITEM.exec(line);
      if (first) {
        const ordered = first[2] !== '-';
        const items = [];
        while (i < ls.length) {
          const m = LIST_ITEM.exec(ls[i]);
          if (m) {
            if (m[1].length >= 2 && items.length) {
              const parent = items[items.length - 1];
              if (!parent.children.length) parent.childOrdered = m[2] !== '-';
              parent.children.push({ text: m[3], children: [] });
            } else {
              items.push({ text: m[3], children: [], childOrdered: false });
            }
            i++;
          } else if (ls[i].trim() && /^\s{2,}\S/.test(ls[i]) && items.length) {
            const parent = items[items.length - 1];
            const last = parent.children.length ? parent.children[parent.children.length - 1] : parent;
            last.text += ` ${ls[i].trim()}`;
            i++;
          } else {
            break;
          }
        }
        html.push(renderList(items, ordered));
        continue;
      }
      const para = [line.trim()];
      i++;
      while (i < ls.length && !startsBlock(ls[i], ls[i + 1])) para.push(ls[i++].trim());
      const body = inl(para.join(' '));
      text.push(plainOf(body));
      html.push(`<p>${body}</p>`);
    }
    return html.join('\n');
  }

  const html = renderBlocks(lines);
  return { title, html, headings, text: text.join('\n') };
}
