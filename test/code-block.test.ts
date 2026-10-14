import { describe, expect, it } from 'vitest';
import { MAX_CODE_CHARS } from '../shared/code-langs.mjs';
import { describeObject, CODE_DESCRIBE_MAX } from '../src/canvas-describe';
import { CODE, codeBoxHeight, codeCharWidth, codeDefaultWidth, gutterWidth, layoutCode, newCodeFields } from '../src/code-layout';
import { codeMarkup, getCodeTokens, requestRepaint, setCodeRepaint, setCodeTokenSource, sliceTokens } from '../src/code-markup';
import { codeAccessibleName, codeLayerLabel } from '../src/code-strings';
import type { CodeLines } from '../src/code-tokens';
import { layerLabel } from '../src/layers';
import { typeGlyph } from '../src/layers-ui-logic';
import { objectMarkup, fittedBoxHeight, type MarkupCtx } from '../src/markup';
import { safeObj } from '../src/safe-obj';
import type { BaseObj, Obj } from '../src/types';

const CW = 8; // a fixed glyph width: layouts in these tests do not depend on the machine's fonts
const ctx = (extra: Partial<MarkupCtx> = {}) => ({ get: () => undefined, ...extra }) as unknown as MarkupCtx;
const code = (text: unknown, extra: Record<string, unknown> = {}) => ({ id: 'c1', type: 'code', x: 10, y: 20, w: 520, h: 200, rotation: 0, z: 'a', text, lang: 'ts', ...extra }) as unknown as BaseObj;

