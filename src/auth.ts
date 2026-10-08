import { ApiError, api, type Me, type ServerBoard } from './api';

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
