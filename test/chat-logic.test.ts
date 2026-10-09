import { describe, expect, it } from 'vitest';
import type { ChatChannelEntry, ChatMessage } from '../src/api';
import {
  GROUP_MS, applyDelete, atBottom, CHAT_REACTIONS, objectBoardHash, objectChip, badgeText, buildRows, channelHash, channelLabel, channelMeta, defaultChannel, groupChannels, canDelete, canEdit, chatOpenKey, colourIndex, composerState, countUnread, dayLabel, filterPeople,
  findLinks, fromTokens, initials, insertMention, mentionLabel, mentionQuery, mergeMessages, newer, outboxItem, quoteText, segments,
  timeLabel, toTokens, trimOldest, noticeHash, parseMention, reactedWith, reactionChips, withReactions, type ChatAccess,
} from '../src/ui/chat-logic';

// docs/chat.md: merging by id, grouping into runs, date lines and the New messages line, plain-text links, mentions.
// Times are built in local time and `now` is passed in, so nothing here depends on the machine's zone or clock.

const at = (d: number, h: number, m = 0) => new Date(2026, 0, d, h, m).getTime();

let next = 1;
const msg = (fields: Partial<ChatMessage> = {}): ChatMessage => ({
  id: next++, kind: 'board', ref: 'b1', authorId: 'ana', authorName: 'Ana', clientId: `client-${next}-x`, text: 'hello', replyTo: null,
  objectId: null, mentions: [], createdAt: at(15, 9), editedAt: null, deleted: false, deletedBy: null, ...fields,
});

