# Flip cards

TAB-128. Status: spec for review. Nothing here is built yet.

Johan asked whether Tabula has flip cards. It does not: no object has a back side, and there is no mirror flip either. This page specifies the reading the issue assumes, **a card with a front and a back that turns over on click**, and notes the other reading, **mirroring a shape**, as a small separate item at the end ([Mirror flip](#mirror-flip-the-other-reading)).

Uses the issue names: flashcards and quizzes, answers hidden in a workshop, reveal moments in a retro, estimates in planning poker. What these have in common is that the same place on the board shows one of two things, and the answer to "who sees which" differs: study alone, or reveal to everyone together. That difference, personal versus shared, is the main design question.

## Summary

- **A "two-sided" option on sticky notes and shapes, not a new object type.** A card is a sticky or a shape with a second set of face fields (`backText`, `backFill`, `backTextColor`, and an optional back icon). Everything else (resize, rotate, lock, frames, connectors, comments, copy and paste, MCP, history) keeps working because the object is the same object.
- **Two kinds of flip, chosen per card.** **Just me**: a click turns the card over on your screen only, stored in your browser, visible to nobody else, available to viewers too. **Everyone**: a click writes the card's shared face into the board, so everyone sees it turn. New cards are **Just me**; the facilitator switches the ones that should be revealed together.
- **Facilitator controls**: **Reveal all** and **Hide all** on a selection, a frame or the whole board, as one undo step, and a session-step option **Cards** (*Front* or *Back*) that sets the faces of the step's cards when the session moves to that step.
- **Editing the back**: flip the card, then double-click or press Enter; the editor edits the side you are looking at. The quick-action bar and properties panel apply to the visible side.
- **The turn** is a quick horizontal squash and swap drawn in 2D (CSS 3D does not apply to SVG children), instant under reduced motion.
- **The back is not a secret.** It lives in the board document like every other field, so it is in exports of the JSON, in `.drift` files and in the data every collaborator's browser holds. This is the same status as notes hidden by private-writing steps today. See [Confidentiality](#confidentiality-the-back-is-not-a-secret).
- **Not in v1**: images on a card's back (they follow TAB-127), a dedicated planning-poker mode, a flip counter or timer, mirror flip.

## Decisions and why

1. **An option on existing objects, not a new `card` type.** Every place the app switches on object type (render, editor, quick-action bar, properties, hit test, export, templates, MCP, history, import) already handles stickies and shapes. A new type would need a branch in all of them and duplicate colour, font, alignment and shape handling. The cost of the option is a handful of extra fields and a "which side" parameter in the few functions that read text and colour.
2. **Flat fields, not a nested `back` object.** The store writes one Y.Map key per changed field, so two people editing the back's text and its colour at once both win. A nested `back: {text, fill}` value would be replaced whole, and the later write would erase the other's change. The existing icon fields (`ref`, `body`, `viewBox`) are flat for the same reason.
3. **Personal is the default.** A stray click on a shared card changes the board for everyone and shows up in everyone's undo history. A personal flip cannot hurt anyone, needs no write permission and makes flashcards work on a read-only board. Reveals are deliberate, so they are a separate setting.
4. **Shared state in the document, personal state in the browser, nothing in awareness.** Awareness disappears after 30 seconds of silence or a disconnect and is not saved, so it can not hold "which cards I turned". A shared flip must survive a reload and be undoable, so it is a document field. Personal peeks are the same kind of per-person state as the hidden idle bar and muted people, which already live in `localStorage` under `driftboard:<thing>:{user}:{board}`.
5. **A shared write beats an older personal flip.** Each shared face is written with a timestamp (`faceAt`). A personal peek stores its own time; if the card's `faceAt` is newer, the peek is dropped. This makes **Reveal all** and **Hide all** reset everybody's local turns without any message to anybody.
6. **2D squash, not 3D rotation.** The board is one SVG; each object is a `<g>`. CSS `rotateY` and `perspective` do not render for SVG children in the browsers we support. The effect used is `scaleX` to 0 about the card's centre, swap the face, `scaleX` back to 1, over about 200 ms, which reads as a card turning.
7. **The server stays out of it.** A flip is a field write on an object, so the relay, history and backups treat it like any edit. No new socket message, no new table, no new route.

## Object model

Fields added to `BaseObj` (`src/types.ts`), all optional, only meaningful on `sticky` and `shape` objects:

| Field | Type | Meaning |
|---|---|---|
| `twoSided` | `boolean` | the card has a back. Absent or false: an ordinary object, and the other fields below are ignored |
| `flipMode` | `'personal' \| 'shared'` | what a click does; absent means `personal` |
| `face` | `'front' \| 'back'` | the shared face, what everyone sees unless they hold a newer personal flip; absent means `front` |
| `faceAt` | `number` | time of the last write to `face` (milliseconds), used to retire older personal flips |
| `backText` | `string` | the back's text |
| `backFill`, `backTextColor` | `string` | the back's colours, same format as `fill` and `textColor` |
| `backAlign`, `backValign`, `backFont` | as the front | optional; absent means "same as the front" |
| `backRef`, `backBody`, `backViewBox` | as `ref`, `body`, `viewBox` | optional icon on the back, sanitised like any icon body |

The back keeps the front's size, position, rotation, shape kind, stroke and lock. Connectors attach to the object, so they behave the same on both sides.

Which types: **`sticky` and every `shape` kind** (the issue says "sticky notes and shapes"). Frames, text, icons, drawings, UML elements and connectors are not cards. Images get a back later (TAB-127).

The `sideKey(o, side, field)` function (one pure helper in `src/cards.ts`) maps `('back', 'fill')` to `backFill` and so on, with the front-fallback for the optional ones. Everything that reads or writes a face field goes through it. The facts this spec relies on, from the code today:

- `src/markup.ts` `objectMarkup`/`wrapG` is the only place that draws an object, and the only transform is translate and rotate. The hidden-sticky branch ("Hidden until reveal") shows the pattern for drawing something other than the stored text.
- `src/editor.ts` picks the text field by type (connector label, UML class, frame name, otherwise `o.text`). It gains one more rule: the face being looked at decides between `text` and `backText`.
- `src/style-edit.ts` writes a generic patch (`WriteFn`), so colour changes from the quick-action bar and properties panel need no new plumbing beyond choosing `fill` or `backFill`.

## Flip state

### What a viewer sees

`effectiveFace(o, peeks)` (pure, in `src/cards.ts`):

1. Not two-sided: front.
2. A personal peek for this card, newer than `faceAt` (or `faceAt` absent): the peek's face.
3. Otherwise `o.face ?? 'front'`.

A peek stores `{face, at}` per card id in `localStorage` under `driftboard:cards:{user}:{board}`, as JSON, capped at 500 entries (oldest dropped). Opening the board, switching tabs and reloading keep it. It is not synced, not exported, not in history and not in a `.drift` file.

### What a click does

- **`flipMode: 'personal'`**: toggles the peek between the shared face and the other side. Nothing is written to the board. Works for everyone who can see the card, including viewers, commenters and people on a read-only workspace.
- **`flipMode: 'shared'`**: writes `face` (the opposite of the current shared face) and `faceAt` in one transaction, one undo step. Only people who can write the board (owner, editor) can do this. For a viewer or commenter a click on a shared card falls back to a personal peek, and a tooltip on the card says "Only editors flip this card for everyone."
- A **double-click** edits (as always); a **click on the selected card** turns it, a click on an unselected card selects it first, so dragging and selecting do not flip anything. The quick-action bar has an explicit **Flip** button (and `B`) for people who do not want to click the card itself, and for locked cards.
- **Locked cards** are click-through background (as everywhere), so a click does not flip them and they cannot be selected for `B` or **Flip**. **Reveal all** and a step's **Cards** setting still apply to them, because those are the facilitator's writes, not clicks.

Who decides the mode: **Flip for** in the quick-action bar and properties panel, a two-way segmented control, **Just me** and **Everyone**, shown when a two-sided card is selected. It is an ordinary edit (undoable). With several cards selected it sets them all.

### Facilitator: reveal all and hide all

- **Reveal all** and **Hide all** act on a **scope**: the current selection (cards inside it, and every card inside a selected frame), or the whole board when nothing is selected. They appear in the quick-action bar when a card, several objects or a frame is selected, and in the session bar's **Cards** group when the session has a step that uses cards.
- They write `face` (`back` for reveal, `front` for hide) and a fresh `faceAt` on every two-sided card in scope, in a single transaction: **one undo step** that restores the previous faces. Cards in `personal` mode are included, since "reveal all" means exactly that, and personal peeks older than the write are dropped by the `faceAt` rule.
- Only owners and editors can use them (they are writes). Viewers do not see the buttons.
- A short stagger (40 ms per card, up to 400 ms in total) between the turns of a mass flip, so a revealed grid ripples rather than snaps. Reduced motion removes it.

### Session steps

`Step` (`src/types.ts`) gains an optional `cards: 'front' | 'back'`. The step editor shows **Cards when this step starts: leave as they are · Front · Back**. When the session moves to a step with `cards` set, the client that moved it writes, in the same transaction as the flow change, the face for every two-sided card in the step's frame (or on the whole board when the step has no frame), the same code path as **Reveal all**. This follows how `reveal()` already works for private notes (a write made by the person who moved the session, not a rule evaluated by every client, so nobody writes twice).

Examples: *Think*, with `cards: 'front'`, and *Reveal*, with `cards: 'back'`, make a quiz; a retro with the answers hidden uses one step and the **Reveal all** button.

- **Moving backwards** in a session applies the earlier step's setting again, so going back to *Think* hides the answers again.
- **Ending the session** leaves the faces as they are.
- A step that moves the session also moves other people's views only through the focus features that exist; flipping never moves anyone's view. A facilitator who wants people to look at a revealed card uses **Ask everyone to look here** (focus requests, TAB-111).
- `cards` is a step field, not a step mode, so it combines with `write`, `cluster`, `vote`, `discuss` and `private-write` and is ignored by `poll` steps.

## Editing the back

- **Make a card two-sided**: select a sticky or shape and choose **Two-sided** in the quick-action bar (a toggle, in the same group as lock and duplicate). The back starts with the front's colours and empty text. Turning it off asks nothing if the back is empty; otherwise a confirmation ("Remove the back? Its text will be lost. Undo brings it back.").
- **Edit the back**: flip the card (peek or shared, whichever your **Flip for** is), then double-click it or press `Enter`. The editor edits the text of the side you are looking at, with the same text box, auto-shrink and layout as the front. There is also **Edit back** in the quick-action bar (opens the editor on the back without turning the card), for when the card is shared and you do not want to flip it for everyone just to type.
- **Colours and text options** in the quick-action bar and properties panel apply to the side you are looking at. The properties panel has a **Side** control (**Front**, **Back**) that follows what is visible and can be changed without turning the card (it changes which fields the panel shows and writes, not what everyone sees).
- **Copy and paste, duplicate** carry both sides and the settings. A pasted card keeps `face` but its `faceAt` is reset so it does not retire anybody's peek.
- **Text size** and fonts are per side only if set (`backFont`); otherwise the back inherits.
- **Undo**: shared flips and edits of the back are ordinary board edits, one step each. Personal peeks are not undoable and are not in the undo history.

## Rendering and motion

- The card draws the face chosen by `effectiveFace`. Both faces use the object's existing outline and size, so nothing about hit testing, handles, snapping, smart guides or connectors changes.
- **Animation**: when an object's effective face changes between two renders and the object is on screen, the renderer animates it with the Web Animations API on the object's `<g>`: `scaleX(1 → 0)` over 100 ms ease-in, swap the markup, `scaleX(0 → 1)` over 100 ms ease-out, with the transform origin at the box centre (`transform-box: fill-box`). To make "changed between renders" mean what it says, the renderer remembers the last face it drew per card id and **does not animate the first render of an object, a version restore or a board load**. This matters because `invalidateAll` rebuilds every visible object on any flow change, and a naive CSS animation on the rebuilt node would replay on every session step.
- **Remote flips** animate the same way (a shared flip from a collaborator arrives as a document change). A card that is off screen swaps without animating.
- **Reduced motion**: `matchMedia('(prefers-reduced-motion: reduce)')` is read when the animation would start, and the swap is instant. The stagger is dropped too. (The app already respects the setting for cursors, the poll arc and tooltips; `.timer-fill` has no query today and is outside this spec.)
- **Accessibility**: the canvas is one SVG with `role="application"`; individual objects have no roles or labels, so a card cannot announce itself. A flip writes "Card turned to the back" or "Card turned to the front" into a polite live region (the same pattern as the focus-request stack), and a mass reveal writes one summary ("12 cards revealed"). The side shown is also what the text editor opens on, so a keyboard user can select a card, press `B` to turn it and `Enter` to read and edit it.
- **Themes**: the back has its own `backFill`, so the five themes' ink and paper rules apply to it the same way they do to the front (the existing contrast tests keep covering the swatch colours).

## Keyboard

`B` turns the selected two-sided cards (personal peek or shared flip, per card). `F` is already the frame tool, so it cannot be used; `B` is free. It is not a tool, so it goes in the shortcuts table (`src/shortcuts.ts`) as an Edit row, and the existing test that compares the key handler with the table covers it. `Enter` on a selected card edits the visible side. No shortcut for **Reveal all** in v1 (a mass change should be a deliberate click).

## Export, import and the other formats

| Format | What a two-sided card shows |
|---|---|
| **PNG and SVG** | The **shared face** (`face`), never a personal peek. Because new cards start on the front, and a hidden answer stays on the front until a facilitator reveals it, an export taken mid-session does not leak the answers. After a **Reveal all** the export shows the revealed side, because that is what the board shows. Peeks are not part of the board. |
| **.drift and JSON** | Everything: `twoSided`, both faces, `face`, `faceAt`, `flipMode`. This is the full board and the format makes no promise of secrecy (see below). |
| **Markdown summary** | Lists the front text. When `face` is `back` it lists "front → back". Backs of cards still on the front are not listed, for the same reason as the export. |
| **Copy and paste of objects, board import** | Carry all the fields (the paste handler already moves whole objects). |
| **Copy as Mermaid** | Ignored, as for any text-less path. |

The two exports (SVG and PNG) reuse `objectMarkup` with an explicit face argument instead of the viewer's effective face, so the exporter never reads `localStorage`.

## Templates

- **Field allow-lists must learn the new fields**. `server/templates.mjs` validates uploaded template objects with an explicit field whitelist (`box()`), and a field not on it is dropped; `src/custom-templates.ts` passes unknown fields through but normalises known ones. The whitelist gains `twoSided`, `flipMode`, `backText`, `backFill`, `backTextColor`, `backAlign`, `backValign`, `backFont`, `backRef`, `backBody` (sanitised like `body`) and `backViewBox`. The step whitelist gains `cards`. A test pins the lists so a new field cannot be silently dropped from a saved template again.
- **Not saved into a template**: `face` and `faceAt`. A template always starts with every card on the front, so saving a template from a board where the answers were revealed does not save the revealed state.
- **Built-in templates**, using the existing `Builder` (`src/templates.ts`):
  - **Flashcards**: a frame "Deck" holding six two-sided stickies, **Just me**, a question on each front ("Capital of France?") and the answer on the back ("Paris"), and a short note sticky explaining "Click a card to turn it over; select a card and press Enter to edit it." No session steps.
  - **Hidden answers**: a frame of two-sided stickies with **Everyone**, questions on the front and answers on the back, and two session steps, **Think** (`cards: 'front'`, mode `discuss`) and **Reveal** (`cards: 'back'`). The facilitator runs it with the session bar.
  - Both go into the Templates page categories that exist (Discussion for the second, Ideation for the first) and need thumbnail rendering to draw the front.
- `privateStep` is not combined with cards in the built-ins (the Builder has no way to pre-hide objects today, and the server and client template validators both drop `privateStep`).

## History

Cards add ordinary fields. Version restore compares fields generically, so a restore brings back the old faces, backs and modes with no history-specific code. A restore writes `faceAt` like any field, which retires personal peeks made before it (a restored board shows what the version showed). History snapshots include both sides of every card, the same status as the rest of the board. Restores skip objects hidden by private-writing steps today; a card that is also in a private-writing step is simply one of those.

## MCP and the other AI tools

- Reads (`get_board`, `get_objects`) return `twoSided`, `flipMode`, `face` and the text of the **shown** side as text, fenced and escaped like all board text. **`backText` and the other back fields are withheld from reads while `face` is `front`**, the same rule the tools already apply to private-writing stickies, so an AI tool cannot read hidden answers it was never meant to see; once a card is revealed (`face: 'back'`) the back is returned and the front is as well.
- Writes: `update_objects` may change the faces and mode of an existing card; `create_objects` does not create two-sided cards in v1 (its per-type key lists do not include the new keys, and adding them is a small follow-up if wanted).
- `CREATE_KEYS`, `UPDATABLE` and `BOX_FIELDS` in `server/board-ops.mjs` get the new keys for the update path, and the summariser's withholding gets one more case. The tests cover that a front-facing card's back is absent from every tool's output.

## Permissions

| Action | Who |
|---|---|
| Turn **Two-sided** on or off, edit the back, change **Flip for** | owner and editor (document writes) |
| **Personal flip** (a click on a `personal` card, or on a `shared` card by someone who cannot write) | everyone who can see the card, including viewers, commenters, guests, and people in a read-only workspace |
| **Shared flip** and **Reveal all / Hide all**, and the session step's **Cards** | owner and editor |
| Flip a locked card | not by clicking (locked objects are click-through and cannot be selected, so `B` and **Flip** cannot reach them either); **Reveal all**, **Hide all** and a step's **Cards** setting still apply to locked cards |
| Cards hidden by private writing | follow the existing rule: the whole card is hidden from other people until the reveal |

A read-only hosted workspace drops document writes silently, so a shared flip made there does nothing; the UI treats the workspace as read-only (as it does for every other write) and falls back to a personal peek.

The relay needs no change: a card is a box object with more keys, written through the same Yjs path as any other edit.

## Confidentiality: the back is not a secret

The board document is shared in full with every client that opens the board. Hiding in Tabula is a **display rule**, not an access rule: notes in a private-writing step are in the document too (and any collaborator can read them through exports, developer tools or the JSON), and a session's markdown summary today even lists them (found while reading `summaryMarkdown` for this spec; reported separately, see open questions). Cards are the same: the back is `backText` in the board document, readable by anyone who can open the board.

What the design does guarantee:

- It is not shown in the UI, in PNG or SVG exports, in the Markdown summary, or to AI tools through MCP until a facilitator reveals it.
- A template saved from a board keeps the back text (it is the card's content) but resets every card to the front, so a revealed state is not saved.

What it does not:

- A participant with developer tools, a JSON or `.drift` export, or a collaborator's browser extension can read the backs of a hidden-answers board.
- Anyone who can edit can also turn the card over for themselves or everyone.

The user guide and the template's note must say this plainly ("answers are hidden on screen, not locked away"). If real secrecy is ever needed (an exam, a sealed estimate), it needs a different mechanism: the server withholding the field from clients that may not see it, which would be a relay feature of its own. That is a question for Johan below.

## Limits

- At most 200 two-sided cards per board in v1 (checked in the **Two-sided** toggle with a message), so a **Reveal all** is one bounded transaction. The ordinary 5000-object cap still applies.
- `backText` follows the same length limit as `text` (4,000 characters). Back icons follow the icon body limit.
- A mass flip (reveal, hide, step) writes at most 200 objects in one transaction.
- Personal peeks: 500 per person per board in `localStorage`.

## Tests

Pure (vitest):

- `test/cards.test.ts`: `effectiveFace` (not two-sided, no peek, older peek retired by a newer `faceAt`, newer peek wins, absent `face`), `sideKey` mapping and front-fallback, flip target for each mode and role, scope selection for reveal and hide (selection, frame children, whole board, ignores non-cards), the 200 limit, the stagger schedule, peeks capping at 500 entries.
- `test/cards-render.test.ts`: `objectMarkup` for a two-sided sticky and shape on each face, the same card on `exportFace`, hidden-until-reveal interplay with `privateStep`, text and colours from the right side.
- `test/cards-flow.test.ts`: a step's `cards` setting applied on `goto` in the same transaction, going backwards, ending a session, ignored by poll steps.
- `test/cards-templates.test.ts`: the server and client template whitelists accept the new fields and drop `face` and `faceAt`; the two built-in templates validate and instantiate with every card on the front.
- `test/cards-mcp.test.ts`: a front-facing card's back is absent from every read tool; a revealed card's back is present; `update_objects` can set the faces; `create_objects` refuses the new keys.
- `test/shortcuts.test.ts`: the new `B` row is covered by the existing comparison with the handler.
- The animation decision is tested as a pure function (`shouldAnimateFace(prev, next, onScreen, reducedMotion)`); the animation itself is checked by hand in a browser at 390 px and desktop width, with reduced motion on and off.

Round-trip: a board with cards through `.drift` and JSON export and import keeps both faces; the SVG export of a hidden card never contains its back text.

## Not in this slice

- Images on a card's back (TAB-127 first), a different size or shape for the back, rotation about the vertical axis in 3D.
- A planning-poker mode (a hidden value per person, revealed together). The pieces exist after this slice (shared faces, **Reveal all**, a **Cards** step); the missing piece is "one card per person that only that person can set" and that is a session feature of its own.
- Flip counters, timers, scoring, a "study mode" with right and wrong piles, spaced repetition.
- A server-enforced hidden back.
- Cards created by AI tools, and a card-specific tool on the rail.
- Mirror flip (below).

## Slices

1. **Fields, rendering, editing and personal flip.** `twoSided`, back fields, `sideKey`, `effectiveFace`, `localStorage` peeks, drawing the visible face, **Two-sided** and **Edit back** and **Flip for** in the quick-action bar and properties panel, the editor choosing the side, shared flips as document writes, `B`. No animation yet.
2. **Motion and announcements.** The squash turn and its swap, the change detection that avoids replays, reduced motion, remote flips, the live region.
3. **Facilitator.** **Reveal all** and **Hide all**, the stagger, the step field **Cards** in the step editor and `goto`, the session bar group.
4. **Everything around it.** Exports (explicit face), Markdown summary, templates (whitelists, reset on save, the two built-ins), MCP withholding and update keys, history check, the limits.
5. **Docs and polish.** The user guide page (including the confidentiality note), the `docs/` spec update to "as built", themes and phone checks.

Slices 1 and 2 give a working card; 3 is what makes it a facilitation tool; 4 is what makes it safe to leave on.

## Files

### New

- `src/cards.ts` (pure: `effectiveFace`, `sideKey`, flip logic, scope selection, peeks storage, `shouldAnimateFace`)
- `src/ui/cards.ts` (quick-action bar and properties pieces, the mass-flip controls) and a small `src/ui/cards.css` if needed (theme variables only)
- the tests listed above

### Existing (touched)

- `src/types.ts` (fields, `Step.cards`), `src/markup.ts` (face argument), `src/render.ts` (change detection, animation), `src/editor.ts` (side choice), `src/app.ts` (click, `B`, selection scope), `src/ui/quickbar.ts`, `src/ui/props.ts`, `src/style-edit.ts` (side keys), `src/flow.ts` and `src/ui/flowbar.ts` (step field, controls), `src/exporters.ts` (explicit face, summary), `src/templates.ts` (built-ins), `src/custom-templates.ts`, `src/shortcuts.ts`
- `server/templates.mjs` (whitelists), `server/board-ops.mjs` (keys, withholding)
- `docs/guide/` (a cards page), `CHANGELOG.md`

## Mirror flip, the other reading

If Johan meant **mirroring a shape or image horizontally or vertically**, that is a different and smaller feature. It should be its own issue and does not block flip cards. A sketch so it can be sized:

Mirror flip is now available as **Flip horizontal** and **Flip vertical** (`flipX` and `flipY`, with `Shift+H` and `Shift+V`). Text is never mirrored, and connector anchors follow the visible sides. For a two-sided card, the action is **Turn over** in every menu, tooltip, announcement and shortcut; it never uses `Shift+H` or `Shift+V`. Mirror flip on a two-sided card mirrors shapes on both faces and never mirrors text.

- **Fields**: `flipX` and `flipY` booleans on box objects (shapes, icons, images, stickers), absent meaning false.
- **Rendering**: `wrapG` today applies translate and rotate only. A mirror adds `scale(-1, 1)` or `scale(1, -1)` about the box centre, applied to the **outline only**, never to the text (mirrored text is unreadable), so the text layer is drawn in a sibling group. Icons and stickers mirror their artwork; an image mirrors its bitmap.
- **Order with rotation**: mirror first, then rotate. The rotation direction flips visually when mirrored once; the rotate handle and `rotation` field keep meaning "clockwise on screen" so people are not surprised.
- **Geometry**: connector anchors (`sideAnchor`, `shapeAnchor`) must follow an asymmetric outline (arrows, chevrons, pentagon arrow, speech boxes, delay, display, document, manual input and operation); `resolveSides` (the new fan-out layout) returns null for rotated boxes and would do the same for mirrored ones at first. Hit tests and resize handles are unaffected for the bounding box.
- **UI**: **Flip horizontal** and **Flip vertical** in the quick-action bar and the properties panel, and `Shift+H` and `Shift+V` as shortcuts (`H` alone is the hand tool; the key handler only claims `Shift` combinations for digits today, so these are free). A multi-selection mirrors about its common centre.
- **Elsewhere**: export follows `objectMarkup`; templates and MCP whitelists gain the two booleans; history needs nothing.
- **Size**: small to medium, mostly connector anchors for asymmetric shapes; slices as one issue.

## Open questions for Johan

1. **Which meaning of "flip cards"?** Two-sided cards that turn over (this spec), the mirror flip, or both? The mirror flip is spec'd as a separate small item above.
2. **Default flip mode.** New cards **Just me** (this spec) or **Everyone**? "Everyone" suits facilitated reveals; "Just me" cannot be done by accident to a whole workspace.
3. **Is it acceptable that the back is not a secret?** Hidden answers are hidden on screen only (like private notes today); anyone can read them from an export or developer tools. If that is not acceptable, the real fix is the relay withholding the field, which is a bigger separate feature.
4. **What exports and summaries show.** The shared face, so a hidden answer is never exported and a revealed one is (this spec), or always the front, or an export option "cards: front, back, as shown"?
5. **Which objects can be cards.** Stickies and all shapes (this spec), or only stickies and rectangles to keep the first version small?
6. **Animation.** The 2D squash turn (this spec) or a plain cross-fade? Under reduced motion both are an instant swap.
7. **Keyboard.** `B` for turn (this spec) because `F` is the frame tool, or another key?
8. **Reveal stagger.** A 40 ms ripple on mass reveals (this spec), or all at once?
9. **Planning poker.** A dedicated mode where each person sets their own hidden value and the facilitator reveals all at once is a natural next step but is a session feature of its own. Wanted soon, or later?
10. **Viewers on shared cards.** A viewer's click falls back to a private peek with a tooltip (this spec), or does nothing?
11. **AI tools.** The back is withheld from MCP reads until revealed (this spec). Should an AI tool ever be able to create two-sided cards (flashcard generation is an obvious AI feature, tied to TAB-123)?
12. **A related bug found while reading the code.** The Markdown summary (`flow.summaryMarkdown`) lists every note with text inside frames, including private-writing notes that are hidden on screen, and totals votes before they are revealed, so a participant can download another person's hidden note from **Markdown summary** mid-session. It is a display rule, not a security boundary, but it defeats the purpose of the hidden step; it needs its own issue.
