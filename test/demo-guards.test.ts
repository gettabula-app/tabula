import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = () => ({
  getItem: vi.fn<(key: string) => string | null>(() => null),
  setItem: vi.fn<(key: string, value: string) => void>(),
  removeItem: vi.fn<(key: string) => void>(),
  clear: vi.fn<() => void>(),
  key: vi.fn<(index: number) => string | null>(() => null),
  get length() { return 0; },
});

let release: (() => void) | undefined;
let realLocal: ReturnType<typeof storage>;
let realSession: ReturnType<typeof storage>;
let nativeFetch: ReturnType<typeof vi.fn>;
let nativeBeacon: ReturnType<typeof vi.fn<(url: string | URL) => boolean>>;
let nativeRegister: ReturnType<typeof vi.fn<() => Promise<ServiceWorkerRegistration>>>;
let nativeCache: { open: ReturnType<typeof vi.fn<() => Promise<Cache>>> };
let createdXhr: { open: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } | undefined;

afterEach(() => {
  release?.();
  release = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  createdXhr = undefined;
});

async function install() {
  realLocal = storage();
  realSession = storage();
  nativeFetch = vi.fn<() => Promise<Response>>(async () => new Response('{}'));
  nativeBeacon = vi.fn<(url: string | URL) => boolean>(() => true);
  nativeRegister = vi.fn<() => Promise<ServiceWorkerRegistration>>(async () => ({} as ServiceWorkerRegistration));
  nativeCache = { open: vi.fn<() => Promise<Cache>>(async () => ({} as Cache)) };
  const navigator = new class TestNavigator {
    serviceWorker = { register: nativeRegister } as unknown as ServiceWorkerContainer;
    sendBeacon(url: string | URL) { return nativeBeacon(url); }
  }();
  const surface = {
    localStorage: realLocal,
    sessionStorage: realSession,
    indexedDB: { open: vi.fn<() => void>() },
    caches: nativeCache,
    navigator,
    fetch: nativeFetch,
    WebSocket: class {},
    EventSource: class {},
    XMLHttpRequest: class {
      open = vi.fn<() => void>();
      send = vi.fn<() => void>();
      constructor() { createdXhr = { open: this.open, send: this.send }; }
    },
  };
  vi.stubEnv('VITE_DEMO', '1');
  vi.stubEnv('BASE_URL', '/demo/');
  vi.stubGlobal('window', surface);
  vi.stubGlobal('localStorage', realLocal);
  vi.stubGlobal('sessionStorage', realSession);
  vi.stubGlobal('indexedDB', surface.indexedDB);
  vi.stubGlobal('caches', nativeCache);
  vi.stubGlobal('navigator', navigator);
  vi.stubGlobal('location', { href: 'https://demo.test/demo/', origin: 'https://demo.test', pathname: '/demo/' });
  vi.stubGlobal('fetch', nativeFetch);
  vi.stubGlobal('WebSocket', surface.WebSocket);
  vi.stubGlobal('EventSource', surface.EventSource);
  vi.stubGlobal('XMLHttpRequest', surface.XMLHttpRequest);
  vi.stubGlobal('Navigator', navigator.constructor);
  const demo = await import('../src/demo');
  release = demo.installDemoGuards();
  return { surface, demo };
}

describe('demo guards', () => {
  it('replaces persistent storage, Cache Storage and IndexedDB with in-memory or unavailable surfaces', async () => {
    const { surface } = await install();
    expect(indexedDB).toBeUndefined();
    expect(surface.indexedDB).toBeUndefined();
    expect(caches).toBeUndefined();
    expect(surface.caches).toBeUndefined();
    expect(localStorage.getItem('before')).toBeNull();
    localStorage.setItem('ephemeral', 'yes');
    sessionStorage.setItem('ephemeral', 'yes');
    expect(localStorage.getItem('ephemeral')).toBe('yes');
    expect(realLocal.setItem).not.toHaveBeenCalled();
    expect(realSession.setItem).not.toHaveBeenCalled();
    expect(realLocal.getItem).not.toHaveBeenCalled();
    expect(realLocal.removeItem).not.toHaveBeenCalled();
    expect(realLocal.clear).not.toHaveBeenCalled();
    expect(realSession.getItem).not.toHaveBeenCalled();
    expect(realSession.removeItem).not.toHaveBeenCalled();
    expect(realSession.clear).not.toHaveBeenCalled();
  });

  it('allows only static GETs below /demo/ and Fontshare, including a Request input', async () => {
    const { demo } = await install();
    await fetch('/demo/favicon.svg');
    await fetch(new Request('https://demo.test/demo/assets/index.js'));
    await fetch('https://api.fontshare.com/v2/css?f[]=switzer');
    await fetch('https://cdn.fontshare.com/fonts/switzer.woff2');
    await expect(fetch('/demo/api/x')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('/demo/sync')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('/assets/outside-demo.js')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('https://api.iconify.design/collections')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('https://example.test/anything')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('/demo/favicon.svg', { method: 'POST' })).rejects.toThrow('Demo blocked fetch');
    expect(nativeFetch).toHaveBeenCalledTimes(4);
    expect(demo.demoGuardReport().blocked).toBe(6);
  });

  it('allows a static XHR GET and blocks API XHR, sockets, service worker registration and both sendBeacon methods', async () => {
    const { demo } = await install();
    const staticXhr = new XMLHttpRequest();
    staticXhr.open('GET', '/demo/assets/index.js');
    staticXhr.send();
    expect(createdXhr?.open).toHaveBeenCalledWith('GET', '/demo/assets/index.js', true, null, null);
    expect(createdXhr?.send).toHaveBeenCalledWith(null);
    expect(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/demo/api/x');
    }).toThrow('Demo blocked XMLHttpRequest');
    expect(() => new WebSocket('wss://demo.test/sync')).toThrow('Demo blocked WebSocket');
    expect(() => new EventSource('/demo/api/events')).toThrow('Demo blocked EventSource');
    await expect(navigator.serviceWorker.register('/demo/sw.js')).rejects.toThrow('Demo blocked serviceWorker.register');
    expect(navigator.sendBeacon('/demo/api/track', 'x')).toBe(false);
    const NavigatorClass = (globalThis as unknown as { Navigator: typeof Navigator }).Navigator;
    expect(NavigatorClass.prototype.sendBeacon.call(navigator, '/demo/api/prototype')).toBe(false);
    expect(nativeRegister).not.toHaveBeenCalled();
    expect(nativeBeacon).not.toHaveBeenCalled();
    expect(demo.demoGuardReport().blocked).toBe(6);
  });

  it('returns the same release function when installed more than once', async () => {
    const { demo } = await install();
    expect(demo.installDemoGuards()).toBe(release);
  });

  it('does not return remote icon previews in the demo', async () => {
    await install();
    const { previewUrl } = await import('../src/icons');
    expect(previewUrl('not-hosted:example')).toBe('');
  });
});
