import './mention-notice.css';
import { onMention } from '../chat';
import { announce } from './announce';
import { h } from './dom';
import { noticeHash, type MentionNotice } from './chat-logic';

/** A card stays this long, as the focus request cards do. */
const SHOW_MS = 20_000;
const MAX_CARDS = 3;

/**
 * Cards for mentions in channels you are not looking at (docs/chat.md, Mentions): who mentioned you, where, and the first
 * words. **Open** goes to the board or to the channel on the Chat page. The card never takes focus; a screen reader hears
 * it through the app's announcer. Mounted once for the page's life; returns what stops it.
 */
export function mountMentionNotices(): () => void {
  const stack = h('div', { class: 'mention-stack' });
  document.body.appendChild(stack);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const keyOf = (n: MentionNotice) => `${n.kind}/${n.ref}`;
  function drop(key: string, el: HTMLElement) {
    clearTimeout(timers.get(key));
    timers.delete(key);
    el.remove();
  }

  const off = onMention((n) => {
    const key = keyOf(n);
    // a newer mention in the same channel replaces its card (kind and ref are letters, digits, - and _)
    stack.querySelector<HTMLElement>(`[data-key="${key}"]`)?.remove();
    clearTimeout(timers.get(key));
    const title = h('p', { class: 'mention-title' });
    title.textContent = `${n.from} mentioned you in ${n.channel}`;
    const text = h('p', { class: 'mention-text' });
    text.textContent = n.text;
    const card: HTMLElement = h('div', { class: 'mention-card', 'data-key': key },
      title, text,
      h('div', { class: 'mention-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => { drop(key, card); location.hash = noticeHash(n); } }, 'Open'),
        h('button', { class: 'btn', type: 'button', onclick: () => drop(key, card) }, 'Dismiss')));
    const kept = Array.from(stack.children).slice(0, MAX_CARDS - 1) as HTMLElement[];
    for (const gone of Array.from(stack.children).slice(MAX_CARDS - 1) as HTMLElement[]) clearTimeout(timers.get(gone.dataset.key ?? ''));
    stack.replaceChildren(card, ...kept);
    timers.set(key, setTimeout(() => drop(key, card), SHOW_MS));
    announce(`${n.from} mentioned you in ${n.channel}`);
  });

  return () => {
    off();
    for (const t of timers.values()) clearTimeout(t);
    stack.remove();
  };
}
