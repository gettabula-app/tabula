// Board chat, the parts with no DOM, no network and no storage (docs/chat.md): merging what the server sends, the
// outbox, grouping the list into rows, finding links and mentions, and the composer's `@` list. src/chat.ts and
// src/ui/chat.ts do the I/O around it.

import type { ChatChannelEntry, ChatMessage } from '../api';

/** Messages per page, as the server's default. */
export const PAGE = 50;
/** Messages kept in the browser's list per channel (docs/chat.md, Limits). */
export const KEEP_IN_LIST = 1000;
/** Messages cached for reading offline per opened channel. */
export const CACHE_PER_CHANNEL = 50;
/** A run of messages by one person within this time shows the name and time once. */
export const GROUP_MS = 5 * 60_000;
export const MAX_TEXT = 2000;
export const MAX_MENTIONS = 10;
export const QUOTE_CHARS = 80;
/** The server's shape for a client-made message id. */
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MENTION_RE = /@\{([A-Za-z0-9_-]{1,64})\}/g;

// ---------------------------------------------------------------- ids

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 22 random characters of the server's clientId alphabet (132 bits). Works outside a secure context too. */
export function newClientId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(22)].map((b) => ID_ALPHABET[b & 63]).join('');
}

export const isClientId = (value: unknown): value is string => typeof value === 'string' && CLIENT_ID_RE.test(value);

// ---------------------------------------------------------------- merging

/**
 * Which of two copies of one message to keep. A frame and a page can arrive in either order, so the newer state wins:
 * a tombstone over live text, a later edit over an earlier one, and otherwise the incoming copy.
 */
export function newer(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (current.deleted && !incoming.deleted) return current;
  if (incoming.deleted && !current.deleted) return incoming;
  if ((incoming.editedAt ?? 0) < (current.editedAt ?? 0)) return current;
  return incoming;
}

