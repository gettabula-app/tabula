import { describe, expect, it, vi } from 'vitest';
import { firstGrapheme, firstLastInitials, graphemes, initialOf, wordInitials } from '../shared/initials.mjs';

// Escapes keep the emoji visible in the source: ZWJ (U+200D), skin tone (U+1F3FD), regional indicators (U+1F1F8 U+1F1EA).
const FOX = '\u{1F98A}';
const DEV = '\u{1F469}‍\u{1F4BB}';
const SWEDEN = '\u{1F1F8}\u{1F1EA}';
const OK = '\u{1F44D}\u{1F3FD}';

describe('initialOf', () => {
  it.each([
    ['ASCII name', 'Ana', 'A'],
    ['lowercase', 'lea', 'L'],
    ['accented capital', 'Åsa', 'Å'],
    ['accented lowercase', 'åsa', 'Å'],
    ['leading emoji', `${FOX} Fox`, FOX],
    ['ZWJ sequence', `${DEV} Dev`, DEV],
    ['flag', `${SWEDEN} Sweden`, SWEDEN],
    ['skin-tone modifier', `${OK} Ok`, OK],
    ['CJK', '漢字', '漢'],
    ['combining mark', 'éva', 'É'],
    ['leading whitespace', '  Mia', 'M'],
    ['empty', '', '?'],
    ['whitespace only', '   ', '?'],
  ])('%s', (_label, name, expected) => {
    expect(initialOf(name)).toBe(expected);
  });

  it('keeps a grapheme whole when the name is one emoji and nothing else', () => {
    expect(initialOf(DEV)).toBe(DEV);
  });
});

describe('graphemes and firstGrapheme', () => {
  it('cuts a ZWJ sequence and a combining mark as one character each', () => {
    expect(graphemes(`${DEV}a`)).toEqual([DEV, 'a']);
    expect(graphemes('éx')).toEqual(['é', 'x']);
    expect(firstGrapheme('')).toBe('');
  });
});

describe('wordInitials (first two words)', () => {
  it.each([
    ['two words', 'Ana Lima Souza', 'AL'],
    ['one word', 'ben', 'B'],
    ['blank', '  ', ''],
    ['leading emoji word', `${FOX} Fox`, `${FOX}F`],
    ['ZWJ word first', `${DEV} Dev Ops`, `${DEV}D`],
    ['accented word', 'Åsa Lind', 'ÅL'],
  ])('%s', (_label, name, expected) => {
    expect(wordInitials(name)).toBe(expected);
  });
});

describe('firstLastInitials (first and last word)', () => {
  it.each([
    ['two words', 'Johan Saldes', 'JS'],
    ['first and last of three', 'Ana Lima Souza', 'AS'],
    ['one word', 'Lea', 'L'],
    ['blank', '  ', ''],
    ['leading emoji word', `${FOX} Fox`, `${FOX}F`],
    ['ZWJ word last', `Ana ${DEV}`, `A${DEV}`],
  ])('%s', (_label, name, expected) => {
    expect(firstLastInitials(name)).toBe(expected);
  });
});

describe('without Intl.Segmenter', () => {
  it('falls back to whole code points, so a surrogate pair is never split', async () => {
    const original = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true });
    try {
      vi.resetModules();
      const fallback = await import('../shared/initials.mjs');
      expect(fallback.initialOf(`${FOX} Fox`)).toBe(FOX);
      expect(fallback.initialOf(`${DEV} Dev`)).toBe('\u{1F469}'); // the fallback keeps code points, so it stops before the ZWJ
      expect(fallback.initialOf('Åsa')).toBe('Å');
      expect(fallback.initialOf('  ')).toBe('?');
    } finally {
      if (original) Object.defineProperty(Intl, 'Segmenter', original);
      vi.resetModules();
    }
  });
});
