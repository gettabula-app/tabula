import type { AccessScope, AccessToken, UserRole } from '../api';

/** Pure rules and text for AI tool access (docs/mcp.md): no DOM, so they can be unit tested. */

/** The name tools register this server under; MCP_SERVER_NAME in server/mcp.mjs (a test keeps them equal). */
export const SERVER_NAME = 'board';

/** AI tool access is offered only when the server has turned it on for this person (`me.mcp`). */
export function aiToolsAvailable(me: { mcp?: boolean } | null | undefined): boolean {
  return me?.mcp === true;
}

export const NAME_MAX = 80;
export const MAX_BOARDS = 20;
export const EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const DEFAULT_DAYS = 30;
export const DEFAULT_SCOPE: AccessScope = 'read';

export const SCOPE_OPTIONS: { value: AccessScope; label: string; hint: string }[] = [
  { value: 'read', label: 'Read only', hint: 'The tool can read boards and comments. It cannot change anything.' },
  { value: 'comment', label: 'Read and comment', hint: 'The tool can also add comments and replies.' },
  { value: 'write', label: 'Read and edit', hint: 'This token can change every board listed, as you.' },
];

export const scopeLabel = (scope: AccessScope): string => SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;

/** Owners and admins are the owner of every board, so a token that can write must name the boards it may use. */
export function needsBoardPick(role: UserRole, scope: AccessScope): boolean {
  return (role === 'owner' || role === 'admin') && scope !== 'read';
}

export interface Draft {
  name: string;
  scope: AccessScope;
  allBoards: boolean;
  boardIds: string[];
  days: number;
}

export const emptyDraft = (): Draft => ({ name: '', scope: DEFAULT_SCOPE, allBoards: true, boardIds: [], days: DEFAULT_DAYS });

/** Why a draft cannot be created yet, or null. The server checks the same rules. */
export function draftProblem(role: UserRole, draft: Draft): string | null {
  const name = draft.name.trim();
  if (!name) return 'Give the token a name, for example the tool it is for.';
  if (name.length > NAME_MAX) return `Use at most ${NAME_MAX} characters for the name.`;
  if (!(EXPIRY_DAYS as readonly number[]).includes(draft.days)) return 'Pick when the token expires.';
  if (!draft.allBoards && draft.boardIds.length === 0) return 'Pick at least one board.';
  if (!draft.allBoards && draft.boardIds.length > MAX_BOARDS) return `Pick at most ${MAX_BOARDS} boards.`;
  if (needsBoardPick(role, draft.scope) && draft.allBoards) return 'This level needs named boards: pick the boards it may use.';
  return null;
}

export function toRequest(draft: Draft): { name: string; scope: AccessScope; days: number; boardIds?: string[] } {
  return {
    name: draft.name.trim(),
    scope: draft.scope,
    days: draft.days,
    ...(draft.allBoards ? {} : { boardIds: draft.boardIds }),
  };
}

/** "All boards you can access", or the titles when known, otherwise a count. */
export function boardsLabel(boardIds: string[] | null, titles: ReadonlyMap<string, string> = new Map()): string {
  if (boardIds === null) return 'All boards you can access';
  if (boardIds.length === 0) return 'No boards';
  const names = boardIds.map((id) => titles.get(id) || 'a board');
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** "All boards", "1 board", "3 boards": for lists that do not know the titles. */
export function boardsSummary(boardIds: string[] | null): string {
  if (boardIds === null) return 'All boards';
  return `${boardIds.length} ${boardIds.length === 1 ? 'board' : 'boards'}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function expiryLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return 'Expired';
  const days = Math.ceil(left / DAY_MS);
  if (days <= 1) return 'Expires today';
  if (days === 2) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

export function lastUsedLabel(token: Pick<AccessToken, 'lastUsedAt'>, ago: (t: number) => string): string {
  return token.lastUsedAt === null ? 'Never used' : `Used ${ago(token.lastUsedAt)}`;
}

/** What to paste into a tool. The token is only ever in these two strings while its dialog is open. */
export function clientSnippets(url: string, token: string): { claudeCode: string; config: string } {
  return {
    claudeCode: `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`,
    config: JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  };
}
