# Groups

TAB-106. Status: spec for review. Nothing here is built yet.

People want to treat several things as one: move a diagram without picking up each box, duplicate a header with its icon and its note, lock a legend, put a cluster above everything else. Tabula has frames, which are labelled rectangles that carry what is inside them, and nothing that is only a bundle. The README lists groups as not built.

This page specifies **groups**: what one is in the document, how a click selects it and a double-click enters it, what move, resize, rotate, copy, delete, lock and stacking do to it, what happens to connectors and frames, how two people editing at once end up with the same board, and what the layers panel, templates, exports and the AI tools see. It follows three neighbours: the stacking steps of TAB-108 (`src/z-order.ts`), the container model of kanban (`docs/kanban.md`, which has the same "children paint as a unit" rule), and the existing frame code in `src/app.ts`.

## Summary

- **A group is an object of a new type, `group`, with no picture of its own.** Its members have `parent` set to its id. The group has no size or position of its own to keep in step: its rectangle is **derived** from its visible members. The same `parent` field already means "belongs to" for frames, so a group nests (in a group, in a frame) with the code that already walks `parent`.
- **Group and ungroup**: `Ctrl+G` (`Cmd+G` on Mac) groups the selection, `Shift+Ctrl+G` ungroups. Both are one undo step. The group appears where its topmost member was.
- **Selecting**: clicking a member selects the whole group (the outermost one). **Double-click** enters the group, so the next click picks one member; **Esc** or a click outside leaves. Entering is a local view state, not shared.
- **Transforms act on the whole group**: move translates every member, resize is always proportional and scales members about the group's corner, rotate turns the members about the group's centre. A group has no rotation of its own (members keep theirs), so its box is always upright.
- **Connectors keep working** because they bind to member ids, which do not change. Connectors whose two ends are both inside the selection join the group.
- **Stacking is a unit**: the group is one step in the order of its level, and its members paint together at that spot. Bring forward, Send backward and the others (TAB-108) work on groups.
- **Lock, copy, duplicate, delete** act on the whole subtree. Nested groups are allowed up to 8 deep.
- **Two people at once** merge because every change is a field of one object: a move is a write per member, grouping is one transaction that creates the group and re-parents. The few conflicts have a rule each (a table below), and a group left with nothing is removed by whoever notices.
- **Nothing here needs the server** except two MCP tools and the template validator; the relay does not look inside board updates.

## Decisions and why

1. **A `group` object and `parent`, not a `group` field and a separate map.** Alternatives were a field on each member (`group: id`) with the group's own data in a new root map, or a list of member ids on the group. A list is one value that two people overwrite. A separate map is one more place that history, templates, exports and the layers panel must learn about. An object is already a thing all of them handle: it has a z key, it can be locked and named, it appears in `.drift`, JSON, history and the template validators once its type is in the list, and `parent` already nests. The cost is that `parent` now has two meanings (a frame or a group; later a kanban lane), which [Where `parent` is read](#where-parent-is-read) pins down.
2. **Derived rectangle, never stored.** A frame stores its size because people resize it. A group's size is a consequence of its members. Storing it would add a write to every member move, from every client, and a value that can disagree with its members. The group object holds `x: 0, y: 0, w: 0, h: 0` (the fields exist so every consumer that expects a box does not crash) and `Store.geometry(o)` (also named in the kanban spec) returns the union of the visible members for a group.
3. **No rotation on the group.** Remembering that a group was turned 30 degrees and then resized along its turned axes needs a stored angle, rotated handles, and a rule for what a member's own rotation means inside it. Without it, a group is an upright box, rotating it rotates the members rigidly and leaves each with a new `rotation`, and the next turn starts from zero. It is what the app does today when several things are selected and turned, which people already understand.
4. **Resize is proportional only.** Stretching a group would distort text, icons and connectors' labels. Proportional scaling is what a selection of several items does for icons and actors today (`keepAspect`), and it is what "zoom this diagram" means.
5. **The group paints where its topmost member was.** Grouping must not change what is on top of what *inside* the group, and should disturb what is *outside* it as little as possible. Members that were interleaved with outside objects cannot all keep their place; the group takes the top member's, so outside objects that were between members end up below the group. That is the rule most design tools use and people predict it.
6. **Entering is local.** Which group you have "opened" is a view state like the zoom: it is not written to the document and a collaborator sees nothing of it. The alternative (a shared "being edited" marker) would make two people fight over it.
7. **Group-level lock is a flag on the group, not on every member.** Locking a group must be undoable as one step and must not erase which members were locked on their own beforehand. Effective lock is "this object or any ancestor group".

