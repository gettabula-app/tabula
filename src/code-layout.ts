// Layout of a code block (docs/code-blocks.md): pure and O(n). The text is set in a fixed-pitch face, so a row is `columns` characters and there is no
// per-token measuring: the only measurement is the width of one glyph per font size. Tokens (src/code-tokens.ts) never change this geometry.
import { MAX_CODE_CHARS } from '../shared/code-langs.mjs';
import { expandTabs } from './code-tokens';
import { measure, measureEpoch } from './text';

export const CODE_MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
export const CODE = {
  FONT: 13,
  LINE: 1.5,
  TAB: 2,
  PAD_X: 16,
  PAD_Y: 14,
  HEADER: 36,
  GUTTER: 40,
  GUTTER_NUM: 12,
  /** Hanging indent of a wrapped line's continuation rows, in columns. */
  HANG: 2,
  /** Room the header keeps free at its right edge for the controls (wrap toggle, copy). */
  CONTROLS_W: 76,
  /** Text beyond this is not laid out at all (the validator only reports the cap; this keeps a hostile block cheap to draw). */
  DRAW_MAX_CHARS: MAX_CODE_CHARS * 5,
  DEFAULT_W: 520,
  MIN_W: 160,
} as const;

export type MeasureGlyphs = (sample: string, font: string) => number;

const widthCache = new Map<number, { epoch: number; w: number }>();
const SAMPLE = 'M'.repeat(64);

/** The width of one character of the code face at `size`px: one measurement of a 64-glyph run per size, cached until the fonts change. */
export function codeCharWidth(size: number = CODE.FONT, measureFn?: MeasureGlyphs): number {
  if (measureFn) return Math.max(1, measureFn(SAMPLE, `400 ${size}px ${CODE_MONO}`) / SAMPLE.length);
  const epoch = measureEpoch();
  const hit = widthCache.get(size);
  if (hit && hit.epoch === epoch) return hit.w;
  const w = Math.max(1, measure(SAMPLE, `400 ${size}px ${CODE_MONO}`) / SAMPLE.length);
  widthCache.set(size, { epoch, w });
  return w;
}

export interface CodeLayoutInput {
  text?: unknown;
  title?: unknown;
  lines?: unknown;
  wrap?: unknown;
  w: number;
}

export interface CodeRow {
  /** Index of the logical line (0-based). */
  line: number;
  /** Code-point offset of this row's first character in the line's expanded text. */
  col: number;
  /** Code points the row shows (the text of the row is `[...line].slice(col, col + len)`). */
  len: number;
  text: string;
  /** Top of the row, relative to the top of the code area. */
  y: number;
  /** The first row of its line: the one that carries the line number. */
  first: boolean;
  /** Left indent in columns (the hanging indent of a continuation row). */
  indent: number;
}

export interface CodeLayout {
  /** The expanded text of every logical line (CRLF to LF, tabs expanded). */
  lines: string[];
  rows: CodeRow[];
  hasHeader: boolean;
  headerH: number;
  showLines: boolean;
  gutterW: number;
  /** Left edge of the code text, relative to the card. */
  textX: number;
  /** Width the code text may use. */
  textW: number;
  cols: number;
  charW: number;
  lineH: number;
  /** Top of the first row, relative to the card. */
  top: number;
  /** The text is longer than MAX_CODE_CHARS: plain text and a quiet note. */
  long: boolean;
  /** Top of the note row (relative to the card) when `long`, else null. */
  noteY: number | null;
  height: number;
}

const LF = /\r\n?/g;

/** The gutter's width: 40px, wider once the numbers need more than four digits. */
export function gutterWidth(lineCount: number): number {
  const digits = String(Math.max(1, lineCount)).length;
  return digits <= 4 ? CODE.GUTTER : CODE.GUTTER + (digits - 4) * 8;
}

/** Splits a code text into logical lines the way every consumer needs them: CRLF/CR to LF, tabs expanded. */
export function codeLines(text: string): string[] {
  const t = text.length > CODE.DRAW_MAX_CHARS ? text.slice(0, CODE.DRAW_MAX_CHARS) : text;
  return t.replace(LF, '\n').split('\n').map((l) => expandTabs(l, CODE.TAB));
}

export function layoutCode(input: CodeLayoutInput, opts: { charW?: number } = {}): CodeLayout {
  const text = typeof input.text === 'string' ? input.text : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const w = Number.isFinite(input.w) ? input.w : CODE.DEFAULT_W;
  const charW = opts.charW ?? codeCharWidth();
  const lineH = CODE.FONT * CODE.LINE;
  const lines = codeLines(text);
  const hasHeader = title.length > 0;
  const headerH = hasHeader ? CODE.HEADER : 0;
  const showLines = input.lines === true;
  const gutterW = showLines ? gutterWidth(lines.length) : 0;
  const textX = gutterW + CODE.PAD_X;
  const textW = Math.max(charW, w - textX - CODE.PAD_X);
  const cols = Math.max(1, Math.floor(textW / charW));
  const wrap = input.wrap === true;
  const top = headerH + CODE.PAD_Y;
  const rows: CodeRow[] = [];
  let y = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ASCII lines (nearly all code) are cut by index; others by code point
    const ascii = !/[\ud800-\udfff]/.test(line);
    const cps = ascii ? null : Array.from(line);
    const total = cps ? cps.length : line.length;
    const part = (a: number, b: number) => (cps ? cps.slice(a, b).join('') : line.slice(a, b));
    if (!wrap || total <= cols) {
      rows.push({ line: i, col: 0, len: total, text: line, y, first: true, indent: 0 });
      y += lineH;
      continue;
    }
    let col = 0;
    let first = true;
    while (col < total) {
      const indent = first ? 0 : Math.min(CODE.HANG, cols - 1);
      const take = Math.max(1, cols - indent);
      rows.push({ line: i, col, len: Math.min(take, total - col), text: part(col, col + take), y, first, indent });
      y += lineH;
      col += take;
      first = false;
    }
  }
  const long = text.length > MAX_CODE_CHARS;
  const noteY = long ? top + y + 4 : null;
  const bodyH = y + (long ? lineH + 4 : 0);
  return { lines, rows, hasHeader, headerH, showLines, gutterW, textX, textW, cols, charW, lineH, top, long, noteY, height: Math.ceil(top + bodyH + CODE.PAD_Y) };
}

/** The height a code block needs for its text at its current width (the app, the editor and the height heal fit the object to it). */
export function codeBoxHeight(o: CodeLayoutInput, width: number = o.w, opts?: { charW?: number }): number {
  return layoutCode({ ...o, w: width }, opts).height;
}

/** Fields of a new, empty code block (the creation tool spreads them into the object). */
export function newCodeFields(text = ''): { text: string; lang: 'plaintext'; lines: false; wrap: false; w: number; h: number } {
  return { text, lang: 'plaintext', lines: false, wrap: false, w: CODE.DEFAULT_W, h: codeBoxHeight({ text, w: CODE.DEFAULT_W }) };
}
