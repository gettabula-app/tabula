import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT, MENTION_FALLBACK, checkText, findLinks, isClientId, isObjectId, mentionIds, normaliseText, resolveMentions, textLength,
} from '../server/chat-text.mjs';

// docs/chat.md, "The messages": what is stored is exactly what is shown.

describe('normaliseText', () => {
  it.each<[string, string, string]>([
    ['keeps plain text', 'Are we starting at ten?', 'Are we starting at ten?'],
    ['turns CRLF and lone CR into newlines', 'one\r\ntwo\rthree', 'one\ntwo\nthree'],
    ['keeps tabs and newlines', 'a\tb\nc', 'a\tb\nc'],
    ['removes control characters', 'a\u0000b\u0007c\u001bd\u007fe\u0085f', 'abcdef'],
    ['removes zero-width characters', 'pay​pal‌‍⁠﻿', 'paypal'],
    ['removes bidirectional overrides and isolates', 'abc‮dcba‬ ⁦x⁩ ‎y‏', 'abcdcba x y'],
    ['removes the line and paragraph separators', 'a b c', 'abc'],
    ['removes tag characters', 'hi\u{e0041}\u{e0042}', 'hi'],
    ['composes to NFC', 'Café', 'Café'],
    ['trims trailing whitespace on every line', 'one   \ntwo\t\nthree  ', 'one\ntwo\nthree'],
    ['collapses more than two blank lines', 'a\n\n\n\n\n\nb', 'a\n\n\nb'],
    ['keeps two blank lines', 'a\n\n\nb', 'a\n\n\nb'],
    ['counts whitespace-only lines as blank', 'a\n  \n \t\n   \n \nb', 'a\n\n\nb'],
    ['drops blank lines at the start and the end', '\n\n  \nhello\n\n\n', 'hello'],
    ['keeps leading spaces of the first line', '  indented', '  indented'],
  ])('%s', (_name, input, output) => {
    expect(normaliseText(input)).toBe(output);
  });

  it('treats anything but a string as empty', () => {
    for (const value of [undefined, null, 42, {}, ['x']]) expect(normaliseText(value)).toBe('');
  });
});

describe('checkText', () => {
  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['only newlines and tabs', '\n\t\n'],
    ['only invisible characters', '​‮﻿'],
    ['not a string', 7],
  ])('refuses %s as empty', (_name, value) => {
    expect(checkText(value)).toEqual({ error: 'empty' });
  });

  it('accepts exactly the limit and refuses one character more', () => {
    expect(checkText('x'.repeat(MAX_TEXT))).toEqual({ text: 'x'.repeat(MAX_TEXT) });
    expect(checkText('x'.repeat(MAX_TEXT + 1))).toEqual({ error: 'too_long' });
  });

  it('counts characters as people do, so emoji count once', () => {
    const text = '🎉'.repeat(MAX_TEXT);
    expect(textLength(text)).toBe(MAX_TEXT);
    expect(checkText(text)).toEqual({ text });
  });

  it('measures after normalising, so stripped characters do not count', () => {
    const padded = `${'x'.repeat(MAX_TEXT)}${'​'.repeat(50)}   \n\n`;
    expect(checkText(padded)).toEqual({ text: 'x'.repeat(MAX_TEXT) });
  });
});

describe('mentions', () => {
  it('finds the distinct ids of @{id} tokens in order', () => {
    expect(mentionIds('Hi @{abc_1} and @{XYZ-2}, also @{abc_1}')).toEqual(['abc_1', 'XYZ-2']);
  });

  it.each(['@abc', '@{}', '@{a b}', '@{a.b}', '@{<script>}', `@{${'a'.repeat(65)}}`])('does not take %s for a token', (text) => {
    expect(mentionIds(text)).toEqual([]);
  });

  it('keeps tokens of people who can read the channel and turns the others into @someone', () => {
    const can = new Set(['ana']);
    expect(resolveMentions('@{ana} ask @{ghost} and @{ana}', (id) => can.has(id))).toEqual({
      text: `@{ana} ask ${MENTION_FALLBACK} and @{ana}`,
      mentions: ['ana'],
    });
  });

  it('allows ten people and refuses eleven', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `@{u${i}}`).join(' ');
    expect(resolveMentions(ten, () => true)).toMatchObject({ mentions: Array.from({ length: 10 }, (_, i) => `u${i}`) });
    expect(resolveMentions(`${ten} @{u10}`, () => true)).toEqual({ error: 'too_many_mentions' });
  });

  it('counts the same person once toward the limit', () => {
    const same = Array.from({ length: 15 }, () => '@{ana}').join(' ');
    expect(resolveMentions(same, () => true)).toMatchObject({ mentions: ['ana'] });
  });
});

describe('findLinks', () => {
  it('finds http and https links', () => {
    expect(findLinks('see https://example.com/a?b=1#c and http://x.org').map((l) => l.url)).toEqual(['https://example.com/a?b=1#c', 'http://x.org']);
  });

  it('gives offsets into the text', () => {
    const text = 'go to https://example.com now';
    const [link] = findLinks(text);
    expect(text.slice(link.start, link.end)).toBe('https://example.com');
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:msgbox',
    'file:///etc/passwd',
    'mailto:ana@example.com',
    'ftp://example.com/file',
    'www.example.com',
    'example.com',
    'https://',
  ])('does not make a link of %s', (text) => {
    expect(findLinks(text)).toEqual([]);
  });

  it('leaves sentence punctuation outside the link', () => {
    expect(findLinks('Read https://example.com/page.').map((l) => l.url)).toEqual(['https://example.com/page']);
    expect(findLinks('(see https://example.com/x)').map((l) => l.url)).toEqual(['https://example.com/x']);
  });

  it('keeps a bracket that belongs to the address', () => {
    expect(findLinks('https://en.wikipedia.org/wiki/Mercury_(planet) is it').map((l) => l.url)).toEqual(['https://en.wikipedia.org/wiki/Mercury_(planet)']);
  });

  it('does not run a link into markup characters', () => {
    expect(findLinks('<https://example.com>"x"').map((l) => l.url)).toEqual(['https://example.com']);
  });
});

describe('ids', () => {
  it.each([['abcDEF123', true], ['a-b_c', true], ['x'.repeat(64), true], ['', false], ['x'.repeat(65), false], ['a b', false], ['a/b', false], ['../x', false]])(
    'object id %s is %s',
    (id, ok) => {
      expect(isObjectId(id)).toBe(ok);
    },
  );

  it('object ids must be strings', () => {
    expect(isObjectId(123)).toBe(false);
    expect(isObjectId(null)).toBe(false);
  });

  it.each([['0f8fad5b-d9cb-469f-a165-70867728950e', true], ['abcdefgh', true], ['short', false], ['x'.repeat(65), false], ['has space here', false]])(
    'client id %s is %s',
    (id, ok) => {
      expect(isClientId(id)).toBe(ok);
    },
  );
});
