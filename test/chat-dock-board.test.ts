import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubDeps } from './chat-dock-deps';
import { FakeEvent, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

// docs/chat.md, Dock: the board's chat in the dock. The Chat button toggles the dock, the conversation is drawn into the dock
// the first time it is shown and kept (not drawn again) while it is minimised or closed, and it goes with the board.

const mocks = vi.hoisted(() => ({
  mounts: [] as { panel: unknown; signal: AbortSignal; onView?: (v: { unread: number; mentions: number }) => void; conv: { setOpen: ReturnType<typeof vi.fn>; focusComposer: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } }[],
  unread: { unread: 0, mentions: 0 },
}));

vi.mock('../src/chat', () => ({
  boardUnread: () => mocks.unread,
  onChatBadge: () => () => undefined,
  openBoardChat: () => ({}),
}));
vi.mock('../src/auth', () => ({ authState: () => ({ mode: 'signed-in', me: { user: { id: 'u1', name: 'Ana' }, chat: true } }) }));
vi.mock('../src/layers', () => ({ layerLabel: () => 'Note' }));
vi.mock('../src/ui/announce', () => ({ announce: () => undefined }));
vi.mock('../src/ui/chat', () => ({
  mountConversation: (opts: { panel: unknown; signal: AbortSignal; onView?: (v: { unread: number; mentions: number }) => void }) => {
    const conv = { setOpen: vi.fn<(open: boolean) => void>(), focusComposer: vi.fn<() => void>(), refresh: vi.fn<() => void>() };
    mocks.mounts.push({ panel: opts.panel, signal: opts.signal, onView: opts.onView, conv });
    return conv;
  },
}));

let browser: FakeBrowser | undefined;
afterEach(() => {
  browser?.uninstall();
  browser = undefined;
  mocks.mounts.length = 0;
  mocks.unread = { unread: 0, mentions: 0 };
  vi.unstubAllGlobals();
});

async function setup() {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const overlay = browser.document.createElement('div');
  browser.document.body.appendChild(overlay);
  const { mountChatDock } = await import('../src/ui/chat-dock');
  const { mountChat } = await import('../src/ui/board-chat');
  const memory = new Map<string, string>();
  const dock = mountChatDock(overlay as unknown as HTMLElement, { userId: 'u1', deps: stubDeps().deps, storage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) } });
  const life = new AbortController();
  const app = { conn: { id: 'b1' }, r: { dockInset: 0, setCamera() {} }, participants: () => [], lifetime: life, selection: [], on: () => () => undefined, store: { get: () => undefined, isShown: () => true }, flow: { isHidden: () => false }, flyToObject: () => true, toggleChat: null as null | (() => void) };
  (app as { lifetime: unknown }).lifetime = { signal: life.signal };
  const trayListeners = new Set<(tab: string | null) => void>();
  let trayTab: string | null = null;
  const tray = {
    hide: vi.fn<() => void>(() => { trayTab = null; trayListeners.forEach((fn) => fn(null)); }),
    show: (tab: string) => { trayTab = tab; trayListeners.forEach((fn) => fn(tab)); },
    current: () => trayTab,
    onChange: (fn: (tab: string | null) => void) => { trayListeners.add(fn); return () => trayListeners.delete(fn); },
  };
  const { button } = mountChat(app as never, dock, tray as never);
  return { dock, button: button as unknown as FakeElement, app, life, overlay: overlay as unknown as FakeElement, tray };
}

