// The pure parts of the code block's UI (docs/code-blocks.md): what Tab, Shift+Tab and Enter do in the editing textarea, the order of the language list,
// the language a new block starts with, whether it wraps, and how far a block that does not wrap can scroll. No DOM here, so every rule is unit-tested.
import { CODE_LANGS, COMMON_CODE_LANGS, DEFAULT_CODE_LANG, MAX_CODE_CHARS, isCodeLang } from '../shared/code-langs.mjs';
import type { CodeLayout } from './code-layout';

export interface Edit {
  value: string;
  start: number;
  end: number;
}

const INDENT = '  ';

/** Start of the line that contains offset `at`. */
const lineStart = (value: string, at: number) => value.lastIndexOf('\n', at - 1) + 1;

/**
 * Tab: with the caret (or a selection inside one line) two spaces are typed; with a selection over several lines every one of them is indented by two.
 * Shift+Tab: up to two leading spaces (or one tab) come off every line the selection touches.
 */
export function tabEdit(value: string, start: number, end: number, shift: boolean): Edit {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(value.length, Math.max(start, end));
  const multi = value.slice(a, b).includes('\n');
  if (!shift && !multi) {
    return { value: value.slice(0, a) + INDENT + value.slice(b), start: a + INDENT.length, end: a + INDENT.length };
  }
  // the lines touched: a selection that ends at the very start of a line does not take that line
  const first = lineStart(value, a);
  const lastAt = b > a && value[b - 1] === '\n' ? b - 1 : b;
  const nl = value.indexOf('\n', lastAt);
  const blockEnd = nl === -1 ? value.length : nl;
  const lines = value.slice(first, blockEnd).split('\n');
  const marks: { pos: number; delta: number }[] = [];
  let pos = first;
  const out = lines.map((line) => {
    let delta = 0;
    let next = line;
    if (shift) {
      const m = /^(?: {1,2}|\t)/.exec(line);
      if (m) {
        delta = -m[0].length;
        next = line.slice(m[0].length);
      }
    } else if (line.length > 0 || lines.length === 1) {
      delta = INDENT.length;
      next = INDENT + line;
    }
    if (delta) marks.push({ pos, delta });
    pos += line.length + 1;
    return next;
  });
  // an offset moves by what changed before it; a caret inside indentation that was taken off goes to the line's start
  const moved = (p: number) => {
    let at = p;
    for (const m of marks) {
      if (m.delta > 0) {
        if (m.pos <= p) at += m.delta;
      } else if (p >= m.pos - m.delta) at += m.delta;
      else if (p > m.pos) at -= p - m.pos;
    }
    return at;
  };
  return { value: value.slice(0, first) + out.join('\n') + value.slice(blockEnd), start: moved(a), end: moved(b) };
}

/** Enter: a new line that starts with the indentation of the line the caret is on (as much of it as is left of the caret). */
export function enterEdit(value: string, start: number, end: number): Edit {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(value.length, Math.max(start, end));
  const from = lineStart(value, a);
  const lead = /^[ \t]*/.exec(value.slice(from, a))?.[0] ?? '';
  const insert = `\n${lead}`;
  return { value: value.slice(0, a) + insert + value.slice(b), start: a + insert.length, end: a + insert.length };
}

/** A paste or a value cut to the limit: the text to keep and whether anything was dropped. */
export function clampCodeText(text: string, max: number = MAX_CODE_CHARS): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

export interface LangRow {
  id: string;
  label: string;
}

/** The picker's order: Plain text, the 12 common languages in their fixed order, then the rest alphabetically by label. */
export function orderedCodeLangs(): LangRow[] {
  const byId = new Map(CODE_LANGS.map((l) => [l.id, l]));
  const head = [DEFAULT_CODE_LANG, ...COMMON_CODE_LANGS].map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l);
  const used = new Set(head.map((l) => l.id));
  const rest = CODE_LANGS.filter((l) => !used.has(l.id)).sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  return [...head, ...rest].map((l) => ({ id: l.id, label: l.label }));
}

/** The languages whose name or id contains what was typed (case ignored); an empty query keeps them all. */
export function filterCodeLangs(rows: readonly LangRow[], query: string): LangRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.label.toLowerCase().includes(q) || r.id.includes(q));
}

// The language a new block starts with is the last one used on this board in this session (a view preference, not board data).
const lastLang = new Map<string, string>();
export function rememberCodeLang(boardId: string, lang: unknown): void {
  if (typeof lang !== 'string' || !isCodeLang(lang)) return;
  if (lastLang.size > 200) lastLang.clear();
  lastLang.set(boardId, lang);
}
export function defaultCodeLang(boardId: string): string {
  return lastLang.get(boardId) ?? DEFAULT_CODE_LANG;
}
export function forgetCodeLangs(): void {
  lastLang.clear();
}

/** A new block wraps on a device whose main pointer is coarse (a phone or tablet), and does not on a mouse or a trackpad. */
export const codeWrapDefault = (coarsePointer: boolean): boolean => coarsePointer;

/** How far (px) the code of a block that does not wrap can be scrolled to the left: the longest line less the width the text may use. */
export function codeMaxScroll(layout: Pick<CodeLayout, 'lines' | 'charW' | 'textW'>, wrap: boolean): number {
  if (wrap) return 0;
  let cols = 0;
  for (const line of layout.lines) {
    const n = /[\ud800-\udfff]/.test(line) ? Array.from(line).length : line.length;
    if (n > cols) cols = n;
  }
  return Math.max(0, Math.ceil(cols * layout.charW - layout.textW));
}
