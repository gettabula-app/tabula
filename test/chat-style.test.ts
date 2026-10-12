import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api';
import type { BoardChat, ChatView } from '../src/chat';
import { mountConversation } from '../src/ui/chat';
import { FakeElement, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// Message styling in the shared conversation (docs/chat.md, Interface): grouped runs, own bubbles, the mention row, hover tools,
// reaction pills and the empty state with the colour squares of the people here. Drawn into the fake DOM over a stub channel;
// the quick-reactions bar and the compact style are checked in a real browser (chat-style-browser.test.ts).

const T0 = Date.UTC(2026, 9, 12, 9, 40);
const msg = (id: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, kind: 'workspace', ref: 'main', authorId: 'ana', authorName: 'Ana Lima', clientId: `client-${id}-xx`, text: `m${id}`, replyTo: null, objectId: null, mentions: [],
  createdAt: T0 + id * 1000, editedAt: null, deleted: false, deletedBy: null, ...over,
});

let browser: FakeBrowser;
let view: ChatView;

const chat = (): BoardChat => ({
  view: () => view,
  onChange: () => () => undefined,
  setVisible: () => undefined,
  loadOlder: async () => undefined,
  send: () => undefined,
  retry: () => undefined,
  discard: () => undefined,
  edit: async () => undefined,
  remove: async () => undefined,
  react: async () => undefined,
  markRead: () => undefined,
});

function mount(messages: ChatMessage[], over: Partial<ChatView> = {}) {
  view = {
    meId: 'me', messages, pending: [], access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [], loading: false,
    loadingOlder: false, hasOlder: false, savedOnly: false, lost: false, online: true, signedOut: false, newAfter: null, unread: 0, mentions: 0, error: null, ...over,
  };
  const panel = browser.document.createElement('div') as unknown as FakeElement;
  mountConversation({ chat: chat(), id: 'workspace-main', panel: panel as unknown as HTMLElement, signal: new AbortController().signal, meId: 'me', meName: 'Me' }).setOpen(true);
  return panel;
}

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1024, innerHeight: 800, matchMedia: () => ({ matches: false }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  browser.uninstall();
});

