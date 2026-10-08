# Comment authorship on the server

Status: built for TAB-24 (accounts mode). The rules as shipped are in [comments.md](comments.md). This page keeps the reasoning, the measured cost and the decisions (the last section); where the build differs from the proposal below, the decisions say so.

## The problem

The relay decides who may write a room, not what a write does. A writer of a comments room (`owner`, `editor` or `commenter`; see [comments.md](comments.md)) sends Yjs updates that `Room.onMessage` applies as they are (`syncProtocol.readSyncMessage`). So `authorId` is whatever the client writes. The rules ("edit and delete your own", "the board owner deletes anyone's", "not your own thread once others have replied") exist only in `src/comments.ts`. A modified client, or a script holding a valid session, can post as someone else, rewrite other people's comments and delete any thread.

Scope: **accounts mode only.** In open mode there is no identity to check against: the author id is a device id the client picks.

## Options

| Option | Guarantee | Offline | Cost |
| --- | --- | --- | --- |
| A. **Check and correct on the relay**: apply the update, inspect what it changed in `threads`, and undo what the sender was not allowed to do with a second update | Every client's end state follows the rules | Unchanged | Small, server only |
| B. Reject the update (drop it, or close the socket) | Same, if it works | Breaks: see below | Small server, large client |
| C. Comments become read-only rooms; writes go through `POST /api/boards/:id/comments…` and the relay applies them | Strongest, simplest to reason about | Lost, or an outbox and optimistic UI in the client | Large: new API and a client rewrite of the data layer |
| D. One comments room per author | Authorship by construction | Unchanged | Moderation and "others replied" rules span rooms; many rooms per board |

**Why not B.** A Yjs update cannot be refused after the fact. The sender has already applied it locally and keeps it, in IndexedDB too. Its next updates depend on it, so the relay would hold them as pending structs forever, and that client would diverge from everyone else. Rejecting only works if the client then throws away its local comments document, which also loses its other offline comments.

**Why A.** A correcting update is an ordinary CRDT change, so every client, including the sender, converges on the corrected state, with nothing to reset. It touches only the relay and only comments rooms.

## Recommended design (A)

For a comments room in accounts mode, the relay keeps a plain JSON mirror of each thread (`threadId -> thread.toJSON()`) next to the `Y.Doc`. For each sync step 2 or update message from a writer:

1. Apply the update in a transaction with the socket as origin. `threads.observeDeep` records which thread ids it touched.
2. Compare each touched thread with its mirror entry, using the sender's account id and board role (`ws.userId`, `ws.role`; *moderator* = board role `owner`, which already includes workspace owners and admins):
   - **New thread or reply**: `authorId` must be the sender. Otherwise the relay rewrites `authorId` and `authorName` to the sender's account. Proposed: the relay always stamps `authorName` from the account, so nobody can post under another name either.
   - **Edit** (`text`, `editedAt` of a thread or a reply): only its author. Otherwise restore both from the mirror.
   - **Set-once fields** (`id`, `createdAt`, `author*`, `anchor`): changes are restored. Exception: a moderator may move an anchor (to be decided).
   - **Resolve or reopen**: any writer, as today. `resolvedBy` must be the sender, otherwise it is rewritten.
   - **Delete a reply**: its author or a moderator. **Delete a thread**: a moderator, or its author while no one else has replied. Otherwise the relay re-creates it from the mirror, as a new `Y.Map` under the same key.
   - **Anything outside `threads`** (other top-level types, non-map values): cleared.
3. Apply the corrections in a second transaction (origin `authz`), then refresh the mirror for the touched ids.
4. Broadcast **one** merged update (`Y.mergeUpdates` of both). Other clients never see the forbidden state, even briefly. Today `doc.on('update')` broadcasts each update at once, so comments rooms need to buffer the broadcast during step 1–3.

Board rooms are not affected and cost nothing extra.

### Cost

