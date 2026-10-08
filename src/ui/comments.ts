import './comments.css';
import type { BoardApp } from '../app';
import type { Anchor, Author, Reply, Thread } from '../comments';
import type { Point } from '../types';
import { authState } from '../auth';
import { h, icon } from './dom';
import { fmtAgo, segmented, toast } from './common';

type Target = { threadId?: string; anchor?: Anchor; screen: Point };
type Msg = Pick<Reply, 'id' | 'authorId' | 'authorName' | 'authorColor' | 'text' | 'createdAt' | 'editedAt'> & { root: boolean };
type Filter = 'open' | 'resolved';

const GAP = 12;
const MARGIN = 12;
/** A row's camera flight takes about 420ms; moves inside this window do not close the card it opens. */
const FLIGHT_MS = 600;

/** Writes are attributed to the account in accounts mode, otherwise to this device's user. */
function authorOf(app: BoardApp): Author {
  const auth = authState();
  return { id: auth.mode === 'signed-in' ? auth.me.user.id : app.user.id, name: app.user.name, color: app.user.color };
}

/** Only the board owner may delete other people's comments. */
function canModerate(app: BoardApp): boolean {
  return app.role === 'owner';
}

function avatar(name: string, color: string): HTMLSpanElement {
  const a = h('span', { class: 'comment-avatar', 'aria-hidden': 'true' }, ([...name.trim()][0] ?? '?').toUpperCase());
  a.style.setProperty('--c', color);
  return a;
}

/** Enter posts, Shift+Enter adds a line, Escape calls onEscape. Keys never reach the board's shortcuts. */
function textArea(label: string, onEnter: () => void, onEscape: () => void): HTMLTextAreaElement {
  const ta = h('textarea', { class: 'input comment-input', 'aria-label': label, placeholder: label, maxlength: '4000', rows: 2 });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onEnter();
    }
  });
  ta.addEventListener('keyup', (e) => e.stopPropagation());
  ta.addEventListener('paste', (e) => e.stopPropagation());
  return ta;
}

function focusSoon(ta: HTMLTextAreaElement) {
  requestAnimationFrame(() => ta.focus());
  setTimeout(() => ta.focus(), 30);
}

/** Below and to the right of the point, flipped left or up when that overflows, clamped inside the viewport. */
function placeCard(el: HTMLElement, p: Point) {
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = p.x + GAP, y = p.y + GAP;
  if (x + w > vw - MARGIN) x = p.x - GAP - w;
  if (y + hgt > vh - MARGIN) y = p.y - GAP - hgt;
  el.style.left = `${Math.max(MARGIN, Math.min(x, vw - w - MARGIN))}px`;
  el.style.top = `${Math.max(MARGIN, Math.min(y, vh - hgt - MARGIN))}px`;
}