describe('merging', () => {
  it('orders by id and ignores a frame it has already seen', () => {
    const a = msg({ id: 1 }), b = msg({ id: 2 }), c = msg({ id: 3 });
    const list = mergeMessages([c, a], [b, a, c]);
    expect(list.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(mergeMessages(list, [b])).toEqual(list);
  });

  it('orders by id, never by the clock', () => {
    const late = msg({ id: 5, createdAt: at(15, 8) });
    const early = msg({ id: 4, createdAt: at(15, 10) });
    expect(mergeMessages([], [late, early]).map((m) => m.id)).toEqual([4, 5]);
  });

  it('keeps the newest state whichever copy arrives last', () => {
    const plain = msg({ id: 9, text: 'one' });
    const edited = { ...plain, text: 'two', editedAt: 100 };
    const dead = { ...plain, text: '', deleted: true, deletedBy: 'author' as const };
    expect(newer(edited, plain).text).toBe('two');
    expect(newer(plain, edited).text).toBe('two');
    expect(newer(dead, edited).deleted).toBe(true);
    expect(newer(edited, dead).deleted).toBe(true);
    expect(mergeMessages([edited], [plain])[0].text).toBe('two');
  });

  it('turns a deleted message into a tombstone with no text', () => {
    const m = msg({ id: 3, text: 'secret', mentions: [{ id: 'ben', name: 'Ben' }] });
    const [dead] = applyDelete([m], 3, 'moderator');
    expect(dead).toMatchObject({ id: 3, text: '', mentions: [], deleted: true, deletedBy: 'moderator' });
    expect(applyDelete([m], 99, 'author')).toEqual([m]);
  });

  it('keeps at most the newest messages', () => {
    const list = Array.from({ length: 5 }, (_, i) => msg({ id: i + 1 }));
    expect(trimOldest(list, 3).map((m) => m.id)).toEqual([3, 4, 5]);
    expect(trimOldest(list, 10)).toHaveLength(5);
  });

  it('counts unread after the marker, without own messages and tombstones', () => {
    const list = [msg({ id: 1 }), msg({ id: 2, authorId: 'me' }), msg({ id: 3, deleted: true }), msg({ id: 4 }), msg({ id: 5 })];
    expect(countUnread(list, 1, 'me')).toBe(2);
    expect(countUnread(list, 5, 'me')).toBe(0);
  });
});

describe('rows', () => {
  const now = at(15, 12);

  it('shows the name once for a run by one person within five minutes', () => {
    const rows = buildRows([
      msg({ id: 1, createdAt: at(15, 9, 0) }),
      msg({ id: 2, createdAt: at(15, 9, 4) }),
      msg({ id: 3, createdAt: at(15, 9, 4) + GROUP_MS }),
      msg({ id: 4, createdAt: at(15, 9, 10), authorId: 'ben', authorName: 'Ben' }),
      msg({ id: 5, createdAt: at(15, 9, 11) }),
    ], [], { newAfter: null, meId: 'me', now });
    expect(rows.map((r) => (r.type === 'message' ? `${r.message.id}${r.head ? '*' : ''}` : r.type))).toEqual(['day', '1*', '2', '3*', '4*', '5*']);
  });

  it('puts a date line where the day changes, and starts a new run there', () => {
    const rows = buildRows([
      msg({ id: 1, createdAt: at(13, 23, 58) }),
      msg({ id: 2, createdAt: at(14, 0, 1) }),
      msg({ id: 3, createdAt: at(15, 8) }),
    ], [], { newAfter: null, meId: 'me', now });
    expect(rows.map((r) => (r.type === 'day' ? r.label : r.type === 'message' ? `${r.message.id}${r.head ? '*' : ''}` : r.type)))
      .toEqual(['Tuesday 13 January 2026', '1*', 'Yesterday', '2*', 'Today', '3*']);
  });

  it('puts New messages before the first unread message of someone else, once', () => {
    const rows = buildRows([
      msg({ id: 1 }), msg({ id: 2, authorId: 'me', authorName: 'Me' }), msg({ id: 3, authorId: 'me', authorName: 'Me' }),
      msg({ id: 4, deleted: true }), msg({ id: 5 }), msg({ id: 6 }),
    ], [], { newAfter: 1, meId: 'me', now });
    const kinds = rows.map((r) => (r.type === 'message' ? r.message.id : r.type));
    expect(kinds).toEqual(['day', 1, 2, 3, 4, 'new', 5, 6]);
    const five = rows.find((r) => r.type === 'message' && r.message.id === 5);
    expect(five?.type === 'message' && five.head).toBe(true);
  });

  it('has no New messages line when nothing is unread', () => {
    const rows = buildRows([msg({ id: 1 }), msg({ id: 2 })], [], { newAfter: 2, meId: 'me', now });
    expect(rows.some((r) => r.type === 'new')).toBe(false);
    expect(buildRows([msg({ id: 1 })], [], { newAfter: null, meId: 'me', now }).some((r) => r.type === 'new')).toBe(false);
  });

  it('starts a new run after a tombstone', () => {
    const rows = buildRows([msg({ id: 1 }), msg({ id: 2, deleted: true }), msg({ id: 3 })], [], { newAfter: null, meId: 'me', now });
    expect(rows.filter((r) => r.type === 'message').map((r) => r.type === 'message' && r.head)).toEqual([true, false, true]);
  });

  it('puts unsent messages last, oldest first, in a run with the person\'s last message', () => {
    const rows = buildRows([msg({ id: 1, authorId: 'me', createdAt: at(15, 11, 58) })], [
      outboxItem({ clientId: 'bbbbbbbb', kind: 'board', ref: 'b1', text: 'second', createdLocal: at(15, 11, 59, ) + 1 }),
      outboxItem({ clientId: 'aaaaaaaa', kind: 'board', ref: 'b1', text: 'first', createdLocal: at(15, 11, 59) }),
    ], { newAfter: null, meId: 'me', now });
    expect(rows.map((r) => (r.type === 'pending' ? `${r.item.text}${r.head ? '*' : ''}` : r.type))).toEqual(['day', 'message', 'first', 'second']);
  });

  it('gives every row a stable key', () => {
    const rows = buildRows([msg({ id: 41 })], [outboxItem({ clientId: 'aaaaaaaa', kind: 'board', ref: 'b1', text: 'x', createdLocal: at(15, 9) })], { newAfter: 0, meId: 'me', now });
    expect(rows.map((r) => r.key)).toEqual([`day:2026-1-15`, 'new', 'm:41', 'p:aaaaaaaa']);
  });

  it('labels days and times in local time', () => {
    expect(dayLabel(at(15, 0, 1), at(15, 23))).toBe('Today');
    expect(dayLabel(at(14, 23, 59), at(15, 0, 1))).toBe('Yesterday');
    expect(dayLabel(at(1, 12), at(15, 12))).toBe('Thursday 1 January 2026');
    expect(timeLabel(at(15, 9, 5))).toBe('09:05');
    expect(timeLabel(at(15, 21, 30))).toBe('21:30');
  });
});

describe('links', () => {
  it('finds http and https links only, the same way as the server', () => {
    expect(findLinks('see https://example.com/a?b=1#c and http://x.org').map((l) => l.url)).toEqual(['https://example.com/a?b=1#c', 'http://x.org']);
    for (const text of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'mailto:ana@example.com', 'ftp://example.com/f', 'www.example.com', 'https://']) {
      expect(findLinks(text)).toEqual([]);
    }
  });

  it('leaves sentence punctuation outside and keeps a bracket that belongs to the address', () => {
    expect(findLinks('Read https://example.com/page.').map((l) => l.url)).toEqual(['https://example.com/page']);
    expect(findLinks('(see https://example.com/x)').map((l) => l.url)).toEqual(['https://example.com/x']);
    expect(findLinks('https://en.wikipedia.org/wiki/Mercury_(planet) is it').map((l) => l.url)).toEqual(['https://en.wikipedia.org/wiki/Mercury_(planet)']);
    expect(findLinks('<https://example.com>"x"').map((l) => l.url)).toEqual(['https://example.com']);
  });

  it('splits a text into plain text, links and mentions', () => {
    const parts = segments('Hi @{ben1}, see https://example.com/x. And <b>@{gone}</b>', [{ id: 'ben1', name: 'Ben' }]);
    expect(parts).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'mention', id: 'ben1', name: 'Ben' },
      { type: 'text', text: ', see ' },
      { type: 'link', url: 'https://example.com/x' },
      { type: 'text', text: '. And <b>' },
      { type: 'mention', id: 'gone', name: null },
      { type: 'text', text: '</b>' },
    ]);
  });

  it('keeps markup as text, never as a link', () => {
    expect(segments('<a href="javascript:x">click</a>', [])).toEqual([{ type: 'text', text: '<a href="javascript:x">click</a>' }]);
  });
});

