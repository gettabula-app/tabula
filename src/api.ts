export type UserRole = 'owner' | 'admin' | 'member' | 'guest';
export type TeamRole = 'admin' | 'member';
export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer';
export type ShareRole = 'editor' | 'commenter' | 'viewer';
export type PrincipalType = 'user' | 'team';

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/** Present in /api/me only when a control plane runs this instance (docs/cloud.md). */
export interface Workspace {
  readOnly: boolean;
  banner: string | null;
  seatLimit: number | null;
  seatsUsed: number;
}

export interface Me {
  user: ApiUser;
  teams: { id: string; name: string; role: TeamRole }[];
  workspace?: Workspace;
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole | null;
  memberCount: number;
  archived: boolean;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
}

export interface Invite {
  id: string;
  role: TeamRole;
  expiresAt: number;
  uses: number;
  maxUses: number | null;
}

export interface CreatedInvite {
  id: string;
  url: string;
  token: string;
  expiresAt: number;
}

export interface InvitePreview {
  team: { id: string; name: string };
  role: TeamRole;
}

export interface ServerBoard {
  id: string;
  title: string;
  teamId: string | null;
  ownerId: string | null;
  role: BoardRole;
  createdAt: number;
  updatedAt: number;
}

export interface Share {
  principalType: PrincipalType;
  principalId: string;
  name: string;
  role: ShareRole;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  teams: { id: string; name: string; role: TeamRole }[];
}

export interface AdminOverview {
  members: { total: number; active: number; disabled: number; byRole: Record<UserRole, number> };
  teams: { total: number; archived: number };
  boards: { total: number; deleted: number };
  sessions: { active: number };
  signIns7d: number;
  live: { rooms: number; connections: number };
  instance: { authEnabled: true; baseUrl: string; mail: 'log' | 'file' | 'webhook' | 'smtp'; version: string };
}

export interface AdminMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  activeSessions: number;
  boardCount: number;
  teams: { id: string; name: string; role: TeamRole }[];
}

export interface AdminSession {
  id: string;
  userId: string;
  userName: string;
  email: string;
  createdAt: number;
  lastSeen: number;
  /** The browser the session signed in from; null for sessions older than this field. */
  userAgent: string | null;
  expiresAt: number;
  current: boolean;
}

export interface AdminBoard {
  id: string;
  title: string;
  ownerId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  shareCount: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  detail: Record<string, unknown>;
}

export interface AuditPage {
  entries: AuditEntry[];
  next: number | null;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A hung server must not freeze the app: a timeout rejects like any other network failure. */
const REQUEST_TIMEOUT_MS = 8000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

type Body = { valid: true; data: unknown } | { valid: false };

async function readBody(res: Response): Promise<Body> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { valid: false };
  }
  if (!text) return { valid: true, data: undefined };
  try {
    return { valid: true, data: JSON.parse(text) };
  } catch {
    return { valid: false };
  }
}

