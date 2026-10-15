// The checklist of a kanban card (TAB-372, po/specs/12-kanban-checklist.md): the pure rules for its items. No DOM and no store
// writes: the card write is cardFields in src/containers.ts, and each rewrite path keeps the field the way it keeps labels.
// The limits and the one-line rule are the shared ones (shared/containers.mjs), the same the server checks.

import { LIMITS, checklistProblem, codePointLength } from '../shared/containers';
import { newId } from './store';
import type { ChecklistItem, Id } from './types';

export type { ChecklistItem } from './types';

const MAX_ITEMS = LIMITS.checklistItems;
const MAX_TEXT = LIMITS.checklistText;
const MAX_BYTES = LIMITS.checklistBytes;
/** An item id as the validator takes it: 1 to 64 of A-Z, a-z, 0-9, `_` and `-` (server/sync-validate.mjs). */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LINE_SPLIT = /\r\n|[\n\r\u0085\u2028\u2029]/;
/** A markdown list marker at the start of a pasted line, with the space after it (or the end of the line). */
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/;
/** A task box at the start of a pasted line: `[ ]` open, `[x]` or `[X]` ticked. */
const TICK = /^\[([ xX])\]\s*/;
const encoder = new TextEncoder();
const bytesOf = (v: unknown) => encoder.encode(JSON.stringify(v)).length;

/** Line breaks and every other control character become one space, runs of white space one space, the ends trimmed. Not cut. */
function flatten(s: string): string {
  return s.replace(/[\p{Cc}\s\u2028\u2029]+/gu, ' ').trim();
}

/** An item's text as it is stored: one line, the ends trimmed, at most 200 code points (cut); '' when nothing is left. */
export function cleanItemText(s: unknown): string {
  if (typeof s !== 'string') return '';
  const t = flatten(s);
  return codePointLength(t) > MAX_TEXT ? [...t].slice(0, MAX_TEXT).join('').trimEnd() : t;
}

function freshId(taken: ReadonlySet<string>): string {
  let id = newId();
  while (taken.has(id)) id = newId();
  return id;
}

export interface CleanChecklistOptions {
  /**
   * What an item with a missing, malformed or repeated id does. `regenerate` (the default: loading a board, an import) gives it a
   * new id; `drop` (the render path, which runs on every draw and must not change ids each time) leaves it out.
   */
  badIds?: 'regenerate' | 'drop';
}

/**
 * A card's checklist as the app keeps it, from any value (a loaded board, a file, a template): non-objects and items with no
 * text after cleaning are dropped, each item keeps only id, text and done, the first 50 items stay, and the list is cut from the end
 * to 12,000 bytes of JSON. Undefined when nothing is left, so the key is not written. Idempotent for valid input.
 */
export function cleanChecklist(value: unknown, opts: CleanChecklistOptions = {}): ChecklistItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ChecklistItem[] = [];
  const ids = new Set<string>();
  let bytes = 2; // the brackets of the list
  for (const raw of value) {
    if (out.length >= MAX_ITEMS) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const text = cleanItemText(r.text);
    if (!text) continue;
    let id: string;
    if (typeof r.id === 'string' && ID_RE.test(r.id) && !ids.has(r.id)) id = r.id;
    else if (opts.badIds === 'drop') continue;
    else id = freshId(ids);
    const item: ChecklistItem = { id, text, done: r.done === true };
    const cost = bytesOf(item) + (out.length ? 1 : 0);
    if (bytes + cost > MAX_BYTES) break;
    bytes += cost;
    ids.add(id);
    out.push(item);
  }
  return out.length ? out : undefined;
}

/**
 * An explicit write of a card's checklist (a card patch): the list as it will be stored, or null when it must be refused. Nothing
 * is cut to fit: more than 50 items, an item over 200 code points, an empty item, a key other than id, text and done, a repeated
 * or malformed id, or a list over 12,000 bytes refuse the whole write, as the validator does. Text is flattened to one line first.
 */
export function checklistForWrite(value: unknown): ChecklistItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const out: ChecklistItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== 'id' && k !== 'text' && k !== 'done')) return null;
    if (typeof r.text !== 'string' || (r.done !== undefined && typeof r.done !== 'boolean')) return null;
    out.push({ id: r.id as string, text: flatten(r.text), done: r.done === true });
  }
  return checklistProblem(out) ? null : out;
}

export interface ChecklistProgress { done: number; total: number }

/** How many of a card's items are ticked, out of how many it has. Zero and zero for a card with no checklist. */
export function checklistProgress(card: { checklist?: unknown } | null | undefined): ChecklistProgress {
  const raw = card?.checklist;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const done = list.filter((i) => !!i && typeof i === 'object' && (i as { done?: unknown }).done === true).length;
  return { done, total: list.length };
}

export interface ChecklistProgressLabel { text: string; srText: string; complete: boolean }

