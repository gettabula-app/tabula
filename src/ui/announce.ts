import { h } from './dom';

// One visually hidden live region for what a sighted person sees change on the board without being told: people joining,
// the sync state, a deleted selection, an undo. Toasts (common.ts) are for messages that are also shown; this is for the rest.
// docs/accessibility-audit.md, S4.

let region: HTMLElement | null = null;
let alternate = false;
const pending = new Map<string, { texts: string[]; timer: number }>();

function say(text: string) {
  if (!region?.isConnected) {
    region = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.appendChild(region);
  }
  // the same words twice in a row are announced again only if the text differs
  alternate = !alternate;
  region.textContent = alternate ? text : `${text} `;
}

/**
 * Announces `text` to screen readers. With `delay`, messages under one `key` wait for it and go out together (`merge`, joined
 * with a full stop) or as the last one only, so a burst of changes is one announcement.
 */
export function announce(text: string, opts: { key?: string; delay?: number; merge?: boolean } = {}) {
  if (!opts.delay) {
    say(text);
    return;
  }
  const key = opts.key ?? text;
  const entry = pending.get(key) ?? { texts: [], timer: 0 };
  pending.set(key, entry);
  if (opts.merge) entry.texts.push(text);
  else entry.texts = [text];
  clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => {
    pending.delete(key);
    say(entry.texts.join('. '));
  }, opts.delay);
}
