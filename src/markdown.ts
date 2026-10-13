// Markdown for the board's Markdown block (TAB-140): a parser with a strict allow-list. Pure (no DOM, no measuring), so the server tests and the client share it.
//
// What exists: headings, paragraphs, bold, italic, strikethrough, inline code, fenced code, quotes, bullet / numbered / task lists, links, tables (GFM), horizontal
// rules and picture references into the board's own asset store. What does not, on purpose: raw HTML (it is shown as the text it is), remote images, scripts,
// iframes, embeds, footnotes, definitions, setext headings and indented code. A link is kept only when its address is http(s), mailto: or a board item
// (#obj:<id>); anything else (javascript:, data:, a relative path) is dropped and its text stays as plain text.

export const MD_MAX_SOURCE = 20_000;
const MAX_DEPTH = 6;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_ROWS = 200;
const INLINE_BUDGET = 40_000;

export type Align = 'left' | 'center' | 'right' | null;

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'code'; s: string }
  | { t: 'link'; href: string; kind: 'web' | 'mail' | 'obj'; c: Inline[] }
  | { t: 'image'; alt: string; asset: string }
  | { t: 'br' };

export interface ListItem {
  /** 'open' / 'done' for a task item; null for a plain one. */
  task: 'open' | 'done' | null;
  /** The index of the source line that holds the item's marker (the task box is toggled there). */
  line: number;
  blocks: Block[];
}

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'code'; lang: string; s: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

// ---------------------------------------------------------------------------------------------------------------- links

const OBJ_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_HASH = /^[a-f0-9]{64}$/;

