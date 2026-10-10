# Tracker REST API

The session API exposes the workspace tracker under `/api/tracker/`. It is available only in accounts mode when `TABULA_TRACKER=on`. The directory migration can exist while the feature is off, but the HTTP routes then behave exactly like unknown routes and return `404`.

Every request needs a signed-in session cookie; mutating requests also need the `x-tabula: 1` CSRF header (reads follow the rest of `/api`). Guests and board-only users receive `404` for every tracker route so the API does not reveal whether a ticket exists. Disabled accounts are rejected by the session layer. `GET /api/me` includes `tracker: true` only for an account that can access the tracker while the feature is on; guests and board-only users get no `tracker` key, and the routes answer `404` to them.

Ticket writes use the current user as the actor and are audited with record IDs only. A hosted workspace in read-only mode keeps all reads available; every tracker mutation returns `403 {"error":"read_only"}` before writing. Mutations are limited to 60 per user per minute and return `429` with `Retry-After` when the limit is reached.

## Routes

### `GET /api/tracker/meta`

Returns the tracker metadata visible to the signed-in user:

```json
{
  "enabled": true,
  "trackerId": "trk_default",
  "prefix": "TAB",
  "states": [{ "id": "st_todo", "key": "todo", "name": "To do", "category": "unstarted", "position": 0 }],
  "labels": [{ "id": "label-id", "name": "Bug", "color": "#D02020" }],
  "members": [{ "userId": "user-id", "name": "Ada Lovelace", "initials": "AL" }],
  "projects": [{ "id": "project-id", "name": "Payments", "state": "started" }],
  "milestones": [{ "id": "milestone-id", "name": "Launch", "projectId": "project-id", "due": "2026-11-01" }],
  "views": [{ "id": "view-id", "name": "My open work", "shared": false, "mine": true }],
  "me": { "userId": "user-id", "canWrite": true, "canCreate": true }
}
```

Members are active workspace owners, admins, and members. This endpoint never returns email addresses. `projects` and `milestones` contain active resources. `views` contains the caller's views and shared views. `canWrite` and `canCreate` are false in hosted read-only mode.

### `GET /api/tracker/tickets`

List tickets with repeated filter tokens, or search tickets when `q` is present:

```text
GET /api/tracker/tickets?filter=state:started&filter=assignee:me&limit=20&cursor=...
GET /api/tracker/tickets?q=payment&filter=label:Bug&limit=20
```

The filter grammar is shared with MCP: `assignee`, `state`, `label`, `due`, `has:link`, `is:archived`, and `created` filters. The response is `{ "tickets": [...], "nextCursor": string|null }`. Search tickets include the `<mark>` snippet returned by the search command. Pages contain at most 50 tickets.

For polling changes instead of browsing pages, use `updatedSince`:

```text
GET /api/tracker/tickets?updatedSince=123
```

This returns `{ "tickets": [...], "seq": 456 }`, ordered by `updatedSeq` oldest first. At most 200 tickets are returned; `more: true` means another page is available. Continue with the last returned ticket's `updatedSeq`. `seq` is the highest ticket `updatedSeq` currently stored.

### `POST /api/tracker/tickets`

Creates a ticket and returns `201 { "ticket": ... }`.

```json
{
  "title": "Review payment retries",
  "description": "Document retry behavior.",
  "state": "todo",
  "priority": "high",
  "assignee": "me",
  "labels": ["Bug"],
  "due": "2026-11-01",
  "parent": "TAB-12",
  "idempotencyKey": "payment-retry-2026"
}
```

`idempotencyKey` is required and must be 8–64 characters. `assignee` accepts `"me"`, an active member name, or an email. This user-session API also accepts `assigneeId` for an active workspace member; send one assignee field only. `due` is a calendar date. Labels replace the set when updating.

### `GET /api/tracker/tickets/:key`

Reads a ticket by case-insensitive key or ticket alias. The response is `{ "ticket": ..., "comments": [...], "events": [...], "subscribed": boolean }`. Alias lookup adds `resolvedKey` with the canonical ticket key. The initial comments and events contain up to the latest 50 items in oldest-first display order. A comment has `edited`, `deleted`, and `actorType` (`user`, `agent`, `integration`, `import`, or `system`). Deleted comments remain as tombstones with `deleted: true` and no `body`.

