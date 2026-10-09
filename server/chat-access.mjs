// Who may do what in a chat channel (docs/chat.md, "Channels and who may do what"). Pure: the directory's lookups are
// passed in, so the whole table is tested without a server. Every read, write and subscription asks this one function.

// the same pattern as directory.mjs, kept here so this module loads without node:sqlite
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const CHAT_KINDS = ['board', 'team', 'workspace'];
const WRITERS = new Set(['owner', 'editor', 'commenter']);

/**
 * @typedef {{ id: string, role: string, disabled?: boolean }} ChatUser
 * @typedef {{ read: boolean, write: boolean, moderate: boolean, role: string | null, readOnly: boolean }} ChatAccess
 * @typedef {object} AccessDeps
 * @property {(id: string) => ({ deletedAt: number | null } | null)} getBoard
 * @property {(boardId: string, userId: string) => (string | null)} boardRole
 * @property {boolean} [readOnly] the hosted workspace is read-only
 * @property {boolean} [viewersMayPost] the workspace setting "Viewers may post in board chat"
 */

const isWorkspaceAdmin = (user) => user.role === 'owner' || user.role === 'admin';

/**
 * What `user` may do in channel (kind, ref), or null when the channel does not exist for them (the API then answers
 * 404, never 403, so nobody learns what exists). `role` is the board role behind the answer, so a caller can tell a
 * viewer who may not post from everyone else. A read-only workspace keeps reading and refuses writing and moderating.
 *
 * Only board channels exist in this slice: team and workspace channels answer null until they are built.
 * @param {ChatUser | null | undefined} user
 * @param {unknown} kind
 * @param {unknown} ref
 * @param {AccessDeps} deps
 * @returns {ChatAccess | null}
 */
export function chatAccess(user, kind, ref, deps) {
  if (!user || typeof user.id !== 'string' || user.disabled) return null;
  if (kind !== 'board') return null;
  if (typeof ref !== 'string' || !BOARD_ID_RE.test(ref)) return null;
  const board = deps.getBoard(ref);
  if (!board) return null;
  const readOnly = deps.readOnly === true;
  // A deleted board keeps its chat for workspace admins to read, like the board itself; nobody writes to it.
  if (board.deletedAt != null) {
    return isWorkspaceAdmin(user) ? { read: true, write: false, moderate: false, role: 'owner', readOnly } : null;
  }
  const role = deps.boardRole(ref, user.id);
  if (role === null || role === undefined) return null;
  const write = WRITERS.has(role) || (role === 'viewer' && deps.viewersMayPost === true);
  const moderate = role === 'owner';
  return { read: true, write: write && !readOnly, moderate: moderate && !readOnly, role, readOnly };
}

/**
 * chatAccess bound to the live directory and workspace state. Every call reads them afresh, so a role change, a share
 * or a read-only switch applies to the next question. `settings` returns the chat settings (readChatSettings).
 * @param {{ directory: { getBoard: Function, boardRole: Function }, cloud?: { limits(): { readOnly: boolean } } | null,
 *   settings: () => { viewersMayPost: boolean } }} deps
 * @returns {(user: ChatUser | null | undefined, kind: unknown, ref: unknown) => ChatAccess | null}
 */
export function boundAccess({ directory, cloud = null, settings }) {
  return (user, kind, ref) =>
    chatAccess(user, kind, ref, {
      getBoard: (id) => directory.getBoard(id),
      boardRole: (boardId, userId) => directory.boardRole(boardId, userId),
      readOnly: cloud?.limits().readOnly === true,
      viewersMayPost: settings().viewersMayPost,
    });
}

/** The channel key used in maps and limiter keys. */
export const channelKey = (kind, ref) => `${kind}/${ref}`;