describe('mentions', () => {
  it('names a mention by the current name, a removed person as Former member, a stray token as someone', () => {
    expect(mentionLabel({ id: 'a', name: 'Ana' }, true)).toBe('@Ana');
    expect(mentionLabel({ id: 'a', name: null }, true)).toBe('@Former member');
    expect(mentionLabel({ id: 'a', name: null }, false)).toBe('@someone');
  });

  it('finds the @ word at the caret', () => {
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('hi @an', 6)).toEqual({ start: 3, query: 'an' });
    expect(mentionQuery('(@an', 4)).toEqual({ start: 1, query: 'an' });
    expect(mentionQuery('mail ana@example.com', 20)).toBeNull();
    expect(mentionQuery('hi @ana lima', 12)).toBeNull();
    expect(mentionQuery('no at sign', 5)).toBeNull();
  });

  it('lists people by name, starts first, never oneself', () => {
    const people = [{ id: 'me', name: 'Anna Me' }, { id: 'b', name: 'Bo Andersen' }, { id: 'a', name: 'Ana Lima' }, { id: 'c', name: 'Cy' }];
    expect(filterPeople(people, 'an', 'me').map((p) => p.id)).toEqual(['a', 'b']);
    expect(filterPeople(people, '', 'me').map((p) => p.id)).toEqual(['b', 'a', 'c']);
    expect(filterPeople(people, 'zz', 'me')).toEqual([]);
  });

  it('inserts the chosen name in place of what was typed', () => {
    expect(insertMention('hi @an', 3, 6, 'Ana Lima')).toEqual({ value: 'hi @Ana Lima ', caret: 13 });
    expect(insertMention('hi @an and more', 3, 6, 'Ana')).toEqual({ value: 'hi @Ana and more', caret: 8 });
  });

  it('turns picked names into the server\'s tokens, longest name first', () => {
    const picked = [{ id: 'a1', name: 'Ana' }, { id: 'a2', name: 'Ana Lima' }];
    expect(toTokens('@Ana Lima and @Ana, thanks', picked)).toBe('@{a2} and @{a1}, thanks');
    expect(toTokens('@Anabel is not Ana', picked)).toBe('@Anabel is not Ana');
    expect(toTokens('nobody picked @Ana', [])).toBe('nobody picked @Ana');
    expect(toTokens('@A.B (x)', [{ id: 'z', name: 'A.B (x)' }])).toBe('@{z}');
  });

  it('turns tokens back into names for editing, with the people they name', () => {
    expect(fromTokens('Thanks @{a1} and @{gone}', [{ id: 'a1', name: 'Ana' }, { id: 'gone', name: null }]))
      .toEqual({ text: 'Thanks @Ana and @someone', picked: [{ id: 'a1', name: 'Ana' }] });
    const round = fromTokens('@{a1} @{a1}', [{ id: 'a1', name: 'Ana' }]);
    expect(toTokens(round.text, round.picked)).toBe('@{a1} @{a1}');
  });
});

