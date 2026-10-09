# Containers and kanban

TAB-134. Status: slices 1 and 2 are built (see the notes at the end); the rest is the spec.

A kanban board is a set of columns with cards in them, and the interesting part is not drawing columns. It is that the cards **belong** to a column, have an **order** inside it, and move between columns without anyone computing coordinates. Tabula has nothing like that today: every object has its own `x` and `y`, and the only grouping is a frame, which is a rectangle that happens to contain things. Three other planned features need the same missing piece: tables (TAB-121), grids (TAB-122) and swimlanes and timelines (TAB-142).

So this page does two jobs. First it specifies a **container model**: how an object can own an ordered list of children, how their positions follow from the list, and how several people can move things in it at once without losing any. Then it specifies **kanban** as the first container built on it, with task cards, labels, owners, due dates, WIP limits, filters, conversion between stickies and cards, templates, CSV export, MCP and AI access, and a phone layout. The model is the expensive part; it is written so that the other three features are small additions to it, and [The other containers](#the-other-containers) shows how.

The central decision, in one paragraph: **a container's children are placed by a pure layout function from their order, never by stored coordinates.** A card in a column stores which column it is in (`parent`) and a fractional `rank` among its neighbours. Where it is drawn comes from running the container's layout over those facts, on every client, with the same result. Dragging does not write positions; it shows a ghost and writes one `parent` and `rank` pair when you drop. That makes moves one small write, makes moving a whole board cost one write instead of one per card, and makes two people moving cards at once a merge of small independent facts instead of a fight over coordinates.

## Summary

- **A new generic object type `container`**, with a `layout` (`kanban` now; `table`, `grid` and `timeline` later). Its direct children are **lanes** (type `lane`: a kanban column), and a lane's children are **cards** (type `card`). The tree is at most three levels deep and a container sits on the board or in a frame, never inside another container.
- **Membership is `parent`, order is `rank`.** `rank` is a fractional-indexing key (the package the board already uses for `z`), unique per parent with ties broken by id. A move writes `parent` and `rank` in one transaction, which is one undo step.
- **Geometry is derived.** One pure module computes every child's rectangle, and the container's own size, from the container, its lanes and its cards. The renderer, hit testing, connectors, export, the MCP reader and the AI reader all call it. Children's stored `x`, `y`, `w`, `h` are not read.
- **Moves are safe because they are small.** Two people dropping different cards touch different objects. Two people dropping the same card is last writer wins on that card. Two people inserting at the same spot get equal ranks, which sort by id and are repaired on the next drop. A card whose lane was deleted under it is shown in the first lane, not lost. [Concurrent edits](#concurrent-edits) lists every case.
- **Kanban**: lanes you add, rename, reorder, colour, give a **stage** (to do, doing, done) and a **WIP limit**; cards with a title, description, **owner**, **due date** and **labels**. Status is the lane. Labels come from a board-wide set (TAB-107; the repository has no trace of it, so this page defines what it needs and the question list asks Johan to confirm).
- **Sticky and card convert both ways** in place, keeping the object id, so comments, connectors, votes and history survive. Dropping a sticky on a lane turns it into a card.
- **Filters** by owner, label, due date and text are personal and dim the cards that do not match; they never change the layout, so nobody drops a card at an index the others do not see.
- **WIP limits** warn by default and can block drops on the client. They cannot be enforced against two people dropping at the same moment, and the page says so.
- **Phone**: the board is still a canvas, and a container opens in a **list sheet** with lane tabs, a card list and a **Move to** menu. The sheet is DOM, so it is also the keyboard and screen reader route to cards.
- **CSV export** of cards (one row per card, formula-safe). Cards also appear in SVG, PNG, JSON, `.drift` and the Markdown summary with no extra work beyond the layout call.
- **MCP**: reads show the structure; new tools add and move cards; `create_objects` stays as it is.
- **Later, not now**: a Linear or Jira link. The model leaves room for it and [Linear and Jira later](#linear-and-jira-later) says how.

## Decisions and why

1. **One generic `container` type, not one type per feature.** Every new object type touches the same seven lists (the type union, both template whitelists, the render dispatch, the properties panel lists, the editor, the Mermaid exporter, the MCP summariser). Four features would do that four times. A `container` with a `layout` field does it once, and a new layout is a function plus a registry entry.
2. **Derived geometry, not stored coordinates.** Frames store coordinates and move their children by rewriting every child's `x` and `y` while you drag. For a column of cards that is the wrong shape of data: inserting a card in the middle means rewriting everything below it, concurrently, from several machines that each believe a different height. Deriving positions from order removes the whole class. It also makes a container cheap to move (one write) and to resize.
3. **A rank per child, not an array on the parent.** An array of child ids on the lane is one value: two people adding cards at once overwrite each other, and a card moved while the array is rewritten can vanish from both lists. A `rank` on each card is a field of its own object, which merges. The cost is that order is recovered by sorting (cheap at these sizes) and that equal ranks can happen, which the tie-break and the repair handle.
4. **Do not write while dragging.** Today a move writes every frame, merged into one write per animation frame, and the undo manager splits a long drag into several steps when you pause more than 350 ms. A card drag instead draws a **ghost** in the renderer's overlay, with the insertion line, and writes once on release. One drag, one transaction, one undo step, nothing for other people to flicker on. (Optionally the ghost is shared; see [Seeing others drag](#seeing-others-drag).)
5. **Status is the lane.** A separate `status` field on a card would have to agree with its lane, and it would not, the first time two people moved it. The lane has a `stage` (to do, doing, done) for the things that need a meaning (done styling, overdue, the CSV, a Linear or Jira mapping).
6. **Labels are board data, not per-card strings.** A label has a name and a colour and is shared, so renaming "Bug" renames it everywhere. Cards hold label ids.
7. **Filters dim, they do not hide.** The layout is shared state. A hiding filter would make each person's column a different height and their drop index different from the one written. Dimming keeps one layout. A "hide the rest" toggle is a v2 that maps indexes explicitly.
8. **Server rules are role rules, as for every other object.** The relay accepts Yjs updates from editors without looking inside them (`server/relay.mjs:325-336`), and the container model keeps to that: nothing here needs the server to arbitrate a move. The honest consequence is that WIP limits and "only owners may move their card" cannot be server-enforced.
9. **Shared code goes in a new `shared/` folder.** The client is TypeScript through Vite and the server is plain `.mjs`; today the two share no source (the server carries its own copy of the object type list and its own use of `fractional-indexing`). The layout and rank code must give the same answer on both, because the MCP reader and the AI reader report positions. It is written once as `shared/containers.mjs` with JSDoc types and a `.d.ts`, imported by both sides, and a test pins its outputs. The Dockerfile copies the folder.

## The container model

### Object types

| Type | Role | Parent | Children |
|---|---|---|---|
| `container` | The board-level object; has a `layout` | none or a frame | lanes |
| `lane` | A column (kanban), later a row, a cell, a band | a container | cards |
| `card` | A task | a lane, or none (a loose card) | none |

New fields, flat on the object as everything else is, so concurrent edits to different fields merge:

| Field | On | Meaning |
|---|---|---|
| `layout` | container | `'kanban'` now. Unknown values draw as a plain rectangle with the name and a "needs a newer Tabula" note and are never edited. |
| `name` | container, lane | The title, edited with the frame name editor. |
| `rank` | lane, card | Fractional key, see below. |
| `laneW` | container | Lane width, default 280, 200 to 480. |
| `stage` | lane | `'todo' \| 'doing' \| 'done'`, optional. |
| `wip`, `wipMode` | lane | A limit (1 to 99) and `'warn'` (default) or `'block'`. |
| `fill` | lane, card | Existing style field. Lane tint, card accent. |
| `text` | card | The title (first line is shown; at most 200 characters). |
| `desc` | card | Description, plain text, at most 4,000 characters. |
| `ownerId`, `ownerName` | card | See [Owners](#owners). |
| `due` | card | `YYYY-MM-DD`, a date with no time zone. |
| `labels` | card | Array of label ids, at most 10. |

`parent` already exists on `BaseObj` (`src/types.ts:73`) and keeps its meaning: "belongs to". `ObjType` gains `'container' | 'lane' | 'card'`. `childrenOf` (`src/store.ts:206`) is a linear scan of the cache today; containers add an index (parent id to child ids) kept in the same observer that maintains the connector index, because the layout asks for the children of every lane on every change.

Board labels live in a new top-level map, `labels`, next to `votes` and `polls`: `Y.Map<Label>` keyed by label id, each value `{ id, name, color, order }`, whole-value per label as polls are. `color` is a **palette key** (eight named swatches), not a hex value, so the chips follow the theme (the house rule is that new colours use CSS variables). At most 30 labels, names at most 40 characters.

### Ranks

`rank` is a key from `fractional-indexing`, as `z` is. Two things differ from `z`.

- **It orders within one parent.** `z` is a global paint order and frames always sort first (`src/store.ts:139-149`); `rank` is local. A card keeps its rank when its parent changes only if the key still fits between the neighbours it lands between, so a move computes a new key every time: `generateKeyBetween(prev.rank, next.rank)` for the neighbours at the drop index.
- **It carries its parent.** The stored value is `<key>@<parentId>`. A card's `parent` and `rank` are two keys of one map, and Yjs resolves concurrent writes per key, so two people moving the same card to different lanes at the same instant could leave the `parent` of one and the `rank` of the other. With the parent inside the rank, a reader knows when that happened (the suffix does not match `parent`), treats the card as last in its lane for display, and the next write to that lane repairs it. Ids use `[A-Za-z0-9_-]`, so `@` cannot occur in a key or an id.

The helpers, all pure and in `shared/containers.mjs`:

- `rankBetween(prev, next, parentId)` and `ranksBetween(prev, next, n, parentId)` (the batch form, for moving several cards at once).
- `sortedChildren(children)`: by key, then by id; children whose rank has the wrong or no suffix go last, by `updatedAt` then id.
- `normaliseRanks(children, parentId)`: fresh evenly spaced keys for all children of one parent, returned as patches. Called by the writer, in the same transaction, when it sees two adjacent equal keys or a bad suffix in the lane it is writing to. Lanes are at most 500 cards, so this is cheap and rare.

**A finding about the existing ordering code.** `bringToFront` and `sendToBack` (`src/app.ts:1359-1370`) assign each selected object `store.topZ()` or `store.bottomZ()` inside one transaction. Yjs updates the store's cache only when the transaction ends (`src/store.ts:72-95`), so every selected object reads the same maximum and gets the same key; the survey reproduced `b` and `c` both receiving `a4`. Relative order among the selected objects then falls to the id tie-break. This is separate from kanban but the same primitive (`generateNKeysBetween` with a `bottomZs` counterpart fixes it, as `insertObjects` already does), and it is raised as its own issue. Container moves use the batch form from the start.

### Layout

`layoutContainer(container, lanes, cards, ctx)` returns a map from id to rectangle, plus the container's own size. It is a pure function of stored fields. It never measures text: a card's height is its stored `h` (set by the editor when the text changes, as stickies do), so two clients with different font loading still agree.

Kanban constants (CSS pixels at zoom 1): lane width `laneW` (280), gap between lanes 16, padding 12, lane header 48, gap between cards 8, minimum lane body 160. Lanes run left to right by rank. Cards stack top to bottom by rank, each as wide as the lane body. The container is as wide as its lanes and as tall as its tallest lane plus an empty drop zone of one card. A card taller than the stored default grows its lane; nothing scrolls inside a lane in v1 (the canvas is the scroll).

**Where derived geometry is applied.** The store keeps `cache` as the raw documents. A second index, rebuilt per container only when one of its descendants changes (the observer already reports the changed ids; the container of each is found through `parent`), holds the laid-out rectangle of every child. `Store.geometry(o)` returns the derived rectangle for a laid-out object and the stored one for anything else, and the code paths that read `o.x`, `o.y`, `o.w`, `o.h` for hit testing, culling, selection bounds, connectors, guides and export go through it. The list of those call sites is part of slice 1 and is checked by a test that moves a container and asserts that its card's hit box moved.

**Stored `x`, `y`, `w`, `h` of laid-out children are set once at creation and then ignored.** They are not maintained when a container moves, because writing them would be the per-child rewrite this design avoids. Everything that needs a position of a laid-out object calls the layout: the renderer, the exporters (`toJson` runs it), and on the server `board-ops.mjs` through the shared module. A document read by an older client shows containers as unknown objects (below); it does not show stale positions of cards, because it does not draw them.

**Paint order.** `ordered()` today sorts frames first and everything else by `z`. A container is painted as a unit at its own `z`: the container, then its lanes by rank, then each lane's cards by rank, contiguous. Children's own `z` is unused. A loose card (no lane) is an ordinary box with a `z`.

**Version skew.** Old clients do not know the new types. They must not corrupt them: the Y.Map round-trips, the renderer's default case draws nothing, and `update()` only writes the keys it is given. A board that contains a container needs the new client to be usable, so the first container written also sets `meta.features` to include `containers`, and a client that does not know the feature shows a banner ("This board uses features from a newer Tabula. Reload to update.") and opens read-only. This is the only place the model touches the shared board metadata.

### Hit testing, selection and dropping

- A click on a card selects the card; a click on a lane header or empty lane body selects the lane; the container's border or title selects the container. Double-click opens the editor that fits (card dialog, lane name, container name).
- The existing `frameAt` (`src/app.ts:362-369`) returns the topmost frame whose body contains a point. A generalised `dropTargetAt(point, moving)` returns `{ kind: 'frame' | 'lane', id, index }`: containers win over frames, a lane's index comes from comparing the pointer's y with the laid-out card midpoints, and moving cards never target themselves. The reparent step on drop (`reparent`, `src/app.ts:1073-1083`) learns to call it for stickies and cards; frames keep their rule.
- **Selecting several cards** and dragging moves them as a group into one lane, in their current order, with `ranksBetween`. Cards from different lanes join the target lane in container order (lane rank, then card rank).
- **Moving a container** writes only the container's `x` and `y` (and its `parent` if dropped into a frame). The recursion in `beginMove` that collects children (`src/app.ts:657-674`) skips laid-out descendants.
- Lock: `locked` on a card blocks moving it, as for every object. `locked` on a container blocks moving it and structural edits (add, remove, reorder lanes) but not moving cards, because that is the point of the board; cards can be locked one by one.

### Concurrent edits

| Situation | Result |
|---|---|
| Two people drop different cards | Independent objects, both land. |
| Two people drop the same card in different lanes | Last writer wins per key; `rank`'s parent suffix reveals a mix, the card shows last in the lane `parent` names and is repaired by the next write there. Nothing is lost; the card is in one lane. |
| Two people insert into the same gap | Equal keys. Order is by id, identical everywhere. The next drop into that lane sees the equal pair and normalises the lane. |
| A lane is deleted while another person drops a card into it | The delete removed the lane object; the card's `parent` points at nothing. Layout puts every such card at the end of the container's **first lane**, ordered by rank and id. The next write to that lane gives them a valid `parent`. |
| A lane is deleted by the UI | The deleting client first moves the lane's cards to the lane on its left (or right if first), at the end, and then removes the lane, in one transaction. Choosing **Delete lane and its cards** removes both. Either is one undo step. |
| Two people reorder lanes | Per-lane `rank`; same repair as for cards. |
| Rename a lane while it is deleted | Update of a missing map is ignored (`Store.update` returns when the object is gone). |
| Edit a card while it is moved | Different keys; both apply. |
| Convert to sticky while another edits `desc` | `type` and `desc` are different keys; both apply and the description is kept on the object. |

**What the model cannot promise:** a global count. WIP limits are computed by each client from what it can see; two people who each drop the fourth card into a three-card limit at the same moment both succeed.

### Undo, history and comments

- A move, a lane delete with relocation, a conversion and an add are each **one `transact`**, so one undo step. Undo restores `parent` and `rank`; if someone else moved the card since, undo overwrites their move as it does for any field today.
- Version history (`planRestore`, `src/history.ts:114`) works on whole objects keyed by id: restoring a card restores its `parent` and `rank` with it, and a lane that no longer exists is covered by the orphan rule. No special case.
- Comment threads anchor to an object id and a fraction of its box (`src/comments.ts:323-342`). The pin follows the card because the anchor lookup goes through `Store.geometry`. Deleting a card leaves its thread at its last absolute position today (`src/app.ts:1249-1276` does not touch comments); that existing behaviour is noted in the open questions because a kanban board will delete cards far more often than a whiteboard does.

### Connectors

Connectors bind to object ids and read anchors through the box, so a connector to a card follows it when the card moves lanes (it reads `Store.geometry`). Connectors are allowed between cards and from a card to anything else. They are not drawn inside the lane; they cross it. Their ends are not part of the card's order.

### Performance

- Layout is recomputed for **one container**, only when one of its descendants or itself changed, and cached until the next change. A kanban of 500 cards is a few hundred rectangles; sorting and summing is microseconds. The cost that matters is the DOM, and the renderer already culls to the viewport plus 200 px and re-renders only dirty elements (`src/render.ts:391-426`). Cards in a container outside the view are not in the DOM.
- A move invalidates the old and new lanes and the container's size. Dragging causes no store writes, so nothing re-renders but the overlay.
- Limits: 50 containers per board, 20 lanes per container, 500 cards per lane, 2,000 cards per board. They are checked on create (client and MCP) and reported in a message, not enforced by the relay.

## Kanban

### Making one

- **Toolbar**: a Kanban tool in the shapes drawer. Click or drag on the board to place a container with three lanes, **To do**, **Doing**, **Done** (stages set), 280 px wide, and one empty card in the first lane in edit mode.
- **Templates**: Kanban, Sprint board (Backlog, Sprint, In review, Done with WIP 3 on In review), Bug triage, Personal tasks. See [Templates](#templates).
- **From selection**: with stickies selected, **Make kanban from selection** creates a container whose first lane holds the stickies as cards in reading order (top to bottom, left to right), and leaves the other lanes empty.
- **Menu**: no new menu entry; the tool and the quick-action bar cover it.

### Lanes

- A lane header shows the name, the card count (and `count / limit` with a limit), a colour tint, and a **⋯** menu: **Rename**, **Colour**, **Stage**, **WIP limit**, **Move left / right**, **Delete lane**. Adding a lane is a **+** at the right of the last header and writes a lane with `rank` after the last one.
- Dragging a header reorders lanes with the same ghost mechanism as cards; it writes the lane's `rank` on release.
- **Stage** is optional. `done` draws the lane's cards with a check mark in place of their due date's alarm colour, `doing` and `todo` change nothing visually, and all three are exported (CSV, MCP).

### Cards

A card shows its title (up to three lines), label chips (colour and, in the wide size, the name), an owner badge (initials in the person's colour), a due chip, and a comment count where there are comments. It is a card, not a sticky: a hairline border, square corners, the surface colour of the theme, an accent edge from `fill`.

- **Add a card**: **+ Add card** at the bottom of each lane (types the title in place; Enter adds it and starts the next, Esc stops), or double-click empty lane space.
- **Open a card**: double-click, Enter with it selected, or the **Open** button of the quick-action bar. A dialog (a bottom sheet on a phone) has the title, description, owner, due date and labels, and a **Turn into sticky** button. Fields save as you leave them; there is no Save button, as in the rest of the app. All of its inputs are real inputs, so typing never triggers a board shortcut (the app's typing check already includes `SELECT`, `src/app.ts`).
- **Keyboard on the canvas**: with a card selected, `Alt+Up` and `Alt+Down` move it within its lane, `Alt+Left` and `Alt+Right` to the neighbouring lane (to the same index when possible, else the end), announced in a visually hidden live region ("Moved to Doing, position 2 of 5"). The same verbs are in the list sheet.

### Owners

One owner per card in v1.

- **Accounts mode**: `ownerId` is the user id, and `ownerName` the name at the time it was set, so a card still reads correctly after the person is removed or renamed (the badge uses the live name when the id is known). The picker lists people with access that the signed-in person can already see: themselves, the board's current participants, and everyone previously assigned on this board. It does not call the directory for the whole workspace, so a guest can assign nobody they could not already see. A plain free-text name is allowed too (`ownerName` without `ownerId`) for people who have no account.
- **Open mode**: there is no identity to trust; the owner is a name typed or picked from participants.
- The owner badge colour is the person's cursor colour when known, else a neutral.
- **My cards** in the filter bar uses `ownerId === me` in accounts mode and `ownerName === my display name` otherwise.

### Due dates

`due` is a calendar date (`YYYY-MM-DD`), picked with the native date input, which already gives a calendar on phones. It has no time and no time zone, so it means the same day for everybody. The chip says "Tomorrow", "Fri 12 Oct" or "3 days ago" and is **overdue** (a warning colour from the theme tokens) when the date is before today **and the lane's stage is not `done`**. "Today" is the viewer's local date; two people in different zones disagree about overdue by up to a day at midnight, which is accepted.

### Labels

Labels are the board-wide set in the `labels` map (TAB-107 is not in the repository; this is the smallest model that serves cards, and it is deliberately usable for other objects later by giving them the same `labels` field).

- Managed from the card dialog and a **Labels** dialog (create, rename, recolour, reorder, delete). Eight palette colours, each with a name so colour is never the only signal.
- A card's `labels` is an array of ids, replaced whole on change. Two people toggling different labels on one card at the same moment can lose one toggle (last writer wins on the array). It is rare and visible, and per-label keys would be heavier than the case deserves; the open questions ask.
- Deleting a label removes it from the map. Cards keep the dangling id and ignore it; the next edit of a card drops unknown ids. Restore from history brings the label back with the cards that reference it.

### Filters

A **Filter** button on the container's header (and on the list sheet) opens a small popover: **Mine**, label chips (any of), **Due** (overdue, today, this week, none), and a text box (title and description). Active filters show as removable chips. Matching cards draw at full strength, others at 35 % opacity and are not selectable by marquee. The filter is **personal and not saved in the board**: it lives in memory per container and in `localStorage` per board (`tabula:filter:<board>:<container>`, wrapped in try/catch as other local state is). Viewers filter too. Counts in lane headers always count all cards, so WIP and filtering do not interact.

### WIP limits

A lane may carry `wip` (1 to 99) and `wipMode`.

- **warn** (default): over the limit, the header shows `4 / 3` in the warning colour, with the text "Over the limit" in the title attribute and the live region. Dropping is allowed.
- **block**: a drop that would exceed the limit is refused on the client with a toast ("Doing is full: 3 of 3"). Moving a card within the lane, out of it, or when the lane is already over the limit because of someone else's drop, is allowed.
- Neither mode counts done lanes specially; a limit on a `done` lane is allowed and rarely useful.
- Neither mode is a guarantee. See [Concurrent edits](#concurrent-edits). The MCP and AI writers run the same check for **block** lanes and return an error, since they write from one place.

### Sticky to card and back

- **Turn into card** (quick-action bar, properties panel, and the shortcut `K`) on selected stickies. It changes `type` to `card` on the same object, so its id, comments, connectors, votes and history stay. `text` is split at the first line break into `text` (title) and `desc` (the rest); the sticky colour moves to `fill`; size, rotation and `privateStep` are dropped from use (a sticky hidden by private writing is converted only for its author, and a private note converted to a card becomes a normal card, since cards do not take part in private writing in v1). If a lane is under the pointer or selection the card goes there; otherwise it becomes a loose card.
- **Turn into sticky** is the reverse: `desc` is appended under the title with a blank line, `fill` becomes the sticky colour (nearest sticky colour if it is not one), and a card in a lane is placed where it was drawn (the derived rectangle is written into `x` and `y` as the sticky leaves the container) and its `parent` becomes the frame containing that point, if any.
- The card-only fields (`ownerId`, `ownerName`, `due`, `labels`, `desc`) stay on the object when it becomes a sticky, so converting back restores them. Sticky export, templates and the sticky editor ignore them. A template saved from stickies that were once cards drops them (the template whitelist does not know them).
- **Dropping** a sticky on a lane converts it; dropping a card on empty canvas leaves it a loose card (it does not silently become a sticky and lose its fields).
- Several at once is one transaction and one undo step.

### Seeing others drag

Optional in slice 2, not needed for correctness. A person who is dragging cards sets one awareness field, `drag: { ids, x, y }`, and other clients draw a faint ghost with the person's colour. It is awareness (ephemeral, no document writes), throttled as cursors are. It makes it obvious that someone is mid-move, which prevents most of the conflicts above in practice.

### Sessions and voting

Cards are ordinary boxes for the facilitation tools in these ways: **dot voting** places dots on cards like on stickies (`VOTABLE` in `src/flow.ts:11` accepts every box except frames and paths, so cards qualify with no change, but containers and lanes would too and the slice adds them to the exclusion); **private writing** is not extended to cards (a kanban is a work plan, not a brainstorm; open question); **session steps** can link to a container's frame the same as to a frame, but a container is not a frame, so the step editor lists containers too and flying to one uses its derived bounds; the **Markdown summary** lists each container as a heading, each lane as a sub-heading and its cards as bullets with owner and due date.

## Rendering

- `markup.ts` gets `containerMarkup`, `laneMarkup`, `cardMarkup`; the dispatch at `src/markup.ts:394-407` adds three cases. Chips and badges are plain SVG and `<text>`; text wrapping reuses the sticky text path. Colours come from CSS variables (tokens), so all five themes work; a test pins that no hex colour appears in the new markup (the existing `css-colors` test pattern).
- Frames do not clip their children today (`src/markup.ts:205-215`), and containers do not need to: a card never overflows its lane, because the lane grows.
- The lane header and **+ Add card** are SVG with hit targets 40 px high at zoom 1; below zoom 0.4 the card text is replaced by blocks (the same level-of-detail rule the renderer applies to long text) and the header by the name only.
- Reduced motion: cards snap to the new place, with no tween. Otherwise a 120 ms tween of the derived rectangle plays when the layout changes *because of someone else's change* or a drop; it never plays during local pointer drag, which uses the ghost.

## Phone and touch

- On a phone the canvas still shows the container, scaled, and a card can be dragged on it with a long press (600 ms, the existing `armLongPress` rule, `src/app.ts:520-531`). That is hard to do precisely at small scale, so the primary route is the sheet.
- **List sheet**: tapping a container's **Open** button, or double-tapping it, opens a full-screen sheet below the top bar. A tab strip of lanes with counts scrolls horizontally (a segmented control, active lane underlined), the lane's cards are a vertical list, each with a drag handle, a **⋯** menu with **Move to…** (lane picker, then position top or bottom), **Open**, **Turn into sticky**. **+ Add card** is a sticky bar at the bottom. Filters are a button in the header.
- The sheet is built from real buttons and lists with labels, so it is also the screen reader and keyboard route to everything the canvas does; moves announce through the live region. It follows the same breakpoint as the rest (`@media (max-width: 860px)`, `src/styles.css:489-505`); at 390 px the tab strip, the card rows and the add bar are checked in slice 5.
- The card dialog is a bottom sheet at that width (max height 85 vh, the title and a close button fixed). The native date input and a plain `<select>` for the owner keep the on-screen keyboard behaviour right.
- Pinch zoom and two-finger pan are unchanged and win over a ghost drag (the existing `isPinching` guards).

## Templates

- Four built-in templates (above) in `src/templates.ts` using the same structure as the others, each with a container, lanes and cards, plus a small `labels` list (Bug, Feature, Chore) that is merged by name into the board's label set on use.
- **Whitelists to extend**: `OBJ_TYPES` in `src/custom-templates.ts:168-173` (a `Record<ObjType, true>`, so the compiler lists what is missing), `OBJ_TYPES` in `server/board-ops.mjs:45-49` (which `server/templates.mjs:16` reuses), and the per-type field switch `box()` at `server/templates.mjs:277-316` for the fields above with their limits. Validation adds: a `lane` must have a `container` parent in the same template, a `card` a `lane` parent (or none), `rank` must be valid and carry its parent, label ids must be in the template's `labels`, counts within the limits, no `due`, `ownerId` or `ownerName` accepted (a template does not carry people or dates). The 2,000 object ceiling (`MAX_TEMPLATE_OBJECTS`) already bounds a template.
- **Saving a custom template** from a selection that includes a container strips `ownerId`, `ownerName` and `due` and keeps labels, so a shared template does not leak names or stale dates.
- **Instantiating** remaps ids as it does today (`instantiate`, `src/custom-templates.ts:153`); the rank suffixes are rewritten with the new parent ids; and the labels merge by name (an existing label with the same name wins).
- Template thumbnails (`src/template-thumb.ts`) render through `objectMarkup`, so they show the container, using the layout call.

## Export and import

- **SVG and PNG** draw the container, lanes and cards through `objectMarkup` with derived geometry (`exportSvg`, `src/exporters.ts:155`), including chips and badges. Dimmed (filtered) cards export at full strength: a filter is a view, not content.
- **JSON snapshot and `.drift`**: the objects and the `labels` map are included; the JSON export runs the layout and adds `x`, `y`, `w`, `h` to laid-out children in the exported copy only, so other tools can read positions. Importing a file runs `readBoardFile` (`src/exporters.ts:56`) as before; unknown future types survive the round trip.
- **Markdown summary**: containers and lanes as headings, cards as bullets with `(owner, due)` in parentheses; hidden private notes stay out as in the fixed TAB-139 summary.
- **Mermaid**: not extended; `toMermaid` (`src/mermaid.ts:352-392`) ignores the new types.
- **CSV** (new, **Export > Cards as CSV**, and **Export cards (CSV)** in the container's **⋯** menu): per container (or for the selected containers, or the whole board when none is selected). RFC 4180, UTF-8 with a byte order mark so Excel opens it correctly, `\r\n` line ends, one row per card, columns:

  `container, lane, stage, position, title, description, owner, due, labels, comments, created_by, updated_at, id`

  `position` is 1-based within the lane. `labels` is the names, joined with `; `. `updated_at` is ISO 8601 in UTC. **Formula safety:** any cell that starts with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe, which every spreadsheet shows as plain text; a test covers each. The exported filename is `<board>-<container>-cards.csv` with unsafe characters removed (the existing `safeName`).
- **CSV import** (rows to cards in a chosen lane, matching lanes by name and labels by name, creating missing ones) is useful for moving from other tools and is deliberately **not** in this spec's first slices; it needs its own size and character limits and a preview.

## MCP and the other AI tools

The current MCP surface is twelve tools (`server/mcp.mjs`), and `create_objects` accepts only `sticky`, `shape`, `text`, `frame` and `connector` (`mcp.mjs:95`). The board reader gives each object a short summary (`summarise`, `server/board-ops.mjs:191`).

- **Reads**: `get_board` and `get_objects` return containers, lanes and cards. Summaries add, for a card, `lane` (id and name), `position`, `stage`, `owner` (name only; `ownerId` is not returned, as the AI reader sends no author names today), `due` and `labels` (names). Positions come from the shared layout, so x and y are correct. All text (titles, descriptions, lane names, label names, owner names) is cleaned and fenced like every other board text, because a card description is an obvious place to plant instructions. `get_board` gains a `containerId` filter, as it has `frameId`.
- **New tools** (write token, editor role, the same checks as `update_objects`, one Yjs transaction each):
  - `create_kanban { name, lanes: [{ name, stage?, wip? }], x?, y? }`
  - `add_cards { laneId, cards: [{ title, description?, owner?, due?, labels?: [name] }], position?: 'top' | 'bottom' }` (up to 30 per call; labels are created if missing, within the limit)
  - `move_cards { cardIds, laneId, position?: 'top' | 'bottom' | { before: id } | { after: id } }`
  - `update_cards { cards: [{ id, title?, description?, owner?, due?, labels?, laneId? }] }`
  - These use `shared/containers.mjs`, so ranks and the WIP check match the browser. A `block` lane over its limit returns `wip_limit` with the lane and counts and writes nothing.
- `create_objects` is unchanged. `update_objects` can move a container, rename it and lock it; it cannot write `rank` or `parent` of laid-out children (those keys are not in `UPDATABLE` for the new types), so an agent cannot produce an inconsistent order by hand.
- **AI features** (TAB-97, `docs/ai.md`): *Summarise* and *Cluster* read the board through the same reader and see cards as text with their lane, so "summarise this board" can say what is in each column and what is overdue (dates are sent as dates; today's date is part of the fenced context). *Generate* (stickies from a prompt) is unchanged in v1; a later "generate cards into this lane" is a proposal of `add_cards` shape and the preview is the existing proposal UI. Owners are not sent to the model in v1 (the AI reader sends no names).
- Limits and the audit rows follow the existing MCP rules; new audit sentences are not needed (the board writes are not audited individually today).

## Linear and Jira later

Not built here, but the model must not make it hard.

- A card gains optional `extProvider` (`'linear' | 'jira'`), `extKey` (`TAB-134`) and `extUrl`, flat fields so they merge. They are reserved now (the template whitelist drops them; `update_objects` does not write them) and become writable when the integration exists.
- **Direction**: first, one way, from the tracker to the board: a workspace admin connects the tracker (OAuth, stored encrypted the way AI keys are, `docs/ai.md`), picks a project and a container, and the server creates and updates cards (title, status, owner, due) on a schedule or from a webhook, using the MCP write path with a service identity, so the audit log says who did it. Second, board to tracker for lane moves only, mapped by lane `stage` or by lane name.
- **Mapping** between tracker statuses and lanes is stored on the container (`ext: { provider, project, map }`), one value that an admin edits; it is not per card.
- **Conflicts**: the tracker is the source of truth for the fields it owns while linked. A local edit to a linked field is allowed, shown as "changed here" until pushed or overwritten.
- **Privacy**: the board holds `extKey` and `extUrl` only; tracker content that is not on the card is never copied.
- Reads for AI tools include the key and URL (not secrets) once present.

This needs its own spec (OAuth, rate limits, webhooks, the service identity); the point here is that the card id is stable, the structure is on the card, and status is the lane.

## Permissions

| Role | Can |
|---|---|
| Owner, editor | Everything: create containers, lanes, cards; move, edit, convert, delete; manage labels |
| Commenter | Read, filter, open the card dialog read-only, comment on cards. Cannot move or edit |
| Viewer | Read and filter |
| Hosted workspace read-only | Same as viewer for everyone; the sheet's edit actions are hidden |

- The client enforces this through the store's read-only flag, as every other write does (`transact` returns without writing when it is set, `src/store.ts:126-133`); drag ghosts do not start. The server enforces it as it does today: updates from non-writers are dropped (`canWriteRoom`, `server/relay.mjs:85-90`).
- There is **no per-object rule** on the server, and none is added: an editor can move any card, including one that has an owner, and can remove any lane. Features such as "only the owner may move this card" are out of scope; they need the server to inspect updates, which it does not do for board rooms.
- The card dialog is read-only for commenters but keeps the comment button. Labels management is an editor action.
- **Accounts mode, guests**: guests see the board they were given; the owner picker offers only people they can already see.
- **Open mode**: everyone with the link edits.

## Limits

| Thing | Limit |
|---|---|
| Containers per board | 50 |
| Lanes per container | 20 |
| Cards per lane / per board | 500 / 2,000 |
| Title / description | 200 / 4,000 characters |
| Labels per board / per card | 30 / 10 |
| Label name, lane name, container name | 40, 60, 80 characters |
| Lane width | 200 to 480 |
| WIP limit | 1 to 99 |

Over a limit, the client says so and does nothing; the MCP tools return an error naming the limit.

## Tests

Unit (no DOM, `test/containers.test.ts`, run against `shared/containers.mjs`):

- `rankBetween` and `ranksBetween`: ordering, the suffix, a thousand random inserts staying strictly ordered, equal ranks handled by `sortedChildren`, `normaliseRanks` output order preserved.
- `layoutContainer`: lane positions and widths, card stacking, the container size, an empty lane, an orphan card appearing at the end of the first lane, a card with a bad rank suffix going last, a lane deleted and its cards ending in the first lane, the same result from different input orders.
- Concurrency with two real `Y.Doc`s and a sync between them: two inserts into one gap, two moves of one card, delete-lane against drop-into-lane, convert against edit, lane reorder against lane reorder, asserting that after sync both docs lay out identically and no card is lost.
- WIP: warn and block, within-lane moves allowed, an over-limit lane not trapping its own cards.
- Filters: matching rules, dimming not changing layout.
- Conversion: sticky to card and back keeps id, text, description, fill and card fields; a private note's rule; several at once is one undo step.
- Due: overdue is computed from the lane stage; the chip text for today, tomorrow, last week; no time zone drift for a fixed date.
- CSV: columns, quoting of commas, quotes and newlines, the byte order mark, `\r\n`, formula guards for each of `=+-@`, tab and carriage return, the position numbering, a filename with unsafe characters.
- Templates: each new rule in the validator (a lane without a container, a card in a non-lane, a bad rank, a label not in the template, a `due` present), the stripping on save, the label merge on use.
- Store: the container index; `Store.geometry` for a moved container moving its cards' hit boxes; a card moved between lanes invalidating only two lanes; the observer cost with 2,000 cards under a budget.
- MCP and board-ops: the new tools, `containerId` filter, fenced text for every new text field, `block` lane refusal with nothing written, the limits, `update_objects` refusing `rank` and `parent`.
- Render: markup for a container has no hard-coded colours; reduced motion; zoom levels.
- UI logic (pure files, as `share-logic.ts`): the drop index from pointer y, the keyboard moves, the live region text, the filter popover state.
- Version skew: a document with a container opens in a client that lacks the feature as read-only with the banner; unknown `layout` draws the placeholder.

Browser (the Chrome checklist in the slice, not in CI): drag across lanes, reorder, the ghost and the insertion line, two windows moving cards at once, the phone sheet at 390 px, dark and light themes, reduced motion.

## Not in this slice

- Tables, grids, swimlanes and timelines (only the model they use).
- Nested containers, a kanban inside a lane, sub-tasks and checklists inside a card.
- Multiple owners, estimates and story points, priorities, custom fields, card templates, recurring tasks, reminders and notifications (due dates do not email anyone).
- Time tracking, burn-down charts and cumulative flow diagrams, though `updatedAt` and the history make a later version possible.
- CSV import, and Trello or Jira file import.
- Archived cards (**Delete** is the only removal; an **Archive lane** is an easy follow-up).
- Swim-lane rows inside a kanban (that is TAB-142's container).
- Private writing on cards, and hiding a card from some viewers.
- A shared, saved filter ("view").
- Real-time drag preview for everyone is optional (slice 2), and the "hide the rest" filter mode is v2.
- The Linear and Jira link.
- Cards as the target of the AI Generate feature.

## Slices

1. **The model and the store.** `shared/containers.mjs` and its `.d.ts` (ranks, sorting, normalising, layout, WIP check), the Dockerfile copy, the `ObjType` additions and all seven lists, `Store` child index and `Store.geometry`, the call sites that read geometry, paint order, version skew (`meta.features` and the banner), the `labels` map, tests. No UI. This slice also fixes `bringToFront` and `sendToBack` with batch keys, or that is a separate issue merged first.
2. **Drawing and moving.** Markup for container, lane and card; selection and hit testing; the ghost drag with `dropTargetAt`; one-transaction moves; the keyboard moves and live region; shared drag awareness (optional); undo behaviour. Creating through a tool with the three default lanes.
3. **Cards.** Card dialog, owner, due, labels and the Labels dialog, add-card inline, sticky to card and back, make-kanban-from-selection, the quick-action bar and properties panel entries, comments on cards.
4. **Lanes and discipline.** Lane menu (rename, colour, stage, move, delete with relocation), WIP warn and block, filters, the container menu.
5. **Phone sheet, templates and export.** The list sheet with **Move to…**, the four templates and the validator and whitelist changes, saving custom templates with stripping, CSV export, the Markdown summary, themes and reduced motion checks at 390 px.
6. **MCP, AI and docs.** The reader changes, `create_kanban`, `add_cards`, `move_cards`, `update_cards`, the `containerId` filter, `docs/mcp.md`, `docs/ai.md`, the user guide page and the CHANGELOG.

Slices 1 to 3 are a usable kanban; 4 and 5 are what makes it safe for a team; 6 lets agents work the board. The Linear and Jira link, tables, grids and timelines are separate specs on top of slice 1.

## Files

### New

- `shared/containers.mjs`, `shared/containers.d.ts` (ranks, sorting, layout, WIP, CSV helpers pure enough to share)
- `src/containers.ts` (client glue: drop target, ghost, keyboard moves), `src/labels.ts` (the `labels` map wrapper)
- `src/ui/kanban.ts`, `src/ui/kanban.css`, `src/ui/kanban-logic.ts` (pure), `src/ui/card-dialog.ts`, `src/ui/labels-dialog.ts`, `src/ui/container-sheet.ts` (phone list)
- `src/csv.ts` (client CSV writer, using the shared helpers)
- tests listed above

### Existing (touched)

- `src/types.ts` (types, fields), `src/store.ts` (index, geometry, `labels` map, undo tracking of `labels`), `src/markup.ts`, `src/render.ts` (paint order, overlay ghost), `src/app.ts` (`dropTargetAt`, `reparent`, `beginMove`, quick actions, conversion), `src/geometry.ts` (hit box via `Store.geometry`), `src/guides.ts` (reference rects), `src/editor.ts` (lane and container names, inline card add), `src/comments.ts` (anchor lookup), `src/flow.ts` (voting types, summary), `src/exporters.ts` (JSON layout, CSV entry), `src/ui/board.ts` (export menu), `src/ui/props.ts`, `src/ui/quickbar.ts`, `src/shortcuts.ts` (`K`), `src/templates.ts`, `src/custom-templates.ts`, `src/template-thumb.ts`, `src/history.ts` (labels in snapshots)
- `server/board-ops.mjs` (type lists, summariser, new write helpers), `server/mcp.mjs` (tools), `server/templates.mjs` (validator), `Dockerfile` (copy `shared/`)
- `docs/mcp.md`, `docs/ai.md`, `docs/custom-templates.md`, `docs/guide/` (a page when it ships), `CHANGELOG.md`

## The other containers

The model is designed so that each of these is a layout function, a lane or cell notion, and little else.

- **Table (TAB-121).** `layout: 'table'`. Rows are lanes (`rank` orders them); columns are a list on the container (`cols`, each `{ id, name, w }`, one value like labels). A cell is a `card`-like child of a row with a `col` field naming its column; the layout places a cell at (column x, row y), with row height from the tallest cell. Adding a row or a column writes one object or one container value; reordering rewrites ranks; sorting by a column is a local view.
- **Grid (TAB-122).** `layout: 'grid'`. Children keep a `cell` field (`col,row`) and a `rank` among those in one cell; the layout places them in the cell's rectangle. A grid is a table without headers and with free assignment of an item to a cell.
- **Swimlanes and timelines (TAB-142).** `layout: 'timeline'`. Lanes are horizontal bands (`rank`); a child's horizontal position comes from a `start` (and optional `end`) date on a time axis stored on the container (`from`, `to`, `scale`), and its row within the band from `rank`. Moving along the axis writes `start`, not `x`. A swimlane view of kanban is the same kanban container with a second axis (`laneBy: 'owner' | 'label'`) computed, not stored.
- What these will reuse unchanged: the `parent` and `rank` pair, the suffix repair, `sortedChildren`, the orphan rule, the ghost drag, `dropTargetAt`, derived geometry, the template and MCP lists, the phone sheet idea, and the CSV writer.

## Open questions for Johan

1. **TAB-107, labels.** The repository has no trace of it. Is a board-wide label set with names and eight palette colours (this spec) what you want, and should other objects (stickies, shapes) get the same `labels` field now or later?
2. **One owner or several?** One per card is drafted. People often want two. A second `ownerIds` array is easy to add; do you want it in v1?
3. **Who can be an owner in accounts mode?** Drafted: people the editor can already see on the board, plus free text. The alternative is everyone with access to the board, which needs a server call that guests may not make.
4. **Is "status is the lane" enough?** Drafted: yes, with an optional lane stage for done and overdue. Or do you want a separate status field that can differ from the lane?
5. **WIP limits cannot be enforced across two people dropping at once.** Is warn-by-default with an optional client-side block acceptable, or do you want a stronger promise (which means the server inspecting board updates, a large change)?
6. **Older clients.** A board with a container opens read-only with a banner in a client that predates it (drafted, via `meta.features`). Acceptable, or must it degrade to a plain frame?
7. **Hide or dim?** Filters dim in v1 so the layout stays shared. Is dimming enough to launch, or is "hide the rest" required?
8. **Private writing on cards** is not drafted. Does a retro-style kanban ("What went well", cards written privately then revealed) matter enough to extend `privateStep` to cards? The reveal path would need to cover lanes.
9. **Seeing others drag.** Include the shared ghost in slice 2 (drafted as optional), or leave it until people ask?
10. **Deleting a card with comments.** Existing behaviour leaves the thread pinned at a stale point. For a board that deletes cards often, should threads go with the card (hidden, restorable by undo) or stay as they are?
11. **Labels on a card use a whole-array write.** Two people toggling labels on one card at the same moment can lose one toggle. Accept, or use one key per label on the card?
12. **Keyboard shortcut `K`** for "Turn into card" is free today (`src/shortcuts.ts`); is it the right key?
13. **Limits** (2,000 cards per board, 500 per lane, 20 lanes) are drafted from the sizes the renderer and Yjs handle comfortably. Are they too low for your largest expected use?
14. **CSV for Excel.** The file starts with a byte order mark so Excel reads UTF-8; some tools dislike it. Offer a setting, or keep one format?
15. **Shared code folder.** `shared/` is new and the Docker image must copy it. Is that the right way to avoid two copies of the layout, or should the server call the client build?
16. **Linear and Jira.** Which first, and one way or two? And does the integration belong to the workspace admin (drafted) or to each person with their own token?
17. **Order of work.** The kanban slices are drafted before tables, grids and timelines. Are those three needed sooner, which would put more weight on slice 1 and less on cards?

## Visual design

The mock is `design/kanban/index.html`: one file, theme blocks copied from `src/themes.ts`, icons from `src/ui/dom.ts`. A reviewer strip switches theme, state, filter, WIP, dragging, width and reduced motion; `?bare=1` hides it for screenshots, and every control is also a URL parameter (`theme`, `state`, `filter`, `wip`, `drag`, `width`, `reduce`). The positions in it come from a layout function over lane and card order, as above. Board objects use the canvas tokens; the popover, menu and phone sheet are chrome and use the admin tokens (`src/ui/admin.css`). Radius 0, no shadows: edges are hairlines and 2px ink rules (the few `box-shadow`s in the mock are inset rules with no blur).

### Anatomy

Sizes are CSS pixels at zoom 1. The layout constants above are unchanged; the layout function also needs a **container header of 48**, an **inner lane padding of 8**, a **drop zone of 56** under the tallest lane, and an **add-lane column** (8 gap, 32 wide) right of the last lane.

| Element | Size | Tokens |
|---|---|---|
| Container | lanes + add-lane column + 12 padding, 1px border | `--canvas` fill (opaque, so the dot grid never runs behind text), `--canvas-rule` border |
| Container header | 48 high, 2px rule under it | Name 17px Cabinet Grotesk 700 `--canvas-ink`; "4 lanes · 9 cards" 11px label in `--k-meta`; **Filter** button 32 high, 1px `--canvas-ink` outline; active filters as 32-high outlined chips with a 30px remove button; **⋯** 32 square |
| Lane | 280 wide, 16 apart, all lanes as tall as the tallest plus a 56 drop zone | Body `--k-lane` = `color-mix(--canvas-ink 5%, --canvas)`; with a colour, a 4px top bar in the swatch and the body `color-mix(swatch 10%, --k-lane)` |
| Lane header | 48 high | Name 14px 600 `--canvas-ink`; count 11px label, right; stage `✓ DONE` label for `done` only; **⋯** 28 square |
| Add lane | 32 square, 8 right of the last lane, level with its header | `+` icon, 1px `--canvas-ink` outline; editors only |
| WIP count | 20 high | `3 / 3` in `--canvas-ink` at the limit; over: `4 / 3` as `--paper` on `--danger` plus a 2px `--danger` rule under the header; block lanes add a lock icon before the count |
| Card | lane width − 16, height from the stored `h`, 8 apart | `--paper`, `--ink` text, 1px `--k-edge` hairline; `fill` draws a 4px accent edge on the left |
| Card rows | padding 8 / 12, 8 between rows | Title 13/18 500, up to 3 lines; label row 16 high; meta row 24 high: due, spacer, comment count, owner |
| Label chip | 16 high | Swatch from the sticky palette (`--s-*`), `--sticky-ink` 11px label; at most 3 then `+n`, names never clipped |
| Due | 20 high, 11px label | Normal and done: `--k-card-meta` (done adds a check); soon (today, tomorrow): `--ink` with a 1px `--ink` box; overdue: `--paper` on `--danger` |
| Owner | 24 square | Initials 10px 700 `--ink` on `--paper` in a 2px ring of the person's colour; a free-text owner gets a hairline ring instead |
| Add card | 40 high, after the last card | `+ Add card` 13px `--k-meta`; inline input is a card with a 2px `--ink` border |
| Empty lane | 56 high | Dashed hairline box, "No cards" label |

`--k-meta` is `color-mix(--canvas-ink 82%, --canvas)` and `--k-card-meta` is `color-mix(--ink 72%, --paper)`, the lightest mixes that pass 4.5:1 on every lane tint in every theme.

**Decisions.**
- **Owner badges are square with ink initials.** The spec says "initials in the person's colour"; the colour is kept as a ring. No single text colour passes 4.5:1 on all eight `USER_COLORS`, and even the per-colour `inkOn` choice gives 4.38:1 on `#D64545`, so the initials are `--ink` on `--paper` everywhere and the colour is a non-text identity cue. Square, not round, by the radius rule; it also keeps a card owner apart from the round presence avatars.
- **Labels on their own row.** With chips, due, comments and owner on one 240px line, names clipped mid-word. Two rows read cleanly and keep chip names whole.
- **"Due soon" is today and tomorrow**, an ink box; only overdue uses `--danger`, so red keeps one meaning on the board.
- **Done lanes mark their stage in the header** (`✓ DONE`), because a lane called "Shipped" does not say it switches off overdue. `todo` and `doing` show nothing, as the spec says. Overdue is a card state, not a lane marker.
- **Label colours are the eight sticky swatches**, the same in every theme and already readable with `--sticky-ink` (9.3:1 or more). The `labels` map stores the swatch name.
- **Filter on** uses `--signal` (the active state); active filters show as outlined chips with a remove button to the left of it.
- **New icons**: `filter` (three bars), `grip` (six squares, the sheet's drag handle) and `kanban` (the tool and **Open as list**). They follow the 24px, 1.75 stroke grid of `ICONS`.

### States

| State | Look |
|---|---|
| Container unselected | Header, lanes and cards as above; nothing else |
| Container selected | The usual 1.5px `--wire` outline and square handles; quick-action bar: **Add lane**, **Filter**, **Export CSV**, lock, **⋯** |
| Container menu | From the header **⋯**: Rename, Add lane, Labels…, Export cards (CSV), Open as list, Lock, Delete kanban (`--danger`) |
| Card selected | 1.5px `--wire` outline; quick-action bar with **Open** as the primary (`--signal`), Owner, Due, Labels, Turn into sticky |
| Adding a card | Inline card input with caret; "Enter adds · Esc stops" label under it |
| Filter open | Popover under the header: Owner (Mine), Labels (any of), Due, Text, "2 of 9 match" and **Clear** |
| Filter on | Matching cards full; others at 35 % opacity; comment pins stay full (they belong to the comment layer) |
| WIP over (warn) | `4 / 3` danger chip and 2px danger rule; dropping still allowed |
| WIP full (block), dragging over | Lane body outlined 2px dashed `--danger`, a "Full · 2 / 2" label, no drop line; on release the toast "Review is full: 2 of 2" |
| Dragging | Source slot: a dashed hairline placeholder of the same height, content hidden (no writes, so the layout does not move). Ghost: the card at full opacity with a 2px `--canvas-ink` edge, under the pointer. Drop line: 2px `--canvas-ink` with 8px square ends, centred in the 8px gap |
| Dragging into an empty lane | Drop line at the top of the body; "No cards" reads "Drop here" |
| Keyboard move | Wire selection plus a 2px `--canvas-ink` ring 4px out, and a `--signal` tag "Moving · Alt + arrows"; the live region says "Moved to Doing, position 2 of 3" |
| Zoom below 0.4 | Titles become bars, chips colour only, lane header the name only |

The drop line is `--canvas-ink`, not `--wire`: wire already means "selected" on the canvas, and a 2px ink rule is the house mark for "here". The keyboard ring is `--canvas-ink` for the same contrast reason: `--signal` on a light lane is 1.2:1, so yellow carries only the label.

### Contrast

Computed from `src/themes.ts` with the mock's own `color-mix` expressions. Text needs 4.5:1, indicators 3:1.

| Pair | Min | Default | Ayu | Kanagawa | Matrix | Evergreen |
|---|---|---|---|---|---|---|
| Container name, lane name (canvas-ink on canvas / lane) | 4.5 | 13.1 | 8.5 | 10.1 | 13.9 | 11.6 |
| Container meta (canvas-ink 82% on canvas) | 4.5 | 8.4 | 6.8 | 8.0 | 10.1 | 7.4 |
| Lane count, Add card, No cards (canvas-ink 82% on lane) | 4.5 | 7.7 | 6.1 | 7.2 | 9.4 | 6.8 |
| Lane name on a tinted lane, worst of 8 tints at 10% | 4.5 | 12.5 | 6.4 | 7.7 | 11.1 | 11.1 |
| Lane count on a tinted lane, worst of 8 tints | 4.5 | 7.3 | 4.6 | 5.4 | 7.5 | 6.5 |
| Card title, owner initials, due soon (ink on paper) | 4.5 | 16.3 | 8.4 | 9.7 | 14.1 | 14.3 |
| Card meta, due, done date, +n (ink 72% on paper) | 4.5 | 6.5 | 5.1 | 5.8 | 7.6 | 5.8 |
| Overdue chip, WIP over count, Full label (paper on danger) | 4.5 | 5.2 | 5.6 | 4.6 | 5.7 | 5.2 |
| Filter on, Moving tag, primary buttons (on-signal on signal) | 4.5 | 11.3 | 10.4 | 9.7 | 14.3 | 7.1 |
| Popover, sheet, menu text (ink on paper) | 4.5 | 16.3 | 8.4 | 9.7 | 14.1 | 14.3 |
| Popover and sheet labels (graphite on paper) | 4.5 | 5.9 | 4.6 | 5.8 | 6.0 | 5.9 |
| Active option (paper on ink) | 4.5 | 16.3 | 8.4 | 9.7 | 14.1 | 14.3 |
| Toast, quick-action bar (tray-text on tray) | 4.5 | 13.8 | 10.5 | 12.4 | 15.4 | 13.3 |
| Delete kanban (danger on paper) | 4.5 | 5.2 | 5.6 | 4.6 | 5.7 | 5.2 |
| Dimmed card title (35% opacity, intentional) | none | 2.1 | 2.3 | 2.5 | 2.7 | 2.0 |
| WIP over rule (danger on lane) | 3 | 4.2 | 5.7 | 4.8 | 5.7 | 4.2 |
| Refused drop outline (danger on lane) | 3 | 4.2 | 5.7 | 4.8 | 5.7 | 4.2 |
| Overdue chip (danger on paper) | 3 | 5.2 | 5.6 | 4.6 | 5.7 | 5.2 |
| Drop line, ghost edge, keyboard ring (canvas-ink on lane) | 3 | 13.1 | 8.5 | 10.1 | 13.9 | 11.6 |
| Selection (wire on canvas) | 3 | 4.0 | 9.0 | 5.9 | 11.0 | 4.3 |
| Container header rule (canvas-ink on canvas) | 3 | 14.3 | 9.5 | 11.3 | 15.0 | 12.7 |
| Card hairline (canvas-ink 28% on lane, decorative) | none | 1.8 | 2.0 | 2.1 | 2.1 | 1.7 |

Label chips, the same in every theme (`--sticky-ink` on the swatch): yellow 13.4, orange 10.3, pink 9.3, violet 9.8, blue 10.9, teal 11.6, green 12.5, grey 13.9.

Two rows have no minimum on purpose: dimmed cards are the filter's message (the matching cards carry the information, and the filter chips say what is hidden), and the card hairline is decorative (the paper fill and the title identify a card). Not part of this design but found on the way: the existing comment pin puts white letters on the person colour, which is under 4.5:1 for six of the eight colours (2.95 to 4.38).

### Motion

- **Drop**: the 120 ms tween of the derived rectangle from the spec, `ease-out`; never during a local drag.
- **Ghost**: appears with a 120 ms lift (8px offset and fade in).
- **Reduced motion** (`prefers-reduced-motion: reduce`): no lift, the ghost is there at once; a drop snaps. Screenshots `drag-lift-default` and `drag-lift-reduced-default` are taken 40 ms into the lift. The mock's **Reduced motion** box simulates it, and **Play a drop** shows both.
- Nothing pulses or loops.

### Phone

- At 390 the canvas shows the container scaled (31 % for four lanes), so the level-of-detail rule applies. Selecting it gives a quick-action bar with **Open as list** as the primary action, **Filter** and **⋯**.
- **List sheet**: full width below the top bar, a 2px ink rule on top. Header 56: the name (20px display), "4 lanes · 9 cards", **Filter** (40 high) and close. Lane tabs 48 high, 11px labels with counts (`3 / 3` with a limit, the danger chip when over), the active tab underlined 2px `--ink` as in the admin phone tabs. Card rows: 32px grip, title 15/20 up to 3 lines, the card's chip and meta rows, a 40px **⋯** button; rows on hairlines. The **Add card to Doing** bar is a 48px `--signal` button on a 2px ink rule.
- **Move to…** is a bottom sheet over a `--tray` scrim: lanes as 48px square radio rows with their colour bar and count, the current lane marked "Current", a full block lane disabled with a lock and "Full"; then **Top** / **Bottom**; then **Cancel** and **Move** (primary).
- All targets are 40px or more; text in the sheet uses the admin pairs (`--ink`, `--graphite` on `--paper`).

### Open questions

None. Every visual choice the spec left open is decided above with its reason.

## Slice 1 notes

Where the spec was silent or ambiguous, slice 1 took the reversible option (none of these is stored data):

1. The front/back order bug (TAB-159) was already fixed on main before this slice. Slice 1 only makes `bringToFront` and `sendToBack` skip what a container lays out, since its `z` is unused.
2. **A card whose lane was deleted** has nothing stored that names a container, so "the container's first lane" cannot be found from the document. The rule built: the first lane of the container lowest in paint order (`z`, then id) that has a known layout; with no such container the card is a loose card at its stored place. It is right for a board with one kanban and arbitrary with several. Open for Johan: keep a container id on cards, or accept this.
3. **Layout constants** are all named in `KANBAN` in `shared/containers.mjs`. The spec's are unchanged (lane width 280, lane gap 16, padding 12, lane header 48, card gap 8, minimum lane body 160). From the visual design (e72d5ab on design/kanban) it adds a container header of 48, an inner lane padding of 8 (so cards are 264 wide), a drop zone of 56, an add-lane column (8 gap, 32 wide) and an empty-lane box of 56. The column is always reserved, whatever the role, because every client must lay out the same; its rectangle is `addLane` in the layout result, centred in the lane header band (the design says only "level with its header"). The container name's editor sits in the header band. A card with no stored `h` is 72 high. Three points where the two documents do not quite meet, each taken the reversible way:
   - The spec ends a container with "a drop zone of one card"; the design says 56. 56 is used. If one card is meant, `dropZone` becomes the card height.
   - The design's "empty lane 56 high" is read as the dashed "No cards" box inside a lane. Read as the lane's height it would contradict the spec's minimum body of 160 (and "all lanes as tall as the tallest"), so the lane keeps 160 and `emptyLane` is only named for the drawing slice.
   - The spec's "padding 12" is taken as the container's padding; inside a lane the design's 8 applies (the spec gives cards "the width of the lane body" without a number).
4. `layoutContainer(container, lanes, cards)` has no `ctx` argument, because nothing needs one yet. Layouts are cached and dropped per container, not per lane.
5. **The feature gate.** The spec says `meta.features` includes `containers`; one array under one key loses a feature when two clients add different ones at the same moment, so the gate fails open. Built instead: one meta key per feature, `feature:containers` = true, read as a union (the first array form, `features`, is still read). Reading fails closed: a `features` value that is not an array of names, or a `feature:` key with no name, counts as a feature this client does not know, and the board opens read-only with the banner. `Store.create` and `Store.update` write the key when an object of any of the three types is written or converted (not only a container); it stays when the last one is removed. Version history never removes or restores `feature:` keys and calls `Store.syncFeatures` after a restore, so a restored container or a changed type cannot leave the flag off. The gate (`watchFeatureGate`) starts before an import writes the board, so an imported file that needs a newer client locks the board too. This client knows only `containers`, so the lock and the banner show up only for a feature it does not know yet; clients from before this slice cannot show a banner at all.
6. Label colour keys are the lower-case names of the eight sticky swatches, as the visual design decided; a test keeps them equal to `src/palette.ts`.
7. The template whitelists (client and server) list the three types. The field switch and the validator rules are slice 5, so until then a `lane` or `card` in a template is refused (its parent must be a frame) and a `container` passes with only the common fields.
8. Until slice 2 draws them, a container, a lane and a card are a hairline box with their name (a container whose layout is unknown also says "Needs a newer Tabula"; the spec asks for that note and for never editing it), so none is an invisible region. They have no resize or rotate handles, since their size and place come from the layout. Slice 2 replaces both.
9. Left for the slices that draw and edit: copy, paste and duplicate of containers (`gather` does not collect their children and does not rewrite rank suffixes), deleting a container (`deleteSelection` would un-parent its lanes), `labels` in the JSON export and the `.drift` snapshot, `update_objects` refusing `rank` and `parent`, and the card fields in the MCP summaries (the reader already reports derived positions).

## Slice 2 notes

Slice 2 draws containers, lanes and cards, selects and moves them, and makes a kanban with the tool. Where the spec or the design was silent, it took the reversible option (none of these is stored data, except where a note says which field is written):

1. **Sticky and card.** Conversion is slice 3, so a sticky dragged onto a lane stays a sticky (an ordinary move, with the frame rules). A card dragged off every kanban becomes a loose card where it was dropped, in the frame under it if any, as the spec says ("it does not silently become a sticky"); a loose card dragged onto a lane joins it. Loose cards use the same ghost drag as laid-out ones, so each of these is one write and one undo step.
2. **Making one.** The tool is a **Kanban** tile under a new **Boards** heading in the Shapes drawer; the spec assigns no shortcut, so there is none. A click centres the kanban on the point, a drag puts its top-left corner where the drag started (its size comes from its lanes). It is named "Kanban". In place of the spec's "one empty card in the first lane in edit mode", the add-card input opens in the first lane, so nothing is left behind when nobody types.
3. **Add card** is the minimal version: a title only (at most 200 characters, the first line), Enter adds it and starts the next, Esc stops, and leaving the input with text in it adds that text, as leaving a field does elsewhere. Double-click on empty lane space opens it too. The card dialog, owner, due date and labels editing are slice 3; until then a double-click or Enter on a card only selects it, so a card's title cannot be changed in this slice.
4. **Card height.** The writer stores `h` from the title (up to three wrapped lines at the card's width), a label row when the card has labels and a meta row when it has a due date or an owner. The comment count is drawn only in an existing meta row, because a comment writes nothing to the card and so cannot change its height; slice 3 can give it room. The height is measured with the fonts the writing client has; one that writes before the board's fonts load stores the fallback face's height, as text objects already do.
5. **Not drawn yet**, though the mock shows them: the header's **Filter** and **⋯**, the lane **⋯** and the add-lane **+** (filters, the container menu, the lane menu and adding lanes are slice 4). The layout still reserves the add-lane column. Dragging a lane header to reorder lanes is not built either. WIP is display only: the count, the `at` and `over` looks (the over rule for any lane over its limit, block or warn) and a lock on a blocking lane; no drop is refused.
6. **Deleting.** With the Delete key a lane's cards move to the end of the lane on its left (on its right for the first lane) in the same transaction, as the spec's "A lane is deleted by the UI" row says; the last lane of a kanban takes its cards with it. A lane of a locked kanban is not deleted. Deleting a kanban deletes its lanes and cards. A delete that would remove or move a locked lane or card is refused with a message, as a locked object is never changed by an edit. The "Delete lane and its cards" choice belongs to the slice 4 lane menu.
7. **Copy, paste and duplicate** are still shallow (slice 1, note 9): copying a kanban copies no lanes, and duplicating a card in a lane gives it the same rank, which sorts by id and is repaired by the next drop into that lane. Left for slice 3.
8. **Several cards.** A drag that starts on a card moves the selected cards that are not locked, as one group in container order; other selected objects stay where they are. The ghost shows the card under the pointer. A drop where the cards already are writes nothing and makes no undo step. Pointer drops are announced in the live region like keyboard moves.
9. **Keyboard.** Alt+arrows act on one selected card in a lane; at an edge nothing moves and nothing is announced, but the ring shows. Each press is its own undo step. The ring and the "Moving" tag are drawn at a constant screen size (the mock scales them with the board), and the tag moves to the left of the card, or above it, when the view ends on its right. They go when the selection changes or the pointer goes down.
10. **Owner badges** take the person's colour only when the owner (`ownerId`) is in the room now; anyone else, and a free-text owner, gets the hairline ring. Remembering colours of people seen earlier is open.
11. **Fonts.** Lane names, card text and labels use the board's body font and the container name its heading font (the mock uses the chrome font, Switzer). Label chips use `var(--s-<swatch>, <sticky colour>)`; the app defines no `--s-*` variables, so the sticky palette, the same in every theme as the design says, is what shows.
12. **The tween** plays on the lane or card element (from where it was last drawn to its new place) after any change that moves it, local or remote, a drop and a keyboard move included; not on first draw, not when its container moved (a container dragged by anyone moves its contents without lag), and never with reduced motion. The ghost's lift is a CSS animation that reduced motion turns off.
13. **For the next slices.** A lane redraws when its cards change, but its cards do not redraw when the lane changes: slice 4, which edits `stage`, has to redraw the lane's cards (their due chips depend on it). A loose card has no resize or rotate handles, like everything of the three types (slice 1); the spec calls a loose card an ordinary box, so slice 3 may want them back for loose cards.
14. **Colours from the board.** A lane's `fill`, a card's `fill`, a label's `color` and an owner's ring colour reach a style attribute, so each goes through `safeColor` first (palette key or `#rgb`, `#rrggbb`, `#rrggbbaa`, else not drawn), and a label read from the `labels` map goes through `validLabel`. `shared/containers.mjs` re-exports `safeColor`; until `shared/colors.mjs` lands it comes from a stand-in, `shared/colors-shim.mjs`. The SVG export replaces `color-mix()` by plain colours (`resolveColorMix` in `src/exporters.ts`), since Inkscape, Illustrator and librsvg do not read it.
15. **Hit testing.** Laid-out lanes and cards are hit with no slack around them (other objects keep 5 screen pixels), so at low zoom the card below never takes a click meant for its neighbour. Below zoom 0.4, where the add-card row is not drawn, clicking there is a click on the lane. A cancelled pointer gives up a card drag; it never drops.
16. **Skipped**, as the brief allows: shared drag awareness (the optional ghost of other people's drags), and the long press to drag a card on touch (the phone route is slice 5's list sheet).

Open for Johan (each built the reversible way above): whether a card's title should be editable in place before the slice 3 dialog arrives (note 3), and whether an owner who is not in the room should keep a remembered colour (note 10).
