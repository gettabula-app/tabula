// The notifications bell and panel on the Boards top bar (proto/designer-preview/notifications/SPEC.md): what a row says, how the
// bell is labelled, how times read, where a row goes. Pure; the server's rows are ids and names, and the text is built here.

export type NotificationKind = 'chat_mention' | 'comment_mention' | 'comment_reply' | 'board_shared' | 'team_joined' | 'ticket_assigned' | 'ticket_commented' | 'ticket_status';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['chat_mention', 'comment_mention', 'comment_reply', 'board_shared', 'team_joined', 'ticket_assigned', 'ticket_commented', 'ticket_status'];

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  /** Milliseconds since the epoch. */
  at: number;
  read: boolean;
  actor: { id: string; name: string } | null;
  board: { id: string; title: string } | null;
  team: { id: string; name: string } | null;
  /** What was said, or the ticket's title: read when the list was built, null when there is none to show. */
  snippet: string | null;
  /** A route the app opens as it is: `#/...` or `/t/<KEY>`. */
  target: string;
}

export interface NotificationCounts {
  unread: number;
  unreadMentions: number;
}

export type NotificationFilter = 'all' | 'mentions';

/** Mentions are the rows the Mentions chip holds: a chat mention, or a comment that names this person with @. */
export const isMention = (item: Pick<NotificationItem, 'kind'>) => item.kind === 'chat_mention' || item.kind === 'comment_mention';

export const badgeText = (unread: number) => (unread > 99 ? '99+' : String(Math.max(0, Math.floor(unread))));

/** "Notifications, 3 unread", or just "Notifications" at zero. */
export const bellLabel = (unread: number) => (unread > 0 ? `Notifications, ${unread > 99 ? 'more than 99' : unread} unread` : 'Notifications');

export function matchesFilter(item: NotificationItem, filter: NotificationFilter): boolean {
  return filter === 'all' || isMention(item);
}

// ---------------------------------------------------------------- what a row says

export interface RowText {
  /** The person, set in bold. Empty when the row has no actor. */
  who: string;
  /** Between the person and the place: "mentioned you in". */
  verb: string;
  /** The place, set in bold: a board, a team, a ticket. */
  where: string;
  /** Text after the place ("with you"), or empty. */
  after: string;
  /** The muted second line. */
  context: string;
  /** One line of what was said, for mentions and replies only. */
  excerpt: string | null;
}

