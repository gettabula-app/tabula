import { h, icon } from './dom';

export type TrayTab = 'comments' | 'chat';

const LABELS: Record<TrayTab, string> = { comments: 'Comments', chat: 'Chat' };

export interface SideTray {
  el: HTMLElement;
  /** The panel element of a tab, where its owner draws. */
  slot(tab: TrayTab): HTMLElement;
  /** The open tab, or null when the tray is closed. */
  current(): TrayTab | null;
  show(tab: TrayTab): void;
  hide(): void;
  /** Opens `tab`, or closes the tray when `tab` is already the open one. */
  toggle(tab: TrayTab): void;
  /** Chat is a tab only where it is available; without it the tray is the comments panel as before. */
  setAvailable(tab: TrayTab, on: boolean): void;
  onChange(fn: (tab: TrayTab | null) => void): () => void;
}

/**
 * The right-hand tray shared by Comments and Chat (docs/chat.md, Interface): one panel below the top bars
 * (`--panel-top`), with a tab per part where more than one is available, and a close button.
 */
export function mountSideTray(chrome: HTMLElement): SideTray {
  const available = new Set<TrayTab>(['comments']);
  const listeners = new Set<(tab: TrayTab | null) => void>();
  let open: TrayTab | null = null;

  const slots: Record<TrayTab, HTMLElement> = {
    comments: h('div', { class: 'side-tray-panel comments-panel', id: 'side-tray-comments', role: 'tabpanel' }),
    chat: h('div', { class: 'side-tray-panel chat-panel', id: 'side-tray-chat', role: 'tabpanel' }),
  };
  const tabs: Record<TrayTab, HTMLButtonElement> = {
    comments: tabButton('comments'),
    chat: tabButton('chat'),
  };
  const title = h('h2', { class: 'side-tray-title' });
  const tablist = h('div', { class: 'side-tray-tabs', role: 'tablist', 'aria-label': 'Comments and chat' }, tabs.comments, tabs.chat);
  const close = h('button', { class: 'icon-btn side-tray-close', 'data-tip': 'Close', onclick: () => api.hide() }, icon('close', 18));
  const head = h('div', { class: 'side-tray-head' }, title, tablist, close);
  const el = h('aside', { class: 'side-tray tray' }, head, slots.comments, slots.chat);
  chrome.appendChild(el);

  function tabButton(tab: TrayTab): HTMLButtonElement {
    const b = h('button', { class: 'side-tray-tab', role: 'tab', id: `side-tray-tab-${tab}`, 'aria-controls': `side-tray-${tab}`, onclick: () => api.show(tab) }, LABELS[tab]);
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const list = (['comments', 'chat'] as TrayTab[]).filter((t) => available.has(t));
      const next = list[(list.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      api.show(next);
      tabs[next].focus();
    });
    return b;
  }

  function paint() {
    const many = available.size > 1;
    el.classList.toggle('show', open !== null);
    el.dataset.tab = open ?? '';
    el.setAttribute('aria-label', open ? LABELS[open] : 'Comments');
    title.hidden = many;
    tablist.hidden = !many;
    title.textContent = open ? LABELS[open] : '';
    close.setAttribute('aria-label', `Close ${open ? LABELS[open].toLowerCase() : 'panel'}`);
    for (const t of Object.keys(tabs) as TrayTab[]) {
      const on = open === t;
      tabs[t].hidden = !available.has(t);
      tabs[t].classList.toggle('on', on);
      tabs[t].setAttribute('aria-selected', String(on));
      tabs[t].tabIndex = on || (open === null && t === 'comments') ? 0 : -1;
      slots[t].hidden = !on;
      if (many) slots[t].setAttribute('aria-labelledby', tabs[t].id);
      else slots[t].removeAttribute('aria-labelledby');
    }
  }

  function set(tab: TrayTab | null) {
    if (tab !== null && !available.has(tab)) tab = null;
    if (tab === open) return;
    open = tab;
    paint();
    for (const fn of Array.from(listeners)) fn(open);
  }

  const api: SideTray = {
    el,
    slot: (tab) => slots[tab],
    current: () => open,
    show: (tab) => set(tab),
    hide: () => set(null),
    toggle: (tab) => set(open === tab ? null : tab),
    setAvailable(tab, on) {
      if (on) available.add(tab);
      else available.delete(tab);
      if (open && !available.has(open)) set(null);
      else paint();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  paint();
  return api;
}
