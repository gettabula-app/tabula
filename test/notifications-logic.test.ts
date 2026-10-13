import { describe, expect, it } from 'vitest';
import {
  applyRead, badgeText, bellLabel, countOf, isMention, markLabel, matchesFilter, parseCounts, parseItem, parsePage, rowLabel, rowText, safeTarget, shortAgo, spokenAgo,
  type NotificationItem, type NotificationKind,
} from '../src/ui/notifications-logic';

// The bell and panel's pure rules (proto/designer-preview/notifications/SPEC.md).

const NOW = new Date(2026, 9, 12, 14, 0, 0).getTime();
const item = (kind: NotificationKind, over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: `n_${kind}`, kind, at: NOW - 2 * 60_000, read: false, actor: { id: 'u1', name: 'Maja' }, board: null, team: null, snippet: null, target: '#/', ...over,
});

describe('the bell', () => {
  it('hides nothing but the zero, caps at 99+, and says the count in words', () => {
    expect([badgeText(0), badgeText(3), badgeText(99), badgeText(100), badgeText(-4)]).toEqual(['0', '3', '99', '99+', '0']);
    expect([bellLabel(0), bellLabel(1), bellLabel(120)]).toEqual(['Notifications', 'Notifications, 1 unread', 'Notifications, more than 99 unread']);
  });
});

describe('what a row says', () => {
  it('says each kind the way the spec words it', () => {
    const board = { id: 'b1', title: 'Spring campaign board' };
    const team = { id: 't1', name: 'Design team' };
    expect(rowText(item('chat_mention', { team, snippet: '@Johan ok?' }))).toEqual({ who: 'Maja', verb: 'mentioned you in', where: 'Design team chat', after: '', context: 'Team chat', excerpt: '@Johan ok?' });
    expect(rowText(item('chat_mention', { board })).context).toBe('Board chat');
    expect(rowText(item('chat_mention')).where).toBe('the workspace chat');
    expect(rowText(item('comment_reply', { board, snippet: 'Agreed' }))).toMatchObject({ verb: 'replied to your comment on', where: board.title, context: 'Spring campaign board · Comment', excerpt: 'Agreed' });
    expect(rowText(item('board_shared', { board }))).toMatchObject({ verb: 'shared', where: board.title, after: 'with you', context: 'Shared with you', excerpt: null });
    expect(rowText(item('team_joined', { team }))).toMatchObject({ verb: 'joined', where: 'Design team', context: 'Workspace' });
    expect(rowText(item('ticket_assigned', { snippet: 'TAB-12 Fix export margins' }))).toMatchObject({ verb: 'assigned you', where: 'TAB-12 Fix export margins', context: 'Tracker', excerpt: null });
  });

  it('tolerates a missing excerpt, a missing actor and a missing place', () => {
    expect(rowText(item('chat_mention', { actor: null, snippet: null }))).toMatchObject({ who: 'Someone', excerpt: null });
    expect(rowText(item('comment_reply')).where).toBe('a board');
    expect(rowText(item('comment_mention', { board: { id: 'b1', title: 'Spring campaign board' }, snippet: 'Ask @Ana' }))).toEqual({ who: 'Maja', verb: 'mentioned you in a comment on', where: 'Spring campaign board', after: '', context: 'Spring campaign board · Comment', excerpt: 'Ask @Ana' });
    expect(rowText(item('comment_mention'))).toMatchObject({ verb: 'mentioned you in a comment on', where: 'a board', context: 'Comment', excerpt: null });
    expect(rowText(item('ticket_status', { snippet: null })).where).toBe('a ticket');
  });

  it('collapses whitespace, and cuts a very long name or excerpt', () => {
    const t = rowText(item('chat_mention', { actor: { id: 'u', name: ` ${'W'.repeat(200)} \n x` }, snippet: `a\n\n  b ${'z'.repeat(500)}` }));
    expect(t.who.length).toBeLessThanOrEqual(80);
    expect(t.excerpt?.startsWith('a b ')).toBe(true);
    expect(t.excerpt!.length).toBeLessThanOrEqual(300);
  });

  it('labels a row for a screen reader with the unread word, the place and the time', () => {
    const board = { id: 'b1', title: 'Retro team' };
    expect(rowLabel(item('chat_mention', { board }), NOW)).toBe('Maja mentioned you in Retro team chat, unread. Board chat. 2 minutes ago');
    expect(rowLabel(item('chat_mention', { board, read: true }), NOW)).toBe('Maja mentioned you in Retro team chat. Board chat. 2 minutes ago');
    expect(markLabel(item('chat_mention', { board }))).toBe('Mark as read: Maja mentioned you in Retro team chat');
  });
});

