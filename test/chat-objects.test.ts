import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api';
import type { BoardChat, ChatView } from '../src/chat';
import { mountConversation, type ObjectRefs } from '../src/ui/chat';
import { FakeElement, FakeEvent, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/chat.md, Object link: a message points at a board object with a chip that goes there, and Reference selection attaches the
// selected object to the next message. The conversation is drawn into the fake DOM over a stub channel and a stub board.

const msg = (id: number, objectId: string | null, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, kind: 'board', ref: 'b1', authorId: 'ana', authorName: 'Ana', clientId: `client-${id}-xx`, text: `m${id}`, replyTo: null, objectId, mentions: [],
  createdAt: 1_700_000_000_000 + id, editedAt: null, deleted: false, deletedBy: null, ...extra,
});

let browser: FakeBrowser;
let view: ChatView;
const sent: { text: string; replyTo: number | null; objectId: string | null | undefined }[] = [];
let info: Record<string, { label: string; private: boolean; hidden: boolean }>;
let selected: string | null;
let opened: string[];

const chat = (): BoardChat => ({
  view: () => view,
  onChange: () => () => undefined,
  setVisible: () => undefined,
  loadOlder: async () => undefined,
  send: (text, replyTo, objectId) => void sent.push({ text, replyTo, objectId }),
  retry: () => undefined,
  discard: () => undefined,
  edit: async () => undefined,
  remove: async () => undefined,
  react: async () => undefined,
  markRead: () => undefined,
});
const objects = (): ObjectRefs => ({
  selected: () => selected,
  describe: (id) => info[id],
  open: (id) => {
    opened.push(id);
    return id !== 'unshowable';
  },
  onChange: () => () => undefined,
});

function mount(messages: ChatMessage[], withObjects = true) {
  view = {
    meId: 'me', messages, pending: [], access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [], loading: false,
    loadingOlder: false, hasOlder: false, savedOnly: false, lost: false, online: true, signedOut: false, newAfter: null, unread: 0, mentions: 0, error: null,
  };
  const panel = browser.document.createElement('div') as unknown as FakeElement;
  const signal = new AbortController().signal;
  const conv = mountConversation({ chat: chat(), id: 'b1', panel: panel as unknown as HTMLElement, signal, meId: 'me', meName: 'Me', ...(withObjects ? { objects: objects() } : {}) });
  conv.setOpen(true);
  return { panel, conv };
}

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1024, innerHeight: 800, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('toast', undefined);
  sent.length = 0;
  info = { o1: { label: 'Reviews were fast', private: false, hidden: false } };
  selected = null;
  opened = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  browser.uninstall();
});

const chips = (panel: FakeElement) => panel.querySelectorAll('.chat-object');

describe('object chips', () => {
  it('show what the object is now and go to it on a click', () => {
    const { panel } = mount([msg(1, 'o1')]);
    expect(chips(panel)).toHaveLength(1);
    expect(textOf(chips(panel)[0])).toBe('Reviews were fast');
    chips(panel)[0].click();
    expect(opened).toEqual(['o1']);
  });

  it('say when the object is gone, and do not try to go there', () => {
    const { panel } = mount([msg(1, 'gone')]);
    expect(textOf(chips(panel)[0])).toBe('Object no longer on the board');
    expect(chips(panel)[0].classList.contains('missing')).toBe(true);
    chips(panel)[0].click();
    expect(opened).toEqual([]);
  });

  it('never write the words of an object that is private to a session, or hidden', () => {
    info.o2 = { label: 'my private idea', private: true, hidden: false };
    info.o3 = { label: 'secret plan', private: false, hidden: true };
    const { panel } = mount([msg(1, 'o2'), msg(2, 'o3')]);
    expect(chips(panel).map((c) => textOf(c))).toEqual(['An object', 'A hidden object']);
    expect(panel.querySelector('.chat-log')!.textContent).not.toContain('private idea');
    expect(panel.querySelector('.chat-log')!.textContent).not.toContain('secret plan');
    chips(panel)[0].click();
    chips(panel)[1].click();
    expect(opened).toEqual([]);
  });

  it('draw a message without an object without a chip', () => {
    const { panel } = mount([msg(1, null)]);
    expect(chips(panel)).toHaveLength(0);
  });

  it('follow the board: the label changes when the object does', () => {
    const { panel, conv } = mount([msg(1, 'o1')]);
    info.o1 = { label: 'A better headline', private: false, hidden: false };
    conv.refresh();
    expect(textOf(chips(panel)[0])).toBe('A better headline');
    delete info.o1;
    conv.refresh();
    expect(textOf(chips(panel)[0])).toBe('Object no longer on the board');
  });

  it('are a way into the board on the Chat page, where no board is open', () => {
    const { panel } = mount([msg(1, 'o1')], false);
    const link = chips(panel)[0];
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('#/b/b1');
  });

  it('are left off messages of other kinds of channel', () => {
    const { panel } = mount([msg(1, 'o1', { kind: 'team', ref: 't1' })]);
    expect(chips(panel)).toHaveLength(0);
  });
});

describe('Reference selection', () => {
  const button = (panel: FakeElement) => panel.querySelector('.chat-attach-btn')!;
  const chip = (panel: FakeElement) => panel.querySelector('.chat-attached')!;
  const type = (panel: FakeElement, text: string) => {
    const ta = panel.querySelector('textarea.chat-input')!;
    ta.value = text;
    ta.dispatchEvent(new FakeEvent('input'));
    return ta;
  };

  it('is off until exactly one object is selected', () => {
    const { panel, conv } = mount([]);
    expect(button(panel).disabled).toBe(true);
    selected = 'o1';
    conv.refresh();
    expect(button(panel).disabled).toBe(false);
  });

  it('is not there where the board is not open', () => {
    const { panel } = mount([], false);
    expect(button(panel).hidden).toBe(true);
  });

  it('attaches the selected object, shows what it is, and sends its id with the message once', () => {
    const { panel, conv } = mount([]);
    selected = 'o1';
    conv.refresh();
    button(panel).click();
    expect(chip(panel).hidden).toBe(false);
    expect(textOf(chip(panel))).toContain('Pointing at: Reviews were fast');
    const ta = type(panel, 'Look at this');
    ta.dispatchEvent(Object.assign(new FakeEvent('keydown'), { key: 'Enter', shiftKey: false, isComposing: false }));
    expect(sent).toEqual([{ text: 'Look at this', replyTo: null, objectId: 'o1' }]);
    expect(chip(panel).hidden).toBe(true);
    type(panel, 'And another');
    panel.querySelector('textarea.chat-input')!.dispatchEvent(Object.assign(new FakeEvent('keydown'), { key: 'Enter', shiftKey: false, isComposing: false }));
    expect(sent[1].objectId).toBeNull();
  });

  it('can be taken off before sending', () => {
    const { panel, conv } = mount([]);
    selected = 'o1';
    conv.refresh();
    button(panel).click();
    chip(panel).querySelector('button')!.click();
    expect(chip(panel).hidden).toBe(true);
    const ta = type(panel, 'Never mind');
    ta.dispatchEvent(Object.assign(new FakeEvent('keydown'), { key: 'Enter', shiftKey: false, isComposing: false }));
    expect(sent[0].objectId).toBeNull();
  });

  it('drops the object if it is deleted from the board while attached', () => {
    const { panel, conv } = mount([]);
    selected = 'o1';
    conv.refresh();
    button(panel).click();
    delete info.o1;
    conv.refresh();
    expect(chip(panel).hidden).toBe(true);
  });
});