/** The list with `incoming` merged in by id (duplicates ignored), in the server's order: by id, never by a clock. */
export function mergeMessages(list: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return list.slice();
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) {
    const have = byId.get(m.id);
    byId.set(m.id, have ? newer(have, m) : m);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** A delete frame: the message becomes a tombstone with no text. Unknown ids change nothing. */
export function applyDelete(list: readonly ChatMessage[], id: number, by: 'author' | 'moderator'): ChatMessage[] {
  return list.map((m) => (m.id === id && !m.deleted ? { ...m, text: '', mentions: [], deleted: true, deletedBy: by } : m));
}

/** Keeps the newest `max` messages. */
export const trimOldest = (list: readonly ChatMessage[], max = KEEP_IN_LIST): ChatMessage[] => (list.length > max ? list.slice(list.length - max) : list.slice());

export const newestId = (list: readonly ChatMessage[]): number => (list.length ? list[list.length - 1].id : 0);
export const oldestId = (list: readonly ChatMessage[]): number => (list.length ? list[0].id : 0);

/** Unread for this person: after their marker, not deleted, not their own. */
export const countUnread = (list: readonly ChatMessage[], lastRead: number, meId: string): number =>
  list.filter((m) => m.id > lastRead && !m.deleted && m.authorId !== meId).length;

// ---------------------------------------------------------------- outbox

export type OutboxState = 'queued' | 'sending' | 'failed' | 'blocked';

/** A message on its way to the server. Kept in IndexedDB until the server has it or the person discards it. */
export interface OutboxItem {
  clientId: string;
  kind: string;
  ref: string;
  text: string;
  replyTo: number | null;
  objectId: string | null;
  createdLocal: number;
  state: OutboxState;
  /** Why it was not sent: shown under the message. */
  reason?: string;
  /** A 429 asked to wait until this time before the next try. */
  waitUntil?: number;
}

export function outboxItem(fields: { clientId: string; kind: string; ref: string; text: string; replyTo?: number | null; objectId?: string | null; createdLocal: number }): OutboxItem {
  return { replyTo: null, objectId: null, ...fields, state: 'queued' };
}

const byAge = (a: OutboxItem, b: OutboxItem) => a.createdLocal - b.createdLocal || (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0);

/** Adds an item, once per clientId. */
export function enqueue(outbox: readonly OutboxItem[], item: OutboxItem): OutboxItem[] {
  if (outbox.some((o) => o.clientId === item.clientId)) return outbox.slice();
  return [...outbox, item].sort(byAge);
}

/**
 * The item to send next: the oldest one that is not refused for good. Nothing while one is on its way (one at a time)
 * or while the oldest must wait (so a later message never overtakes an earlier one).
 */
export function nextToSend(outbox: readonly OutboxItem[], now: number): OutboxItem | null {
  for (const item of [...outbox].sort(byAge)) {
    if (item.state === 'blocked') continue;
    if (item.state === 'sending') return null;
    if (item.waitUntil !== undefined && item.waitUntil > now) return null;
    return item;
  }
  return null;
}

export const updateItem = (outbox: readonly OutboxItem[], clientId: string, patch: Partial<OutboxItem>): OutboxItem[] =>
  outbox.map((o) => (o.clientId === clientId ? { ...o, ...patch } : o));

export const removeItem = (outbox: readonly OutboxItem[], clientId: string): OutboxItem[] => outbox.filter((o) => o.clientId !== clientId);

/** Items the server already has: a message of this person in the same channel with the same clientId. */
export function delivered(outbox: readonly OutboxItem[], messages: readonly ChatMessage[], meId: string): OutboxItem[] {
  const seen = new Set(messages.filter((m) => m.authorId === meId).map((m) => `${m.kind}/${m.ref}/${m.clientId}`));
  return outbox.filter((o) => seen.has(`${o.kind}/${o.ref}/${o.clientId}`));
}

/** Items loaded from storage: one that was on its way when the page closed goes back in the queue. */
export const revive = (items: readonly OutboxItem[]): OutboxItem[] =>
  items.map((o) => (o.state === 'sending' ? { ...o, state: 'queued' as const } : o)).sort(byAge);

export type Failure =
  | { kind: 'retry' }
  | { kind: 'wait'; ms: number }
  | { kind: 'signed-out' }
  | { kind: 'permanent'; reason: string };

const TEXT_REASONS: Record<string, string> = {
  empty: 'the message is empty',
  too_long: 'a message can be at most 2000 characters',
  too_many_mentions: 'a message can mention at most 10 people',
};

/**
 * What a failed send means. No answer or a server error: try again later. 429: wait as long as the server said. 401:
 * stop until the person signs in again. 400, 402, 403 and 404 never succeed by retrying, so the text stays with the
 * reason until the person copies or discards it.
 */
export function classifyFailure(status: number, code: string, retryAfter?: number): Failure {
  if (status === 0 || status >= 500 || status === 408) return { kind: 'retry' };
  if (status === 429) return { kind: 'wait', ms: Math.max(1, retryAfter ?? 5) * 1000 };
  if (status === 401) return { kind: 'signed-out' };
  if (status === 400) return { kind: 'permanent', reason: TEXT_REASONS[code] ?? 'the server could not read it' };
  if (status === 402) return { kind: 'permanent', reason: 'the workspace is read-only' };
  if (status === 403) return { kind: 'permanent', reason: code === 'read_only_viewer' ? 'viewers cannot post in this chat' : 'you cannot post in this chat' };
  if (status === 404) return { kind: 'permanent', reason: 'you no longer have access to this chat' };
  return { kind: 'permanent', reason: 'the server refused it' };
}

/** How long to wait before reconnecting or retrying after `attempt` failures: doubling from 1 s to 30 s, with jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 15)));
  return Math.round(base * (0.5 + random() / 2));
}

// ---------------------------------------------------------------- rows

export type Row =
  | { type: 'day'; key: string; label: string }
  | { type: 'new'; key: string }
  | { type: 'message'; key: string; message: ChatMessage; head: boolean }
  | { type: 'pending'; key: string; item: OutboxItem; head: boolean };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A local calendar day. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "Today", "Yesterday", or "Monday 12 January 2026", in local time. */
export function dayLabel(ts: number, now: number): string {
  if (dayKey(ts) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday';
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "09:05", 24-hour local time. */
export function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface Speaker { authorId: string | null; at: number; day: string }

/**
 * The list as rows: a date line where the day changes, a "New messages" line before the first unread message of
 * someone else after `newAfter`, and each message with `head` true where its run starts (another person, more than five
 * minutes, a new day or a line in between). The person's unsent messages follow, oldest first.
 */
export function buildRows(messages: readonly ChatMessage[], pending: readonly OutboxItem[], opts: { newAfter: number | null; meId: string; now: number }): Row[] {
  const rows: Row[] = [];
  let prev: Speaker | null = null;
  let day = '';
  let marked = false;
  const startsRun = (who: Speaker) => !prev || prev.authorId === null || prev.authorId !== who.authorId || prev.day !== who.day || who.at - prev.at >= GROUP_MS;
  const dayLine = (ts: number) => {
    const key = dayKey(ts);
    if (key === day) return;
    day = key;
    rows.push({ type: 'day', key: `day:${key}`, label: dayLabel(ts, opts.now) });
    prev = null;
  };
  for (const m of messages) {
    dayLine(m.createdAt);
    if (!marked && opts.newAfter !== null && m.id > opts.newAfter && m.authorId !== opts.meId && !m.deleted) {
      marked = true;
      rows.push({ type: 'new', key: 'new' });
      prev = null;
    }
    const who: Speaker = { authorId: m.authorId, at: m.createdAt, day };
    rows.push({ type: 'message', key: `m:${m.id}`, message: m, head: startsRun(who) });
    prev = m.deleted ? null : who;
  }
  for (const item of [...pending].sort(byAge)) {
    dayLine(item.createdLocal);
    const who: Speaker = { authorId: opts.meId, at: item.createdLocal, day };
    rows.push({ type: 'pending', key: `p:${item.clientId}`, item, head: startsRun(who) });
    prev = who;
  }
  return rows;
}

// ---------------------------------------------------------------- text

// The same rules as findLinks in server/chat-text.mjs (docs/chat.md, Security): http and https only, running to the next
// whitespace, closing punctuation left outside, a ')' kept when it closes a '(' inside the address.
const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;
const TRAILING = /[.,:;!?'")\]}]+$/;

export function findLinks(text: string): { start: number; end: number; url: string }[] {
  const links: { start: number; end: number; url: string }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(TRAILING, '');
    while (m[0].length > url.length && m[0][url.length] === ')' && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) {
      url += ')';
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) continue;
    links.push({ start: m.index ?? 0, end: (m.index ?? 0) + url.length, url });
  }
  return links;
}

export type Segment = { type: 'text'; text: string } | { type: 'link'; url: string } | { type: 'mention'; id: string; name: string | null };

/**
 * A message's text as pieces to build with textContent: plain text, links and mentions. A mention's name comes from
 * the message's validated mention list, never from the text; a token for someone not in it shows as "someone".
 */
export function segments(text: string, mentions: readonly { id: string; name: string | null }[]): Segment[] {
  const names = new Map(mentions.map((p) => [p.id, p.name]));
  const out: Segment[] = [];
  const pushText = (chunk: string) => {
    let at = 0;
    for (const link of findLinks(chunk)) {
      if (link.start > at) out.push({ type: 'text', text: chunk.slice(at, link.start) });
      out.push({ type: 'link', url: link.url });
      at = link.end;
    }
    if (at < chunk.length) out.push({ type: 'text', text: chunk.slice(at) });
  };
  let at = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > at) pushText(text.slice(at, start));
    out.push({ type: 'mention', id: m[1], name: names.has(m[1]) ? (names.get(m[1]) ?? null) : null });
    at = start + m[0].length;
  }
  if (at < text.length) pushText(text.slice(at));
  return out;
}

/** How a mention reads: the person's current name, "Former member" once they are gone, "someone" for a stray token. */
export function mentionLabel(seg: { id: string; name: string | null }, known: boolean): string {
  if (seg.name) return `@${seg.name}`;
  return known ? '@Former member' : '@someone';
}

/** One line to quote a message in a reply: its first 80 characters with mentions as names. */
export function quoteText(m: Pick<ChatMessage, 'text' | 'mentions' | 'deleted'>): string {
  if (m.deleted) return 'Message deleted';
  const flat = segments(m.text, m.mentions)
    .map((s) => (s.type === 'text' ? s.text : s.type === 'link' ? s.url : mentionLabel(s, m.mentions.some((p) => p.id === s.id))))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...flat];
  return chars.length > QUOTE_CHARS ? `${chars.slice(0, QUOTE_CHARS).join('').trimEnd()}…` : flat;
}

