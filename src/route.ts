import type { AuthState } from './auth';

export type Route =
  | { name: 'home' }
  | { name: 'board'; id: string }
  | { name: 'signin' }
  | { name: 'verify'; token: string }
  | { name: 'invite'; token: string };

const HOME: Route = { name: 'home' };

/** Sign-in, emailed-link and invite screens: reachable without a session. */
function isAuthRoute(route: Route): boolean {
  return route.name === 'signin' || route.name === 'verify' || route.name === 'invite';
}

/** Maps a location hash to a route. Anything unrecognised is the home screen, as it always was. */
export function parseRoute(hash: string): Route {
  const board = hash.match(/^#\/b\/([A-Za-z0-9_-]{1,64})$/);
  if (board) return { name: 'board', id: board[1] };
  const invite = hash.match(/^#\/invite\/([A-Za-z0-9_-]+)$/);
  if (invite) return { name: 'invite', token: invite[1] };
  if (hash === '#/signin') return { name: 'signin' };
  const verify = hash.match(/^#\/signin\/verify(?:\?(.*))?$/);
  if (verify) {
    const token = new URLSearchParams(verify[1] ?? '').get('token');
    return token ? { name: 'verify', token } : { name: 'signin' };
  }
  return HOME;
}

/** The route to render: open mode has no accounts, so the account screens fall back to home like any unknown hash. */
export function resolveRoute(hash: string, mode: AuthState['mode']): Route {
  const route = parseRoute(hash);
  return mode === 'open' && isAuthRoute(route) ? HOME : route;
}

/** Only a server that has accounts turned on and no signed-in user gates routes. */
export function needsSignIn(route: Route, mode: AuthState['mode']): boolean {
  return mode === 'signed-out' && !isAuthRoute(route);
}

/** The hash worth coming back to after signing in. Only boards: the other routes are the gate itself or home. */
export function returnHash(hash: string): string | null {
  return parseRoute(hash).name === 'board' ? hash : null;
}