describe('layoutCode', () => {
  it('splits lines (CRLF, CR, LF), expands tabs to two columns and gives each line one row when not wrapping', () => {
    const l = layoutCode({ text: 'a\r\n\tb\rc\n', w: 520 }, { charW: CW });
    expect(l.lines).toEqual(['a', '  b', 'c', '']);
    expect(l.rows).toHaveLength(4);
    expect(l.rows.map((r) => r.y)).toEqual([0, 19.5, 39, 58.5]);
    expect(l.rows.every((r) => r.first && r.indent === 0)).toBe(true);
    expect(l.hasHeader).toBe(false);
    expect(l.height).toBe(Math.ceil(CODE.PAD_Y * 2 + 4 * 19.5));
  });

  it('has a 36px header only when there is a title', () => {
    const a = layoutCode({ text: 'x', w: 520, title: 'Hello' }, { charW: CW });
    const b = layoutCode({ text: 'x', w: 520, title: '   ' }, { charW: CW });
    expect(a.hasHeader).toBe(true);
    expect(a.height - b.height).toBe(36);
    expect(a.top).toBe(36 + 14);
  });

  it('wraps at the column count with a two-column hanging indent, one number per logical line', () => {
    const w = 16 + 8 * 20 + 16; // 20 columns
    const l = layoutCode({ text: 'x'.repeat(45) + '\nshort', w, wrap: true, lines: false }, { charW: CW });
    expect(l.cols).toBe(20);
    const first = l.rows.filter((r) => r.line === 0);
    expect(first.map((r) => r.len)).toEqual([20, 18, 7]);
    expect(first.map((r) => r.indent)).toEqual([0, 2, 2]);
    expect(first.map((r) => r.first)).toEqual([true, false, false]);
    expect(first.map((r) => r.text).join('')).toBe('x'.repeat(45));
    expect(l.rows.filter((r) => r.first)).toHaveLength(2);
    // no wrap: a long line stays one row
    expect(layoutCode({ text: 'x'.repeat(45), w, wrap: false }, { charW: CW }).rows).toHaveLength(1);
  });

  it('wraps in whole code points and never loops on a tiny box', () => {
    const l = layoutCode({ text: '😀'.repeat(7), w: 40, wrap: true }, { charW: CW });
    expect(l.cols).toBeGreaterThanOrEqual(1);
    expect(l.rows.map((r) => r.text).join('')).toBe('😀'.repeat(7));
    expect(layoutCode({ text: 'abc', w: -5, wrap: true }, { charW: CW }).rows.length).toBeGreaterThan(0);
  });

  it('the gutter is 40px and grows past 9,999 lines; numbers push the text right', () => {
    expect(gutterWidth(1)).toBe(40);
    expect(gutterWidth(9999)).toBe(40);
    expect(gutterWidth(10000)).toBe(48);
    const l = layoutCode({ text: 'a', w: 520, lines: true }, { charW: CW });
    expect(l.gutterW).toBe(40);
    expect(l.textX).toBe(40 + CODE.PAD_X);
    expect(layoutCode({ text: 'a', w: 520 }, { charW: CW }).textX).toBe(CODE.PAD_X);
  });

  it('20,000 characters and long single lines lay out fast and in linear rows', () => {
    const t0 = performance.now();
    const text = ('const value = compute(alpha, beta, gamma);\n').repeat(Math.floor(MAX_CODE_CHARS / 43));
    const a = layoutCode({ text, w: 520, wrap: true, lines: true }, { charW: CW });
    const b = layoutCode({ text: 'y'.repeat(MAX_CODE_CHARS), w: 300, wrap: true }, { charW: CW });
    expect(a.rows.length).toBeGreaterThan(400);
    expect(b.rows.length).toBe(Math.ceil((MAX_CODE_CHARS - b.cols) / (b.cols - 2)) + 1);
    expect(a.long).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('over the cap it is flagged long, gets a note row and a hostile size is cut', () => {
    const l = layoutCode({ text: 'a\n'.repeat(MAX_CODE_CHARS), w: 520 }, { charW: CW });
    expect(l.long).toBe(true);
    expect(l.noteY).not.toBeNull();
    const huge = layoutCode({ text: 'a'.repeat(CODE.DRAW_MAX_CHARS * 3), w: 520, wrap: true }, { charW: CW });
    expect(huge.rows.map((r) => r.len).reduce((a, b) => a + b, 0)).toBe(CODE.DRAW_MAX_CHARS);
  });

  it('measures one glyph run per size with an injectable measure function', () => {
    let calls = 0;
    const fake = (sample: string) => { calls++; return sample.length * 7.5; };
    expect(codeCharWidth(13, fake)).toBe(7.5);
    expect(calls).toBe(1);
    expect(codeCharWidth(13)).toBeGreaterThan(0);
  });

  it('codeBoxHeight and newCodeFields agree with the layout; fittedBoxHeight picks the right block', () => {
    const o = code('a\nb\nc', { w: 400 });
    expect(codeBoxHeight(o, 400, { charW: CW })).toBe(layoutCode({ text: 'a\nb\nc', w: 400 }, { charW: CW }).height);
    const f = newCodeFields();
    expect(f).toMatchObject({ lang: 'plaintext', lines: false, wrap: false, w: 520 });
    expect(f.h).toBe(fittedBoxHeight({ ...o, text: '', w: 520 } as BaseObj));
  });
});

describe('codeMarkup', () => {
  const tokens: CodeLines = [[{ t: 'const', c: '#d73a49' }, { t: ' x', c: null }], [{ t: '  y', c: '#005cc5', b: 1, i: 1 }]];

  it('draws a card, plain ink tspans without tokens and no foreignObject', () => {
    const svg = objectMarkup(code('const x\n\ty'), ctx());
    expect(svg).toMatch(/^<g transform="translate\(10 20\)"/);
    expect(svg).toContain('rx="12"');
    expect(svg).toMatch(/<tspan x="16">const x<\/tspan>/);
    expect(svg).toMatch(/<tspan x="[\d.]+">y<\/tspan>/); // the two leading spaces are a gap in x, not characters
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toContain('overflow="hidden"');
    expect(svg).not.toMatch(/foreignObject|<script|<iframe/);
    expect(svg).toContain('aria-label="Code, TypeScript"');
  });

  it('colours tspans from the tokens, with bold and italic, and ignores stale tokens', () => {
    const o = code('const x\n\ty');
    const svg = codeMarkup(o, layoutCode(o, { charW: CW }), tokens);
    expect(svg).toContain('<tspan x="16" fill="#d73a49">const </tspan>');
    expect(svg).toContain('<tspan x="32" fill="#005cc5" font-weight="700" font-style="italic">y</tspan>'); // 16 + 2 columns * 8
    const stale = codeMarkup(code('different\ntext'), layoutCode(code('different\ntext'), { charW: CW }), tokens);
    expect(stale).not.toContain('#d73a49');
    expect(stale).toContain('<tspan x="16">different</tspan>');
  });

  it('keeps indentation as explicit x per run, whatever the renderer does with spaces', () => {
    const xs = (svg: string) => [...svg.matchAll(/<tspan x="([\d.]+)"[^>]*>([^<]*)<\/tspan>/g)].map((m) => [Number(m[1]), m[2]] as const);
    const o = code('  a');
    const plain = codeMarkup(o, layoutCode(o, { charW: CW }));
    const L = layoutCode(o, { charW: CW });
    expect(xs(plain)).toEqual([[L.textX + 2 * CW, 'a']]); // first glyph at textX + 2 * charW
    expect(plain).toContain('style="white-space: pre" xml:space="preserve"');
    // a run that starts after 3 spaces of the previous run, a gap of several spaces inside a run, a tab (2 columns)
    const o2 = code('ab   cd  e\n\tf');
    const L2 = layoutCode(o2, { charW: CW });
    const t2: CodeLines = [[{ t: 'ab   ', c: '#111111' }, { t: 'cd  e', c: '#222222' }], [{ t: '  f', c: '#333333' }]];
    const svg2 = codeMarkup(o2, L2, t2);
    expect(xs(svg2)).toEqual([[L2.textX, 'ab   '], [L2.textX + 5 * CW, 'cd  '], [L2.textX + 9 * CW, 'e'], [L2.textX + 2 * CW, 'f']]);
    // the spaces stay in the text as trailing spaces of the run before; a single space inside a run stays a space
    const o3 = code('a b  ');
    const L3 = layoutCode(o3, { charW: CW });
    expect(xs(codeMarkup(o3, L3))).toEqual([[L3.textX, 'a b  ']]);
    // a wrapped continuation row sits on its hanging indent, and its runs keep their columns
    const o4 = code('x'.repeat(10) + '  yy', { w: 16 + 8 * 8 + 16, wrap: true });
    const L4 = layoutCode(o4, { charW: CW });
    const rows = xs(codeMarkup(o4, L4));
    expect(rows[0][0]).toBe(L4.textX);
    expect(rows.every(([x]) => x >= L4.textX)).toBe(true);
  });

  it('a hostile colour from the highlighter never reaches an attribute', () => {
    const o = code('a');
    const svg = codeMarkup(o, layoutCode(o, { charW: CW }), [[{ t: 'a', c: '"><script>x</script>' }]]);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('<tspan x="16">a</tspan>');
  });

  it('escapes the code, the title and a hostile language', () => {
    const hostile = '"><script>alert(1)</script><rect onload="x" /> & \'';
    const svg = objectMarkup(code(hostile, { title: hostile, lang: hostile }), ctx());
    expect(svg).not.toMatch(/<script|onload="x"/);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('Plain text'); // an unknown language reads as plain text
    expect(svg).not.toContain('<rect onload');
  });

  it('draws the header (title and language chip), the gutter numbers once per logical line, and the long-code note', () => {
    const svg = objectMarkup(code('a\nb', { title: 'My snippet', lines: true, lang: 'python' }), ctx());
    expect(svg).toContain('>My snippet</text>');
    expect(svg).toContain('>Python</text>');
    expect(svg).toContain('>1</text>');
    expect(svg).toContain('>2</text>');
    expect(svg).toContain('tabular-nums');
    const wrapped = objectMarkup(code('x'.repeat(400) + '\nb', { w: 200, lines: true, wrap: true }), ctx());
    expect(wrapped.match(/text-anchor="end"/g)).toHaveLength(2);
    const long = objectMarkup(code('a'.repeat(MAX_CODE_CHARS + 1)), ctx());
    expect(long).toContain('Highlighting off for long code');
    expect(objectMarkup(code('short'), ctx())).not.toContain('Highlighting off');
  });

  it('draws a dimmed prompt for an empty block and only the card while editing', () => {
    expect(objectMarkup(code(''), ctx())).toContain('Paste or type code');
    const editing = objectMarkup(code('secret code'), ctx({ editingId: 'c1' }));
    expect(editing).not.toContain('secret code');
    expect(editing).toContain('rx="12"');
  });

  it('asks the registered source for tokens and passes the repaint hook through', () => {
    const o = code('const x\n\ty');
    let asked = 0;
    setCodeTokenSource((b) => { asked++; return b.id === 'c1' ? tokens : null; });
    try {
      expect(objectMarkup(o, ctx())).toContain('fill="#d73a49"');
      expect(asked).toBe(1);
      expect(getCodeTokens(o)).toBe(tokens);
    } finally { setCodeTokenSource(null); }
    expect(getCodeTokens(o)).toBeNull();
    let repainted = 0;
    setCodeRepaint(() => { repainted++; });
    requestRepaint();
    setCodeRepaint(null);
    requestRepaint();
    expect(repainted).toBe(1);
  });

  it('slices tokens by code point for wrapped rows', () => {
    const runs = [{ t: 'ab', c: '#111' }, { t: 'cd😀', c: null }];
    expect(sliceTokens(runs, 1, 4)).toEqual([{ t: 'b', c: '#111' }, { t: 'cd', c: null }]);
    expect(sliceTokens(runs, 4, 5)).toEqual([{ t: '😀', c: null }]);
  });
});

describe('safeObj for a code block', () => {
  it('falls back to plaintext for an unknown language, keeps aliases as ids, clamps text and title, drops non-booleans', () => {
    const o = safeObj({ ...code('x'), lang: 'klingon', title: '  a\n‮ b  '.repeat(80), lines: 'yes', wrap: 1 } as unknown as Obj) as unknown as Record<string, unknown>;
    expect(o.lang).toBe('plaintext');
    expect((o.title as string).length).toBeLessThanOrEqual(100);
    expect(o.title).not.toMatch(/[\n‮]/);
    expect(o.lines).toBeUndefined();
    expect(o.wrap).toBeUndefined();
    expect((safeObj({ ...code('x'), lang: 'py' } as unknown as Obj) as unknown as { lang: string }).lang).toBe('python');
    expect((safeObj({ ...code('x'), lang: 'ts', lines: true, wrap: false } as unknown as Obj) as unknown as Record<string, unknown>)).toMatchObject({ lang: 'ts', lines: true, wrap: false });
    const big = safeObj({ ...code('z'.repeat(CODE.DRAW_MAX_CHARS + 50)) } as unknown as Obj) as unknown as { text: string };
    expect(big.text).toHaveLength(CODE.DRAW_MAX_CHARS);
    // control and bidirectional characters are not kept, tabs and line breaks are
    expect((safeObj(code('a‮b\u0000\tc\nd') as unknown as Obj) as unknown as { text: string }).text).toBe('ab\tc\nd');
  });

  it('other types do not carry code fields', () => {
    const o = safeObj({ id: 's', type: 'sticky', x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 'a', lang: 'ts', lines: true, wrap: true } as unknown as Obj) as unknown as Record<string, unknown>;
    expect(o.lang).toBeUndefined();
    expect(o.lines).toBeUndefined();
  });
});

describe('names, Layers and the screen-reader description', () => {
  it('names the block by language, title and first line', () => {
    expect(codeAccessibleName({ lang: 'ts' })).toBe('Code, TypeScript');
    expect(codeAccessibleName({ lang: 'cpp', title: ' Main ' })).toBe('Code, Main, C++');
    expect(codeLayerLabel({ title: 'Setup', text: 'x' })).toBe('Code block: Setup');
    expect(codeLayerLabel({ text: '\n\n  const   a = 1;\nmore' })).toBe('Code block: const a = 1;');
    expect(codeLayerLabel({ text: 'x'.repeat(100) })).toBe(`Code block: ${'x'.repeat(39)}…`);
    expect(codeLayerLabel({ text: '' })).toBe('Code block');
    expect(layerLabel(code('let a = 1') as unknown as Obj)).toBe('Code block: let a = 1');
    expect(typeGlyph('code')).toBe('code');
  });

  it('describes the language, the title and the code up to a cap', () => {
    const none = make();
    const d = describeObject(code('let a = 1;\nlet b = 2;', { title: 'Vars' }) as unknown as Obj, none);
    expect(d.name).toBe('Code block, TypeScript, "Vars"');
    expect(d.description).toContain('2 lines.');
    expect(d.description).toContain('Code: let a = 1;\nlet b = 2;');
    const long = describeObject(code('x'.repeat(CODE_DESCRIBE_MAX + 500)) as unknown as Obj, none);
    expect(long.description).toContain('500 more characters');
    expect(long.description.length).toBeLessThan(CODE_DESCRIBE_MAX + 200);
    expect(describeObject(code('') as unknown as Obj, none).description).toContain('Empty.');
    expect(describeObject(code('a', { lang: 'nope' }) as unknown as Obj, none).name).toBe('Code block, Plain text');
  });
});

function make() {
  return { get: () => undefined, childCount: () => 0 };
}

describe('codeDefaultWidth', () => {
  it('is 520 on a wide fine-pointer screen and min(520, viewport - 96), never under 160, on a phone', () => {
    expect(codeDefaultWidth(1280)).toBe(520);
    expect(codeDefaultWidth(1024, true)).toBe(520);
    expect(codeDefaultWidth(390)).toBe(294);
    expect(codeDefaultWidth(700, true)).toBe(520);
    expect(codeDefaultWidth(599)).toBe(503);
    expect(codeDefaultWidth(200)).toBe(160);
    expect(newCodeFields('', 294).w).toBe(294);
  });
});