## The document

### The group object

```
Group {
  id, type: 'group', z                // its place among its siblings
  parent?: Id                          // a frame or a group
  name?: string                        // shown in the layers panel, up to 80 characters; "Group" when empty
  locked?: boolean
  x: 0, y: 0, w: 0, h: 0, rotation: 0  // present so a box is a box; always these values; never read, never written
  createdBy, updatedAt
}
```

Members: any box object (sticky, shape, text, icon, image, path, UML, container, frame excluded) and connectors, with `parent` = the group's id. Their `x`, `y` and `z` stay their own: `z` is the order **inside** the group.

Not groupable: **frames** (a frame already carries its children; grouping two frames would hide that), and **objects whose `parent` is a kanban lane** (cards inside a container move with the container; a whole container can be grouped like any box). The Group command is disabled with a reason in its tooltip when the selection holds only such things, and groups the rest with a one-line toast when it holds some ("2 frames were left out").

Limits: nesting depth 8, 500 direct members per group, 500 groups per board. Beyond them the command says so and does nothing.

### Where `parent` is read

`parent` is read in a handful of places and each needs a decision. They are the list of what slice 1 touches.

| Place | Today | With groups |
|---|---|---|
| `Store.childrenOf(frameId)` (`src/store.ts:238`), a linear scan | children of a frame | unchanged for direct children; new `descendantsOf(id)` returns the subtree through groups, and `frameOf(o)` the nearest frame ancestor. A child index (parent to ids) replaces the scan |
| Moving a frame (`beginMove`, `src/app.ts`) | walks `childrenOf` recursively and rewrites each child's position | the walk already recurses; a group on the way is passed through and skipped as a writer (it has no position), its members are written |
| Dropping onto a frame (`reparent`, `src/app.ts`) | sets `parent` to the frame under the object's centre | for a group member it does nothing (it moves with its group); for the group itself it sets the group's `parent`; members are never re-parented by a drop |
| Deleting a frame (`deleteSelection`, `src/app.ts:1290`) | children lose their `parent` and stay | unchanged for children of a frame; a group inside the frame keeps its members, loses its `parent` |
| Copy, duplicate, export gathering (`src/app.ts:1304`, `src/exporters.ts:204`) | frame children come along | the whole subtree comes along, groups included, with `parent` remapped |
| Markdown summary (`src/flow.ts:401`) | lists the text of a frame's direct children | lists the text of everything whose `frameOf` is the frame, so grouping a note does not make it vanish from its frame's section |
| AI bar context (`src/ui/ai-bar.ts:99`), MCP `get_board {frameId}` (`server/board-ops.mjs:286`) | direct children of a frame | descendants through groups |
| Templates (`src/custom-templates.ts:70,237`, `server/templates.mjs:262`) | a parent must be a frame in the template | a parent may be a frame or a group in the template; no cycles; depth within the limit |
| MCP create (`server/board-ops.mjs:566`) | `parent` must be a frame | unchanged: groups are made by the new tools below |

A parent that does not exist (the group was deleted by someone else) is read as no parent, never as an error. That is the **orphan rule** and it applies everywhere in the table.

### Derived geometry

