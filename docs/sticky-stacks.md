# Sticky stacks

TAB-110. Status: spec for review. Nothing here is built yet.

A pad of sticky notes on a real table has a name written on its top sheet, a colour, and sometimes an owner: the yellow pad is Alice's, the pink one is for risks. You tear a sheet off and write on it. Tabula has one sticky tool and one colour tray: every note is made from nothing, and nothing says which notes belong together except where they were put or what colour they happen to be.

This page specifies **stacks** (pads): a named, coloured pad you place on the board and tear sticky notes off, optionally assigned to a person. The torn notes remember their pad, so the pad can show how many came off it and select them, and the name travels with the notes as a small tag. It is written to fit the existing sticky code (`makeObj`, the click placement, private writing), the task-card fields of kanban (`docs/kanban.md`, which has `ownerId` and `ownerName`), and the tags work (TAB-107).

The issue says "if Johan meant stacks of stickers or emojis instead, adapt". [If you meant stickers](#if-you-meant-stickers) sketches that variant on the same object so the decision does not have to be made before building; the first open question asks.

## Summary

- **A stack is a board object of a new type, `stack`.** It draws as a pad (three offset sheets) with an editable **name** along its top edge and a **colour**. It has no text of its own.
- **Tear off** with a click or a drag on the sheets, with **Enter** when the pad is selected, or with a **Tear off** button in the quick-action bar. A click tears a note beside the pad and starts editing it; a drag tears one that follows the pointer and lands where you let go.
- **A torn note is an ordinary sticky** with the pad's colour and three extra fields: `stackId` (which pad), `stackName` (its name when torn), and, if the pad has an owner, `ownerId` and `ownerName`. It behaves as any sticky: private writing hides it, voting counts it, it converts to a task card and keeps its tag.
- **The name travels as a tag.** A torn note shows the pad's name in a small label in its corner. Renaming the pad renames the label on every note still linked to it. When the tag system (TAB-107) exists the name is also a tag the notes can be filtered and grouped by.
- **Count and select**: the pad shows how many notes are linked to it; clicking the count selects them.
- **Owner**: a pad can be assigned to a person ("For Alice", or an account). Notes torn from it carry that person's initials. This is a label, not a permission: anyone who can edit can tear from any pad.
- **Pad for everyone here**: one command makes a pad named after each person present, for retros and private writing.
- **Works in templates**, syncs live, works offline, and undo is one step per tear.
- **Nothing here needs the server.** MCP gains one creation type and one field.

## Decisions and why

1. **A new object type, not a sticky with a flag.** A pad has a different look, different gestures and its own fields, and it must be hit-tested, selected, moved, locked and deleted as a thing. A sticky variant would put branches into every sticky code path (the editor, the colour tray, text fitting). The cost is the usual new-type list (the type union, both template whitelists, the markup dispatch, the properties panel lists, the MCP summariser); the same list the images and kanban specs name.
2. **The notes point at the pad; the pad does not list its notes.** A list on the pad would be one value that every tear from every client overwrites. `stackId` on each note is a field of an object that only its creator writes, so concurrent tears never conflict, and the count is derived.
3. **A name snapshot beside the live link.** Showing the pad's current name on the note needs the pad to exist. Deleting a pad must not strip meaning from its notes, so each note also keeps `stackName` as torn. The label shows the pad's live name when the pad exists and the snapshot when it does not.
4. **Colour is copied, not linked.** A note keeps the colour it was torn with. Recolouring the pad later changes new notes only, because people also colour notes by hand (the sticky tray and quick bar) and a linked colour would fight that. A **Recolour its notes** action in the pad's menu is the explicit way to change them all.
5. **The top strip is the handle; the sheets tear.** The same click cannot both select a pad to move it and tear a note off it. The name strip along the top (28 units) selects, drags and renames; the sheets below tear. It is one rule, visible in the pad's drawing, and it works with a finger.
6. **Owner is a label, not access control.** Private writing hides a note from everyone but its `createdBy`. An assigned pad does not change who can see or write; it says whom the notes are about or for. Anything stronger (a pad only Alice can tear from) needs the server to inspect updates, which it does not do for board rooms.
7. **Reuse the task-card field names.** `ownerId` and `ownerName` are the names kanban uses. A torn note turned into a card keeps its owner and its tag, and the picker for an owner is one component.

## The pad

### The object

```
Stack {
  id, type: 'stack', z, parent?, locked?
  x, y, w, h, rotation       // w and h default to 192, the size of a sticky
  name: string               // up to 40 characters; "Notes" when empty
  fill: string               // the colour of the sheets and of notes torn from it
  ownerId?, ownerName?       // optional assignee (see Owner)
  createdBy, updatedAt
}
```

It is a box: it can be moved, resized (a square pad stays square: resize keeps the proportions as icons do), rotated, locked, put in a frame, grouped (TAB-106), connected, commented on. It has no `text`.

### Drawing

Three sheets in the pad's colour, each offset 3 units down and right of the one in front, the front sheet carrying a **name strip** at its top edge: the name in 12 px uppercase on a slightly darker band of the colour. The text colour comes from the same contrast rule stickies use (`inkOn`). If an owner is set, their initials sit in a small circle at the strip's right end. At the bottom right of the front sheet, a **count** chip shows the number of linked notes the viewer can see (hidden private-writing notes of other people are not counted), and is left out when it is zero. A selected pad shows the usual handles; it also shows a faint **Tear off** hint ("click to tear") the first time in a session.

The pad's drawing uses the same `fill` as a sticky and none of the sticky's folded corner, so the two read differently at a glance.

### Hit zones

| Zone | Click | Drag | Double-click |
|---|---|---|---|
| Name strip | select the pad | move the pad | rename in place (the frame name editor) |
| Sheets | tear a note off (and select it, editing) | tear a note that follows the pointer | tear a note (same as click) |
| Count chip | select the linked notes | (as sheets) | (as sheets) |
| Owner circle | open the owner picker | (as strip) | (as strip) |

When the pad is **locked** the sheets still tear (a locked pad is a pad glued to the table: it cannot be moved, resized or renamed, but people can still use it). The strip, the owner circle and handles are inert. The lock icon's long-press unlock still works on the strip. This is the one exception to "locked objects are click-through", and it is what a facilitator needs to hand out pads that people cannot knock around; it is the second open question.

## Tearing off

### The gestures

- **Click or tap on the sheets**: a new sticky appears next to the pad and is put into text editing at once. Where: the spot to the right of the pad (the same free-spot search the quick "add a connected sticky" uses, `freeSpotInDirection`, `src/geometry.ts`), then below, then further right in steps of the gap, so repeated tears fan out and do not pile up. A tap on a phone does the same.
- **Drag from the sheets**: a ghost of a sticky follows the pointer (drawn in the overlay, nothing written while dragging, as kanban cards are); on release the sticky is created where it was dropped (snapped as other drops are, into the frame under it if any), selected, and put into text editing. A drag that ends back over the pad creates nothing.
- **Keyboard**: with a pad selected, **Enter** tears one off beside it and edits it (Enter edits the selected object's text elsewhere; a pad has none, so the key is free). **Tab** or **Escape** leaves the editing as for any sticky.
- **Quick-action bar**: a **Tear off** button; **Tear off 5** in its menu makes five at once in a row (useful before a silent brainstorm), up to 20.

### What the new note is

`app.makeObj('sticky', ...)` is used, so everything a new sticky gets today it still gets (default size, font, `createdBy`, the frame under it as `parent`, and `privateStep` when a private-writing step is running and the reveal has not happened). On top:

| Field | Value |
|---|---|
| `fill` | the pad's `fill` |
| `stackId` | the pad's id |
| `stackName` | the pad's name now |
| `ownerId`, `ownerName` | the pad's, when it has an owner |

The creation is one transaction: one undo step per tear, undone by `Ctrl+Z` like any new object. `Tear off 5` is one step.

A torn note that is left empty is kept (as an empty sticky is today). The note is not tied to the pad's position afterwards: moving the pad does not move the notes.

### Notes torn at the same time

Two people tearing from one pad at once make two notes. Each chooses its spot from the board as that client sees it, so they can land on one another; a small offset by the creator's client number avoids an exact overlap. No coordination is added: it is the same as two people adding a sticky at the same place.

## Name, colour, owner

- **Name**: double-click the strip (or press `F2`, or choose **Rename** in the pad's menu). Up to 40 characters, plain text. It edits in place with the frame name editor. Renaming is one field write; notes show the new name at once (the label reads the pad live).
- **Colour**: the quick-action bar's colour swatch with the sticky colour field (the sticky colours and custom ones, `stickyColorField`). It changes the pad and nothing else. **Recolour its notes** (in the pad's ⋯ menu) writes the new `fill` to every linked note the person can edit, as one undo step, skipping notes the person's role does not allow (a viewer sees no menu).
- **Owner** (**For…** in the quick-action bar): a picker with *Nobody*, *Me*, the people currently on the board (names from presence, as the kanban owner picker lists), and a free-text name. In accounts mode a person picked from presence or *Me* is stored with their id (`ownerId`) and the name at that time (`ownerName`); a typed name is `ownerName` alone. Removing the owner removes the initials from the pad; notes already torn keep theirs.
- **Pad for everyone here** (the sticky tray's menu, and the command palette when it exists): makes one pad per person currently present, named after them with their name as owner, laid out in a row, each in a different sticky colour, in one undo step. Up to 20; more people ask the person to choose.

## The label on a note

A torn note whose `stackName` (or its pad's live name) is not empty draws a small label inside its bottom-left corner: 10 px uppercase text, at most 14 characters then an ellipsis, in the note's text colour at 70% strength. If there is an owner, the initials show at the bottom right in a small circle. The text of the note (centred, fitted) is laid out in the remaining area, so adding a tag never makes a note's text overflow: the fitting code (`fitText`) is given the note's size minus the label band, and a note with no tag fits as it does now.

The labels follow the **viewer's theme** through the same ink rule as the text and are drawn into SVG and PNG exports, so a printed board shows whose pad a note came from.

Turn the label off for one note by clearing its tag (**Remove tag** in the quick-action bar when a note with a `stackId` is selected): it removes `stackId` and `stackName` (and owner if it came from the pad). The note is a plain sticky again and no longer counts.

> **Anonymity.** A pad assigned to a person puts that person's initials on every note torn from it. In a retro that is meant to be anonymous, use unassigned pads. In private writing this is a label only: notes stay hidden from others until the reveal because of who created them, not because of the pad.

## Count and select

- The count is derived: the number of boxes with `stackId` equal to the pad's id that the viewer may see. It is kept by an index in the store (pad id to note ids) updated by the same change observer that already maintains the connector index, so drawing a pad never scans the board.
- **Click the count**: selects those notes (and flies the view to them if they are out of sight; the same fly the step editor uses). A second click, or `Esc`, clears.
- **Highlight on hover**: pointing at the count outlines the linked notes on the board in the pad's colour, so the count is not a number you have to take on trust.
- Deleted notes leave the count; a note moved to another board by cut and paste loses its link (the pad is not there).

## When a pad goes

**Deleting a pad** deletes only the pad. Its notes stay, keep `stackName` and the owner, and read as tagged notes from a pad that no longer exists (the label shows the snapshot). A note's `stackId` that no longer resolves is not an error anywhere: the orphan rule is "no live pad, use the snapshot".

**Copying a note** keeps its tag (a copy of a note from Alice's pad is still from Alice's pad). **Duplicating a pad** makes a new pad with a new id, the same name plus " copy", and no notes (the count restarts at 0). **Copying a pad together with its notes** (selecting both) remaps `stackId` to the new pad, as `remapObjects` already remaps `parent`, so the copy is a self-contained pad with its own notes.

## Private writing, voting and sessions

- **Private writing**: a torn note takes `privateStep` while the step is private and unrevealed, through the normal `makeObj` path. The **pad** is not hidden (it is a tool, not content). The count shows the notes the viewer may see, so a pad does not leak how many notes others wrote.
- **Dot voting** clicks on notes, not pads. A pad is not votable (the vote path accepts every box except frames and paths today; `stack` joins the exclusions, as `container` does in the kanban spec).
- **Session steps** can point at a pad's frame as for any object. A **step prompt** such as "Everyone tear off a note for each risk" needs nothing special.
- **Focus requests** ("look here") can target a pad like any object.

## Templates

- `stack` joins both type whitelists (`OBJ_TYPES` in `src/custom-templates.ts` and `server/board-ops.mjs`) and the per-type validator in `server/templates.mjs` (`name` up to 40 characters, `fill` a colour the validator already accepts for stickies, `ownerId` stripped on save, `ownerName` kept).
- A sticky with a `stackId` saved in a template must name a pad that is in the same template; otherwise `stackId` is dropped at save and the note keeps its `stackName`. On use, `stackId` is remapped with the other ids.
- New built-in templates: **Retro with pads** (a Went well pad, a To improve pad and an Actions pad on a three-column board) and **Silent brainstorm** (one pad per colour with a prompt).

## History, undo, offline

- **Undo**: a tear is one step; rename, colour, owner and **Recolour its notes** are each one step.
- **Version history** restores whole objects; a restored pad and its notes come back with their fields, and the orphan rule covers a half-restored state.
- **Offline**: tears are creations, which merge. The count is local until sync and consistent after.

## Export and other formats

- **SVG and PNG** draw the pad (the sheets, the name, the owner circle; not the count chip, which is an interface element) and the labels on the notes.
- **JSON, `.drift`**: pads and the new fields are objects and fields like the rest.
- **Markdown summary**: a note with a tag is listed with it, `- <text> (<stackName>)`, unless it has an owner and the board is in a private-writing step that is not revealed, in which case the tag is left out so the summary does not attribute hidden notes (the rule `summaryMarkdown` already follows for the notes themselves, TAB-139). Pads are not listed.
- **Mermaid**: ignored.

## MCP and the other AI tools

- **Reads**: a `stack` is returned with `name`, `fill`, `ownerName` (not the id) and `count`; a note with a tag returns `stackId` and `stackName`. All fenced as board text.
- **`create_objects`** accepts `type: 'stack'` with `name`, `color` (the sticky colour names), `x`, `y` and an optional `ownerName`. A `sticky` item may carry `stack` (a ref or an id of a pad) and the server then sets `stackId`, `stackName`, the colour and the owner the same way a tear does, so an agent can "add a note to Alice's pad" in one call.
- **`update_objects`** can rename, recolour and move a pad (`name`, `color`, box fields), not reassign notes.
- **AI features** (TAB-97): the context for **Summarise** and **Cluster** includes tags, so "what did Alice's pad collect" is answerable; no proposal creates pads in this spec.

## Permissions

Owners and editors place, rename, recolour, assign and tear. Commenters and viewers see pads and the count, can click the count to select the notes (selection is local), and cannot tear (they cannot create objects). In a hosted workspace that is read-only, the same. Nothing is enforced by the relay beyond the room role, as for every other object.

## Phone and touch

- A tap on the sheets tears a note and opens the keyboard on it (the editing that starts after a sticky is placed). The name strip is 36 px tall on touch so it is a real target; a long-press on the strip opens the pad's menu (rename, colour, owner, recolour notes, delete), the touch equivalent of the quick-action bar.
- The count chip is 44 px wide on a coarse pointer.
- **Pad for everyone here** is in the sticky tray, which is how touch reaches the sticky colour already.

## Keyboard and accessibility

- Pad selected: **Enter** tears off, **F2** renames, **Delete** removes the pad. These go in the shortcuts dialog (`src/shortcuts.ts`, whose test checks that every handled key is documented).
- The canvas is not keyboard-addressable today, so the pad's functions are also in the quick-action bar and the layers panel when it exists. A live-region message says "Tore off a note from Ideas" and "12 notes from Ideas selected".
- Colour is never the only signal: the name strip carries the pad's name in text.

## Limits

| Thing | Limit |
|---|---|
| Pads per board | 100 |
| Name | 40 characters |
| Notes per **Tear off N** | 20 |
| Pads from **Pad for everyone here** | 20 |
| Tag shown on a note | 14 characters (the full name is in the field) |

## If you meant stickers

If the request was a **stack of stickers** (emoji from the sticker sets, `docs/stickers.md`) to stamp from, the same object does it with two changes. The pad gets `stackKind: 'stickers'` (default `'sticky'`) and `items`, a list of up to 12 sticker references (the `ref` and `body` an icon object stores), shown as a small grid on the front sheet instead of blank sheets. Tearing then **places the sticker the pointer is over** (a click on one of the items), or the first one on a click elsewhere on the sheets, as an ordinary sticker object with the pad's `stackId` and `stackName`. Naming, colour of the sheets, owner, count, select-by-count, templates and the rest are the same. The drawer's sticker set switch, licences and offline caching are not touched. The cost of deciding later is small: `stackKind` is one field and the tear path branches once.

## Tests

Pure (`test/sticky-stacks.test.ts`, with a `src/stacks.ts` of pure functions):

- The tear: fields copied (colour, `stackId`, `stackName`, owner), `privateStep` while a private step is running, the frame under the spot, snapping, one transaction, the spot search (right, below, further), `Tear off N` layout.
- The label: layout of the text area with and without tag and owner, truncation at 14 characters, the live name and the snapshot fallback, the text colour from the fill.
- Count and select: the index (add, delete, move to another stack by editing `stackId`), hidden private notes not counted, selection from the count.
- Deletion of a pad leaves notes and snapshot; copying a note keeps the tag; copying a pad with its notes remaps `stackId`; duplicating a pad alone gives zero.
- **Recolour its notes**: only editable notes, one undo step.
- **Pad for everyone here**: names, owners, distinct colours, row layout, the cap.
- Templates: both validators accept good pads, refuse a long name, strip `ownerId`, drop a dangling `stackId`; ids remap on use.
- Hit zones: strip against sheets against count against owner circle, the locked-pad rule.
- Vote path excludes pads.
- MCP: reads with `count` and fenced `name`, `create_objects` for a pad and for a note with `stack`, `update_objects` rename and recolour.
- Summary: tag shown, tag left out for a hidden note.
- Two real `Y.Doc`s: two people tearing from one pad, a pad deleted while a note is torn from it, a rename against a tear; after sync both have the same notes and the same count.

Browser checklist (not CI): click, drag and keyboard tear, rename in place, recolour, owner picker, the count highlight, a retro with **Pad for everyone here**, phone at 390 px, five themes, reduced motion.

## Not in this slice

- A supply limit on a pad ("10 notes per person"), pads that run out, or a pad only one person can tear from.
- Notes that stay attached to the pad's colour after the pad changes (only the explicit **Recolour its notes**).
- Auto-arranging torn notes into columns or rows.
- A pad inside a kanban lane, or a pad as a source for task cards (a torn note converts to a card by the usual conversion).
- Filtering and grouping by tag, which belong to TAB-107; the name is stored so they can be added.
- Stacks of stickers (the variant above) until decided.

## Slices

1. **The pad.** The `stack` type in every list, markup (sheets, strip, owner circle, count chip), hit zones, move, resize, rotate, lock, delete, duplicate, templates and the store index. No tearing.
2. **Tearing.** The three gestures, the new note's fields, the label on notes, the spot search, `Tear off N`, undo, private writing, the quick-action bar entries, **Remove tag**.
3. **Name, colour, owner.** In-place rename, the colour swatch, the owner picker, **Recolour its notes**, **Pad for everyone here**, the sticky tray entry.
4. **Count, select, export, summary, MCP.** The count chip and its select and hover, the SVG and PNG drawing, the Markdown summary rule, MCP reads and creation, the two built-in templates.
5. **TAB-107 tags** (when it lands): the pad name as an automatic tag, filter and group.
6. **Docs.** The user guide page and the CHANGELOG.

## Files

### New

- `src/stacks.ts` (pure: the tear, the spot search, the label layout, the count index helpers, the pad-for-everyone layout)
- `src/ui/stack-ui.ts` and `src/ui/stack-ui.css` (the owner picker, the count hover outline, the menu)
- the tests above

### Existing (touched)

- `src/types.ts` (`ObjType`, `Stack` fields, the sticky fields `stackId`, `stackName`, `ownerId`, `ownerName`), `src/store.ts` (the index), `src/markup.ts` (the pad, the label on a sticky), `src/render.ts` (the ghost while dragging a tear), `src/app.ts` (`makeObj` keeps working; a `tearOff` method; pointer zones in `onDown` and `onDblClick`; Enter and F2), `src/geometry.ts` (hit box of a pad's zones), `src/flow.ts` (vote exclusion, summary tag), `src/exporters.ts`, `src/custom-templates.ts`, `src/shortcuts.ts`, `src/ui/quickbar.ts`, `src/ui/props.ts`, `src/ui/board.ts` (the sticky tray entries), `src/ui/save-template.ts` (strip owner id)
- `server/board-ops.mjs` (`OBJ_TYPES`, summaries, `create_objects`, `update_objects`), `server/mcp.mjs` (schema), `server/templates.mjs`
- `docs/mcp.md`, `docs/custom-templates.md`, `docs/stickers.md` (a pointer to the variant), `docs/guide/` (a page when it ships), `CHANGELOG.md`

## Open questions for Johan

1. **Sticky pads or stacks of stickers?** This page builds the pad of sticky notes and sketches the sticker variant on the same object. Which did you mean? If both, which first?
2. **A locked pad still tears** (drafted), so a facilitator can fix the pads in place and people can still use them. Or should a locked pad be fully inert like any locked object?
3. **Owner is a label** (drafted), not who may tear. Do you need a pad only its owner can tear from? That needs the server to look inside board updates, which is a big change.
4. **Anonymous retros**: notes from an assigned pad show initials. Is that wanted, or should assigned pads be refused during a private-writing step?
5. **Colour is copied** (drafted). Do you want a live link as an option (a setting on the pad: notes follow its colour), at the cost of fighting hand colouring?
6. **The strip is the handle, the sheets tear** (drafted). Would you rather tear on a double-click and move on a single drag, as the pad is simply an object?
7. **The tag shows on the note** (drafted, in its bottom-left corner, 14 characters). Too much on small notes? Show it only when the note is selected or hovered, or in the layers panel?
8. **Limits**: 100 pads per board, tear 20 at a time. Right?
9. **Pad for everyone here** uses presence, so it only finds people who are on the board now. Should it offer the team's members in accounts mode too?
10. **Summary and exports** include the tag in text and drawing. Should the Markdown summary list notes by pad, as a heading per pad, when pads are in use?
