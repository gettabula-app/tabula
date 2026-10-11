import './chat-dock.css';
import { h, icon } from './dom';
import type { Conversation } from './chat';
import { loadDock, nextDock, saveDock, type DockEvent, type DockMode, type DockPrefs } from './chat-dock-state';

/** What a page offers the dock to show: today the board that is open. */
export interface DockBoard {
  boardId: string;
  /** The name of the channel, for the compact header ("This board"). */
  label: string;
  /** Draws the conversation into `panel`; `signal` aborts when the board goes away. */
  mount(panel: HTMLElement, signal: AbortSignal): Conversation;
  /** Where focus goes when Esc closes the dock from inside it (the Chat button). */
  returnFocus?: () => HTMLElement | null;
}

export interface ChatDock {
  userId: string;
  /** The dock and its bubble, in the overlay layer. */
  el: HTMLElement;
  /** Where the conversation goes (step 2 fills it). */
  body: HTMLElement;
  mode(): DockMode;
  prefs(): DockPrefs;
  /** Applies an event; the new state is remembered and shown. Returns the mode. */
  dispatch(event: DockEvent): DockMode;
  /** Remember which channel the dock shows. */
  setChannel(channel: string | null): void;
  onChange(fn: (mode: DockMode) => void): () => void;
  /** A board page offers its chat; the dock shows it while open. The returned function takes it back (the board closed). */
  attachBoard(board: DockBoard): () => void;
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
 * page and the tracker. What it is showing is remembered per person on this device.
 */
export function mountChatDock(overlay: HTMLElement, opts: { userId: string; storage?: Pick<Storage, 'getItem' | 'setItem'> | null }): ChatDock {
  const { userId } = opts;
  let prefs = loadDock(userId, opts.storage);
  const listeners = new Set<(mode: DockMode) => void>();

  const body = h('div', { class: 'chat-dock-body chat-panel' });
  const button = (label: string, name: Parameters<typeof icon>[0], event: DockEvent) =>
    h('button', { class: 'icon-btn chat-dock-btn', type: 'button', 'aria-label': label, 'data-tip': label, onclick: () => dispatch(event) }, icon(name, 18));
  const context = h('span', { class: 'chat-dock-context' });
  const title = h('h2', { class: 'chat-dock-title' }, 'Chat', context);
  const expand = button('Full size', 'expand', 'expand');
  const compact = button('Compact', 'collapse', 'compact');
  const head = h('header', { class: 'chat-dock-head' }, title, h('span', { class: 'chat-dock-spacer' }),
    expand, compact, button('Minimise to a bubble', 'minus', 'minimise'), button('Close chat', 'close', 'close'));
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

  let board: { ctx: DockBoard; conv: Conversation | null; abort: AbortController | null } | null = null;
  const isShown = () => prefs.mode === 'open' || prefs.mode === 'compact';

  /** Mounts the board's conversation the first time the dock is shown, and tells it whether it is on screen. */
  function syncBody() {
    if (!board) return;
    if (isShown() && !board.conv) {
      board.abort = new AbortController();
      board.conv = board.ctx.mount(body, board.abort.signal);
    }
    board.conv?.setOpen(isShown());
  }

  function paint() {
    context.textContent = board ? ` · ${board.ctx.label}` : '';
    el.dataset.mode = prefs.mode;
    panel.hidden = prefs.mode !== 'open' && prefs.mode !== 'compact';
    bubble.hidden = prefs.mode !== 'bubble';
    expand.hidden = prefs.mode !== 'compact';
    compact.hidden = prefs.mode !== 'open';
  }

  function dispatch(event: DockEvent): DockMode {
    const before = prefs.mode;
    prefs = nextDock(prefs, event);
    saveDock(userId, prefs, opts.storage);
    paint();
    syncBody();
    if (prefs.mode !== before) listeners.forEach((fn) => fn(prefs.mode));
    return prefs.mode;
  }

  paint();
  const dock: ChatDock = {
    userId,
    el,
    body,
    mode: () => prefs.mode,
    prefs: () => ({ ...prefs }),
    dispatch,
    setChannel(channel) {
      if (prefs.channel === channel) return;
      prefs = { ...prefs, channel };
      saveDock(userId, prefs, opts.storage);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    attachBoard(ctx) {
      board?.abort?.abort();
      body.replaceChildren();
      const mine = { ctx, conv: null as Conversation | null, abort: null as AbortController | null };
      board = mine;
      paint();
      syncBody();
      return () => {
        if (board !== mine) return;
        mine.abort?.abort();
        body.replaceChildren();
        board = null;
        paint();
      };
    },
    focusComposer() {
      board?.conv?.focusComposer();
    },
    destroy() {
      board?.abort?.abort();
      board = null;
      listeners.clear();
      el.remove();
      if (current === dock) current = null;
    },
  };
  current?.destroy();
  current = dock;
  return dock;
}

/**
 * Keeps the dock in step with who is signed in and whether this server has chat for them: mounted once for a person with chat,
 * gone for anyone else. Call it again whenever the account state changes.
 */
export function syncChatDock(overlay: HTMLElement, userId: string | null, chatOn: boolean): ChatDock | null {
  if (!userId || !chatOn) {
    current?.destroy();
    return null;
  }
  if (current && current.userId === userId) return current;
  return mountChatDock(overlay, { userId });
}
