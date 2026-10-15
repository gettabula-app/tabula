import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

// The Tracker entry of the Templates picker (TAB-390). It sits next to Kanban, follows its gate while the picker is open, and
// inserts a tracker frame centred in the view and selects it, the way the rail button did.

const mocks = vi.hoisted(() => ({
  auth: { mode: 'signed-in', me: { user: { id: 'u1', name: 'Johan', email: 'johan@example.test', role: 'member' }, mcp: null, chat: null, tracker: true } } as Record<string, unknown>,
  authListeners: new Set<(state: unknown) => void>(),
}));

vi.mock('../src/auth', () => ({
  authState: () => mocks.auth,
  onAuth: (fn: (state: unknown) => void) => {
    mocks.authListeners.add(fn);
    return () => {
      mocks.authListeners.delete(fn);
    };
  },
}));
vi.mock('../src/template-store', () => ({ listTemplates: async () => [], onTemplatesChange: () => () => undefined }));
vi.mock('../src/template-share', () => ({ accountId: () => 'u1', splitMine: () => ({ mine: [], shared: [] }) }));
vi.mock('../src/template-thumb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/template-thumb')>()),
  builtinThumbnail: () => '<svg></svg>',
}));
vi.mock('../src/ui/templates-page', () => ({ customThumbnail: () => '<svg></svg>' }));

let browser: FakeBrowser | undefined;

afterEach(() => {
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllGlobals();
  mocks.authListeners.clear();
  mocks.auth = { mode: 'signed-in', me: { user: { id: 'u1', name: 'Johan', email: 'johan@example.test', role: 'member' }, mcp: null, chat: null, tracker: true } };
  vi.clearAllMocks();
});

type Listener = () => void;

/** The parts of a board the picker touches: its store, the view, selection and the read-only and other events. */
function fakeApp() {
  const cache = new Map<string, { id: string; type: string; x: number; y: number; w: number; h: number }>();
  const listeners = new Map<string, Set<Listener>>();
  const app = {
    readOnly: false,
    store: {
      readOnly: false,
      cache,
      topZ: () => 0,
      transact: (fn: () => void) => fn(),
      create: (obj: { id: string; type: string; x: number; y: number; w: number; h: number }) => {
        cache.set(obj.id, obj);
      },
    },
    r: { viewport: () => ({ x: 100, y: 50, w: 1000, h: 800 }) },
    setSelection: vi.fn<(ids: string[]) => void>(),
    on: (event: string, fn: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(fn);
      return () => set.delete(fn);
    },
    emit: (event: string) => listeners.get(event)?.forEach((fn) => fn()),
    conn: { id: 'board' },
    user: { id: 'u1' },
  };
  return app;
}

async function openPicker(trackerAllowed: () => boolean, app = fakeApp()) {
  browser = installFakeBrowser();
  // the picker asks its opener (the focused element) whether it is the drawer button; the fake body is never one
  (browser.document.body as unknown as { matches: () => boolean }).matches = () => false;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  const { openTemplatePicker } = await import('../src/ui/template-picker');
  openTemplatePicker(app as never, undefined, trackerAllowed);
  return app;
}

const body = () => browser!.document.body;
const cardIds = () => (body().querySelectorAll('.template-picker-card') as FakeElement[]).map((card) => card.getAttribute('data-entry-id'));
const trackerCard = () => (body().querySelectorAll('.template-picker-card') as FakeElement[]).find((card) => card.getAttribute('data-entry-id') === 'tracker:create-frame');
const signedIn = () => mocks.auth.mode === 'signed-in' && (mocks.auth.me as { tracker?: boolean } | null)?.tracker === true;

describe('the Tracker entry of the Templates picker', () => {
  it('sits right after Kanban, is named Tracker and keeps the command id of the rail button', async () => {
    await openPicker(signedIn);
    const ids = cardIds();
    expect(ids.indexOf('tracker:create-frame')).toBe(ids.indexOf('builtin:kanban') + 1);
    const card = trackerCard()!;
    expect(card.getAttribute('data-command')).toBe('tracker:create-frame');
    expect(card.querySelector('.template-picker-card-name')!.textContent).toBe('Tracker');
    expect(card.getAttribute('data-category')).toBe('Planning');
  });

  it('is not listed when the gate does not pass, and the built-in templates are unchanged', async () => {
    await openPicker(() => false);
    expect(cardIds()).not.toContain('tracker:create-frame');
    expect(cardIds()).toContain('builtin:kanban');
  });

  it.each([
    ['a workspace without the tracker', () => { mocks.auth = { mode: 'signed-in', me: { user: { id: 'u1' }, tracker: false } }; }],
    ['a guest', () => { mocks.auth = { mode: 'guest', guest: { boardId: 'b' } }; }],
  ])('is not listed for %s', async (_name, setup) => {
    setup();
    await openPicker(signedIn);
    expect(cardIds()).not.toContain('tracker:create-frame');
  });

  it('appears when the account gains the tracker, and goes when it is lost, while the picker is open', async () => {
    mocks.auth = { mode: 'signed-in', me: { user: { id: 'u1' }, tracker: false } };
    await openPicker(signedIn);
    expect(cardIds()).not.toContain('tracker:create-frame');
    mocks.auth = { mode: 'signed-in', me: { user: { id: 'u1' }, tracker: true } };
    mocks.authListeners.forEach((fn) => fn(mocks.auth));
    expect(cardIds()).toContain('tracker:create-frame');
    mocks.auth = { mode: 'signed-in', me: { user: { id: 'u1' }, tracker: false } };
    mocks.authListeners.forEach((fn) => fn(mocks.auth));
    expect(cardIds()).not.toContain('tracker:create-frame');
  });

  it('is hidden on a read-only board and comes back when the board is writable again', async () => {
    const app = fakeApp();
    await openPicker(() => signedIn() && !app.readOnly, app);
    expect(cardIds()).toContain('tracker:create-frame');
    app.readOnly = true;
    app.emit('readonly');
    expect(cardIds()).not.toContain('tracker:create-frame');
    app.readOnly = false;
    app.emit('readonly');
    expect(cardIds()).toContain('tracker:create-frame');
  });

  it('choosing it creates a tracker frame centred in the view, selects it and closes the picker', async () => {
    const app = await openPicker(signedIn);
    trackerCard()!.click();
    (body().querySelector('.template-picker-use') as FakeElement).click();
    const trackers = [...app.store.cache.values()].filter((obj) => obj.type === 'tracker');
    expect(trackers).toHaveLength(1);
    // the view is 1000 by 800 at (100, 50); a tracker is 720 by 480, so it starts at (240, 210)
    expect(trackers[0]).toMatchObject({ x: 240, y: 210, w: 720, h: 480 });
    expect(app.setSelection).toHaveBeenCalledWith([trackers[0].id]);
    expect(body().querySelector('.template-picker')).toBeNull();
  });

  it('does nothing when the gate closed after the card was drawn', async () => {
    let open = true;
    const app = await openPicker(() => open);
    trackerCard()!.click();
    open = false;
    (body().querySelector('.template-picker-use') as FakeElement).click();
    expect([...app.store.cache.values()].some((obj) => obj.type === 'tracker')).toBe(false);
    expect(app.setSelection).not.toHaveBeenCalled();
  });
});
