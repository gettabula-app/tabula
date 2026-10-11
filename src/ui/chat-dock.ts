import './chat-dock.css';
import { h, icon } from './dom';
import type { ChatChannelEntry } from '../api';
import { channelUnread, fetchChannels, hasUnlisted, onChatBadge, openChat, watchChat, type BoardChat } from '../chat';
import { mountConversation, type Conversation, type ConversationOptions } from './chat';
import { badgeText, type ChannelKind } from './chat-logic';
import { channelKey, dockChannels, hereLine, pickChannel, splitChips, type DockChannel } from './chat-dock-channels';
import { popover } from './common';
import { dockInset, loadDock, nextDock, saveDock, type DockEvent, type DockMode, type DockPrefs } from './chat-dock-state';

/** What a board page offers the dock: its own chat (with object links) and who is on it. */
export interface DockBoard {
  boardId: string;
  /** The name of the channel, for the compact header ("This board"). */
  label: string;
  /** Draws the conversation into `panel`; `signal` aborts when the board goes away. */
  mount(panel: HTMLElement, signal: AbortSignal): Conversation;
  /** Where focus goes when Esc closes the dock from inside it (the Chat button). */
  returnFocus?: () => HTMLElement | null;
  /** The people on the board now, for the presence strip. */
  presence?: {
    people(): { id: string; name: string; color: string }[];
    onChange(fn: () => void): () => void;
  };
}

/** What the dock reads from the chat store and draws with. Injected so the dock is tested without a server. */
export interface DockDeps {
  fetchChannels(): Promise<ChatChannelEntry[]>;
  openChat(kind: ChannelKind, ref: string, signal: AbortSignal): BoardChat;
  unread(kind: ChannelKind, ref: string): { unread: number; mentions: number };
  onBadge(fn: () => void): () => void;
  hasUnlisted(listed: ReadonlySet<string>): boolean;
  watch(signal: AbortSignal): void;
  mount(opts: ConversationOptions): Conversation;
}

const realDeps = (): DockDeps => ({
  fetchChannels, openChat, unread: channelUnread, onBadge: onChatBadge, hasUnlisted, watch: watchChat, mount: mountConversation,
});

/** A channel list that has not been refetched for this long is not asked for again on a badge change. */
const REFETCH_MS = 10_000;
/** Chips shown in the full dock; the rest are in the "+N" list. */
const MAX_CHIPS = 3;

export interface ChatDock {
  userId: string;
  /** The dock and its bubble, in the overlay layer. */
  el: HTMLElement;
  /** Where a conversation is drawn: below the chips and the presence strip. */
  conversationHost: HTMLElement;
  mode(): DockMode;
  prefs(): DockPrefs;
  /** Applies an event; the new state is remembered and shown. Returns the mode. */
  dispatch(event: DockEvent): DockMode;
  /** Show this channel (`kind/ref`) and remember it. */
  select(channel: string): void;
  /** The channel the dock is showing, or null before there is one. */
  channel(): string | null;
  setChannel(channel: string | null): void;
  onChange(fn: (mode: DockMode) => void): () => void;
  /** A board page offers its chat; the dock shows it while open. The returned function takes it back (the board closed). */
  attachBoard(board: DockBoard): () => void;
  /** Called with the dock's inset in px whenever it changes (the board refits its camera insets). */
  onInset(fn: (inset: number) => void): () => void;
  inset(): number;
  /** Focuses the message box of what is shown, once the dock is. */
  focusComposer(): void;
  destroy(): void;
}

let current: ChatDock | null = null;

/** The dock of this page, for the entry points (the Chat link, the board menu, the M key). Null while chat is off or nobody is signed in. */
export function currentChatDock(): ChatDock | null {
  return current;
}

