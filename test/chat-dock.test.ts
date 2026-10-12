import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubDeps } from './chat-dock-deps';
import { installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';
import { DEFAULT_DOCK, dockHiddenOn, dockInset, dockKey, loadDock, nextDock, parseDock, saveDock, type DockEvent, type DockPrefs } from '../src/ui/chat-dock-state';

// docs/chat.md, Dock: the state machine and what is remembered (pure), then the host in the overlay layer.

const prefs = (mode: DockPrefs['mode'], size: DockPrefs['size'] = 'open'): DockPrefs => ({ mode, size, channel: null });

describe('the dock state machine', () => {
  it.each<[DockPrefs['mode'], DockEvent, DockPrefs['mode']]>([
    ['closed', 'open', 'open'],
    ['closed', 'toggle', 'open'],
    ['open', 'toggle', 'closed'],
    ['compact', 'toggle', 'closed'],
    ['bubble', 'toggle', 'open'],
    ['open', 'compact', 'compact'],
    ['compact', 'expand', 'open'],
    ['open', 'minimise', 'bubble'],
    ['compact', 'minimise', 'bubble'],
    ['bubble', 'open', 'open'],
    ['open', 'close', 'closed'],
    ['bubble', 'close', 'closed'],
  ])('%s + %s -> %s', (from, event, to) => {
    expect(nextDock(prefs(from), event).mode).toBe(to);
  });

  it('comes back from a bubble or from closed in the size it had', () => {
    let p = nextDock(prefs('open'), 'compact');
    p = nextDock(p, 'minimise');
    expect(p).toMatchObject({ mode: 'bubble', size: 'compact' });
    expect(nextDock(p, 'open').mode).toBe('compact');
    expect(nextDock(nextDock(p, 'close'), 'toggle').mode).toBe('compact');
    expect(nextDock(nextDock(p, 'expand'), 'minimise')).toMatchObject({ size: 'open' });
  });

  it('a minimise of a dock that is not shown changes nothing', () => {
    expect(nextDock(prefs('closed'), 'minimise')).toEqual(prefs('closed'));
    expect(nextDock(prefs('bubble'), 'minimise')).toEqual(prefs('bubble'));
  });
});

describe('how far the dock reaches in', () => {
  it('is the dock and its gap when shown, and nothing otherwise or under 900 px', () => {
    expect(dockInset('open', 1280)).toBe(372);
    expect(dockInset('compact', 1280)).toBe(312);
    expect(dockInset('bubble', 1280)).toBe(0);
    expect(dockInset('closed', 1280)).toBe(0);
    expect(dockInset('open', 899)).toBe(0);
    expect(dockInset('open', 900)).toBe(372);
  });
});

describe('where the dock stays away', () => {
  it('is hidden on sign-in, consent, invitations, join codes and the Chat page, and shown on the rest', () => {
    for (const name of ['signin', 'verify', 'oauth-consent', 'invite', 'join', 'chat']) expect(dockHiddenOn(name)).toBe(true);
    for (const name of ['home', 'templates', 'board', 'tracker', 'admin', 'template-edit']) expect(dockHiddenOn(name)).toBe(false);
  });
});

describe('what is remembered', () => {
  it('starts closed for a person with nothing stored, and for stored text that is wrong', () => {
    expect(parseDock(null)).toEqual(DEFAULT_DOCK);
    for (const bad of ['', 'x', '[]', '{"mode":"sideways","size":"huge","channel":5}', 'null']) expect(parseDock(bad)).toEqual(DEFAULT_DOCK);
  });

  it('keeps the good fields and drops the bad ones, one by one', () => {
    expect(parseDock('{"mode":"bubble","size":"compact","channel":"board/b1"}')).toEqual({ mode: 'bubble', size: 'compact', channel: 'board/b1' });
    expect(parseDock('{"mode":"open","size":"compact","channel":"../x"}')).toEqual({ mode: 'compact', size: 'compact', channel: null });
    expect(parseDock('{"mode":"open","size":"nope"}').size).toBe('open');
  });

  it('is kept per person', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveDock('ana', prefs('open'), storage);
    expect(loadDock('ana', storage).mode).toBe('open');
    expect(loadDock('ben', storage)).toEqual(DEFAULT_DOCK);
    expect(dockKey('ana')).not.toBe(dockKey('ben'));
  });

  it('survives storage that throws or is missing', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
    expect(() => saveDock('ana', prefs('open'), blocked)).not.toThrow();
    expect(loadDock('ana', blocked)).toEqual(DEFAULT_DOCK);
    expect(() => saveDock('ana', prefs('open'), null)).not.toThrow();
    expect(loadDock('ana', null)).toEqual(DEFAULT_DOCK);
  });
});

