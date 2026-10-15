import './chat-dock.css';
import { h, icon } from './dom';
import type { ChatChannelEntry } from '../api';
import { channelUnread, fetchChannels, hasUnlisted, onChatBadge, openChat, totalUnread, watchChat, type BoardChat } from '../chat';
import { mountConversation, type Conversation, type ConversationOptions } from './chat';
import { badgeText, channelHash, initials, type ChannelKind } from './chat-logic';
import { channelKey, dockChannels, hereLine, pickChannel, splitChips, type DockChannel } from './chat-dock-channels';
import { popover } from './common';
import { dockInset, loadDock, nextDock, saveDock, sheetDragMinimises, type DockEvent, type DockMode, type DockPrefs } from './chat-dock-state';

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
  /** The sum over every channel, for the bubble. */
  totalUnread(): { unread: number; mentions: number };
  onBadge(fn: () => void): () => void;
  hasUnlisted(listed: ReadonlySet<string>): boolean;
  watch(signal: AbortSignal): void;
  mount(opts: ConversationOptions): Conversation;
  /** Goes to a hash page (the full Chat page). */
  navigate(hash: string): void;
}

/** Leave a path route (the tracker) for a hash page such as `#/chat`: the path goes back to `/` and the router runs once. */
function navigateHashPage(hash: string) {
  window.history.pushState(null, '', '/' + hash);
  window.dispatchEvent(new Event('popstate'));
}

