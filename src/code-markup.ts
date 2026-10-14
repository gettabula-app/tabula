// The SVG of a code block (docs/code-blocks.md): a card, an optional header, a line-number gutter and the code as <text>/<tspan fill>. No foreignObject:
// the canvas, the PNG/SVG exports and the print all take this markup. Tokens come from the highlighter (src/code-tokens.ts) when it has them for exactly
// this text; otherwise every line is one plain run, same geometry.
import { codeLangLabel } from '../shared/code-langs.mjs';
import { CODE, CODE_MONO, layoutCode, type CodeLayout } from './code-layout';
import { CODE_STRINGS, codeAccessibleName } from './code-strings';
import type { CodeLines, CodeToken } from './code-tokens';
import { fontFamily } from './fonts';
import { escapeXml } from './text';
import type { BaseObj } from './types';

const n = (v: number) => Math.round(v * 100) / 100;
const INK = 'var(--ink, #111111)';
const PAPER = 'var(--paper, #FFFFFF)';
const EDGE = 'color-mix(in srgb, var(--ink, #111111) 22%, var(--paper, #FFFFFF))';
const RULE = 'var(--tray-line, rgba(17,17,17,0.08))';
const GRAPHITE = 'var(--graphite, #65635F)';

// The seam the highlighter and the UI register (docs/code-blocks.md): the markup asks for the tokens of a block and the highlighter says when new ones arrived.
export type CodeTokenSource = (o: BaseObj) => CodeLines | null;
let tokenSource: CodeTokenSource = () => null;
let repaint: () => void = () => {};
/** Registers where the drawing code gets a block's tokens (must answer from a cache, synchronously, for exactly the block's current text and language). */
export const setCodeTokenSource = (fn: CodeTokenSource | null): void => { tokenSource = fn ?? (() => null); };
export const getCodeTokens: CodeTokenSource = (o) => tokenSource(o);
/** Registers the function that repaints code blocks (the renderer's); the highlighter calls `requestRepaint()` when tokens for a block arrived. */
export const setCodeRepaint = (fn: (() => void) | null): void => { repaint = fn ?? (() => {}); };
export const requestRepaint = (): void => repaint();

const hasSurrogates = (s: string) => /[\ud800-\udfff]/.test(s);

/** Cuts runs to the code points [from, to) of their line. */
export function sliceTokens(tokens: readonly CodeToken[], from: number, to: number): CodeToken[] {
  const out: CodeToken[] = [];
  let pos = 0;
  for (const tk of tokens) {
    if (pos >= to) break;
    const wide = hasSurrogates(tk.t);
    const len = wide ? Array.from(tk.t).length : tk.t.length;
    const end = pos + len;
    if (end > from && len > 0) {
      const a = Math.max(from, pos) - pos, b = Math.min(to, end) - pos;
      const t = a === 0 && b === len ? tk.t : (wide ? Array.from(tk.t).slice(a, b).join('') : tk.t.slice(a, b));
      out.push(t === tk.t ? tk : { ...tk, t });
    }
    pos = end;
  }
  return out;
}

/** Tokens usable for this layout: same number of lines, and the runs of each line put together are the line's text. Anything else is stale and ignored. */
function usable(tokens: CodeLines | null, lines: readonly string[]): CodeLines | null {
  if (!tokens || tokens.length !== lines.length) return null;
  for (let i = 0; i < lines.length; i++) {
    const runs = tokens[i];
    if (!Array.isArray(runs)) return null;
    let s = '';
    for (const r of runs) s += typeof r?.t === 'string' ? r.t : '\u0000';
    if (s !== lines[i]) return null;
  }
  return tokens;
}