function hasControlOrSpace(h: string): boolean {
  for (let i = 0; i < h.length; i++) {
    const c = h.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0xa0 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** The kind of address a link may have, or null when it must not become a link. */
export function linkKind(href: string): 'web' | 'mail' | 'obj' | null {
  const h = href.trim();
  if (h.length === 0 || h.length > 2000 || hasControlOrSpace(h)) return null;
  if (/^https?:\/\/[^/?#\s]+/i.test(h)) {
    try {
      const u = new URL(h);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' ? 'web' : null;
    } catch {
      return null;
    }
  }
  if (/^mailto:[^\s@<>]+@[^\s@<>]+$/i.test(h)) return 'mail';
  if (h.startsWith('#obj:') && OBJ_ID.test(h.slice(5))) return 'obj';
  return null;
}

// -------------------------------------------------------------------------------------------------------------- inline

interface Cursor {
  budget: number;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>"'<&]/;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/u.test(ch);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** The index just past the `)` that closes a link address starting at `from` (just after the `(`), allowing balanced parentheses; -1 when there is none. */
function closeParen(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
    else if (ch === '\n') return -1;
  }
  return -1;
}

/** The index just past the `]` that closes a link text starting at `from` (just after the `[`), allowing nested brackets; -1 when there is none. */
function closeBracket(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

function pushText(out: Inline[], s: string): void {
  if (!s) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.s += s;
  else out.push({ t: 'text', s });
}

/** Finds the closing delimiter `d` for an emphasis that opened at `from`: not preceded by a space, not escaped, outside inline code. -1 when there is none. */
function findCloser(s: string, from: number, d: string, cur: Cursor): number {
  for (let i = from; i < s.length; i++) {
    if (--cur.budget < 0) return -1;
    const ch = s[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i, i + 20))![0];
      const end = s.indexOf(run, i + run.length);
      if (end >= 0) i = end + run.length - 1;
      continue;
    }
    if (s.startsWith(d, i) && i > from && !isSpace(s[i - 1])) {
      if (d.length === 1 && s[i + 1] === d) {
        // a single * or _ inside a doubled one belongs to the doubled one
        i++;
        continue;
      }
      if (d === '_' && isWordChar(s[i + 1])) continue;
      return i;
    }
  }
  return -1;
}

function parseInline(s: string, depth: number, cur: Cursor): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, s);
    return out;
  }
  let i = 0;
  let plain = '';
  const flush = () => {
    pushText(out, plain);
    plain = '';
  };
  while (i < s.length) {
    if (--cur.budget < 0) {
      plain += s.slice(i);
      break;
    }
    const ch = s[i];
    if (ch === '\\') {
      if (s[i + 1] === '\n') {
        flush();
        out.push({ t: 'br' });
        i += 2;
      } else if (i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
        plain += s[i + 1];
        i += 2;
      } else {
        plain += ch;
        i++;
      }
      continue;
    }
    if (ch === '\n') {
      // two spaces before the line end make a hard break; any other line end is a space
      if (/ {2,}$/.test(plain)) {
        plain = plain.replace(/ +$/, '');
        flush();
        out.push({ t: 'br' });
      } else {
        plain = plain.replace(/ +$/, '') + ' ';
      }
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i, i + 20))![0];
      const end = s.indexOf(run, i + run.length);
      if (end >= 0 && run.length <= 3) {
        flush();
        let code = s.slice(i + run.length, end).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
        out.push({ t: 'code', s: code });
        i = end + run.length;
        continue;
      }
      plain += run;
      i += run.length;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const close = closeBracket(s, i + 2);
      if (close >= 0 && s[close + 1] === '(') {
        const end = closeParen(s, close + 2);
        if (end >= 0) {
          const target = s.slice(close + 2, end).trim().split(/\s+/)[0] ?? '';
          const alt = s.slice(i + 2, close);
          // only a picture already in the board's asset store: asset:<sha-256>; never an address on the internet
          if (target.startsWith('asset:') && ASSET_HASH.test(target.slice(6))) {
            flush();
            out.push({ t: 'image', alt: alt.replace(/[\n\\*_`[\]]/g, ' ').slice(0, 200), asset: target.slice(6) });
          } else {
            pushText(out, alt ? `[image: ${alt.replace(/\n/g, ' ')}]` : '[image]');
          }
          i = end + 1;
          continue;
        }
      }
      plain += ch;
      i++;
      continue;
    }
    if (ch === '[') {
      const close = closeBracket(s, i + 1);
      if (close >= 0 && s[close + 1] === '(') {
        const end = closeParen(s, close + 2);
        if (end >= 0) {
          const target = s.slice(close + 2, end).trim().split(/\s+/)[0] ?? '';
          const label = s.slice(i + 1, close);
          const kind = linkKind(target.replace(/\\(.)/g, '$1'));
          flush();
          const inner = parseInline(label, depth + 1, cur);
          if (kind && !JSON.stringify(inner).includes('"t":"link"')) out.push({ t: 'link', href: target.replace(/\\(.)/g, '$1'), kind, c: inner });
          else out.push(...inner);
          i = end + 1;
          continue;
        }
      }
      plain += ch;
      i++;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = /^[*_~]+/.exec(s.slice(i, i + 8))![0];
      const prev = s[i - 1];
      const marker = ch === '~' ? '~~' : run.length >= 2 ? ch + ch : ch;
      const opens = ch === '~' ? run.length >= 2 && !isSpace(s[i + 2]) : !isSpace(s[i + marker.length]) && !(ch === '_' && isWordChar(prev));
      if (opens && (ch !== '~' || run.length >= 2)) {
        const close = findCloser(s, i + marker.length, marker, cur);
        if (close > i + marker.length - 1 && close > i + marker.length) {
          flush();
          const kids = parseInline(s.slice(i + marker.length, close), depth + 1, cur);
          out.push({ t: ch === '~' ? 'del' : marker.length === 2 ? 'strong' : 'em', c: kids });
          i = close + marker.length;
          continue;
        }
      }
      plain += run;
      i += run.length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

export function parseInlineText(s: string): Inline[] {
  return parseInline(s, 0, { budget: INLINE_BUDGET });
}

// --------------------------------------------------------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?/;
const LIST_MARK = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TABLE_DELIM_CELL = /^\s*:?-{1,}:?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const isTableDelimiter = (line: string): boolean => line.includes('-') && line.includes('|') !== false && splitRow(line).every((c) => TABLE_DELIM_CELL.test(c));

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HR.test(line) || (HEADING.test(line) && /^ {0,3}#/.test(line)) || QUOTE.test(line) || LIST_MARK.test(line);
}

function parseBlocks(lines: string[], base: number, depth: number, cur: Cursor): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (depth > MAX_DEPTH) {
      blocks.push({ t: 'para', c: parseInline(lines.slice(i).join('\n'), depth, cur) });
      break;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && /^[`~]+\s*$/.test(lines[i].trim()))) body.push(lines[i++]);
      i++; // the closing fence (an unclosed block runs to the end)
      blocks.push({ t: 'code', lang: fence[2].slice(0, 30), s: body.join('\n') });
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    const heading = /^ {0,3}#/.test(line) ? HEADING.exec(line) : null;
    if (heading) {
      blocks.push({ t: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline((heading[2] ?? '').trim(), depth, cur) });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() !== '' && inner.length > 0 && !startsBlock(lines[i])))) {
        inner.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      blocks.push({ t: 'quote', blocks: parseBlocks(inner, base + i - inner.length, depth + 1, cur) });
      continue;
    }
    const mark = LIST_MARK.exec(line);
    if (mark) {
      const ordered = /\d/.test(mark[2]);
      const start = ordered ? Number.parseInt(mark[2], 10) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_MARK.exec(lines[i]);
        if (!m || /\d/.test(m[2]) !== ordered || HR.test(lines[i])) break;
        const indent = m[1].length + m[2].length + Math.min(4, Math.max(1, m[3].length || 1));
        const first = lines[i].slice(m[0].length);
        const itemLine = base + i;
        const body: string[] = [first];
        i++;
        let blank = 0;
        while (i < lines.length) {
          const next = lines[i];
          if (next.trim() === '') {
            blank++;
            body.push('');
            i++;
            continue;
          }
          const lead = /^ */.exec(next)![0].length;
          if (lead >= indent) {
            blank = 0;
            body.push(next.slice(indent));
            i++;
          } else if (blank === 0 && !startsBlock(next)) {
            body.push(next.trim()); // a lazy continuation of the item's paragraph
            i++;
          } else break;
        }
        while (body.length && body[body.length - 1] === '') body.pop();
        let task: 'open' | 'done' | null = null;
        const taskMark = /^\[( |x|X)\](?:[ \t]+|$)/.exec(body[0]);
        if (taskMark) {
          task = taskMark[1] === ' ' ? 'open' : 'done';
          body[0] = body[0].slice(taskMark[0].length);
        }
        items.push({ task, line: itemLine, blocks: parseBlocks(body, itemLine, depth + 1, cur) });
        if (items.length >= 500) break;
      }
      blocks.push({ t: 'list', ordered, start, items });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]);
      if (head.length === delim.length && head.length <= MAX_TABLE_COLUMNS) {
        const align: Align[] = delim.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
        const rows: Inline[][][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && rows.length < MAX_TABLE_ROWS) {
          const cells = splitRow(lines[i]);
          rows.push(head.map((_, c) => parseInline(cells[c] ?? '', depth + 1, cur)));
          i++;
        }
        blocks.push({ t: 'table', align, head: head.map((c) => parseInline(c, depth + 1, cur)), rows });
        continue;
      }
    }
    const para: string[] = [line.trimStart()];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1]))) {
      para.push(lines[i].trimStart());
      i++;
    }
    blocks.push({ t: 'para', c: parseInline(para.join('\n'), depth, cur) });
  }
  return blocks;
}

