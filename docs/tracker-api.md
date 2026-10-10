# Tracker REST API

The session API exposes the workspace tracker under `/api/tracker/`. It is available only in accounts mode when `TABULA_TRACKER=on`. The directory migration can exist while the feature is off, but the HTTP routes then behave exactly like unknown routes and return `404`.

Every request needs a signed-in session cookie; mutating requests also need the `x-tabula: 1` CSRF header (reads follow the rest of `/api`). Guests and board-only users receive `404` for every tracker route so the API does not reveal whether a ticket exists. Disabled accounts are rejected by the session layer. `GET /api/me` includes `tracker: true` while the feature is on (it is also what tells the app to offer the tracker board object); whether the account may use the routes is decided by the routes themselves, which answer `404` to anyone without tracker access.

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
  "me": { "userId": "user-id", "canWrite": true }
}
```

Members are active workspace owners, admins, and members. This endpoint never returns email addresses.

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

Reads a ticket by case-insensitive key or ticket alias. The response is `{ "ticket": ..., "comments": [...], "events": [...], "subscribed": boolean }`. Alias lookup adds `resolvedKey` with the canonical ticket key. The initial comments and events contain up to the latest 50 items in oldest-first display order.

### `GET /api/tracker/tickets/:key/comments` and `GET /api/tracker/tickets/:key/events`

Read older comments or events using `before` and an optional `limit` from 1 to 100. `before` is the ID of an item already seen. Responses are `{ "comments": [...], "nextBefore": string|null }` or `{ "events": [...], "nextBefore": string|null }`. Pages are returned oldest first; pass `nextBefore` to continue farther back.

### `PATCH /api/tracker/tickets/:key`

Updates ticket fields and returns `{ "ticket": ... }`. Supported fields are `title`, `description`, `priority`, `assignee`, `assigneeId`, `labels`, `due`, `parent`, `archived`, and `ifUpdatedSeq`. `assigneeId` follows the create rules above. `ifUpdatedSeq` is an optional optimistic concurrency check. A stale update returns `409` with `{ "error": "conflict", "ticket": <current ticket> }`. Set `archived` to `true` to archive or `false` to restore.

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
