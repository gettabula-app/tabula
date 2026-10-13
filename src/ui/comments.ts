import './comments.css';
import type { BoardApp } from '../app';
import { personColor } from '../palette';
import { mayDelete, type Anchor, type Author, type Reply, type Thread } from '../comments';
import type { Point } from '../types';
import { authState } from '../auth';
import { h, icon } from './dom';
import { announce } from './announce';
import { guestMark } from './guest-mark';
import { fmtAgo, segmented, toast } from './common';
import { mentionLabel, type Person } from './chat-logic';
import { choosePerson, commentSegments, editableText, knownPeople, offerable, mentionState, plainText, storedText, withinLimit, MAX_TEXT } from './comment-mentions-logic';
import type { SideTray } from './side-tray';
import { safeInsets } from './safe-area';

type Target = { threadId?: string; anchor?: Anchor; screen: Point };
type Msg = Pick<Reply, 'id' | 'authorId' | 'authorName' | 'authorColor' | 'text' | 'createdAt' | 'editedAt' | 'imported' | 'importedBy' | 'legacy'> & { root: boolean };
type Filter = 'open' | 'resolved';

const GAP = 12;
const MARGIN = 12;
/** A row's camera flight takes about 420ms; moves inside this window do not close the card it opens. */
const FLIGHT_MS = 600;

/**
 * Writes are attributed to the account in accounts mode, otherwise to this device's user. The account's current name is
 * read from the signed-in session, so a rename made in another tab is not undone by the relay.
 */
function authorOf(app: BoardApp): Author {
  const auth = authState();
  return auth.mode === 'signed-in'
    ? { id: auth.me.user.id, name: auth.me.user.name, color: app.user.color }
    : { id: app.user.id, name: app.user.name, color: app.user.color };
}

/** Only the board owner may delete other people's comments. */
function canModerate(app: BoardApp): boolean {
  return app.role === 'owner';
}

function avatar(name: string, color: string): HTMLSpanElement {
  const a = h('span', { class: 'comment-avatar', 'aria-hidden': 'true' }, ([...name.trim()][0] ?? '?').toUpperCase());
  a.style.setProperty('--c', personColor(color));
  return a;
}

/** Who a comment can name: the people on this board the client knows (comment authors and the people here now). */
function peopleOf(app: BoardApp): Person[] {
  return knownPeople(app.comments.list(), app.participants().map((p) => ({ id: p.user.id, name: p.user.name })));
}

/** The `@` list of a comment field. `onKey` runs first on every key; it returns true when it has used the key. */
interface MentionKeys { onKey: (e: KeyboardEvent) => boolean }

/** Enter posts, Shift+Enter adds a line, Escape calls onEscape. Keys never reach the board's shortcuts. */
function textArea(label: string, onEnter: () => void, onEscape: () => void, mention?: MentionKeys): HTMLTextAreaElement {
  const ta = h('textarea', { class: 'input comment-input', 'aria-label': label, placeholder: label, maxlength: '4000', rows: 2 });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (mention?.onKey(e)) return;
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

let listSeq = 0;

/**
 * The people list under a comment field, with chat's rules: typing `@` offers the people here, Up and Down move, Enter picks,
 * Escape closes the list only, and Tab leaves the field as it does without a list (focus is never held). A pick shows
 * `@Name` in the field and is stored as the token when the comment is posted (storedText).
 */
function mentionPicker(ta: HTMLTextAreaElement, people: () => Person[], meId: string, changed: () => void) {
  const id = `comment-suggest-${++listSeq}`;
  const el = h('ul', { class: 'comment-suggest', id, role: 'listbox', 'aria-label': 'People', hidden: true });
  ta.setAttribute('role', 'combobox');
  ta.setAttribute('aria-multiline', 'true');
  ta.setAttribute('aria-autocomplete', 'list');
  ta.setAttribute('aria-controls', id);
  ta.setAttribute('aria-expanded', 'false');
  let options: Person[] = [];
  let active = 0;
  let picked: Person[] = [];

  function close() {
    options = [];
    el.hidden = true;
    el.replaceChildren();
    ta.setAttribute('aria-expanded', 'false');
    ta.removeAttribute('aria-activedescendant');
  }

  function paint() {
    el.replaceChildren(...options.map((p, i) => {
      const li = h('li', { class: `comment-option${i === active ? ' on' : ''}`, role: 'option', id: `${id}-${i}`, 'aria-selected': String(i === active) }, p.name);
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        choose(i);
      });
      return li;
    }));
    el.hidden = options.length === 0;
    ta.setAttribute('aria-expanded', String(options.length > 0));
    if (options.length) ta.setAttribute('aria-activedescendant', `${id}-${active}`);
    else ta.removeAttribute('aria-activedescendant');
  }

  function update() {
    const state = ta.selectionStart === ta.selectionEnd ? mentionState(ta.value, ta.selectionStart, people(), meId, picked) : null;
    if (!state) return close();
    if (state.options.map((p) => p.id).join() !== options.map((p) => p.id).join()) active = 0;
    options = state.options;
    paint();
  }

  function choose(i: number) {
    const person = options[i];
    const next = person ? choosePerson(ta.value, ta.selectionStart, person, picked) : null;
    if (!next) return close();
    ta.value = next.text;
    ta.setSelectionRange(next.caret, next.caret);
    picked = next.picked;
    close();
    changed();
    ta.focus();
  }

  const onKey = (e: KeyboardEvent): boolean => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') requestAnimationFrame(update);
    if (!options.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
      paint();
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      choose(active);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return true;
    }
    if (e.key === 'Tab') close();
    return false;
  };

  ta.addEventListener('input', update);
  ta.addEventListener('click', update);
  ta.addEventListener('blur', () => close());

  return {
    el,
    onKey,
    picked: () => picked,
    reset() {
      picked = [];
      close();
    },
  };
}

