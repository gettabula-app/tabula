import type { AuthState } from './auth';

export const ADMIN_TABS = ['overview', 'members', 'teams', 'boards', 'sessions', 'tokens', 'ai', 'backups', 'audit'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

export type Route =
  | { name: 'home' }
  | { name: 'templates' }
  | { name: 'template-edit'; id: string }
  | { name: 'board'; id: string }
  | { name: 'signin' }
  | { name: 'verify'; token: string }
  | { name: 'invite'; token: string }
  | { name: 'admin'; tab: AdminTab };

const HOME: Route = { name: 'home' };

/** An unknown or missing tab is the overview. */
function adminTab(segment: string | undefined): AdminTab {
  return ADMIN_TABS.find((t) => t === segment) ?? 'overview';
}

/** Sign-in, emailed-link and invite screens: reachable without a session. */
function isAuthRoute(route: Route): boolean {
  return route.name === 'signin' || route.name === 'verify' || route.name === 'invite';
}

/** Maps a location hash to a route. Anything unrecognised is the home screen, as it always was. */
export function parseRoute(hash: string): Route {
  const board = hash.match(/^#\/b\/([A-Za-z0-9_-]{1,64})$/);
  if (board) return { name: 'board', id: board[1] };
  const edit = hash.match(/^#\/t\/([A-Za-z0-9_-]{1,64})\/edit$/);
  if (edit) return { name: 'template-edit', id: edit[1] };
  const invite = hash.match(/^#\/invite\/([A-Za-z0-9_-]+)$/);
  if (invite) return { name: 'invite', token: invite[1] };
  if (hash === '#/signin') return { name: 'signin' };
  if (hash === '#/templates') return { name: 'templates' };
  const admin = hash.match(/^#\/admin(?:\/([^/]*))?$/);
  if (admin) return { name: 'admin', tab: adminTab(admin[1]) };
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
  return mode === 'open' && (isAuthRoute(route) || route.name === 'admin') ? HOME : route;
}

/** Only a server that has accounts turned on and no signed-in user gates routes. */
export function needsSignIn(route: Route, mode: AuthState['mode']): boolean {
  return mode === 'signed-out' && !isAuthRoute(route);
}

/** The hash worth coming back to after signing in. Only boards: the other routes are the gate itself or home. */
export function returnHash(hash: string): string | null {
  return parseRoute(hash).name === 'board' ? hash : null;
}