### `GET /api/tracker/tickets/:key/comments` and `GET /api/tracker/tickets/:key/events`

Read older comments or events using `before` and an optional `limit` from 1 to 100. `before` is the ID of an item already seen. Responses are `{ "comments": [...], "nextBefore": string|null }` or `{ "events": [...], "nextBefore": string|null }`. Pages are returned oldest first; pass `nextBefore` to continue farther back.

### `PATCH /api/tracker/tickets/:key`

Updates ticket fields and returns `{ "ticket": ... }`. Supported fields are `title`, `description`, `state`, `priority`, `assignee`, `assigneeId`, `labels`, `due`, `parent`, `project`, `milestone`, `archived`, and `ifUpdatedSeq`. `assigneeId` must identify an active workspace member; `project` and `milestone` accept active names or `null`. `ifUpdatedSeq` is an optional optimistic concurrency check. A stale update returns `409` with `{ "error": "conflict", "ticket": <current ticket> }`. Set `archived` to `true` to archive or `false` to restore.

`POST /api/tracker/tickets/:key/archive` and `POST /api/tracker/tickets/:key/restore` are aliases for setting `archived` to `true` or `false` through `PATCH`.

### `POST /api/tracker/tickets/bulk`

Applies a patch to up to 50 tickets. Each ticket is updated in its own transaction, so a failure for one key does not roll back the others. The request counts as one mutation for the per-user limiter. Duplicate keys are rejected. Bulk updates do not accept `ifUpdatedSeq`.

```json
{
  "keys": ["TAB-12", "TAB-13"],
  "patch": { "state": "done", "priority": "high", "labelsAdd": ["Bug"], "due": "2026-11-01" }
}
```

The patch accepts `state`, `priority`, `assignee` or `assigneeId`, `labels` (replace), `labelsAdd`, `labelsRemove`, `project`, `milestone`, `due`, and `archived`. Label names are matched case-insensitively; removing a name that is not present has no effect. The response is `{ "batchId": string, "results": [...] }`. Each success contains `{ key, ok: true, ticket, before }`; `before` contains only the previous values for fields that changed, in forms accepted by `PATCH /tickets/:key`. Each failure contains `{ key, ok: false, error: { error, message, path? } }`. Every changed ticket has one update event whose details include the `batchId`.

### Labels

`GET /api/tracker/labels` returns `{ "labels": [...] }`. `POST /api/tracker/labels` accepts `{ "name": string, "color"?: "#RRGGBB"|null }` and returns `201 { "label": ... }`.

### Relations

`POST /api/tracker/tickets/:key/relations` accepts `{ "relation": "blocks"|"blocked_by"|"relates_to"|"duplicates"|"duplicated_by", "otherKey": string }` and returns `{ "ticket": ... }`. `DELETE` on the same path removes the relation and returns the updated ticket. Its `relation` and `otherKey` can be supplied in a JSON body or query string. A blocks cycle returns `409` with the current ticket.

### Projects and milestones

`GET /api/tracker/projects` returns active projects with `ticketCount` and `doneCount`; `?archived=1` includes archived projects. `POST /api/tracker/projects` accepts `name`, optional `description`, optional `state`, and optional `ownerId`, which must be an active workspace member ID or `"me"`; it returns `201 { "project": ... }`. Project responses include the command resource fields, `owner: { userId, name }|null`, `ticketCount`, and `doneCount`. Ticket counts include archived tickets.

`GET /api/tracker/projects/:id` reads a project. `PATCH /api/tracker/projects/:id` accepts `name`, `description`, `state`, `ownerId`, and `archived`, then returns `{ "project": ... }`.

