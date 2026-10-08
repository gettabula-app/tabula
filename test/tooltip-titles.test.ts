import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shortcutKeys } from '../src/shortcuts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Controls name themselves with aria-label and open the shared tooltip from data-tip (see src/ui/tooltip.ts), never a native
// title, so two tooltips never show. The exceptions below are explanations on disabled text buttons and selects: disabled
// controls get no pointer events in some browsers, so only a native title can say why they are disabled.
const INTERACTIVE = new Set(['button', 'a', 'select', 'input', 'textarea', 'label']);

const ALLOWED_PROPS: { file: string; snippet: string }[] = [
  { file: 'src/ui/history.ts', snippet: 'title: off ? lockedText() : null' },
  { file: 'src/ui/history.ts', snippet: 'title: !mutable() ? lockedText() : null' },
  { file: 'src/ui/history.ts', snippet: 'title: block?.message ?? null' },
  { file: 'src/ui/tokens.ts', snippet: 'title: opts.title' },
  { file: 'src/ui/admin.ts', snippet: 'title: opts.title' },
  { file: 'src/ui/admin.ts', snippet: 'title: lock.reason' },
];

// Assignments to an element's title: the same disabled explanations, and the workspace banner's full text when it is cut off.
const ALLOWED_ASSIGNMENTS: { file: string; snippet: string }[] = [
  { file: 'src/ui/admin.ts', snippet: 'button.title = opts.title' },
  { file: 'src/ui/admin.ts', snippet: 'button.title = armedLabel' },
  { file: 'src/ui/workspace.ts', snippet: "el.title = text ?? ''" },
];

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

// The scanners below read TypeScript as text. They skip strings, template literals (nested ones too) and comments.
function skipString(src: string, from: number): number {
  const quote = src[from];
  let i = from + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === quote) return i + 1;
    else if (quote === '`' && c === '$' && src[i + 1] === '{') i = skipBraces(src, i + 1);
    else i++;
  }
  return i;
}

function skipComment(src: string, from: number): number {
  if (src[from] !== '/') return from;
  if (src[from + 1] === '/') {
    const end = src.indexOf('\n', from);
    return end < 0 ? src.length : end;
  }
  if (src[from + 1] === '*') {
    const end = src.indexOf('*/', from + 2);
    return end < 0 ? src.length : end + 2;
  }
  return from;
}

