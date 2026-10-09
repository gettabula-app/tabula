// The text of a chat message (docs/chat.md, "The messages"). Pure: no I/O, no directory. What is stored is exactly
// what is shown, so every rule that changes the text runs here, on the server, before anything is written.

import { stripInvisible } from './board-ops.mjs';

export const MAX_TEXT = 2000;
export const MAX_MENTIONS = 10;
/** The shape of a board object id (newId() in src/store.ts makes 9 of these characters; imports may be longer). */
export const OBJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A client-made id that makes a retried send harmless (a uuid fits). */
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** A mention in stored text: `@{<userId>}`. User ids are base64url (directory.mjs newId()). */
const MENTION_RE = /@\{([A-Za-z0-9_-]{1,64})\}/g;
export const MENTION_FALLBACK = '@someone';

/**
 * The stored form of what a person typed: NFC, `\r\n` and `\r` as `\n`, no control characters but newline and tab,
 * no invisible or bidirectional controls, trailing whitespace off every line, at most two blank lines in a row, and
 * no blank lines at the start or the end.
 * @param {unknown} value
 */
export function normaliseText(value) {
  if (typeof value !== 'string') return '';
  const unified = value.replace(/\r\n?/g, '\n').normalize('NFC');
  // NFC first, then strip: composing never makes an invisible character, and stripping cannot undo the composition.
  const lines = stripInvisible(unified).split('\n').map((line) => line.replace(/\s+$/u, ''));
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/^\n+/, '').replace(/\s+$/u, '');
}

/** Length in characters as a person counts them (code points), so an emoji is one, not two. */
export const textLength = (text) => [...text].length;

/**
 * The text to store, or why it cannot be. `empty` means nothing but whitespace was left after normalising.
 * @param {unknown} value
 * @returns {{ text: string } | { error: 'empty' | 'too_long' }}
 */
export function checkText(value) {
  const text = normaliseText(value);
  if (text.trim() === '') return { error: 'empty' };
  if (textLength(text) > MAX_TEXT) return { error: 'too_long' };
  return { text };
}

/** The distinct user ids mentioned in a text, in order of first appearance. */
export function mentionIds(text) {
  const ids = [];
  for (const m of text.matchAll(MENTION_RE)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

/**
 * Keeps the mention tokens of people `mayRead` allows and turns every other token into the literal `@someone`, so a
 * stored token always names someone who could read the channel when it was written. More than MAX_MENTIONS distinct
 * people is refused.
 * @param {string} text normalised text
 * @param {(userId: string) => boolean} mayRead
 * @returns {{ text: string, mentions: string[] } | { error: 'too_many_mentions' }}
 */
export function resolveMentions(text, mayRead) {
  const ids = mentionIds(text);
  if (ids.length > MAX_MENTIONS) return { error: 'too_many_mentions' };
  const kept = ids.filter((id) => mayRead(id));
  const out = text.replace(MENTION_RE, (token, id) => (kept.includes(id) ? token : MENTION_FALLBACK));
  return { text: out, mentions: kept };
}

// Links: http and https only. A URL runs to the next whitespace; closing punctuation that usually ends a sentence is
// left outside the link. The client makes the same choice when it renders (docs/chat.md, Security).
const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;
const TRAILING = /[.,:;!?'")\]}]+$/;

/**
 * The http and https links in a text, as start and end offsets and the address. Nothing else (no `javascript:`, no
 * `mailto:`, no bare domains) is ever a link.
 * @param {string} text
 * @returns {{ start: number, end: number, url: string }[]}
 */
export function findLinks(text) {
  const links = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(TRAILING, '');
    // a ')' that closes a '(' inside the address (Wikipedia style) belongs to it
    while (m[0].length > url.length && m[0][url.length] === ')' && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) {
      url += ')';
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) continue;
    links.push({ start: m.index, end: m.index + url.length, url });
  }
  return links;
}

/** Whether a value has the shape of a board object id. The board document itself is never read. */
export const isObjectId = (value) => typeof value === 'string' && OBJECT_ID_RE.test(value);

/** Whether a value has the shape of a client-made message id. */
export const isClientId = (value) => typeof value === 'string' && CLIENT_ID_RE.test(value);
