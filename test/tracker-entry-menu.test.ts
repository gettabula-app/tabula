import { afterEach, describe, expect, it, vi } from 'vitest';
import { control, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

// Tracker entry points on the board: the Tracker item in the board menu and the Tracker link of the Boards top bar. Both
// ask one question (tracker-gate.ts): signed in or offline, and /api/me says the workspace has the tracker.

const mocks = vi.hoisted(() => ({
  auth: { mode: 'signed-in', me: { user: { id: 'u1', name: 'Johan', email: 'johan@example.test', role: 'member' }, mcp: null, chat: null, tracker: true } } as Record<string, unknown>,
  navigate: vi.fn<(...args: unknown[]) => boolean>(() => true),
}));

vi.mock('../src/ui/props', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/ui/props')>()), mountProps: () => ({ el: document.createElement('aside'), toggle: () => undefined, isOpen: () => false, onToggle: () => undefined }) }));
vi.mock('../src/ui/library', () => ({
  mountLibrary: () => ({ tab: null, open: vi.fn<(...args: unknown[]) => void>(), onChange: vi.fn<(...args: unknown[]) => void>() }),
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
  it('sits directly under the User guide row, then a separator, and opens the tracker', async () => {
    mocks.auth = signedIn(true);
    const menu = await openBoardMenu();
    const items = labels(menu);
    expect(items[0]).toContain('User guide');
    expect(items[1]).toBe('Tracker');
    const children = menu.children as FakeElement[];
    const at = children.findIndex((c) => textOf(c) === 'Tracker');
    expect(children[at + 1].tagName.toLowerCase()).toBe('hr');
    (menu.querySelectorAll('.menu-item') as FakeElement[])[1].click();
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
    expect(links(createTopbar('boards', me(true)))).toEqual(['Boards', 'Tracker', 'Templates', 'Help']);
    // AI tool access is not in the top bar any more, even when the server has it; the name is the account menu button
    const withMcp = { ...(me(true) as object), mcp: true, ai: { personalKeys: true }, chat: true } as never;
    expect(links(createTopbar('boards', withMcp))).toEqual(['Boards', 'Tracker', 'Templates', 'Help']);
    const barWithMcp = createTopbar('boards', withMcp) as unknown as FakeElement;
    expect((barWithMcp.querySelectorAll('button') as FakeElement[]).map((b) => textOf(b))).toEqual(['Johan']);
    const menuItems = () => (browser!.document.body.querySelector('.menu') as FakeElement).querySelectorAll('.menu-item').map((i) => textOf(i as FakeElement));
    const button = barWithMcp.querySelector('.topbar-me-btn') as FakeElement;
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    button.click();
    expect(menuItems()).toEqual(['Your name and colour', 'AI tool access', 'Your AI key', 'Chat notifications', 'Sign out']);
    (await import('../src/ui/common')).closePopover();
    await new Promise((resolve) => setTimeout(resolve, 5)); // the popover's pointer listener is added on a timer
    // without the server offering them, the menu is the name and Sign out
    const plain = createTopbar('boards', me(true)) as unknown as FakeElement;
    (plain.querySelector('.topbar-me-btn') as FakeElement).click();
    expect(menuItems()).toEqual(['Your name and colour', 'Sign out']);
    (await import('../src/ui/common')).closePopover();
    await new Promise((resolve) => setTimeout(resolve, 5)); // the popover's pointer listener is added on a timer
    expect(links(createTopbar('boards', me(false)))).toEqual(['Boards', 'Templates', 'Help']);
    expect(links(createTopbar('boards', me(undefined)))).toEqual(['Boards', 'Templates', 'Help']);
    expect(links(createTopbar('boards', null))).toEqual(['Boards', 'Templates', 'Help']);

    const bar = createTopbar('templates', me(true)) as unknown as FakeElement;
    const tracker = (bar.querySelectorAll('.topbar-link') as FakeElement[]).find((a) => textOf(a) === 'Tracker')!;
    expect(tracker.getAttribute('href')).toBe('/t/all');
    tracker.click();
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'view', view: 'all' });
  });
});