export function createApi(fetchFn: typeof fetch = (...a) => fetch(...a)) {
  async function call<T>(method: Method, path: string, payload?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers['x-tabula'] = '1';
    const init: RequestInit = { method, credentials: 'same-origin', headers };
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }

    let res: Response;
    try {
      res = await fetchFn(path, init);
    } catch {
      throw new ApiError(0, 'network', 'network');
    }
    const body = await readBody(res);
    if (!res.ok) {
      const fields: Record<string, unknown> = body.valid && isRecord(body.data) ? body.data : {};
      const code = typeof fields.error === 'string' ? fields.error : 'unknown';
      const message = typeof fields.message === 'string' ? fields.message : code;
      throw new ApiError(res.status, code, message);
    }
    if (!body.valid) throw new ApiError(res.status, 'unknown', 'unknown');
    return body.data as T;
  }

  const seg = (s: string) => encodeURIComponent(s);
  const qs = (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  return {
    config: () => call<{ authEnabled: boolean }>('GET', '/api/config'),
    me: () => call<Me>('GET', '/api/me'),
    updateMe: (name: string) => call<ApiUser>('PATCH', '/api/me', { name }),
    requestLogin: (email: string, invite?: string) =>
      call<{ ok: true }>('POST', '/api/auth/request', { email, invite }),
    verifyLogin: (token: string) => call<{ user: ApiUser }>('POST', '/api/auth/verify', { token }),
    logout: () => call<void>('POST', '/api/auth/logout'),
    logoutAll: () => call<void>('POST', '/api/auth/logout-all'),

    teams: () => call<Team[]>('GET', '/api/teams'),
    createTeam: (name: string) => call<Team>('POST', '/api/teams', { name }),
    updateTeam: (id: string, patch: { name?: string; archived?: boolean }) =>
      call<Team>('PATCH', `/api/teams/${seg(id)}`, patch),
    teamMembers: (id: string) => call<TeamMember[]>('GET', `/api/teams/${seg(id)}/members`),
    setTeamRole: (teamId: string, userId: string, role: TeamRole) =>
      call<TeamMember>('PATCH', `/api/teams/${seg(teamId)}/members/${seg(userId)}`, { role }),
    removeTeamMember: (teamId: string, userId: string) =>
      call<void>('DELETE', `/api/teams/${seg(teamId)}/members/${seg(userId)}`),
    createInvite: (teamId: string, opts: { role?: TeamRole; days?: number } = {}) =>
      call<CreatedInvite>('POST', `/api/teams/${seg(teamId)}/invites`, opts),
    listInvites: (teamId: string) => call<Invite[]>('GET', `/api/teams/${seg(teamId)}/invites`),
    revokeInvite: (teamId: string, inviteId: string) =>
      call<void>('DELETE', `/api/teams/${seg(teamId)}/invites/${seg(inviteId)}`),
    invitePreview: (token: string) => call<InvitePreview>('GET', `/api/invites/${seg(token)}`),
    acceptInvite: (token: string) => call<InvitePreview>('POST', `/api/invites/${seg(token)}/accept`),

    boards: () => call<ServerBoard[]>('GET', '/api/boards'),
    createBoard: (board: { id: string; title?: string; teamId?: string }) =>
      call<ServerBoard>('POST', '/api/boards', board),
    updateBoard: (id: string, patch: { title?: string; teamId?: string | null }) =>
      call<ServerBoard>('PATCH', `/api/boards/${seg(id)}`, patch),
    deleteBoard: (id: string) => call<void>('DELETE', `/api/boards/${seg(id)}`),
    shares: (boardId: string) => call<Share[]>('GET', `/api/boards/${seg(boardId)}/shares`),
    share: (boardId: string, grant: { principalType: PrincipalType; principalId: string; role: ShareRole }) =>
      call<void>('POST', `/api/boards/${seg(boardId)}/shares`, grant),
    unshare: (boardId: string, principalType: PrincipalType, principalId: string) =>
      call<void>('DELETE', `/api/boards/${seg(boardId)}/shares/${seg(principalType)}/${seg(principalId)}`),

    members: () => call<Member[]>('GET', '/api/members'),
    updateMember: (id: string, patch: { role?: UserRole; disabled?: boolean }) =>
      call<Member>('PATCH', `/api/members/${seg(id)}`, patch),
    removeMember: (id: string) => call<void>('DELETE', `/api/members/${seg(id)}`),

    billingPortal: () => call<{ url: string }>('POST', '/api/billing/portal'),

    adminOverview: () => call<AdminOverview>('GET', '/api/admin/overview'),
    adminMembers: () => call<AdminMember[]>('GET', '/api/admin/members'),
    revokeMemberSessions: (id: string) => call<void>('POST', `/api/admin/members/${seg(id)}/revoke-sessions`),
    adminSessions: () => call<AdminSession[]>('GET', '/api/admin/sessions'),
    revokeSession: (id: string) => call<void>('DELETE', `/api/admin/sessions/${seg(id)}`),
    adminBoards: (deleted = false) => call<AdminBoard[]>('GET', `/api/admin/boards${qs({ deleted: deleted ? 1 : undefined })}`),
    restoreBoard: (id: string) => call<void>('POST', `/api/admin/boards/${seg(id)}/restore`),
    adminAudit: (opts: { limit?: number; before?: number; action?: string } = {}) =>
      call<AuditPage>('GET', `/api/admin/audit${qs({ limit: opts.limit, before: opts.before, action: opts.action })}`),
  };
}

export const api = createApi();
