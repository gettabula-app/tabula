# Agent presence, labels and the activity log (TAB-158)

People should always see what an agent is doing and did. Slice 1, the server half (`server/activity.mjs`), is below; presence (a cursor and a participant entry for an agent), the "Drafted by" badge and the Activity panel come in the next slices.

## The activity log

Every MCP tool call that changes a board adds one entry to that board's log. An entry is: an id, the time, the agent ("Claude for Ada": the access token's name and the first name of the member whose token it is), the tool, a one-line summary by kind and count (`created 6 sticky notes; changed 2 frames`), the counts and the ids of up to 50 objects. It never holds text a person wrote, so the log is safe to show to anyone who can see the board. The workspace audit log keeps its own row for the call (tool, member, token, ids, no content), as before.

The agent is two fields, never one string: the token's name (chosen by the member who made the token, so a panel shows it as quoted, secondary text) and the member's own first name (from the directory), so a token named "Admin approved" cannot pass for a person. The log is bounded: 200 entries or 7 days a board, 4 MiB a board file, and the revert data is kept 48 hours (the line stays 7 days; an older entry says it is too old to revert). It is a file per board (`<data dir>/activity/<boardId>.json`, folder mode 0700, files 0600), written a moment after the call, atomically and off the call (a burst is one write; shutdown flushes), and at most 32 boards' logs are held in memory. A note kept private until the board is revealed is counted but its id is not listed.

The log goes with what it describes: the sweep (at start and daily) deletes the file of a board that is deleted or gone, and removing a person from the workspace removes every entry made with their tokens, revert data included. A backup restore can bring back old revert data; a revert only writes what an object still holds as the call left it, so stale data does nothing.

### How a call is captured

`roomAccess.write` (`server/relay.mjs`) snapshots the board's objects before and after an MCP board write (`snapshotObjects`, `diffObjects`) when the board has at most 1,500 objects; a bigger board is not snapshotted (too costly on the shared event loop; measured for 1,500 objects of about 250 bytes, snapshot before and after plus the diff: median 4 ms, worst of 60 runs 20 ms on a loaded development machine) and the call is logged by the ids it touched (`watchTouched`) with no revert data (`reason: too_large`); several writes of one call are composed (`composeDiffs`: the first before and the last after of each object). The diff is turned into the entry and into the data to revert it: the objects the call made (as they were left), the objects it removed (as they were), and the fields it changed (before and after). That revert data is at most 256 KiB an entry (a bigger call is logged and can not be reverted) and stays on the server: it is never sent to a client, and it is dropped when the entry is reverted.

## Routes (accounts mode)

- `GET /api/boards/:id/activity`: the log, newest first. Anyone who can see the board.
- `POST /api/boards/:id/activity/:entryId/revert`: takes one call back. Owners and editors only, decided when the revert is made from the person's role on the board then (never from who made the entry). It runs as one board transaction with its own origin (`activity-revert:<entryId>`), writes the audit row `board.activity.revert`, and answers `{ applied, skipped: [{ id, reason }] }`. Once only (409 afterwards).

### What a revert does

- An object the call made is removed if nobody has touched it since.
- An object the call removed is put back if its id is free.
- A field the call changed goes back if it still holds what the call wrote.
- Anything a person changed since is left as it is and reported (`changed`, `partly changed`, `exists`, `gone`).
- An object something else still points at (a connector end, a child) is not removed (`in use`).
- Every object it would write is first checked with the validator that live writes get (`validateBoardObject`); one that fails is left out (`invalid`).
- Nothing the tracker guards is written, in either direction: an object with a tracker field, a tracker frame, or revert data that names such a field is left alone (`linked`), so a revert can never link a card again that a call unlinked.
- When nothing at all could be applied the entry stays revertible, so the person can sort out what is in the way and try again.

## Presence (agents at work)

An MCP call that changes a board makes its agent show as at work for 30 seconds (`AGENT_PRESENCE_MS`, at most 10 minutes even when the test knob `TABULA_TEST_AGENT_PRESENCE_MS` is set): `Room.setAgent` (`server/relay.mjs`) puts `{ agents: [{ id, token, member, x, y }] }` into the room's own awareness state. `id` is a 12-character hash of the token's id (never the token id); `x, y` is the middle of what the call changed (`diffCenter`), leaving out notes kept private until the board is revealed.

- **Only the relay writes it.** `stripRelayFields` (`server/awareness-guard.mjs`) removes an `agents` field from every state a client sends, in every path; and the relay's own awareness client id is reserved: a client update for that id is ignored (it could otherwise erase the agent for everyone).
- **Who sees what.** People in the workspace see who the agent works for, its token name and where it works. A join-code guest sees only that an agent is at work (`{ token: 'Agent', member: null, x: null, y: null }`): `Room.awarenessMessage` redacts the relay's entry for guest sockets, on every update and on joining.
- **In the app.** `BoardApp.agents()` reads the field as untrusted text (names cleaned and cut, ids and positions checked) and shows a cursor in the room ("Ada's agent" with the token name quoted after it, gliding to where the agent works) and an avatar with the spark in the people list that goes there when pressed. The member comes first and the token name is quoted and apart, because a member names their own tokens.
- **Drafts.** Objects an MCP `create_objects` call makes carry `proposedBy: { feature: 'agent', by: { id, name } }` (the name is the member's first name; the token name is not stored). The app marks them with a dashed outline and an "Agent draft" label until a person edits one (any edit through the store removes the field) or presses Accept draft in the properties panel (one undo step). The properties panel says "Drafted by an agent for Ada".
- **Activity panel.** "Agent activity" in the board menu (workspace boards only) lists the log (`GET /api/boards/:id/activity`) and, for editors, Revert (`POST .../revert`), saying in words what a revert left because it had been changed since.

Tests: `test/agent-activity.test.ts` (log, revert, presence, expiry, forging, reserved id, guest redaction), `test/awareness-guard.test.ts`, `test/agent-presence-browser.test.ts` (drafts, cursor, avatar, the panel).