`Store.geometry(o)` for a group returns the union of `boxBounds` of its **visible** members (recursively, nested groups included, connectors excluded). "Visible" leaves out a private-writing note the viewer may not see (`Flow.isHidden`), so a group's outline cannot be used to find where a hidden note sits. A group with no visible members has an empty rectangle and is neither drawn nor hit.

Every consumer that reads `o.x`, `o.y`, `o.w`, `o.h` for a group goes through `geometry` (the renderer's selection box, hit testing, culling, snapping and guides, align and distribute, export bounds, the minimap). The list is part of slice 1 and a test moves a member and asserts the group's rectangle followed. The cache that holds the union is invalidated by the store's change observer, which already knows which ids changed: it walks `parent` upward from each changed object and marks every group on the way.

### Paint order

`Store.ordered()` today puts all frames first and everything else by `z`. With groups, everything that is **not** a frame and **not** a group member is sorted by `z` at the top level, and each group is replaced by its subtree: the group (not painted, not hit), then its members by their own `z`, recursively, contiguous. A frame's children are not contiguous with the frame and are not made so: a frame is a background, a group is a unit.

`planStep` (TAB-108) and the four stacking commands work among **siblings**, so inside an entered group they reorder members, and outside they reorder top-level items, with a group counted as one item whose rectangle is its derived one. Writing a group's `z` is one write however many members it has.

## Selecting and entering

State kept by the client, not synced: `scope`, the group the person has entered (`null` at the top). `selection` holds ids of objects that are **direct children of the scope** (or of no group when scope is `null`).

- `pick(o, scope)`: climb from the object through its group ancestors until the next step up would be the scope (or the top). That ancestor is what a click selects.
- **Click** an item: select `pick(item)`. Shift-click toggles it; items from other levels are lifted to the scope's level so one selection never mixes levels.
- **Double-click** a member of a group that is not the scope: enter it (`scope` becomes that group) and select the member that was clicked. A second double-click on an item that is already a direct child of the scope does what double-click does today (edit text, enter a frame name). A double-click on empty space inside the scope's rectangle does nothing new.
- **Leave** with `Esc` (selects the group just left and sets `scope` to its parent group), with a click on empty canvas, or by selecting something outside. A nested scope leaves one level at a time.
- **Marquee** selects the items at the scope's level that touch the rectangle (a group when any visible member does), as the marquee does today for single objects.
- **Select all** (`Ctrl+A`) selects the top-level items (or the scope's children), skipping locked ones as now.
- Selection after undo, redo, paste or an AI apply sets `scope` to `null` and selects the top-level ancestors of what changed.
- **Hover** outlines the whole of what a click would select, so the effect of the click is visible beforehand.
- A **dot vote** (a vote step running) is the exception: a click votes for the item under the pointer, not for its group, because votes belong to items (`Flow.handleClick`, `src/flow.ts`).

`app.selected()` returns what is selected (groups as groups). New `app.selectedLeaves()` expands groups to their non-group descendants; style and text controls (fill, line, text alignment, opacity, stickers) use it, so choosing a colour for a group colours every member that has one, exactly as for a multiple selection today. Arrange controls (stacking, duplicate, lock, delete, align) use `selected()`.

The selection box and handles use the group's derived rectangle. A group with a locked member shows no difference; see [Lock](#lock).

## Grouping and ungrouping

**Group** (`Ctrl+G`, a **Group** button in the quick-action bar and the context menu, **Group** in the properties panel's arrange row): needs two or more selected items after the exclusions above, all at the same level (the selection is by construction).

In one transaction:

1. Create the group: new id, `z` = the highest `z` among the selected top-level items, `parent` = the frame under the middle of their combined rectangle (the `frameAt` rule), else none.
2. Set `parent` of each selected item to the group, **keeping** its own `z`.
3. Add the connectors whose two ends are both bound to (or are free ends belonging to) items in the selection and that are not already inside another group: their `parent` becomes the group.
4. Select the new group.

The members were in other places in the paint order. Those that were below an outside object that lies between members now paint above it (the group moves up to its top member), as in the decisions list.

**Ungroup** (`Shift+Ctrl+G`, **Ungroup** in the same places): for each selected group, in one transaction, give its members the group's `parent` and fresh `z` keys that put them exactly where the group was, in their order (`generateNKeysBetween(group.z, next sibling above, n)`), delete the group object, and select the members. Ungrouping a selection of several groups does all of them in one step. Ungroup on something that is not a group is disabled.

Ungrouping only one level: members that are themselves groups stay groups.

Undo of either is one step and restores the exact previous state, since both are single transactions (`transact` with the local origin).

## Transforms

All of them write the members, never the group. They share the structure of frame move (`beginMove`): collect the subtree, remember the originals, write each frame of the drag, one transaction per frame batch, one undo step per gesture (the capture rule already in `store.undo`).

- **Move**: translate every member and the free ends of connectors inside the group. Snap and guides use the group's derived rectangle. Dragging a group over a frame highlights the drop target and re-parents the **group** on release. Members that are individually locked are carried along (the lock keeps people from editing them, not from moving the thing they belong to; see the open questions).
- **Resize** (proportional only, from any corner or edge handle, always keeping the ratio): scale about the opposite corner by `s`. For each member the centre maps to `a + (c - a) * s`, `w` and `h` are multiplied by `s`, then `x` and `y` come from the new centre (so a rotated member stays correct), `rotation` is unchanged, `points` of a path and the free ends of connectors scale, `fontSize` is multiplied by `s` and kept within 6 to 400, and `strokeWidth` is left alone (a line scaled to a hair would vanish). Minimum scale: the group's smaller side may not go below 24 units.
- **Rotate**: the angle `d` from the handle (Shift snaps to 15 degrees) turns each member's centre about the group's centre and adds `d` to its `rotation`; free connector ends turn too. The group's box is the new union and is upright again.
- **Nudge** (arrow keys) and **align and distribute**: a group is one box with its derived rectangle, moved by translating members.
- **Text editing, shape change, anything on a single member** needs entering the group first (a double-click), then it is the normal single-object behaviour.

A transform of a group with many members writes many objects in a frame; the batching that drag already has (one write per animation frame) is kept, and the limit of 500 members per group keeps it far below what a frame move can already be.

## Connectors

- A connector bound to a member keeps its binding: ids do not change when something is grouped, moved, scaled or duplicated within the same board. It follows the member as it follows any moving object.
- A connector bound to a group is not possible: the pick that makes a connector's endpoint (`app.connectTarget`) skips groups and uses the member under the pointer, so a connector always ends on a visible thing.
- **Joining** (step 3 of grouping): both ends inside the selection makes it part of the group, so duplicating the group duplicates it, and moving the group moves its free ends. A connector with one end outside is **not** a member: it stays at its level and its inside end follows the member.
- **Duplicating** a group copies the connectors that are members and rebinds them to the copies; a connector with an outside end is not copied (as today when only one end of a connector is copied).
- **Ungroup** gives the member connectors the group's parent like any other member.

## Frames and containers

- A group may sit in a frame, and frame move, frame delete, export gathering and the Markdown summary treat its members as the frame's (the table above).
- Dropping a member of an entered group onto another frame re-parents nothing: a member leaves its group only by **Ungroup** or by being dragged out in the layers panel.
- A group inside a kanban container is not possible; a whole container in a group is. The container model (`docs/kanban.md`) derives its children's positions, and a group of a container moves by moving the container's own `x` and `y`, which is the one write the container needs.

## Lock

Locking a selected group writes `locked: true` on the **group**. A locked group behaves like any locked object: clicks and marquees pass over it, select-all skips it, it cannot be edited, and a long press unlocks it. A member is **effectively locked** when it or any ancestor group is locked, and the click-through and edit refusals use that. Unlocking the group does not touch the members' own flags, so a member locked on its own before stays locked.

A hit test that finds a locked member (long-press to unlock) lifts to the **outermost locked ancestor** so the unlock acts on the group the person sees, not on a member inside it.

## Copy, paste, duplicate, delete

- **Copy and cut** (`Ctrl+C`, `Ctrl+X`) and **duplicate** (`Ctrl+D`) expand the selection to its subtree, remap ids and `parent` links (`remapObjects` already remaps `parent` inside the set), and select the new top-level groups. Paste across boards works the same way.
- **Delete** a group deletes its subtree: the group, its members, nested groups. Connectors left with a deleted end behave as they do when any object is deleted. Deleting **members** of a group (entered, or by a marquee inside it) deletes just those; if the group has no members left it is deleted in the same transaction. A group with one member is kept (the person can ungroup it).
- A group is never left in the clipboard on its own: copying a group copies its members.

## Concurrency and offline

Groups are ordinary Yjs map objects with per-field merges, so everything works offline and syncs. What can go wrong when two people act at once:

| Situation | Result |
|---|---|
| Two people move different members | Both writes land; the group's derived rectangle follows. |
| Two people move the same group | Each writes every member; per member the last write wins, so the group may end up split between the two positions for a moment and then the last writer's frame batch wins on each member. Nothing is lost; it looks like two people dragging the same note. |
| One groups, the other deletes a member | The deleted member's `parent` write is ignored (updating a missing object does nothing, `Store.update`). The group has one member fewer. |
| One ungroups, the other moves a member | Both apply: the member is moved and is now at the group's old parent. |
| One groups two items, the other groups one of them with something else | `parent` of the shared item is last writer wins. The loser's group has one member fewer; if it has none left it is **empty**. |
| A member's `parent` names a group that no longer exists | The orphan rule: read as no parent (top-level), never an error. Its position is its own, so it does not jump. |
| A group with no members | Drawn nowhere, hit nowhere, listed nowhere. Any client that notices one while it writes (deleting, ungrouping, grouping) removes it in the same transaction; removing twice is harmless. |
| A cycle (group A in B in A, by two crossed writes) | Impossible to make through the commands, since a group cannot be moved into its own subtree. If a hand-edited or imported document has one, the walker stops at a repeated id and reads the second as top-level. |

Version history (`planRestore`, `src/history.ts`) works object by object by id; a restored group comes back with its members' `parent` links, and the orphan and empty-group rules cover a half-restored state.

## Undo

Group, ungroup, move, resize, rotate, delete, duplicate, lock and every stacking step are each one transaction with the local origin, so each is one undo entry (move, resize and rotate by the gesture, as today). Entering and leaving a group are not undoable: they change no document state.

## The layers panel

The panel itself is a separate issue (TAB-107 and the z-order work); what it needs from groups, so that issue can build on them:

- A group is a **collapsible node**: a disclosure triangle, an editable name (the group's `name`), a lock toggle (the group's `locked`), and its members indented beneath, in paint order (top first).
- Collapsed or expanded is per client (local storage per board), like scope.
- **Selecting** a node selects that item at its level and sets `scope` to its parent so the canvas matches.
- **Dragging** a node within its parent reorders (one `z` write, using the same key arithmetic as the stacking steps); dragging it onto another group's node or out of its group re-parents it (a `parent` write plus a `z` key at the drop place), one undo step. This is the way to take a member out of a group without ungrouping the rest.
- A node shows an "empty" state for a group with no visible members, and the panel is the one place a hidden private-writing member is shown as "hidden item" rather than left out, since it is the owner's own and the count matters. For everyone else it is left out, as on the canvas.

## Templates, history and the rest of the document

- **Custom and built-in templates**: `group` joins the type lists (the two `OBJ_TYPES` of the client and the server; the compiler lists what is missing for the client one) and the validators: a group's `parent` must be a frame or a group of the same template, a member's `parent` a group of the template, no cycles, depth at most 8, at most 500 groups, `name` at most 80 characters, no `locked` (a template does not carry locks). Saving a selection that includes members of a group but not the group itself saves them without a `parent` (their group is not in the set); saving a whole group saves it.
- **`.drift` and JSON**: group objects appear as objects with `type: 'group'`; members carry `parent`. Nothing else changes.
- **History**: snapshots are whole documents; groups are objects in them.
- **Presence and comments**: a comment thread anchors to an object and the point inside it. Threads anchor to **members**, not groups, since a group has no drawn body; commenting on a group in the layers panel anchors to its top member. Moving the group moves the pin because it follows the member.

## Export and other formats

- **SVG and PNG**: members draw as they always have. The SVG wraps each group's contiguous members in `<g id="group-<id>" data-name="<name>">`, which changes nothing visually and lets people who open the SVG in a vector tool find the groups. PNG is the rasterised SVG.
- **Mermaid**: groups are ignored; members export as before.
- **Markdown summary**: members are listed under their frame by `frameOf`; the group's name is not listed.
- **Minimap and zoom to selection**: use the derived rectangle.

## MCP and the other AI tools

- **Reads** (`get_board`, `get_objects`): a group is an object with `type: 'group'`, `name`, `members` (the count of direct members) and its **derived** `x`, `y`, `w`, `h` (the server computes the union with the same rule, minus private-writing notes it withholds). Members show `parent`: the group's id. `get_board {frameId}` returns descendants through groups. The group's name is fenced text like any name.
- **New tools** (write token, editor role, one Yjs transaction each, the same limits as the commands): `group_objects { ids, name? }` (the exclusions and rules above; returns the group id) and `ungroup_objects { ids }`.
- **`update_objects` on a group** may change `name` and `locked`, and **translate** it with `x` and `y` (the server moves every member by the difference). `w`, `h` and `rotation` on a group are refused with `group_transform_unsupported`: scaling and turning need the client's arithmetic, and the server has no second copy of it. Moving the members individually is allowed.
- **`delete_objects` on a group** deletes its subtree and lists the members under `alsoDeleted`. `create_objects` still does not create groups directly.
- **AI features** (TAB-97): the reader that builds the context includes groups so a summary can say "a group called Roadmap with five notes"; `cluster` and `generate` proposals do not create groups in this spec.

## Permissions

Owners and editors group, ungroup and do everything above; commenters and viewers can select (enter and leave a group to look at its members) but cannot change anything, as with any object. In a hosted workspace that is read-only, the same. The relay validates nothing about groups: like every other object, they are fields in a room an editor may write.

## Limits

| Thing | Limit |
|---|---|
| Nesting depth | 8 |
| Direct members of a group | 500 |
| Groups per board | 500 |
| Group name | 80 characters |

Over a limit the command says so and does nothing; MCP returns an error naming the limit.

## Keyboard, touch and accessibility

- `Ctrl+G` and `Shift+Ctrl+G` (`Cmd` on Mac) go in the shortcuts dialog (`src/shortcuts.ts`; its test checks every handler key is documented). `Ctrl+G` is **Find next** in browsers: the handler calls `preventDefault`, as it does for `Ctrl+D`.
- **Touch**: no `Ctrl`, so **Group** and **Ungroup** are buttons in the quick-action bar (which is already how touch reaches duplicate and lock). Entering a group is a double-tap, leaving is a tap on empty canvas or the **Done** chip that shows near a group while it is entered.
- **Screen readers**: the canvas is not keyboard-addressable today; the layers panel (a tree with `aria-expanded` per group node) is the accessible way to reach a member and to group and ungroup. A live-region message says "Grouped 4 items" or "Ungrouped".
- **Entered state** is visible: the rest of the board dims slightly (the dimming that exists for a focused frame step is reused), the group shows a dashed outline and its name above it, and a small **Done** chip leaves.

## Tests

Pure (no DOM, `test/groups.test.ts`, with a `src/groups.ts` of pure functions):

- `pick` climbing through nested groups to a scope; scope changes on enter and leave; selection levels never mix.
- `groupPlan`: which items join, frames and lane children excluded with the count, the group's `z` (highest member), `parent` by the `frameAt` rule, connectors with both ends inside join and the ones with one end outside do not, the member limits.
- `ungroupPlan`: members get the group's parent and keys that keep their order and place, nested groups stay, empty and one-member cases.
- Derived geometry: union of visible members, hidden private notes left out, nested groups, empty group, connectors excluded, invalidation after a member move.
- `ordered()` with groups: contiguous subtrees at the group's `z`, nested order, frames first, an orphan member read as top-level, a cycle stopped.
- Transforms: move, resize (centre mapping with rotated members, `fontSize` clamp, `points`, free connector ends, minimum size), rotate (centres, `rotation` added, snapping), nudge, align and distribute over groups.
- Copy, duplicate and paste remap ids and parents, copy connectors that are members and drop ones with an outside end; delete removes the subtree and an emptied group.
- Lock: effective lock through ancestors, unlock leaves members' own flags, lifting to the outermost locked ancestor.
- Stacking with groups: `planStep` among siblings with a group's derived rectangle, inside an entered scope, equal keys.
- Concurrency with two real `Y.Doc`s and a sync: group against delete of a member, ungroup against move, two groupings of one item, a group deleted while a member is moved, a crossed cycle read safely; after sync both documents order and measure the same.
- Templates: both validators accept good group structure and refuse a cycle, depth 9, a group parent that is not in the template, a member whose parent is a non-group non-frame.
- MCP: `group_objects`, `ungroup_objects`, reads with derived rectangles and `members`, `update_objects` translate and refusals, `delete_objects` with `alsoDeleted`, fencing of `name`.
- Export: SVG wrappers, Markdown summary under the right frame, JSON round trip.

Browser checklist (not CI): group by `Ctrl+G` and from the quick-action bar, click selects the group, double-click enters, `Esc` leaves, drag and resize and rotate a group of mixed objects with connectors, nested groups, lock and long-press unlock, duplicate, undo of each step, two windows editing one group, a phone at 390 px with the buttons.

## Not in this slice

- A layers panel (TAB-107); the nodes are specified above.
- Group rotation stored on the group, non-proportional resize, masking or clipping by a group, group-level styles that outlive the members (a fill that applies to members added later).
- Boolean operations, components and instances (a group that updates its copies).
- Grouping frames, or grouping kanban cards inside a container.
- MCP scaling and rotating a group; AI proposals that create groups.
- Sharing a "which group is entered" state between people.
- Per-group comments.

## Slices

1. **Model and store.** The `group` type in every list (types, both `OBJ_TYPES`, both template validators, `custom-templates`), the child index and `descendantsOf` and `frameOf`, derived geometry through `Store.geometry` and its call sites, `ordered()` with groups, the orphan, cycle and empty-group rules, the limits, and the read-side changes in the table (Markdown summary, AI context, MCP reads). No commands yet.
2. **Group and ungroup, selection and entering.** `groupPlan`, `ungroupPlan`, the commands and shortcuts, `pick`, scope, double-click, `Esc`, marquee and hover, the dimmed entered state and the **Done** chip, `selectedLeaves` for styles, the quick-action and context-menu entries, the properties panel row, the shortcuts dialog.
3. **Transforms.** Move, resize, rotate, nudge, align and distribute, snapping against the derived rectangle, frame drop, member connector joining.
4. **Copy, delete, lock, stacking.** Copy, cut, duplicate, paste; delete and the emptied-group rule; lock and the long-press lift; stacking among siblings (TAB-108 integration).
5. **MCP and export.** `group_objects`, `ungroup_objects`, the `update_objects` and `delete_objects` rules, SVG wrappers, `docs/mcp.md`.
6. **Layers panel node** (its own issue), then the user guide page and the CHANGELOG.

Slices 1 to 4 are the feature. Slice 1 is large because of the read sites; it changes behaviour for nobody until slice 2.

## Files

### New

- `src/groups.ts` (pure: pick, plans, derived union, subtree and ancestor walks, transforms)
- `src/ui/group-ui.ts` (the Done chip and the entered-state outline), `src/ui/group-ui.css`
- the tests above

### Existing (touched)

- `src/types.ts` (`ObjType`, `Group`), `src/store.ts` (child index, `descendantsOf`, `frameOf`, `geometry`, `ordered()`, `restack`), `src/app.ts` (selection scope, `pick`, group and ungroup, `beginMove`, `reparent`, `deleteSelection`, copy and duplicate gathering, keys, hit and marquee, `connectTarget`), `src/geometry.ts` (`objBounds` for groups), `src/render.ts` and `src/markup.ts` (groups are not drawn; selection box and hover), `src/z-order.ts` (siblings, group rectangles), `src/guides.ts`, `src/flow.ts` (summary, vote clicks), `src/exporters.ts` (gathering, SVG wrappers), `src/custom-templates.ts`, `src/shortcuts.ts`, `src/ui/quickbar.ts`, `src/ui/props.ts`, `src/ui/context-menu.ts`, `src/ui/ai-bar.ts`, `src/history.ts` (nothing, noted so nobody adds a case)
- `server/board-ops.mjs` (`OBJ_TYPES`, summaries with derived rectangles, `frameId` through groups, delete rules, the two tools' planners), `server/mcp.mjs`, `server/templates.mjs`
- `README.md` (groups are no longer "not built"), `docs/mcp.md`, `docs/custom-templates.md`, `docs/guide/` (a page when it ships), `CHANGELOG.md`

## Open questions for Johan

1. **Members that are locked on their own, inside a group that is moved or scaled.** Drafted: they are carried along (a lock stops editing the item, not the thing it belongs to). The alternative, refusing to transform a group that contains a locked member, is safer but surprising.
2. **No stored rotation on a group** (drafted), so a turned group is an upright box of turned members. Is that enough, or should a group remember its angle (Figma-like rotated handles), which is more state and more code?
3. **The group takes its topmost member's place in the stacking order** (drafted), which can move members above outside objects that were between them. Alternative: grouping refuses when outside objects are interleaved, or asks.
4. **Style changes on a group apply to the members that have the property** (drafted, as for multiple selection) and are not remembered by the group. Is a group-level fill that survives adding members wanted?
5. **Frames cannot be grouped** (drafted). Should a selection that includes a frame group everything else and leave the frame, or refuse outright?
6. **Joining connectors**: a connector with both ends inside joins the group (drafted). Do you want connectors never to join (simpler: they stay at their level and just follow)?
7. **Double-click enters, `Esc` leaves** (drafted). Should a single click on an already selected group also enter, as some tools do, or should members be selectable by `Ctrl`-click without entering?
8. **Dot votes address the item, not the group** (drafted). Should a group be votable as a whole?
9. **A group with one member is kept** (drafted). Auto-ungroup when a group is down to one, or when it is empty only?
10. **`Ctrl+G` overrides the browser's Find next** (drafted, with `preventDefault`). Acceptable, or use another key?
11. **MCP can translate a group but not scale or turn it** (drafted), because the server has no copy of the client's transform math. Worth building a shared module (`shared/`, as the kanban spec proposes) so the server can do it too?
12. **A private-writing note a person may not see is left out of a group's outline** (drafted) so the outline gives nothing away. In the layers panel the owner sees their own. Is that the right split?
13. **Limits** (depth 8, 500 members, 500 groups). Right for your largest boards?
14. **Template saving**: members of a group saved without their group lose the grouping (drafted). Should the dialog offer to include whole groups?
