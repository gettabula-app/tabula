// Data that comes into a board from outside: a .drift file made by another account, objects pasted from another board.
// The relay checks what a write names (server/sync-validate.mjs: authors, owners, votes, poll answers) and how big a
// message is, and it cannot tell an import from a forgery, so the app maps the data before writing it:
//   - what names a person who is not on the target board becomes the importer or is cleared;
//   - the keys `__proto__`, `constructor` and `prototype` are dropped at any depth (the key, not the object);
//   - the tracker links of a card, a kanban and a tracker frame belong to the board they came from and are left behind;
//   - a file's `proposedBy` (which AI run made an object, and for whom) is dropped; a paste keeps it in its clean shape;
//   - a table (docs/tables.md) is one object with a key per row, column, width, alignment, fill and cell: the keys that are not
//     well-formed table parts are dropped, the rest kept as they are; a table past the editor's own limits is refused (`tableProblem`);
//   - the result is cut into groups that stay inside the relay's per-message budget (`planChunks`).
// Pure: no store, no DOM.

import { cleanColor } from '../shared/colors';
import { ALIGNS, MAX_CELL_CHARS, MAX_COL_WIDTH, MAX_TABLE_CHARS, MAX_TABLE_COLS, MAX_TABLE_ROWS, MIN_COL_WIDTH, isValidRank, parseTableKey, tableChars } from '../shared/tables';
import { isSafeHttpUrl } from '../shared/containers';
import { DEFAULT_CODE_LANG, MAX_CODE_CHARS, MAX_CODE_TITLE, normaliseCodeLang } from '../shared/code-langs';
import { cleanProposedBy } from './safe-obj';
import type { Obj, Poll, PollAnswer, Vote } from './types';

/** The people the target board knows: the importer, and whoever `known` says. */
export type IsMember = (id: string) => boolean;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 24;

// Characters XML 1.0 cannot carry (U+0000-0008, 000B, 000C, 000E-001F, FFFE, FFFF, a lone surrogate) and the bidirectional
// overrides and isolates (U+202A-202E, U+2066-2069) that make text read differently from how it is stored. Tab, line feed and
// carriage return stay.
// oxlint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿‪-‮⁦-⁩]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const HIDDEN_TEST = new RegExp(HIDDEN_CHARS.source);

/** `s` without XML-illegal control characters, lone surrogates and bidi override or isolate characters (tab and line breaks stay). */
export function stripHiddenChars(s: string): string {
  return HIDDEN_TEST.test(s) ? s.replace(HIDDEN_CHARS, '') : s;
}

/**
 * A copy of a plain value without the keys `__proto__`, `constructor` and `prototype` at any depth, and nothing deeper than
 * MAX_DEPTH (what is deeper is dropped). The key is dropped, not the object it sits in: the rest of the object is still usable.
 * Anything that is not plain data (a function, a symbol, a bigint) becomes undefined. Arrays keep their length. Every string
 * loses its XML-illegal and bidi control characters (`stripHiddenChars`).
 */
export function cleanPlain<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return stripHiddenChars(value) as T;
  if (value === null || typeof value !== 'object') {
    return (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ? undefined : value) as T;
  }
  if (depth >= MAX_DEPTH) return undefined as T;
  if (Array.isArray(value)) return value.map((x) => cleanPlain(x, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const v = cleanPlain((value as Record<string, unknown>)[key], depth + 1);
    if (v !== undefined) out[key] = v;
  }
  return out as T;
}

/** The types (Markdown block, table, code block) whose fields the relay knows no owner, tracker link or attribution for (server/sync-validate.mjs FIELDS: BOX only). */
const PLAIN_BOX_TYPES = new Set(['markdown', 'table', 'code']);
const OWNER_FIELDS = ['ownerId', 'ownerName', 'ownerKind'] as const;
const PART_LIKE = /^[rkwacf]:/;

/** The relay's cap for one object (server/sync-validate.mjs LIMITS.objectBytes). */
const TABLE_OBJECT_BYTES = 256 * 1024;

