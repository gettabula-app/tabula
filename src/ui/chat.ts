import './chat.css';
import type { BoardApp } from '../app';
import type { ChatMessage } from '../api';
import { authState } from '../auth';
import { boardUnread, onChatBadge, openBoardChat, type BoardChat, type ChatView } from '../chat';
import { USER_COLORS } from '../palette';
import { h, icon } from './dom';
import { announce } from './announce';
import { popover, toast } from './common';
import type { SideTray } from './side-tray';
import {
  MAX_MENTIONS, MAX_TEXT, atBottom, buildRows, canDelete, canEdit, chatOpenKey, colourIndex, composerState, filterPeople, fromTokens,
  initials, insertMention, mentionLabel, mentionQuery, quoteText, segments, textLength, timeLabel, toTokens,
  type OutboxItem, type Person, type Row,
} from './chat-logic';

/** Six lines of 20px plus the field's padding. */
const COMPOSER_MAX_PX = 6 * 20 + 16;
/** Scrolled this close to the top, the next older page loads. */
const OLDER_PX = 48;
/** The character count shows from here. */
const COUNT_FROM = MAX_TEXT - 200;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* storage is unavailable: the tray simply opens closed next time */
  }
}

function copyText(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Clipboard is not available'));
}

/** Enter and the board's keys stay in the field; the board's shortcuts never see them. */
function guardKeys(ta: HTMLTextAreaElement) {
  ta.addEventListener('keyup', (e) => e.stopPropagation());
  ta.addEventListener('paste', (e) => e.stopPropagation());
}

function grow(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  const want = Math.min(ta.scrollHeight + 2, COMPOSER_MAX_PX);
  ta.style.height = `${want}px`;
  ta.style.overflowY = ta.scrollHeight + 2 > COMPOSER_MAX_PX ? 'auto' : 'hidden';
}

/** A message's text as DOM built with textContent only: plain text, http(s) links and mention chips. Never innerHTML. */
function textNodes(text: string, mentions: readonly { id: string; name: string | null }[], meId: string): Node[] {
  return segments(text, mentions).map((s) => {
    if (s.type === 'text') return document.createTextNode(s.text);
    if (s.type === 'link') {
      const a = h('a', { class: 'chat-link', href: s.url, target: '_blank', rel: 'noopener noreferrer' });
      a.textContent = s.url;
      return a;
    }
    const chip = h('span', { class: `chat-mention${s.id === meId ? ' me' : ''}` });
    chip.textContent = mentionLabel(s, mentions.some((p) => p.id === s.id));
    return chip;
  });
}

function avatar(id: string | null, name: string): HTMLElement {
  const a = h('span', { class: 'chat-avatar', 'aria-hidden': 'true' });
  a.textContent = initials(name);
  a.style.setProperty('--c', USER_COLORS[colourIndex(id, USER_COLORS.length)]);
  return a;
}

/** What one conversation needs to be drawn: the channel, the element to draw in and who is looking. */
export interface ConversationOptions {
  chat: BoardChat;
  /** Makes DOM ids unique (the people list of the composer). */
  id: string;
  panel: HTMLElement;
  signal: AbortSignal;
  meId: string;
  meName: string;
  /** Called with every new view, open or not (the board's button paints its badge from it). */
  onView?: (view: ChatView) => void;
}

export interface Conversation {
  /** The conversation is on screen (or not): it subscribes, loads, marks read and announces only while it is. */
  setOpen(open: boolean): void;
  /** Focuses the composer once the channel says whether this person may write; the list when they may not. */
  focusComposer(): void;
}

/**
 * One channel's messages and composer in `panel`: the list with its rows, scrolling and read marker, the composer with
 * mentions, replies, edit and delete. Board chat draws it in the side tray; the Chat page draws it beside the channel list.
 */