/** A text as DOM for a comment: plain text, and each mention as a chip with the person's name (never innerHTML). */
function textNodes(text: string, people: Person[], meId: string): Node[] {
  return commentSegments(text, people).map((s) => {
    if (s.type !== 'mention') return document.createTextNode(s.type === 'link' ? s.url : s.text);
    const chip = h('span', { class: `comment-mention${s.id === meId ? ' me' : ''}` });
    chip.textContent = mentionLabel(s, people.some((p) => p.id === s.id));
    return chip;
  });
}

function focusSoon(ta: HTMLTextAreaElement) {
  requestAnimationFrame(() => ta.focus());
  setTimeout(() => ta.focus(), 30);
}

/** Below and to the right of the point, flipped left or up when that overflows, clamped inside the viewport. */
function placeCard(el: HTMLElement, p: Point) {
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const safe = safeInsets();
  const left = MARGIN + safe.left;
  const right = MARGIN + safe.right;
  const top = MARGIN + safe.top;
  const bottom = MARGIN + safe.bottom;
  let x = p.x + GAP, y = p.y + GAP;
  if (x + w > vw - right) x = p.x - GAP - w;
  if (y + hgt > vh - bottom) y = p.y - GAP - hgt;
  el.style.left = `${Math.max(left, Math.min(x, vw - w - right))}px`;
  el.style.top = `${Math.max(top, Math.min(y, vh - hgt - bottom))}px`;
}