/**
 * Why a table cannot be imported, or null. A table has at most MAX_TABLE_ROWS rows and MAX_TABLE_COLS columns and MAX_TABLE_CHARS
 * characters of cell text, and the relay refuses one past that (`too_many_rows`, `too_many_columns`, `table_too_big`), so such a
 * table is refused here instead of being written and taken back. What the editor allows always fits one message: at most 6,190
 * keys (100 rows, 30 columns, 30 widths, 30 alignments, 3,000 cells, 3,000 fills) and under 256 KiB (the relay's cap for one object),
 * well inside IMPORT_CHUNK, so a table is never split between messages.
 */
export function tableProblem(o: { type?: unknown } & Record<string, unknown>): string | null {
  if (o.type !== 'table') return null;
  let rows = 0, cols = 0;
  for (const k of Object.keys(o)) {
    const kind = parseTableKey(k)?.kind;
    if (kind === 'r') rows++;
    else if (kind === 'k') cols++;
  }
  if (rows > MAX_TABLE_ROWS) return `a table with ${rows.toLocaleString('en-US')} rows (up to ${MAX_TABLE_ROWS})`;
  if (cols > MAX_TABLE_COLS) return `a table with ${cols.toLocaleString('en-US')} columns (up to ${MAX_TABLE_COLS})`;
  if (tableChars(o) > MAX_TABLE_CHARS) return `a table with more than ${MAX_TABLE_CHARS.toLocaleString('en-US')} characters of text`;
  if (estimate(o).bytes > TABLE_OBJECT_BYTES) return 'a table that is larger than one object may be';
  return null;
}

/** The first table in `objs` that cannot be imported, as a sentence ("a table with 101 rows (up to 100)"), or null. */
export function firstTableProblem(objs: readonly object[]): string | null {
  for (const o of objs) {
    const p = tableProblem(o as Record<string, unknown>);
    if (p) return p;
  }
  return null;
}

/**
 * The parts of a table object that are well-formed, in place: a key that looks like a part (`r:`, `k:`, `w:`, `a:`, `c:`, `f:`) but is
 * not one (`c:__proto__:x`, a long id), a part with a value of the wrong kind (a rank fractional-indexing rejects, a width that is not a
 * number, an alignment that is not left, center or right, a cell that is not text, a fill that is not a colour), and a cell or fill of a
 * row or column that does not exist are dropped; a width is kept within bounds and a cell is cut at MAX_CELL_CHARS characters.
 */
function cleanTableParts(o: Record<string, unknown>): void {
  const rows = new Set<string>();
  const cols = new Set<string>();
  for (const k of Object.keys(o)) {
    const p = parseTableKey(k);
    if (p?.kind === 'r' && isValidRank(o[k])) rows.add(p.id);
    else if (p?.kind === 'k' && isValidRank(o[k])) cols.add(p.id);
  }
  for (const k of Object.keys(o)) {
    if (!PART_LIKE.test(k)) continue;
    const p = parseTableKey(k);
    const v = o[k];
    let keep: unknown;
    if (!p) keep = undefined;
    else if (!('rowId' in p)) {
      if (p.kind === 'w') keep = typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, v)) : undefined;
      else if (p.kind === 'a') keep = (ALIGNS as readonly unknown[]).includes(v) ? v : undefined;
      else keep = isValidRank(v) ? v : undefined; // a row or column rank
    } else if (!rows.has(p.rowId) || !cols.has(p.colId)) keep = undefined;
    else if (p.kind === 'c') keep = typeof v === 'string' ? ([...v].length > MAX_CELL_CHARS ? [...v].slice(0, MAX_CELL_CHARS).join('') : v) : undefined;
    else keep = typeof v === 'string' && v && cleanColor(v) !== null ? v : undefined;
    if (keep === undefined) delete o[k];
    else o[k] = keep;
  }
}

