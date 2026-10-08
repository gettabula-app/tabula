# Accounts and teams

Tabula can run in two modes.

- **Open mode** (default, `TABULA_AUTH=off`): today's behaviour. The relay accepts anyone who knows a board link, and each browser keeps its own board list.
- **Accounts mode** (`TABULA_AUTH=on`): people sign in with an email link. The server keeps a directory of members, teams, boards and permissions in SQLite, and the relay enforces them on every connection and every update.

Open mode must keep working unchanged, including every existing test.

## Configuration

Tabula was called Mira before. The old `MIRA_<X>` variable names are deprecated but still honoured: each one is read as `TABULA_<X>` when that is not set (the `TABULA_` name wins), and the relay prints one warning at startup naming the old variables it used. The same applies to the `TABULA_CLOUD_*` variables in `docs/cloud.md`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_AUTH` | `off` | `on` turns accounts mode on |
| `TABULA_OWNER_EMAIL` | none | The first person to sign in with this address becomes the workspace owner. Required when `TABULA_AUTH=on` |
| `TABULA_BASE_URL` | `http://localhost:<PORT>` | Public URL, used in emailed links and as the only allowed WebSocket `Origin`. An `https://` URL makes the session cookie `Secure` and `__Host-` prefixed |
| `TABULA_MAIL` | `log` | `log` prints each email to the console, `file` appends JSON lines to `<DATA_DIR>/outbox.jsonl`, `smtp` sends through your own SMTP server (`TABULA_SMTP_URL`), `webhook` POSTs `{to, subject, text, from, template, params}` as JSON to `TABULA_MAIL_WEBHOOK_URL` |
| `TABULA_MAIL_WEBHOOK_URL` | none | Target for `TABULA_MAIL=webhook` |
| `TABULA_MAIL_WEBHOOK_TOKEN` | none | Sent as `Authorization: Bearer <token>` with each webhook request |
| `TABULA_MAIL_FROM` | `Tabula <no-reply@localhost>` | Sender address; required with `smtp`, included in webhook payloads as `from` |
| `TABULA_SMTP_URL` | none | SMTP connection for `TABULA_MAIL=smtp`, for example `smtps://user:password@smtp.example.com:465` (any provider's SMTP credentials work, including Mailgun's) |
| `.env` | none | The relay reads a `.env` file in its working directory at startup (existing environment variables take precedence); the file is gitignored |
| `TABULA_SESSION_DAYS` | `30` | Session lifetime |
| `TABULA_TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy (Caddy on Cloud): the client IP for rate limiting is the rightmost `X-Forwarded-For` entry. (Whether the cookie is `Secure` follows `TABULA_BASE_URL`, not request headers.) Off by default, because anyone can forge those headers when there is no proxy |

The directory lives in `<DATA_DIR>/directory.sqlite` (Node's built-in `node:sqlite`, no native dependency; requires Node 22.13 or newer). Version history is kept as files under `<DATA_DIR>/history/<boardId>/` in both modes (`docs/history.md`).

## Roles

- **Workspace** (one workspace per instance): `owner`, `admin`, `member`, `guest`. Guests only see boards shared with them and cannot create teams.
- **Team**: `admin`, `member`. A team admin invites and removes people in that team and manages its boards.
- **Board**: `owner`, `editor`, `commenter`, `viewer` (highest first).

| Board role | Board room | Comments room |
| --- | --- | --- |
| `owner`, `editor` | read and write | read and write |
| `commenter` | read only | read and write |
| `viewer` | read only | read only |

Effective board role for a user, highest wins:

1. Workspace `owner` or `admin`: `owner` of every board.
2. The user created the board: `owner`.
3. The board belongs to a team (`team_id`) and the user is a member of that team: `editor` (team admins: `owner`).
4. An explicit share (`board_shares`) to the user, or to a team the user belongs to: the shared role.
5. Otherwise: no access.

`viewer` is read-only: the relay drops their document updates (awareness, i.e. cursors, still works). `commenter` can read the board and write its comments room (see `docs/comments.md`), but not the board itself. Shares can grant `editor`, `commenter` or `viewer`; team members are `editor`s of their team's boards. Deleted boards (`deleted_at` set) have no access for anyone except workspace admins.

## Data model (SQLite)

`PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, schema version in `PRAGMA user_version` with ordered migrations (migration 2 rebuilds `board_shares` to allow the `commenter` role, keeping existing shares). All timestamps are integer milliseconds since the epoch. Ids are random URL-safe strings (16 bytes, base64url) except boards, whose id is the board's room id chosen by the client (`^[A-Za-z0-9_-]{1,64}$`).