/**
 * The chat dock host: a panel that docks at the right edge, a compact variant, a bubble above the zoom tray, or nothing.
 * It is created once into the overlay layer at the app root, so it stays while the person moves between boards, the Boards
 * page and the tracker. What it is showing is remembered per person on this device. Its chips switch between the open board,
 * the workspace and the person's teams; a presence strip says who is on the board.
 */
export function mountChatDock(overlay: HTMLElement, opts: {
  userId: string; userName?: string; storage?: Pick<Storage, 'getItem' | 'setItem'> | null; deps?: DockDeps;
}): ChatDock {
  const { userId } = opts;
  const deps = opts.deps ?? realDeps();
  const userName = opts.userName ?? 'You';
  let prefs = loadDock(userId, opts.storage);
  const listeners = new Set<(mode: DockMode) => void>();

  const conversationHost = h('div', { class: 'chat-dock-conv chat-panel' });
  const chips = h('nav', { class: 'chat-dock-chips', 'aria-label': 'Chat channels' });
  const here = h('div', { class: 'chat-dock-here', hidden: true });
  const status = h('p', { class: 'chat-dock-status', role: 'status', hidden: true });
  const body = h('div', { class: 'chat-dock-body' }, chips, here, status, conversationHost);
  const button = (label: string, name: Parameters<typeof icon>[0], event: DockEvent) =>
    h('button', { class: 'icon-btn chat-dock-btn', type: 'button', 'aria-label': label, 'data-tip': label, onclick: () => dispatch(event) }, icon(name, 18));
  const context = h('span', { class: 'chat-dock-context' });
  const title = h('h2', { class: 'chat-dock-title' }, 'Chat', context);
  const expand = button('Full size', 'expand', 'expand');
  const compact = button('Compact', 'collapse', 'compact');
  const head = h('header', { class: 'chat-dock-head' }, title, expand, compact, button('Minimise to a bubble', 'minus', 'minimise'), button('Close chat', 'close', 'close'));
  const panel = h('section', { class: 'chat-dock tray', 'aria-label': 'Chat', role: 'complementary' }, head, body);
  const bubble = h('button', { class: 'chat-bubble tray', type: 'button', 'aria-label': 'Chat', 'data-tip': 'Open chat', onclick: () => dispatch('open') }, icon('chat', 22));
  // Esc inside the dock closes it and gives focus back to the Chat button; a message box, a menu or an edit uses its own Esc first.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    dispatch('close');
    board?.ctx.returnFocus?.()?.focus();
  });
  const el = h('div', { class: 'chat-dock-host' }, panel, bubble);
  overlay.append(el);

  let board: { ctx: DockBoard; offPresence: (() => void) | null } | null = null;
  let entries: ChatChannelEntry[] = [];
  let loaded = false;
  let failed = false;
  let lastFetch = 0;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let watchLife: AbortController | null = null;
  let mounted: { key: string; abort: AbortController; conv: Conversation } | null = null;
  const isShown = () => prefs.mode === 'open' || prefs.mode === 'compact';

  const channels = () => dockChannels(entries, board?.ctx.boardId ?? null);
  /** The channel on screen: the one remembered, else the open board, else the busiest. Waits for the list when the remembered one is not the open board. */
  const chosen = (): DockChannel | null => {
    const list = channels();
    const attachedKey = list.find((c) => c.attached)?.key ?? null;
    if (!loaded && prefs.channel && prefs.channel !== attachedKey) return null;
    return pickChannel(list, prefs.channel, (c) => deps.unread(c.kind, c.ref));
  };

  // ---------------------------------------------------------------- chips and presence
  function paintChips() {
    const list = channels();
    const now = chosen();
    const { visible, overflow } = splitChips(list, now?.key ?? null, MAX_CHIPS);
    const chip = (c: DockChannel, inList = false) => {
      const u = deps.unread(c.kind, c.ref);
      const count = h('u', { class: 'chat-chip-count', 'aria-hidden': 'true' }, u.unread ? badgeText(u.unread) : '');
      count.hidden = !u.unread;
      const b = h('button', {
        class: `chat-chip${inList ? ' menu-item' : ''}${c.key === now?.key ? ' on' : ''}`, type: 'button', 'aria-pressed': String(c.key === now?.key),
        'aria-label': u.unread ? `${c.label}, ${u.unread} unread${u.mentions ? `, ${u.mentions} mentioning you` : ''}` : c.label,
        onclick: () => dock.select(c.key),
      }, h('span', { class: 'chat-chip-label' }, c.label), count);
      return b;
    };
    const items: HTMLElement[] = visible.map((c) => chip(c));
    if (overflow.length) {
      const total = overflow.reduce((n, c) => n + deps.unread(c.kind, c.ref).unread, 0);
      const more = h('button', { class: 'chat-chip chat-chip-more', type: 'button', 'aria-haspopup': 'menu', 'aria-label': `${overflow.length} more channels${total ? `, ${total} unread` : ''}` }, `+${overflow.length}`);
      more.addEventListener('click', () => {
        const pop = popover(more, h('div', { class: 'menu chat-chip-list' }, ...overflow.map((c) => {
          const b = chip(c, true);
          b.addEventListener('click', () => pop.close());
          return b;
        })), { side: 'bottom', label: 'More channels' });
      });
      items.push(more);
    }
    chips.replaceChildren(...items);
    chips.hidden = list.length < 2;
  }

  function paintHere() {
    const now = chosen();
    const people = board?.ctx.presence?.people() ?? [];
    here.hidden = !(now?.attached && people.length);
    if (here.hidden) return;
    const avatars = people.slice(0, 4).map((p) => {
      const a = h('span', { class: 'chat-here-avatar live', 'aria-hidden': 'true', style: `background:${p.color}` });
      a.textContent = p.name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
      return a;
    });
    const text = h('span', { class: 'chat-here-text' }, hereLine(people.map((p) => p.name)));
    here.replaceChildren(...avatars, text);
  }

  // ---------------------------------------------------------------- the conversation
  /** Draws the chosen channel's conversation once the dock is shown; a channel that is already drawn only learns whether it is on screen. */
  function syncConversation() {
    const now = isShown() ? chosen() : null;
    if (isShown() && mounted && (!now || mounted.key !== now.key)) unmount();
    if (isShown() && now && !mounted) {
      const abort = new AbortController();
      conversationHost.replaceChildren();
      let conv: Conversation;
      if (now.attached && board) conv = board.ctx.mount(conversationHost, abort.signal);
      else {
        const chat = deps.openChat(now.kind, now.ref, abort.signal);
        conv = deps.mount({ chat, id: `${now.kind}-${now.ref}`, panel: conversationHost, signal: abort.signal, meId: userId, meName: userName, workspace: now.kind === 'workspace' });
      }
      mounted = { key: now.key, abort, conv };
    }
    mounted?.conv.setOpen(isShown() && !!now && mounted.key === now.key);
    const attachedLabel = board && now?.attached ? ` · ${board.ctx.label}` : now ? ` · ${now.label}` : '';
    context.textContent = attachedLabel;
    status.textContent = loaded && failed && channels().length === 0 ? 'Could not load the channels. Check your connection.' : loaded && !now ? 'No chats yet. Team and workspace conversations appear here.' : '';
    status.hidden = !status.textContent;
  }

  function unmount() {
    mounted?.abort.abort();
    mounted = null;
    conversationHost.replaceChildren();
  }

  // ---------------------------------------------------------------- loading
  async function load() {
    lastFetch = Date.now();
    try {
      entries = await deps.fetchChannels();
      failed = false;
    } catch {
      failed = true;
    }
    loaded = true;
    render();
  }

  function render() {
    paintChips();
    paintHere();
    syncConversation();
  }

  /** Keeps the chat socket up and the channel list fresh while the dock is on screen. */
  function syncWatch() {
    if (isShown() && !watchLife) {
      watchLife = new AbortController();
      deps.watch(watchLife.signal);
      if (!loaded) void load();
    } else if (!isShown() && watchLife) {
      watchLife.abort();
      watchLife = null;
    }
  }
  const offBadge = deps.onBadge(() => {
    if (!isShown()) return;
    paintChips();
    // a count for a channel that is not listed (a board that just had its first message): ask for the list again, not too often
    if (!loaded || refetchTimer || !deps.hasUnlisted(new Set(entries.map((e) => channelKey(e.kind, e.ref))))) return;
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      void load();
    }, Math.max(0, REFETCH_MS - (Date.now() - lastFetch)));
  });

  /** The room the dock takes from the board, published as --dock-inset on the page for the chrome to read. */
  const insetListeners = new Set<(inset: number) => void>();
  const publishInset = () => {
    const inset = dockInset(prefs.mode, window.innerWidth);
    document.documentElement.style.setProperty('--dock-inset', `${inset}px`);
    document.documentElement.dataset.dockInset = String(inset);
    insetListeners.forEach((fn) => fn(inset));
  };
  window.addEventListener('resize', publishInset);

  function paint() {
    publishInset();
    el.dataset.mode = prefs.mode;
    panel.hidden = !isShown();
    bubble.hidden = prefs.mode !== 'bubble';
    expand.hidden = prefs.mode !== 'compact';
    compact.hidden = prefs.mode !== 'open';
  }

  function dispatch(event: DockEvent): DockMode {
    const before = prefs.mode;
    prefs = nextDock(prefs, event);
    saveDock(userId, prefs, opts.storage);
    paint();
    syncWatch();
    render();
    if (prefs.mode !== before) listeners.forEach((fn) => fn(prefs.mode));
    return prefs.mode;
  }

  paint();
  syncWatch();
  const dock: ChatDock = {
    userId,
    el,
    conversationHost,
    mode: () => prefs.mode,
    prefs: () => ({ ...prefs }),
    dispatch,
    channel: () => chosen()?.key ?? null,
    select(channel) {
      dock.setChannel(channel);
      render();
    },
    setChannel(channel) {
      if (prefs.channel === channel) return;
      prefs = { ...prefs, channel };
      saveDock(userId, prefs, opts.storage);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onInset(fn) {
      insetListeners.add(fn);
      return () => insetListeners.delete(fn);
    },
    inset: () => dockInset(prefs.mode, window.innerWidth),
    attachBoard(ctx) {
      board?.offPresence?.();
      const mine = { ctx, offPresence: ctx.presence?.onChange(() => paintHere()) ?? null };
      board = mine;
      if (mounted) unmount();
      render();
      return () => {
        if (board !== mine) return;
        mine.offPresence?.();
        board = null;
        unmount();
        render();
      };
    },
    focusComposer() {
      mounted?.conv.focusComposer();
    },
    destroy() {
      window.removeEventListener('resize', publishInset);
      document.documentElement.style.removeProperty('--dock-inset');
      delete document.documentElement.dataset.dockInset;
      offBadge();
      watchLife?.abort();
      if (refetchTimer) clearTimeout(refetchTimer);
      board?.offPresence?.();
      unmount();
      board = null;
      listeners.clear();
      el.remove();
      if (current === dock) current = null;
    },
  };
  current?.destroy();
  current = dock;
  render();
  return dock;
}

/**
 * Keeps the dock in step with who is signed in and whether this server has chat for them: mounted once for a person with chat,
 * gone for anyone else. Call it again whenever the account state changes.
 */
export function syncChatDock(overlay: HTMLElement, userId: string | null, chatOn: boolean, userName?: string): ChatDock | null {
  if (!userId || !chatOn) {
    current?.destroy();
    return null;
  }
  if (current && current.userId === userId) return current;
  return mountChatDock(overlay, { userId, userName });
}