/**
 * The fields of a code block in place (docs/code-blocks.md): the language is one of the shared list (plain text when it is not), the
 * code is cut at MAX_CODE_CHARS (control, zero-width and bidirectional characters are already gone: `cleanPlain`), the title is one
 * plain line of at most MAX_CODE_TITLE characters, and `lines` and `wrap` are booleans or absent.
 */
function cleanCodeFields(o: Record<string, unknown>): void {
  o.lang = normaliseCodeLang(o.lang) ?? DEFAULT_CODE_LANG;
  if (typeof o.text === 'string' && o.text.length > MAX_CODE_CHARS) o.text = [...o.text].slice(0, MAX_CODE_CHARS).join('');
  if (typeof o.title === 'string') Object.assign(o, { title: [...o.title.replace(/\s+/g, ' ').trim()].slice(0, MAX_CODE_TITLE).join('') }); // a data field, not an element's tooltip
  else delete o.title;
  for (const k of ['lines', 'wrap']) if (k in o && typeof o[k] !== 'boolean') delete o[k];
}

// ---------------------------------------------------------------- links

/** Whether a link target may be followed: http(s) (shared/containers.mjs isSafeHttpUrl), mailto: and #obj:<id>. */
export function isSafeLinkTarget(target: string): boolean {
  const t = target.trim();
  return isSafeHttpUrl(t) || /^mailto:[^\s@<>]+@[^\s@<>]+$/i.test(t) || /^#obj:[A-Za-z0-9_-]{1,64}$/.test(t);
}

const MD_LINK = /(!?)\[([^\]\n]{0,2000})\]\(((?:[^()\n]|\([^()\n]{0,2100}\)){0,2100})\)/g;
const ASSET_IMAGE = /^asset:[0-9a-f]{64}$/;

/** Markdown text whose links point only at http(s), mailto: and #obj: addresses: any other target (javascript:, data:, vbscript:, …) leaves just the link text. */
export function cleanMarkdownLinks(text: string): string {
  if (!text.includes('](')) return text;
  return text.replace(MD_LINK, (whole, bang: string, label: string, target: string) => {
    const t = target.replace(/\\(.)/g, '$1');
    if (bang ? ASSET_IMAGE.test(t.trim()) : isSafeLinkTarget(t)) return whole;
    return `${bang}${label}`;
  });
}

/** The address fields of an object in place: `link` (a card), `url` and `finalUrl` (a link card) are kept only when they are http(s) addresses; a Markdown block's links and a table's cells likewise. */
function cleanLinkFields(o: Record<string, unknown>): void {
  for (const f of ['link', 'url', 'finalUrl', 'extUrl']) if (f in o && !isSafeHttpUrl(o[f])) delete o[f];
  if (o.type === 'markdown' && typeof o.text === 'string') o.text = cleanMarkdownLinks(o.text);
  if (o.type === 'table') for (const k of Object.keys(o)) if (parseTableKey(k)?.kind === 'c' && typeof o[k] === 'string') o[k] = cleanMarkdownLinks(o[k] as string);
}

// ---------------------------------------------------------------- templates

