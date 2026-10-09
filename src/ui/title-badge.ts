import { onChatBadge, totalUnread } from '../chat';

// docs/chat.md, Unread: while the tab is in the background, the page title starts with the number of unread chat messages,
// "(3) Roadmap - Tabula", so a person with many tabs can see that something was said. The prefix leaves when the tab is shown.

/** The prefix for a count, or nothing: the unread count in front while the tab is hidden and something is unread. */
export function prefixFor(unread: number, hidden: boolean): string {
  return hidden && unread > 0 ? `(${unread > 99 ? '99+' : unread}) ` : '';
}

/**
 * The title a page should have: its own words (`title` minus the prefix this module put there, `applied`) with the prefix
 * for now. Only a prefix this module added is taken off, so a board called "(2024) Plan" keeps its brackets.
 */
export function titleFor(title: string, applied: string, unread: number, hidden: boolean): string {
  const base = applied && title.startsWith(applied) ? title.slice(applied.length) : title;
  return prefixFor(unread, hidden) + base;
}

/**
 * Keeps the prefix on the page's title. Pages set their own titles whenever they change (a board renamed, another page
 * opened), so a change of the title is looked at too and the prefix put back. Returns what stops it.
 */
export function mountTitleBadge(): () => void {
  let applying = false;
  let applied = '';
  const paint = () => {
    const unread = totalUnread().unread;
    const hidden = document.visibilityState === 'hidden';
    const want = titleFor(document.title, applied, unread, hidden);
    applied = prefixFor(unread, hidden);
    if (want === document.title) return;
    applying = true;
    document.title = want;
    applying = false;
  };
  const offBadge = onChatBadge(paint);
  document.addEventListener('visibilitychange', paint);
  const el = document.querySelector('title');
  const watch = el && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => {
      if (!applying) paint();
    })
    : null;
  if (el) watch?.observe(el, { childList: true, characterData: true, subtree: true });
  paint();
  return () => {
    offBadge();
    document.removeEventListener('visibilitychange', paint);
    watch?.disconnect();
    document.title = titleFor(document.title, applied, 0, false);
  };
}