describe('quotes, initials and colours', () => {
  it('quotes the first 80 characters on one line, mentions as names', () => {
    expect(quoteText({ text: 'Hi @{b}\nsee   you', mentions: [{ id: 'b', name: 'Ben' }], deleted: false })).toBe('Hi @Ben see you');
    const long = quoteText({ text: 'x'.repeat(100), mentions: [], deleted: false });
    expect(long).toBe(`${'x'.repeat(80)}…`);
    expect(quoteText({ text: '', mentions: [], deleted: true })).toBe('Message deleted');
  });

  it('makes initials and a stable colour', () => {
    expect(initials('Ana Lima Souza')).toBe('AL');
    expect(initials('ben')).toBe('B');
    expect(initials('  ')).toBe('?');
    expect(colourIndex('user-1', 8)).toBe(colourIndex('user-1', 8));
    expect(colourIndex(null, 8)).toBe(0);
    for (const id of ['a', 'bb', 'ccc', 'dddd']) expect(colourIndex(id, 8)).toBeLessThan(8);
  });
});

describe('what the person may do', () => {
  const writer: ChatAccess = { write: true, moderate: false, role: 'commenter', readOnly: false };
  const owner: ChatAccess = { write: true, moderate: true, role: 'owner', readOnly: false };
  const viewer: ChatAccess = { write: false, moderate: false, role: 'viewer', readOnly: false };
  const locked: ChatAccess = { write: false, moderate: false, role: 'owner', readOnly: true };

  it('says why the composer is off', () => {
    expect(composerState(writer, { lost: false, signedOut: false })).toEqual({ enabled: true, reason: null });
    expect(composerState(viewer, { lost: false, signedOut: false })).toEqual({ enabled: false, reason: 'Viewers can read this chat but not post.' });
    expect(composerState(locked, { lost: false, signedOut: false }).reason).toMatch(/read-only/);
    expect(composerState(writer, { lost: true, signedOut: false }).reason).toMatch(/no longer have access/);
    expect(composerState(writer, { lost: false, signedOut: true }).reason).toMatch(/Sign in/);
    expect(composerState(null, { lost: false, signedOut: false })).toEqual({ enabled: false, reason: null });
  });

  it('lets authors edit and authors or moderators delete, only online', () => {
    const mine = msg({ authorId: 'me' });
    const theirs = msg({ authorId: 'ana' });
    expect(canEdit(mine, 'me', writer, true)).toBe(true);
    expect(canEdit(mine, 'me', writer, false)).toBe(false);
    expect(canEdit(theirs, 'me', owner, true)).toBe(false);
    expect(canEdit({ ...mine, deleted: true }, 'me', writer, true)).toBe(false);
    expect(canDelete(mine, 'me', writer, true)).toBe(true);
    expect(canDelete(theirs, 'me', writer, true)).toBe(false);
    expect(canDelete(theirs, 'me', owner, true)).toBe(true);
    expect(canDelete(theirs, 'me', owner, false)).toBe(false);
    expect(canDelete(mine, 'me', locked, true)).toBe(false);
  });

  it('knows when the list is at the bottom', () => {
    expect(atBottom(500, 1000, 500)).toBe(true);
    expect(atBottom(480, 1000, 500)).toBe(true);
    expect(atBottom(400, 1000, 500)).toBe(false);
  });

  it('remembers open or closed per person and board under the driftboard prefix', () => {
    expect(chatOpenKey('u1', 'board-1')).toBe('driftboard:chat:u1:board-1');
  });
});

// ---------------------------------------------------------------- the Chat page's channel list