// a colour from the highlighter goes into an attribute: only plain colour syntax passes
const COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/-]{1,48}\)|color-mix\([0-9a-zA-Z%.,\s()#-]{1,120}\)|var\(--[a-z0-9-]{1,32}(?:,\s*#[0-9a-fA-F]{3,8})?\))$/;
const safeFill = (c: string | null | undefined) => (typeof c === 'string' && COLOR_RE.test(c) ? c : null);

const cpLen = (s: string) => (hasSurrogates(s) ? Array.from(s).length : s.length);

/**
 * The runs of one row as <tspan>s, each at an explicit x (its character column times the character width). Nothing depends on how a renderer treats
 * whitespace: spaces between runs, runs of two or more spaces and the leading spaces of a run become a gap in x instead of characters (a renderer that
 * collapses spaces, as Chromium does for SVG text whatever xml:space says, then draws the same columns). They also stay as trailing spaces of the run
 * before, so the text of a row still reads as the line (only the line's own leading spaces are left out). `white-space: pre` and xml:space on the <text>
 * keep them as well where they are honoured.
 */
export function runs(row: readonly CodeToken[], x0: number, charW: number): string {
  const segs: Array<{ col: number; text: string; tk: CodeToken }> = [];
  let col = 0;
  let pending = 0; // spaces since the last run: a gap in x, and (so the text still reads as the line) trailing spaces of the run before
  for (const tk of row) {
    if (!tk.t) continue;
    for (const part of tk.t.split(/( {2,})/)) {
      if (!part) continue;
      if (/^ {2,}$/.test(part)) { col += part.length; pending += part.length; continue; }
      const lead = part.length - part.trimStart().length;
      col += lead;
      pending += lead;
      const text = part.slice(lead);
      if (!text) continue;
      if (pending > 0 && segs.length) segs[segs.length - 1].text += ' '.repeat(pending);
      pending = 0;
      segs.push({ col, text, tk });
      col += cpLen(text);
    }
  }
  if (pending > 0 && segs.length) segs[segs.length - 1].text += ' '.repeat(pending);
  let out = '';
  for (const { col: c, text, tk } of segs) {
    const fill = safeFill(tk.c);
    const attrs = `${fill ? ` fill="${escapeXml(fill)}"` : ''}${tk.b ? ' font-weight="700"' : ''}${tk.i ? ' font-style="italic"' : ''}`;
    out += `<tspan x="${n(x0 + c * charW)}"${attrs}>${escapeXml(text)}</tspan>`;
  }
  return out;
}

/** The inner markup of a code block in its own box frame (the caller adds the translate/rotate group). `tokens` null draws plain ink. */
export function codeMarkup(o: BaseObj, layout: CodeLayout = layoutCode(o), tokens: CodeLines | null = null, opts: { editing?: boolean; scrollX?: number } = {}): string {
  const L = layout;
  const w = n(o.w);
  const family = escapeXml(CODE_MONO);
  const ui = escapeXml(fontFamily(o.font));
  let out = `<g class="code-block" role="region" aria-label="${escapeXml(codeAccessibleName(o))}">`;
  out += `<rect class="code-card" x="0.5" y="0.5" width="${n(o.w - 1)}" height="${n(o.h - 1)}" rx="12" fill="${PAPER}" stroke="${EDGE}" stroke-width="1" filter="url(#code-shadow)"/>`;
  if (L.hasHeader) {
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const chip = codeLangLabel(typeof o.lang === 'string' ? o.lang : 'plaintext');
    const chipW = Math.ceil(chip.length * 6.4 + 16);
    const chipX = Math.max(CODE.PAD_X, o.w - 12 - CODE.CONTROLS_W - chipW);
    const titleW = Math.max(0, chipX - 8 - CODE.PAD_X);
    out += `<line x1="0" y1="${L.headerH - 0.5}" x2="${w}" y2="${L.headerH - 0.5}" stroke="${RULE}" stroke-width="1"/>`;
    out += `<svg x="${CODE.PAD_X}" y="0" width="${n(titleW)}" height="${L.headerH}" overflow="hidden"><text x="0" y="${L.headerH / 2 + 4.5}" font-family="${ui}" font-size="13" font-weight="600" fill="${INK}" xml:space="preserve">${escapeXml(title)}</text></svg>`;
    out += `<rect x="${n(chipX)}" y="${(L.headerH - 20) / 2}" width="${chipW}" height="20" rx="6" fill="color-mix(in srgb, var(--ink, #111111) 6%, var(--paper, #FFFFFF))"/>`;
    out += `<text x="${n(chipX + chipW / 2)}" y="${L.headerH / 2 + 4}" font-family="${ui}" font-size="11" fill="${GRAPHITE}" text-anchor="middle">${escapeXml(chip)}</text>`;
  }
  // while the code is typed (a textarea sits over it) the card, the header and the numbers stay and only the code itself is left out
  if (L.showLines) out += `<line class="code-rule" x1="${L.gutterW - 0.5}" y1="${L.headerH}" x2="${L.gutterW - 0.5}" y2="${n(o.h - 1)}" stroke="${RULE}" stroke-width="1"/>`;
  const empty = L.lines.length === 1 && L.lines[0] === '';
  const toks = L.long || empty ? null : usable(tokens, L.lines);
  let nums = '';
  let body = '';
  for (const r of L.rows) {
    const y = n(L.top + r.y + (L.lineH - CODE.FONT) / 2 + CODE.FONT * 0.8);
    if (L.showLines && r.first) nums += `<text x="${L.gutterW - 10}" y="${y}" text-anchor="end">${r.line + 1}</text>`;
    const row = toks ? sliceTokens(toks[r.line], r.col, r.col + r.len) : [{ t: r.text, c: null } as CodeToken];
    if (opts.editing || row.every((t) => !t.t)) continue;
    const spans = runs(row, L.textX + r.indent * L.charW, L.charW);
    if (spans) body += `<text x="${n(L.textX + r.indent * L.charW)}" y="${y}" style="white-space: pre" xml:space="preserve">${spans}</text>`;
  }
  // long lines (wrap off) are clipped inside the card, right of the numbers, and slide under that edge when the block is scrolled sideways
  const scroll = opts.editing || L.long ? 0 : Math.max(0, opts.scrollX ?? 0);
  out += `<svg x="0" y="${L.headerH}" width="${w}" height="${n(Math.max(0, o.h - L.headerH - 1))}" overflow="hidden"><g transform="translate(0 ${-L.headerH})">`;
  if (L.showLines) out += `<g class="code-nums" font-family="${family}" font-size="${CODE.GUTTER_NUM}" fill="${GRAPHITE}" style="font-variant-numeric: tabular-nums" xml:space="preserve">${nums}</g>`;
  if (!opts.editing) {
    out += `<svg x="${L.gutterW}" y="${L.headerH}" width="${n(Math.max(0, o.w - L.gutterW))}" height="${n(Math.max(0, o.h - L.headerH - 1))}" overflow="hidden"><g transform="translate(${n(-L.gutterW - scroll)} ${-L.headerH})">`;
    out += `<g class="code-text" font-family="${family}" font-size="${CODE.FONT}" fill="${INK}" style="font-variant-ligatures: none; font-feature-settings: 'liga' 0, 'calt' 0; tab-size: ${CODE.TAB}; white-space: pre" xml:space="preserve">`;
    out += empty
      ? `<text class="code-empty" x="${L.textX}" y="${n(L.top + (L.lineH - CODE.FONT) / 2 + CODE.FONT * 0.8)}" fill="${GRAPHITE}" opacity="0.7">${escapeXml(CODE_STRINGS.empty)}</text>`
      : body;
    out += '</g></g></svg>';
  }
  if (L.long && L.noteY !== null) {
    out += `<text class="code-note" x="${L.textX}" y="${n(L.noteY + CODE.FONT)}" font-family="${ui}" font-size="12" fill="${GRAPHITE}">${escapeXml(CODE_STRINGS.longNote)}</text>`;
  }
  return `${out}</g></svg></g>`;
}
