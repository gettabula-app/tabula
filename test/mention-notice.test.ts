import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionNotice } from '../src/ui/chat-logic';
import { FakeElement, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/chat.md, Mentions: the card for a mention in a channel you are not looking at. The store's listener and the announcer
// are replaced; what is checked is the card: its words, its two buttons, how many there are, and that it goes by itself.

const listeners = new Set<(n: MentionNotice) => void>();
const said: string[] = [];
vi.mock('../src/chat', () => ({
  onMention: (fn: (n: MentionNotice) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));
vi.mock('../src/ui/announce', () => ({ announce: (text: string) => void said.push(text) }));

const { mountMentionNotices } = await import('../src/ui/mention-notice');

let browser: FakeBrowser;
let stop: (() => void) | null = null;
const notice = (extra: Partial<MentionNotice> = {}): MentionNotice => ({ kind: 'team', ref: 't1', id: 1, from: 'Ana', channel: 'Design', text: 'can you check the room?', ...extra });
const emit = (n: MentionNotice) => listeners.forEach((fn) => fn(n));
const cards = () => browser.document.body.querySelectorAll('.mention-card');

beforeEach(() => {
  vi.useFakeTimers();
  browser = installFakeBrowser();
  listeners.clear();
  said.length = 0;
  stop = mountMentionNotices();
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  browser.uninstall();
});

describe('mention cards', () => {
  it('say who mentioned you, where, and the first words, without taking focus', () => {
    const before = browser.document.activeElement;
    emit(notice());
    expect(cards()).toHaveLength(1);
    expect(textOf(cards()[0].querySelector('.mention-title'))).toBe('Ana mentioned you in Design');
    expect(textOf(cards()[0].querySelector('.mention-text'))).toBe('can you check the room?');
    expect(browser.document.activeElement).toBe(before);
    expect(said).toEqual(['Ana mentioned you in Design']);
  });

  it('write names and text as text, never as markup', () => {
    emit(notice({ from: '<b>Ana</b>', text: '<img src=x onerror=alert(1)>' }));
    const card = cards()[0] as FakeElement;
    expect(card.querySelector('img')).toBeNull();
    expect(textOf(card.querySelector('.mention-text'))).toBe('<img src=x onerror=alert(1)>');
  });

  it('open a board, or a channel on the Chat page', () => {
    emit(notice({ kind: 'board', ref: 'b9' }));
    cards()[0].querySelector('.btn.primary')!.click();
    expect(browser.location.hash).toBe('#/b/b9');
    expect(cards()).toHaveLength(0);
    emit(notice({ kind: 'workspace', ref: 'main' }));
    cards()[0].querySelector('.btn.primary')!.click();
    expect(browser.location.hash).toBe('#/chat/workspace/main');
  });

  it('dismiss with the other button', () => {
    emit(notice());
    cards()[0].querySelectorAll('.btn')[1].click();
    expect(cards()).toHaveLength(0);
  });

  it('go away after twenty seconds', () => {
    emit(notice());
    vi.advanceTimersByTime(19_999);
    expect(cards()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(cards()).toHaveLength(0);
  });

  it('keep one card per channel, the newest, and at most three cards', () => {
    emit(notice({ id: 1, text: 'first' }));
    emit(notice({ id: 2, text: 'second' }));
    expect(cards().map((c) => textOf(c.querySelector('.mention-text')))).toEqual(['second']);
    emit(notice({ ref: 'a' }));
    emit(notice({ ref: 'b' }));
    emit(notice({ ref: 'c' }));
    expect(cards()).toHaveLength(3);
    expect(textOf(cards()[0])).toContain('Design');
  });

  it('are gone with the page', () => {
    emit(notice());
    stop?.();
    stop = null;
    expect(cards()).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });
});
