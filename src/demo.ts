import { DEMO_FONT_ALLOWLIST } from './font-policy';

/** A build-time switch; ordinary app builds replace this with `undefined`. */
declare global {
  interface ImportMetaEnv {
    readonly VITE_DEMO?: string;
  }
}

export const DEMO = import.meta.env.VITE_DEMO === '1';

export interface DemoGuardReport {
  blocked: number;
  attempts: string[];
}

let blocked = 0;
let attempts: string[] = [];
let releaseGuards: (() => void) | null = null;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(String(key)) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(String(key)),
    setItem: (key, value) => void data.set(String(key), String(value)),
  };
}

function sameTarget(a: object, b: object): boolean {
  return a === b;
}

/**
 * Prevents app code in the landing-page demo from using persistent browser APIs or making backend requests.
 * The first import of this module applies the guard before the rest of main.ts's static imports are evaluated.
 */
export function installDemoGuards(): () => void {
  if (releaseGuards) return releaseGuards;

  blocked = 0;
  attempts = [];
  const win = typeof window === 'undefined' ? globalThis : window;
  const targets = [globalThis, win].filter((target, i, list) => list.findIndex((other) => sameTarget(target, other)) === i);
  const restorers: (() => void)[] = [];
  const replace = (target: object, key: PropertyKey, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, enumerable: descriptor?.enumerable ?? true, writable: true, value });
    restorers.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
  };
  const reject = (kind: string, target: string): never => {
    blocked++;
    attempts.push(`${kind}: ${target}`);
    throw new Error(`Demo blocked ${kind}: ${target}`);
  };
  const allowedFontshare = (url: URL): boolean => {
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false;
    if (url.hostname === 'api.fontshare.com') {
      if (url.pathname !== '/v2/css') return false;
      const params = [...url.searchParams.entries()];
      const values = url.searchParams.getAll('f[]');
      if (!values.length || params.some(([key]) => key !== 'f[]' && key !== 'display')) return false;
      if (url.searchParams.getAll('display').some((value) => value !== 'swap')) return false;
      return values.every((value) => {
        const match = /^([a-z0-9-]+)(?:@([0-9]{3}(?:,[0-9]{3})*))?$/.exec(value);
        if (!match || !DEMO_FONT_ALLOWLIST.has(match[1])) return false;
        return !match[2] || match[2].split(',').every((weight) => Number(weight) >= 100 && Number(weight) <= 900);
      });
    }
    if (url.hostname === 'cdn.fontshare.com') {
      return !url.search && /(?:^|\/)\w[^/]*\.(?:woff2?|otf|ttf)$/i.test(url.pathname);
    }
    return false;
  };
  const allowed = (method: string, value: string | URL): boolean => {
    if (method.toUpperCase() !== 'GET') return false;
    let url: URL;
    try {
      url = new URL(String(value), globalThis.location?.href ?? 'http://localhost/');
    } catch {
      return false;
    }
    if (url.protocol === 'https:' && ['api.fontshare.com', 'cdn.fontshare.com'].includes(url.hostname)) {
      return allowedFontshare(url);
    }
    const origin = globalThis.location?.origin ?? new URL(globalThis.location?.href ?? 'http://localhost/').origin;
    if (url.origin !== origin) return false;
    const base = new URL(import.meta.env.BASE_URL || '/', globalThis.location?.href ?? 'http://localhost/').pathname;
    if (!url.pathname.startsWith(base)) return false;
    return !/(?:^|\/)(?:api|sync|chat)(?:\/|$)/i.test(url.pathname);
  };

  for (const target of targets) {
    replace(target, 'localStorage', memoryStorage());
    replace(target, 'sessionStorage', memoryStorage());
    replace(target, 'indexedDB', undefined);
    replace(target, 'caches', undefined);
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const guardedFetch: typeof fetch = async (input, init) => {
    const request = typeof Request !== 'undefined' && input instanceof Request;
    const target = request ? (input as Request).url : String(input);
    const method = init?.method ?? (request ? (input as Request).method : 'GET');
    if (!allowed(method, target)) reject('fetch', target);
    return originalFetch(input, init);
  };
  replace(globalThis, 'fetch', guardedFetch);
  if (!sameTarget(globalThis, win)) replace(win, 'fetch', guardedFetch);

  const blockedConstructor = (name: string) => class {
    constructor(target: string | URL) { reject(name, String(target)); }
  };
  for (const target of targets) {
    replace(target, 'WebSocket', blockedConstructor('WebSocket'));
    replace(target, 'EventSource', blockedConstructor('EventSource'));
  }

  const originalXhr = globalThis.XMLHttpRequest;
  function GuardedXMLHttpRequest(): XMLHttpRequest {
    if (!originalXhr) return reject('XMLHttpRequest', 'constructor');
    const xhr = new originalXhr();
    let demoAllowed = false;
    const open = xhr.open.bind(xhr) as (method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) => void;
    const send = xhr.send.bind(xhr) as (body?: Document | XMLHttpRequestBodyInit | null) => void;
    xhr.open = ((method: string, url: string | URL, async = true, username?: string | null, password?: string | null) => {
      demoAllowed = allowed(method, url);
      if (!demoAllowed) reject('XMLHttpRequest', String(url));
      open(method, url, Boolean(async), username ?? null, password ?? null);
    }) as typeof xhr.open;
    xhr.send = ((body?: Document | XMLHttpRequestBodyInit | null) => {
      if (!demoAllowed) reject('XMLHttpRequest', 'send');
      send(body ?? null);
    }) as typeof xhr.send;
    return xhr;
  }
  for (const target of targets) replace(target, 'XMLHttpRequest', GuardedXMLHttpRequest);

  const navigatorTargets = targets.flatMap((target) => {
    try {
      const nav = (target as unknown as { navigator?: Navigator }).navigator;
      return nav ? [nav] : [];
    } catch {
      return [];
    }
  }).filter((target, i, list) => list.findIndex((other) => other === target) === i);
  const blockedBeacon = (url: string | URL) => {
    try { reject('sendBeacon', String(url)); } catch { return false; }
    return false;
  };
  for (const nav of navigatorTargets) {
    replace(nav, 'sendBeacon', blockedBeacon);
    const serviceWorker = (nav as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
    if (serviceWorker && typeof serviceWorker.register === 'function') {
      replace(serviceWorker, 'register', ((scriptURL: string | URL) => {
        try { reject('serviceWorker.register', String(scriptURL)); } catch (error) { return Promise.reject(error); }
      }) as ServiceWorkerContainer['register']);
    }
  }

  if (typeof Navigator !== 'undefined' && typeof Navigator.prototype.sendBeacon === 'function') {
    replace(Navigator.prototype, 'sendBeacon', blockedBeacon);
  }

  releaseGuards = () => {
    for (const restore of restorers.reverse()) restore();
    releaseGuards = null;
  };
  return releaseGuards;
}

/** A snapshot of requests or APIs the guard refused, for the demo verification suite. */
export function demoGuardReport(): DemoGuardReport {
  return { blocked, attempts: [...attempts] };
}

// This module is the first main.ts dependency: its evaluation runs before any app module can read storage.
if (DEMO) installDemoGuards();
