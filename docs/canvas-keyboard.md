# Keyboard and screen reader access to the canvas

TAB-149, slice 7 of `docs/accessibility-audit.md` (finding C1). Status: spec for review. Nothing here is built yet.

Everything around the canvas can be used from the keyboard and read by a screen reader today: the toolbars, menus, dialogs, panels and the announcements of what changes (slices 1 to 6 of the audit). The canvas itself cannot. A keyboard user can pick a tool and press a shortcut, and can nudge, edit, duplicate, delete and restack something that is **already selected**, but cannot select anything, cannot move from one object to the next, cannot resize, rotate or connect, and a screen reader hears "Whiteboard canvas" and nothing about what is on it. The WCAG criteria this breaks are 2.1.1 Keyboard, 4.1.2 Name, Role, Value and 1.1.1 Non-text Content, and it is the one finding of the audit that stops a person doing the main job of the product.

This page specifies how the canvas becomes operable and readable without a pointer: what receives keyboard focus, how focus moves between objects, how an object is selected, moved, resized, turned, edited, created and connected, what a screen reader is told, and how this fits the AI toolbar, kanban containers, groups and sticky stacks that other specs are adding to the same canvas. It changes how the board works for everyone who uses a keyboard, which is why it is a spec first.

## Summary

- **The canvas becomes one Tab stop, and one hidden DOM list stands for its content.** A visually hidden *outline* (a `listbox` of `option`s, one per object) is the accessible twin of the SVG. The SVG is hidden from assistive technology. Focus never goes into the SVG: it stays on one element, `aria-activedescendant` names the current object, and the renderer draws a **focus ring** on that object.
- **Tab goes into the canvas once and leaves it with the next Tab.** Inside, the keys that move between objects are not `Tab`: arrows move to the nearest object in that direction, `PageDown` and `PageUp` follow reading order, `Home` and `End` go to the first and last. A board of 500 objects is therefore never 500 Tab presses.
- **Focus and selection are separate.** Moving focus does not select. `Space` selects the focused object (and toggles it, so it also builds a multiple selection), `Enter` edits it. This is the one rule that keeps today's habit (click an object, press the arrow keys to nudge it) working: **with an object selected, arrows nudge it; with an object focused and not selected, arrows move focus.**
- **Moving, resizing, turning** use the existing arrows for moving (`Shift` for a grid step, unchanged), `Alt+Shift+Arrow` for size and `Alt+,` and `Alt+.` for rotation, in the steps the pointer uses, one undo step per burst of presses.
- **Creating**: with a placement tool active and the canvas focused, `Enter` places the object at the centre of the view (or beside the focused object) and starts editing it, as a click does today.
- **Connecting**: select the source, press `L`, move focus to the target, press `Enter`. The connector is the same object the pointer makes (bound ends, automatic anchors).
- **What a screen reader hears** is built from the object's kind, text, colour, parent, and state (locked, selected, comments, votes), in a fixed order, short first. Selection, movement and resizing are announced through the existing announcer (`src/ui/announce.ts`), batched so a run of nudges is one message.
- **The same outline is also a visible panel** (the "layers" panel the groups spec wants, and the list sheet the kanban spec wants on phones). One component, three uses.
- **Nothing here changes what a pointer user sees or does**, apart from a focus ring that only appears after the keyboard has been used.

## Decisions and why

