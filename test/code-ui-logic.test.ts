import { describe, expect, it } from 'vitest';
import { CODE_LANGS, COMMON_CODE_LANGS, MAX_CODE_CHARS } from '../shared/code-langs.mjs';
import { clampCodeText, codeMaxScroll, codeWrapDefault, defaultCodeLang, enterEdit, filterCodeLangs, forgetCodeLangs, orderedCodeLangs, rememberCodeLang, tabEdit } from '../src/code-ui-logic';
import { codeScroll, forgetCodeScroll, onCodeScroll, setCodeScroll } from '../src/code-view';
import { layoutCode } from '../src/code-layout';

describe('Tab and Shift+Tab', () => {
  it('types two spaces at the caret, and replaces a selection inside one line', () => {
    expect(tabEdit('ab', 1, 1, false)).toEqual({ value: 'a  b', start: 3, end: 3 });
    expect(tabEdit('abcd', 1, 3, false)).toEqual({ value: 'a  d', start: 3, end: 3 });
  });

  it('indents every line a multi-line selection touches, keeping the selection on the same text', () => {
    const v = 'one\ntwo\nthree';
    expect(tabEdit(v, 1, 9, false)).toEqual({ value: '  one\n  two\n  three', start: 3, end: 15 });
    // a selection that ends at the start of a line does not take that line
    expect(tabEdit(v, 0, 8, false).value).toBe('  one\n  two\nthree');
    // empty lines stay empty
    expect(tabEdit('a\n\nb', 0, 4, false).value).toBe('  a\n\n  b');
  });

  it('Shift+Tab takes up to two leading spaces (or a tab) off each touched line', () => {
    expect(tabEdit('  one\n   two\nthree', 0, 14, true).value).toBe('one\n two\nthree');
    expect(tabEdit(' x', 2, 2, true)).toEqual({ value: 'x', start: 1, end: 1 });
    expect(tabEdit('\tx', 2, 2, true).value).toBe('x');
    // nothing to remove: nothing changes
    expect(tabEdit('x', 1, 1, true)).toEqual({ value: 'x', start: 1, end: 1 });
    // a caret inside the removed indent goes to the line start
    expect(tabEdit('  x', 1, 1, true)).toEqual({ value: 'x', start: 0, end: 0 });
  });
});

describe('Enter', () => {
  it('starts the next line with the indentation of this one, as far as the caret is past it', () => {
    expect(enterEdit('    foo', 7, 7)).toEqual({ value: '    foo\n    ', start: 12, end: 12 });
    expect(enterEdit('\tfoo', 4, 4).value).toBe('\tfoo\n\t');
    // in the middle of the indent only the indent left of the caret is carried
    expect(enterEdit('    foo', 2, 2)).toEqual({ value: '  \n  ' + '  foo', start: 5, end: 5 });
    // a selection is replaced
    expect(enterEdit('  ab', 3, 4).value).toBe('  a\n  ');
    expect(enterEdit('x\n  y', 1, 1).value).toBe('x\n\n  y');
  });
});

describe('the language list', () => {
  it('is Plain text, the 12 common languages in their order, then the rest alphabetically by label', () => {
    const rows = orderedCodeLangs();
    expect(rows).toHaveLength(CODE_LANGS.length);
    expect(rows[0].id).toBe('plaintext');
    expect(rows.slice(1, 13).map((r) => r.id)).toEqual([...COMMON_CODE_LANGS]);
    const rest = rows.slice(13).map((r) => r.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('is searched by name or id, ignoring case; nothing found is an empty list', () => {
    const rows = orderedCodeLangs();
    expect(filterCodeLangs(rows, 'SCRIPT').map((r) => r.label)).toEqual(expect.arrayContaining(['JavaScript', 'TypeScript']));
    expect(filterCodeLangs(rows, 'py').map((r) => r.id)).toEqual(['python']);
    expect(filterCodeLangs(rows, '  ')).toHaveLength(rows.length);
    expect(filterCodeLangs(rows, 'zzzz')).toEqual([]);
  });
});

describe('the language a new block starts with', () => {
  it('is Plain text, then the last language used on that board', () => {
    forgetCodeLangs();
    expect(defaultCodeLang('b1')).toBe('plaintext');
    rememberCodeLang('b1', 'python');
    rememberCodeLang('b2', 'rust');
    expect(defaultCodeLang('b1')).toBe('python');
    expect(defaultCodeLang('b2')).toBe('rust');
    expect(defaultCodeLang('b3')).toBe('plaintext');
    rememberCodeLang('b1', 'klingon');
    rememberCodeLang('b1', 7);
    expect(defaultCodeLang('b1')).toBe('python');
  });
});

describe('wrapping by default', () => {
  it('is on for a coarse pointer and off for a fine one', () => {
    expect(codeWrapDefault(true)).toBe(true);
    expect(codeWrapDefault(false)).toBe(false);
  });
});

describe('the length limit', () => {
  it('cuts text at the limit and says it did', () => {
    expect(clampCodeText('abc')).toEqual({ text: 'abc', cut: false });
    const r = clampCodeText('x'.repeat(MAX_CODE_CHARS + 5));
    expect(r.cut).toBe(true);
    expect(r.text).toHaveLength(MAX_CODE_CHARS);
  });
});

describe('sideways scroll', () => {
  const CW = 8;
  it('is the longest line less the width the code may use, and nothing when wrapping', () => {
    const l = layoutCode({ text: 'x'.repeat(100) + '\nshort', w: 16 + 8 * 20 + 16 }, { charW: CW });
    expect(codeMaxScroll(l, false)).toBe(100 * CW - l.textW);
    expect(codeMaxScroll(l, true)).toBe(0);
    expect(codeMaxScroll(layoutCode({ text: 'short', w: 520 }, { charW: CW }), false)).toBe(0);
  });

  it('is kept per block, clamped, and tells the app when it moved', () => {
    const moved: string[] = [];
    onCodeScroll((id) => moved.push(id));
    expect(setCodeScroll('c1', 50, 200)).toBe(true);
    expect(setCodeScroll('c1', 50, 200)).toBe(false);
    expect(setCodeScroll('c1', 999, 200)).toBe(true);
    expect(codeScroll('c1')).toBe(200);
    expect(setCodeScroll('c1', -5, 200)).toBe(true);
    expect(codeScroll('c1')).toBe(0);
    expect(codeScroll('other')).toBe(0);
    expect(moved).toEqual(['c1', 'c1', 'c1']);
    setCodeScroll('c2', 10, 100);
    forgetCodeScroll('c2');
    expect(codeScroll('c2')).toBe(0);
    onCodeScroll(null);
  });
});