/** The comment tool's card, the comments panel (the Comments tab of the side tray) and its count badge. */
export function mountComments(app: BoardApp, chrome: HTMLElement, tray: SideTray): { button: HTMLButtonElement } {
  let current: { close: (notify: boolean) => void } | null = null;
  let panelOpen = false;
  let filter: Filter = 'open';
  let painted = '';
  let flightUntil = 0;

  const count = h('span', { class: 'comment-count', 'aria-hidden': 'true' });
  const button = h('button', { class: 'icon-btn comment-toggle', 'aria-label': 'Comments', 'aria-pressed': 'false', onclick: () => tray.toggle('comments') }, icon('comment', 18), count);
  const panel = tray.slot('comments');

  tray.onChange((tab) => {
    const open = tab === 'comments';
    if (open === panelOpen) return;
    panelOpen = open;
    painted = '';
    button.classList.toggle('on', panelOpen);
    button.setAttribute('aria-pressed', String(panelOpen));
    render();
  });

  function openRow(t: Thread) {
    flightUntil = performance.now() + FLIGHT_MS;
    app.flyToThread(t.id);
    app.openThread(t.id);
    app.onOpenComment?.({ threadId: t.id, screen: { x: window.innerWidth / 2, y: window.innerHeight / 2 } });
  }

  function row(t: Thread, people: Person[]) {
    const n = t.replies.length;
    return h('button', { class: 'comment-row', onclick: () => openRow(t) },
      avatar(t.authorName, t.authorColor),
      h('span', { class: 'comment-row-body' },
        t.authorId.startsWith('guest_') ? h('span', { class: 'comment-row-author' }, t.authorName, ' ', guestMark('comment-badge comment-guest')) : null,
        h('span', { class: 'comment-row-text' }, plainText(t.text.trim().split('\n')[0], people)),
        h('span', { class: 'comment-row-meta' }, `${n} repl${n === 1 ? 'y' : 'ies'} · ${fmtAgo(t.createdAt)}`)));
  }

  // what others wrote since the last render, said once (the first render only learns what is there)
  let seen: Map<string, number> | null = null;
  function announceArrivals(threads: Thread[]) {
    const me = authorOf(app).id;
    const next = new Map(threads.map((t) => [t.id, t.replies.length]));
    if (seen) {
      for (const t of threads) {
        const before = seen.get(t.id);
        if (before === undefined && t.authorId !== me) announce(`New comment from ${t.authorName}`, { key: 'comments', delay: 600, merge: true });
        else if (before !== undefined && t.replies.length > before && t.replies[t.replies.length - 1].authorId !== me) {
          announce(`${t.replies[t.replies.length - 1].authorName} replied to a comment`, { key: 'comments', delay: 600, merge: true });
        }
      }
    }
    seen = next;
  }

  function render() {
    const threads = app.visibleThreads();
    announceArrivals(app.comments.list());
    const open = threads.filter((t) => !t.resolved);
    const resolved = threads.filter((t) => t.resolved);
    count.textContent = String(open.length);
    count.classList.toggle('show', open.length > 0);
    button.setAttribute('aria-label', open.length ? `Comments, ${open.length} open ${open.length === 1 ? 'comment' : 'comments'}` : 'Comments');
    if (!panelOpen) return;
    const shown = (filter === 'open' ? open : resolved).sort((a, b) => b.createdAt - a.createdAt);
    const people = peopleOf(app);
    // Rebuild only when something shown changed: a row removed under the pointer would swallow its click.
    const key = JSON.stringify([filter, open.length, resolved.length, shown.map((t) => [t.id, t.authorId, t.text, t.replies.length, t.resolved, t.createdAt, t.authorName, t.authorColor])]);
    if (key === painted) return;
    painted = key;
    panel.replaceChildren(
      segmented<Filter>([
        { value: 'open', label: `Open (${open.length})` },
        { value: 'resolved', label: `Resolved (${resolved.length})` },
      ], filter, (v) => {
        filter = v;
        render();
      }, 'Filter comments'),
      shown.length
        ? h('div', { class: 'comments-list' }, ...shown.map((t) => row(t, people)))
        : h('p', { class: 'comment-muted comments-empty' }, filter === 'open' ? 'No open comments.' : 'No resolved comments.'),
    );
  }

  function openCard(target: Target) {
    current?.close(true);
    const active = document.activeElement as HTMLElement | null;
    const activeIsControl = active && active !== document.body && (
      ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) || active.tagName === 'A' && active.hasAttribute('href') || active.hasAttribute('tabindex')
    );
    const opener = activeIsControl ? active : chrome.querySelector<HTMLElement>('.rail-btn[aria-label="Comment"]');
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
    const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(true) }, icon('close', 18));

    const mine = authorOf(app).id;
    const composeSubmit = h('button', { class: 'btn primary', disabled: true, onclick: () => post() }, 'Comment');
    const composeHook: MentionKeys = { onKey: () => false };
    const composeArea = textArea('Add a comment', () => post(), () => close(true), composeHook);
    const composePicker = mentionPicker(composeArea, () => offerable(peopleOf(app)), mine, () => {
      composeSubmit.disabled = !composeArea.value.trim();
    });
    composeHook.onKey = composePicker.onKey;
    composeArea.addEventListener('input', () => {
      composeSubmit.disabled = !composeArea.value.trim();
    });
    const composeBody = h('div', { class: 'comment-compose' },
      composePicker.el,
      composeArea,
      h('div', { class: 'comment-actions' }, h('button', { class: 'btn', onclick: () => close(true) }, 'Cancel'), composeSubmit));

    const replyBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => postReply() }, 'Reply');
    const replyHook: MentionKeys = { onKey: () => false };
    const replyArea = textArea('Reply', () => postReply(), () => close(true), replyHook);
    const replyPicker = mentionPicker(replyArea, () => offerable(peopleOf(app)), mine, () => {
      replyBtn.disabled = !replyArea.value.trim();
    });
    replyHook.onKey = replyPicker.onKey;
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
      const restoreOpener = el.contains(document.activeElement);
      clearTimeout(arm);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      unsubs.forEach((f) => f());
      el.remove();
      if (current?.close === close) current = null;
      app.setDraftPin(null);
      if (notify) app.closeThread();
      if (restoreOpener && opener?.isConnected) opener.focus();
    }

    function post() {
      const text = storedText(composeArea.value, composePicker.picked());
      if (!anchor || !composeArea.value.trim()) return;
      if (!withinLimit(text)) {
        toast(`A comment can be at most ${MAX_TEXT} characters.`);
        return;
      }
      const id = app.comments.addThread(authorOf(app), anchor, text);
      if (id === null) {
        toast('Could not add the comment.');
        return;
      }
      composePicker.reset();
      app.setDraftPin(null);
      threadId = id;
      app.openThread(id);
      body.replaceChildren(msgs, foot);
      renderThread();
      focusSoon(replyArea);
    }

    function postReply() {
      const id = threadId;
      const text = storedText(replyArea.value, replyPicker.picked());
      if (id === null || !replyArea.value.trim()) return;
      if (!withinLimit(text)) {
        toast(`A comment can be at most ${MAX_TEXT} characters.`);
        return;
      }
      if (!app.comments.reply(id, authorOf(app), text)) {
        toast('Could not add the reply.');
        return;
      }
      replyArea.value = '';
      replyPicker.reset();
      replyBtn.disabled = true;
      renderThread();
    }

    function toggleResolved() {
      const t = threadId === null ? undefined : app.comments.get(threadId);
      if (t) app.comments.setResolved(t.id, !t.resolved, authorOf(app));
      renderThread();
    }

    let editPicked: Person[] = [];

    function startEdit(m: Msg) {
      editing = m.id;
      confirming = null;
      const editable = editableText(m.text, peopleOf(app));
      editArea.value = editable.text;
      editPicked = editable.picked;
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
      const text = storedText(editArea.value, editPicked);
      if (id === null || mid === null || !text) return;
      if (!withinLimit(text)) {
        toast(`A comment can be at most ${MAX_TEXT} characters.`);
        return;
      }
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

    function messageEl(m: Msg, ro: boolean, mine: string, mod: boolean, othersReplied: boolean, people: Person[]): HTMLElement {
      const meta = h('div', { class: 'comment-meta' },
        avatar(m.authorName, m.authorColor),
        h('span', { class: 'comment-name' }, m.authorName),
        m.authorId.startsWith('guest_') ? guestMark('comment-badge comment-guest') : null,
        m.imported ? h('span', { class: 'comment-badge' }, 'imported') : m.legacy ? h('span', { class: 'comment-badge' }, 'legacy') : null,
        h('span', { class: 'comment-time' }, `${fmtAgo(m.createdAt)}${m.editedAt ? ' · edited' : ''}`));
      if (editing === m.id) {
        return h('div', { class: 'comment-msg' }, meta, editArea, h('div', { class: 'comment-actions' }, editCancel, editSave));
      }
      const own = m.authorId === mine && !m.imported && !m.legacy;
      const acts: HTMLElement[] = [];
      if (!ro && own) acts.push(h('button', { class: 'btn ghost small', onclick: () => startEdit(m) }, 'Edit'));
      // The same rule as the relay: a moderator, the author (not once others replied), or whoever imported the comment.
      const deletable = mayDelete(m, { id: mine, moderator: mod }) && !(m.root && !mod && m.authorId === mine && othersReplied);
      if (!ro && deletable) {
        const armed = confirming === m.id;
        if (armed) acts.push(h('span', { class: 'comment-muted' }, 'Delete this comment?'));
        acts.push(h('button', { class: `btn ghost small${armed ? ' armed' : ''}`, onclick: () => onDelete(m) }, armed ? 'Click again to delete' : 'Delete'));
      }
      return h('div', { class: 'comment-msg' }, meta, h('p', { class: 'comment-text' }, ...textNodes(m.text, people, mine)), acts.length ? h('div', { class: 'comment-actions' }, ...acts) : null);
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
        {
          id: t.id, root: true, authorId: t.authorId, authorName: t.authorName, authorColor: t.authorColor, text: t.text, createdAt: t.createdAt,
          editedAt: t.editedAt, imported: t.imported, importedBy: t.importedBy, legacy: t.legacy,
        },
        ...t.replies.map((r) => ({ ...r, root: false })),
      ];
      if (ro || !list.some((m) => m.id === editing)) editing = null;
      if (!list.some((m) => m.id === confirming)) confirming = null;
      const hadFocus = document.activeElement === editArea;
      head.replaceChildren(...(t.resolved ? [h('span', { class: 'comment-badge' }, 'Resolved')] : []), closeBtn);
      const people = peopleOf(app);
      msgs.replaceChildren(...list.map((m) => messageEl(m, ro, mine, mod, list.some((x) => !x.root && x.authorId !== mine), people)));
      if (ro !== footRo) {
        footRo = ro;
        foot.replaceChildren(...(ro ? [readonlyLine] : [replyPicker.el, replyArea, replyRow]));
      }
      if (!ro) resolveBtn.replaceChildren(icon('check', 16), t.resolved ? 'Reopen' : 'Resolve');
      // The relay undoes a resolve by anyone else: the author, or whoever may edit the board, may resolve.
      resolveBtn.hidden = !(!app.role || app.role === 'owner' || app.role === 'editor' || t.authorId === mine);
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
      app.comments.onReadOnly((readOnly) => {
        if (readOnly && anchor) close(false);
        else onChange();
      }),
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