describe('the channel list', () => {
  const NOW = Date.UTC(2026, 9, 9, 12);
  const entry = (kind: 'board' | 'team' | 'workspace', ref: string, name: string, extra: Partial<ChatChannelEntry> = {}): ChatChannelEntry =>
    ({ kind, ref, name, write: true, unread: 0, mentions: 0, lastId: 0, lastAt: null, ...extra });

  it('groups into workspace, teams, other teams and boards, and leaves empty sections out', () => {
    const sections = groupChannels([
      entry('board', 'b1', 'Roadmap', { lastAt: NOW }),
      entry('team', 't2', 'Zeta', { member: true }),
      entry('workspace', 'main', 'Workspace'),
      entry('team', 't1', 'Alpha', { member: true }),
      entry('team', 't3', 'Elsewhere', { member: false }),
    ]);
    expect(sections.map((s) => s.id)).toEqual(['workspace', 'teams', 'other-teams', 'boards']);
    expect(sections.map((s) => s.title)).toEqual(['Workspace', 'Teams', 'Other teams', 'Boards']);
    expect(groupChannels([entry('team', 't1', 'Alpha')]).map((s) => s.id)).toEqual(['teams']);
    expect(groupChannels([])).toEqual([]);
  });

  it('puts recent teams first, archived ones last, and sorts by name when nothing has been said', () => {
    const teams = groupChannels([
      entry('team', 'old', 'Old', { archived: true, lastAt: NOW }),
      entry('team', 'b', 'Beta'),
      entry('team', 'a', 'alpha'),
      entry('team', 'c', 'Gamma', { lastAt: NOW - 1000 }),
      entry('team', 'd', 'Delta', { lastAt: NOW }),
    ])[0].entries;
    expect(teams.map((t) => t.ref)).toEqual(['d', 'c', 'a', 'b', 'old']);
  });

  it('lists boards by their latest message', () => {
    const boards = groupChannels([entry('board', 'x', 'X', { lastAt: 1 }), entry('board', 'y', 'Y', { lastAt: 3 }), entry('board', 'z', 'Z', { lastAt: 2 })])[0].entries;
    expect(boards.map((b) => b.ref)).toEqual(['y', 'z', 'x']);
  });

  it('picks the channel with a mention, then the most unread, then the first', () => {
    const sections = groupChannels([entry('workspace', 'main', 'Workspace'), entry('team', 't1', 'A'), entry('team', 't2', 'B')]);
    const counts: Record<string, { unread: number; mentions: number }> = { main: { unread: 0, mentions: 0 }, t1: { unread: 5, mentions: 0 }, t2: { unread: 1, mentions: 1 } };
    const of = (e: ChatChannelEntry) => counts[e.ref];
    expect(defaultChannel(sections, of)?.ref).toBe('t2');
    counts.t2 = { unread: 1, mentions: 0 };
    expect(defaultChannel(sections, of)?.ref).toBe('t1');
    counts.t1 = { unread: 0, mentions: 0 };
    counts.t2 = { unread: 0, mentions: 0 };
    expect(defaultChannel(sections, of)?.ref).toBe('main');
    expect(defaultChannel([], of)).toBeNull();
  });

  it('writes badges, labels and meta lines', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(100)).toBe('99+');
    expect(channelHash('team', 't1')).toBe('#/chat/team/t1');
    const t = entry('team', 't1', 'Design', { member: true });
    expect(channelLabel(t, { unread: 0, mentions: 0 })).toBe('Design, Team');
    expect(channelLabel(t, { unread: 3, mentions: 1 })).toBe('Design, Team, 3 unread, 1 mentioning you');
    expect(channelLabel(entry('team', 'o', 'Old', { archived: true }), { unread: 0, mentions: 0 })).toBe('Old, Team, archived');
    expect(channelMeta(entry('workspace', 'main', 'Workspace'), NOW)).toBe('Everyone');
    expect(channelMeta(entry('team', 't', 'T', { member: false }), NOW)).toBe('Team, not a member');
    expect(channelMeta(entry('board', 'b', 'B', { lastAt: NOW - 86_400_000 }), NOW)).toBe('Board · yesterday');
    expect(channelMeta(entry('board', 'b', 'B', { lastAt: NOW - 3 * 86_400_000 }), NOW)).toBe('Board · 3 days ago');
    expect(channelMeta(entry('team', 't', 'T', { archived: true, lastAt: NOW - 86_400_000 }), NOW)).toBe('Team · archived · yesterday');
  });
});

// ---------------------------------------------------------------- reactions and mention notices