describe('the dock host', () => {
  let browser: FakeBrowser | undefined;
  afterEach(() => {
    browser?.uninstall();
    browser = undefined;
    vi.unstubAllGlobals();
  });

  async function setup(storage?: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }) {
    browser = installFakeBrowser();
    const overlay = browser.document.createElement('div');
    browser.document.body.appendChild(overlay);
    const mod = await import('../src/ui/chat-dock');
    return { mod, overlay: overlay as unknown as HTMLElement, host: overlay as FakeElement, storage };
  }
  const memory = () => {
    const store = new Map<string, string>();
    return { store, storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
  };
  const shown = (host: FakeElement) => ({
    dock: !(host.querySelector('.chat-dock') as FakeElement).hidden,
    bubble: !(host.querySelector('.chat-bubble') as FakeElement).hidden,
  });

  it('shows the dock, the compact dock, the bubble or nothing, and remembers each', async () => {
    const { mod, overlay, host } = await setup();
    const { store, storage } = memory();
    const dock = mod.mountChatDock(overlay, { userId: 'ana', storage, deps: stubDeps().deps });
    expect(dock.mode()).toBe('closed');
    expect(shown(host)).toEqual({ dock: false, bubble: false });
    dock.dispatch('open');
    expect(shown(host)).toEqual({ dock: true, bubble: false });
    expect((host.querySelector('.chat-dock-host') as FakeElement).dataset.mode).toBe('open');
    dock.dispatch('compact');
    expect((host.querySelector('.chat-dock-host') as FakeElement).dataset.mode).toBe('compact');
    dock.dispatch('minimise');
    expect(shown(host)).toEqual({ dock: false, bubble: true });
    expect(JSON.parse(store.get(dockKey('ana'))!)).toMatchObject({ mode: 'bubble', size: 'compact' });
    dock.dispatch('close');
    expect(shown(host)).toEqual({ dock: false, bubble: false });
  });

  it('comes back as it was left, after a reload', async () => {
    const { mod, overlay } = await setup();
    const { storage } = memory();
    const first = mod.mountChatDock(overlay, { userId: 'ana', storage, deps: stubDeps().deps });
    first.dispatch('compact');
    first.dispatch('minimise');
    first.setChannel('board/b1');
    const second = mod.mountChatDock(overlay, { userId: 'ana', storage, deps: stubDeps().deps });
    expect(second.prefs()).toEqual({ mode: 'bubble', size: 'compact', channel: 'board/b1' });
    expect(overlay.querySelectorAll('.chat-dock-host')).toHaveLength(1);
  });

  it('opens from the bubble and reports changes', async () => {
    const { mod, overlay, host } = await setup();
    const dock = mod.mountChatDock(overlay, { userId: 'ana', storage: memory().storage, deps: stubDeps().deps });
    const seen: string[] = [];
    dock.onChange((m) => seen.push(m));
    dock.dispatch('open');
    dock.dispatch('minimise');
    (host.querySelector('.chat-bubble') as FakeElement).click();
    expect(seen).toEqual(['open', 'bubble', 'open']);
    expect(textOf(host.querySelector('.chat-dock-title') as FakeElement)).toBe('Chat');
  });

  it('has Compact only when full size and Full size only when compact, and a Close button that closes', async () => {
    const { mod, overlay, host } = await setup();
    const dock = mod.mountChatDock(overlay, { userId: 'ana', storage: memory().storage, deps: stubDeps().deps });
    dock.dispatch('open');
    const label = (name: string) => (host.querySelectorAll('.chat-dock-btn') as FakeElement[]).find((b) => b.getAttribute('aria-label') === name)!;
    expect(label('Compact').hidden).toBe(false);
    expect(label('Full size').hidden).toBe(true);
    dock.dispatch('compact');
    expect(label('Compact').hidden).toBe(true);
    expect(label('Full size').hidden).toBe(false);
    label('Close chat').click();
    expect(dock.mode()).toBe('closed');
  });

  it('does not break when storage is blocked', async () => {
    const { mod, overlay } = await setup();
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
    const dock = mod.mountChatDock(overlay, { userId: 'ana', storage: blocked, deps: stubDeps().deps });
    expect(() => dock.dispatch('open')).not.toThrow();
    expect(dock.mode()).toBe('open');
  });

  it('can be suppressed on a page: hidden, no room taken, no socket, and back as it was afterwards', async () => {
    const { mod, overlay, host } = await setup();
    const stub = stubDeps();
    const dock = mod.mountChatDock(overlay, { userId: 'ana', storage: memory().storage, deps: stub.deps });
    dock.dispatch('open');
    expect(dock.inset()).toBe(372);
    dock.setSuppressed(true);
    expect((host.querySelector('.chat-dock-host') as FakeElement).hidden).toBe(true);
    expect(dock.inset()).toBe(0);
    expect(stub.watches[0].aborted).toBe(true);
    expect(dock.mode()).toBe('open'); // its state is kept
    dock.setSuppressed(false);
    expect((host.querySelector('.chat-dock-host') as FakeElement).hidden).toBe(false);
    expect(dock.inset()).toBe(372);
    expect(stub.watches).toHaveLength(2);
  });

  it('syncChatDock mounts for a person with chat, once, and removes it for anyone else', async () => {
    const { mod, overlay } = await setup();
    const a = mod.syncChatDock(overlay, 'ana', true);
    expect(a).not.toBeNull();
    expect(mod.syncChatDock(overlay, 'ana', true)).toBe(a);
    expect(mod.currentChatDock()).toBe(a);
    const b = mod.syncChatDock(overlay, 'ben', true);
    expect(b).not.toBe(a);
    expect(overlay.querySelectorAll('.chat-dock-host')).toHaveLength(1);
    expect(mod.syncChatDock(overlay, 'ben', false)).toBeNull();
    expect(mod.syncChatDock(overlay, null, true)).toBeNull();
    expect(mod.currentChatDock()).toBeNull();
    expect(overlay.querySelectorAll('.chat-dock-host')).toHaveLength(0);
  });
});
