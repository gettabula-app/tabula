import { ApiError, type BoardRole, type Me, type Workspace } from './api';
import type { AuthState } from './auth';

// Hosted workspaces (docs/cloud.md): the rules the screens share, kept free of the DOM so they can be tested.

export const READ_ONLY_BADGE = 'Workspace is read-only';
export const ME_REFRESH_MS = 5 * 60 * 1000;

const READ_ONLY_BANNER = 'This workspace is read-only.';

const ERROR_TEXT = new Map([
  ['seat_limit', 'All seats are in use. Remove or disable someone, or ask the workspace owner to add seats.'],
  ['read_only', 'This workspace is read-only right now. Ask the workspace owner to check billing.'],
]);

/** The workspace limits the server reported for the signed-in user; null in open mode and on plain accounts servers. */
export function workspaceOf(auth: AuthState): Workspace | null {
  return auth.mode === 'signed-in' || auth.mode === 'offline' ? (auth.me?.workspace ?? null) : null;
}

/** The line to show above the app: the operator's banner, or a plain notice for a read-only workspace without one. */
export function bannerText(workspace: Workspace | null | undefined): string | null {
  if (!workspace) return null;
  return workspace.banner?.trim() || (workspace.readOnly ? READ_ONLY_BANNER : null);
}

export interface BoardAccess {
  storeReadOnly: boolean;
  commentsReadOnly: boolean;
  /** Text of the badge next to the board name; null when the board is editable. */
  badge: string | null;
}

/** What the person may do on a board: their role, and nothing at all while the workspace is read-only. */
export function boardAccess(role: BoardRole | null | undefined, workspace: Workspace | null | undefined): BoardAccess {
  const locked = workspace?.readOnly === true;
  const viewer = role === 'viewer';
  const commenter = role === 'commenter';
  return {
    storeReadOnly: locked || viewer || commenter,
    commentsReadOnly: locked || viewer,
    badge: locked ? READ_ONLY_BADGE : viewer || commenter ? 'View only' : null,
  };
}

/** Only the owner of a workspace that a control plane runs has a billing portal. */
export function canManageBilling(me: Me | null | undefined): boolean {
  return me?.workspace !== undefined && me.user.role === 'owner';
}

/** A readable text for the errors that only hosted workspaces produce; null for any other error. */
export function cloudErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const fallback = ERROR_TEXT.get(error.code);
  if (fallback === undefined) return null;
  return error.message && error.message !== error.code ? error.message : fallback;
}

/** The portal address, if it is one the app may navigate to. */
export function portalTarget(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export const meChanged = (before: Me | null, after: Me): boolean => JSON.stringify(before) !== JSON.stringify(after);

export interface MeRefreshDeps {
  /** Only a signed-in person on a hosted workspace has anything to refresh. */
  active: () => boolean;
  /** Background tabs wait until they are seen again, so an idle workspace can sleep. */
  visible: () => boolean;
  fetchMe: () => Promise<Me>;
  apply: (me: Me) => void;
  /** The server no longer knows this session. */
  expired: () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/** Asks the server who the user is every few minutes, so a banner or a read-only switch shows up without a reload. */
export function createMeRefresher(deps: MeRefreshDeps, ms = ME_REFRESH_MS) {
  let busy = false;
  let missed = false;

  async function run() {
    if (busy || !deps.active()) return;
    if (!deps.visible()) {
      missed = true;
      return;
    }
    busy = true;
    missed = false;
    try {
      const me = await deps.fetchMe();
      // The person may have signed out while the request was in flight.
      if (deps.active()) deps.apply(me);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) deps.expired();
    } finally {
      busy = false;
    }
  }

  const handle = deps.setInterval(() => void run(), ms);
  return {
    /** Call when the tab is seen again: runs the refresh a hidden tab skipped. */
    resume: () => {
      if (missed) void run();
    },
    stop: () => deps.clearInterval(handle),
  };
}