```
users(id PK, email UNIQUE COLLATE NOCASE, name, role CHECK(owner|admin|member|guest), disabled INT DEFAULT 0, created_at)
login_tokens(token_hash PK, email, invite_id NULL, expires_at, used_at NULL, created_at)
sessions(id PK, token_hash UNIQUE, user_id FK, created_at, last_seen, expires_at, revoked INT DEFAULT 0, user_agent NULL)   -- user_agent: the browser it signed in from (schema 4)
teams(id PK, name, archived INT DEFAULT 0, created_at)
team_members(team_id FK, user_id FK, role CHECK(admin|member), PRIMARY KEY(team_id,user_id))
invites(id PK, token_hash UNIQUE, team_id FK, role CHECK(admin|member), created_by FK, expires_at, max_uses NULL, uses DEFAULT 0, revoked INT DEFAULT 0, created_at)
boards(id PK, title, owner_id FK, team_id NULL FK, created_at, updated_at, deleted_at NULL)
board_shares(board_id FK, principal_type CHECK(user|team), principal_id, role CHECK(editor|commenter|viewer), PRIMARY KEY(board_id,principal_type,principal_id))
audit(id INTEGER PK AUTOINCREMENT, ts, actor_id NULL, action, detail JSON)
```

Tokens (login, session, invite) are 32 random bytes, base64url, shown once and stored only as a SHA-256 hash.

## Sign-in