export function mountConversation(opts: ConversationOptions): Conversation {
  const { chat, panel, signal } = opts;
  const boardId = opts.id;
  const myId = opts.meId;
  const myName = opts.meName;

  const status = h('p', { class: 'chat-status', role: 'status' });
  const older = h('div', { class: 'chat-older' });
  // A log by role, but silent itself (a re-drawn or older row would be read out again): new messages from others are said
  // through the app's one live region (announce.ts) instead.
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'off', 'aria-label': 'Messages', tabindex: '0' }, older);
  const jump = h('button', { class: 'btn chat-jump', hidden: true, onclick: () => toBottom() }, 'Jump to latest');
  const body = h('div', { class: 'chat-body' }, log, jump);

  const replying = h('div', { class: 'chat-replying', hidden: true });
  const suggest = h('ul', { class: 'chat-suggest', id: `chat-suggest-${boardId}`, role: 'listbox', 'aria-label': 'People', hidden: true });
  const ta = h('textarea', {
    class: 'input chat-input', rows: 1, placeholder: 'Message', 'aria-label': 'Message', role: 'combobox', 'aria-multiline': 'true',
    'aria-autocomplete': 'list', 'aria-controls': suggest.id, 'aria-expanded': 'false',
  });
  const note = h('p', { class: 'chat-note', id: `chat-note-${boardId}` });
  ta.setAttribute('aria-describedby', note.id);
  const sendBtn = h('button', { class: 'btn primary chat-send', disabled: true, onclick: () => send() }, 'Send');
  const composer = h('div', { class: 'chat-composer' }, suggest, replying, ta, h('div', { class: 'chat-compose-foot' }, note, sendBtn));
  panel.replaceChildren(status, body, composer);

  let view: ChatView = chat.view();
  let open = false;
  let stick = true;
  let replyTo: { id: number; name: string; quote: string } | null = null;
  let picked: Person[] = [];
  let editing: { id: number; picked: Person[] } | null = null;
  let suggestions: Person[] = [];
  let focusWhenReady = false;
  let active = 0;
  const rowEls = new Map<string, { sig: string; el: HTMLElement }>();

  const editArea = h('textarea', { class: 'input chat-input chat-edit', rows: 1, 'aria-label': 'Edit message' });
  guardKeys(editArea);
  editArea.addEventListener('input', () => grow(editArea));
  editArea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      stopEdit();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void saveEdit();
    }
  });

  // ---------------------------------------------------------------- rows

  function personName(id: string): string | null {
    return view.people.find((p) => p.id === id)?.name ?? null;
  }

  function meta(name: string, at: number, extra?: string): HTMLElement {
    const time = h('time', { class: 'chat-time', datetime: new Date(at).toISOString() });
    time.textContent = extra ? `${timeLabel(at)} · ${extra}` : timeLabel(at);
    const who = h('span', { class: 'chat-name' });
    who.textContent = name;
    return h('div', { class: 'chat-meta' }, who, time);
  }

  function quoteEl(id: number): HTMLElement {
    const target = view.messages.find((m) => m.id === id);
    const q = h('div', { class: 'chat-quote' });
    if (!target) {
      q.textContent = 'Reply to an earlier message';
      return q;
    }
    const who = h('span', { class: 'chat-quote-name' });
    who.textContent = target.deleted ? '' : target.authorName;
    const text = h('span', { class: 'chat-quote-text' });
    text.textContent = quoteText(target);
    q.append(who, text);
    return q;
  }

  function messageEl(m: ChatMessage, head: boolean): HTMLElement {
    const el = h('div', { class: `chat-msg${head ? ' head' : ''}${m.deleted ? ' deleted' : ''}` });
    el.append(head ? avatar(m.authorId, m.authorName) : h('span', { class: 'chat-gutter', 'aria-hidden': 'true' }));
    const main = h('div', { class: 'chat-main' });
    if (head) main.append(meta(m.authorName, m.createdAt));
    if (m.replyTo !== null && !m.deleted) main.append(quoteEl(m.replyTo));
    if (m.deleted) {
      const tomb = h('p', { class: 'chat-tomb' });
      tomb.textContent = m.deletedBy === 'moderator' ? 'Message removed by a moderator' : 'Message deleted';
      main.append(tomb);
    } else if (editing?.id === m.id) {
      main.append(editArea, h('div', { class: 'chat-edit-actions' },
        h('button', { class: 'btn small', onclick: () => stopEdit() }, 'Cancel'),
        h('button', { class: 'btn primary small', onclick: () => void saveEdit() }, 'Save')));
    } else {
      const p = h('p', { class: 'chat-text' }, ...textNodes(m.text, m.mentions, myId));
      if (m.editedAt) {
        const mark = h('span', { class: 'chat-edited' });
        mark.textContent = ' (edited)';
        p.append(mark);
      }
      if (!head) p.prepend(h('span', { class: 'sr-only' }, `${m.authorName}, ${timeLabel(m.createdAt)}: `));
      main.append(p);
    }
    el.append(main);
    if (!m.deleted && editing?.id !== m.id) {
      const more = h('button', {
        class: 'icon-btn chat-more', 'aria-label': `Message actions, ${m.authorName} at ${timeLabel(m.createdAt)}`, 'aria-haspopup': 'menu',
      }, icon('dots', 16));
      more.addEventListener('click', () => openMenu(more, m));
      el.append(more);
    }
    return el;
  }

  function pendingEl(item: OutboxItem, head: boolean): HTMLElement {
    const stuck = item.state === 'blocked' || item.state === 'failed' || (item.state === 'queued' && !view.online && !item.waitUntil);
    const el = h('div', { class: `chat-msg pending${head ? ' head' : ''}${stuck ? ' failed' : ''}` });
    el.append(head ? avatar(myId, myName) : h('span', { class: 'chat-gutter', 'aria-hidden': 'true' }));
    const main = h('div', { class: 'chat-main' });
    if (head) main.append(meta(myName, item.createdLocal));
    if (item.replyTo !== null) main.append(quoteEl(item.replyTo));
    const mentions = [...item.text.matchAll(/@\{([A-Za-z0-9_-]{1,64})\}/g)].map((x) => ({ id: x[1], name: personName(x[1]) }));
    main.append(h('p', { class: 'chat-text' }, ...textNodes(item.text, mentions, myId)));
    const state = h('p', { class: 'chat-state' });
    const link = (label: string, fn: () => void) => h('button', { class: 'chat-action', onclick: fn }, label);
    const dot = () => h('span', { 'aria-hidden': 'true' }, ' · ');
    // offline, a queued message is not on its way: it says so and offers the same choices as a failed one
    if (item.state === 'failed' || (item.state === 'queued' && !view.online && !item.waitUntil)) {
      state.append(item.reason ? `Not sent: ${item.reason}. ` : 'Not sent. ', link('Retry', () => chat.retry(item.clientId)), dot(),
        link('Copy', () => copyText(fromTokens(item.text, mentions).text)), dot(), link('Discard', () => chat.discard(item.clientId)));
    } else if (item.state === 'blocked') {
      state.append(`Not sent: ${item.reason ?? 'refused'}. `, link('Copy', () => copyText(fromTokens(item.text, mentions).text)), dot(),
        link('Discard', () => chat.discard(item.clientId)));
    } else {
      state.textContent = item.reason ?? 'Sending…';
    }
    main.append(state);
    el.append(main);
    return el;
  }

  function sigOf(row: Row): string {
    if (row.type === 'day') return `d|${row.label}`;
    if (row.type === 'new') return 'n';
    if (row.type === 'pending') {
      const i = row.item;
      return JSON.stringify(['p', row.head, i.state, i.reason ?? '', i.text, i.replyTo, i.replyTo !== null ? quoteSig(i.replyTo) : '', view.people.length, view.online]);
    }
    const m = row.message;
    return JSON.stringify(['m', row.head, m.text, m.editedAt, m.deleted, m.deletedBy, m.authorName, m.mentions, editing?.id === m.id,
      m.replyTo !== null ? quoteSig(m.replyTo) : '']);
  }

  function quoteSig(id: number): string {
    const t = view.messages.find((m) => m.id === id);
    return t ? `${t.authorName}|${t.deleted}|${t.editedAt}` : 'none';
  }

  function rowEl(row: Row): HTMLElement {
    if (row.type === 'day') {
      const d = h('div', { class: 'chat-day', role: 'separator' });
      d.textContent = row.label;
      return d;
    }
    if (row.type === 'new') return h('div', { class: 'chat-new', role: 'separator' }, 'New messages');
    return row.type === 'pending' ? pendingEl(row.item, row.head) : messageEl(row.message, row.head);
  }

  /** Brings the list in line with the rows, rebuilding only rows that changed, so focus and scroll stay put. */
  function patch(rows: Row[]) {
    const keep = new Set<string>();
    let cursor: ChildNode | null = older.nextSibling;
    for (const row of rows) {
      keep.add(row.key);
      const sig = sigOf(row);
      let entry = rowEls.get(row.key);
      if (!entry || entry.sig !== sig) {
        const el = rowEl(row);
        el.dataset.key = row.key;
        if (entry) entry.el.replaceWith(el);
        if (entry && cursor === entry.el) cursor = el;
        entry = { sig, el };
        rowEls.set(row.key, entry);
      }
      if (entry.el !== cursor) log.insertBefore(entry.el, cursor);
      else cursor = cursor.nextSibling;
    }
    for (const [key, entry] of rowEls) {
      if (keep.has(key)) continue;
      entry.el.remove();
      rowEls.delete(key);
    }
  }

  function paintOlder() {
    older.replaceChildren();
    if (view.loadingOlder) older.append(h('span', null, 'Loading older messages…'));
    else if (view.hasOlder && view.messages.length) older.append(h('button', { class: 'chat-action', onclick: () => void chat.loadOlder() }, 'Load older messages'));
    else if (!view.messages.length && !view.pending.length && !view.loading) older.append(h('span', null, view.lost ? '' : 'No messages yet. Say hello.'));
    else if (view.messages.length && !view.hasOlder) older.append(h('span', null, 'Start of the conversation'));
  }

  // ---------------------------------------------------------------- scrolling and reading

  const isAtBottom = () => atBottom(log.scrollTop, log.scrollHeight, log.clientHeight);

  function toBottom() {
    stick = true;
    log.scrollTop = log.scrollHeight;
    jump.hidden = true;
    chat.markRead();
  }

  /**
   * The first message in view and how far its top is from the list's top. Date lines move (a day's line stays first
   * when older messages of that day arrive), so only messages anchor.
   */
  function anchor(): { key: string; offset: number } | null {
    for (const child of log.children) {
      const el = child as HTMLElement;
      const key = el.dataset.key ?? '';
      if (!key.startsWith('m:') && !key.startsWith('p:')) continue;
      if (el.offsetTop + el.offsetHeight > log.scrollTop) return { key, offset: el.offsetTop - log.scrollTop };
    }
    return null;
  }

  function afterScroll() {
    const bottom = isAtBottom();
    stick = bottom;
    jump.hidden = bottom || !open;
    if (!open) return;
    if (bottom) chat.markRead();
    if (log.scrollTop < OLDER_PX && view.hasOlder && !view.loadingOlder) void chat.loadOlder();
  }
  log.addEventListener('scroll', afterScroll, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (open && document.visibilityState === 'visible' && isAtBottom()) chat.markRead();
  }, { signal });

  // ---------------------------------------------------------------- composer

  function paintComposer() {
    const state = composerState(view.access, { lost: view.lost, signedOut: view.signedOut });
    const wasDisabled = ta.disabled;
    ta.disabled = !state.enabled;
    if (ta.disabled && !wasDisabled) closeSuggest();
    const length = textLength(toTokens(ta.value, picked));
    sendBtn.disabled = !state.enabled || !ta.value.trim() || length > MAX_TEXT;
    let line = state.reason ?? (view.access === null && view.loading ? 'Loading…' : '');
    if (state.enabled && !view.online) line = 'Offline. Messages are sent when the connection is back.';
    if (state.enabled && length >= COUNT_FROM) line = length > MAX_TEXT ? `${length - MAX_TEXT} characters too many` : `${MAX_TEXT - length} characters left`;
    note.textContent = line;
    note.classList.toggle('over', length > MAX_TEXT);
    ta.placeholder = state.enabled ? 'Message' : 'You cannot post here';
    replying.hidden = !replyTo || !state.enabled;
  }

  function paintReplying() {
    replying.replaceChildren();
    if (!replyTo) return;
    const label = h('span', { class: 'chat-replying-label' });
    label.textContent = `Replying to ${replyTo.name}`;
    const quote = h('span', { class: 'chat-replying-quote' });
    quote.textContent = replyTo.quote;
    replying.append(h('div', { class: 'chat-replying-text' }, label, quote),
      h('button', { class: 'icon-btn', 'aria-label': 'Cancel reply', onclick: () => { replyTo = null; paintReplying(); paintComposer(); ta.focus(); } }, icon('close', 16)));
  }

  function send() {
    if (ta.disabled) return;
    const text = toTokens(ta.value, picked).trim();
    if (!text) return;
    if (textLength(text) > MAX_TEXT) {
      paintComposer();
      return;
    }
    if (new Set(picked.filter((p) => text.includes(`@{${p.id}}`)).map((p) => p.id)).size > MAX_MENTIONS) {
      note.textContent = `A message can mention at most ${MAX_MENTIONS} people.`;
      return;
    }
    chat.send(text, replyTo?.id ?? null);
    ta.value = '';
    picked = [];
    replyTo = null;
    paintReplying();
    closeSuggest();
    grow(ta);
    stick = true;
    render();
  }

  function closeSuggest() {
    suggestions = [];
    suggest.hidden = true;
    suggest.replaceChildren();
    ta.setAttribute('aria-expanded', 'false');
    ta.removeAttribute('aria-activedescendant');
  }

  function paintSuggest() {
    suggest.replaceChildren(...suggestions.map((p, i) => {
      const li = h('li', { class: `chat-option${i === active ? ' on' : ''}`, role: 'option', id: `${suggest.id}-${i}`, 'aria-selected': String(i === active) });
      li.append(avatar(p.id, p.name));
      const name = h('span');
      name.textContent = p.name;
      li.append(name);
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        choose(i);
      });
      return li;
    }));
    suggest.hidden = suggestions.length === 0;
    ta.setAttribute('aria-expanded', String(suggestions.length > 0));
    if (suggestions.length) ta.setAttribute('aria-activedescendant', `${suggest.id}-${active}`);
    else ta.removeAttribute('aria-activedescendant');
  }

  function updateSuggest() {
    const q = ta.selectionStart === ta.selectionEnd ? mentionQuery(ta.value, ta.selectionStart) : null;
    if (!q || ta.disabled) return closeSuggest();
    const next = filterPeople(view.people, q.query, myId);
    if (next.map((p) => p.id).join() !== suggestions.map((p) => p.id).join()) active = 0;
    suggestions = next;
    paintSuggest();
  }

  function choose(i: number) {
    const person = suggestions[i];
    const q = mentionQuery(ta.value, ta.selectionStart);
    if (!person || !q) return closeSuggest();
    const next = insertMention(ta.value, q.start, ta.selectionStart, person.name);
    ta.value = next.value;
    ta.setSelectionRange(next.caret, next.caret);
    if (!picked.some((p) => p.id === person.id)) picked.push(person);
    closeSuggest();
    grow(ta);
    paintComposer();
    ta.focus();
  }

  guardKeys(ta);
  ta.addEventListener('input', () => {
    grow(ta);
    updateSuggest();
    paintComposer();
  });
  ta.addEventListener('click', updateSuggest);
  ta.addEventListener('blur', () => closeSuggest());
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length;
        paintSuggest();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        choose(active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSuggest();
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      ta.blur();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      requestAnimationFrame(updateSuggest);
    }
  });

  // ---------------------------------------------------------------- message actions

  function openMenu(anchorEl: HTMLElement, m: ChatMessage) {
    const own = m.authorId === myId;
    const item = (label: string, fn: () => void) => h('button', { class: 'menu-item', role: 'menuitem', onclick: fn }, h('span', null, label));
    const writable = composerState(view.access, { lost: view.lost, signedOut: view.signedOut }).enabled;
    const menu = h('div', { class: 'menu chat-menu', role: 'menu', 'aria-label': 'Message actions' });
    const pop = popover(anchorEl, menu, { side: 'left', onClose: () => anchorEl.isConnected && anchorEl.focus() });
    const first = () => menu.querySelector<HTMLButtonElement>('button')?.focus();
    const items = () => {
      menu.replaceChildren(...[
        writable ? item('Reply', () => {
          pop.close();
          replyTo = { id: m.id, name: m.authorName, quote: quoteText(m) };
          paintReplying();
          paintComposer();
          ta.focus();
        }) : null,
        item('Copy text', () => {
          pop.close();
          copyText(fromTokens(m.text, m.mentions).text);
        }),
        canEdit(m, myId, view.access, view.online) ? item('Edit', () => {
          pop.close();
          startEdit(m);
        }) : null,
        canDelete(m, myId, view.access, view.online) ? item(own ? 'Delete' : 'Remove', () => confirmDelete()) : null,
        !view.online && (own || view.access?.moderate) ? h('p', { class: 'chat-menu-note' }, 'Editing and deleting need a connection.') : null,
      ].filter((el) => el !== null) as HTMLElement[]);
    };
    const confirmDelete = () => {
      const label = h('p', { class: 'chat-menu-note' }, own ? 'Delete this message for everyone?' : 'Remove this message for everyone?');
      menu.replaceChildren(label,
        h('button', { class: 'menu-item', role: 'menuitem', onclick: () => {
          pop.close();
          chat.remove(m.id).catch((err: Error) => toast(err.message || 'Could not delete the message.'));
        } }, h('span', null, own ? 'Delete' : 'Remove')),
        h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { items(); first(); } }, h('span', null, 'Cancel')));
      first();
    };
    items();
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = [...menu.querySelectorAll<HTMLButtonElement>('button')];
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    });
    requestAnimationFrame(first);
  }

  function startEdit(m: ChatMessage) {
    const editable = fromTokens(m.text, m.mentions);
    editing = { id: m.id, picked: editable.picked };
    editArea.value = editable.text;
    render();
    grow(editArea);
    editArea.focus();
    editArea.setSelectionRange(editArea.value.length, editArea.value.length);
  }

  function stopEdit() {
    const id = editing?.id;
    editing = null;
    render();
    if (id !== undefined) rowEls.get(`m:${id}`)?.el.querySelector<HTMLButtonElement>('.chat-more')?.focus();
  }

  async function saveEdit() {
    if (!editing) return;
    const text = toTokens(editArea.value, editing.picked).trim();
    if (!text) return;
    if (textLength(text) > MAX_TEXT) {
      toast(`A message can be at most ${MAX_TEXT} characters.`);
      return;
    }
    try {
      await chat.edit(editing.id, text);
      stopEdit();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'Could not save the message.');
    }
  }

  // ---------------------------------------------------------------- render

  function paintStatus() {
    let line = '';
    if (view.lost) line = 'You no longer have access to this chat.';
    else if (view.error) line = view.error;
    else if (view.savedOnly) line = 'Offline, showing saved messages.';
    else if (view.signedOut) line = 'Signed out. Sign in again to see new messages.';
    status.textContent = line;
    status.hidden = !line;
  }

  /** The newest message already on screen or said, so only what arrives later is announced (not the page that loads). */
  let saidUpTo: number | null = null;
  function announceArrivals() {
    if (view.loading || !view.messages.length) return;
    const newest = view.messages[view.messages.length - 1].id;
    if (saidUpTo !== null) {
      for (const m of view.messages) {
        if (m.id <= saidUpTo || m.deleted || m.authorId === myId) continue;
        announce(`${m.authorName}: ${quoteText(m)}`, { key: 'chat', delay: 600, merge: true });
      }
    }
    saidUpTo = Math.max(saidUpTo ?? 0, newest);
  }

  function render() {
    view = chat.view();
    opts.onView?.(view);
    if (!open) return;
    announceArrivals();
    if (editing && !view.messages.some((m) => m.id === editing?.id && !m.deleted)) editing = null;
    const keepFocus = editing ? null : document.activeElement;
    const before = stick ? null : anchor();
    paintStatus();
    paintOlder();
    patch(buildRows(view.messages, view.pending, { newAfter: view.newAfter, meId: myId, now: Date.now() }));
    if (stick) log.scrollTop = log.scrollHeight;
    else if (before) {
      const el = rowEls.get(before.key)?.el;
      if (el) log.scrollTop = el.offsetTop - before.offset;
    }
    if (keepFocus instanceof HTMLElement && !keepFocus.isConnected) log.focus({ preventScroll: true });
    paintComposer();
    if (focusWhenReady && (view.access || view.lost || !view.loading)) {
      focusWhenReady = false;
      (ta.disabled ? log : ta).focus({ preventScroll: true });
    }
    jump.hidden = stick || isAtBottom();
    if (isAtBottom()) chat.markRead();
  }

  chat.onChange(render);

  render();
  return {
    setOpen(now) {
      if (now === open) return;
      open = now;
      if (open) stick = true;
      else {
        saidUpTo = null;
        closeSuggest();
        editing = null;
        focusWhenReady = false;
      }
      chat.setVisible(open);
      render();
    },
    focusComposer() {
      if (view.access) requestAnimationFrame(() => (ta.disabled ? log : ta).focus());
      else focusWhenReady = true;
    },
  };
}

