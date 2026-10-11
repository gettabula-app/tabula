import { afterEach, describe, expect, it, vi } from 'vitest';
import { entry, stubDeps } from './chat-dock-deps';
import { installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';
import { channelKey, dockChannels, hereLine, pickChannel, splitChips } from '../src/ui/chat-dock-channels';
import type { DockBoard } from '../src/ui/chat-dock';

// docs/chat.md, Dock: the channel chips (this board, the workspace, teams), the "+N" list, unread badges, the presence strip,
// and what the dock remembers about the channel.

const ws = entry({ kind: 'workspace', ref: 'main', name: 'Workspace' });
const team = (ref: string, name: string, over: Partial<Parameters<typeof entry>[0]> = {}) => entry({ kind: 'team', ref, name, ...over });
const board = (ref: string, name: string, lastAt: number) => entry({ kind: 'board', ref, name, lastAt });

describe('the channels the dock offers', () => {
  it('lists the open board first, then the workspace, teams, other teams and other boards, the open board once', () => {
    const list = dockChannels([
      board('b2', 'Roadmap', 5), board('b1', 'Retro', 9), team('t2', 'Zed', { archived: true }), team('t1', 'Alpha', { lastAt: 3 }), ws,
      team('t3', 'Guest read', { member: false }),
    ], 'b1');
    expect(list.map((c) => c.key)).toEqual(['board/b1', 'workspace/main', 'team/t1', 'team/t2', 'team/t3', 'board/b2']);
    expect(list[0]).toMatchObject({ label: 'This board', attached: true });
    expect(list.filter((c) => c.ref === 'b1')).toHaveLength(1);
  });

  it('without an open board starts with the workspace', () => {
    expect(dockChannels([team('t1', 'Alpha'), ws], null).map((c) => c.key)).toEqual(['workspace/main', 'team/t1']);
  });

  it('picks the remembered channel, else the open board, else the one with a mention, else the first', () => {
    const list = dockChannels([ws, team('t1', 'Alpha'), team('t2', 'Beta')], 'b1');
    const none = () => ({ unread: 0, mentions: 0 });
    expect(pickChannel(list, 'team/t2', none)?.key).toBe('team/t2');
    expect(pickChannel(list, 'team/gone', none)?.key).toBe('board/b1');
    const noBoard = dockChannels([ws, team('t1', 'Alpha'), team('t2', 'Beta')], null);
    expect(pickChannel(noBoard, null, (c) => (c.ref === 't2' ? { unread: 1, mentions: 1 } : { unread: 5, mentions: 0 }))?.key).toBe('team/t2');
    expect(pickChannel(noBoard, null, none)?.key).toBe('workspace/main');
    expect(pickChannel([], null, none)).toBeNull();
  });

  it('splits the chips to what fits and always keeps the current channel visible', () => {
    const list = dockChannels([ws, team('t1', 'A'), team('t2', 'B'), team('t3', 'C')], 'b1');
    expect(splitChips(list, 'board/b1', 3).overflow.map((c) => c.key)).toEqual(['team/t2', 'team/t3']);
    const moved = splitChips(list, 'team/t3', 3);
    expect(moved.visible.map((c) => c.key)).toEqual(['board/b1', 'workspace/main', 'team/t3']);
    expect(moved.overflow.map((c) => c.key)).toEqual(['team/t1', 'team/t2']);
    expect(splitChips(list, null, 10).overflow).toEqual([]);
  });

  it('says who is here', () => {
    expect(hereLine([])).toBe('');
    expect(hereLine(['Ana'])).toBe('1 here now: Ana');
    expect(hereLine(['Ana', 'Ben', 'Sara'])).toBe('3 here now: Ana, Ben and Sara');
    expect(hereLine(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('6 here now: A, B, C, D and 2 more');
    expect(channelKey('team', 't1')).toBe('team/t1');
  });
});

describe('the dock with channels', () => {
  let browser: FakeBrowser | undefined;
  afterEach(() => {
    browser?.uninstall();
    browser = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup(entries = [ws, team('t1', 'Retro team', { lastAt: 9 }), team('t2', 'Design', { lastAt: 5 })], storedChannel: string | null = null) {
    browser = installFakeBrowser();
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const overlay = browser.document.createElement('div');
    browser.document.body.appendChild(overlay);
    const mod = await import('../src/ui/chat-dock');
    const stub = stubDeps(entries);
    const store = new Map<string, string>();
    if (storedChannel) store.set('driftboard:chat-dock:u1', JSON.stringify({ mode: 'closed', size: 'open', channel: storedChannel }));
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const dock = mod.mountChatDock(overlay as unknown as HTMLElement, { userId: 'u1', userName: 'Ana', deps: stub.deps, storage });
    const host = overlay as unknown as FakeElement;
    const chipLabels = () => (host.querySelectorAll('.chat-chip') as FakeElement[]).map((c) => c.getAttribute('aria-label'));
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    return { dock, stub, host, store, chipLabels, flush };
  }

  const boardCtx = (id = 'b1', people: { id: string; name: string; color: string }[] = []) => {
    const listeners = new Set<() => void>();
    let aborted: AbortSignal | null = null;
    const ctx: DockBoard & { setPeople(p: typeof people): void; signal(): AbortSignal | null } = {
      boardId: id, label: 'This board',
      mount: (_panel, signal) => { aborted = signal; return { setOpen: vi.fn<(open: boolean) => void>(), focusComposer: vi.fn<() => void>(), refresh: vi.fn<() => void>() } as never; },
      presence: { people: () => people, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
      setPeople: (p) => { people = p; listeners.forEach((fn) => fn()); },
      signal: () => aborted,
    };
    return ctx;
  };

  it('does not ask for channels or keep the chat socket while the dock is closed', async () => {
    const { stub } = await setup();
    expect(stub.deps.fetchChannels).not.toHaveBeenCalled();
    expect(stub.watches).toHaveLength(0);
  });

  it('on a page with no board it shows the Workspace channel first, with chips for the teams', async () => {
    const { dock, stub, chipLabels, flush } = await setup();
    dock.dispatch('open');
    await flush();
    expect(stub.watches).toHaveLength(1);
    expect(chipLabels()).toEqual(['Workspace', 'Retro team', 'Design']);
    expect(stub.opened).toEqual([expect.objectContaining({ kind: 'workspace', ref: 'main' })]);
    expect(stub.mounts).toHaveLength(1);
    expect(stub.mounts[0].opts).toMatchObject({ id: 'workspace-main', workspace: true, meId: 'u1', meName: 'Ana' });
    expect(dock.channel()).toBe('workspace/main');
  });

  it('with a board open it starts on This board and switching drops the old conversation and remembers the choice', async () => {
    const { dock, stub, host, store, chipLabels, flush } = await setup();
    const ctx = boardCtx();
    dock.attachBoard(ctx);
    dock.dispatch('open');
    await flush();
    expect(chipLabels()[0]).toBe('This board');
    expect(dock.channel()).toBe('board/b1');
    const first = ctx.signal()!;
    expect(first.aborted).toBe(false);
    const chip = (host.querySelectorAll('.chat-chip') as FakeElement[]).find((c) => c.getAttribute('aria-label') === 'Retro team')!;
    chip.click();
    expect(first.aborted).toBe(true);
    expect(stub.opened.at(-1)).toMatchObject({ kind: 'team', ref: 't1' });
    expect(stub.mounts.at(-1)!.opts.workspace).toBe(false);
    expect(JSON.parse(store.get('driftboard:chat-dock:u1')!).channel).toBe('team/t1');
    expect(dock.channel()).toBe('team/t1');
    expect((host.querySelector('.chat-chip.on') as FakeElement).getAttribute('aria-label')).toBe('Retro team');
  });

  it('comes back to the remembered channel after a reload, and falls back when it is gone', async () => {
    const remembered = await setup(undefined, 'team/t2');
    remembered.dock.dispatch('open');
    await remembered.flush();
    expect(remembered.dock.channel()).toBe('team/t2');
    expect(remembered.stub.opened.map((o) => o.ref)).toEqual(['t2']); // nothing was drawn before the list said it exists
    browser?.uninstall();
    const gone = await setup([ws], 'team/deleted');
    gone.dock.dispatch('open');
    await gone.flush();
    expect(gone.dock.channel()).toBe('workspace/main');
  });

  it('shows unread counts on the chips and says them to a screen reader', async () => {
    const { dock, stub, host, chipLabels, flush } = await setup();
    dock.dispatch('open');
    await flush();
    stub.setUnread('team', 't1', { unread: 2, mentions: 1 });
    expect(chipLabels()).toContain('Retro team, 2 unread, 1 mentioning you');
    const chip = (host.querySelectorAll('.chat-chip') as FakeElement[]).find((c) => c.getAttribute('aria-label')?.startsWith('Retro team'))!;
    expect(textOf(chip.querySelector('.chat-chip-count') as FakeElement)).toBe('2');
    stub.setUnread('team', 't1', { unread: 120, mentions: 0 });
    expect(textOf((host.querySelectorAll('.chat-chip-count') as FakeElement[]).find((c) => !c.hidden)!)).toBe('99+');
  });

  it('puts channels past three into a +N list and keeps the current one visible', async () => {
    const many = [ws, team('t1', 'A'), team('t2', 'B'), team('t3', 'C'), team('t4', 'D')];
    const { dock, host, chipLabels, flush } = await setup(many);
    dock.dispatch('open');
    await flush();
    expect(chipLabels()).toEqual(['Workspace', 'A', 'B', '2 more channels']);
    dock.select('team/t4');
    expect(chipLabels()).toEqual(['Workspace', 'A', 'D', '2 more channels']);
    expect((host.querySelector('.chat-chip-more') as FakeElement).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('shows who is here on the board channel only, and follows the board', async () => {
    const { dock, host, flush } = await setup();
    const ctx = boardCtx('b1', [{ id: 'u1', name: 'Ana Lima', color: '#c4571f' }, { id: 'u2', name: 'Ben Okafor', color: '#b7870a' }]);
    dock.attachBoard(ctx);
    dock.dispatch('open');
    await flush();
    const here = host.querySelector('.chat-dock-here') as FakeElement;
    expect(here.hidden).toBe(false);
    expect(textOf(here)).toContain('2 here now: Ana Lima and Ben Okafor');
    expect((here.querySelectorAll('.chat-here-avatar') as FakeElement[]).map((a) => textOf(a))).toEqual(['AL', 'BO']);
    ctx.setPeople([{ id: 'u1', name: 'Ana Lima', color: '#c4571f' }]);
    expect(textOf(here)).toContain('1 here now: Ana Lima');
    dock.select('workspace/main');
    expect(here.hidden).toBe(true);
  });

  it('stops watching and drops the conversation when the dock is minimised, and asks for the list again for an unlisted channel', async () => {
    vi.useFakeTimers();
    const { dock, stub, flush } = await setup();
    dock.dispatch('open');
    await flush();
    expect(stub.deps.fetchChannels).toHaveBeenCalledTimes(1);
    stub.setUnlisted(true);
    stub.setUnread('board', 'new', { unread: 1, mentions: 0 });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(stub.deps.fetchChannels).toHaveBeenCalledTimes(2);
    stub.setUnlisted(false);
    dock.dispatch('minimise');
    expect(stub.watches[0].aborted).toBe(true);
    expect(stub.mounts[0].conv.setOpen).toHaveBeenLastCalledWith(false);
  });
});
