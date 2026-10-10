import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { BoardApp } from '../src/app';
import { Comments, type Author } from '../src/comments';
import { mountComments } from '../src/ui/comments';
import { mountSideTray } from '../src/ui/side-tray';
import { FakeElement, installFakeBrowser, need, type FakeBrowser } from './fake-dom';

let browser: FakeBrowser;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('Element', FakeElement);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  browser.uninstall();
});

const author: Author = { id: 'visual-qa', name: 'Visual QA', color: '#2F6FED' };

function mountThread(commentAuthor: Author = author, focusCanvas = false) {
  const chromeElement = browser.document.createElement('div');
  browser.document.body.appendChild(chromeElement);
  const chrome = chromeElement as unknown as HTMLElement;
  const comments = new Comments(new Y.Doc());
  const threadId = comments.addThread(commentAuthor, { x: 100, y: 100 }, 'Root message');
  if (!threadId) throw new Error('could not seed the comment thread');
  const opener = browser.document.createElement('button') as unknown as HTMLElement;
  opener.className = 'rail-btn';
  opener.setAttribute('aria-label', 'Comment');
  chromeElement.appendChild(opener as unknown as FakeElement);
  if (focusCanvas) {
    const canvas = browser.document.createElement('div');
    chromeElement.appendChild(canvas);
    canvas.focus();
  } else opener.focus();

  const listeners = new Map<string, Set<() => void>>();
  let openThreadId: string | null = null;
  const app = {
    user: { id: 'viewer', name: 'Viewer', color: '#D64545' },
    role: 'owner',
    comments,
    r: { onCamera: () => () => undefined },
    get openThreadId() { return openThreadId; },
    onOpenComment: null as BoardApp['onOpenComment'],
    visibleThreads: () => comments.list(),
    flyToThread: () => undefined,
    openThread(id: string | null) {
      openThreadId = id;
      for (const listener of listeners.get('comments') ?? []) listener();
    },
    closeThread() {
      openThreadId = null;
      for (const listener of listeners.get('comments') ?? []) listener();
    },
    setDraftPin: () => undefined,
    on(name: string, listener: () => void) {
      const set = listeners.get(name) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
  } as unknown as BoardApp;

  const { button } = mountComments(app, chrome, mountSideTray(chrome));
  app.onOpenComment?.({ threadId, screen: { x: 100, y: 100 } });
  const card = need(chromeElement, '.comment-card');
  cleanups.push(() => {
    need(card, 'button[aria-label="Close"]').click();
    comments.doc.destroy();
  });
  return { app, card, comments, threadId, button, opener };
}

describe('comment thread card', () => {
  it('shows the root author once and one author label per reply', async () => {
    const { card, comments, threadId } = mountThread();

    const nameCount = () => card.querySelectorAll('.comment-name').filter((el) => el.textContent === author.name).length;
    expect(nameCount()).toBe(1);
    expect(card.querySelectorAll('.comment-msg').length).toBe(1);
    expect(need(card, '.comment-text').textContent).toBe('Root message');

    comments.reply(threadId, author, 'Reply message');
    await new Promise((resolve) => setImmediate(resolve));

    expect(nameCount()).toBe(2);
    expect(card.querySelectorAll('.comment-msg').length).toBe(2);
    expect(card.querySelectorAll('.comment-text').map((el) => el.textContent)).toEqual(['Root message', 'Reply message']);

    comments.setResolved(threadId, true, author);
    await new Promise((resolve) => setImmediate(resolve));
    const head = need(card, '.comment-head');
    expect(head.children[0].className).toBe('comment-badge');
    expect(head.children[0].textContent).toBe('Resolved');
    expect(head.children[1].getAttribute('aria-label')).toBe('Close');
  });

  it('marks a guest comment even when its name matches a member name', () => {
    const { card } = mountThread({ id: 'guest_session123', name: 'Visual QA', color: '#2F6FED' });
    expect(need(card, '.comment-name').textContent).toBe('Visual QA');
    expect(need(card, '.comment-guest').textContent).toBe('Guest');
  });

  it('hides comment write controls after the comments document becomes read only', () => {
    const guest: Author = { id: 'guest_session123', name: 'Guest visitor', color: '#2F6FED' };
    const { app, card, comments, threadId } = mountThread(guest);
    (app as unknown as { user: Author }).user = { ...guest };
    comments.reply(threadId, guest, 'A reply by the guest');

    comments.setReadOnly(true);

    const buttons = card.querySelectorAll('button').map((button) => button.textContent);
    expect(buttons).not.toContain('Reply');
    expect(buttons).not.toContain('Edit');
    expect(buttons).not.toContain('Delete');
    expect(buttons).not.toContain('Resolve');
    expect(card.querySelectorAll('textarea')).toHaveLength(0);
    expect(card.textContent).toContain('You can read comments on this board but not add them.');
  });

  it('includes the visible open-comment count in the Comments button name', () => {
    const { button } = mountThread();
    expect(button.getAttribute('aria-label')).toBe('Comments, 1 open comment');
  });

  it('returns focus to the control that opened the comment card', () => {
    const { card, opener } = mountThread();
    need(card, 'textarea[aria-label="Reply"]').focus();
    need(card, 'button[aria-label="Close"]').click();
    expect(browser.document.activeElement).toBe(opener);
  });

  it('returns canvas comment editing to the Comment tool when the canvas itself had focus', () => {
    const { card, opener } = mountThread(author, true);
    need(card, 'textarea[aria-label="Reply"]').focus();
    need(card, 'button[aria-label="Close"]').click();
    expect(browser.document.activeElement).toBe(opener);
  });
});