- `POST /api/auth/request {email, invite?}` always answers `200 {ok: true}` (no user enumeration). It sends a login link only if the address may sign in: an existing, non-disabled user; or `TABULA_OWNER_EMAIL` when no owner exists yet; or any address presenting a valid invite token. Rate limits (in memory): 5 requests per email and 20 per IP per hour, then `429`.
- The emailed link is `<TABULA_BASE_URL>/#/signin/verify?token=<token>`. It is a fragment link on purpose: mail scanners (Safe Links, Mimecast, chat unfurlers) prefetch links, and a GET that consumed the token would burn it; the fragment also keeps the token out of server and proxy logs. Tokens expire after 15 minutes and are single use.
- The app opens that route and sends `POST /api/auth/verify {token}` (with `x-tabula: 1`). The server consumes the token, re-checks that the invite it came from is still valid (not revoked, not expired, under `max_uses`), creates the user if needed (owner for the owner email, otherwise `member`; joins the invite's team), creates a session, sets the cookie and answers `200 {user}`. An invalid or expired token answers `400 {error: 'invalid_token'}` and the app shows "This link has expired. Request a new one."
- Cookie: host-only (never a `Domain` attribute, because Cloud workspaces are sibling subdomains), `HttpOnly; SameSite=Lax; Path=/; Max-Age=<seconds>`. Over https it is named `__Host-tabula_session` and also `Secure`; over plain http (local dev) it is `tabula_session`. Sessions slide: when less than half the lifetime remains, a request extends it.
- CSRF: every state-changing API request (`POST`, `PATCH`, `PUT`, `DELETE`) must carry the header `x-tabula: 1` and, when an `Origin` header is present, it must match the request host; otherwise `403 {error: 'csrf'}`. The header `x-mira: 1` from the time the product was called Mira is still accepted in its place, but it is deprecated: send `x-tabula: 1`.
- Disabling or removing a user revokes all their sessions and closes their open sync connections at once.

## HTTP API

JSON in and out. Errors: `{error: <code>, message?: <text>}` with status `400` (bad input), `401 unauthenticated`, `403 forbidden`, `404 not_found`, `409 conflict`, `429 rate_limited`. In open mode every `/api/*` route except `/api/health`, `/api/config` and the board version routes (`docs/history.md`) answers `404`.

```
GET    /api/health                      public  {ok, rooms, connections}                       (exists today)
GET    /api/config                      public  {authEnabled: boolean}
GET    /api/me                          -> {user: {id,email,name,role}, teams: [{id,name,role}]}
PATCH  /api/me {name}                   -> user
POST   /api/auth/request {email, invite?}   public
POST   /api/auth/verify {token}         public  -> 200 {user} + Set-Cookie (see Sign-in)
POST   /api/auth/logout                 -> 204 (revokes this session, clears the cookie)
POST   /api/auth/logout-all             -> 204 (revokes every session of this user)

GET    /api/teams                       -> [{id,name,role,memberCount,archived}]   (mine; workspace admins see all, role = their team role or null)
POST   /api/teams {name}                -> 201 team  (not for guests; creator becomes team admin)
PATCH  /api/teams/:id {name?,archived?} -> team      (team admin or workspace admin)
GET    /api/teams/:id/members           -> [{userId,name,email,role}]   (team members and workspace admins)
PATCH  /api/teams/:id/members/:userId {role} -> member  (team admin or workspace admin)
DELETE /api/teams/:id/members/:userId   -> 204  (yourself = leave; team/workspace admins can remove others; the last team admin cannot leave: 409)
POST   /api/teams/:id/invites {role?: 'member'|'admin', days?: 1..30} -> 201 {id, url, token, expiresAt}   (url = <base>/#/invite/<token>; team admin or workspace admin)
GET    /api/teams/:id/invites           -> [{id,role,expiresAt,uses,maxUses}]
DELETE /api/teams/:id/invites/:inviteId -> 204
GET    /api/invites/:token              public  {team: {id,name}, role}  (404 when invalid/expired/revoked)
POST   /api/invites/:token/accept       -> 200 {team: {id,name}, role}   (signed-in user joins the team; same validity rules as at sign-in; idempotent: joining a team you are already in changes nothing and uses no invite slot; promotes a member to admin only when the invite grants admin)

GET    /api/boards                      -> [{id,title,teamId,ownerId,role,createdAt,updatedAt}]   (every board the user can access)
POST   /api/boards {id, title?, teamId?} -> 201 board  (id must match the board id pattern and not be registered: 409; teamId requires team membership; guests cannot create. Adopting existing boards: if a room file `<id>.yjs` (or `<id>~comments.yjs`) already exists on disk but has no directory row, only a workspace owner/admin may register it, anyone else gets 409 `needs_admin`. A board that exists only in the caller's browser has no room file, so any member can register it and their local copy then syncs up)
PATCH  /api/boards/:id {title?, teamId?: string|null} -> board  (board owner or workspace admin; moving into a team requires membership of that team)
DELETE /api/boards/:id                  -> 204  (soft delete; board owner or workspace admin)
GET    /api/boards/:id/shares           -> [{principalType, principalId, name, role}]
POST   /api/boards/:id/shares {principalType: 'user'|'team', principalId, role: 'editor'|'commenter'|'viewer'} -> 201
DELETE /api/boards/:id/shares/:principalType/:principalId -> 204

GET    /api/members                     -> [{id,email,name,role,disabled,teams:[{id,name,role}]}]   (workspace admin)
PATCH  /api/members/:id {role?, disabled?} -> member  (admins; only an owner may change an owner or grant owner; the last owner cannot be demoted or disabled: 409)
DELETE /api/members/:id                 -> 204  (admins; same owner rules; revokes sessions and closes sockets)

GET    /api/boards/:id/versions   and the routes under it: version history of a board (owners and editors only), see docs/history.md
```

Every mutating call writes an `audit` row (`action` like `team.create`, `member.remove`, `invite.create`, `board.delete`, `board.version.restore`).

## Relay (WebSocket `/sync/<boardId>` and `/sync/<boardId>~comments`)

Every board has a sibling comments room, `<boardId>~comments` (room names match `^[A-Za-z0-9_-]{1,64}(~comments)?$`, anything else is a `400`; the room file is `<DATA_DIR>/<room name>.yjs`). Authorisation always runs on the **board** id, for both room kinds, with the same close codes; only the write rule differs (below).

In accounts mode the relay decides **before it touches the room** (`getRoom()` must not run for an unauthorised connection: it would load or create the room file on disk). The HTTP upgrade still completes first so the browser can read a close code:

0. The `Origin` header must equal the origin of `TABULA_BASE_URL`; otherwise answer `403` and destroy the socket before upgrading (stops a page on another workspace's sibling subdomain from riding the cookie).
1. Read the session cookie. No or invalid session: close with code `4401` (`unauthenticated`).
2. Unknown or deleted board id (for non-admins): `4404`. A board must exist in the directory first (created through `POST /api/boards`). Workspace admins may open a deleted board, but read-only: the relay drops their writes to both rooms until the board is restored, and the app opens it read-only with a **Deleted board** badge.
3. No access: `4403` (never deletes anything on the client).
4. Otherwise `getRoom()` and join. The connection remembers `userId`.

While connected:

- Sync messages of type update / step 2 are dropped unless the connection may write that room: the board room needs `owner` or `editor`, the comments room `owner`, `editor` or `commenter`. Nobody is told; their local edits stay local. Sync step 1 (state vector request) is always allowed. Awareness always works.
- The role is re-resolved at most every 5 seconds per connection, and immediately after any access change, so a demoted editor becomes read-only (or comment-only) without reconnecting and a member who lost access is disconnected with close code **`4410` (`access_removed`)**. `4410` is the only code the client may treat as "your access was taken away"; it is distinct from `4403` (no access at join time).
- Revoking a session closes its sockets with `4401`. Disabling or removing a user, removing them from a team, unsharing a board or deleting a board closes the affected sockets with `4410`. A user's sockets for the board room and the comments room are treated alike.
- When a board room is saved, the relay copies the board title from the document (`doc.getMap('meta').get('name')`) into `boards.title` and bumps `updated_at`.
- The other way round: when the relay loads a board room whose document has no name, it sets the name from `boards.title` (unless that is the default "Untitled board"), so a board created with `POST /api/boards {title}` (outside the app) opens under that name. `PATCH /api/boards/:id {title}` also renames the document, loading the room if nobody has it open.

Open mode (`TABULA_AUTH=off`) skips all of this.

## Client

- On start, `GET /api/config`. Open mode: the current home screen and local board list, unchanged.
- Turning accounts on for an instance that already has boards: the old rooms have no directory rows, so they would get `4404`. Admins adopt them through `POST /api/boards`. Each browser's local list is not discarded: the home screen keeps an **On this device** section listing local boards that are not in the server list, with an **Add to workspace** action (optionally into a team).
- Accounts mode: `GET /api/me`. A `401` shows the sign-in screen (`#/signin`; `#/invite/<token>` shows the team name and asks for an email). After the emailed link the server redirects to `/`.
- Home screen: teams as sections, then **Personal** (boards you own that have no team) and **Shared with you** (everything else you can open: boards of teams you are not in and personal boards others shared with you; workspace admins see it as **Other boards**), each with its boards. Create a board in a team, create/rename/leave a team, invite link, member list, move a personal board into a team. The board list comes from `GET /api/boards` and is cached in `localStorage` for offline use.
- Board creation registers the board (`POST /api/boards`) before opening it.
- **Viewers are read-only in the UI**, not just at the relay (otherwise their edits would silently never sync and look like data loss). `GET /api/boards` returns `role`; for `viewer` the board opens read-only: `Store.transact` becomes a no-op (the single choke point for every write), drawing tools and the quick-action bar are disabled, text editing does not start, and a **View only** badge is shown. Remote updates still apply.
- The sync connection stops reconnecting on close codes `4401`, `4403`, `4404` and `4410` and the app shows a clear message: `4401` sign in again, `4403` no access, `4404` board not found, `4410` access removed. Local data is never deleted automatically: on `4410` the message offers a **Remove from this device** button.
- **Share dialog**: the board owner (workspace admins count as owners) sees **People with access**: the board's shares with a role menu (`POST /api/boards/:id/shares` upserts) and **Remove** (`DELETE`, click twice), and an add row. The picker offers the teams the person is in and the people in them (`GET /api/teams`, `GET /api/teams/:id/members`); workspace owners and admins also get every active member (`GET /api/members`). Yourself, the board owner and anyone already shared are left out. Other roles see the link only, because listing shares is owner-only.
- The board menu shows who is signed in and a **Sign out** item. With accounts on, the presence name defaults to the account name (the colour stays local).

## Server modules (internal contract)

All server code is plain ESM (`.mjs`), run directly by Node. Strict-TypeScript tests import these modules directly: `tsconfig.json` gets `"allowJs": true` (and no `checkJs`), so the imports resolve with types inferred from the JavaScript. Black-box tests (HTTP and WebSocket against a spawned server, like `test/relay.test.ts`) cover `api.mjs` and `relay.mjs`. `package.json` `engines.node` becomes `>=22.13` (node:sqlite without a flag) and the README says so.

```js
// server/config.mjs
export function loadConfig(env = process.env): {
  authEnabled: boolean, ownerEmail: string | null, baseUrl: string, origin: string, secureCookies: boolean,
  cookieName: string, sessionMs: number, loginTokenMs: number, dataDir: string, port: number,
  mail: { mode: 'log' | 'file' | 'webhook', webhookUrl: string | null, from: string },
}

// server/directory.mjs  (node:sqlite DatabaseSync; every method is synchronous; `now` is injectable for tests)
export function openDirectory(file: string /* ':memory:' allowed */): Directory
Directory {
  close(): void
  // users
  createUser({email, name?, role}): User                       // name defaults to the email local part
  getUser(id): User | null;  getUserByEmail(email): User | null
  listUsers(): User[];  updateUser(id, {name?, role?, disabled?}): User;  removeUser(id): void   // removeUser cascades memberships, sessions
  // login tokens (hashed at rest)
  createLoginToken({email, inviteId?, ttlMs, now?}): string                  // plaintext token, shown once
  consumeLoginToken(token, now?): {email, inviteId: string | null} | null    // single use
  // sessions
  createSession(userId, {ttlMs, now?}): {id, token, expiresAt}
  getSession(token, now?): {id, user: User, expiresAt} | null                // null if revoked/expired/disabled user; slides expiry
  revokeSession(id): void;  revokeUserSessions(userId): number
  // teams
  createTeam({name, creatorId}): Team                                       // creator becomes team admin
  getTeam(id): Team | null;  listTeamsFor(userId): TeamWithRole[];  listAllTeams(): TeamWithRole[]
  updateTeam(id, {name?, archived?}): Team
  addTeamMember(teamId, userId, role): void;  removeTeamMember(teamId, userId): void
  setTeamRole(teamId, userId, role): void;  getTeamRole(teamId, userId): 'admin' | 'member' | null
  listTeamMembers(teamId): {userId, name, email, role}[];  countTeamAdmins(teamId): number
  // invites (hashed at rest)
  createInvite({teamId, role, createdBy, ttlMs, maxUses?, now?}): {id, token, expiresAt}
  findInvite(token, now?): Invite | null                                    // null if revoked, expired or used up
  recordInviteUse(id): void;  listInvites(teamId): Invite[];  revokeInvite(id): void
  // boards
  createBoard({id, title, ownerId, teamId?}): Board;  getBoard(id): Board | null   // includes soft-deleted rows
  listBoardsFor(user: User): BoardWithRole[]                                // honours the role rules; excludes soft-deleted
  updateBoard(id, {title?, teamId?}): Board;  deleteBoard(id): void;  touchBoard(id, {title?}): void
  boardRole(boardId, userId): 'owner' | 'editor' | 'commenter' | 'viewer' | null          // THE role-resolution function (rules in "Roles")
  shareBoard(boardId, {principalType, principalId, role}): void;  unshareBoard(boardId, principalType, principalId): void
  listShares(boardId): Share[]
  // audit
  audit(actorId: string | null, action: string, detail?: object): void;  listAudit(limit?: number): AuditRow[]
}

// server/mailer.mjs
export function createMailer(config): { send({to, subject, text}): Promise<void> }

// server/auth.mjs
export function createAuth({directory, config, mailer, now = Date.now}): {
  requestLogin({email, invite?, ip}): Promise<{ok: true} | {limited: true}>     // never reveals whether the address is known
  verifyLogin(token): {user, sessionToken, maxAgeMs} | null
  authenticate(cookieHeader: string | undefined): {user, sessionId} | null
  sessionCookie(token, maxAgeMs): string;  clearCookie(): string
  logout(sessionId): void;  logoutAll(userId): number
  csrfOk(req): boolean                                                        // method, x-tabula (or deprecated x-mira) header, Origin vs host
}

// server/api.mjs
export function createApi({directory, auth, config, roomExists, events, liveStats?}): { handle(req, res): Promise<boolean> }
//   roomExists(boardId): boolean   (is there a room file on disk, for the board or its comments room)
//   events: { emit(name, payload) } with names 'session-revoked' {userId, sessionId?}, 'access-changed' {userId?, boardId?}, 'user-removed' {userId}
```

`relay.mjs` wires these together: it builds config, directory, mailer, auth and api when `authEnabled`, calls `api.handle` before static serving, and subscribes to `events` to close sockets.

## Not in this slice

Passkeys and two-factor, SSO (Dex), the admin dashboard UI beyond team and member management, email-bound invites, SMTP delivery (use the webhook mailer), encrypted device storage, the AI gateway, and everything Cloud-only.
