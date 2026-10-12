import type { BoardApp } from '../app';
import { authState } from '../auth';
import { boardUnread, onChatBadge, openBoardChat } from '../chat';
import { layerLabel } from '../layers';
import type { BaseObj } from '../types';
import { h, icon } from './dom';
import { announce } from './announce';
import { mountConversation, type Conversation, type ObjectRefs } from './chat';
import type { ChatDock } from './chat-dock';
import type { SideTray } from './side-tray';

/**
 * Board chat: the Chat button with its unread badge in the top bar, and the board's conversation in the chat dock (docs/chat.md,
 * Dock). The dock is the app's, in the overlay layer; this offers it the board's chat while the board is open and takes it
 * back when the board closes. Messages are plain text; every node is built with textContent.
 */
export function mountChat(app: BoardApp, dock: ChatDock, tray: SideTray | null = null): { button: HTMLButtonElement } {
  const boardId = app.conn.id;
  const signal = app.lifetime.signal;
  const auth = authState();
  const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
  const myId = me?.user.id ?? '';
  const myName = me?.user.name ?? 'You';
  const shown = () => dock.mode() === 'open' || dock.mode() === 'compact';

  // ---------------------------------------------------------------- button
  const badge = h('span', { class: 'chat-count', 'aria-hidden': 'true' });
  const button = h('button', {
    class: 'icon-btn chat-toggle', 'aria-label': 'Chat', 'aria-pressed': 'false', 'aria-keyshortcuts': 'M', 'data-tip-key': 'm', onclick: (e: MouseEvent) => {
      // a keyboard press (detail 0) opens the dock and moves into it; the dock is last in the page's order, 30 Tabs away otherwise
      const opening = !shown();
      dock.dispatch('toggle');
      if (opening && e.detail === 0) dock.focusComposer();
    },
  }, icon('chat', 18), badge);

  let badgeSeen: number | null = null;
  function paintBadge(v: { unread: number; mentions: number }) {
    // with the dock closed only counts arrive: say that there is something new, never what
    if (!shown() && badgeSeen !== null && v.unread > badgeSeen) {
      announce(`${v.unread} unread in board chat${v.mentions ? ', you were mentioned' : ''}`, { key: 'chat-badge', delay: 600 });
    }
    badgeSeen = v.unread;
    badge.textContent = v.unread > 99 ? '99+' : String(v.unread);
    badge.classList.toggle('show', v.unread > 0);
    badge.classList.toggle('mention', v.mentions > 0);
    const extra = v.unread ? `, ${v.unread} unread${v.mentions ? `, ${v.mentions} mentioning you` : ''}` : '';
    button.setAttribute('aria-label', `Chat${extra}`);
  }

  // ---------------------------------------------------------------- conversation
  // what board chat can do with the board's objects (docs/chat.md, Object link)
  const objects: ObjectRefs = {
    selected: () => (app.selection.length === 1 ? app.selection[0] : null),
    describe(id) {
      const o = app.store.get(id);
      if (!o) return undefined;
      return { label: layerLabel(o), private: app.flow.isHidden(o as BaseObj), hidden: !app.store.isShown(o) };
    },
    open: (id) => app.flyToObject(id),
    onChange(fn) {
      const offSel = app.on('selection', fn);
      const offObj = app.on('objects', fn);
      return () => {
        offSel();
        offObj();
      };
    },
  };
  let conversation: Conversation | null = null;
  const detach = dock.attachBoard({
    boardId,
    label: 'This board',
    returnFocus: () => button,
    presence: {
      people: () => app.participants().map((p) => ({ id: p.user.id, name: p.user.name, color: p.user.color })),
      onChange: (fn) => app.on('presence', fn),
    },
    mount(panel, mountSignal) {
      const chat = openBoardChat(boardId, mountSignal);
      conversation = mountConversation({ chat, id: boardId, panel, signal: mountSignal, meId: myId, meName: myName, onView: paintBadge, objects });
      return conversation;
    },
  });
  signal.addEventListener('abort', detach, { once: true });

  let redraw = 0;
  const offObjects = objects.onChange(() => {
    if (redraw || !shown()) return;
    redraw = requestAnimationFrame(() => {
      redraw = 0;
      conversation?.refresh();
    });
  });
  signal.addEventListener('abort', () => {
    offObjects();
    cancelAnimationFrame(redraw);
  }, { once: true });
  const offBadge = onChatBadge(() => {
    if (!shown()) paintBadge(boardUnread(boardId));
  });
  signal.addEventListener('abort', offBadge, { once: true });

  const paintButton = () => {
    button.classList.toggle('on', shown());
    button.setAttribute('aria-pressed', String(shown()));
  };
  // The dock and the Comments tray share the right edge: showing one puts the other away (the dock goes to a bubble, so it is one click back).
  const offMode = dock.onChange((mode) => {
    paintButton();
    if (mode === 'open' || mode === 'compact') tray?.hide();
  });
  signal.addEventListener('abort', offMode, { once: true });
  const offTray = tray?.onChange((tab) => {
    if (tab !== null && shown()) dock.dispatch('minimise');
  });
  if (offTray) signal.addEventListener('abort', offTray, { once: true });
  // the chrome leaves room for the dock, and the camera's fit does too
  const applyInset = (inset: number) => {
    app.r.dockInset = inset;
    app.r.setCamera({});
  };
  const offInset = dock.onInset(applyInset);
  signal.addEventListener('abort', () => {
    offInset();
    app.r.dockInset = 0;
  }, { once: true });
  app.r.dockInset = dock.inset();
  paintButton();

  // the button leaves focus where it is; the M key is for typing, so it also puts the cursor in the message box
  app.toggleChat = () => {
    const opening = !shown();
    dock.dispatch('toggle');
    if (opening) dock.focusComposer();
  };
  signal.addEventListener('abort', () => {
    app.toggleChat = null;
  }, { once: true });
  paintBadge(boardUnread(boardId));
  return { button };
}