const T_COMMON = ['id', 'type', 'x', 'y', 'w', 'h', 'rotation', 'z', 'parent', 'flipX', 'flipY', 'text', 'name', 'fill', 'stroke', 'textColor', 'strokeWidth', 'dash', 'opacity', 'font', 'fontWeight', 'fontSize', 'align', 'valign', 'lineHeight'];
const T_CONNECTOR = ['id', 'type', 'z', 'from', 'to', 'route', 'startHead', 'endHead', 'line', 'relation', 'label', 'stroke', 'strokeWidth', 'dash', 'opacity', 'parent', 'name', 'x', 'y', 'w', 'h', 'rotation', 'font', 'fontSize', 'fontWeight', 'textColor', 'align', 'valign'];
const TEMPLATE_KEYS: Record<string, ReadonlySet<string>> = {
  shape: new Set([...T_COMMON, 'kind']),
  icon: new Set([...T_COMMON, 'ref', 'body', 'viewBox', 'sticker']),
  path: new Set([...T_COMMON, 'points']),
  link: new Set([...T_COMMON, 'url', 'title', 'description', 'siteName', 'finalUrl', 'unfurl', 'unfurlError', 'fetchedAt', 'edited']),
  table: new Set([...T_COMMON, 'headerRow', 'headerCol']),
  code: new Set([...T_COMMON, 'lang', 'title', 'lines', 'wrap']),
  'uml-class': new Set([...T_COMMON, 'stereotype', 'attributes', 'operations']),
  group: new Set(['id', 'type', 'x', 'y', 'w', 'h', 'rotation', 'z', 'parent', 'name']),
  connector: new Set(T_CONNECTOR),
};
const T_PLAIN = new Set(T_COMMON); // sticky, text, frame, markdown and the other UML boxes
/** Types a template keeps as the kanban rules rebuild them (shared/containers.mjs templateKanbanFields). */
const KANBAN_TEMPLATE_TYPES = new Set(['container', 'lane', 'card']);

/**
 * Whether a template may carry the key `key` on an object of `type`: the one allow-list for what a template holds, per type. A
 * table's rows, columns, widths, alignments, cells and fills are the keys `r:`, `k:`, `w:`, `a:`, `c:`, `f:` of shared/tables.mjs
 * (checked by `parseTableKey`); a Markdown block holds the common fields and its text. Kanban objects (container, lane, card)
 * return true: their fields are rebuilt by the kanban rules.
 */
export function isTemplateKey(type: string, key: string): boolean {
  if (KANBAN_TEMPLATE_TYPES.has(type)) return true;
  if (FORBIDDEN_KEYS.has(key)) return false;
  if (type === 'table' && parseTableKey(key)) return true;
  return (TEMPLATE_KEYS[type] ?? T_PLAIN).has(key);
}

/**
 * An object of a template (a file, a saved or shared template, the server's answer) as the board may take it. Only the keys of
 * its type stay (`isTemplateKey`); a template names no people and carries no authorship, tracker link, lock, hidden mark or
 * private step, so those are gone; forbidden keys and XML-illegal or bidi control characters are removed at any depth; `url`,
 * `finalUrl` and a link card's address stay only as http(s) addresses; Markdown links and table cells keep only http(s), mailto:
 * and #obj: targets; a table keeps only well-formed parts. Kanban objects keep their fields, minus the same unsafe ones, as the kanban
 * rules (shared/containers.mjs) have already rebuilt them. Returns a copy.
 */
export function sanitizeTemplateObject<T extends object>(src: T): T {
  const o = cleanPlain({ ...src }) as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : '';
  for (const key of Object.keys(o)) if (!isTemplateKey(type, key)) delete o[key];
  if (KANBAN_TEMPLATE_TYPES.has(type)) {
    for (const f of [...OWNER_FIELDS, ...TRACKER_CARD_FIELDS, 'createdBy', 'proposedBy', 'privateStep', 'locked', 'hidden', 'updatedAt']) delete o[f];
  }
  if (type === 'table') cleanTableParts(o);
  if (type === 'code') cleanCodeFields(o);
  cleanLinkFields(o);
  return o as unknown as T;
}

const TRACKER_CARD_FIELDS = ['ext', 'extProvider', 'extKey', 'extUrl', 'trackerId', 'tracker', 'trackerUnmappedState'] as const;
const TRACKER_FRAME_FIELDS = ['trackerId', 'viewId', 'focusKey'] as const;

export interface SanitizeOptions {
  /** `drop` (a file from someone else) removes `proposedBy`; `keep` (a paste) keeps it in its one clean shape. Default `drop`. */
  proposedBy?: 'keep' | 'drop';
}