function skipBraces(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    const after = skipComment(src, i);
    if (after !== i) {
      i = after;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

/** The comma-separated entries at the top level of the object literal opening at `open`. */
function topLevelEntries(src: string, open: number): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = open + 1;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    const after = skipComment(src, i);
    if (after !== i) {
      i = after;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) {
        entries.push(src.slice(start, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      entries.push(src.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  return entries.map((e) => squash(e.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, ''))).filter(Boolean);
}

const KEY = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\s*(?::|$)/;
const keyOf = (entry: string) => {
  const m = KEY.exec(entry);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

interface Hit {
  where: string;
  snippet: string;
}

/** Controls built with h('button' | 'a' | ...) that pass a title among their props. */
function titledControls(src: string, file: string): Hit[] {
  const hits: Hit[] = [];
  for (const call of src.matchAll(/\bh\(\s*'(\w+)'\s*,\s*\{/g)) {
    if (!INTERACTIVE.has(call[1])) continue;
    const open = (call.index ?? 0) + call[0].length - 1;
    for (const entry of topLevelEntries(src, open)) {
      if (keyOf(entry) === 'title') hits.push({ where: `${file}:${lineOf(src, call.index ?? 0)} h('${call[1]}')`, snippet: entry });
    }
  }
  return hits;
}

/** `x.title = ...` on anything but the document, and setAttribute('title', ...) or title="..." anywhere. */
function titleWrites(src: string, file: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of src.matchAll(/(?<![\w$.])((?:[\w$]+)(?:\.[\w$]+)*)\.title\s*=(?!=)[^;\n]*/g)) {
    if (m[1] === 'document') continue;
    hits.push({ where: `${file}:${lineOf(src, m.index ?? 0)} assignment`, snippet: squash(m[0]) });
  }
  for (const m of src.matchAll(/setAttribute\(\s*['"]title['"]|\btitle=["']/g)) {
    hits.push({ where: `${file}:${lineOf(src, m.index ?? 0)} attribute`, snippet: squash(m[0]) });
  }
  return hits;
}

const rel = (file: string) => relative(ROOT, file).replaceAll('\\', '/');
const allowed = (list: { file: string; snippet: string }[], file: string, snippet: string) =>
  list.some((a) => a.file === file && squash(a.snippet) === squash(snippet));

describe('native titles on controls', () => {
  const files = sourceFiles(join(ROOT, 'src'));

  it('are not used on buttons, links or form controls outside the allowlist', () => {
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap((f) => {
      const file = rel(f);
      return titledControls(readFileSync(f, 'utf8'), file).filter((h) => !allowed(ALLOWED_PROPS, file, h.snippet));
    });
    expect(bad.map((h) => `${h.where} ${h.snippet}`)).toEqual([]);
  });

  it('are not assigned, set as an attribute or written as HTML outside the allowlist', () => {
    const bad = files.flatMap((f) => {
      const file = rel(f);
      return titleWrites(readFileSync(f, 'utf8'), file).filter((h) => !allowed(ALLOWED_ASSIGNMENTS, file, h.snippet));
    });
    expect(bad.map((h) => `${h.where} ${h.snippet}`)).toEqual([]);
  });

  it('keep every allowlist entry in use, so a fixed title leaves the list', () => {
    const props = files.flatMap((f) => titledControls(readFileSync(f, 'utf8'), rel(f)).map((h) => ({ file: rel(f), snippet: h.snippet })));
    const writes = files.flatMap((f) => titleWrites(readFileSync(f, 'utf8'), rel(f)).map((h) => ({ file: rel(f), snippet: h.snippet })));
    expect(ALLOWED_PROPS.filter((a) => !props.some((p) => allowed([a], p.file, p.snippet)))).toEqual([]);
    expect(ALLOWED_ASSIGNMENTS.filter((a) => !writes.some((p) => allowed([a], p.file, p.snippet)))).toEqual([]);
  });

  it('name only shortcuts that the shortcuts dialog lists', () => {
    const ids = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/'data-tip-key':\s*'([^']+)'/g)].map((m) => m[1]));
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.filter((id) => shortcutKeys(id) === undefined)).toEqual([]);
  });
});

describe('the title scanner', () => {
  const scan = (src: string) => titledControls(src, 'x.ts').map((h) => h.snippet);

  it('finds a title among the props of a button, however the props are written', () => {
    expect(scan("h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close' })")).toEqual(["title: 'Close'"]);
    expect(scan("h('button', { class: `icon-btn${on ? ` x` : ''}`, title, onclick: () => { go({ a: 1 }); } }, icon('x'))")).toEqual(['title']);
    expect(scan("h('a', {\n  href: '#/', // it's here\n  'title': `Go ${n}`,\n})")).toEqual(['\'title\': `Go ${n}`']);
    expect(scan("h('select', { 'aria-label': 'Role', disabled: !ok, title: lock.reason })")).toEqual(['title: lock.reason']);
  });

  it('leaves titles that are not control tooltips alone', () => {
    expect(scan("h('div', { class: 'muted', title: m.email }, m.email)")).toEqual([]);
    expect(scan("h('button', { class: 'btn', style: { title: 1 }, onclick: () => save({ title: t }) }, 'Save')")).toEqual([]);
    expect(scan("h('button', { class: 'btn', 'data-tip': 'Title: untitled', 'aria-label': `title: ${x}` }, 'Save')")).toEqual([]);
    expect(scan("dialog('Save as template', h('div', null), [{ title: 'x' }])")).toEqual([]);
  });

  it('finds assignments, attributes and HTML titles but not the document title', () => {
    const writes = (src: string) => titleWrites(src, 'x.ts').map((h) => h.snippet);
    expect(writes("document.title = 'Admin';\nbutton.title = 'x';")).toEqual(["button.title = 'x'"]);
    expect(writes("el.setAttribute('title', 'x')")).toHaveLength(1);
    expect(writes('const html = `<button title="x">`;')).toHaveLength(1);
    expect(writes("if (a.title === b.title) go();")).toEqual([]);
  });
});
