import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatChannelEntry } from '../src/api';
import { FakeElement, FakeEvent, flush, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/chat.md, Interface: the Chat page. The store, the conversation and the top bar are replaced here (they have their own
// tests); what is checked is the page itself: the sections, which channel opens, the address, the badges, the back button
// of a phone, and that leaving the page lets everything go.

const entries: ChatChannelEntry[] = [];
const unread = new Map<string, { unread: number; mentions: number }>();
const badgeListeners = new Set<() => void>();
const opened: { kind: string; ref: string; aborted: boolean }[] = [];
const conversations: { id: string; open: boolean; focused: number }[] = [];
let listed = new Set<string>();
let unlisted = false;
let fetches = 0;
let available = true;

vi.mock('../src/chat', () => ({
  channelUnread: (kind: string, ref: string) => unread.get(`${kind}/${ref}`) ?? { unread: 0, mentions: 0 },
  fetchChannels: async () => {
    fetches++;
    return entries;
  },
  hasUnlisted: (set: ReadonlySet<string>) => {
    listed = new Set(set);
    return unlisted;
  },
  onChatBadge: (fn: () => void) => {
    badgeListeners.add(fn);
    return () => badgeListeners.delete(fn);
  },
  openChat: (kind: string, ref: string, signal: AbortSignal) => {
    const rec = { kind, ref, aborted: false };
    signal.addEventListener('abort', () => (rec.aborted = true));
    opened.push(rec);
    return {} as never;
  },
  watchChat: vi.fn<() => void>(),
}));
vi.mock('../src/ui/chat', () => ({
  mountConversation: (o: { id: string }) => {
    const c = { id: o.id, open: false, focused: 0 };
    conversations.push(c);
    return { setOpen: (on: boolean) => (c.open = on), focusComposer: () => c.focused++ };
  },
}));
vi.mock('../src/ui/topbar', () => ({
  createTopbar: () => document.createElement('header'),
  accountMe: () => ({ user: { id: 'me', name: 'Me' } }),
}));
vi.mock('../src/auth', () => ({
  authState: () => ({ mode: 'signed-in', me: { user: { id: 'me', name: 'Me' }, chat: true } }),
  chatAvailable: () => available,
}));
vi.mock('../src/ui/announce', () => ({ announce: vi.fn<() => void>() }));

const { renderChatPage } = await import('../src/ui/chat-page');

const entry = (kind: ChatChannelEntry['kind'], ref: string, name: string, extra: Partial<ChatChannelEntry> = {}): ChatChannelEntry =>
  ({ kind, ref, name, write: true, unread: 0, mentions: 0, lastId: 0, lastAt: null, ...extra });

let browser: FakeBrowser;
let phone = false;
const pushed: string[] = [];
let leave: (() => void) | null = null;

beforeEach(() => {
  browser = installFakeBrowser();
  entries.length = 0;
  entries.push(
    entry('workspace', 'main', 'Workspace', { lastAt: 100 }),
    entry('team', 't1', 'Design', { member: true, lastAt: 300 }),
    entry('team', 't2', 'Ops', { member: true, lastAt: 200 }),
    entry('board', 'b1', 'Roadmap', { lastAt: 400 }),
  );
  unread.clear();
  badgeListeners.clear();
  opened.length = 0;
  conversations.length = 0;
  pushed.length = 0;
  unlisted = false;
  fetches = 0;
  available = true;
  phone = false;
  vi.stubGlobal('window', {
    matchMedia: () => ({ get matches() { return phone; } }),
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('history', { pushState: (_s: unknown, _t: string, url: string) => void pushed.push(url) });
});
afterEach(() => {
  leave?.();
  leave = null;
  vi.unstubAllGlobals();
  browser.uninstall();
});

const mount = async (route: { kind?: ChatChannelEntry['kind']; ref?: string } = {}) => {
  const root = browser.mount();
  leave = renderChatPage(root as unknown as HTMLElement, route);
  await flush();
  return root;
};
const rowsOf = (root: FakeElement) => root.querySelectorAll('a.chat-row');
const nameOf = (row: FakeElement) => textOf(row.querySelector('.chat-row-name'));
const click = (el: FakeElement) => {
  const e = Object.assign(new FakeEvent('click'), { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
  el.dispatchEvent(e);
  return e;
};

describe('the Chat page', () => {
  it('lists the workspace, teams and boards in sections, and says what is unread', async () => {
    unread.set('team/t2', { unread: 3, mentions: 1 });
    const root = await mount();
    expect(root.querySelectorAll('.chat-section-title').map((t) => textOf(t))).toEqual(['Workspace', 'Teams', 'Boards']);
    expect(rowsOf(root).map(nameOf)).toEqual(['Workspace', 'Design', 'Ops', 'Roadmap']);
    const ops = rowsOf(root)[2];
    expect(textOf(ops.querySelector('.chat-row-badge'))).toBe('3');
    expect(ops.querySelector('.chat-row-badge')!.classList.contains('mention')).toBe(true);
    expect(ops.getAttribute('aria-label')).toBe('Ops, Team, 3 unread, 1 mentioning you');
    expect(rowsOf(root)[0].getAttribute('href')).toBe('#/chat/workspace/main');
  });

  it('opens the channel in the address, marks it, and subscribes only to it', async () => {
    const root = await mount({ kind: 'team', ref: 't2' });
    expect(opened.map((o) => `${o.kind}/${o.ref}`)).toEqual(['team/t2']);
    expect(rowsOf(root)[2].getAttribute('aria-current')).toBe('true');
    expect(rowsOf(root)[1].getAttribute('aria-current')).toBeNull();
    expect(textOf(root.querySelector('.chat-conv-title'))).toBe('Ops');
    expect(conversations[0]).toMatchObject({ open: true });
    expect(root.querySelector('.chat-conv')!.classList.contains('open')).toBe(true);
  });

  it('opens the channel with a mention, else the most unread, when the address names none', async () => {
    unread.set('team/t1', { unread: 5, mentions: 0 });
    unread.set('team/t2', { unread: 1, mentions: 1 });
    await mount();
    expect(opened.map((o) => o.ref)).toEqual(['t2']);
  });

  it('opens nothing by itself on a phone: the list is the first screen', async () => {
    phone = true;
    const root = await mount();
    expect(opened).toEqual([]);
    expect(root.querySelector('.chat-conv')!.classList.contains('open')).toBe(false);
    expect(textOf(root.querySelector('.chat-conv-empty'))).toContain('Pick a channel');
  });

  it('switches channel on a click, changes the address without a reload, and lets the old conversation go', async () => {
    const root = await mount({ kind: 'team', ref: 't1' });
    const click1 = click(rowsOf(root)[3]);
    expect(click1.defaultPrevented).toBe(true);
    expect(pushed).toEqual(['#/chat/board/b1']);
    expect(opened.map((o) => `${o.kind}/${o.ref}`)).toEqual(['team/t1', 'board/b1']);
    expect(opened[0].aborted).toBe(true);
    expect(opened[1].aborted).toBe(false);
    expect(textOf(root.querySelector('.chat-conv-title'))).toBe('Roadmap');
    const link = root.querySelector('.chat-open-board')!;
    expect(link.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('#/b/b1');
  });

  it('leaves a click with a modifier key to the browser', async () => {
    const root = await mount({ kind: 'team', ref: 't1' });
    const e = Object.assign(new FakeEvent('click'), { button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    rowsOf(root)[3].dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('moves focus to the composer after a pick on a wide screen, and to the title on a phone', async () => {
    const wide = await mount({ kind: 'team', ref: 't1' });
    click(rowsOf(wide)[2]);
    expect(conversations.at(-1)!.focused).toBe(1);
    leave?.();
    phone = true;
    const root = browser.mount();
    leave = renderChatPage(root as unknown as HTMLElement, { kind: 'team', ref: 't1' });
    await flush();
    click(rowsOf(root)[2]);
    expect(conversations.at(-1)!.focused).toBe(0);
    expect(browser.document.activeElement).toBe(root.querySelector('.chat-conv-title'));
  });

  it('goes back to the list on a phone and forgets the open channel', async () => {
    phone = true;
    const root = await mount({ kind: 'team', ref: 't1' });
    const back = root.querySelector('.chat-back')!;
    click(back);
    expect(pushed).toEqual(['#/chat']);
    expect(opened[0].aborted).toBe(true);
    expect(root.querySelector('.chat-conv')!.classList.contains('open')).toBe(false);
    expect(root.querySelector('.chat-list')!.classList.contains('away')).toBe(false);
    expect(rowsOf(root).every((r) => r.getAttribute('aria-current') === null)).toBe(true);
  });

  it('shows the counts as they change, without drawing the list again', async () => {
    const root = await mount({ kind: 'workspace', ref: 'main' });
    const before = rowsOf(root)[1];
    unread.set('team/t1', { unread: 2, mentions: 0 });
    for (const fn of badgeListeners) fn();
    expect(rowsOf(root)[1]).toBe(before);
    expect(textOf(before.querySelector('.chat-row-badge'))).toBe('2');
    unread.set('team/t1', { unread: 120, mentions: 0 });
    for (const fn of badgeListeners) fn();
    expect(textOf(before.querySelector('.chat-row-badge'))).toBe('99+');
    unread.delete('team/t1');
    for (const fn of badgeListeners) fn();
    expect(before.querySelector('.chat-row-badge')!.classList.contains('show')).toBe(false);
  });

  it('fetches the list again, not too often, when a count names a channel it does not list', async () => {
    vi.useFakeTimers();
    try {
      await mount({ kind: 'workspace', ref: 'main' });
      expect(fetches).toBe(1);
      unlisted = true;
      for (const fn of badgeListeners) fn();
      for (const fn of badgeListeners) fn();
      expect(listed.has('team/t1')).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when there is nothing to list', async () => {
    entries.length = 0;
    const root = await mount();
    expect(textOf(root.querySelector('.chat-list-status'))).toContain('No chats yet');
    expect(rowsOf(root)).toHaveLength(0);
  });

  it('lets go of its conversation and its listeners when the page is left', async () => {
    await mount({ kind: 'team', ref: 't1' });
    expect(badgeListeners.size).toBe(1);
    leave?.();
    leave = null;
    expect(opened[0].aborted).toBe(true);
    expect(badgeListeners.size).toBe(0);
  });

  it('says that chat is off where the server has none', async () => {
    available = false;
    const root = await mount();
    expect(textOf(root.querySelector('.chat-list-status'))).toContain('not turned on');
    expect(fetches).toBe(0);
  });
});
