# Agent presence, labels and the activity log (TAB-158)

People should always see what an agent is doing and did. Slice 1, the server half (`server/activity.mjs`), is below; presence (a cursor and a participant entry for an agent), the "Drafted by" badge and the Activity panel come in the next slices.

## The activity log

Every MCP tool call that changes a board adds one entry to that board's log. An entry is: an id, the time, the agent ("Claude for Ada": the access token's name and the first name of the member whose token it is), the tool, a one-line summary by kind and count (`created 6 sticky notes; changed 2 frames`), the counts and the ids of up to 50 objects. It never holds text a person wrote, so the log is safe to show to anyone who can see the board. The workspace audit log keeps its own row for the call (tool, member, token, ids, no content), as before.

The log is bounded: 200 entries or 7 days a board, 4 MiB a board file. It is a file per board (`<data dir>/activity/<boardId>.json`), written atomically.

### How a call is captured

`roomAccess.write` (`server/relay.mjs`) snapshots the board's objects before and after an MCP board write (`snapshotObjects`, `diffObjects`); several writes of one call are composed (`composeDiffs`: the first before and the last after of each object). The diff is turned into the entry and into the data to revert it: the objects the call made (as they were left), the objects it removed (as they were), and the fields it changed (before and after). That revert data is at most 256 KiB an entry (a bigger call is logged and can not be reverted) and stays on the server: it is never sent to a client, and it is dropped when the entry is reverted.

## Routes (accounts mode)

- `GET /api/boards/:id/activity`: the log, newest first. Anyone who can see the board.
- `POST /api/boards/:id/activity/:entryId/revert`: takes one call back. Owners and editors only, decided when the revert is made from the person's role on the board then (never from who made the entry). It runs as one board transaction with its own origin (`activity-revert:<entryId>`), writes the audit row `board.activity.revert`, and answers `{ applied, skipped: [{ id, reason }] }`. Once only (409 afterwards).

### What a revert does

- An object the call made is removed if nobody has touched it since.
- An object the call removed is put back if its id is free.
- A field the call changed goes back if it still holds what the call wrote.
- Anything a person changed since is left as it is and reported (`changed`, `partly changed`, `exists`, `gone`).
- Every object it would write is first checked with the validator that live writes get (`validateBoardObject`); one that fails is left out (`invalid`).
- Objects linked to the tracker (`ext`, `trackerId`, `tracker` fields) are left to the tracker's own rules (`linked`).