/**
 * Objects as they may be written by `importerId`: forbidden keys removed at any depth, authored by the importer, an owner who
 * is not a member of the target board cleared (the owner's name stays as text, an agent owner is dropped with its kind; this also
 * covers a member who has since left, whose id the board no longer knows), and the tracker link of a card, a kanban or a
 * tracker frame left behind. Returns copies; the input is not changed.
 */
export function sanitizeImportedObjects<T extends Obj>(objs: readonly T[], importerId: string, isMember: IsMember = (id) => id === importerId, options: SanitizeOptions = {}): T[] {
  return objs.map((src) => {
    const o = cleanPlain({ ...src }) as Record<string, unknown>;
    o.createdBy = importerId;
    if (typeof o.ownerId === 'string' && !(o.ownerId === importerId || isMember(o.ownerId))) delete o.ownerId;
    else if (o.ownerId !== undefined && typeof o.ownerId !== 'string') delete o.ownerId;
    if (o.ownerKind === 'agent' && o.ownerId === undefined) delete o.ownerKind;
    if (o.ownerId === undefined && !o.ownerName) delete o.ownerKind;
    if (PLAIN_BOX_TYPES.has(o.type as string)) {
      // a Markdown block and a table carry no owner or tracker link (the relay would call them unknown fields): only the author stays
      for (const f of OWNER_FIELDS) delete o[f];
      for (const f of TRACKER_CARD_FIELDS) delete o[f];
      for (const f of TRACKER_FRAME_FIELDS) delete o[f];
      if (o.type === 'table') cleanTableParts(o);
      if (o.type === 'code') cleanCodeFields(o);
    }
    cleanLinkFields(o);
    if (o.type === 'card' || o.type === 'container') for (const f of TRACKER_CARD_FIELDS) delete o[f];
    if (o.type === 'tracker') for (const f of TRACKER_FRAME_FIELDS) delete o[f];
    if (options.proposedBy === 'keep') {
      const clean = cleanProposedBy(o.proposedBy);
      if (clean) o.proposedBy = clean;
      else delete o.proposedBy;
    } else delete o.proposedBy;
    return o as unknown as T;
  });
}

export interface ImportedState {
  objects: Obj[];
  meta?: Record<string, unknown>;
  flow?: Record<string, unknown>;
  votes?: Record<string, Vote>;
  polls?: Poll[];
  pollAnswers?: PollAnswer[];
  pollState?: Record<string, unknown>;
  labels?: Record<string, unknown>;
}

/**
 * A whole imported board as the importer may write it. Objects as above; every other part is cleaned of forbidden keys; polls are
 * the importer's; a vote or a poll answer stays only when it is the importer's own (the others name people who are not on this
 * board); the session's focus request (`flow.focus`, a view of the source board by someone else) is dropped.
 */
export function sanitizeImportedState(state: ImportedState, importerId: string, isMember?: IsMember): ImportedState {
  const out: ImportedState = { ...cleanPlain({ ...state, objects: [] }), objects: sanitizeImportedObjects(state.objects, importerId, isMember) };
  if (out.flow) {
    const { focus: _focus, ...flow } = out.flow;
    out.flow = flow;
  }
  if (out.polls) out.polls = out.polls.map((p) => ({ ...p, createdBy: importerId }));
  if (out.pollAnswers) out.pollAnswers = out.pollAnswers.filter((a) => a.userId === importerId);
  if (out.votes) out.votes = Object.fromEntries(Object.entries(out.votes).filter(([, v]) => v.userId === importerId));
  return out;
}

// ---------------------------------------------------------------- message size

/** What one message may hold. The relay's budget is 2 MiB and 50,000 values (server/sync-guard.mjs); these keep a margin. */
export const IMPORT_CHUNK: Readonly<{ bytes: number; values: number }> = Object.freeze({ bytes: 1024 * 1024, values: 25_000 });

/** The bytes of `s` in UTF-8 (what a message carries), counted without building the bytes. */
function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x7f) continue;
    // 2 bytes up to U+07FF; 3 bytes for the rest of the BMP; a surrogate pair is 4 bytes for two units (+1 each)
    n += c <= 0x7ff ? 1 : c >= 0xd800 && c <= 0xdfff ? 1 : 2;
  }
  return n;
}