/** The blocks of a Markdown source. Never throws; a source longer than MD_MAX_SOURCE is read up to that length. */
export function parseMarkdown(src: string): Block[] {
  const text = (src ?? '').slice(0, MD_MAX_SOURCE).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  return parseBlocks(text.split('\n'), 0, 0, { budget: INLINE_BUDGET });
}

// ------------------------------------------------------------------------------------------------------------- helpers

/** The plain text of inline content (for names, descriptions and the like). */
export function inlineText(c: Inline[]): string {
  let out = '';
  for (const n of c) {
    if (n.t === 'text' || n.t === 'code') out += n.s;
    else if (n.t === 'br') out += ' ';
    else if (n.t === 'image') out += n.alt;
    else out += inlineText(n.c);
  }
  return out;
}

/** Flips the task box on one source line: `[ ]` to `[x]` and back. Returns the source unchanged when that line has no task box. */
export function toggleTask(src: string, line: number): string {
  const text = src.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const l = lines[line];
  if (l === undefined) return src;
  const m = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[( |x|X)\](?=[ \t]|$)/.exec(l);
  if (!m) return src;
  const at = m[1].length;
  lines[line] = l.slice(0, at) + (m[2] === ' ' ? '[x]' : '[ ]') + l.slice(at + 3);
  return lines.join('\n');
}

function titleOf(blocks: Block[]): string {
  for (const b of blocks) {
    let text = '';
    if (b.t === 'heading' || b.t === 'para') text = inlineText(b.c);
    else if (b.t === 'code') text = b.s;
    else if (b.t === 'quote') text = titleOf(b.blocks);
    else if (b.t === 'list') text = b.items.map((i) => titleOf(i.blocks)).find(Boolean) ?? '';
    else if (b.t === 'table') text = b.head.map(inlineText).join(' ');
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

/** A one-line summary of a source for lists and screen readers: the first heading or line, cut at `max` characters. */
export function markdownTitle(src: string, max = 80): string {
  const t = titleOf(parseMarkdown(src));
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function plainOf(blocks: Block[], out: string[]): void {
  for (const b of blocks) {
    if (b.t === 'heading' || b.t === 'para') out.push(inlineText(b.c));
    else if (b.t === 'code') out.push(b.s);
    else if (b.t === 'quote') plainOf(b.blocks, out);
    else if (b.t === 'list') for (const i of b.items) plainOf(i.blocks, out);
    else if (b.t === 'table') {
      out.push(b.head.map(inlineText).join(', '));
      for (const r of b.rows) out.push(r.map(inlineText).join(', '));
    }
  }
}

/** The reading text of a source, without its marks, cut at `max` characters, and how many task boxes it holds and how many of them are ticked. */
export function markdownReading(src: string, max = 600): { text: string; tasks: number; done: number } {
  const blocks = parseMarkdown(src);
  const out: string[] = [];
  plainOf(blocks, out);
  let tasks = 0;
  let done = 0;
  const count = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === 'list') for (const i of b.items) {
        if (i.task) tasks++;
        if (i.task === 'done') done++;
        count(i.blocks);
      } else if (b.t === 'quote') count(b.blocks);
    }
  };
  count(blocks);
  const text = out.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join('. ');
  return { text: text.length > max ? `${text.slice(0, max - 1)}…` : text, tasks, done };
}