- **Latency**, measured with the repo's Yjs: apply, find the touched threads, correct a forged edit from the mirror and merge the result took **0.10 ms** per update with 100 threads, **0.14 ms** with 500 and **0.26 ms** with 2,000. Clients converged every time.
- **Memory**: the mirror is about the size of the comments as JSON, roughly 0.9 KB per thread with 4 replies (460 KB for 500 threads), held only while the room is loaded.
- **Measured in the build**: median 0.04 ms, mean 0.05 ms and 95th percentile 0.09 ms per update in a room of 500 threads, forbidden updates (undone) included. `test/comment-authz.test.ts` fails if the median reaches 1 ms.
- **Complexity**: `server/comment-authz.mjs`, called from `Room.onMessage` for comments rooms. Tests: `test/comment-authz.test.ts` (each rule, offline batches checked at sync time, concurrent edits and convergence, cost) and `test/comment-authz-relay.test.ts` (the same rules over sockets, with notices and merged broadcasts). The client changed only for the notice, the import marks and the UI rules (decisions 3 to 6).
- **Risk**: a re-created thread is a new Yjs item. If someone's reply landed in the original thread's `replies` *after* the forbidden delete reached the relay, that reply is lost with the deleted original. It's rare, and only possible after a forbidden action. The same goes for an edit: a correction writes the old value again, so an author's edit to the same field, sent at the same moment as a forbidden edit, can lose the race. Every client still converges, and the forbidden text never wins.
- **Not covered**: writes made through MCP (`docs/mcp.md`) reach the room through the relay's own write path and do not go through the guard. Open mode has no guard.

### Offline edits

Offline work arrives as one sync step 2 batch on reconnect and is checked like any update, against the account and role **at sync time, not at edit time**. This has three effects:

- Someone whose role was lowered while they were offline gets their moderator deletes undone.
- Edits made offline under a different account in the same browser are attributed to, or undone for, the account that syncs them. Both docs share one IndexedDB key per board.
- An author who deletes their thread offline while someone else replies online gets the thread back, with that reply.

The client says when its own change was undone (decision 5).

### History (TAB-13) and import

- Version history snapshots only the board room, never the comments room. Board restores are ordinary board edits and pass through no comment checks. A restore can remove an object that a pin is attached to; the pin falls back to its `{x, y}`, as today.
- If comment history is added later, a restore would touch other people's threads, and these checks would undo it. Such a restore should run on the relay with a trusted origin, like the snapshot code, not as a client edit.
- Imports (`.drift` and JSON) keep their authors and are marked `imported` (decision 3).

## Decisions

The owner's six questions, as decided and built:

1. **Moderators.** A moderator is a board role `owner`: the board owner, workspace owners and admins, and team admins of the board's team (`boardRole` already maps them to `owner`). Moderators delete anything but edit only their own words.
2. **Author names.** The relay stamps `authorId` and `authorName` from the account on every new comment and reply, and clients cannot set them. A later rename reaches new comments only, as before. Author fields never change afterwards, and neither does an anchor (a moderator cannot move someone's pin either).
3. **Imports.** Imported comments and their replies keep their authors and carry `imported` and `importedBy`. Only the board owner's imports are honoured: a `.drift` or JSON file opens as a new board its importer owns, so any other import is re-attributed to the sender. The proposal allowed owners and editors; owner alone is tighter and costs nothing. Nobody edits imported comments; the importer and moderators delete them.
4. **Existing comments.** A comment whose author is a device id (from before accounts) is marked `legacy` when the room loads. Nobody edits it; moderators delete it. A removed member keeps an account id, so their comments are not marked. A device-id comment that an offline client syncs later is a new comment: it is attributed to the account that syncs it, with a notice.
5. **Telling the user.** The relay sends message type 5 (`{ undone: [...] }`) only to the socket whose change it undid, and the app shows one sentence per kind as a toast. The kinds: `edit`, `delete`, `resolve`, `author` (the author, name or resolver was rewritten), `other` (a write outside the comments or a value that is not a comment). Type 5 and not 4, because 4 is the workspace hint.
6. **Resolving.** The comment's author, or anyone who may edit the board (board owner or editor). Other commenters cannot resolve; the app hides the button from them.
