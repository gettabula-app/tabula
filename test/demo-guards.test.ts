import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoGuardReport, installDemoGuards } from '../src/demo';

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

afterEach(() => {
  release?.();
  release = undefined;
  vi.unstubAllGlobals();
});

function install() {
  realLocal = storage();
  realSession = storage();
  nativeFetch = vi.fn<() => Promise<Response>>(async () => new Response('{}'));
  const navigator = { sendBeacon: vi.fn<(url: string | URL, data?: BodyInit | null) => boolean>(() => true) };
  const surface = {
    localStorage: realLocal,
    sessionStorage: realSession,
    indexedDB: { open: vi.fn<() => void>() },
    navigator,
    fetch: nativeFetch,
    WebSocket: class {},
    EventSource: class {},
    XMLHttpRequest: class {
      open = vi.fn<() => void>();
      send = vi.fn<() => void>();
    },
  };
  vi.stubGlobal('window', surface);
  vi.stubGlobal('localStorage', realLocal);
  vi.stubGlobal('sessionStorage', realSession);
  vi.stubGlobal('indexedDB', surface.indexedDB);
  vi.stubGlobal('navigator', navigator);
  vi.stubGlobal('location', { href: 'https://demo.test/demo/', origin: 'https://demo.test' });
  vi.stubGlobal('fetch', nativeFetch);
  vi.stubGlobal('WebSocket', surface.WebSocket);
  vi.stubGlobal('EventSource', surface.EventSource);
  vi.stubGlobal('XMLHttpRequest', surface.XMLHttpRequest);
  release = installDemoGuards();
  return surface;
}

describe('demo guards', () => {
  it('replaces persistent storage and IndexedDB with an empty in-memory surface', () => {
    const surface = install();
    expect(indexedDB).toBeUndefined();
    expect(surface.indexedDB).toBeUndefined();
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

  it('allows only static GETs and Fontshare, counting and rejecting other fetches', async () => {
    install();
    await fetch('/favicon.svg');
    await fetch('https://api.fontshare.com/v2/css?f[]=switzer');
    await fetch('https://cdn.fontshare.com/fonts/switzer.woff2');
    await expect(fetch('/api/me')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('/sync')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('https://api.iconify.design/collections')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('https://example.test/anything')).rejects.toThrow('Demo blocked fetch');
    await expect(fetch('/favicon.svg', { method: 'POST' })).rejects.toThrow('Demo blocked fetch');
    expect(nativeFetch).toHaveBeenCalledTimes(3);
    expect(demoGuardReport().blocked).toBe(5);
  });

  it('blocks sockets, non-static XHR and sendBeacon', () => {
    install();
    expect(() => new WebSocket('wss://demo.test/sync')).toThrow('Demo blocked WebSocket');
    expect(() => new EventSource('/api/events')).toThrow('Demo blocked EventSource');
    expect(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
    }).toThrow('Demo blocked XMLHttpRequest');
    expect(navigator.sendBeacon('/api/track', 'x')).toBe(false);
    expect(demoGuardReport().blocked).toBe(4);
  });
});
