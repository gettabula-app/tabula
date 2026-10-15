// The initial a person's name is drawn with (TAB-361). The first UTF-16 unit of an emoji is a lone surrogate, which
// draws as a broken glyph, and an emoji with a skin tone, a ZWJ sequence or a flag is several code points. So a name is
// cut into user-perceived characters (grapheme clusters): "🦊 Fox" starts with "🦊", "👩‍💻 Dev" with "👩‍💻", "🇸🇪 Sweden" with
// "🇸🇪". Shared by the browser and the server, so both draw the same initials. Where Intl.Segmenter is missing the cut
// falls back to code points, which still keeps every surrogate pair whole.

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('und', { granularity: 'grapheme' })
  : null;

/** The user-perceived characters of `text`: grapheme clusters, or code points where Intl.Segmenter is missing. */
export function graphemes(text) {
  const s = String(text ?? '');
  return segmenter ? Array.from(segmenter.segment(s), ({ segment }) => segment) : Array.from(s);
}

/** The first user-perceived character of `text`, as it is; '' when there is none. */
export function firstGrapheme(text) {
  return graphemes(text)[0] ?? '';
}

/** The initial a name is drawn with: its first character, upper case; '?' when the name is blank. */
export function initialOf(name) {
  return firstGrapheme(String(name ?? '').trim()).toLocaleUpperCase() || '?';
}

const wordsOf = (name) => String(name ?? '').trim().split(/\s+/u).filter(Boolean);

/** The initials of the first two words: "Ana Lima Souza" gives "AL", "ben" gives "B"; '' when the name is blank. */
export function wordInitials(name) {
  return wordsOf(name).slice(0, 2).map(firstGrapheme).join('').toLocaleUpperCase();
}

/** The initials of the first and the last word: "Ana Lima Souza" gives "AS", "ben" gives "B"; '' when the name is blank. */
export function firstLastInitials(name) {
  const words = wordsOf(name);
  return (words.length > 1 ? [words[0], words.at(-1)] : words).map(firstGrapheme).join('').toLocaleUpperCase();
}