const clean = (s: string | null | undefined, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function rowText(item: NotificationItem): RowText {
  const who = clean(item.actor?.name, 80) || 'Someone';
  const board = clean(item.board?.title, 200);
  const team = clean(item.team?.name, 200);
  const snippet = clean(item.snippet, 300);
  switch (item.kind) {
    case 'chat_mention': {
      const place = team || board;
      const where = place ? `${place} chat` : 'the workspace chat';
      return { who, verb: 'mentioned you in', where, after: '', context: team ? 'Team chat' : board ? 'Board chat' : 'Workspace chat', excerpt: snippet || null };
    }
    case 'comment_mention':
      return { who, verb: 'mentioned you in a comment on', where: board || 'a board', after: '', context: board ? `${board} · Comment` : 'Comment', excerpt: snippet || null };
    case 'comment_reply':
      return { who, verb: 'replied to your comment on', where: board || 'a board', after: '', context: board ? `${board} · Comment` : 'Comment', excerpt: snippet || null };
    case 'board_shared':
      return { who, verb: 'shared', where: board || 'a board', after: 'with you', context: 'Shared with you', excerpt: null };
    case 'team_joined':
      return { who, verb: 'joined', where: team || 'a team', after: '', context: 'Workspace', excerpt: null };
    case 'ticket_assigned':
      return { who, verb: 'assigned you', where: snippet || 'a ticket', after: '', context: 'Tracker', excerpt: null };
    case 'ticket_commented':
      return { who, verb: 'commented on', where: snippet || 'a ticket', after: '', context: 'Tracker', excerpt: null };
    case 'ticket_status':
      return { who, verb: 'changed the status of', where: snippet || 'a ticket', after: '', context: 'Tracker', excerpt: null };
  }
}

/** The first line as one sentence, for the row's accessible name. */
export const sentence = (t: RowText) => [t.who, t.verb, t.where, t.after].filter(Boolean).join(' ');

/** "Maja mentioned you in Retro team chat, unread. Board chat. 2 minutes ago" */
export function rowLabel(item: NotificationItem, now: number): string {
  const t = rowText(item);
  return `${sentence(t)}${item.read ? '' : ', unread'}. ${t.context}. ${spokenAgo(item.at, now)}`;
}

/** The label of the per-row check button. */
export const markLabel = (item: NotificationItem) => `Mark as read: ${sentence(rowText(item))}`;

// ---------------------------------------------------------------- time

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "now", "2 min", "1 h", "Yesterday", then "11 Oct" (and the year once it is not this year's). */
export function shortAgo(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min`;
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return `${Math.floor(d / HOUR)} h`;
  if (at >= startOfToday - DAY) return 'Yesterday';
  const then = new Date(at);
  const base = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === today.getFullYear() ? base : `${base} ${then.getFullYear()}`;
}

/** The same in words for a screen reader: "2 minutes ago". */
export function spokenAgo(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return 'just now';
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`;
  if (d < HOUR) return unit(Math.floor(d / MIN), 'minute');
  const short = shortAgo(at, now);
  if (short.endsWith(' h')) return unit(Math.floor(d / HOUR), 'hour');
  return short === 'Yesterday' ? 'yesterday' : `on ${short}`;
}

// ---------------------------------------------------------------- where a row goes

/** A server route is followed only if it is one of the app's own: a hash route or a tracker ticket path. Anything else goes nowhere. */
export function safeTarget(target: unknown): { kind: 'hash'; hash: string } | { kind: 'path'; path: string } | null {
  if (typeof target !== 'string' || target.length > 300) return null;
  if (/^#\/[A-Za-z0-9_\-./?=&%:~]*$/.test(target)) return { kind: 'hash', hash: target };
  if (/^\/t\/[A-Za-z0-9_\-./?=&%]*$/.test(target)) return { kind: 'path', path: target };
  return null;
}

// ---------------------------------------------------------------- the list's own rules

/** Keeps the list's unread numbers honest when only some rows were read locally. */
export function applyRead(items: readonly NotificationItem[], ids: ReadonlySet<string> | 'all'): NotificationItem[] {
  return items.map((i) => (!i.read && (ids === 'all' || ids.has(i.id)) ? { ...i, read: true } : i));
}

export const countOf = (items: readonly NotificationItem[]): NotificationCounts => ({
  unread: items.filter((i) => !i.read).length,
  unreadMentions: items.filter((i) => !i.read && isMention(i)).length,
});

// ---------------------------------------------------------------- what the server sends

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const pair = (x: unknown, key: string): { id: string; [k: string]: string } | null =>
  isObject(x) && typeof x.id === 'string' && typeof x[key] === 'string' ? { id: x.id, [key]: x[key] as string } : null;

export function parseItem(x: unknown): NotificationItem | null {
  if (!isObject(x) || typeof x.id !== 'string' || !x.id) return null;
  if (!NOTIFICATION_KINDS.includes(x.kind as NotificationKind)) return null;
  const at = typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : 0;
  const actor = pair(x.actor, 'name');
  const board = pair(x.board, 'title');
  const team = pair(x.team, 'name');
  return {
    id: x.id,
    kind: x.kind as NotificationKind,
    at,
    read: x.read === true,
    actor: actor ? { id: actor.id, name: actor.name } : null,
    board: board ? { id: board.id, title: board.title } : null,
    team: team ? { id: team.id, name: team.name } : null,
    snippet: typeof x.snippet === 'string' && x.snippet ? x.snippet : null,
    target: typeof x.target === 'string' ? x.target : '',
  };
}

export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
  counts: NotificationCounts;
}

const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0);

export function parsePage(x: unknown): NotificationPage {
  const o = isObject(x) ? x : {};
  return {
    items: (Array.isArray(o.items) ? o.items : []).map(parseItem).filter((i): i is NotificationItem => i !== null),
    nextCursor: typeof o.nextCursor === 'string' && o.nextCursor ? o.nextCursor : null,
    counts: { unread: count(o.unread), unreadMentions: count(o.unreadMentions) },
  };
}

export function parseCounts(x: unknown): NotificationCounts {
  const o = isObject(x) ? x : {};
  return { unread: count(o.unread), unreadMentions: count(o.unreadMentions) };
}