`GET /api/tracker/projects/:id/milestones` returns active milestones with `ticketCount` and `doneCount`. `POST` on that path accepts `name`, optional `description`, required calendar date `due`, and optional `state`, returning `201 { "milestone": ... }`. `PATCH /api/tracker/milestones/:id` accepts `name`, `description`, nullable `due`, `state`, and `archived`, returning `{ "milestone": ... }`. Milestone responses include the command resource fields plus `ticketCount` and `doneCount`. Ticket counts include archived tickets; `doneCount` counts tickets whose state category is completed or canceled.

### Saved views

`GET /api/tracker/views` returns the caller's own and shared views. Each view includes the command fields, `owner: { userId, name }`, `ownerName`, and `mine`.

`POST /api/tracker/views` accepts `{ "name": string, "filter": string[], "shared"?: boolean }` and returns `201 { "view": ... }`. `PATCH /api/tracker/views/:id` accepts optional `name`, `filter`, and `shared`; only the owner can update a view. `DELETE /api/tracker/views/:id` is owner-only and returns `204`.

`GET /api/tracker/views/:id/tickets?limit=&cursor=` runs the saved filter with the requesting session's ticket access and returns `{ "tickets": [...], "nextCursor": string|null, "view": ... }`.

### Comment edits and deletion

`PATCH /api/tracker/tickets/:key/comments/:id` accepts `{ "body": string }`. Only the comment author can edit; the response is `{ "comment": ..., "ticket": ... }`. The event records the comment ID and new body length, not the body.

`DELETE /api/tracker/tickets/:key/comments/:id` soft-deletes a comment and returns `{ "comment": ..., "ticket": ... }`. The author or a workspace owner/admin can delete it. Deleted comments are returned as tombstones without a `body`, are excluded from comment counts, and are removed from ticket search text. The event records only the comment ID.

### Ticket row extras

Ticket objects in list, detail, and mutation responses include `commentCount` (non-deleted comments), `subIssueCount` (all children, including archived children), `subIssueDone` (children completed or canceled), `blocked` (an active blocks relation points to this ticket), and `prs` (`null` until pull request data is available).

### `POST /api/tracker/tickets/:key/transition`

Moves a ticket to an active state by name or key:

```json
{ "state": "Done" }
```

Returns `{ "ticket": ... }`.

### `POST /api/tracker/tickets/:key/comments`

Adds a comment and returns `201 { "comment": ..., "ticket": ... }`:

```json
{ "body": "The retry path is covered.", "clientId": "comment-client-17" }
```

`clientId` is optional and makes retries idempotent when supplied.

### `PUT /api/tracker/tickets/:key/subscription` and `DELETE /api/tracker/tickets/:key/subscription`

Subscribe or unsubscribe the signed-in user. Both return `{ "subscribed": boolean }`. They are idempotent and do not add ticket activity events.

### `GET /api/tracker/feed?since=<seq>`

Returns `{ "events": [...], "seq": number }`, with at most 200 readable events ordered by ascending event ID. Each event contains `id`, `ticketKey`, `eventType`, `at`, and `actor: {type, id, name}`. If `since` is missing or zero, the response has no events and `seq` is the current maximum event ID; save that value before polling.

## Errors and polling

Tracker errors are JSON objects with `error`, `message`, and an optional `path`. Status codes are:

| Status | Error code | Meaning |
| --- | --- | --- |
| 400 | `invalid_input`, `invalid_filter` | Invalid field, cursor, query, or filter token |
| 401 | `unauthenticated` | Missing or expired session |
| 403 | `forbidden`, `read_only`, `csrf` | Access denied, hosted workspace is read-only, or CSRF check failed |
| 404 | `not_found` | Ticket missing or not visible to the actor |
| 409 | `conflict` | Ticket changed since the supplied sequence or the requested operation conflicts with its current state |
| 413 | `limit_exceeded` | A documented query or page limit was exceeded |
| 429 | `rate_limited` | Per-user mutation limit reached; retry after the `Retry-After` header |

For a full ticket page, use `filter` and `cursor`. For incremental synchronization, persist `seq`, request `updatedSince=<seq>`, and when `more` is true advance from the last ticket returned. For activity, bootstrap with `/feed` and no `since`; when a page contains 200 events, request again from the last returned event ID. For shorter pages, continue from `seq`. Keep the ticket and event cursors separately.