/**
 * An estimate of the serialized size and the number of values in `value` (strings by UTF-8 length, numbers 8, keys length + 3).
 * Every key of an object is a value of its own, so a table (one object with a key per row, column, width and cell) counts every
 * part, and the bytes of every cell's text and key.
 */
export function estimate(value: unknown): { bytes: number; values: number } {
  let bytes = 0;
  let values = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    values++;
    if (typeof v === 'string') bytes += utf8Length(v) + 2;
    else if (v === null || typeof v !== 'object') bytes += 8;
    else if (Array.isArray(v)) {
      bytes += 2;
      for (const x of v) stack.push(x);
    } else {
      bytes += 2;
      for (const k of Object.keys(v)) {
        bytes += utf8Length(k) + 3;
        stack.push((v as Record<string, unknown>)[k]);
      }
    }
  }
  return { bytes, values };
}

export interface Chunk<T> { items: T[]; bytes: number; values: number }

/**
 * Cuts `items` into chunks that stay within `limits` (an item that is alone larger than the limits gets a chunk of its own).
 * `groupOf` says which items must travel together: items with the same group key are never split and are written in the same
 * message, in their order.
 */
export function planChunks<T>(items: readonly T[], size: (item: T) => { bytes: number; values: number }, groupOf: (item: T) => string, limits = IMPORT_CHUNK): Chunk<T>[] {
  const groups = new Map<string, Chunk<T>>();
  for (const item of items) {
    const g = groupOf(item);
    let chunk = groups.get(g);
    if (!chunk) groups.set(g, (chunk = { items: [], bytes: 0, values: 0 }));
    const s = size(item);
    chunk.items.push(item);
    chunk.bytes += s.bytes;
    chunk.values += s.values;
  }
  const chunks: Chunk<T>[] = [];
  let current: Chunk<T> = { items: [], bytes: 0, values: 0 };
  for (const g of groups.values()) {
    if (current.items.length && (current.bytes + g.bytes > limits.bytes || current.values + g.values > limits.values)) {
      chunks.push(current);
      current = { items: [], bytes: 0, values: 0 };
    }
    current.items.push(...g.items);
    current.bytes += g.bytes;
    current.values += g.values;
  }
  if (current.items.length) chunks.push(current);
  return chunks;
}

interface Linked { id: string; parent?: string; from?: { kind?: string; id?: string }; to?: { kind?: string; id?: string } }

/**
 * The group key of every object: an object, its parent chain and every connector bound to any of them share one key, so a group
 * keeps its members (the store removes an empty group), a kanban its lanes and cards, and a connector its two ends. Union-find
 * over parent links and connector ends.
 */
export function familyKeys(objs: readonly Linked[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const o of objs) parent.set(o.id, o.id);
  for (const o of objs) {
    if (o.parent) union(o.id, o.parent);
    if (o.from?.kind === 'bound' && o.from.id) union(o.id, o.from.id);
    if (o.to?.kind === 'bound' && o.to.id) union(o.id, o.to.id);
  }
  const out = new Map<string, string>();
  for (const o of objs) out.set(o.id, find(o.id));
  return out;
}

/** Objects cut into chunks within the message budget, keeping families (parents, children, connector ends) together. */
export function chunkObjects<T extends Linked>(objs: readonly T[], limits = IMPORT_CHUNK): Chunk<T>[] {
  const keys = familyKeys(objs);
  return planChunks(objs, estimate, (o) => keys.get(o.id) ?? o.id, limits);
}

/** The keys of a state, cut into chunks within the budget: `entries` of one map, written one chunk at a time. */
export function chunkEntries(entries: readonly [string, unknown][], limits = IMPORT_CHUNK): Chunk<[string, unknown]>[] {
  return planChunks(entries, ([k, v]) => estimate([k, v]), ([k]) => k, limits);
}