/**
 * Board chat: the Chat button with its unread badge in the top bar, and the Chat tab of the side tray (docs/chat.md,
 * Interface). Messages are plain text; every node is built with textContent.
 */
export function mountChat(app: BoardApp, tray: SideTray): { button: HTMLButtonElement } {
  const boardId = app.conn.id;
  const signal = app.lifetime.signal;
  const chat = openBoardChat(boardId, signal);
  const auth = authState();
  const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
  const myId = me?.user.id ?? '';
  const myName = me?.user.name ?? 'You';
  const openKey = chatOpenKey(myId, boardId);
  tray.setAvailable('chat', true);
  let open = false;

  // ---------------------------------------------------------------- button
  const badge = h('span', { class: 'chat-count', 'aria-hidden': 'true' });
  const button = h('button', {
    class: 'icon-btn chat-toggle', 'aria-label': 'Chat', 'aria-pressed': 'false', 'aria-keyshortcuts': 'M', 'data-tip-key': 'm', onclick: () => tray.toggle('chat'),
  }, icon('chat', 18), badge);

  let badgeSeen: number | null = null;
  function paintBadge(v: { unread: number; mentions: number }) {
    // with the tab closed only counts arrive: say that there is something new, never what
    if (!open && badgeSeen !== null && v.unread > badgeSeen) {
      announce(`${v.unread} unread in board chat${v.mentions ? ', you were mentioned' : ''}`, { key: 'chat-badge', delay: 600 });
    }
    badgeSeen = v.unread;
    badge.textContent = v.unread > 99 ? '99+' : String(v.unread);
    badge.classList.toggle('show', v.unread > 0);
    badge.classList.toggle('mention', v.mentions > 0);
    const extra = v.unread ? `, ${v.unread} unread${v.mentions ? `, ${v.mentions} mentioning you` : ''}` : '';
    button.setAttribute('aria-label', `Chat${extra}`);
  }

  // ---------------------------------------------------------------- panel
  const conversation = mountConversation({ chat, id: boardId, panel: tray.slot('chat'), signal, meId: myId, meName: myName, onView: paintBadge });
  const offBadge = onChatBadge(() => {
    if (!open) paintBadge(boardUnread(boardId));
  });
  signal.addEventListener('abort', offBadge, { once: true });

  tray.onChange((tab) => {
    const now = tab === 'chat';
    if (now === open) return;
    open = now;
    button.classList.toggle('on', open);
    button.setAttribute('aria-pressed', String(open));
    writeFlag(openKey, open);
    conversation.setOpen(open);
  });

  app.toggleChat = () => {
    const opening = tray.current() !== 'chat';
    tray.toggle('chat');
    if (opening) conversation.focusComposer();
  };
  signal.addEventListener('abort', () => {
    app.toggleChat = null;
  }, { once: true });

  if (readFlag(openKey)) tray.show('chat');
  return { button };
}
