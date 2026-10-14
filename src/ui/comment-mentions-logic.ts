// Mentions in comments (TAB-53): the parts with no DOM. A comment is plain text; a mention is the token `@{<userId>}`, the same as
// chat's. The chat composer's rules (the `@` word, the people filter, showing `@Name` and storing the token) are reused from
// chat-logic. src/ui/comments.ts does the DOM around it.

import { MAX_TEXT } from '../comments';
import { filterPeople, insertMention, MAX_MENTIONS, mentionLabel, mentionQuery, segments, toTokens, type Person, type Segment } from './chat-logic';

export { MAX_MENTIONS, MAX_TEXT };

const TOKEN_RE = /@\{([A-Za-z0-9_-]{1,64})\}/g;

/** The distinct people a text names with a token, in the order they first appear. */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]))];
}

/**
 * The people this board's comments can name: the comment authors (threads and replies) and the people here now. A person
 * here now wins over an older name from a comment. Oneself is kept, so a mention of oneself still reads as a name.
 */
export function knownPeople(
  comments: readonly { authorId: string; authorName: string; replies: readonly { authorId: string; authorName: string }[] }[],
  here: readonly { id: string; name: string }[],
): Person[] {
  const byId = new Map<string, Person>();
  for (const t of comments) {
    for (const a of [t, ...t.replies]) if (a.authorId && a.authorName.trim()) byId.set(a.authorId, { id: a.authorId, name: a.authorName });
  }
  for (const p of here) if (p.id && p.name.trim()) byId.set(p.id, { id: p.id, name: p.name });
  return [...byId.values()];
}

/** The text as segments for the DOM: names from `people`. A token for someone not in `people` has a null name ("someone"). */
export function commentSegments(text: string, people: readonly Person[]): Segment[] {
  return segments(text, people.map((p) => ({ id: p.id, name: p.name })));
}

/** One line of text with each mention as `@Name` (or "@someone"), for the list rows that show plain text. */
export function plainText(text: string, people: readonly Person[]): string {
  return commentSegments(text, people)
    .map((s) => (s.type === 'text' ? s.text : s.type === 'link' ? s.url : mentionLabel(s, people.some((p) => p.id === s.id))))
    .join('');
}

/** How many distinct people the text would name once the picked names are tokens. */
export function mentionCount(text: string, picked: readonly Person[]): number {
  return mentionedIds(toTokens(text, picked)).length;
}

/** The people the `@` list offers: none once the text already names MAX_MENTIONS people. Not oneself. */
export function mentionCandidates(people: readonly Person[], query: string, meId: string, text: string, picked: readonly Person[], limit = 8): Person[] {
  if (mentionCount(text, picked) >= MAX_MENTIONS) return [];
  return filterPeople(people, query, meId, limit);
}

/** The `@` word at the caret, if any, with the people the list offers for it. */
export function mentionState(text: string, caret: number, people: readonly Person[], meId: string, picked: readonly Person[]): { start: number; query: string; options: Person[] } | null {
  const q = mentionQuery(text, caret);
  if (!q) return null;
  return { ...q, options: mentionCandidates(people, q.query, meId, text, picked) };
}

/** Picks a person for the `@` word at the caret: shows `@Name ` and remembers the pick, so it is stored as a token on send. */
export function choosePerson(text: string, caret: number, person: Person, picked: readonly Person[]): { text: string; caret: number; picked: Person[] } | null {
  const q = mentionQuery(text, caret);
  if (!q) return null;
  const next = insertMention(text, q.start, caret, person.name);
  const already = picked.some((p) => p.id === person.id);
  return { text: next.value, caret: next.caret, picked: already ? [...picked] : [...picked, person] };
}

/** People the `@` list offers: accounts only, since a guest cannot be notified. */
export const offerable = (people: readonly Person[]): Person[] => people.filter((p) => !p.id.startsWith('guest_'));

/**
 * A stored text as the edit field shows it: a token for someone we know becomes `@Name` (with that person as picked, so saving turns it
 * back into the token). A token for someone we do not know stays as it is, so saving never loses it.
 */
export function editableText(text: string, people: readonly Person[]): { text: string; picked: Person[] } {
  const byId = new Map(people.map((p) => [p.id, p]));
  const picked: Person[] = [];
  const out = text.replace(TOKEN_RE, (whole, id: string) => {
    const person = byId.get(id);
    if (!person) return whole;
    if (!picked.some((p) => p.id === id)) picked.push(person);
    return `@${person.name}`;
  });
  return { text: out, picked };
}

/** The text to store: picked names become tokens. Its length is what the comment store and the server count. */
export function storedText(text: string, picked: readonly Person[]): string {
  return toTokens(text, picked).trim();
}

export const withinLimit = (stored: string): boolean => stored.length <= MAX_TEXT;