describe('time', () => {
  it('reads now, minutes, hours, Yesterday and then a date', () => {
    const at = (ms: number) => NOW - ms;
    expect(shortAgo(at(10_000), NOW)).toBe('now');
    expect(shortAgo(at(2 * 60_000), NOW)).toBe('2 min');
    expect(shortAgo(at(59 * 60_000), NOW)).toBe('59 min');
    expect(shortAgo(at(60 * 60_000), NOW)).toBe('1 h');
    expect(shortAgo(new Date(2026, 9, 12, 9, 0).getTime(), NOW)).toBe('5 h');
    expect(shortAgo(new Date(2026, 9, 11, 23, 0).getTime(), NOW)).toBe('Yesterday');
    expect(shortAgo(new Date(2026, 9, 3, 12, 0).getTime(), NOW)).toBe('3 Oct');
    expect(shortAgo(new Date(2025, 11, 24, 12, 0).getTime(), NOW)).toBe('24 Dec 2025');
    expect(shortAgo(NOW + 5 * 60_000, NOW)).toBe('now'); // a clock a little ahead
  });

  it('says the same in words', () => {
    expect([spokenAgo(NOW - 5_000, NOW), spokenAgo(NOW - 60_000, NOW), spokenAgo(NOW - 3 * 3_600_000, NOW)]).toEqual(['just now', '1 minute ago', '3 hours ago']);
    expect([spokenAgo(new Date(2026, 9, 11, 12).getTime(), NOW), spokenAgo(new Date(2026, 9, 3, 12).getTime(), NOW)]).toEqual(['yesterday', 'on 3 Oct']);
  });
});

describe('where a row goes', () => {
  it('follows the app’s own routes and nothing else', () => {
    expect(safeTarget('#/b/abc123')).toEqual({ kind: 'hash', hash: '#/b/abc123' });
    expect(safeTarget('#/chat/board/b1?msg=12')).toEqual({ kind: 'hash', hash: '#/chat/board/b1?msg=12' });
    expect(safeTarget('/t/TAB-12')).toEqual({ kind: 'path', path: '/t/TAB-12' });
    for (const bad of ['javascript:alert(1)', 'https://evil.example/', '//evil.example', '/admin', '#', '', '#/x y', '#/<script>', 42, null, `#/${'a'.repeat(400)}`]) {
      expect([bad, safeTarget(bad)]).toEqual([bad, null]);
    }
  });
});

describe('read state', () => {
  const rows = [item('chat_mention', { id: 'a' }), item('board_shared', { id: 'b' }), item('chat_mention', { id: 'c', read: true })];
  it('marks some or all rows read without touching the others', () => {
    expect(applyRead(rows, new Set(['a'])).map((r) => r.read)).toEqual([true, false, true]);
    expect(applyRead(rows, 'all').map((r) => r.read)).toEqual([true, true, true]);
    expect(applyRead(rows, new Set(['a']))[1]).toBe(rows[1]);
    expect(countOf(rows)).toEqual({ unread: 2, unreadMentions: 1 });
  });
});

describe('what the server sends', () => {
  it('keeps a well-formed row and drops the rest', () => {
    const ok = { id: 'n_1', kind: 'chat_mention', at: 5, read: false, actor: { id: 'u', name: 'Ana', colour: '#000' }, board: { id: 'b', title: 'T' }, team: null, snippet: 'hi', target: '#/b/b' };
    expect(parseItem(ok)).toEqual({ id: 'n_1', kind: 'chat_mention', at: 5, read: false, actor: { id: 'u', name: 'Ana' }, board: { id: 'b', title: 'T' }, team: null, snippet: 'hi', target: '#/b/b' });
    for (const bad of [null, 'x', { kind: 'chat_mention' }, { id: 'n', kind: 'wat' }, { id: '', kind: 'chat_mention' }]) expect(parseItem(bad)).toBeNull();
    expect(parseItem({ id: 'n', kind: 'team_joined', actor: { id: 1 }, snippet: '' })).toMatchObject({ actor: null, snippet: null, at: 0, target: '' });
  });

  it('reads a page and its counts, whatever is missing', () => {
    expect(parsePage({ items: [{ id: 'n_1', kind: 'board_shared' }, 'junk'], nextCursor: 'c1', unread: 7, unreadMentions: 2 })).toMatchObject({ nextCursor: 'c1', counts: { unread: 7, unreadMentions: 2 } });
    expect(parsePage(null)).toEqual({ items: [], nextCursor: null, counts: { unread: 0, unreadMentions: 0 } });
    expect(parseCounts({ unread: -1, unreadMentions: 'x' })).toEqual({ unread: 0, unreadMentions: 0 });
  });
});

describe('comment mentions in the Mentions chip', () => {
  it('counts a comment that names you with the chat mentions, and the chip shows only mentions', () => {
    const rows = [item('comment_mention', { id: 'c1' }), item('comment_reply', { id: 'r1' }), item('chat_mention', { id: 'm1', read: true })];
    expect(rows.map(isMention)).toEqual([true, false, true]);
    expect(countOf(rows)).toEqual({ unread: 2, unreadMentions: 1 });
    expect(rows.filter((r) => matchesFilter(r, 'mentions')).map((r) => r.id)).toEqual(['c1', 'm1']);
  });

  it('parses a comment_mention row from the server', () => {
    expect(parseItem({ id: 'n_9', kind: 'comment_mention', at: 7, read: false, actor: { id: 'u', name: 'Ana' }, board: { id: 'b', title: 'T' }, team: null, snippet: 'hi @Ben', target: '#/b/b' }))
      .toMatchObject({ id: 'n_9', kind: 'comment_mention', snippet: 'hi @Ben' });
  });
});

