import { afterEach, describe, expect, it, vi } from 'vitest';
import { control, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

// Tracker entry points on the board: the Tracker item in the board menu and the Tracker link of the Boards top bar. Both
// ask one question (tracker-gate.ts): signed in or offline, and /api/me says the workspace has the tracker.

const mocks = vi.hoisted(() => ({
  auth: { mode: 'signed-in', me: { user: { id: 'u1', name: 'Johan', email: 'johan@example.test', role: 'member' }, mcp: null, chat: null, tracker: true } } as Record<string, unknown>,
  navigate: vi.fn<(...args: unknown[]) => boolean>(() => true),
  libraryArgs: [] as unknown[][],
}));

vi.mock('../src/ui/props', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/ui/props')>()), mountProps: () => ({ el: document.createElement('aside'), toggle: () => undefined, isOpen: () => false, onToggle: () => undefined }) }));
vi.mock('../src/ui/library', () => ({
  mountLibrary: (...args: unknown[]) => {
    mocks.libraryArgs.push(args);
    return { tab: null, open: vi.fn<(...args: unknown[]) => void>(), onChange: vi.fn<(...args: unknown[]) => void>() };
  },
  openMermaidImport: vi.fn<(...args: unknown[]) => void>(),
}));
vi.mock('../src/ui/layers', () => ({ bindLayersKey: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/side-tray', () => ({ mountSideTray: vi.fn<() => Record<string, never>>(() => ({})) }));
vi.mock('../src/ui/comments', () => ({ mountComments: vi.fn<() => { button: HTMLElement }>(() => ({ button: document.createElement('button') })) }));
vi.mock('../src/ui/group-ui', () => ({ mountGroupUI: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/focus', () => ({ mountFocus: vi.fn<(...args: unknown[]) => void>(), mutedCount: vi.fn<() => number>(() => 0), openMuted: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/flowbar', () => ({ mountFlowBar: vi.fn<(...args: unknown[]) => void>(), openVoteSetup: vi.fn<(...args: unknown[]) => void>(), startVote: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/panel-top', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/ui/panel-top')>()), trackPanelTop: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/route', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/route')>()), navigateTrackerPath: (...args: unknown[]) => mocks.navigate(...args) }));
vi.mock('../src/auth', () => ({
  authState: () => mocks.auth,
  chatAvailable: () => false,
  imagesAvailable: () => false,
  onAuth: () => () => undefined,
  registerAuthChatReset: () => undefined,
  setSignedIn: vi.fn<(...args: unknown[]) => void>(),
  setSignedOut: vi.fn<(...args: unknown[]) => void>(),
  signOut: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));
vi.mock('../src/cloud-logic', () => ({ boardAccess: () => ({ badge: null }), workspaceOf: () => null }));

let browser: FakeBrowser | undefined;
const signedIn = (tracker: boolean | undefined) => ({ mode: 'signed-in', me: { user: { id: 'u1', name: 'Johan', email: 'johan@example.test', role: 'member' }, mcp: null, chat: null, ...(tracker === undefined ? {} : { tracker }) } });

afterEach(() => {
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function prepareBoard() {
  browser = installFakeBrowser();
  const root = browser.mount();
  const cursorLayer = browser.document.createElement('div');
  root.appendChild(cursorLayer);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
  const app = {
    store: {
      getMeta: () => ({ name: 'Test board', gridType: 'dots', gridSize: 24 }),
      setMeta: vi.fn<(...args: unknown[]) => void>(),
      cache: new Map(), get: () => undefined, shown: () => [], onReadOnly: () => () => undefined,
    },
    conn: { id: 'board', status: 'live', denied: null, onAiRuns: () => () => undefined },
    participants: () => [],
    on: () => () => undefined,
    r: { root, cursorLayer, onCamera: () => () => undefined, contentBounds: () => null, svg: { addEventListener: () => undefined, removeEventListener: () => undefined, contains: () => false } },
    flow: { isVoting: () => false },
    tool: { kind: 'select' }, selection: [] as string[], selected: () => [], selectedLeaves: () => [],
    dragging: false, editor: { active: false }, readOnly: false, onDestroy: () => undefined,
    comments: { readOnly: () => false, onReadOnly: () => () => undefined },
    lifetime: { signal: new AbortController().signal }, role: 'owner', deleted: false, commentsVisible: false, toggleChat: null,
    user: { id: 'u1', name: 'Johan', color: '#2F6FED' },
  };
  return { root, app };
}

async function openBoardMenu(opts: { scratch?: boolean; demo?: boolean } = {}) {
  const { root, app } = prepareBoard();
  const { mountBoardUi } = await import('../src/ui/board');
  mountBoardUi(app as never, root as unknown as HTMLElement, { home: () => undefined }, opts);
  await new Promise((resolve) => setTimeout(resolve, 0));
  control(root, 'Menu').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return browser!.document.body.querySelector('.menu') as FakeElement;
}

const labels = (menu: FakeElement) => (menu.querySelectorAll('.menu-item') as FakeElement[]).map((item) => textOf(item));

describe('the Tracker item of the board menu', () => {
  it('appears in the Board group and opens the tracker', async () => {
    mocks.auth = signedIn(true);
    const menu = await openBoardMenu();
    const boardGroup = menu.querySelector('.board-menu-board') as FakeElement;
    const tracker = (boardGroup.querySelectorAll('.menu-item') as FakeElement[])
      .find((item) => textOf(item).trim() === 'Tracker');
    expect(tracker).toBeDefined();
    tracker!.click();
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'view', view: 'all' });
  });

  it.each([
    ['a workspace without the tracker', () => { mocks.auth = signedIn(false); return {}; }],
    ['a /api/me that does not say', () => { mocks.auth = signedIn(undefined); return {}; }],
    ['a guest', () => { mocks.auth = { mode: 'guest', guest: { boardId: 'b' } }; return {}; }],
    ['a scratch board', () => { mocks.auth = signedIn(true); return { scratch: true }; }],
    ['the demo', () => { mocks.auth = signedIn(true); return { demo: true }; }],
  ])('is absent for %s', async (_name, setup) => {
    const opts = setup();
    const menu = await openBoardMenu(opts);
    expect(labels(menu).some((label) => label === 'Tracker')).toBe(false);
  });
});

describe('the Tracker link of the Boards top bar', () => {
  it('follows the same gate and routes the click in the app', async () => {
    browser = installFakeBrowser();
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const { createTopbar } = await import('../src/ui/topbar');
    const me = (tracker: boolean | undefined) => (signedIn(tracker) as unknown as { me: never }).me;
    const links = (bar: unknown) => ((bar as FakeElement).querySelectorAll('.topbar-link') as FakeElement[]).map((a) => textOf(a));
    expect(links(createTopbar('boards', me(true)))).toEqual(['Boards', 'Tracker', 'Help']);
    // AI tool access is not in the top bar any more, even when the server has it; the name is the account menu button
    const withMcp = { ...(me(true) as object), mcp: true, ai: { personalKeys: true }, chat: true } as never;
    expect(links(createTopbar('boards', withMcp))).toEqual(['Boards', 'Tracker', 'Help']);
    const barWithMcp = createTopbar('boards', withMcp) as unknown as FakeElement;
    expect((barWithMcp.querySelectorAll('button') as FakeElement[]).map((b) => textOf(b))).toEqual(['Johan']);
    const menuItems = () => (browser!.document.body.querySelector('.menu') as FakeElement).querySelectorAll('.menu-item').map((i) => textOf(i as FakeElement));
    const button = barWithMcp.querySelector('.topbar-me-btn') as FakeElement;
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    button.click();
    expect(menuItems()).toEqual(['Your name and colour', 'My templates', 'AI tool access', 'Your AI key', 'Notification settings', 'Sign out']);
    browser!.document.body.querySelectorAll('.menu-item').find((item) => textOf(item) === 'My templates')!.click();
    expect(browser!.location.hash).toBe('#/templates');
    (await import('../src/ui/common')).closePopover();
    await new Promise((resolve) => setTimeout(resolve, 5)); // the popover's pointer listener is added on a timer
    // Without the optional profile, AI and key items, My templates and Notification settings remain available to signed-in accounts.
    const plain = createTopbar('boards', me(true)) as unknown as FakeElement;
    (plain.querySelector('.topbar-me-btn') as FakeElement).click();
    expect(menuItems()).toEqual(['Your name and colour', 'My templates', 'Notification settings', 'Sign out']);
    (await import('../src/ui/common')).closePopover();
    await new Promise((resolve) => setTimeout(resolve, 5)); // the popover's pointer listener is added on a timer
    expect(links(createTopbar('boards', me(false)))).toEqual(['Boards', 'Help']);
    expect(links(createTopbar('boards', me(undefined)))).toEqual(['Boards', 'Help']);
    expect(links(createTopbar('boards', null))).toEqual(['Boards', 'Help']);

    const bar = createTopbar('templates', me(true)) as unknown as FakeElement;
    const tracker = (bar.querySelectorAll('.topbar-link') as FakeElement[]).find((a) => textOf(a) === 'Tracker')!;
    expect(tracker.getAttribute('href')).toBe('/t/all');
    tracker.click();
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'view', view: 'all' });
  });
});

describe('the Tracker in the Templates picker, from the board', () => {
  async function mountBoard(opts: { scratch?: boolean; demo?: boolean } = {}) {
    mocks.libraryArgs = [];
    const { root, app } = prepareBoard();
    const { mountBoardUi } = await import('../src/ui/board');
    mountBoardUi(app as never, root as unknown as HTMLElement, { home: () => undefined }, opts);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { root, app };
  }
  // the picker is opened from the library, which gets the gate the Tracker entry asks
  const trackerAllowed = () => (mocks.libraryArgs[0]?.[2] as { trackerAllowed: () => boolean } | undefined)?.trackerAllowed();

  it('is not a rail button any more', async () => {
    mocks.auth = signedIn(true);
    const { root } = await mountBoard();
    expect((root.querySelectorAll('.rail-btn') as FakeElement[]).map((b) => b.getAttribute('aria-label'))).not.toContain('Tracker');
    expect(root.querySelector('[data-command="tracker:create-frame"]')).toBeNull();
  });

  it.each([
    ['signed in with the tracker', () => { mocks.auth = signedIn(true); return {}; }, true],
    ['offline with the tracker', () => { mocks.auth = { mode: 'offline', me: { user: { id: 'u1' }, tracker: true } }; return {}; }, true],
    ['a workspace without the tracker', () => { mocks.auth = signedIn(false); return {}; }, false],
    ['a /api/me that does not say', () => { mocks.auth = signedIn(undefined); return {}; }, false],
    ['a guest', () => { mocks.auth = { mode: 'guest', guest: { boardId: 'b' } }; return {}; }, false],
    ['a scratch board', () => { mocks.auth = signedIn(true); return { scratch: true }; }, false],
    ['the demo', () => { mocks.auth = signedIn(true); return { demo: true }; }, false],
  ])('gates the picker entry for %s', async (_name, setup, expected) => {
    const opts = setup();
    await mountBoard(opts);
    expect(trackerAllowed()).toBe(expected);
  });

  it('is never offered on a read-only board, and the gate is asked again when the board turns read-only', async () => {
    mocks.auth = signedIn(true);
    const { app } = await mountBoard();
    expect(trackerAllowed()).toBe(true);
    app.readOnly = true;
    expect(trackerAllowed()).toBe(false);
  });
});