/** The comment tool's card, the comments panel and its count badge. */
export function mountComments(app: BoardApp, chrome: HTMLElement): { button: HTMLButtonElement } {
  let current: { close: (notify: boolean) => void } | null = null;
  let panelOpen = false;
  let filter: Filter = 'open';
  let painted = '';
  let flightUntil = 0;

  const count = h('span', { class: 'comment-count', 'aria-hidden': 'true' });
  const button = h('button', { class: 'icon-btn comment-toggle', title: 'Comments', 'aria-label': 'Comments', 'aria-pressed': 'false', onclick: () => togglePanel() }, icon('comment', 18), count);
  const panel = h('aside', { class: 'comments-panel tray', 'aria-label': 'Comments' });
  chrome.appendChild(panel);

  function togglePanel() {
    panelOpen = !panelOpen;
    painted = '';
    button.classList.toggle('on', panelOpen);
    button.setAttribute('aria-pressed', String(panelOpen));
    panel.classList.toggle('show', panelOpen);
    render();
  }

  function openRow(t: Thread) {
    flightUntil = performance.now() + FLIGHT_MS;
    app.flyToThread(t.id);
    app.openThread(t.id);
    app.onOpenComment?.({ threadId: t.id, screen: { x: window.innerWidth / 2, y: window.innerHeight / 2 } });
  }

  function row(t: Thread) {
    const n = t.replies.length;
    return h('button', { class: 'comment-row', onclick: () => openRow(t) },
      avatar(t.authorName, t.authorColor),
      h('span', { class: 'comment-row-body' },
        h('span', { class: 'comment-row-text' }, t.text.trim().split('\n')[0]),
        h('span', { class: 'comment-row-meta' }, `${n} repl${n === 1 ? 'y' : 'ies'} · ${fmtAgo(t.createdAt)}`)));
  }

  function render() {
    const threads = app.visibleThreads();
    const open = threads.filter((t) => !t.resolved);
    const resolved = threads.filter((t) => t.resolved);
    count.textContent = String(open.length);
    count.classList.toggle('show', open.length > 0);
    if (!panelOpen) return;
    const shown = (filter === 'open' ? open : resolved).sort((a, b) => b.createdAt - a.createdAt);
    // Rebuild only when something shown changed: a row removed under the pointer would swallow its click.
    const key = JSON.stringify([filter, open.length, resolved.length, shown.map((t) => [t.id, t.text, t.replies.length, t.resolved, t.createdAt, t.authorName, t.authorColor])]);
    if (key === painted) return;
    painted = key;
    panel.replaceChildren(
      h('div', { class: 'comments-head' },
        h('h2', null, 'Comments'),
        h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close comments', onclick: () => togglePanel() }, icon('close', 18))),
      segmented<Filter>([
        { value: 'open', label: `Open (${open.length})` },
        { value: 'resolved', label: `Resolved (${resolved.length})` },
      ], filter, (v) => {
        filter = v;
        render();
      }, 'Filter comments'),
      shown.length
        ? h('div', { class: 'comments-list' }, ...shown.map(row))
        : h('p', { class: 'comment-muted comments-empty' }, filter === 'open' ? 'No open comments.' : 'No resolved comments.'),
    );
  }

  function openCard(target: Target) {
    current?.close(true);
    const origin = target.screen;
    const anchor = target.anchor;
    let threadId: string | null = anchor ? null : (target.threadId ?? null);
    let editing: string | null = null;
    let confirming: string | null = null;
    let footRo: boolean | null = null;
    let closed = false;
    const unsubs: (() => void)[] = [];

    const head = h('div', { class: 'comment-head' });
    const body = h('div', { class: 'comment-body' });
    const el = h('div', { class: 'comment-card tray', role: 'dialog', 'aria-label': 'Comment' }, head, body);
    const closeBtn = h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: () => close(true) }, icon('close', 18));

    const composeArea = textArea('Add a comment', () => post(), () => close(true));
    const composeSubmit = h('button', { class: 'btn primary', disabled: true, onclick: () => post() }, 'Comment');
    composeArea.addEventListener('input', () => {
      composeSubmit.disabled = !composeArea.value.trim();
    });
    const composeBody = h('div', { class: 'comment-compose' },
      composeArea,
      h('div', { class: 'comment-actions' }, h('button', { class: 'btn', onclick: () => close(true) }, 'Cancel'), composeSubmit));

    const replyArea = textArea('Reply', () => postReply(), () => close(true));
    const replyBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => postReply() }, 'Reply');
    replyArea.addEventListener('input', () => {
      replyBtn.disabled = !replyArea.value.trim();
    });
    const resolveBtn = h('button', { class: 'btn', onclick: () => toggleResolved() });
    const replyRow = h('div', { class: 'comment-actions' }, resolveBtn, replyBtn);
    const readonlyLine = h('p', { class: 'comment-muted' }, 'You can read comments on this board but not add them.');
    const msgs = h('div', { class: 'comment-msgs' });
    const foot = h('div', { class: 'comment-foot' });

    const editArea = textArea('Edit comment', () => saveEdit(), () => cancelEdit());
    const editSave = h('button', { class: 'btn primary', disabled: true, onclick: () => saveEdit() }, 'Save');
    const editCancel = h('button', { class: 'btn', onclick: () => cancelEdit() }, 'Cancel');
    editArea.addEventListener('input', () => {
      editSave.disabled = !editArea.value.trim();
    });

    function close(notify: boolean) {
      if (closed) return;
      closed = true;
      clearTimeout(arm);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      unsubs.forEach((f) => f());
      el.remove();
      if (current?.close === close) current = null;
      app.setDraftPin(null);
      if (notify) app.closeThread();
    }

    function post() {
      const text = composeArea.value.trim();
      if (!anchor || !text) return;
      const id = app.comments.addThread(authorOf(app), anchor, text);
      if (id === null) {
        toast('Could not add the comment.');
        return;
      }
      app.setDraftPin(null);
      threadId = id;
      app.openThread(id);
      body.replaceChildren(msgs, foot);
      renderThread();
      focusSoon(replyArea);
    }

    function postReply() {
      const id = threadId;
      const text = replyArea.value.trim();
      if (id === null || !text) return;
      if (!app.comments.reply(id, authorOf(app), text)) {
        toast('Could not add the reply.');
        return;
      }
      replyArea.value = '';
      replyBtn.disabled = true;
      renderThread();
    }

    function toggleResolved() {
      const t = threadId === null ? undefined : app.comments.get(threadId);
      if (t) app.comments.setResolved(t.id, !t.resolved, authorOf(app));
      renderThread();
    }

    function startEdit(m: Msg) {
      editing = m.id;
      confirming = null;
      editArea.value = m.text;
      editSave.disabled = !m.text.trim();
      renderThread();
      editArea.focus();
    }

    function cancelEdit() {
      editing = null;
      renderThread();
    }

    function saveEdit() {
      const id = threadId;
      const mid = editing;
      const text = editArea.value.trim();
      if (id === null || mid === null || !text) return;
      const ok = mid === id ? app.comments.editThread(id, text) : app.comments.editReply(id, mid, text);
      if (!ok) {
        toast('Could not save the comment.');
        return;
      }
      editing = null;
      renderThread();
    }

    function onDelete(m: Msg) {
      const id = threadId;
      if (id === null) return;
      if (confirming !== m.id) {
        confirming = m.id;
        renderThread();
        return;
      }
      confirming = null;
      const actor = { id: authorOf(app).id, moderator: canModerate(app) };
      if (m.root) {
        if (app.comments.removeThread(id, actor)) close(true);
        else toast('Could not delete the comment.');
        return;
      }
      if (!app.comments.removeReply(id, m.id, actor)) toast('Could not delete the comment.');
      renderThread();
    }

    function messageEl(m: Msg, ro: boolean, mine: string, mod: boolean, othersReplied: boolean): HTMLElement {
      const meta = h('div', { class: 'comment-meta' },
        avatar(m.authorName, m.authorColor),
        h('span', { class: 'comment-name' }, m.authorName),
        h('span', { class: 'comment-time' }, `${fmtAgo(m.createdAt)}${m.editedAt ? ' · edited' : ''}`));
      if (editing === m.id) {
        return h('div', { class: 'comment-msg' }, meta, editArea, h('div', { class: 'comment-actions' }, editCancel, editSave));
      }
      const own = m.authorId === mine;
      const acts: HTMLElement[] = [];
      if (!ro && own) acts.push(h('button', { class: 'btn ghost small', onclick: () => startEdit(m) }, 'Edit'));
      if (!ro && (mod || (own && !(m.root && othersReplied)))) {
        const armed = confirming === m.id;
        if (armed) acts.push(h('span', { class: 'comment-muted' }, 'Delete this comment?'));
        acts.push(h('button', { class: `btn ghost small${armed ? ' armed' : ''}`, onclick: () => onDelete(m) }, armed ? 'Click again to delete' : 'Delete'));
      }
      return h('div', { class: 'comment-msg' }, meta, h('p', { class: 'comment-text' }, m.text), acts.length ? h('div', { class: 'comment-actions' }, ...acts) : null);
    }

    function renderThread() {
      const id = threadId;
      if (id === null) return;
      const t = app.comments.get(id);
      if (!t) {
        close(true);
        return;
      }
      const ro = app.comments.readOnly();
      const mine = authorOf(app).id;
      const mod = canModerate(app);
      const list: Msg[] = [
        { id: t.id, root: true, authorId: t.authorId, authorName: t.authorName, authorColor: t.authorColor, text: t.text, createdAt: t.createdAt, editedAt: t.editedAt },
        ...t.replies.map((r) => ({ ...r, root: false })),
      ];
      if (!list.some((m) => m.id === editing)) editing = null;
      if (!list.some((m) => m.id === confirming)) confirming = null;
      const hadFocus = document.activeElement === editArea;
      head.replaceChildren(
        h('div', { class: 'comment-who' },
          avatar(t.authorName, t.authorColor),
          h('span', { class: 'comment-name' }, t.authorName),
          h('span', { class: 'comment-time' }, fmtAgo(t.createdAt)),
          t.resolved ? h('span', { class: 'comment-badge' }, 'Resolved') : null),
        closeBtn,
      );
      msgs.replaceChildren(...list.map((m) => messageEl(m, ro, mine, mod, list.some((x) => !x.root && x.authorId !== mine))));
      if (ro !== footRo) {
        footRo = ro;
        foot.replaceChildren(...(ro ? [readonlyLine] : [replyArea, replyRow]));
      }
      if (!ro) resolveBtn.replaceChildren(icon('check', 16), t.resolved ? 'Reopen' : 'Resolve');
      if (hadFocus) editArea.focus();
      placeCard(el, origin);
    }

    const onChange = () => {
      if (threadId !== null) renderThread();
    };
    const onComments = () => {
      if (app.openThreadId !== threadId) close(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) close(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const arm = window.setTimeout(() => {
      if (!closed) window.addEventListener('pointerdown', onDown, true);
    });
    unsubs.push(
      app.comments.onChange(onChange),
      app.comments.onReadOnly(onChange),
      app.on('comments', onComments),
      app.r.onCamera(() => {
        if (performance.now() >= flightUntil) close(true);
      }),
    );
    window.addEventListener('keydown', onKey);
    current = { close };
    chrome.appendChild(el);

    if (anchor) {
      app.closeThread();
      app.setDraftPin(anchor);
      head.replaceChildren(
        h('div', { class: 'comment-who' }, avatar(app.user.name, app.user.color), h('span', { class: 'comment-name' }, app.user.name)),
        closeBtn,
      );
      body.replaceChildren(composeBody);
      placeCard(el, origin);
      focusSoon(composeArea);
    } else if (threadId !== null) {
      app.openThread(threadId);
      body.replaceChildren(msgs, foot);
      renderThread();
      focusSoon(replyArea);
    }
  }

  app.onOpenComment = (target) => {
    if (target.anchor) {
      if (!app.comments.readOnly()) openCard(target);
    } else if (target.threadId) {
      openCard(target);
    }
  };

  app.comments.onChange(render);
  app.on('flow', render);
  app.on('comments', render);
  render();
  return { button };
}