const realDeps = (): DockDeps => ({
  fetchChannels, openChat, unread: channelUnread, totalUnread, onBadge: onChatBadge, hasUnlisted, watch: watchChat, mount: mountConversation, navigate: navigateHashPage,
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
  /** Hides the dock on a page that must stay chrome-free (consent, sign-in) or is the chat itself; the dock keeps its state. */
  setSuppressed(on: boolean): void;
  /** The control that opened the dock (the Chat link), so focus can go back to it when the dock closes. */
  noteOpener(el: HTMLElement | null): void;
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
  const top = h('div', { class: 'chat-dock-top' }, chips, here);
  const body = h('div', { class: 'chat-dock-body' }, top, status, conversationHost);
  const button = (label: string, name: Parameters<typeof icon>[0], event: DockEvent) =>
    h('button', { class: 'icon-btn chat-dock-btn', type: 'button', 'aria-label': label, 'data-tip': label, onclick: () => dispatch(event) }, icon(name, 18));
  const context = h('span', { class: 'chat-dock-context' });
  const title = h('h2', { class: 'chat-dock-title' }, 'Chat', context);
  const expand = button('Full size', 'expand', 'expand');
  const compact = button('Compact', 'collapse', 'compact');
  const page = h('button', { class: 'icon-btn chat-dock-btn', type: 'button', 'aria-label': 'Open the full Chat page', 'data-tip': 'Open the full Chat page' }, icon('share', 18));
  page.addEventListener('click', () => {
    const now = chosen();
    dispatch('close');
    deps.navigate(now ? channelHash(now.kind, now.ref) : '#/chat');
  });
  const head = h('header', { class: 'chat-dock-head' }, title, page, expand, compact, button('Minimise to a bubble', 'minus', 'minimise'), button('Close chat', 'close', 'close'));
  const panel = h('section', { class: 'chat-dock tray', 'aria-label': 'Chat', role: 'complementary' }, head, body);
  const bubbleCount = h('u', { class: 'chat-bubble-count', 'aria-hidden': 'true', hidden: true });
  const bubble = h('button', { class: 'chat-bubble tray', type: 'button', 'aria-label': 'Chat', 'data-tip': 'Open chat', onclick: (e: MouseEvent) => { dispatch('open'); if (e.detail === 0) dock.focusComposer(); } }, icon('chat', 22), bubbleCount);
  // Esc inside the dock closes it and gives focus back to the Chat button; a message box, a menu or an edit uses its own Esc first.
  panel.setAttribute('tabindex', '-1');
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // The message box stops its keys from travelling up, so its Esc is seen here in the capture phase; once it has let go of focus (the
  // event is done by the next task), focus stays in the dock and the next Esc closes it from here.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    clearTimeout(escTimer);
    escTimer = setTimeout(() => {
      // the page (or a test's fake page) may be gone by now
      if (disposed || typeof document === 'undefined') return;
      const active = document.activeElement;
      if (e.defaultPrevented && isShown() && (!active || active === document.body)) panel.focus({ preventScroll: true });
    });
  }, true);
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // a menu, an edit or the message box used this Esc: the capture listener above keeps focus in the dock
    if (e.defaultPrevented) return;
    e.preventDefault();
    dispatch('close');
    opener()?.focus();
  });
  // On a phone the open dock is a bottom sheet: a scrim behind it, a handle that minimises it (a tap, or a drag down), and the sheet
  // rides above the soft keyboard (--dock-kb, --dock-vh from the visual viewport).
  const scrim = h('div', { class: 'chat-dock-scrim', 'aria-hidden': 'true', hidden: true, onclick: () => dispatch('minimise') });
  const handle = h('button', { class: 'chat-dock-handle', type: 'button', 'aria-label': 'Minimise chat', 'data-tip': 'Minimise chat' }, h('span', { 'aria-hidden': 'true' }));
  handle.addEventListener('click', () => { if (!dragged) dispatch('minimise'); });
  let dragged = false;
  let dragFrom: number | null = null;
  handle.addEventListener('pointerdown', (e) => { dragFrom = e.clientY; dragged = false; handle.setPointerCapture?.(e.pointerId); });
  handle.addEventListener('pointermove', (e) => {
    if (dragFrom === null) return;
    const dy = Math.max(0, e.clientY - dragFrom);
    if (dy > 6) dragged = true;
    panel.style.transform = dy ? `translateY(${dy}px)` : '';
  });
  const endDrag = (e: PointerEvent) => {
    if (dragFrom === null) return;
    const dy = e.clientY - dragFrom;
    dragFrom = null;
    panel.style.transform = '';
    if (dragged && sheetDragMinimises(dy)) dispatch('minimise');
    setTimeout(() => { dragged = false; });
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  panel.prepend(handle);
  const el = h('div', { class: 'chat-dock-host' }, scrim, panel, bubble);
  const publishViewport = () => {
    const vv = window.visualViewport;
    const lift = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0;
    el.style.setProperty('--dock-kb', `${Math.round(lift)}px`);
    el.style.setProperty('--dock-vh', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
  };
  window.visualViewport?.addEventListener('resize', publishViewport);
  window.visualViewport?.addEventListener('scroll', publishViewport);
  publishViewport();
  overlay.append(el);

  let suppressed = false;
  let lastOpener: HTMLElement | null = null;
  /** What gets focus when the dock closes from inside: the open board's Chat button, else the control that last opened it. */
  const opener = (): HTMLElement | null => board?.ctx.returnFocus?.() ?? (lastOpener?.isConnected ? lastOpener : null);
  let board: { ctx: DockBoard; offPresence: (() => void) | null } | null = null;
  let entries: ChatChannelEntry[] = [];
  let loaded = false;
  let failed = false;
  let lastFetch = 0;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let watchLife: AbortController | null = null;
  let mounted: { key: string; abort: AbortController; conv: Conversation } | null = null;
  let focusWanted = false;
  const isShown = () => !suppressed && (prefs.mode === 'open' || prefs.mode === 'compact');

  const channels = () => dockChannels(entries, board?.ctx.boardId ?? null);
  /**
   * The channel on screen. It is chosen once, when the dock opens (mention, then most unread, then the last one open, then the
   * workspace or the open board) and then stays: a new message only raises a badge, and a chip opened by hand stays until the dock
   * is closed. It is chosen again only when it is gone (a board that closed) or the dock was closed. Waits for the channel list.
   */
  let openKey: string | null = null;
  const chosen = (): DockChannel | null => {
    const list = channels();
    const kept = openKey ? list.find((c) => c.key === openKey) : undefined;
    if (kept) return kept;
    if (!isShown()) return null;
    // Before the list arrives the open board can be shown at once when nothing says otherwise: no unread anywhere and nothing else was last open.
    const attached = list.find((c) => c.attached);
    const early = !loaded && !!attached && (prefs.channel === null || prefs.channel === attached.key) && deps.totalUnread().unread === 0;
    if (!loaded && !early) return null;
    const pick = pickChannel(list, prefs.channel, (c) => deps.unread(c.kind, c.ref));
    openKey = pick?.key ?? null;
    if (pick && prefs.channel !== pick.key) {
      prefs = { ...prefs, channel: pick.key };
      saveDock(userId, prefs, opts.storage);
    }
    return pick;
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
      const a = h('span', { class: 'avatar chat-here-avatar live', 'aria-hidden': 'true', style: `--c:${p.color}` });
      a.textContent = initials(p.name);
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
      if (focusWanted) {
        focusWanted = false;
        const active = document.activeElement;
        if (!active || active === document.body || active === panel) conv.focusComposer();
      }
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
  let loading = false;
  async function load() {
    loading = true;
    lastFetch = Date.now();
    try {
      entries = await deps.fetchChannels();
      failed = false;
    } catch {
      failed = true;
    }
    loaded = true;
    loading = false;
    render();
  }

  function render() {
    paintChips();
    paintHere();
    syncConversation();
  }

  /** The bubble says how much is unread in all, and that someone mentioned you. */
  function paintBubble() {
    const t = deps.totalUnread();
    bubbleCount.textContent = badgeText(t.unread);
    bubbleCount.hidden = t.unread === 0;
    bubbleCount.classList.toggle('mention', t.mentions > 0);
    bubble.setAttribute('aria-label', t.unread ? `Chat, ${t.unread} unread${t.mentions ? ', you were mentioned' : ''}` : 'Chat');
  }

  /** Keeps the chat socket up while the dock is a panel or a bubble (the bubble counts), and the channel list loaded while it is a panel. */
  function syncWatch() {
    const watching = prefs.mode !== 'closed' && !suppressed;
    if (watching && !watchLife) {
      watchLife = new AbortController();
      deps.watch(watchLife.signal);
    } else if (!watching && watchLife) {
      watchLife.abort();
      watchLife = null;
    }
    if (isShown() && !loaded && !loading) void load();
  }
  const offBadge = deps.onBadge(() => {
    if (prefs.mode === 'bubble') paintBubble();
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
    const inset = suppressed ? 0 : dockInset(prefs.mode, window.innerWidth);
    document.documentElement.style.setProperty('--dock-inset', `${inset}px`);
    document.documentElement.dataset.dockInset = String(inset);
    insetListeners.forEach((fn) => fn(inset));
  };
  window.addEventListener('resize', publishInset);

  function paint() {
    publishInset();
    el.dataset.mode = prefs.mode;
    el.hidden = suppressed;
    scrim.hidden = !isShown();
    panel.hidden = !isShown();
    bubble.hidden = suppressed || prefs.mode !== 'bubble';
    expand.hidden = prefs.mode !== 'compact';
    compact.hidden = prefs.mode !== 'open';
    paintBubble();
  }

  function dispatch(event: DockEvent): DockMode {
    const before = prefs.mode;
    // focus inside the dock must not be lost when the dock goes away: it goes to what opened it, or to the bubble
    const hadFocus = isShown() && !!document.activeElement && panel.contains(document.activeElement);
    prefs = nextDock(prefs, event);
    if (prefs.mode === 'closed') openKey = null; // the next opening chooses again
    if (!isShown()) focusWanted = false;
    saveDock(userId, prefs, opts.storage);
    paint();
    syncWatch();
    render();
    if (hadFocus && prefs.mode === 'bubble') bubble.focus();
    else if (hadFocus && prefs.mode === 'closed') opener()?.focus();
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
      openKey = channel;
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
    inset: () => (suppressed ? 0 : dockInset(prefs.mode, window.innerWidth)),
    noteOpener(el) {
      lastOpener = el;
    },
    setSuppressed(on) {
      if (suppressed === on) return;
      suppressed = on;
      paint();
      syncWatch();
      render();
    },
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
      // the conversation may not be drawn yet (the channel list is still loading): focus waits in the dock and moves to the message box
      // once it is there, unless the person has gone elsewhere
      if (mounted) mounted.conv.focusComposer();
      else if (isShown()) {
        focusWanted = true;
        panel.focus({ preventScroll: true });
      }
    },
    destroy() {
      window.removeEventListener('resize', publishInset);
      window.visualViewport?.removeEventListener('resize', publishViewport);
      window.visualViewport?.removeEventListener('scroll', publishViewport);
      document.documentElement.style.removeProperty('--dock-inset');
      delete document.documentElement.dataset.dockInset;
      offBadge();
      watchLife?.abort();
      disposed = true;
      clearTimeout(escTimer);
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