1. **A DOM outline plus `aria-activedescendant`, not focusable SVG elements.** Two designs were weighed. *Focusable `<g>` per object* (tabindex -1, roving) is the obvious one, and it fails here for three reasons: the renderer rebuilds object markup (`src/render.ts`, `src/markup.ts`) and a rebuilt node loses focus, so every remote edit would drop the user's place; thousands of nodes each carrying an accessible name is slow for assistive technology to build; and SVG focus semantics differ between browsers and screen readers. *One focus target with an outline list* keeps focus on an element the app never replaces, gives every object a stable id, lets the list be **windowed** (only the objects near the focus exist as DOM) while `aria-setsize` and `aria-posinset` still tell the truth, and gives the visible layers panel and the phone list sheet something to reuse. The cost is that the outline has to be kept in step with the store, which is one derived, throttled mapping, not a new source of truth.
2. **Arrow keys keep nudging a selected object.** The shipped behaviour is documented in the user guide ("Arrow keys nudge by 1; with `Shift`, by one grid step") and in the shortcuts dialog. Taking it away to make arrows navigate would break everyone who relies on it. The split by selection state (decision 3) keeps both.
3. **Focus and selection are separate, as in a multi-select listbox.** A screen reader user needs to move through the board without changing it or changing what the AI toolbar will act on. `Space` toggles selection. `Shift+Arrow` does **not** extend a selection (it is the grid nudge), so a range is built with `Space` on each, or with `Shift+PageDown` and `Shift+PageUp`, which select from the last selected to the new focus in reading order.
4. **`Tab` leaves the canvas.** The usual keyboard canvas (Figma) uses `Tab` to step to the next object. Here that would make leaving the board take as many presses as it has objects, which is a keyboard trap in effect even if not in letter. The ARIA pattern for a composite widget, one Tab stop and keys inside, is used.
5. **Resize on `Alt+Shift+Arrow`, rotation on `Alt+,` and `Alt+.`.** The first choice was `Shift+Arrow` for resize (the intuitive pairing with arrows for moving). It is taken: it is the grid nudge. `Alt+Arrow` is taken by the kanban spec (move a card between lanes). `Alt+Shift+Arrow` is free and keeps `Alt` as the "change the object's place or shape within its context" modifier. Rotation has no arrow pairing; the pair `Alt+,` and `Alt+.` is next to each other on every layout that has them, and `Alt` with a punctuation key types nothing in a canvas. Both are in the shortcuts dialog and in the question list.
6. **One announcer, batched.** Everything said is said through `announce()` with a key, so a held arrow key says "Moved 24 right, 8 down" once, not once per frame. The text is built by pure functions so it can be tested without a browser.
7. **The outline is a first-class component, not an accessibility afterthought.** The groups spec needs a layers tree, the kanban spec needs a list sheet on phones, the stickers spec needs "12 notes from Ideas selected", and this spec needs a list for screen readers. They are the same data (the store's objects in a tree by `parent`, in a reading order). Building one component with a hidden mode and a visible mode costs less than four and makes the visible one the testing ground for the hidden one.

## What takes focus

The board surface (`div.board-surface`, the page's `main` landmark since slice 4) gets one child, the **canvas focus target**:

```
div.board-surface            role=main
  svg.canvas                 aria-hidden=true        (the picture)
  div.canvas-focus           role=application, tabindex=0,
                             aria-label="Whiteboard, 14 objects",
                             aria-activedescendant="<current option id>",
                             aria-describedby="canvas-help"
    ul.canvas-outline        role=listbox, aria-multiselectable=true,
                             aria-label="Objects"          (visually hidden)
      li   role=option  id=ol-<objectId>  aria-selected  aria-posinset  aria-setsize  aria-level  ...
  p#canvas-help              "Arrow keys move between objects. Space selects. Enter edits. ..."
```

- **`role=application`** is kept on the focus target (it is on the SVG today). A screen reader then sends keys to the page instead of using its own reading keys, which is what this widget needs. Because that turns off the reader's browse mode, the help text and the first-use announcement ("Canvas. Arrow keys move between objects.") are part of the design, and **there is always a way out**: `Tab` leaves.
- **The SVG is `aria-hidden`.** Its content is represented by the outline. The `<title>` the markup gives an image with alt text moves into the outline item.
- **Placement in the tab order.** The canvas stands between the tool rail and the panels that act on the selection, not after all the chrome as it does today (the surface is before the chrome in the DOM). The order becomes: top bars, tool rail, **canvas**, quick-action bar and properties panel (when something is selected), library drawers, zoom controls. The visual layout does not change; the chrome's children are placed in this order in the DOM. A person who selects something with the keyboard can then press `Tab` and land on the quick-action bar, whose buttons act on the selection, which makes **Lock** and the other bar actions reachable.
- **Focus return.** After a dialog opened from the canvas closes, focus goes back to the canvas focus target and the same object stays current (slice 1 returns focus to the opener; the canvas focus target is the opener for shortcut-opened dialogs). After a delete, focus moves to the next object in reading order, or the previous if there is none, or stays on the canvas with an empty outline ("Whiteboard, 0 objects").
- **First entry.** `Tab` into the canvas with a selection makes the first selected object current. With no selection the object nearest the centre of the view is current (so the first thing announced is something the person can see), or the first in reading order if none is in view. Entering does not select.
- **Pointer use.** A click on the canvas puts focus on the focus target (without a visible ring, since `:focus-visible` does not match for a mouse), and the object under the pointer becomes current and selected as today. A person who clicks, then types, is in the state they are in now.

## The focus ring

The focused object shows a ring **in addition to** the selection handles. It is the keyboard ring the kanban spec already defines, a 2px `--canvas-ink` line 4px outside the object, with a `--signal` tag showing the verb that is available ("Space selects"), because `--wire` already means "selected" and `--signal` on a light canvas is 1.2:1. The ring:

- appears only after a key was pressed on the canvas (like `:focus-visible`), and disappears on pointer use;
- is drawn by the renderer's overlay layer, so it moves with the object and survives remote edits, and is not part of exported images;
- meets 3:1 against all five themes' canvases (the same calculation as the kanban table);
- keeps the object on screen: moving focus pans the camera the minimum needed to bring the object (and its ring) inside the view with a margin, instantly under `prefers-reduced-motion` and eased otherwise, and zooms only if the object is larger than the view (never more than "fit selection").

## Moving focus

The **outline order** is the reading order: containers first, then children, row by row. It is derived, not stored:

1. Top level objects (no `parent`) are ordered by row then column: objects whose vertical centres are within half of the median object height of each other are one row; rows go top to bottom, objects in a row left to right. (Right to left in a right-to-left locale, which Tabula does not have yet.)
2. A frame, group, container, lane or pad is followed by its children, in their own order (a lane's cards by `rank`), one `aria-level` deeper.
3. A connector comes after the objects it joins, ordered by its start object then its end; an unattached connector by its start point.
4. Hidden things are left out: an object another person's private writing hides (`flow.isHidden`), an object hidden by a filter, a locked object **is** included (it can be read, not edited, and it cannot be selected, as with the pointer).

| Key | With focus on an object | Notes |
| --- | --- | --- |
| Arrow keys | Move focus to the nearest object in that direction | Only when the current object is **not selected**; selected means nudge. Nearest is by centre distance inside a 90 degree cone, preferring the same parent. |
| `PageDown`, `PageUp` | Next, previous in reading order | `Shift` extends the selection (decision 3). |
| `Home`, `End` | First, last in reading order | |
| `Enter` on a frame, group, container or lane | Moves focus to its first child ("Entered Ideas, 4 items") | Same as double-click enters a group (groups spec). |
| `Esc` | One step back, in this order: close a menu or popover; stop editing; cancel connect mode; leave an entered container (focus goes to the container); clear the selection; clear the current object (ring off, focus stays on the canvas); only then select the Select tool | Today `Esc` clears the selection and picks Select in one go; the ladder keeps that for pointer users because the extra steps do nothing when there is nothing to undo. |
| `Tab`, `Shift+Tab` | Leave the canvas | |
| `Ctrl/Cmd+A` | Select all (not locked) | Unchanged; announces "Selected 14 objects". |
| `Alt+I` | Describe: say where the current object is | "At 1,200 across and 340 down. Right of Backlog, overlaps Flaky tests." Pure geometry (nearest neighbours by side, overlaps), no AI. |

Arrow navigation has to be predictable on boards that are not tidy. The rule is: candidates are the objects whose centre lies inside the 90 degree cone around the arrow direction from the current object's centre (a 45 degree margin each side); the winner has the smallest `distance * (1 + 0.5 * off-axis fraction)`; ties go to reading order. If the cone is empty the arrow does nothing and says "No object to the right" (so the person knows it is an edge, not a lost key). This lives in a pure module (`src/canvas-nav.ts`) with tests on grids, scattered boards, overlaps, rotated objects (use the centre) and containers (children stay inside their parent unless the cone is empty, then the parent's neighbours are tried).

## Selecting

| Key | Does |
| --- | --- |
| `Space` | Toggle the current object in the selection (`aria-selected`). Announces "Selected, 1 object" or "Deselected, 0 objects". While an object is current the key is **not** the pan modifier; hold-to-pan is pointer only (dragging) and nothing is lost. |
| `Shift+PageDown`, `Shift+PageUp` | Select from the last selected object to the new current one, in reading order. |
| `Ctrl/Cmd+A`, `Esc` | As above. |

The selection is the same `app.selection` the pointer uses, so the quick-action bar, the properties panel, the AI toolbar's "selection" context, copy and paste, duplicate and delete all work on it unchanged. Because the AI toolbar's context chip reads the selection, **a keyboard-only person can now ask the AI to summarise or cluster the selection**, which is not possible today.

Announcements: a change of selection says the count and, for one object, its name ("Selected: Sticky note, yellow, Reviews were fast"); for several, the count and the kinds ("Selected 6 objects: 5 sticky notes, 1 frame"). Rapid changes are batched under one key with a 400 ms delay. A selection made with the pointer is announced too (the sighted person next to a screen reader user, and someone using both), but only when the canvas focus target has focus, so a pointer user with no reader running hears nothing extra.

## Moving, resizing, turning

Keys act on the **selection** (they do nothing to a focused-only object; the announcement says "Select it first: Space", once per focus).

| Key | Does | Same as the pointer |
| --- | --- | --- |
| Arrow | Move 1 px (world units) | Yes. Today's nudge. |
| `Shift+Arrow` | Move one grid step | Yes. |
| `Alt+Shift+Arrow` | Resize: Right and Down grow the width and height from the bottom-right corner, Left and Up shrink them | Dragging the `se` handle. Step 1 px, or a grid step with `Ctrl/Cmd` also held. Proportional if the object keeps its proportions (images, `Shift` during a drag). |
| `Alt+,`, `Alt+.` | Rotate 1 degree, with `Shift` 15 degrees | The `rot` handle. |

- **What can be resized or turned follows `handlesFor()`** (`src/render.ts`): text only grows and shrinks sideways, a path, a locked object, a container, lane or card has nothing to resize (their geometry is derived), frames and lifelines do not rotate. A key that does nothing says why ("Cannot resize a drawing").
- **Undo.** One burst of the same key is one undo step: the first press starts the step (`undo.stopCapturing()`), later presses within 600 ms of each other extend it. This is what the pointer does for one drag.
- **Guides and snapping** are off for keyboard changes (the key is the precision), and `Alt` is part of the resize chord, so the existing "Alt ignores guides" is not touched.
- **Announcements** are totals over the burst: "Moved 24 right, 8 down", "Width 200, height 120", "Rotated 30 degrees". After the burst ends the announcer says the new position only on `Alt+I`.
- **Locked and read-only.** A locked object cannot be selected, so these keys do not reach it. `Enter` on a focused locked object **unlocks** it, the keyboard form of the 0.6 second long-press: the announcer says "Unlocked" and the object is selected. A viewer's keys that change the board do nothing and say "View only".
- **Containers and groups.** Moving a group or a frame moves its members (as the pointer does). Cards and lane children in a container have derived geometry: arrows on a selected card do not nudge, they move focus (the card is "selected, arrows navigate") and `Alt+Arrow` reorders it in its lane (the kanban spec). The rule "selected means nudge" is therefore "selected and free to move means nudge".

## Editing

`Enter` on a single selected or focused object starts editing its text, as today (`TextEditor.start`). The editor is a real `textarea`, so a screen reader already works inside it. Two changes:

- `Enter` on a **focused but not selected** object selects it and starts editing in one step, so a screen reader user does not need `Space` then `Enter` for the common case.
- Leaving the editor with `Esc` or `Ctrl/Cmd+Enter` returns focus to the **canvas focus target** with that object still current (today focus has nowhere defined to go). `Tab` in the editor still finishes editing and now also moves to the next object in reading order, which is what a person filling in a row of notes wants.

Objects without text: `Enter` on an image opens its alt text field in the quick-action bar (the field exists, `src/ui/quickbar.ts`); on a connector it edits its label; on a pad (stickies spec) it tears a sticky off; on a group or frame the first press **enters** (see above) and `F2` renames a frame or group in place. `F2` is the rename key everywhere else and is free.

## Creating objects

The placement tools (Sticky note `N` or `S`, Text `T`, `R`, `O`, `D`, Frame `F`, Pen excluded) already have shortcut keys and then need a click. With the canvas focused and one of them active:

- `Enter` places the object with its default size and starts editing it. The place is the centre of the view; if an object is current, **beside it** (to its right, one grid gap, or below if that is outside the view), so a row of notes is `N`, `Enter`, type, `Esc`, `N`, `Enter`, type. The tool then returns to Select, as it does after a click for shapes today.
- The new object becomes current and selected, and the announcer says "Added: Sticky note, yellow" (the text follows when typed).
- The library drawers (shapes, icons, stickers, UML) are DOM and already keyboard operable; their "click to add" places at the centre in the same way and now also makes the new object current.
- The comment tool `C`: `Enter` opens the composer anchored to the current object (or the view centre).
- The pen, hand and connector tools have no keyboard placement: drawing freehand is not a keyboard task, and the connector has its own flow below.

## Connecting

Today a connector is made by dragging from an object's anchor, or with the connector tool. The keyboard flow:

1. Select the source object (`Space`).
2. Press `L` (or `X`). With a selected object this does what the tool does for the pointer **and** starts **connect mode** from it: the announcer says "Connect from Sticky note, Reviews were fast. Move to the target, Enter to connect, Esc to cancel." With nothing selected `L` only picks the tool, as now.
3. Arrows move focus to the nearest candidate in that direction (the same navigation, restricted to things a connector can end on: not another connector, not a locked object, not the source), `PageDown` and `PageUp` go through all candidates in reading order, and each move says "Connect to: Sticky note, Flaky tests".
4. `Enter` makes the connector (the active relation if the UML relation tool is the source, else a plain arrow, automatic anchors, as the pointer's default), selects it, and returns to Select.
5. `Esc` cancels. Focus returns to the source.

Pressing `Enter` with focus on empty canvas (no candidate) makes a **free-ended** connector pointing right, 120 px, from the source, which can then be re-aimed. Reconnecting an existing connector: with a connector selected, `Shift+Enter` picks its end (`Tab` toggles From and To in the announcement and ring), arrows and `Enter` choose the new target, `Esc` cancels. A connector's two ends are in the outline item's description ("from Sticky note to Backlog").

Connect mode draws the source with the keyboard ring, the candidate with a second ring and a dashed preview line from one to the other (the overlay layer already draws a preview line during a drag).

## The outline: what a screen reader is told

Each option has an accessible **name** built in a fixed order, most useful first, and a **description** with the rest. The strings come from one pure function (`src/canvas-describe.ts`) so they can be read in a test and corrected in one place.

| Object | Name | Description |
| --- | --- | --- |
| Sticky note | `Sticky note, yellow, "Reviews were fast"` | `In frame Ideas. 2 comments. 3 votes.` |
| Text | `Text, "Q3 goals"` | |
| Shape | `Rectangle, "Backlog"` (the kind: ellipse, diamond, arrow, cloud, and so on) | `Filled blue.` |
| Frame | `Frame Ideas, 4 items` | |
| Group | `Group, 3 items` (the group's name if it has one) | |
| Container, lane, card | `Board Sprint 12, 3 columns`; `Column Doing, 4 cards, limit 5`; `Card, "Fix login", owner Ana, due 12 Oct` | |
| Image | `Image, "Team photo"` (the alt text) or `Image, no description` | `No description yet. Press Enter to add one.` |
| Icon, sticker | `Icon, rocket` | |
| Connector | `Connector from Reviews were fast to Backlog` plus its label | `Arrow. Dashed.` |
| Drawing | `Drawing` (a pen path has no text) | `Drawn by Ben.` |
| UML | `UML class Order` and so on | |

- Text is cut to 120 characters in the name with "…" and the full text is the description when it was cut.
- **State words** come after: `locked`, `selected` is not repeated (it is `aria-selected`), `new` for an object another person added since this person last looked (the same "new since" the comments panel uses, optional).
- **Position in the set** is `aria-posinset` and `aria-setsize` for the whole outline in reading order, and `aria-level` for depth, so a reader says "3 of 14" without the app saying it in the name.
- The names are **updated in place** when text, colour, parent or state changes. If the current object changes while it is current (a remote edit), the announcer says nothing, but the next move reads the new name.
- **Windowing.** For a board of more than 300 objects only the 300 around the current one, plus its ancestors, are DOM options; moving beyond them swaps the window. The posinset/setsize stay right. Below 300 every object is an option. (A board with thousands of objects is also where this earns its keep: no accessible tree for 5,000 SVG nodes.)
- **Empty board**: "Whiteboard, 0 objects. Press N to add a sticky note."

### Announcements, in one place

| When | Said (polite, batched where it says so) |
| --- | --- |
| Tab into the canvas | `Whiteboard, 14 objects. Arrow keys move between objects. Space selects. Enter edits. Question mark lists the keys.` (once per page load, then only the label) |
| Focus moves | Nothing extra: the option's name and position are read by the reader because `aria-activedescendant` changed |
| Selection changes | Count and names as above (400 ms batch) |
| Moved, resized, rotated | Totals over the burst (600 ms) |
| Entered or left a container | `Entered Ideas, 4 items` and `Left Ideas` |
| Object added or deleted | Already announced since slice 3 (`Added 1 object`, `Deleted 2 objects`); the first added is now also the current object |
| Edge, not allowed, locked, view only | One short sentence, not repeated for the same cause within 2 seconds |
| Connect mode | The four messages above |

`?` (Shift+Slash) opens the existing Keyboard shortcuts dialog from the canvas, which gains the rows of this page. The shortcuts test (`test/shortcuts.test.ts`) that checks every handler key is documented keeps this honest.

## How it fits the rest

- **AI toolbar** (`docs/ai-toolbar.md`). Its global keys `Ctrl/Cmd+K` and `/` work from the canvas as from anywhere. The bar's context "selection" now has a keyboard route to a selection. While a **preview** is showing, `Enter` with focus on the canvas **adds** it, as the AI spec decides, and takes precedence over "Enter edits" (the preview state is visible and announced; after adding, `Enter` is edit again). The ghost objects of a preview are in the outline as `aria-disabled` options named `Preview: Sticky note, "…"`, in the order they will have, so a person can review what will be added before pressing `Enter` (the bar's own list is the other route). Other people's runs and previews are listed the same way, labelled with whose they are. After **Add**, focus moves to the first added object and the toast says "Added 6 stickies."
- **Kanban containers** (`docs/kanban.md`). A container is a tree (container, lane, card) in the outline with `aria-level`. Arrow navigation inside a container follows lanes and cards (Left and Right between lanes at the same index, Up and Down within a lane); `Alt+Arrow` is the kanban spec's move-the-card and keeps its announcement ("Moved to Doing, position 2 of 3"), which goes through the same announcer. The phone list sheet is the visible mode of the same outline component.
- **Groups** (`docs/groups.md`). `Enter` enters a group (the keyboard form of double-click) and `Esc` leaves it; `Ctrl+G` and `Shift+Ctrl+G` group and ungroup the selection. A group is one option until entered. The groups spec's layers panel is the visible outline, and its note that "the canvas is not keyboard-addressable today" becomes "the outline is the keyboard route to a member" and then "the canvas is".
- **Sticky stacks** (`docs/sticky-stacks.md`). A pad is one option, `Enter` tears off a note, as that spec says; the notes torn from it are separate options. "12 notes from Ideas selected" is the selection announcement with the pad's name as the kind.
- **Frames and focus requests.** A facilitator's focus request that moves the view does not move canvas focus; it announces through the focus stack that already exists.
- **Comments.** Pins are reached from the comments panel (a list already); an object with comments says "2 comments" in its description. `Enter` in the comment tool anchors a new comment to the current object.
- **Presence.** Following someone does not change keyboard focus. Other people's selections are not part of the outline.
- **Read-only and commenter roles.** Navigation, `Alt+I` and the comment flow work; everything that changes the board says "View only".
- **History preview** shows a read-only copy of the board; it gets the same outline in read-only mode, so a person can read an old version (today the stage is pointer only, finding in the audit's static survey).
- **Export.** The outline text is also what a "plain text outline" export would use; not specified here.

## Touch and screen readers on phones

VoiceOver and TalkBack explore by touch and send their own gestures; a role=application region receives them as pointer events unless the reader's passthrough is used. The phone route is not the canvas but the **list sheet** (the visible outline), already specified for kanban: a bottom sheet with the objects, a **Move to**, **Connect to** and **Edit** menu per row, built from real buttons. Phone widths (860 px and below) show a button **Objects** in the toolbar that opens it. Two-finger pan and pinch on the canvas are unchanged (verified in slice 6).

## Limits

- Outline window 300 objects; reading order recomputed at most every 100 ms and only for the window; names built lazily.
- Announcement text at most 200 characters; a burst of announcements collapses to the last per key.
- Resize keys cannot take an object below 20 by 20 or above 20,000 by 20,000 (the limits of the pointer).
- Rotation is kept in the range -180 to 180.
- Connect mode lists at most 300 candidates in the window.

## Tests

Pure modules, no browser:

- `src/canvas-nav.ts`: reading order (rows, columns, tolerance, nested parents, connectors last), nearest in direction (grid, scattered, overlapping, rotated, empty cone, children of a container), next and previous by reading order, windowing and posinset.
- `src/canvas-describe.ts`: every row of the naming table, truncation, plurals, locked and hidden objects, a private-writing object excluded, an image without alt text.
- `src/canvas-keys.ts`: the key table as data (which key does what for which state: focused, selected, editing, connect mode), including every conflict listed in the next section.
- Nudge, resize and rotate steps against the handle rules (`handlesFor`), including text, frames, paths and locked objects.
- Announcement text and batching (`announce` with keys): "Moved 24 right, 8 down" after five presses.

DOM tests (the fake DOM of `test/fake-dom.ts`): the focus target and outline are created, `aria-activedescendant` follows the keys, `Space` toggles `aria-selected`, `Esc` ladder, a delete moves focus to the neighbour, windowing swaps options, focus returns after a dialog.

Browser (the audit script, `scripts/a11y-audit.mjs`, extended): `probeCanvasKeyboard` tabs in, counts options against the store, presses the arrows and checks `aria-activedescendant` and the announcer, selects with `Space` and checks the quick-action bar, moves and resizes with the keys and compares the object, connects two stickies from the keyboard, and runs axe on the board with the outline present. The visible ring is checked for contrast and for not appearing after a click.

Manual checklist (not CI), before it ships: NVDA with Chrome and Firefox, JAWS with Chrome, VoiceOver with Safari and Chrome on macOS, VoiceOver on iOS and TalkBack on Android with the list sheet; a board of 20 objects and a board of 3,000; five themes; reduced motion; 200% zoom; and someone who uses a screen reader every day doing the retro template.

## Conflicts with keys that exist or are specified

| Key | Today or elsewhere | Here |
| --- | --- | --- |
| Arrow, `Shift+Arrow` | Nudge a selection (shipped) | Unchanged when something is selected and free to move; move focus when it is only focused |
| `Space` | Hold to pan with the pointer (`spaceDown`) | Selects the current object while one is current; hold-to-pan is pointer only anyway |
| `Enter` | Edit the single selected object | Same; also on a focused object; during an AI preview it adds (AI spec) |
| `Tab` | Leaves the text editor and finishes editing | Same, and moves to the next object; leaves the canvas elsewhere |
| `Esc` | Clear selection, cancel drag, close thread, Select tool | A ladder that ends in the same place |
| `Alt+Arrow` | Kanban: move a card in its lane or to a lane | Unchanged and not used for resize |
| `L`, `X` | Pick the connector tool | Also arms connect mode when something is selected |
| `[`, `]`, `Ctrl+[`, `Ctrl+]` | Stacking | Unchanged |
| `Ctrl+G`, `Shift+Ctrl+G` | Group and ungroup (groups spec) | Unchanged |
| `Ctrl/Cmd+K`, `/` | Ask AI (AI spec) | Unchanged |
| `F2` | Not used on the board | Rename a frame or group |
| `?` | Not used | Opens the shortcuts dialog |
| `Alt+I`, `Alt+,`, `Alt+.`, `Alt+Shift+Arrow`, `PageDown`, `PageUp`, `Home`, `End` | Not used on the canvas | New |

## Not in this slice

- Freehand drawing from the keyboard, and editing the points of a path.
- Moving an object to a typed coordinate (a "Position" row in the properties panel is the natural place and is not specified here).
- Multi-object resize and rotate by keys (they act on one selected object; with several selected, resize and rotate say "Select one object").
- Reordering objects by dragging in the visible outline panel (move up and down by key and menu only).
- A spoken description of a drawing or an image (alt text is the author's job; an AI-written description is a separate feature).
- Right-to-left reading order.
- Braille displays beyond what the roles and names give.
- Custom key bindings.

## Slices

1. **Outline and focus target (read only).** `canvas-nav`, `canvas-describe`, the hidden listbox, the focus target in the right tab position, `aria-activedescendant`, the ring, Tab in and out, arrows, `PageDown/Up`, `Home/End`, `Alt+I`, windowing. A screen reader user can read the whole board. No change to the board's contents, so no risk to data.
2. **Selection and activation.** `Space`, `Shift+Page`, the nudge rule, `Enter` to edit, focus return from the editor and dialogs, delete hand-off, selection announcements. The AI toolbar context from the keyboard.
3. **Create by keyboard.** `Enter` places, "beside the current object", drawer placement makes the object current.
4. **Resize and rotate.** `Alt+Shift+Arrow`, `Alt+,` and `Alt+.`, undo bursts, refusals.
5. **Connect.** Connect mode, free-ended default, reconnect.
6. **The visible outline.** The panel (**Objects** in the board menu and the toolbar on phones), shared with groups and kanban, move up and down and the object menu key (`Shift+F10` and the Menu key opening the existing context menu at the current object).
7. **Guide, shortcuts dialog, audit probe, checklist.** The user guide's accessibility page loses its "does not work yet" section; `scripts/a11y-audit.mjs` gains the probes above.

Slice 1 is useful on its own and carries no risk to board data; slices 2 to 5 each add one kind of change; 6 is the one that shares work with the groups and kanban specs and should be sequenced with them.

## Files

- New: `src/canvas-nav.ts`, `src/canvas-describe.ts`, `src/canvas-keys.ts`, `src/ui/canvas-outline.ts` (the hidden list and, later, the panel), `src/ui/canvas-focus.ts` (the focus target, ring, `aria-activedescendant`), `src/ui/canvas-outline.css`, tests for each.
- Changed: `src/app.ts` (`bindKeys` calls `canvas-keys`; focus and selection events; `placeAtKeyboard`), `src/render.ts` (SVG `aria-hidden`; keyboard ring in the overlay layer), `src/ui/board.ts` (DOM order of the chrome; the focus target), `src/ui/quickbar.ts` (tab order after the canvas), `src/shortcuts.ts` (rows), `src/editor.ts` (focus return, `Tab` to next), `src/ui/announce.ts` (keys for batching if not enough), `scripts/a11y-audit.mjs`, `docs/guide/accessibility.md` and the guide pages that list shortcuts.

## Open questions for Johan

1. **Is "arrows nudge a selected object, move focus otherwise" acceptable?** It keeps today's habit and adds navigation, at the cost of a rule people must learn (the ring and the announcer teach it). The alternative is a separate mode key (for example `Enter` to "pick up" an object, as some drag-and-drop widgets do), which is more explicit and changes the shipped nudge.
2. **`Tab` leaves the canvas (drafted) or steps through objects (Figma-like)?** Stepping is quicker for a small board and a trap for a large one. Drafted: leaves, and `PageDown` and `PageUp` step. Laptop keyboards need `Fn` for those; is that acceptable, or should reading order also be on `Alt+Right` and `Alt+Left` (free outside kanban cards)?
3. **Resize on `Alt+Shift+Arrow` and rotation on `Alt+,` and `Alt+.`** (drafted, because `Shift+Arrow` is the grid nudge and `Alt+Arrow` is kanban's). Do you prefer to change the grid nudge to `Ctrl+Arrow` and use `Shift+Arrow` for resize, as most drawing tools do? That breaks the shipped, documented shortcut.
4. **`L` arms connect mode when something is selected** (drafted). Today `L` only picks a tool. Is it right that the same key now does one more thing depending on the selection, or should connect mode have its own key (`Shift+L`)?
5. **`Space` selects while an object is current** (drafted), which is the listbox convention. Hold-to-pan remains a pointer feature. OK?
6. **Where the canvas sits in the tab order**: after the rail and before the selection bars (drafted), which means the chrome's DOM order no longer matches the visual order of the top bars, rail and zoom controls (they stay where they are visually). A person tabbing sees the ring move in a sensible order, but the code has to place elements in a non-obvious DOM order. Accept?
7. **A visible **Objects** panel for everyone, or hidden for screen reader users only?** Drafted: visible for everyone from slice 6 (it is also the layers panel and the phone list). The alternative is to build only the hidden outline now and leave the panel to the groups and kanban work.
8. **Announcing remote changes.** Drafted: not announced (a busy board would never stop talking), except additions and deletions already announced, and joins and leaves. Should there be an optional "Announce other people's edits" setting for small boards?
9. **The first-time help.** Drafted: a spoken line on first entry and `?` for the shortcuts. Should the first entry also show a visible hint ("Arrow keys move between objects")? It would help sighted keyboard users and cost a corner of the canvas.
10. **Image descriptions.** `Enter` on an image without alt text opens the alt field (drafted) and the description nudges ("Press Enter to add one"). Should adding an image ask for the description at the moment it is added?
11. **Reading order of a messy board** is rows then columns with a tolerance (drafted). A board the author has laid out as a map or a timeline may read oddly; the alternatives (by creation time, by distance chain from the first object) read worse on tidy boards. Is rows-and-columns right for the boards people make?
12. **Window of 300 options.** Right for your largest boards, or should the number be higher, accepting a slower tree build in the reader?
13. **Outline in history preview** (read-only copy) is drafted as in scope for slice 1. Skip it until later?
14. **Who tests with a screen reader?** The checklist needs a person who uses one every day, not a developer with a trial. Can you name one, or should the spec's last slice wait for that?
