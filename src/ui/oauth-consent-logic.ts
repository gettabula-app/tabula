export type OAuthScope = 'read' | 'comment' | 'write';

export type OAuthDecisionInput =
  | { request: string; decision: 'allow'; scope: OAuthScope; nonce: string; boardIds?: string[] }
  | { request: string; decision: 'deny'; scope?: OAuthScope; nonce: string };

export type OAuthDecisionBody =
  | { request: string; decision: 'allow'; scope: OAuthScope; nonce: string; boardIds?: string[] }
  | { request: string; decision: 'deny'; nonce: string };

export interface OAuthScopeOption {
  value: OAuthScope;
  label: string;
  help: string;
}

export const MAX_OAUTH_BOARD_IDS = 50;

/** Mirrors server/api.mjs oauthRoleScope: owners and editors write, commenters comment, all other roles read. */
export function roleScope(role: string): OAuthScope {
  if (role === 'editor' || role === 'owner') return 'write';
  return role === 'commenter' ? 'comment' : 'read';
}

function scopeRank(scope: OAuthScope): number {
  return scope === 'write' ? 3 : scope === 'comment' ? 2 : 1;
}

/** Apply the all-board ceiling and the strongest role among the ticked boards. */
export function boardsCeiling(scopesBoards: OAuthScope, tickedRoles: string[]): OAuthScope {
  const strongest = tickedRoles.reduce<OAuthScope>((max, role) => (
    scopeRank(roleScope(role)) > scopeRank(max) ? roleScope(role) : max
  ), 'read');
  return scopeRank(scopesBoards) <= scopeRank(strongest) ? scopesBoards : strongest;
}

export const OAUTH_REQUEST_INVALID = 'This connection request is no longer valid. Go back to the app and start again.';
export const OAUTH_FRAMED_PAGE = 'This page cannot be shown inside another page.';
export const OAUTH_UNVERIFIED_WARNING = 'Tabula has not verified this destination. Only continue if you started this connection yourself.';

const ENVELOPE = /^[A-Za-z0-9_-]{1,8192}$/;

/** The signed request stays opaque. Reject it before any API call or rendering. */
export function isOAuthEnvelope(value: unknown): value is string {
  return typeof value === 'string' && ENVELOPE.test(value);
}

/** The client offers only scopes the server says are available, with Read as the default. */
export function scopeOptions(maxScope: OAuthScope): OAuthScopeOption[] {
  const options: OAuthScopeOption[] = [
    { value: 'read', label: 'Read', help: 'See boards, objects and comments.' },
  ];
  if (maxScope === 'comment' || maxScope === 'write') {
    options.push({ value: 'comment', label: 'Read and comment', help: '…and add comments.' });
  }
  if (maxScope === 'write') {
    options.push({ value: 'write', label: 'Read and edit', help: '…and add, change and delete objects.' });
  }
  return options;
}

/** Use the redirect URI only to name loopback destinations; never navigate to it directly. */
export function hostPresentation(redirectHost: string, redirectUri: string, verified: boolean) {
  const displayedHost = redirectHost.toLowerCase();
  const host = (displayedHost.startsWith('[')
    ? displayedHost.slice(0, displayedHost.indexOf(']') + 1)
    : displayedHost.replace(/:\d+$/u, '')).replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  let label = redirectHost;
  if (loopback) {
    let port = '';
    try {
      port = new URL(redirectUri).port;
    } catch {
      // The server has already validated the URI; keep a safe fallback for an unexpected response.
    }
    label = `an app on this computer (127.0.0.1${port ? `:${port}` : ''})`;
  }
  return {
    label,
    verified: verified === true,
    warning: verified === true ? null : OAUTH_UNVERIFIED_WARNING,
  };
}

export function titleText(clientName: string, clientNameIsClaim: boolean, workspace: string): string {
  const intro = clientNameIsClaim ? 'An app that claims to be' : 'An app named';
  return `${intro} ‘${clientName}’ wants access to ${workspace}`;
}

/** Only plain, documented response facts are turned into sentences; server messages and input are not echoed. */
export function errorSentence(status: number, code: string, retryAfter?: number): string {
  if (status === 404) return OAUTH_REQUEST_INVALID;
  if (status === 429 && code === 'rate_limited') {
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      const seconds = Math.ceil(retryAfter);
      return `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
    }
    return 'Too many requests. Try again later.';
  }
  if (status === 402 && code === 'read_only') return 'This workspace is read-only. Ask the workspace owner to check billing.';
  if (status === 409 && code === 'grant_limit') return 'You can have at most 20 connected apps. Disconnect one first.';
  if (status === 400 && code === 'invalid_scope') return 'The available access level changed. Review the updated request.';
  if (status === 400 && code === 'invalid_boards') return 'One of the chosen boards is no longer available. Review the updated list.';
  return 'Could not complete this connection request. Try again.';
}

/** Construct only the server's allowed body fields; Deny never sends a scope. */
export function decisionBody(input: OAuthDecisionInput): OAuthDecisionBody {
  if (input.decision === 'deny') {
    return { request: input.request, decision: 'deny', nonce: input.nonce };
  }
  return {
    request: input.request, decision: 'allow', scope: input.scope, nonce: input.nonce,
    ...(Array.isArray(input.boardIds) && input.boardIds.length > 0 ? { boardIds: input.boardIds } : {}),
  };
}
