# Comments

Threaded comments pinned to a place on a board or to an object. They work offline, sync live, and have their own permission level so a stakeholder can comment on a board without being able to edit it.

## Storage: a sibling document per board

Comments do NOT live in the board's Yjs document. Each board has a second document, the **comments document**, synced in its own room:

- Board room: `<boardId>` (as today). Comments room: `<boardId>~comments` (the `~` cannot occur in a board id, so names never collide). The relay accepts room names matching `^[A-Za-z0-9_-]{1,64}(~comments)?$`; the room file on disk is `<DATA_DIR>/<room>.yjs`.
- In the browser the comments document is persisted in IndexedDB under `driftboard:<boardId>~comments` and synced with its own `WebsocketProvider` on `/sync/<boardId>~comments`.
- Why: the relay decides who may write a room, not what a write touches. With a separate document, `commenter` can write the comments room and only read the board room.

## Roles

Board roles, highest first: `owner` (3 + workspace owners/admins), `editor`, `commenter`, `viewer`. Team members are `editor`s of their team's boards (unchanged). Shares may now grant `editor`, `commenter` or `viewer`.

| Role | Board room | Comments room |
| --- | --- | --- |
| owner, editor | read and write | read and write |
| commenter | read only | read and write |
| viewer | read only | read only |

Open mode (accounts off): everyone may read and write both rooms, as today.

Relay rule per connection: the room kind (board or comments) and the user's board role decide whether sync step 2 / update messages are dropped (the existing viewer filter); awareness always passes. Role changes are re-resolved like today (`4410` when access is removed, applied to both rooms).

## Data model (the comments document)

One top-level `Y.Map` named `threads`: `threadId -> Y.Map` with fields

```
id, createdAt, authorId, authorName, authorColor      // set once
text        // the first message
editedAt?   // set when the text is edited
anchor      // { x, y, obj?, fx?, fy? } (JSON object)
resolved    // boolean (own field, so resolving never overwrites a concurrent reply)
resolvedBy?, resolvedAt?
replies     // Y.Map: replyId -> { id, authorId, authorName, authorColor, text, createdAt, editedAt? } (one entry per reply)
```

Each reply is its own map entry and `resolved` is its own field, so two people replying or resolving at once merge without losing anything. Ids are `newId()` from `src/store.ts`. The comments document is never part of the board's `UndoManager`, so Ctrl+Z never touches comments.

### Anchors

`{ x, y }` is the absolute world position at creation, always present (fallback). When the pin was placed on an object: `obj` (its id) plus `fx`, `fy`: the position as a fraction of the object's width and height in the object's own (unrotated) frame. The pin's world position is `rotate(origin + (fx*w, fy*h), center, rotation)` of the object as it is NOW, so the pin stays attached through moving, resizing and rotating; if the object no longer exists the pin stays at `{x, y}`.

### Authorship

`authorId` is the account id in accounts mode (`me.user.id`), otherwise the device's local user id; `authorName`/`authorColor` come from the presence identity at the time. Authorship is asserted by the client (the relay does not check it): good enough for "delete your own comment", not a security boundary. The UI lets a person delete or edit their own threads and replies, and only the board owner deletes anyone else's. An author cannot delete their own thread while other people have replied to it (that would delete their comments too). The data layer enforces this on the local client; like authorship it is not a server-side guarantee.

## Behaviour

- **Visibility**: pins are drawn in the board overlay (never in PNG/SVG exports). A pin on an object that private writing hides (`flow.isHidden`) is hidden too and its thread cannot be opened, so comments cannot leak hidden notes.
- **Tool**: a Comment tool (`C`) in the toolbar. Click the canvas or an object to place a pin and open the composer; the thread is created only when the first message is posted (Enter posts, Shift+Enter inserts a newline, Escape cancels).
- **Thread popover**: messages in order with author, relative time and an edit/delete menu for your own, a reply box, **Resolve** / **Reopen**. Resolved threads are drawn faded.
- **Comments panel**: a list of all threads (Open / Resolved filter, newest first); picking one flies to its pin and opens it. A toggle in the board menu shows or hides pins (remembered on this device).
- **Hit priority**: clicking a pin opens its thread (even over a locked object and even when the board is read-only); it never starts a drag.
- **Input isolation**: typing in the composer or reply box never triggers tool shortcuts, Delete or nudging.
- **Who can comment**: the Comment tool and composers are enabled for roles that may write the comments room; for viewers the tool is disabled and threads are readable. Commenters get a read-only board (the board's `Store` read-only mode) with a writable comments document.

## Export and import

- `.drift` files (zip) include the comments document state as `comments.yjs` when there is any; opening a `.drift` file restores it. The JSON snapshot gets optional `comments` (an array of thread objects with their replies) which import restores. PNG, SVG, Mermaid and Markdown exports never contain comments or pins.

## Not in this slice

Mentions and notifications, emoji reactions, attachments, comment search, and enforcing authorship on the server.
