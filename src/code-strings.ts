// Every word a person reads in or around a code block (docs/code-blocks.md), in one module so the drawing code, the Layers panel, the screen-reader
// description and the controls say the same thing. Language names are the labels of shared/code-langs.mjs, never ids or file extensions.
import { codeLangLabel } from '../shared/code-langs.mjs';

export const CODE_STRINGS = {
  untitled: 'Untitled code',
  empty: 'Paste or type code',
  longNote: 'Highlighting off for long code',
  heading: 'Code block',
  copy: 'Copy code',
  copied: 'Copied',
  wrap: 'Wrap lines',
  lines: 'Line numbers',
  language: 'Language',
  title: 'Title',
  searchLanguages: 'Search languages',
  noLanguage: 'No language matches',
} as const;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The accessible name of a block: "Code, TypeScript" or "Code, <title>, TypeScript". */
export function codeAccessibleName(o: { title?: unknown; lang?: unknown }): string {
  const title = typeof o.title === 'string' ? oneLine(o.title) : '';
  const lang = codeLangLabel(typeof o.lang === 'string' ? o.lang : 'plaintext');
  return title ? `Code, ${title}, ${lang}` : `Code, ${lang}`;
}

/** The Layers entry: "Code block: <title or first line>" (the first line cut at about 40 characters), or just "Code block" when empty. */
export function codeLayerLabel(o: { title?: unknown; text?: unknown }): string {
  const title = typeof o.title === 'string' ? oneLine(o.title) : '';
  let what = title;
  if (!what && typeof o.text === 'string') {
    const first = o.text.split(/\r\n?|\n/).map(oneLine).find(Boolean) ?? '';
    what = first.length > 40 ? `${first.slice(0, 39)}…` : first;
  }
  return what ? `${CODE_STRINGS.heading}: ${what}` : CODE_STRINGS.heading;
}
