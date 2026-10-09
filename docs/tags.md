# Tags

TAB-107. Status: spec for review. Nothing here is built yet.

People ask the same thing of a board that has grown past a screenful: "show me everything about onboarding", "put the bugs on the left and the ideas on the right", "which of these did Ana write", "tag these and let me find them later". Tabula has colours and frames, and nothing that says what an item is *about*. A sticky's colour is a weak tag that people already abuse for this, and a frame is a place, not a property.

This page specifies **tags**: coloured, named marks you put on any item, a manager for them per board, **Arrange by** (lay items out in labelled columns by tag, type, colour or author), **filter and highlight** (dim what does not match, never hide it), select-all-with-tag, chips on items, and how all of it merges between people, works offline, exports, travels in templates, and is reached by MCP and the AI.

It is also the second half of the label model that `docs/kanban.md` already defines for cards, and the point of this page is that there is **one model, not two**: a kanban "label" and a tag are the same record, the same palette, the same manager. Where this page extends that model (any item, not just cards; one key per tag on an item; merge; order), it says which lines of `docs/kanban.md`, `docs/sticky-stacks.md` and `docs/groups.md` change.

## Summary

- **One model.** The board-wide `labels` map (`Y.Map<Label>`, `{ id, name, color, order }`, colours are palette keys) that is already in the store (`src/store.ts`, `src/types.ts`, `shared/containers.mjs`) *is* the tag set. The interface says **Tag**; the map, the type and the field keep the name `labels` because they exist. A kanban card's labels are its tags.
- **Any item can carry tags**: stickies, text, shapes, images, icons, frames, drawings, UML elements, connectors and cards, up to 10 each. Containers, lanes and groups do not (a group's members do; see [Groups](#groups-and-frames)).
- **A tag on an item is one key on that item**, `tag:<labelId>`, not an array. Two people tagging the same item at the same moment with different tags both keep theirs. Everything that reads an item (the renderer, export, templates, MCP, the AI) sees the familiar `labels: Id[]`, which the store builds from the keys. This changes one sentence of the kanban spec (see [Changes to other specs](#changes-to-other-specs)).
- **Applying**: a **Tags** button in the quick-action bar and a row in the properties panel open a checklist with a type-to-create box; the object menu has **Tags**; `#` opens it from the keyboard and `Alt+1` to `Alt+9` toggle the first nine tags. With several items selected a tag is checked, unchecked or **mixed**.
- **The tag manager** is a dialog (**Tags** in the board menu): create, rename, recolour, reorder, **merge** into another tag, **delete**, and **Select all with this tag**, each with the number of items that carry it.
- **Chips** show a tag on its item: a small band along the bottom with up to three chips and a **+n**. A per-person toggle (**Show tags on items**) turns them off. They are drawn into exports when shown.
- **Arrange by** tag, type, colour or author lays the items out in columns with a header each, in one undo step, animated for the person who asked. It is an action, not a mode: afterwards the items are ordinary items.
- **Filter and highlight** is personal and never changes the board: items that do not match draw at 35 % and stay out of marquee and select-all; they are never hidden and never moved. One filter serves the whole board, including kanban containers (the filter in `docs/kanban.md` becomes this one).
- **AI**: a fourth feature, **Tag**, proposes tags and assignments for the selected items as a preview that Add writes in one step; **Cluster** can also tag by group name. The model returns names; the app makes ids, colours and positions.
- **Offline and merge**: all of it is Yjs writes. Concurrent tagging merges per tag; concurrent rename and recolour of one tag, and two people creating the same name, are the two cases that need a rule, and the rule is given for each.

## Decisions and why

1. **One model with kanban labels, called "tag" in the interface.** TAB-107 asks for tags on any item; `docs/kanban.md` already defines a board-wide label set for cards and says it "is deliberately usable for other objects later". Building a second set for stickies would give a board two managers, two colour lists and a card that has labels *and* tags. The map is called `labels` in the store today, with a `Label` type, a `LABEL_COLORS` list and limits in `shared/containers.mjs`; nothing writes to it yet, so a rename would be cheap now and expensive later. It is **not** renamed: the word people see is **Tag** (Johan's word in TAB-107, and the one on sticky notes in everyday speech), the file format and code keep `labels`, and one sentence in the developer docs says so. The alternative (rename the map to `tags`) is in the open questions.
2. **One key per tag on the item, not an array.** `docs/kanban.md` stores `labels` as an array replaced whole and accepts that two people toggling labels on one card can lose one (its open question 11). That is tolerable on a card. It is not on a retro board where a facilitator tags forty stickies "Went well" while a colleague tags some of the same stickies "Process": whole-array writes would silently drop one of the two tags on every sticky both touched. A Yjs map takes concurrent writes to *different keys* of the same object without loss, so a tag is a key: `tag:<labelId> = 1` on the object. Removing a tag deletes the key; a concurrent set and delete of the same key keeps the set (add wins), which is the right way round for a tag. The cost is that the stored shape differs from the in-memory shape (below), and that old data written as an array (none exists yet, and `.drift` or template files may carry it) has to be read.
3. **Tags are on items, not on containers, lanes or groups.** A container's size and a lane's place are derived; they are structure, not content, and a filter that dims a lane while its cards stay lit is confusing. A group is a bundle: tagging a group means tagging what is in it, which is what the user means and what the groups spec already does for style (`docs/groups.md`, "style changes on a group apply to the members that have the property").
4. **Arrange is an action, not a mode.** A live "this board is always grouped by tag" would need a layout that owns positions and stays in step with every tag change from every person (the kanban spec's container model, which is a large thing and a different product). **Arrange by** instead writes positions once, as one undo step, and leaves the items free. The AI's Cluster already works this way (`docs/ai.md`: "moves the listed stickies into columns under their titles"), and the two share one layout function so they look the same.
5. **Dim, never hide, and keep the filter personal.** Hiding items changes what a person believes is on the board and makes a shared board mean different things to different people during a session. The kanban filter already decided this: matching items at full strength, others at 35 %, not in marquee, never saved in the board. This page generalises that filter to the whole board and removes the kanban-only copy.
6. **Colours are the eight sticky palette keys, with names.** `yellow, orange, pink, violet, blue, teal, green, grey`, drawn from the theme's `--s-*` variables, so tags are readable in every theme (the kanban spec's contrast table covers them) and the house rule that new colours are CSS variables holds. A chip always shows the name too, except at the smallest size where it shows a swatch and the name is in the accessible text and the tooltip: colour is never the only signal.
7. **First-tag-wins for Arrange by tag.** An item with three tags cannot be in three columns without being copied, and copying items in an arrange action would be surprising. It goes in the column of its first tag **in the manager's order**, and keeps all its tags (the chips still show them). Reordering the tags changes where such items land the next time. The alternatives are in the open questions.
8. **The AI proposes names; the app does everything else.** As for every AI feature (`docs/ai.md`): the model never sees or returns ids of tags it invents, never chooses colours or positions, and its output is a *proposal* shown as a preview that Add writes with `store.transact`, so it has the person's undo, the board's read-only rules and live sync.

## The model

### The tag set

`labels` is the existing board-wide `Y.Map<Label>` keyed by tag id:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | The key, made with `newId()` (as for every object). |
| `name` | string | 1 to 40 characters after trimming and collapsing spaces; no line breaks. Unique ignoring case **on this client's view**; see [Two people create the same name](#concurrency-and-offline). |
| `color` | palette key | One of `LABEL_COLORS` (`shared/containers.mjs`). An unknown key draws as `grey`. |
| `order` | number | Sort position in the manager, in chips, in the checklist and in Arrange by tag. A reorder writes the moved tag's `order` between its new neighbours (the average; all tags are renumbered 1, 2, 3 and so on when two neighbours are closer than 1e-6). |

Each value is written whole, as polls are. At most **30 tags per board** (the kanban limit, `LIMITS.labels`).

### A tag on an item

An item's Y.Map gets one key per tag it carries:

```
tag:<labelId>  →  1
```

- **Reading.** The store builds its plain-object cache with `m.toJSON()` (`src/store.ts`, in the initial load and in the change observer). That one place folds the keys into a field: `labels: Id[]` is the tag ids, in the order of the tag set (`order`, then id), the `tag:` keys are not copied into the cached object, and tag ids no longer in the set are dropped from the array (they stay in the stored map until a sweep removes them). Every consumer that reads `o.labels` (renderer, export, templates, MCP, the AI reader, the kanban card) sees the array the kanban spec describes. The same fold exists once in `shared/tags.mjs` for the server, which reads documents directly (`server/board-ops.mjs`, `server/templates.mjs`).
- **Legacy form.** An item may also carry a plain `labels` array: written by an older build, copied in from a `.drift` or JSON file, or from a template. Reading unions it with the keys. The first write to the item's tags removes the array and writes keys in the same transaction.
- **Writing.** One entry point, `Store.setTags(ids, { add, remove })`, inside `transact`: for each item it sets `tag:<id>` for `add`, deletes it for `remove`, skips locked items and items over the 10-tag limit, and returns what it skipped so the UI can say so. `create()` and `update()` accept `labels: Id[]` as before and translate it to keys, so existing callers (paste, duplicate, templates, import) keep working. Nothing writes the array form.
- **Unknown tag ids** (a key whose tag was deleted by someone else while it was being added) are ignored on read and removed by the next `setTags` on that item and by **Tidy** in the manager (below).
- **Limit.** 10 tags per item (`LIMITS.labelsPerCard`, now for every item). An eleventh is refused with "An item can have 10 tags".
- **Which items.** Everything that is not a `container`, a `lane` or a `group`. A locked item cannot be tagged (it cannot be edited), and Arrange and select-all skip it.
- **Version skew.** An older client that does not know tags shows no chips and no filter, ignores the extra keys and preserves them when it edits other fields. It writes a copy of an item (duplicate, paste) from its cache, which lacks the tags, so a duplicate made by an old client is untagged. That is a small loss and no gating is needed, unlike containers, which open read-only in clients that do not know them (`meta.features`).

`shared/tags.mjs` (with a `.d.ts`, like `shared/containers.mjs`, and copied by the Dockerfile) holds the pure parts: the key prefix, `foldTags(rawObject, labels)`, `setTagKeys(...)`, name normalisation and the uniqueness test, `orderBetween`, palette helpers, the limits, and the merge and sweep planners. The client store, the relay's board operations, the template validator, MCP and the tests all use it, so the model has one definition.

### Derived data

The store keeps an index `tagId -> Set<itemId>`, maintained in the same observer as the connector index (and the container child index in the kanban spec), so the manager's counts, the filter and select-all never scan the board. Counts exclude items hidden from this person (private writing, below).

## Applying tags

A tag can be put on or taken off in four places, all calling `Store.setTags`:

1. **Quick-action bar, Tags** (a tag icon, after Colour). It opens a popover with a search box and a checklist of the board's tags in manager order: each row is a swatch, the name and a check. The search filters the list; if nothing matches, the first row is **Create "<text>"**, and **Enter** creates the tag (next unused palette colour, last in order) and applies it. With several items selected a row is **checked** (all have it), **unchecked** (none) or **mixed** (some); a click on a mixed row applies it to all. A **Manage tags…** link at the bottom opens the manager. Nothing is saved on a button: each click is a write and one undo step per click, merged within 600 ms so toggling three tags is one undo.
2. **Properties panel, Tags row**: the item's chips with a **+** that opens the same popover, and a remove cross on each chip. With a multiple selection the row shows the chips every selected item has, then a mixed marker.
3. **Object menu (right-click, and the menu key once the canvas has one, `docs/canvas-keyboard.md`): Tags ▸** with the same checklist as a submenu on pointer and as the popover on keyboard.
4. **Keyboard**: `#` opens the popover for the selection (it matches the character, not a key position, so it works on every layout); with the popover closed, **`Alt+1` to `Alt+9` toggle the first nine tags** in manager order on the selection (all get it if some lack it, else all lose it), announced as "Tag Bug added to 3 items". Neither key is used today; both go in `src/shortcuts.ts`, and the shortcuts test enforces that.

Rules shared by all four:

- **Roles.** Owners and editors apply tags. Commenters and viewers see tags, chips and the filter and cannot change them (the buttons are hidden, as the rest of the bar is).
- **Locked items** are skipped, and the message says how many ("2 locked items skipped").
- **Over the limit** (10 on an item, 30 on the board) says so and changes nothing for those items.
- **Hidden items.** An item hidden by private writing is not selected by marquee or select-all, so it is never tagged by accident. A person tagging their own private note sees its tags; others see nothing of the item (see [Private writing](#private-writing-reveal-and-leaks)).
- **Groups.** With a group selected the popover edits **its members** (all of them, recursively), and the checklist counts members, as the groups spec does for style.
- **Dragging a tag onto items** from the manager is a later addition (not in this spec).
- **Copy and paste** keep tags: copied items carry `labels` ids, paste writes them as keys. Pasting into a board that lacks the tag ids (another board) goes through the same merge-by-name that templates use (below), so the tags arrive with their names and colours instead of dangling.

## The tag manager

**Board menu, Tags…** opens a dialog (a full-width sheet at 860 px and below). Owners and editors manage; everyone else can open it read-only to see the tags and the counts.

The dialog is a list, one row per tag in manager order:

```
[swatch ▾]  Bug              14 items    ⋯
[swatch ▾]  Idea              9 items    ⋯
[swatch ▾]  Process           3 items    ⋯
[ New tag…                            ] [Add]
```

- **Swatch**: a button that opens the eight palette colours as a radio group with names (roving arrows, as every radio group now does) and writes `color`.
- **Name**: edited in place; **Enter** or leaving the field saves, **Esc** reverts. Renaming changes only the tag's value in `labels`, so every chip and the AI, MCP and CSV readings follow at once. A name that duplicates another (ignoring case) is refused with "There is already a tag called Bug", with a **Merge into Bug** button in the message.
- **Count**: how many items carry it that this person can see. A tag with none says "Not used".
- **⋯ menu**: **Select all with this tag** (selects the matching items that are not locked and closes the dialog), **Show only this** (sets the personal filter to this tag, [below](#filter-and-highlight)), **Move up**, **Move down**, **Merge into…** and **Delete**.
- **Merge into…** opens a menu of the other tags. It writes, in one transaction: for each item with the source tag, add the target and remove the source; delete the source from `labels`. A text like "Merge Process into Bug? 3 items change; 1 already has Bug." is shown first. The result is one undo step, items over the 10-tag limit keep both tags and are reported.
- **Delete** asks once ("Delete Bug? It is on 14 items and is removed from all of them."), then in one transaction removes the keys from every item and deletes the tag. One undo step brings the tag and every key back, because the sweep and the delete are in the same transaction and the `labels` map is in the board's undo scope (it is: `src/store.ts` lists it). The confirmation uses the existing dialog and, as everywhere, the second click is the confirmation.
- **New tag**: type a name and **Enter**: created in the next unused colour, last in order. Disabled with the reason at 30 tags.
- **Tidy** (shown only when it has something to do, "2 unused references"): removes keys that point at deleted tags from items, in one step. It is also run silently on the first edit of an affected item.
- **Duplicate names** (two people created "Bug" at once) are shown with a notice at the top, "2 tags are called Bug", and a **Merge** button.

The list has 30 rows at most. The dialog is an ordinary `dialog()` (focus trap, named, focus returns to the opener) and every control is a real button or input with a name.

## Chips on items

A chip is a small rounded label: a swatch-coloured fill from the theme (`--s-<color>`), the name in `--sticky-ink`, 11 px, 16 px high, with a 1 px border in `--sticky-ink` at 40 % so a chip is still visible on an item of its own colour.

- **Where.** A band along the bottom of the item **inside** its bounds, 22 px high including padding, only when the item has tags and chips are shown. Stickies, shapes with room, text boxes with a fill, images, frames (in the title strip's right side), cards (the kanban card's label row, which this replaces).
- **How many.** Up to three chips, in tag order, then a **+2** chip. Names are never cut mid-word at the larger sizes; below 100 px of item width a chip shrinks to a **swatch dot** and the name is in the item's accessible description and a tooltip. Below 48 px nothing is drawn (the filter and the outline still work).
- **Text fitting.** The item's text area is the item minus the band, so adding a tag never makes text overflow: the fitting code (`fitText`) is given the size minus the band, the same arrangement `docs/sticky-stacks.md` makes for its corner label (one band, two users: when a note has a pad label and tags, the pad name is shown as its tag chip and the corner label is not drawn; see [Sticky stacks](#sticky-stacks)).
- **Toggle.** **Show tags on items** in the manager and in the **View** part of the board menu. It is per person and per browser (`localStorage`, `tabula:tags:chips`, wrapped in try/catch like other local state), default **on**. It changes only drawing; the band space is released when it is off, so text fitting returns to normal.
- **Exports.** PNG and SVG export draw chips if they are shown at that moment, with a checkbox in the export dialog. The JSON and `.drift` exports carry the tags as data, not chips.
- **Theme and contrast.** The chip text is the sticky ink on the palette swatch, 9.3:1 or better in every theme (the kanban contrast table), and the border and the name keep colour from being the only signal.
- **Pointer.** Clicking a chip on a selected item opens the Tags popover; with the filter popover open it adds that tag to the filter. Chips do not take focus (the outline and the properties panel are the keyboard routes).

## Arrange by

**Arrange by** lays items out in labelled columns by a chosen property. It is in the quick-action bar when two or more items are selected, in the object menu, and in the board menu under **Arrange by** for the whole board:

| By | Columns are | Order of columns |
| --- | --- | --- |
| **Tag** | One per tag in use, plus **No tag** last | The manager's order |
| **Type** | Sticky notes, Text, Shapes, Images, Frames, Drawings, Icons, UML, Cards | That fixed order, only those present |
| **Colour** | One per fill colour in use, named by `colorName()` (`src/palette.ts`, "Yellow", "Blue", "Light grey"), plus **No colour** | Sticky palette order, then other colours by hue |
| **Author** | One per person who created items (`createdBy`), plus **Unknown** | Alphabetical by name, you first |

### Scope

- With **two or more items selected**: those items.
- With **nothing selected** (the board menu): every item on the board that is not locked, not hidden from this person, not a connector, and **not inside a frame, group or container** (those travel with their parent). Frames are items: a frame moves as a unit with its contents and is placed in the column its own tag, type (**Frames**), colour or author gives it.
- A selection that includes items inside a frame arranges them within that frame's bounds instead (their parent is the context), and says so ("Arranged 9 items inside Ideas").
- **Connectors** are not placed. Connectors bound to items follow them; free ends stay where they were.
- **Locked** items stay put, and are counted in the message ("3 locked items were left in place").
- **Items hidden by private writing** are not part of the scope and are never moved, so Arrange cannot reveal that a note exists or who wrote it.

### The layout

A pure function, `planArrange(items, by, options)` in `src/arrange.ts`, returns the new `x`, `y` of each item and the headers to create. The AI Cluster's "move the stickies into columns under their titles" calls the same function with the groups the model proposed, so both give the same picture.

1. **Groups**: each scope item gets a group key (its first tag in manager order; its type; its colour name; its author), unknown keys go to the last group. Groups with no items are not drawn. At most **24 columns**; beyond that the smallest groups merge into **Other** (a message says so). An unnamed or blank key is "No tag", "No colour" or "Unknown".
2. **Within a column**: items keep their **current reading order** (rows then columns with a tolerance of half the median item height, the same order as `docs/canvas-keyboard.md`), so arranging does not scramble a board someone had already laid out sensibly. Ties by `z`.
3. **Column geometry**: width is the widest item in the column (at least 160, at most 480); items stack top to bottom with a 16 px gap; columns are 40 px apart; a header sits 16 px above the first item.
4. **Origin**: the top-left of the scope's bounding box (the whole board's content box for the board menu), so the result appears where the content was. Items outside the scope are not moved, so a result can overlap them; the message offers **Undo**.
5. **Headers**: one **text object** per column, bold, 18 px, in the theme's ink, reading `Bug (14)`: ordinary text, editable and deletable afterwards. They are created by the arrange transaction and are not linked to anything (renaming a tag later does not rename the header; the next Arrange makes new ones). Headers from an earlier Arrange are not removed or reused (see the open questions: an alternative is to make each column a frame).
6. **In frames** (a checkbox in the popover, remembered per person): instead of header text each column becomes a **frame** titled with the group name, and the items are its children, so a column moves as one. Off by default.
7. **One transaction.** All position writes and header creations happen in one `store.transact`, preceded by `undo.stopCapturing()`, so **one undo** restores every position and removes the headers.

### Animation

The person who arranged sees the items glide from where they were to where they go: the renderer marks the board `arranging` for 400 ms and gives object transforms a CSS transition, then removes it. Under `prefers-reduced-motion` there is no transition. Other people receive the writes as ordinary updates and see the items jump. The animation does not delay the write.

### Items with several tags

Arrange by tag puts an item in the column of its **first tag in manager order** and does not copy it. The column header's count is of items placed there, not of items that carry the tag, and a short line under the message says "5 items have more than one tag and are in the column of their first tag". The "Show only this" filter (below) is how you see everything with one tag regardless of where it landed.

### Messages and keyboard

A toast says "Arranged 23 items by tag in 4 columns" with **Undo**. The announcer says the same, with the column names for four columns or fewer. The popover is a real menu: `Arrow` keys choose, `Enter` runs, `Esc` closes. A keyboard-only person selects with `Space` (once the canvas has focus, `docs/canvas-keyboard.md`) and runs it from the quick-action bar or the object menu.

## Filter and highlight

A **Filter** button sits in the top bar (next to the sync pill) and in the Tags popover. It opens a popover:

- **Tag**: chips of the board's tags, with **any of** or **all of** (a two-way switch).
- **Type**: Sticky notes, Text, Shapes, Images, Frames, Drawings, Icons, UML, Cards.
- **Author**: **Mine**, or people (by name).
- **Colour**: the palette colours in use.
- **Text**: a box that matches item text, case-insensitively.
- **Match counts**: "14 of 63 match" and **Clear**.

Criteria combine with **and** across kinds and **or** within one (any of the chosen types, any of the chosen authors), except tags, which have the any/all switch.

**What it does.** Matching items draw at full strength. Items that do not match draw at **35 % opacity** and are **left out of marquee selection and of Select all**, and nothing is hidden or moved. A direct click on a dimmed item still selects it, so nothing is ever unreachable, and connectors drawn between dimmed items dim with them. An active filter shows as removable chips in the top bar and as a band across the top of the canvas, "Showing 14 of 63. Clear", so a person who forgot they set it is told. It is **personal and never saved in the board**: kept in memory and in `localStorage` per board (`tabula:filter:<board>`, in try/catch). Viewers filter too.

- **Select matching**: a button in the popover selects every matching item that is not locked (what **Select all with this tag** does for one tag).
- **Highlight on hover**: hovering a tag in the Tags popover or the manager outlines the items that carry it with a 2 px ring in the tag's colour for as long as the pointer is there, without changing the filter. That is the quick "where are they" without commitment.
- **Fly to**: **Fit to matches** in the popover moves the view to the matching items' bounds (the same fly "fit selection" uses).
- **With kanban**: a container's own **Filter** button in `docs/kanban.md` opens this same popover pre-set to cards of that container; its owner, label, due and text criteria are criteria of this filter (due is added as a card-only row). The filter's state is one object per person per board, so a kanban filter and a board filter cannot disagree.
- **With private writing**: items hidden from the person are not counted and not shown, with or without the filter.
- **Exports and presenting**: the filter does not affect exports. Following or presenting someone does not copy their filter.
- **Rendering**: `Renderer.setDim(predicate)` multiplies the opacity of each dimmed object's group; it is applied on invalidate and costs one pass, no DOM per tag.

### Select all with a tag or type

From the manager (**Select all with this tag**), the filter (**Select matching**) and the object menu with a sticky selected (**Select all with the same tag ▸**, **Select all of this type**): selects, replaces the selection, skips locked and hidden items, and announces "Selected 14 items with Bug". Selecting by type or colour from an item is the same function with a different predicate.

## Concurrency and offline

All writes are Yjs map writes, so everything merges and works offline; tags added while offline are in the document that syncs when the connection returns.

| Case | What happens |
| --- | --- |
| Two people add different tags to the same item | Both keys exist: both tags are kept. |
| Two people add the same tag to the same item | One key; no conflict. |
| One adds a tag, another removes it from the same item at once | The add wins (a concurrent set and delete of one key keeps the set). |
| One deletes a tag while another is tagging with it | The delete removes the keys it can see; a key added in between is orphaned. Readers ignore unknown tag ids and the next write to that item (or **Tidy**) removes the key. |
| Two people rename or recolour one tag at the same moment | Whole-value write per tag: the last write wins, and one of the two edits is lost. It is visible (the name or colour on screen is the winner's) and rare; making `name` and `color` separate keys would cost an extra map per tag for a case that is a typo race. |
| Two people create a tag with the same name at once | Two tags with the same name exist until someone merges them. The manager says "2 tags are called Bug" with **Merge**. |
| Two people merge or delete at once | The first transaction's result is merged with the second's; both are idempotent over keys, so the outcome is "tag gone, items carry the target" in every ordering. |
| An item is deleted while being tagged | The write is to a key of a deleted object and is dropped. |
| Two people arrange at once | Each writes `x` and `y` of the same items: last writer wins per item and the board may end up half in one arrangement. Rare; undo works per person. A facilitator should arrange alone. |
| Someone filters while another tags | Filters are local; the match set updates with the change. |
| Offline for hours, then reconnect | The union of everyone's key writes; positions from an offline arrange overwrite later moves of the same items by others (last writer wins). |

**Undo** is each person's own: setting a tag, merge, delete, Arrange and AI Add each use `store.transact` with the board's undo manager, which tracks the objects, meta and the `labels` map. History restore (`docs/history.md`) brings back the tags with the items because both are in the document.

## History, import and export

- **`.drift`** carries the whole document, so tags, their keys and the `labels` map are in it; reading it back restores the tags exactly.
- **JSON snapshot** (`toJson`, `src/exporters.ts`) gains a top-level `labels: Label[]` in order, and each object a `labels: Id[]` as before; importing a JSON file without a document creates the tags and the keys (`BoardJson` and its validator accept the field; unknown fields still survive).
- **Markdown summary** (`flow.summaryMarkdown`) adds the item's tag names after its text as `#Bug #Idea` when any, for items the person may see; the summary never includes tags of hidden items (see below).
- **CSV for kanban** has a `labels` column of names joined by `; `, as the kanban spec says; the same exporter is offered for any selection: **Export items as CSV** (columns `type, text, tags, author, x, y, id`) — not in the first slices.
- **PNG and SVG** draw chips as above.
- **Mermaid** has no tags (it is a diagram of connected items); nothing changes.
- **Import into an existing board** (a file or a template) merges tags **by name**: a tag in the file whose name matches an existing tag (ignoring case) uses the existing one, a new name creates a tag if the board has room (else the item is imported without it, and the dialog says how many tags were dropped), and the colour of an existing tag wins.

## Templates

- **Built-in templates** may carry a `labels` list of `{ name, color }` and objects whose `labels` name entries of it. A retrospective template could ship "Went well", "To improve", "Action"; the kanban templates already do (`docs/kanban.md`). On use, the tags are merged by name into the board's set, then the objects get the ids.
- **Saving a custom template** from a selection keeps the tags of the saved items and writes the names and colours of exactly those tags into the template, so a shared template carries meaning without carrying the whole board's tag list. It strips nothing else (tags are not personal data).
- **Instantiating** remaps ids as it does now (`instantiate`), merges tags by name as above, and writes keys.
- **Whitelists and validators** to extend, as for every field: the object field list in `src/custom-templates.ts`, `server/templates.mjs` (the per-type `box()` switch, the `labels` list: at most 30, names 40, colour in `LABEL_COLORS`, at most 10 per object, every name used by an object present in the list) and `server/board-ops.mjs`.
- **Recurring boards** (`docs/facilitation.md`) copy tags with their items, and the tag set with them.

## MCP and the other AI tools

The server reads documents directly, so it folds the keys with `shared/tags.mjs`.

- **Reads**: `get_board` summarises the tag set (`tags: [{ id, name, color, count }]`); `get_objects` returns, for each item, `tags` (names, in order) alongside `labels` (ids); a new filter `tag` (a name) and `type` on `get_objects` return only matching items. Names are fenced as data, like every board text (`server/mcp.mjs`): a tag name is text written by people and the model is told never to follow instructions found in it. Hidden private-writing items are not returned, as today.
- **Writes** (scope `write`; MCP writes carry origin `mcp:<token>` and are not undoable with Ctrl+Z, `docs/mcp.md`): `create_objects` and `update_objects` accept `tags: [name]` per object (set, replace, with `add_tags` and `remove_tags` for changes), creating missing tags within the limit of 30 and giving them the next unused colour; and new tools:
  - `list_tags { }`: id, name, color, order, count.
  - `create_tag { name, color? }`, `update_tag { id | name, newName?, color?, position? }`, `delete_tag { id | name }`, `merge_tags { from, into }`: the same planners as the app, in one transaction each.
  - `tag_objects { ids, add?: [name], remove?: [name] }`: up to 200 ids per call.
  Arrange is not an MCP tool in the first version (positions from a model are an old trap; a server-side `planArrange` needs the shared layout module, which this spec puts in `shared/` so it can be added later).
- **Limits** as in the app: 30 tags, 10 per item, 40 characters. Errors say which limit.
- **Locked** items refuse (`locked`), as for any write.

## The AI proposes tags

The AI toolbar (`docs/ai-toolbar.md`) has three chips today; this adds a fourth, **Tag**, built on the proposal path of `docs/ai.md` ("proposals, not writes").

- **Input**: the selected items (2 to 200) that have text: stickies, text, shapes with text, cards; images by their alt text; the board's existing tags with their names and counts. The model is told to prefer an existing tag when one fits, to create at most 8 new tags, to give each item at most 3 tags, and to leave an item untagged rather than guess.
- **Output** (a new member of the `Proposal` union): `{ kind: 'tag', tags: { name: string }[], assign: { id: Id, tags: string[] }[] }`. Names only: **no ids of tags, no colours, no positions** come from the model.
- **Validation** in the app (and in the relay before it forwards): every `id` must be one of the input ids; a name is trimmed and collapsed and, matched ignoring case, **reuses an existing tag**; new names are counted against the board limit (30), the per-item limit (10) and the per-run limit (8 new tags, 3 per item); duplicates are merged; anything else is dropped, and the preview says how much.
- **Preview** (the AI bar's preview state): ghost chips on the affected items in the colour each new tag would get (the next unused palette colours, chosen by the app), a summary "Adds 3 new tags and tags 14 of 18 items", **Add to board** and **Discard**. Add is **one `store.transact`**: new tags first, then the keys, then the toast "Tagged 14 items. Arrange by tag?" with **Undo** and an **Arrange** button that runs Arrange by tag on the same items.
- **Cluster** keeps its proposal (`group`) and gains a checkbox in the preview, **Also tag them with the group names** (off by default): Add writes a tag per group, reusing existing names, and the moved stickies get it.
- **Entry points**: the **Tag** chip; **Suggest tags** in the quick-action bar's Tags popover when two or more stickies are selected; and the board menu. All hidden when AI is off and disabled for viewers and commenters, like the others. A free-text prompt can steer it ("tag by customer segment"); an empty prompt is fine.
- **Admin**: the AI tab's feature list gets **Tag stickies** (selected by default, like the others); the effort level is `medium`; the limits, keys and credits are the existing ones. The input is the same class of board content that Cluster sends (up to 400 objects and 60,000 characters, nearest the selection first).
- **Privacy and safety**: text of hidden private-writing notes is never sent; board text is untrusted data in the prompt (as for the other features), and a tag name that looks like an instruction is just a name. The prompt is never shown to other people, only "Tag" and the count (the AI bar's presence rule).
- **Why not let the model arrange?** The model never writes positions; Arrange by tag is the deterministic layout, and the toast offers it, so the result is predictable and the same as a person's.

## How it fits the rest

### Kanban

Cards use the same tags (their `labels` array is the folded view). The card dialog's labels row is the Tags popover; the **Labels** dialog of the kanban spec is the tag manager; a lane header's colour is still its own `fill`, not a tag. The card's chips are the standard chip row. The kanban filter popover becomes the board filter pre-set to the container's cards. Changes to `docs/kanban.md` are listed [below](#changes-to-other-specs).

### Sticky stacks

A pad's name travels as a tag: the pad gets an optional `tagId`; the first time a note is torn from it, the app finds the tag named like the pad (ignoring case) or creates it in the pad's palette colour, stores `tagId`, and puts that tag on the torn note. Renaming a pad renames its tag **only while the tag's name still equals the pad's old name** (so a person who renamed the tag on purpose is not overwritten). Deleting the pad leaves the tag. The note's corner label (`stackName`) is drawn only when chips are off; with chips on, the tag chip is the label, so one band serves both and the fitting code is given one reservation. `Remove tag` on a torn note removes `stackId`, `stackName` and the pad's tag key. A torn note's owner initials are unchanged.

### Groups and frames

A group is not taggable (decision 3); with a group selected the Tags popover edits its members, as style does. A frame is an item: it can be tagged, filtered, arranged, and shows chips in its title strip; its children are separate items with their own tags. Filtering dims a frame and its children independently (a dimmed frame does not dim a matching child); moving an item between frames does not change its tags.

### The canvas keyboard

`docs/canvas-keyboard.md` gives the focus ring, the outline and the object menu key. This spec adds to the outline item's **description** the tags ("Tags: Bug, Idea") and, in the visible outline panel, chips on each row; `#` and `Alt+1` to `Alt+9` work on the keyboard selection; Arrange by and Filter are reachable from the quick-action bar and the board menu, never only by pointer.

### Private writing, reveal and leaks

A tag on a hidden note is part of the note: it is not counted, filtered, listed in a count, exported, or sent to MCP or the AI for people who may not see the note, and tag names themselves are board-wide (a person who writes a tag name that quotes a hidden note has put that text on the board). The tests that keep hidden notes out of what other people see (`test/flow.test.ts`, `test/board-ops.test.ts`, `test/mcp-accounts.test.ts`, `test/history.test.ts`, and the cross-output reveal test that `docs/facilitation.md` plans) gain the tag counts, chips, the filter's match count, the manager's counts and Arrange's scope. Arrange by author never moves a hidden note, which would show who wrote it.

### Comments, votes, polls

Unchanged. A vote or a comment is on the item whatever its tags. Dot-vote results can be shown "by tag" later (not in this spec).

### History

Tag changes are ordinary object and map changes, so version history and its restore (`docs/history.md`) cover them. The version list shows the same one-line summaries it shows now; it does not add one for tags.

## Permissions

| Role | Tags |
| --- | --- |
| Owner, editor | Apply, create, rename, recolour, reorder, merge, delete tags; Arrange; use AI Tag |
| Commenter | See tags and chips; use the filter, highlight and select matching (selection only); comment on tagged items |
| Viewer | See tags and chips; use the filter and highlight |
| Guest | As the role the board gives them |

Read-only workspaces (a hosted workspace that is over its limits) are read-only for tags too.

## Limits

| What | Limit |
| --- | --- |
| Tags per board | 30 |
| Tags per item | 10 |
| Tag name | 40 characters |
| Columns in Arrange | 24 (the rest go to **Other**) |
| Items in one Arrange | 2,000 |
| Items in one AI Tag run | 200 selected, 400 objects of context |
| New tags per AI run | 8; tags per item per AI run 3 |
| MCP `tag_objects` | 200 ids per call |
| Chips per item drawn | 3, then **+n** |

## Accessibility

- Every control is a real button, checkbox or input with a name; the checklist is a group of checkboxes (mixed uses `aria-checked="mixed"`); the palette is a radio group with names; the manager and the filter are `dialog()` and `popover()` with focus managed (slices 1 and 2 of the audit).
- Colour is never the only signal: chips carry names, the dot form has the name in the tooltip and in the outline description, Arrange headers are text.
- Announcements go through `announce()`: "Tag Bug added to 3 items", "Merged Process into Bug, 3 items", "Arranged 23 items by tag in 4 columns", "Showing 14 of 63", "Filter cleared".
- Dimming keeps the contrast of what is lit and does not change the text of anything; a dimmed item stays focusable and readable by a screen reader (the outline is unaffected).
- Reduced motion removes the Arrange animation and the hover pulse.
- The filter band across the canvas and the chips follow the five themes' variables (`--s-*`, `--sticky-ink`, `--canvas-ink`) and are added to the theme contrast tests.

## Tests

Pure modules, no browser:

- `shared/tags.mjs`: folding keys and the legacy array (order, dedupe, unknown ids), `setTagKeys`, name normalisation and the case-insensitive uniqueness, `orderBetween` and renumbering, the limits, the merge planner (including items over the limit and items that already have the target), the delete and sweep planners, and the merge-by-name import.
- `src/arrange.ts`: columns by tag (first-tag rule, No tag last), type, colour, author; the 24-column cap and **Other**; reading order inside a column; widths and gaps; origin; scope rules (selection, board, frame children, locked, hidden, connectors); headers; the in-frames variant; determinism (same input, same output).
- `src/filter-logic.ts`: and/or across kinds, any/all for tags, text match, counts, persistence round trip, hidden items excluded.
- AI: proposal validation (unknown ids, name reuse, limits, duplicates), the preview summary, the Cluster tag option.
- Store: the fold in the cache, `setTags` with locks and limits, `create` and `update` translating `labels`, the undo of merge and delete in one step, the version-skew read of an array-form item.
- Exporters and templates: JSON and `.drift` round trips, merge by name, validator rules, saving a custom template with tags, built-in templates.
- MCP: reads with names, `tag_objects`, `merge_tags`, fencing of names, limits, hidden items.
- Leaks: the hidden-note tests listed above, extended.
- Two-client merge tests with two Yjs docs: concurrent tagging, add versus remove, delete versus tag, rename versus recolour, merge versus tag, create-same-name.

DOM tests (the fake DOM): the popover's tri-state and create row, the manager's rename, duplicate refusal and merge flow, the filter popover and band, chips toggle.

Browser (Playwright): apply by click and by `#`, chips visible and the toggle, Arrange by tag on a retro board with the animation off and on, filter dimming and select matching, the manager on a phone width, five themes, axe.

Manual: a retro with eight people tagging at once; an affinity session with the AI Tag on 60 stickies; offline tagging and reconnect.

## Not in this slice

- Tag **groups** or hierarchies, nested tags, tag values (`priority: high`), and colours beyond the eight palette keys.
- Tags on **comments**, on **boards** (a board list's "tags") or on templates beyond what they carry.
- **Live** grouping that follows tag changes (a "grouped by tag" container); the kanban container is the model for that and is a different spec.
- Dragging a tag from the manager onto items; tag **shortcuts the person defines**.
- Arrange **clusters** (islands in two dimensions) and "arrange by" any other property (due date, owner of a card, votes); both fit `planArrange` as a new group key.
- Showing **votes by tag** and tag statistics in the summary.
- **CSV import**, and the CSV export of arbitrary items.
- Replacing the headers of an earlier Arrange.
- A server-side `planArrange` and the MCP Arrange tool.

## Slices

1. **The model.** `shared/tags.mjs`, the fold in the store cache, `Store.setTags`, translation in `create` and `update`, the per-tag index, limits, the legacy array, types and `BoardJson`, store and two-client tests. No screen yet; kanban cards already read `labels`.
2. **Apply and manage.** The Tags popover (quick-action bar, properties panel, object menu, `#`, `Alt+1` to `Alt+9`), the manager dialog with rename, recolour, reorder, merge, delete, Tidy and the duplicate notice, announcements, shortcuts.
3. **Chips.** Drawing, the band and text fitting, the toggle, exports, theme and contrast tests; coordination with the stacks label band.
4. **Filter and highlight.** The popover, dimming in the renderer, select matching and select all with a tag or type, hover highlight, fit to matches, the band, persistence, the kanban filter becoming this one.
5. **Arrange by.** `planArrange`, the popover, headers and the in-frames option, the animation, the messages; the AI Cluster using the same function.
6. **Export, import and templates.** JSON and `.drift` checks, merge by name on import and paste, markdown summary, template validators and saving, built-in retro tags.
7. **MCP.** Reads, the writes and the new tools; the fencing and the leak tests.
8. **AI Tag.** The feature, the proposal kind and validation, the preview, the Cluster option, admin switch, entry points.
9. **Stickies and guides.** The sticky stack link, the guide page, the shortcuts dialog rows, the audit probe, the manual checks.

Slice 1 is safe on its own and can ship with the kanban slices; 2 to 4 are the user-visible core; 5 depends on 1 and on the reading order of `docs/canvas-keyboard.md` only for the in-column order (it falls back to `y` then `x` if that module is not built).

## Files

- New: `shared/tags.mjs` and `shared/tags.d.ts`, `src/tags.ts` (client glue: the popover state, hover highlight), `src/arrange.ts` (pure), `src/filter-logic.ts` (pure), `src/ui/tags-popover.ts`, `src/ui/tags-dialog.ts`, `src/ui/filter.ts`, `src/ui/chips.ts` (SVG chips) and CSS for each, tests for each.
- Changed: `src/store.ts` (fold in the cache, `setTags`, the index, `labels` helpers), `src/types.ts` (comments only: `labels` is the folded view), `src/markup.ts` (chips and the text band), `src/render.ts` (`setDim`, `arranging`), `src/app.ts` (select by predicate, `arrange`, keys), `src/ui/quickbar.ts` and `src/ui/props.ts` (Tags), `src/ui/context-menu.ts`, `src/ui/board.ts` (menu entries, the filter button and band), `src/exporters.ts` (labels in the JSON, chips in PNG and SVG), `src/flow.ts` (summary), `src/custom-templates.ts`, `src/templates.ts`, `src/shortcuts.ts`, `src/ai-bar-logic.ts`, `src/ai-apply.ts` and `src/ui/ai-bar.ts` (Tag chip, preview, Cluster option), `server/board-ops.mjs`, `server/templates.mjs`, `server/mcp.mjs`, `server/ai/*` (the feature, the proposal, validation), `src/ui/admin.ts` (feature list), the Dockerfile (copy `shared/tags.mjs`).

## Changes to other specs

- `docs/kanban.md`: the **Labels** section says a card's `labels` is an array replaced whole; it becomes "the folded view of one key per label on the object" (this removes its open question 11), the **Labels** dialog is the tag manager, "usable for other objects later" becomes "used by every item", the card's chip row is the standard chip, the **Filter** popover becomes the board filter (criteria and storage), and "Labels" in the interface reads "Tags". CSV and MCP stay `labels` in names and columns; add `tags` as an accepted alias.
- `docs/sticky-stacks.md`: "when the tag system exists" is now: a pad has an optional `tagId`, the torn note gets that tag, and the corner label and the chip are one band (see above); slice 5 of that spec ("TAB-107 tags") is this page's slice 9.
- `docs/groups.md`: the layers panel line "TAB-107 and the z-order work" is the visible outline of `docs/canvas-keyboard.md`; this spec only asks that its rows show chips and that a group is not taggable itself.
- `docs/ai.md` and `docs/ai-toolbar.md`: a fourth feature (**Tag**), the `tag` proposal kind, a fourth chip, the Cluster checkbox, and the admin list.
- `docs/mcp.md`: the tag reads and tools.
- `docs/custom-templates.md`: the `labels` list and the merge by name.

## Open questions for Johan

1. **The word.** "Tag" in the interface, `labels` in the file and code (drafted), or rename the map and field to `tags` now, while nothing writes them? The first leaves two words in the codebase; the second touches the shipped kanban model slice and its tests.
2. **One key per tag (drafted) or an array replaced whole** (the kanban spec's choice)? The key form never loses a tag when two people tag the same item; the array is simpler to read and write and loses one tag in that case. The drafted form adds a fold in two places (store and server) and a legacy read.
3. **An item with several tags in Arrange by tag.** First tag in manager order (drafted, no copies). Alternatives: put it in every column as a **copy** (clutter, and copies are real objects), or in a **Multiple** column, or let the person choose a tag to arrange by (a second popover step).
4. **Headers as text objects (drafted) or as frames** (each column a frame holding its items)? Frames move as units and show a title, but turn an Arrange into frame creation, which people may not want for a quick look; text headers are plain and removable. The in-frames checkbox is drafted as the way to choose per run.
5. **Arrange scope for the whole board** excludes items inside frames, groups and containers (drafted). Should it instead flatten the board (take everything out of frames)? That is a larger edit than "arrange" suggests.
6. **Chips default on or off?** Drafted on, per person. On a dense board they take a band on every tagged item.
7. **A group is not taggable; its members are** (drafted). Is it acceptable that "tag this group" means "tag everything in it" and that the group has no tags of its own?
8. **Tags on connectors and frames.** Drafted yes for both. Connectors rarely need tags and chips on a thin line are awkward (the chips would sit on the label, or be left to the outline only).
9. **Dimming strength** 35 % (as kanban) is drafted. Do you want it adjustable, or an optional "hide" for presentations (a per-person switch that keeps the layout and takes the dimmed items off the picture, like a spotlight)?
10. **Should the filter be sharable**, so a facilitator can say "everyone look at Bug" (a focus request with a filter)? It would use the focus-request channel and is not in this spec.
11. **Name collisions** (two people create "Bug" at once) are handled by showing both and offering **Merge** (drafted). Is a deterministic id from the name worth it, so concurrent creation of the same name is one tag, at the cost of care around renames?
12. **Tag limits** (30 on the board, 10 on an item, 8 new by AI) are drafted from what the chips and the checklist read comfortably. Right for your largest boards?
13. **The AI Tag feature in v1**: is it wanted, or only the proposal path for **Cluster** to also tag? (It costs one feature switch in the admin tab, a prompt and a preview.)
14. **Author names.** `createdBy` is an id and the board has no name for it unless the person is present or has commented. Drafted: Arrange and the filter show the name known from the current people, comment authors and card owners, and **Unknown** otherwise. A small `people` map on the board, each client writing its own name and colour on open, would fix this for tags, kanban owners and history at the cost of one more map; do you want it?
15. **Pad tags** (stacks): the pad's tag is created on the first tear and renamed with the pad while their names match (drafted). Or should a pad simply **choose** an existing tag?