describe('board chat in the dock', () => {
  it('draws nothing while the dock is closed, and draws the conversation into the dock body when it opens', async () => {
    const { dock, button } = await setup();
    expect(mocks.mounts).toHaveLength(0);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(dock.mode()).toBe('open');
    expect(mocks.mounts).toHaveLength(1);
    expect(mocks.mounts[0].panel).toBe(dock.conversationHost);
    expect(mocks.mounts[0].conv.setOpen).toHaveBeenLastCalledWith(true);
    expect(mocks.mounts[0].conv.focusComposer).not.toHaveBeenCalled(); // the button leaves focus where it is
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the conversation while it is minimised or closed and does not draw it twice', async () => {
    const { dock, button } = await setup();
    button.click();
    const { conv } = mocks.mounts[0];
    dock.dispatch('minimise');
    expect(conv.setOpen).toHaveBeenLastCalledWith(false);
    dock.dispatch('open');
    expect(conv.setOpen).toHaveBeenLastCalledWith(true);
    button.click(); // closes
    expect(dock.mode()).toBe('closed');
    expect(conv.setOpen).toHaveBeenLastCalledWith(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(mocks.mounts).toHaveLength(1);
  });

  it('opens straight away when the dock was left open', async () => {
    browser = installFakeBrowser();
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const overlay = browser.document.createElement('div');
    browser.document.body.appendChild(overlay);
    const { mountChatDock } = await import('../src/ui/chat-dock');
    const { mountChat } = await import('../src/ui/board-chat');
    const storage = { getItem: () => JSON.stringify({ mode: 'open', size: 'open', channel: null }), setItem: () => undefined };
    const dock = mountChatDock(overlay as unknown as HTMLElement, { userId: 'u1', deps: stubDeps().deps, storage });
    const app = { conn: { id: 'b1' }, r: { dockInset: 0, setCamera() {} }, participants: () => [], lifetime: { signal: new AbortController().signal }, selection: [], on: () => () => undefined, store: { get: () => undefined, isShown: () => true }, flow: { isHidden: () => false }, flyToObject: () => true, toggleChat: null };
    mountChat(app as never, dock);
    expect(mocks.mounts).toHaveLength(1);
    expect(mocks.mounts[0].conv.setOpen).toHaveBeenLastCalledWith(true);
  });

  it('paints the unread count on the button, with what to say for a screen reader', async () => {
    const { dock, button } = await setup();
    dock.dispatch('open');
    mocks.mounts[0].onView?.({ unread: 3, mentions: 1 });
    expect(textOf(button.querySelector('.chat-count') as FakeElement)).toBe('3');
    expect(button.getAttribute('aria-label')).toBe('Chat, 3 unread, 1 mentioning you'); // the board's Chat button keeps its wording
    mocks.mounts[0].onView?.({ unread: 120, mentions: 0 });
    expect(textOf(button.querySelector('.chat-count') as FakeElement)).toBe('99+');
  });

  it('Esc inside the dock closes it and puts focus on the Chat button, unless something inside used the Esc', async () => {
    const { dock, button, overlay } = await setup();
    button.click();
    const panel = overlay.querySelector('.chat-dock') as FakeElement;
    const focus = vi.spyOn(button, 'focus');
    const used = Object.assign(new FakeEvent('keydown'), { key: 'Escape' });
    used.preventDefault(); // the message box or an edit used it
    panel.dispatchEvent(used);
    expect(dock.mode()).toBe('open');
    panel.dispatchEvent(Object.assign(new FakeEvent('keydown'), { key: 'Escape' }));
    expect(dock.mode()).toBe('closed');
    expect(focus).toHaveBeenCalled();
  });

  it('the M shortcut toggles it like the button', async () => {
    const { dock, app } = await setup();
    app.toggleChat!();
    expect(dock.mode()).toBe('open');
    expect(mocks.mounts[0].conv.focusComposer).toHaveBeenCalledTimes(1); // M is for typing: the cursor goes to the message box
    app.toggleChat!();
    expect(dock.mode()).toBe('closed');
    expect(mocks.mounts[0].conv.focusComposer).toHaveBeenCalledTimes(1); // and not when it closes
  });

  it('goes with the board: aborted, emptied, and the shortcut released', async () => {
    const { dock, button, app, life } = await setup();
    button.click();
    expect(mocks.mounts[0].signal.aborted).toBe(false);
    life.abort();
    expect(mocks.mounts[0].signal.aborted).toBe(true);
    expect((dock.conversationHost as unknown as FakeElement).children).toHaveLength(0);
    expect(app.toggleChat).toBeNull();
  });

  it('a second board takes the dock over and the first board is let go', async () => {
    const { dock, button } = await setup();
    button.click();
    const first = mocks.mounts[0];
    const { mountChat } = await import('../src/ui/board-chat');
    const app2 = { conn: { id: 'b2' }, r: { dockInset: 0, setCamera() {} }, participants: () => [], lifetime: { signal: new AbortController().signal }, selection: [], on: () => () => undefined, store: { get: () => undefined, isShown: () => true }, flow: { isHidden: () => false }, flyToObject: () => true, toggleChat: null };
    mountChat(app2 as never, dock);
    expect(first.signal.aborted).toBe(true);
    expect(mocks.mounts).toHaveLength(2);
    expect(mocks.mounts[1].conv.setOpen).toHaveBeenLastCalledWith(true);
  });

  it('makes room for the dock: the camera and the page know how far it reaches, and it is nothing when closed or under 900 px', async () => {
    const { dock, app, button } = await setup();
    const root = browser!.document.documentElement as unknown as FakeElement;
    expect(app.r.dockInset).toBe(0);
    button.click();
    expect(app.r.dockInset).toBe(372);
    expect(root.style.getPropertyValue('--dock-inset')).toBe('372px');
    dock.dispatch('compact');
    expect(app.r.dockInset).toBe(312);
    dock.dispatch('minimise');
    expect(app.r.dockInset).toBe(0);
    expect(root.style.getPropertyValue('--dock-inset')).toBe('0px');
    (window as unknown as { innerWidth: number }).innerWidth = 800;
    dock.dispatch('open');
    expect(app.r.dockInset).toBe(0); // overlays on a narrow window
  });

  it('shares the right edge with Comments: opening one puts the other away', async () => {
    const { dock, tray, button } = await setup();
    tray.show('comments');
    button.click();
    expect(dock.mode()).toBe('open');
    expect(tray.hide).toHaveBeenCalled();
    tray.show('comments');
    expect(dock.mode()).toBe('bubble');
  });
});