describe('message rows', () => {
  it('groups consecutive messages from one person: one avatar and header, later rows keep a hidden name and time', () => {
    const panel = mount([msg(1), msg(2), msg(3, { authorId: 'ben', authorName: 'Ben Okafor' })]);
    const rows = panel.querySelectorAll('.chat-msg');
    expect(rows.map((r) => r.classList.contains('head'))).toEqual([true, false, true]);
    expect(rows.map((r) => r.querySelectorAll('.chat-avatar').length)).toEqual([1, 0, 1]);
    // the second row's name and time exist for the compact one-liner, but are hidden from screen readers (the text carries them)
    const cont = rows[1].querySelector('.chat-meta')!;
    expect(cont.classList.contains('cont')).toBe(true);
    expect(cont.getAttribute('aria-hidden')).toBe('true');
    expect(textOf(cont)).toContain('Ana Lima');
    expect(rows[0].querySelector('.chat-meta')!.getAttribute('aria-hidden')).toBeNull();
    expect(textOf(rows[1].querySelector('.chat-text')!)).toContain('Ana Lima, ');
  });

  it("marks the person's own messages and pending ones as own, and no one else's", () => {
    const panel = mount([msg(1), msg(2, { authorId: 'me', authorName: 'Me' })]);
    expect(panel.querySelectorAll('.chat-msg').map((r) => r.classList.contains('own'))).toEqual([false, true]);
  });

  it('highlights a message from someone else that names this person, and not one that names someone else or was written by them', () => {
    const named = msg(1, { text: 'hi @{me}', mentions: [{ id: 'me', name: 'Me' }] });
    const other = msg(2, { text: 'hi @{zed}', mentions: [{ id: 'zed', name: 'Zed' }] });
    const self = msg(3, { authorId: 'me', authorName: 'Me', text: '@{me}', mentions: [{ id: 'me', name: 'Me' }] });
    const panel = mount([named, other, self]);
    expect(panel.querySelectorAll('.chat-msg').map((r) => r.classList.contains('mention'))).toEqual([true, false, false]);
    expect(panel.querySelector('.chat-mention.me')).not.toBeNull();
  });

  it('gives each row a person colour for the square and, in the compact dock, the name', () => {
    const panel = mount([msg(1)]);
    expect(panel.querySelector('.chat-msg')!.style.getPropertyValue('--c')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('draws reaction pills as pressed buttons with a label that says who reacted', () => {
    const panel = mount([msg(1, { reactions: [{ emoji: '👍', userIds: ['ana', 'me'] }, { emoji: '🎉', userIds: ['ben'] }] })]);
    const pills = panel.querySelectorAll('.chat-reaction');
    expect(pills.map((p) => p.getAttribute('aria-label'))).toEqual(['👍, 2 people, including you', '🎉, 1 person']);
    expect(pills.map((p) => p.classList.contains('mine'))).toEqual([true, false]);
    expect(pills.map((p) => p.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });
});

describe('hover tools', () => {
  it('has React, Reply and the actions menu as labelled buttons for a writer who is online', () => {
    const panel = mount([msg(1)]);
    const tools = panel.querySelector('.chat-hover')!;
    const labels = tools.querySelectorAll('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^React to Ana Lima at /);
    expect(labels[1]).toMatch(/^Reply to Ana Lima at /);
    expect(labels[2]).toMatch(/^Message actions, Ana Lima at /);
    expect(tools.querySelector('.chat-react')!.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('leaves out React offline and both React and Reply when the person may not write', () => {
    const offline = mount([msg(1)], { online: false });
    expect(offline.querySelectorAll('.chat-hover button').map((b) => b.className)).toEqual(['icon-btn chat-reply', 'icon-btn chat-more']);
    const readOnly = mount([msg(1)], { access: { write: false, moderate: false, role: 'member', readOnly: true } });
    expect(readOnly.querySelectorAll('.chat-hover button').map((b) => b.className)).toEqual(['icon-btn chat-more']);
  });

  it('Reply puts the quoted message above the box and focuses it', () => {
    const panel = mount([msg(1, { text: 'a question' })]);
    (panel.querySelector('.chat-reply') as FakeElement).click();
    expect(textOf(panel.querySelector('.chat-replying-label')!)).toBe('Replying to Ana Lima');
    expect(textOf(panel.querySelector('.chat-replying-quote')!)).toBe('a question');
    expect(browser.document.activeElement).toBe(panel.querySelector('textarea.chat-input'));
  });
});

describe('the empty conversation', () => {
  it('shows the squares of the people here (not this person, at most four), a heading and one line', () => {
    const people = ['me', 'a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: `Person ${id.toUpperCase()}` }));
    const panel = mount([], { people });
    const block = panel.querySelector('.chat-older')!;
    expect(block.querySelectorAll('.chat-empty-people .chat-avatar')).toHaveLength(4);
    expect(block.querySelector('.chat-empty-people')!.getAttribute('aria-hidden')).toBe('true');
    expect(textOf(block.querySelector('.chat-welcome-title')!)).toBe('No messages yet');
    expect(textOf(block)).toContain('Say hello, or type @ to mention someone.');
  });

  it('shows only the heading and the line when nobody else is known', () => {
    const panel = mount([], { people: [{ id: 'me', name: 'Me' }] });
    expect(panel.querySelector('.chat-empty-people')).toBeNull();
    expect(textOf(panel.querySelector('.chat-welcome-title')!)).toBe('No messages yet');
  });
});

describe('plain text only', () => {
  it('never sets innerHTML in the conversation or the page', () => {
    for (const file of ['../src/ui/chat.ts', '../src/ui/chat-page.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/\.innerHTML\s*=/);
    }
  });
});
