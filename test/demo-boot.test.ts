import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';

const mocks = vi.hoisted(() => ({
  release: undefined as (() => void) | undefined,
  seedDemo: vi.fn<() => void>(),
  mountBoardUi: vi.fn<(...args: unknown[]) => void>(),
  mountDemoBanner: vi.fn<(...args: unknown[]) => void>(),
  app: undefined as {
    store: { undo: { clear: () => void; stopCapturing: () => void } };
    conn: { destroy: () => void };
  } | undefined,
}));

vi.mock('../src/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/demo')>();
  mocks.release = actual.installDemoGuards();
  return { ...actual, DEMO: true };
});
vi.mock('../src/app', () => ({
  BoardApp: class {
    store: { undo: { clear: () => void; stopCapturing: () => void } };
    conn: { destroy: () => void };
    constructor(conn: { store: { undo: { clear: () => void; stopCapturing: () => void } }; destroy: () => void }) {
      this.conn = conn;
      this.store = conn.store;
      mocks.app = this;
    }
  },
}));
vi.mock('../src/ui/board', () => ({ mountBoardUi: mocks.mountBoardUi }));
vi.mock('../src/ui/demo-banner', () => ({ mountDemoBanner: mocks.mountDemoBanner }));
vi.mock('../src/demo/seed', () => ({ seedDemo: mocks.seedDemo }));
vi.mock('../src/ui/tooltip', () => ({ installTooltips: vi.fn<() => void>() }));

const spyStorage = () => ({
  getItem: vi.fn<(key: string) => string | null>(() => null),
  setItem: vi.fn<(key: string, value: string) => void>(),
  removeItem: vi.fn<(key: string) => void>(),
});
let browser: FakeBrowser | undefined;
let realLocal: ReturnType<typeof spyStorage>;
let realSession: ReturnType<typeof spyStorage>;
let realIndexedDB: { open: ReturnType<typeof vi.fn> };
let fetchSpy: ReturnType<typeof vi.fn>;

afterEach(() => {
  mocks.release?.();
  mocks.release = undefined;
  mocks.app?.conn.destroy();
  mocks.app = undefined;
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllGlobals();
  vi.resetModules();
  mocks.seedDemo.mockClear();
  mocks.mountBoardUi.mockClear();
  mocks.mountDemoBanner.mockClear();
});

describe('demo boot', () => {
  it('opens the in-memory board without API, relay, IndexedDB or real storage writes', async () => {
    browser = installFakeBrowser();
    const local = browser.document.createElement('div');
    local.id = 'app';
    browser.document.body.appendChild(local);
    realLocal = spyStorage();
    realSession = spyStorage();
    vi.stubGlobal('localStorage', realLocal);
    vi.stubGlobal('sessionStorage', realSession);
    realIndexedDB = { open: vi.fn<() => void>() };
    Object.assign(window, { localStorage: realLocal, sessionStorage: realSession, indexedDB: realIndexedDB });
    Object.assign(location, { href: 'https://demo.test/demo/#/templates', origin: 'https://demo.test', search: '' });
    vi.stubGlobal('history', {
    replaceState: vi.fn<(_state: unknown, _title: string, url: string) => void>((_state, _title, url) => {
        const at = url.indexOf('#');
        location.hash = at >= 0 ? url.slice(at) : '';
      }),
    });
    vi.stubGlobal('navigator', { sendBeacon: vi.fn<() => boolean>(() => true) });
    Object.assign(window, { navigator });
    fetchSpy = vi.fn<() => Promise<Response>>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', class { open = vi.fn<() => void>(); send = vi.fn<() => void>(); });
    await import('../src/main');

    const { authState, imagesAvailable } = await import('../src/auth');
    const demo = await import('../src/demo');
    const sync = await import('../src/sync');
    expect(authState().mode).toBe('open');
    expect(imagesAvailable()).toBe(false);
    expect(location.hash).toBe('#/b/demo');
    expect(mocks.seedDemo).toHaveBeenCalledTimes(1);
    expect(mocks.mountBoardUi).toHaveBeenCalledWith(mocks.app, local, expect.any(Object), { demo: true });
    expect(mocks.mountDemoBanner).toHaveBeenCalledWith(local);
    const testConn = sync.scratchBoard('test', { id: 'test', name: 'Test', color: '#2F6FED' }, false);
    expect(testConn.comments.readOnly()).toBe(false);
    testConn.destroy();
    expect(indexedDB).toBeUndefined();
    expect(realIndexedDB.open).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(realLocal.setItem).not.toHaveBeenCalled();
    expect(realSession.setItem).not.toHaveBeenCalled();
    expect(demo.demoGuardReport()).toEqual({ blocked: 0, attempts: [] });
  });
});
