import type { AuthState } from './auth';

/**
 * Whether this person's workspace has the tracker: signed in (or offline with a remembered account) and /api/me says so.
 * Every entry point (the top bar link, the board menu item, the tracker route) asks this one question. A guest, the demo
 * and a scratch board never pass it.
 */
export function trackerEnabled(auth: AuthState): boolean {
  return (auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me?.tracker === true;
}
