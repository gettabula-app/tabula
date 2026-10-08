import { ApiError, api, type Me, type ServerBoard } from './api';
import { createMeRefresher, meChanged, type MeRefreshDeps } from './cloud-logic';

export type AuthState =
  | { mode: 'unknown' }
  | { mode: 'open' }
  | { mode: 'signed-out' }
  | { mode: 'signed-in'; me: Me }
  | { mode: 'offline'; me: Me | null };

const ME_KEY = 'driftboard:me';
const BOARDS_KEY = 'driftboard:server-boards';

let state: AuthState = { mode: 'unknown' };
const listeners = new Set<(s: AuthState) => void>();

export function authState(): AuthState {
  return state;
}

export function onAuth(fn: (s: AuthState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function commit(next: AuthState): AuthState {
  state = next;
  for (const fn of listeners) fn(next);
  return next;
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage is unavailable (private window, blocked site data): run without the cache */
  }
}

function readJson<T>(key: string): T | null {
  const raw = readStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function forgetCaches() {
  writeStorage(ME_KEY, null);
  writeStorage(BOARDS_KEY, null);
}

export async function initAuth(a: Pick<typeof api, 'config' | 'me'> = api): Promise<AuthState> {
  let authEnabled: boolean;
  try {
    authEnabled = (await a.config()).authEnabled;
  } catch {
    const cached = readJson<Me>(ME_KEY);
    return commit(cached ? { mode: 'offline', me: cached } : { mode: 'open' });
  }
  if (!authEnabled) return commit({ mode: 'open' });

  try {
    const me = await a.me();
    writeStorage(ME_KEY, JSON.stringify(me));
    return commit({ mode: 'signed-in', me });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setSignedOut();
      return authState();
    }
    return commit({ mode: 'offline', me: readJson<Me>(ME_KEY) });
  }
}

let current: ReturnType<typeof createMeRefresher> | null = null;

/**
 * Hosted workspaces (docs/cloud.md): the relay says the workspace changed (an open socket got a hint). Brings the next
 * /api/me forward without trusting the hint; the answer goes through the same path as the five minute refresh. Does
 * nothing before the refresher has started, in open mode and on servers without a control plane.
 */
export function refreshMeSoon() {
  current?.hint();
}

/**
 * Hosted workspaces (docs/cloud.md): while the tab is open, asks for /api/me every few minutes so a new banner or a
 * read-only switch shows up. Does nothing for anyone who is signed out or on a server without a control plane.
 */
export function startMeRefresh(overrides: Partial<MeRefreshDeps> = {}): () => void {
  const refresher = createMeRefresher({
    active: () => state.mode === 'signed-in' && state.me.workspace !== undefined,
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    fetchMe: () => api.me(),
    apply: (me) => {
      if (state.mode === 'signed-in' && meChanged(state.me, me)) setSignedIn(me);
    },
    expired: setSignedOut,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    ...overrides,
  });
  current = refresher;
  const seen = () => {
    if (document.visibilityState === 'visible') refresher.resume();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', seen);
  return () => {
    refresher.stop();
    if (current === refresher) current = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', seen);
  };
}

export async function signOut(a: Pick<typeof api, 'logout'> = api): Promise<void> {
  try {
    await a.logout();
  } finally {
    setSignedOut();
  }
}

export function setSignedIn(me: Me) {
  writeStorage(ME_KEY, JSON.stringify(me));
  commit({ mode: 'signed-in', me });
}

export function setSignedOut() {
  forgetCaches();
  commit({ mode: 'signed-out' });
}

export function cacheServerBoards(list: ServerBoard[]) {
  writeStorage(BOARDS_KEY, JSON.stringify(list));
}

export function cachedServerBoards(): ServerBoard[] {
  const list = readJson<ServerBoard[]>(BOARDS_KEY);
  return Array.isArray(list) ? [...list].sort((a, b) => b.updatedAt - a.updatedAt) : [];
}