describe('reactions', () => {
  const withReacts = (reactions: { emoji: string; userIds: string[] }[]) => ({ reactions });

  it('are chips in the order of the set, with counts, and say whether you are one of them', () => {
    const chips = reactionChips(withReacts([{ emoji: '✅', userIds: ['a'] }, { emoji: '👍', userIds: ['a', 'me'] }, { emoji: '🎉', userIds: [] }]), 'me');
    expect(chips.map((c) => [c.emoji, c.count, c.mine])).toEqual([['👍', 2, true], ['✅', 1, false]]);
    expect(chips[0].label).toBe('👍, 2 people, including you');
    expect(chips[1].label).toBe('✅, 1 person');
  });

  it('are nothing for a message without any, or saved before reactions existed', () => {
    expect(reactionChips({}, 'me')).toEqual([]);
    expect(reactionChips(withReacts([]), 'me')).toEqual([]);
  });

  it('replace one message’s list and leave the others alone', () => {
    const a = msg({ id: 1 }), b = msg({ id: 2 });
    const next = withReactions([a, b], 2, [{ emoji: '👀', userIds: ['x'] }]);
    expect(next[0]).toBe(a);
    expect(next[1].reactions).toEqual([{ emoji: '👀', userIds: ['x'] }]);
    expect(withReactions([a], 99, [])).toEqual([a]);
  });

  it('know whether you reacted with one emoji', () => {
    const m = withReacts([{ emoji: '👍', userIds: ['me'] }, { emoji: '❤️', userIds: ['other'] }]);
    expect(reactedWith(m, 'me', '👍')).toBe(true);
    expect(reactedWith(m, 'me', '❤️')).toBe(false);
    expect(reactedWith({}, 'me', '👍')).toBe(false);
  });

  it('are the six of the spec', () => {
    expect([...CHAT_REACTIONS]).toEqual(['👍', '❤️', '😄', '🎉', '👀', '✅']);
  });
});

describe('mention notices', () => {
  const frame = (extra: Record<string, unknown> = {}) => ({ t: 'mention', kind: 'team', ref: 't1', id: 7, from: { id: 'ana', name: 'Ana' }, channel: 'Design', text: 'can you check?', ...extra });

  it('read a mention frame', () => {
    expect(parseMention(frame())).toEqual({ kind: 'team', ref: 't1', id: 7, from: 'Ana', channel: 'Design', text: 'can you check?' });
  });

  it('cut long text and names, and never keep line breaks', () => {
    const n = parseMention(frame({ text: `a\n\n${'b'.repeat(300)}`, channel: 'c'.repeat(200), from: { name: 'n'.repeat(200) } }))!;
    expect(n.text).toHaveLength(140);
    expect(n.text.startsWith('a b')).toBe(true);
    expect(n.channel).toHaveLength(80);
    expect(n.from).toHaveLength(80);
  });

  it('fall back to plain words for empty names', () => {
    const n = parseMention(frame({ from: { name: '  ' }, channel: ' ' }))!;
    expect([n.from, n.channel]).toEqual(['Someone', 'a channel']);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown kind', { kind: 'room' }],
    ['no ref', { ref: '' }],
    ['a ref that is too long', { ref: 'x'.repeat(129) }],
    ['an id that is not a whole number', { id: 1.5 }],
    ['no sender', { from: undefined }],
    ['a text that is not text', { text: 5 }],
    ['a channel that is not text', { channel: null }],
  ])('refuse %s', (_name, extra) => {
    expect(parseMention(frame(extra))).toBeNull();
  });

  it('open a board in the board and anything else on the Chat page', () => {
    expect(noticeHash({ kind: 'board', ref: 'b1' })).toBe('#/b/b1');
    expect(noticeHash({ kind: 'team', ref: 't1' })).toBe('#/chat/team/t1');
    expect(noticeHash({ kind: 'workspace', ref: 'main' })).toBe('#/chat/workspace/main');
  });
});

describe('object chips', () => {
  it('say what the object is while it can be shown', () => {
    expect(objectChip({ label: 'Reviews were fast', private: false, hidden: false })).toEqual({
      state: 'ok', label: 'Reviews were fast', canOpen: true, tip: 'Go to it on the board.',
    });
  });

  it('never show the words of an object a session keeps from this person', () => {
    const chip = objectChip({ label: 'my private idea', private: true, hidden: false });
    expect(chip).toMatchObject({ state: 'private', label: 'An object', canOpen: false });
    expect(JSON.stringify(chip)).not.toContain('private idea');
  });

  it('say so when the object was hidden for everyone with the eye, and do not go there', () => {
    const chip = objectChip({ label: 'secret plan', private: false, hidden: true });
    expect(chip).toMatchObject({ state: 'hidden', label: 'A hidden object', canOpen: false });
    expect(JSON.stringify(chip)).not.toContain('secret plan');
  });

  it('prefer private over hidden when both apply, and say when the object is gone', () => {
    expect(objectChip({ label: 'x', private: true, hidden: true }).state).toBe('private');
    expect(objectChip(undefined)).toMatchObject({ state: 'missing', label: 'Object no longer on the board', canOpen: false });
  });

  it('link to the board where no board is open', () => {
    expect(objectBoardHash('b1')).toBe('#/b/b1');
  });
});
