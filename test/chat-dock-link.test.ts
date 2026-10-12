import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubDeps } from './chat-dock-deps';
import { FakeEvent, installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

// docs/chat.md, Dock: the Chat link of the top bar opens the dock where you are; the address (and the Chat page) stay for a new tab,
// a modified click and the Chat page itself.

vi.mock('../src/chat', () => ({
  onChatBadge: () => () => undefined,
  totalUnread: () => ({ unread: 0, mentions: 0 }),
  watchChat: () => undefined,
  channelUnread: () => ({ unread: 0, mentions: 0 }),
  fetchChannels: async () => [],
  hasUnlisted: () => false,
  openChat: () => ({}),
}));
vi.mock('../src/auth', () => ({
  authState: () => ({ mode: 'signed-in', me: { user: { id: 'u1', name: 'Ana' }, chat: true } }),
  chatAvailable: () => true,
  signOut: async () => undefined,
}));

let browser: FakeBrowser | undefined;
afterEach(() => {
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllGlobals();
});

async function setup(withDock = true) {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  const overlay = browser.document.createElement('div');
  browser.document.body.appendChild(overlay);
  const mod = await import('../src/ui/chat-dock');
  const stub = stubDeps();
  const dock = withDock ? mod.mountChatDock(overlay as unknown as HTMLElement, { userId: 'u1', deps: stub.deps, storage: { getItem: () => null, setItem: () => undefined } }) : null;
  if (!withDock) mod.syncChatDock(overlay as unknown as HTMLElement, null, false);
  const { createTopbar } = await import('../src/ui/topbar');
  const me = { user: { id: 'u1', name: 'Ana', email: 'a@example.test', role: 'member' }, chat: true } as never;
  const link = (page: 'boards' | 'chat') => {
    const bar = createTopbar(page, me) as unknown as FakeElement;
    return (bar.querySelectorAll('.topbar-link') as FakeElement[]).find((a) => a.getAttribute('href') === '#/chat')!;
  };
  const click = (a: FakeElement, over: Record<string, unknown> = {}) => {
    const e = Object.assign(new FakeEvent('click'), { button: 0 }, over);
    a.dispatchEvent(e);
    return e;
  };
  return { dock, link, click, stub };
}

describe('the Chat link of the top bar', () => {
  it('opens the dock in place and puts the cursor in the message box, without leaving the page', async () => {
    const { dock, link, click, stub } = await setup();
    const e = click(link('boards'));
    expect(e.defaultPrevented).toBe(true);
    expect(dock!.mode()).toBe('open');
    await Promise.resolve();
    expect(stub.watches).toHaveLength(1);
  });

  it('on a page with no board, closing from inside puts focus back on the Chat link', async () => {
    const { dock, link, click, stub } = await setup();
    const a = link('boards');
    click(a);
    const close = (browser!.document.body.querySelectorAll('.chat-dock-btn') as FakeElement[]).find((b) => b.getAttribute('aria-label') === 'Close chat')!;
    close.focus();
    close.click();
    expect(dock!.mode()).toBe('closed');
    expect(stub.deps).toBeDefined();
  });

  it('leaves a modified click, a middle click, and the Chat page itself to the address', async () => {
    const { dock, link, click } = await setup();
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(click(link('boards'), over).defaultPrevented).toBe(false);
    }
    expect(click(link('chat')).defaultPrevented).toBe(false);
    expect(dock!.mode()).toBe('closed');
  });

  it('is a plain link when there is no dock (chat off or nobody signed in)', async () => {
    const { link, click } = await setup(false);
    expect(click(link('boards')).defaultPrevented).toBe(false);
  });
});