/**
 * The chip on the card face and its screen-reader text: "2/5" and "2 of 5 checklist items done"; "5/5 done" when every item is
 * ticked. Null with no items, when the chip is not shown at all.
 */
export function progressLabel(p: ChecklistProgress): ChecklistProgressLabel | null {
  if (p.total <= 0) return null;
  const complete = p.done >= p.total;
  return {
    text: complete ? `${p.done}/${p.total} done` : `${p.done}/${p.total}`,
    srText: `${p.done} of ${p.total} checklist items done`,
    complete,
  };
}

export interface PastedItems { items: { text: string; done: boolean }[]; dropped: number }

/**
 * Pasted text as checklist items: one item per line that is not blank once cleaned. A list marker (`- `, `* `, `+ `, `1. `, `1) `)
 * and a leading `[ ]`, `[x]` or `[X]` are taken off, and `x` arrives ticked. At most `room` items are kept, and no more than
 * `bytesLeft` bytes of list (default: the whole limit); what does not fit is counted in `dropped`, for "Added 50 of 63".
 */
export function parsePastedItems(text: string, room: number, bytesLeft: number = MAX_BYTES): PastedItems {
  const cap = Math.max(0, Math.floor(room));
  const items: { text: string; done: boolean }[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const line of text.split(LINE_SPLIT)) {
    let rest = line.replace(LIST_MARKER, '');
    let done = false;
    const tick = TICK.exec(rest);
    if (tick) {
      done = tick[1] !== ' ';
      rest = rest.slice(tick[0].length);
    }
    const t = cleanItemText(rest);
    if (!t) continue;
    // a comma between items is counted for each, which may overcount a byte on an empty list: the limit is never passed
    const cost = bytesOf({ id: '000000000', text: t, done }) + 1;
    if (items.length >= cap || bytes + cost > bytesLeft) {
      dropped++;
      continue;
    }
    bytes += cost;
    items.push({ text: t, done });
  }
  return { items, dropped };
}

/** Items with fresh ids and their text and tick: a copy, a paste or a template use. Ids are unique within the list. */
export function withNewIds(items: readonly { text: string; done: boolean }[]): ChecklistItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    const id = freshId(taken);
    taken.add(id);
    return { id, text: item.text, done: item.done === true };
  });
}

/** `o` with its checklist cleaned and given fresh item ids (a copy, a paste, a template use). An object with no checklist is returned as it is. */
export function withFreshItemIds<T extends object>(o: T): T {
  if (!('checklist' in o)) return o;
  const items = cleanChecklist((o as { checklist?: unknown }).checklist);
  const { checklist: _old, ...rest } = o as T & { checklist?: unknown };
  return (items ? { ...rest, checklist: withNewIds(items) } : rest) as T;
}

const fits = (list: readonly ChecklistItem[]) => list.length <= MAX_ITEMS && bytesOf(list) <= MAX_BYTES;

/**
 * The list with one more item at the end. Null when the text is empty (after cleaning) or the list has no room for it, by count or
 * by bytes; the caller writes nothing then.
 */
export function addItem(list: ChecklistItem[], text: string): ChecklistItem[] | null {
  const t = cleanItemText(text);
  if (!t) return null;
  const next = [...list, { id: freshId(new Set(list.map((i) => i.id))), text: t, done: false }];
  return fits(next) ? next : null;
}

/** The list with one item's tick flipped. The same list (same reference) when no item has that id. */
export function toggleItem(list: ChecklistItem[], id: Id): ChecklistItem[] {
  if (!list.some((i) => i.id === id)) return list;
  return list.map((i) => (i.id === id ? { ...i, done: !i.done } : i));
}

/**
 * The list with one item's text replaced, cleaned as a new item's is (cut to 200 code points). The same list when the item is
 * missing or the text does not change; null when the text is empty, which the caller refuses.
 */
export function editItem(list: ChecklistItem[], id: Id, text: string): ChecklistItem[] | null {
  const t = cleanItemText(text);
  if (!t) return null;
  const at = list.findIndex((i) => i.id === id);
  if (at < 0 || list[at].text === t) return list;
  return list.map((i, k) => (k === at ? { ...i, text: t } : i));
}

/** The list with one item moved by `delta` places, clamped to the first and last place. The same list when it does not move. */
export function moveItem(list: ChecklistItem[], id: Id, delta: number): ChecklistItem[] {
  const from = list.findIndex((i) => i.id === id);
  const step = Math.trunc(delta);
  if (from < 0 || !step) return list;
  const to = Math.min(list.length - 1, Math.max(0, from + step));
  if (to === from) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** The list without one item. The same list when no item has that id. */
export function removeItem(list: ChecklistItem[], id: Id): ChecklistItem[] {
  return list.some((i) => i.id === id) ? list.filter((i) => i.id !== id) : list;
}