/** Initials for a colour square: the first letters of the first two words. */
export function initials(name: string): string {
  const letters = name.trim().split(/\s+/).filter(Boolean).map((w) => [...w][0] ?? '').join('');
  return ([...letters].slice(0, 2).join('') || '?').toUpperCase();
}

/** A stable colour index for a person id, so one person has one colour in every list. */
export function colourIndex(id: string | null, count: number): number {
  if (!id || count <= 0) return 0;
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % count;
}

/** Characters as the server counts them (code points), after mentions become tokens. */
export const textLength = (text: string): number => [...text].length;

// ---------------------------------------------------------------- mentions in the composer

export interface Person { id: string; name: string }

/** The `@` word being typed at the caret: its start (the `@`) and the letters after it, or null. */
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'“‘]/u.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 32 || /[\s@{}]/u.test(query)) return null;
  return { start: at, query };
}

/** People whose name matches what was typed: names starting with it first, then any word starting with it. Not oneself. */
export function filterPeople(people: readonly Person[], query: string, meId: string, limit = 8): Person[] {
  const q = query.toLocaleLowerCase();
  const others = people.filter((p) => p.id !== meId);
  const starts = others.filter((p) => p.name.toLocaleLowerCase().startsWith(q));
  const words = others.filter((p) => !starts.includes(p) && p.name.toLocaleLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  return [...starts, ...words].slice(0, limit);
}

/** Replaces the `@query` from `start` to the caret with `@Name ` and puts the caret after it. */
export function insertMention(value: string, start: number, caret: number, name: string): { value: string; caret: number } {
  const inserted = `@${name} `;
  const rest = value.slice(caret).replace(/^ /, '');
  return { value: value.slice(0, start) + inserted + rest, caret: start + inserted.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text to send: every `@Name` of a person picked in this message becomes the server's token `@{id}`. Longer names
 * are matched first, so "@Ana Lima" is not read as "@Ana". A name typed but not picked stays plain text.
 */
export function toTokens(text: string, picked: readonly Person[]): string {
  const people = [...new Map(picked.map((p) => [p.name, p])).values()].filter((p) => p.name.trim());
  if (!people.length) return text;
  people.sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`@(${people.map((p) => escapeRe(p.name)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  const byName = new Map(people.map((p) => [p.name, p.id]));
  return text.replace(re, (whole, name: string) => {
    const id = byName.get(name);
    return id ? `@{${id}}` : whole;
  });
}

/** The editable form of a stored text: tokens become `@Name` again, with the people they name. */
export function fromTokens(text: string, mentions: readonly { id: string; name: string | null }[]): { text: string; picked: Person[] } {
  const picked: Person[] = [];
  const names = new Map(mentions.map((p) => [p.id, p.name]));
  const out = text.replace(MENTION_RE, (_whole, id: string) => {
    const name = names.get(id);
    if (!name) return '@someone';
    if (!picked.some((p) => p.id === id)) picked.push({ id, name });
    return `@${name}`;
  });
  return { text: out, picked };
}

// ---------------------------------------------------------------- what the person may do

export interface ChatAccess { write: boolean; moderate: boolean; role: string | null; readOnly: boolean }

/** Whether the composer is usable, and the sentence that says why not. Offline still composes, into the outbox. */
export function composerState(access: ChatAccess | null, opts: { lost: boolean; signedOut: boolean }): { enabled: boolean; reason: string | null } {
  if (opts.signedOut) return { enabled: false, reason: 'Sign in again to post.' };
  if (opts.lost) return { enabled: false, reason: 'You no longer have access to this chat.' };
  if (!access) return { enabled: false, reason: null };
  if (access.readOnly) return { enabled: false, reason: 'This workspace is read-only. You can read the chat but not post.' };
  if (!access.write) return { enabled: false, reason: access.role === 'viewer' ? 'Viewers can read this chat but not post.' : 'You can read this chat but not post.' };
  return { enabled: true, reason: null };
}

/** Edit: the author, online, while they may write. */
export const canEdit = (m: ChatMessage, meId: string, access: ChatAccess | null, online: boolean): boolean =>
  online && !m.deleted && m.authorId === meId && access?.write === true;

/** Delete: the author or a moderator, online, while the workspace is not read-only. */
export const canDelete = (m: ChatMessage, meId: string, access: ChatAccess | null, online: boolean): boolean =>
  online && !m.deleted && access !== null && !access.readOnly && (m.authorId === meId || access.moderate);

/** Within `slack` px of the bottom of a scrolled list. */
export const atBottom = (scrollTop: number, scrollHeight: number, clientHeight: number, slack = 24): boolean =>
  scrollHeight - scrollTop - clientHeight <= slack;

// ---------------------------------------------------------------- remembered open or closed

/** The localStorage key for whether one person had one board's chat open (driftboard prefix, as every stored id). */
export const chatOpenKey = (userId: string, boardId: string): string => `driftboard:chat:${userId}:${boardId}`;

// ---------------------------------------------------------------- the Chat page's channel list

export type ChannelKind = ChatChannelEntry['kind'];

export interface ChannelSection {
  id: 'workspace' | 'teams' | 'other-teams' | 'boards';
  title: string;
  entries: ChatChannelEntry[];
}

const byName = (a: ChatChannelEntry, b: ChatChannelEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.ref < b.ref ? -1 : 1);
const byRecent = (a: ChatChannelEntry, b: ChatChannelEntry) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || byName(a, b);

/**
 * The channel list as sections, in the order people look for things: the workspace, their teams (recent first, archived
 * last), the teams a workspace owner or admin may read without belonging to, then boards whose chat is recent. Empty
 * sections are left out.
 */
export function groupChannels(entries: readonly ChatChannelEntry[]): ChannelSection[] {
  const workspace = entries.filter((e) => e.kind === 'workspace');
  const teams = entries.filter((e) => e.kind === 'team' && e.member !== false);
  const live = teams.filter((e) => !e.archived).sort(byRecent);
  const archived = teams.filter((e) => e.archived).sort(byRecent);
  const others = entries.filter((e) => e.kind === 'team' && e.member === false).sort(byName);
  const boards = entries.filter((e) => e.kind === 'board').sort(byRecent);
  const sections: ChannelSection[] = [
    { id: 'workspace', title: 'Workspace', entries: workspace },
    { id: 'teams', title: 'Teams', entries: [...live, ...archived] },
    { id: 'other-teams', title: 'Other teams', entries: others },
    { id: 'boards', title: 'Boards', entries: boards },
  ];
  return sections.filter((s) => s.entries.length > 0);
}

/** The address of a channel on the Chat page. */
export const channelHash = (kind: ChannelKind, ref: string): string => `#/chat/${kind}/${ref}`;

/** The first channel to show when the address names none: the one with a mention, else the most unread, else the first listed. */
export function defaultChannel(sections: readonly ChannelSection[], unreadOf: (e: ChatChannelEntry) => { unread: number; mentions: number }): ChatChannelEntry | null {
  const all = sections.flatMap((s) => s.entries);
  let best: ChatChannelEntry | null = null;
  let score = 0;
  for (const e of all) {
    const u = unreadOf(e);
    const s = u.mentions * 1_000_000 + u.unread;
    if (s > score) {
      best = e;
      score = s;
    }
  }
  return best ?? all[0] ?? null;
}

/** "99+" past two digits. */
export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n));

const KIND_LABEL: Record<ChannelKind, string> = { workspace: 'Workspace', team: 'Team', board: 'Board' };

/** What a screen reader hears for a channel row: its name, what kind it is and what is unread. */
export function channelLabel(e: ChatChannelEntry, c: { unread: number; mentions: number }): string {
  const parts = [e.name, KIND_LABEL[e.kind] + (e.archived ? ', archived' : '')];
  if (c.unread) parts.push(`${c.unread} unread${c.mentions ? `, ${c.mentions} mentioning you` : ''}`);
  return parts.join(', ');
}

/** The small line under a channel's name: what kind it is and when it last had a message. */
export function channelMeta(e: ChatChannelEntry, now: number): string {
  const kind = e.kind === 'board' ? 'Board' : e.kind === 'team' ? (e.member === false ? 'Team, not a member' : 'Team') : 'Everyone';
  const state = e.archived ? ' · archived' : '';
  if (e.lastAt === null) return `${kind}${state}`;
  const days = Math.floor((now - e.lastAt) / 86_400_000);
  const when = days <= 0 ? timeLabel(e.lastAt) : days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : new Date(e.lastAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${kind}${state} · ${when}`;
}

// ---------------------------------------------------------------- reactions

/** The small fixed set (docs/chat.md, Messages), in the order the server lists them. */
export const CHAT_REACTIONS = ['👍', '❤️', '😄', '🎉', '👀', '✅'] as const;

export interface ReactionChip {
  emoji: string;
  count: number;
  mine: boolean;
  /** What a screen reader hears for the chip. */
  label: string;
}

/** A message's reactions as chips: the set's order, how many, and whether this person is one of them. */
export function reactionChips(m: Pick<ChatMessage, 'reactions'>, meId: string): ReactionChip[] {
  return (m.reactions ?? [])
    .filter((r) => r.userIds.length > 0)
    .sort((a, b) => CHAT_REACTIONS.indexOf(a.emoji as never) - CHAT_REACTIONS.indexOf(b.emoji as never))
    .map((r) => {
      const mine = r.userIds.includes(meId);
      const n = r.userIds.length;
      return { emoji: r.emoji, count: n, mine, label: `${r.emoji}, ${n} ${n === 1 ? 'person' : 'people'}${mine ? `, including you` : ''}` };
    });
}

/** The list with one message's reactions replaced (a frame or an answer). A message that is not in the list changes nothing. */
export function withReactions(messages: readonly ChatMessage[], id: number, reactions: { emoji: string; userIds: string[] }[]): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, reactions } : m));
}

/** Whether this person has reacted to the message with `emoji`. */
export const reactedWith = (m: Pick<ChatMessage, 'reactions'>, meId: string, emoji: string): boolean =>
  (m.reactions ?? []).some((r) => r.emoji === emoji && r.userIds.includes(meId));

// ---------------------------------------------------------------- mention notices

export interface MentionNotice {
  kind: ChannelKind;
  ref: string;
  /** The mentioning message's id. */
  id: number;
  from: string;
  channel: string;
  text: string;
}

const KINDS_OK = ['board', 'team', 'workspace'];

/** A `mention` frame as a notice, or null when its shape is not what the server sends. Text is cut and never HTML. */
export function parseMention(f: Record<string, unknown>): MentionNotice | null {
  const from = f.from as { name?: unknown } | undefined;
  if (typeof f.kind !== 'string' || !KINDS_OK.includes(f.kind) || typeof f.ref !== 'string' || f.ref.length === 0 || f.ref.length > 128) return null;
  if (!Number.isSafeInteger(f.id) || typeof f.channel !== 'string' || typeof f.text !== 'string' || typeof from?.name !== 'string') return null;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return { kind: f.kind as ChannelKind, ref: f.ref, id: f.id as number, from: cut(from.name.trim() || 'Someone', 80), channel: cut(f.channel.trim() || 'a channel', 80), text: cut(f.text.replace(/\s+/g, ' ').trim(), 140) };
}

/** Where a notice's Open button goes: the board, or the channel on the Chat page. */
export const noticeHash = (n: Pick<MentionNotice, 'kind' | 'ref'>): string => (n.kind === 'board' ? `#/b/${n.ref}` : channelHash(n.kind, n.ref));

// ---------------------------------------------------------------- object chips

/** What the board can say about an object a message points at; undefined when it is no longer on the board. */
export interface ObjectInfo {
  /** The layers panel's label: its name, the first words of its text, or its type. */
  label: string;
  /** Hidden from this person by a session's private-writing step: its words are never shown. */
  private: boolean;
  /** Hidden for everyone with the Layers panel's eye: not drawn, so there is nowhere to go. */
  hidden: boolean;
}

export interface ObjectChip {
  state: 'ok' | 'private' | 'hidden' | 'missing';
  label: string;
  /** Whether a click can take the person there. */
  canOpen: boolean;
  /** The sentence for the chip's tooltip. */
  tip: string;
}

/**
 * The chip under a message that points at a board object (docs/chat.md, Object link). The text of an object this person may
 * not see is never part of it, and an object that is gone says so.
 */
export function objectChip(info: ObjectInfo | undefined): ObjectChip {
  if (!info) return { state: 'missing', label: 'Object no longer on the board', canOpen: false, tip: 'It was deleted from the board.' };
  if (info.private) return { state: 'private', label: 'An object', canOpen: false, tip: 'It stays hidden until the session reveals it.' };
  if (info.hidden) return { state: 'hidden', label: 'A hidden object', canOpen: false, tip: 'Show it in the Layers panel first.' };
  return { state: 'ok', label: info.label, canOpen: true, tip: 'Go to it on the board.' };
}

/** Where a chip goes when there is no board open to fly in (the Chat page): the board itself. */
export const objectBoardHash = (boardId: string): string => `#/b/${boardId}`;
