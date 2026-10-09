# Admin dashboard

A workspace-level console for owners and admins of an accounts-mode instance (`TABULA_AUTH=on`). It answers: who is here, what do they have, who is signed in, and what changed. Route `#/admin`, reachable from the home screen and the board menu for workspace `owner` and `admin` only (members and guests never see the link, and the API refuses them).

First slice. Not in it: usage analytics over time, billing, SSO, per-board activity feeds, bulk actions, CSV export.

## Access

All endpoints below sit under `/api/admin/` and require a signed-in user whose workspace role is `owner` or `admin`; otherwise `403 forbidden` (`401` when signed out). They follow the existing API rules (JSON, CSRF header on mutating calls, `404` in open mode, every mutation writes an `audit` row). Role rules that already exist stay: only an owner may act on an owner; the last owner cannot be demoted, disabled or removed.

## Endpoints

```
GET  /api/admin/overview
  -> { members: {total, active, disabled, byRole: {owner,admin,member,guest}},
       teams: {total, archived}, boards: {total, deleted},
       sessions: {active}, signIns7d: number,
       live: {rooms, connections},
       instance: {authEnabled: true, baseUrl, mail: 'log'|'file'|'webhook'|'smtp', version} }

GET  /api/admin/members
  -> [{id, email, name, role, disabled, createdAt, lastSeenAt: number|null,
       activeSessions: number, boardCount: number, teams: [{id, name, role}]}]
  (boardCount = boards the person owns, not deleted. lastSeenAt = latest `sessions.last_seen`.)
  Role changes, disable/enable and removal keep using PATCH/DELETE /api/members/:id.

POST /api/admin/members/:id/revoke-sessions   -> 204
  Revokes every session of that person and closes their open sync sockets (the same effect as disabling, without disabling). Allowed on yourself.

GET  /api/admin/sessions
  -> [{id, userId, userName, email, createdAt, lastSeen, expiresAt, userAgent: string|null, current: boolean}]   (non-revoked, non-expired, newest `lastSeen` first)
DELETE /api/admin/sessions/:id   -> 204
  Revokes that one session and closes that person's open sync sockets (they reconnect and are checked again; a person with another valid session stays in). 404 for an unknown or already revoked id.

GET  /api/admin/boards?deleted=1
  -> [{id, title, ownerId, ownerName, teamId, teamName, createdAt, updatedAt, deletedAt: number|null, shareCount}]
  (`deleted=1` includes soft-deleted boards; default excludes them. Sorted by `updatedAt` desc.)
GET  /api/admin/boards/:id   -> 200 board   (one board, deleted or not; 404 unknown. The app uses it to open a deleted board read-only)
POST /api/admin/boards/:id/restore   -> 200 board   (clears `deleted_at`; 404 unknown, 409 when not deleted)
  Deleting uses the existing DELETE /api/boards/:id (soft delete).

GET  /api/admin/audit?limit=50&before=<id>&action=<prefix>
  -> { entries: [{id, ts, actorId, actorName, actorEmail, action, detail}], next: number|null }
  (`limit` 1..200, default 50; `before` pages by `id` descending; `action` matches by prefix, e.g. `board.` or `member.update`; `next` is the id to pass as `before`, null at the end. `actorName`/`actorEmail` are null for system rows or deleted users.)
```

Backups (workspace **owner** only, not admins; the **Backups** tab): `GET /api/admin/backups` (the list and the engine's status), `GET /api/admin/backups/:name`, `GET /api/admin/backups/:name/boards` (the boards inside one backup), `POST /api/admin/backups/restore-board` and `POST /api/admin/backups/restore` list the backups, preview one, list its boards, restore one board as a copy and restore the whole workspace. They follow the same API rules (CSRF header on the POSTs, an audit row for each call), answer `409 backups_off` when backups are not set up, and are described in [backups.md](backups.md#restoring).

Teams: the dashboard uses the existing `GET /api/teams` (workspace admins already see every team, including archived) and `PATCH /api/teams/:id {archived}`.

## Client

New module `src/ui/admin.ts` (+ `admin.css`), route `{ name: 'admin' }` for `#/admin`, client functions and types in `src/api.ts`:

```ts
export interface AdminOverview { /* shape above */ }
export interface AdminMember { id; email; name; role: UserRole; disabled: boolean; createdAt: number; lastSeenAt: number | null; activeSessions: number; boardCount: number; teams: { id: string; name: string; role: TeamRole }[] }
export interface AdminSession { id; userId; userName; email; createdAt; lastSeen; expiresAt; userAgent: string | null; current: boolean }
export interface AdminBoard { id; title; ownerId; ownerName; teamId: string | null; teamName: string | null; createdAt; updatedAt; deletedAt: number | null; shareCount: number }
export interface AuditEntry { id: number; ts: number; actorId: string | null; actorName: string | null; actorEmail: string | null; action: string; detail: Record<string, unknown> }
```

Layout (Swiss, symmetric padding, theme variables only, no new colours): a full-page screen with a top bar (back to home, "Admin", signed-in person) and a left tab list: **Overview**, **Members**, **Teams**, **Boards**, **Sessions**, **Access tokens** (when AI tool access is on), **AI**, **Backups** (owners only) and **Audit log**. The selected tab is part of the hash (`#/admin/members`), so reload and back work.

- **Overview**: stat tiles (members by role, disabled members, teams, boards, active sessions, sign-ins in 7 days, live connections; members, teams and boards count everything, with the disabled, archived or deleted part on the line under the number) and an instance card (base URL, mail mode, version).
- **Members**: searchable table (name, email, role select, last seen, active sessions, boards, teams). Row actions: change role, disable/enable, sign out everywhere, remove (second-click confirmation, like comment delete). The controls the server would refuse (acting on an owner as a non-owner, the last owner) are disabled with a title explaining why.
- **Teams**: all teams (name, members, archived badge) with archive/unarchive.
- **Boards**: searchable table with a "Show deleted" toggle; open, delete (confirm), restore.
- **Sessions**: table with revoke per row; the current session is marked and its revoke button is labelled "Sign out".
- **Backups** (owners only, listed for every owner also when backups are off): the state of the backup engine, the list of backups, one backup in detail, a board restored as a copy, the whole workspace restored, and the screen that waits for the server to come back. `src/ui/backups.ts` (+ `backups-logic.ts`, `backups.css`), the restoring screen in `src/ui/restoring.ts`. See [backups.md](backups.md#in-the-app).
- **Audit log**: newest first, action filter (All, Members, Teams, Boards, Templates, Invites, Sign-ins, Sessions: revoked sessions and sign-outs everywhere, AI, Images, Backups: the automatic runs and what owners looked at, Restores: restores, board copies and the removal of old data; the filter is one literal prefix, so the two have a chip each), "Load more" using `next`. Each entry reads as a sentence (for example "ana@example.com changed owner@… to admin") built from `action` and `detail`, with the raw action as a tooltip; unknown actions fall back to the raw action string.

All lists show an empty state and an error state with Retry. Mutations update the row in place and toast the outcome. Non-admins who open `#/admin` are sent home.

## Tests

Server: access control (member, guest, signed-out, open mode), every endpoint's shape, revoke-sessions and single-session revoke actually invalidate the cookie and close sockets, restore rules, audit paging and prefix filter, last-owner rule through the existing endpoints. Client: route parsing, the audit sentence builder, the controls' disabled rules (pure functions, unit tested).
