# Presentations

TAB-104. Status: spec for review. Nothing here is built yet.

People already build slide-like things on the board: a frame per topic, laid out left to right, with a heading and a few notes in each. What is missing is the last step, standing up and showing them. Today you pan and zoom by hand while talking, chrome and cursors are in the way, there is no order, no notes, no timer, and nobody else can follow you except by a request you send each time.

This page specifies **presentation mode**: any frame can be a slide, a **Slides** panel orders them, **Play** shows them full-screen one at a time, a **presenter view** shows notes, the next slide and a timer, other people can **follow** you if they choose to, a **laser pointer** draws a fading trail for everyone who is looking, and the slides leave as PDF (and, later, PowerPoint). It follows Johan's rule from TAB-111, which this page builds on: **nobody can force anyone else to watch, focus on or follow them.**

It sits next to four neighbours and says how it fits each: session **steps** (`src/flow.ts`, the facilitation features), **focus requests** and following (`docs/focus-requests.md`, shipped), **pages** (TAB-137, not built) and **export** (PDF in TAB-146, PowerPoint in TAB-105).

## Summary

- **A slide is a frame with a rank.** A frame becomes a slide when it has a `slide` field (a fractional-indexing key); slides are shown in key order. No second list exists, so reordering is one small write per moved slide and two people reordering different slides never overwrite each other. Notes, a "skip in Play" flag and the order live on the frame.
- **The Slides panel** lists the slides with live thumbnails: drag to reorder, rename in place, hide from Play, duplicate, remove from slides, **New slide** (16:9 by default, also 4:3 and custom) placed next to the last one, and **Make slides from my frames**.
- **Play** is a button in the top bar. It goes full-screen, hides all chrome, other people's cursors, comment pins and the grid, shows exactly the frame's rectangle fitted to the screen, and moves between slides with the arrow keys, `Space`, click, tap and swipe. A slide counter and a thin progress line appear on movement. `Esc` leaves. Transitions are **fly** (the camera zooms to the next frame, the default), **fade** or **none**.
- **The presenter view** shows the current slide, the next slide, the speaker notes and a timer, in a second window (synchronised with the audience window) or, where a second window is not wanted, in the same window beside the slide.
- **Following is an invitation.** Starting Play can send one **invitation** to the board (a new kind of the shipped focus request); each person gets the same non-blocking card with **Follow**, **Go to**, **Dismiss**, **Mute**. A person who follows sees the presenter's current slide fitted to their own window, stays in control of their own view, and stops by panning, zooming, pressing `Esc` or pressing **Stop**. Someone who joins late sees "Ana is presenting" in the top bar and can follow from there. Nothing ever moves a view that did not ask.
- **The laser pointer** is a coloured dot with a trail that fades in about a second, in the presenter's cursor colour, visible to everyone looking at that part of the board, and never written to the document. `L` toggles it in Play; outside Play it is a rail tool for teaching and workshops.
- **Export**: **PDF** (one slide per page, in order) is owned by TAB-146; this page says what it asks of it. **PNG per slide** comes free from the existing export. **PowerPoint** (TAB-105) has everything it needs in the data model of this page (size, order, notes, background, skip, transition).
- **Session steps stay separate** and share frames: a step's `frameId` can be a slide, a button turns slides into steps and steps into slides, and both use the same follow channel. They are not unified because they mean different things (see decision 3).

## Decisions and why

1. **Slides are frames, marked by a field, not a separate object.** Johan's brief says "slides = frames", and a frame already is what a person draws a slide on: a rectangle that owns what is inside it, with a name, a fill and a place on the board. A `slide` object would have to be kept in step with a frame (size, content, deletion). A field on the frame means copy, paste, duplicate, templates, history, undo, locking, `.drift` and MCP all work with no new type and no new list. The cost is that "which frames are slides" is a question of a field, which the Slides panel answers.
2. **The order is a rank on each slide, not an array in the board.** An `order: [frameId, ...]` array would be written whole by every reorder: two people moving different slides at once would lose one move, and deleting a frame would leave a dangling id. A fractional-indexing key per slide (the library the board already uses for stacking, `fractional-indexing`, and the kanban spec's `rank`) changes one value on the slide that moved. Equal keys sort by id, and the next move repairs them. This is the same decision the kanban spec made for cards.
3. **Session steps stay separate from slides; they share frames and the follow channel.** A step has a *mode* (brainstorm, vote, poll, private writing, reveal), a duration and a timer, and it changes what everybody can do and see (private notes hidden until reveal, vote dots). A slide changes nothing about what anyone can do: it is a view. A person who wants to show five frames should not have to create five session steps with modes, and a facilitator running a vote should not need slides. They overlap in one place: both point at a frame and both ask others to go there. So: a step may point at a slide frame (it already has `frameId`); **Use slides as steps** creates one step per slide (title from the frame name, mode brainstorm) and **Make slides from steps** adds the `slide` field to the frames the steps point at; and both send their invitations through the same focus-request channel. The unification question is the first open question for Johan.
4. **Play is a view over the live board, not a copy of it.** Play locks the board's own renderer to the frame's rectangle, hides the chrome and clips drawing to the rectangle. That keeps text crisp (it is SVG), fonts and images exactly as on the board, edits by other people visible if they happen, and no second rendering path to keep correct. Thumbnails and the presenter's next-slide preview are different: they are small static SVG renderings of one frame (the same markup the export uses), updated when the frame changes.
5. **Following uses the shipped protocol and adds one awareness field.** `docs/focus-requests.md` already has requests (a card with Follow, Go to, Dismiss, Mute), a follow chip, and the rule that any pan, zoom or `Esc` stops following. A presentation adds a request kind (`slide`, the invitation) and a long-lived awareness field `presenting` (so a latecomer can follow without having seen the invitation). The follower's client moves its own camera to the presenter's current slide **fitted to the follower's window**, so differences in window shape do not matter; the presenter's camera is not mirrored.
6. **The laser is presence, not content.** It is an awareness field with a position and a time, drawn locally as a dot with a fading trail from the last few positions. It writes nothing, so it cannot be undone, saved, exported or leaked, and it needs no new server code. It is allowed to anyone with access to the board, viewers included, as cursors are.
7. **PDF belongs to TAB-146; this page supplies the page list.** A multi-page PDF of frames is wanted outside presentations too (handouts, strategy boards). Building a PDF writer here would duplicate it. This page defines the **page list** (slides in order, each with its size and name, optionally notes) and the call `exportPages(pages, options)` that TAB-146 implements; until that exists, the first slice of PDF is the browser's print route (below), which needs no library.
8. **Chrome-free and key-safe.** Play is a mode in which **none of the board's keys act**. Tool letters, `Delete`, arrows (which nudge), `Ctrl+D` and the rest are suspended, the selection is cleared and the text editor is closed on entry. A presenter who presses `Delete` to dismiss a pop-up or `D` out of habit must not change the board in front of an audience.

## The model

### On a frame

| Field | Type | Notes |
| --- | --- | --- |
| `slide` | string | A fractional-indexing key. Present means "this frame is a slide"; slides sort by it, ties by id. Only a top-level frame (no `parent`) can be a slide. |
| `skip` | boolean | Optional. A slide with `skip: true` stays in the panel (greyed, "Hidden in Play") and is left out of Play, the PDF and the presenter's count. |
| `notes` | string | Optional speaker notes, plain text, at most 4,000 characters. |

The frame keeps its existing fields: `name` (the slide's title, shown in the panel and read by screen readers), `x`, `y`, `w`, `h`, `fill` (the slide background; no fill means the theme's canvas colour), `locked`.

Rules:

- **Reordering** writes one new key for the moved slide, between its new neighbours (`generateKeyBetween(a, b)`). Keys that are not valid or are equal are treated as the same value and ordered by id; the next reorder writes a valid one.
- **Removing from slides** deletes the `slide`, `skip` and `notes` fields on the frame (notes are kept in a `notes` field if the frame is a slide again within the same session via undo; otherwise gone; see the open questions for a keep-notes alternative). The frame and its content stay.
- **Deleting a frame** deletes the slide with it (as it deletes the frame today). The Slides panel's **Delete slide** asks first ("Delete slide 3 and its 5 items?") because it deletes content; **Remove from slides** is the safe action next to it.
- **A frame nested in another frame, or locked inside a container, cannot be a slide**; the panel offers no **Make a slide** for it.
- **The fields survive in old clients.** A client that does not know slides ignores the fields, preserves them when it edits other fields of the frame, and draws the frame as it always did. No gating is needed, unlike containers (`meta.features`).

### On the board

Three optional keys in `meta`, written by editors and read by everyone:

| Key | Values | Default |
| --- | --- | --- |
| `slideTransition` | `'fly'`, `'fade'`, `'none'` | `'fly'` |
| `slideNumbers` | boolean: draw the slide number at the bottom right of each slide in Play and in PDF | `false` |
| `slideSize` | `'16:9'`, `'4:3'`, or `{ w, h }` (the size **New slide** uses) | `'16:9'` |

Sizes are in board units: **16:9 is 1280 by 720**, **4:3 is 1024 by 768**, custom 200 to 8,000 on a side. Play scales to the screen, so the size only sets the working space for text and the relation between slide and content.

### The slide list

One pure function, `slidePlan(objects, meta)` in `src/slides.ts`, returns the ordered list the rest of the code uses:

```
SlideRef = { id: Id, index: number, title: string, rect: Rect, skip: boolean, notes: string, pageId?: Id }
slidePlan(...) -> { slides: SlideRef[], playable: SlideRef[] }   // playable = slides without skip
```

The panel, Play, the presenter view, export, MCP and the AI all call it. `pageId` is empty until pages (TAB-137) exist; see [Pages](#pages-tab-137).

### Limits

200 slides per board; 4,000 characters of notes; slide size 200 to 8,000 board units per side; one invitation per 10 seconds per presenter (the focus-request limit).

## The Slides panel

A **Slides** button in the top bar (between the sync pill's group and **Share**) toggles a panel on the **left** beside the tool rail, 280 px wide, over the canvas as the comments panel does on the right. At 860 px and below it is a bottom sheet (see [Phone](#phone-and-touch)).

```
Slides                      [+ New slide ▾]  [×]
─────────────────────────────────────────────
1  ┌────────────┐  Welcome              ⋯
   │  thumbnail │
   └────────────┘
2  ┌────────────┐  Roadmap     ◌ hidden  ⋯
   │            │
   └────────────┘
3  ┌────────────┐  Risks                ⋯
   └────────────┘
─────────────────────────────────────────────
Notes for slide 2                       0/4000
[ textarea                                   ]
```

- **Thumbnails** are static SVG renderings of each frame (the export markup, clipped to the rectangle), updated at most every 400 ms after a change inside the frame, and only for rows in or near the viewport of the panel.
- **Click a row**: selects the frame and flies the camera to it (`flyTo`). **Double-click the name** (or `F2`) renames the frame in place. The frame is also the board's current selection, so the quick-action bar and the properties panel work on the slide.
- **Drag a row** to reorder: a drop line shows the place; the drop writes one `slide` key. The keyboard route is `Alt+Up` and `Alt+Down` on a focused row ("Moved to position 3 of 8").
- **Row menu (⋯)**: **Play from here**, **Rename**, **Hide in Play** or **Show in Play**, **Duplicate slide** (a copy of the frame and its children placed after the last slide, a new key right after the original), **Remove from slides**, **Delete slide…**.
- **New slide**: a split button. The main part adds a slide of the board's `slideSize`; the arrow offers **16:9**, **4:3** and **Custom size…** (a width and a height), and sets `slideSize` for later slides. The new frame is placed **to the right of the last slide** in order, same top edge, 80 units apart; if that would overlap another frame it goes below the lowest slide's row instead. It gets the name "Slide 4" and its key goes after the last slide's. The view flies to it and its first line is ready to type (a text box is not created: the frame is empty).
- **Make slides from my frames** appears when the board has top-level frames that are not slides (also as the empty state of the panel and of **Play**): it adds ranks to all of them in **reading order** (rows then columns, the order of `docs/canvas-keyboard.md`).
- **Make a slide** on a selected frame (quick-action bar and the frame's object menu) marks one frame as a slide at the end of the list.
- **Notes** edit in the textarea below the list for the selected slide, saved as the person leaves the field (as every field in the app is). A small line says "Notes are saved in the board and everyone who can open it can read them."
- **Slide numbers** can be shown on the frames' title strips while the panel is open (`3 Roadmap`), so a slide is recognisable on the canvas.
- **Roles.** Owners and editors change slides; commenters and viewers see the list and thumbnails, can click a row to fly there and can **Play**; the editing controls are hidden for them.
- **Locked frames** can be reordered and hidden (that is not editing their content) but not renamed or deleted; the panel says why.

## Play

### Starting

- **▶ Play** in the top bar (right of **Slides**). It is a split button: **Play from start** and **Play from current slide** (the selected slide, else the slide that most overlaps the view, else the first). A click on the main part plays from the current slide if one is selected, else from the start.
- Keyboard: `Ctrl/Cmd+Alt+P` plays from the current slide and `Shift+Ctrl/Cmd+Alt+P` from the start (the key `F5` of other tools is the browser's reload; Chrome and Firefox allow a page to take it with `preventDefault`, but a person who presses it to reload would lose nothing and gain nothing, so it is not used). The shortcuts dialog lists both.
- A board with no slides: **Play** offers **Make slides from my 5 frames** (when there are frames) or **Create your first slide** (when there are none). Nothing is played.
- If every slide is hidden, **Play** says "All slides are hidden in Play".
- **Preparation**: Play loads the fonts and images of the slides it can reach before it shows the first one (`ensureFont`, `app.images`), up to 3 seconds with "Preparing slides…", then goes on and shows a placeholder for anything late. It also prefetches the next two slides' images while a slide is on screen.
- **Entering** goes full-screen with the browser's Fullscreen API on the board root. Where that is not available (iPhone Safari, some embedded browsers) it falls back to a **fixed full-window layer** that hides everything else and uses `100dvh`, which is as close as a page can get.

### What is on screen

- The **frame's rectangle**, fitted to the window with the aspect ratio kept (letterboxed on the sides or top), drawn from the live board: its children, anything else on the board that lies inside the rectangle, **clipped to the rectangle**. The surround is the theme's darkest ink (`--play-bg`, a new variable per theme) and the slide's own fill is the frame's `fill`.
- **Everything else is hidden**: toolbars, panels, the rail, the top bar, the grid, the frame's title strip, selection handles, other people's cursors and selections, comment pins, the presence tray, tooltips. The AI bar is hidden. Toasts are shown only for the presenter's own errors.
- **What stays**: private-writing notes remain hidden from everyone who may not see them (`flow.isHidden`), dot-vote dots and poll results on the slide as they are on the board, and locked items drawn as usual. Items another person adds to the frame during Play appear (the board is live). The filter and dimming of the tags spec (`docs/tags.md`) are **not applied** in Play: a slide shows what is on it.
- **Slide counter and progress**: "3 / 12" and a 2 px progress line along the bottom edge in `--signal`, shown for 2 seconds after any key, move or tap, and always on while a control has focus. Slide numbers drawn on the slide itself follow the `slideNumbers` setting.
- **Controls overlay**: a row of buttons at the bottom (**Previous**, **Next**, **Go to slide…**, **Laser**, **Presenter view**, **Black screen**, **Exit**), shown on mouse movement or focus, fading after 2 seconds of stillness. Each is a real button with a name and a shortcut in its tooltip; touch targets are 44 px.

### Moving

| Input | Does |
| --- | --- |
| `Right`, `Down`, `PageDown`, `Space`, `Enter`, `N` | Next slide |
| `Left`, `Up`, `PageUp`, `Backspace`, `P` | Previous slide |
| `Home`, `End` | First, last |
| A number, then `Enter` | Go to that slide (shown as you type) |
| Click or tap the right two thirds, or swipe left | Next |
| Click or tap the left third, or swipe right | Previous |
| `F` | Toggle full-screen (the fallback layer when the API is not there) |
| `B`, `W` | Black screen, white screen; again or any other key returns |
| `L` | Laser pointer (toggle) |
| `O` | Overview: a grid of thumbnails to pick a slide |
| `S` | Open or close the presenter view |
| `T` | Show or hide the timer on the slide's corner (presenter's own, not shared) |
| `?` | List of these keys |
| `Esc` | Closes overview and help first, then turns the laser off, then **exits Play** |

At the last slide, **Next** shows "End of presentation" as a final screen with **Exit** and **Restart**, so a stray press does not drop the audience back onto the editing board mid-sentence. Exit returns to the board with the view where it was before Play.

**Interaction** with the slide's content is off in v1: clicks do not select, links do not open, text cannot be edited, polls cannot be answered. (Poll and vote interactivity during a presentation is a separate decision; open question 9.)

### Transitions

`slideTransition` sets it for the whole deck.

- **Fly** (default): the camera flies from the current frame to the next with the existing ease (about 450 ms; the renderer's `flyTo` with the Play fit), so the audience sees where the next slide sits on the board. Between slides far apart the flight is capped at 700 ms and shortens the middle with a quick zoom-out so a long jump does not whip.
- **Fade**: the slide fades out (150 ms), the camera cuts, the next fades in (150 ms), through the surround colour.
- **None**: a cut.

Under `prefers-reduced-motion` Fly and Fade become None. The setting is in the Slides panel's menu (**Transition**), not in a dialog.

### Keys are suspended

On entry Play clears the selection, closes the text editor, cancels any drag, sets `app.mode = 'present'` and installs its own key handler; the board's `bindKeys` returns at once while the mode is on. All pointer handling of the canvas except the laser is off. On exit the mode is cleared and nothing the audience saw has changed the board.

### Behaviour while the board changes

- **A slide is deleted or hidden while it is shown**: Play stays on screen until the presenter moves, then the counter is recomputed.
- **Slides are added or reordered**: the counter changes; the current slide is kept by id.
- **The board goes read-only or the person's role is reduced**: Play continues (it only reads).
- **The connection drops**: Play continues from the local document and the sync pill is hidden; a small indicator shows in the controls overlay ("Offline").
- **Restore from a backup** (the whole workspace): the existing "Restoring…" screen replaces Play, as it replaces everything.

## The presenter view

A view for the person presenting, with what the audience should not see.

```
┌──────────────────────────────────────────────────────────────┐
│  Slide 3 of 12  ·  Risks                      ⏱ 08:42 / 20:00 │
├───────────────────────────────┬──────────────────────────────┤
│                               │  Next                        │
│       current slide           │  ┌──────────────┐            │
│                               │  │  Open items  │            │
│                               │  └──────────────┘            │
├───────────────────────────────┴──────────────────────────────┤
│  Notes                                       [A−] [A+]        │
│  Three risks to call out: the migration date, …              │
├──────────────────────────────────────────────────────────────┤
│  [◀ Prev] [Next ▶]  [Laser]  [Black]  [Invite others]  [Exit] │
└──────────────────────────────────────────────────────────────┘
```

- **Where it opens.** `S` or **Presenter view** opens it in a **second window** (`window.open`, from the click or key, so popup blockers allow it) at `#/b/<board>/presenter`, sized and placed by the browser. The audience window and the presenter window are one board, two tabs of the same session, and talk through a `BroadcastChannel` named for the board (current slide id, laser state, black screen, the timer's start): a click in either moves both. That is the usual two-screen setup: the presenter window on the laptop, the Play window full-screen on the projector.
- **If a second window is not wanted or cannot open** (a phone, a blocked popup, one screen), the same layout opens **in the same window** in place of the Play surface: current slide large at the left, next slide and notes at the right, with a button **Show slide only** to return to full-screen. A presenter sharing one window in a video call keeps the audience on the clean slide by sharing the Play window and keeping the presenter view in another.
- **Current slide and next slide** are live renderings of the frames (the thumbnail renderer at a larger size). The next slide is the next **playable** slide; after the last it shows "End of presentation".
- **Notes**: the slide's `notes` read-only, scrollable, with **A−** and **A+** (the size is remembered per browser). Editing notes is in the Slides panel; this view is for reading while talking. A slide with no notes says "No notes".
- **Timer**: elapsed time since Play started, with an optional **target** the person types (minutes), remembered in `localStorage` for this board (`tabula:present:<board>:target`, in try/catch). Under a minute left it turns `--signal` ink on dark; past the target it counts up in red-on-paper, as the session timer does (`.timer.warn`, `.timer.done`). **Pause** and **Reset** are buttons. The timer is the presenter's own and is not shared or saved; it is not the session timer of `docs/facilitation.md`.
- **Buttons** are the same actions as the keys. **Invite others** sends the invitation again after the 10 second limit.
- **Accessibility and phone**: the layout reflows to one column below 860 px (current slide, then controls, then notes, then next slide), every control is a button, and the timer is a `timer` role with a visually hidden minute announcement (not every second).
- **Closing** either window ends Play for both after a short grace period (so a reload does not).

## Following

Johan's rule governs this section: **no one is moved who did not ask to be.** Everything below is an invitation, a state a person can look at, or a choice the follower makes.

### The invitation

When Play starts the presenter sees a one-line prompt on the controls overlay (and in the presenter view): **"Invite others to follow?"** with **Invite** and **Not now** (remembered for the Play session). Pressing **Invite** (or **Invite others** later) sends **one** focus request of a new kind:

```
focusRequest = { id, x, y, zoom, ts, from: { id, name, color },
                 kind: 'slide', presentationId, slideId, slideTitle, index, count }
```

`x`, `y`, `zoom` are the centre of the slide's frame and 1, as for a step request, so an older client that knows requests but not this kind should show nothing rather than something wrong (the shipped checks drop a request whose shape they do not recognise; slice 5 adds a test that an old build's validation drops a `slide` request). The card, from the shipped feature, says **"Ana is presenting: Roadmap (slide 3 of 12)"** with **Follow**, **Go to**, **Dismiss** and **Mute Ana**. It never takes focus and never blocks the board, goes away after 20 seconds, and is ignored by the recipient under the same rules as any request (muted, already following, repeat within 10 seconds, clock and shape checks).

### What a presenter publishes while presenting

```
presenting = { id: presentationId, slideId, index, count, title, ts, from: { id, name, color } }
```

An awareness field, set when Play starts and updated on each slide change (a handful of small messages per talk), cleared when Play ends or the client leaves. It is **state, not a request**: a person who dismissed the card, or who joined after it, sees **"Ana is presenting · Follow"** as a chip in the top bar for as long as the field exists. The field is judged by the recipient like a request (the sender id must be the announced user id, the numbers finite, the strings cut and treated as text), and a person who muted Ana does not see the chip.

### What following does

**Follow** (from the card or the chip) is the shipped follow, with a presentation target:

- The follower's camera **flies to the presenter's current slide frame, fitted to the follower's own window** (`flyTo(frame, 80, …)`), and again on every slide change. Their view is not a copy of the presenter's camera, so window shape does not matter, and the presenter's `view` stream (the 120 ms messages of normal following) is not used.
- The follower **stays on the normal board**, with their chrome, able to look at other things. Any **pan, zoom, `Esc` or the Stop button on the follow chip ends following**, as it does today, and the chip says "Following Ana's presentation".
- **Watch full screen** on the chip (and on the card as a second choice after Follow) puts the follower into **audience mode**: the same Play surface as the presenter's, locked to the presenter's slide, with no controls beyond **Exit** and **Stop following**; `Esc` leaves audience mode first and following second. A person in audience mode can also **look ahead**: `Left` and `Right` step away from the presenter, with a **Back to presenter** button, which is what people want when they missed a point; this does not need to be in v1 (open question 10).
- **When the presenter exits Play**: the field clears, following ends with "Ana stopped presenting", and the follower is left where they were.
- **Anyone can follow anyone** (the shipped rule) and **the presenter cannot follow while presenting** (their own view is Play).
- **Presenters are not bound to slides.** A presenter who leaves Play and pans the board is not presenting; a presenter who plays a **session step** with a frame sends the step request as today.

### Slides and session steps

- **Use slides as steps**: creates a session step per playable slide, mode brainstorm, title from the frame name, `frameId` set, duration blank; a facilitator who wants a timed, moded run through the same frames gets it in one click. The result is the ordinary step list; nothing links the two afterwards.
- **Make slides from steps**: gives the `slide` field to the frames of the steps in step order, for those that are top-level frames and not slides yet.
- **A step whose frame is a slide** sends its request as a **step** request, as today; the card says "Ana moved to step". It does not send `presenting`.
- **While a session is running**, **Play** is available and the session's private-writing hiding applies in Play as everywhere. Starting Play does not start, stop or advance the session. (A facilitator who wants slides and steps together uses the steps; the open questions ask whether Play should step the session.)

## The laser pointer

A temporary trail that follows the pointer, fades in about a second, and changes nothing on the board.

- **Turning it on**: in Play, `L` or the **Laser** button; outside Play, the **Laser** tool in the rail (next to Hand) and `Alt+L`. `Esc` or the same key turns it off. While it is on the pointer is the laser and the usual tool is paused; on a touch screen a finger drag is the laser instead of a pan (the pen and the hand do not conflict; the laser tool replaces them while on).
- **What others see**: a 14 px dot (screen pixels, independent of zoom) with a soft ring, in the sender's **cursor colour**, and a trail of the last second of positions fading from full strength to nothing, drawn on the cursor layer of every client whose view contains the position. Under reduced motion the trail is cut to the last 300 ms.
- **Protocol**: an awareness field `laser = { x, y, ts, down }`, set while the laser is on and the pointer moves, at most every 33 ms, cleared 1.5 seconds after the last movement and when the laser is turned off. Receivers keep a ring of the last 40 positions per sender, age them locally and draw a polyline with decreasing alpha; the sender sends one position, never a history. A receiver ignores a `laser` whose `ts` is more than 5 seconds away from its clock, whose numbers are not finite or are outside the board's range, and whose sender id does not match the id that client announced. Muting a person in the focus requests mutes their laser too.
- **Who**: anyone with access to the board, including viewers and commenters, as for cursors; a presenter can point on a slide while others look at the slide on their own screens. In audience mode the laser is the only thing the presenter draws on screen.
- **Never stored**: nothing enters the document, history, exports or undo.
- **Accessibility**: the laser is a visual aid; a presenter who uses it is not required to, and nothing depends on it. It is off by default and not announced.

## Export

### PDF

PDF export and printing are TAB-146's. What this page asks of it, and gives it:

- **The page list**: `slidePlan(...).playable` gives the pages in order, each with the slide's size, so a PDF page is the slide's aspect ratio, not the paper's. `exportPages(pages, { title, notes, numbers })` is the call TAB-146 implements; options are an optional title page, **notes pages** (the slide above its notes, one per page), **slide numbers** (from `slideNumbers`) and **skip hidden** (default on).
- **Route one (no library): the print route.** A hidden print document renders each playable slide as an SVG sized to its frame, one per page with `@page` rules (`size: <w>px <h>px`, margin 0) and `break-after`, and calls `window.print()`; the person chooses **Save as PDF** in the browser's dialog. The result is a vector PDF with the browser's embedded fonts and selectable text, at no cost in code size or dependencies, and a print dialog the person must use.
- **Route two (a download button): a PDF writer.** A small writer in `src/` that embeds each slide as a JPEG image at 2x (the page size is the slide's) gives a **Download PDF** button without the print dialog, at the cost of text that cannot be selected and a bigger file. A vector writer (text and shapes as PDF operators, fonts embedded) is the quality route and is its own piece of work. Which of these to build, and whether a PDF library is acceptable as a dependency (the project adds none without asking), is for TAB-146's spec and for Johan (open question 6). Presentations ship with the **print route** and the page list.
- **Entry points**: **Export slides as PDF** in the Slides panel's menu and in the board menu's **Export** list, with the same options as the dialog.

### PNG per slide

**Export slides as PNG** produces one PNG per playable slide (the frame's rectangle at 2x, with the frame fill), named `01-welcome.png`, `02-roadmap.png` and so on, zipped (`fflate`, already a dependency). It uses the existing export of a selection to PNG (`exportPng(app, ids, 2)`) cropped to the frame, so it needs only the loop and the file names.

### PowerPoint (TAB-105)

TAB-105 is not specified here, but the data model is shaped for it so that it needs nothing more from a slide:

| PowerPoint | Tabula |
| --- | --- |
| Slide size | The frame's `w` and `h`; 16:9 maps to 12,192,000 by 6,858,000 EMU, others by the same scale (EMU per board unit = 12,192,000 / 1280) |
| Slide order | `slide` rank |
| Slide name | `name` |
| Background | `fill` (`p:bg`) |
| Hidden slide | `skip` (`show="0"`) |
| Speaker notes | `notes` (a notes slide) |
| Transition | the deck's `slideTransition` (`fade` maps to `p:fade`; `fly` and `none` export as none) |
| Shapes, text, stickies | Native shapes and text boxes where the kind maps (rectangle, ellipse, diamond, arrows, text), as sticky-coloured rectangles |
| Images | Pictures |
| Connectors | Native connectors with arrowheads (elbow and curved simplified to straight or elbow) |
| Anything else (UML, icons, drawings) | An image of that object, or of the whole slide when a slide is mostly such objects |

A `.pptx` is a zip of XML, which `fflate` can write without a new dependency. Import goes the other way: each slide becomes a frame with a `slide` rank, laid out left to right with the deck's gap, its text boxes, shapes and pictures mapped to objects and its notes into `notes`. The library question (a PPTX writer dependency against hand-written OOXML) is TAB-105's, with the same dependency rule.

## Pages (TAB-137)

Pages are not built, and the model of this page does not depend on them.

- **The slide order is board-wide**: `slide` ranks are compared across the whole board, not per page. When pages arrive, the slide list is **grouped by page** in the panel (page headers, then that page's slides in order), and the playable order is pages in tab order, slides in rank order within each, which `slidePlan` produces from the page order and the ranks. Nothing is stored twice.
- **Play across pages** needs the next page's content to be ready before the camera or the cut gets there. Under the single-room model (all pages in one document) it is immediate; under one-room-per-page it needs a prefetch of the next page's room, which Play already does for images. Between pages the transition is a **cut or fade** (a fly cannot cross two canvases).
- **Presenting follows the page**: `presenting` and the invitation carry `slideId`, and the follower's client switches page first, then flies. This is a note for TAB-137, not a requirement of this spec.
- **PDF and PPTX** treat pages as slide groups: one page list across all pages in the same order.
- **Frames on different pages** can both be slides; a frame cannot be moved between pages while being played (the move is a reparent of the page, and Play reads the live list).

## Accessibility

Play must be usable without a pointer and with a screen reader, and it fits the canvas keyboard spec (`docs/canvas-keyboard.md`).

- **A slide is a region.** The Play surface is `role="region"` with `aria-roledescription="slide"` and `aria-label="Slide 3 of 12: Risks"`, and it takes focus on entry so keys work at once. The slide's content is readable through the **outline** of the canvas keyboard spec, **limited to the objects inside the frame**, so a screen reader can read what is on the slide with the arrow keys, in reading order, without the board's other objects.
- **Announcements**: each slide change is announced through the existing announcer ("Slide 3 of 12, Risks"); starting and ending Play are announced; a hidden slide skipped is not.
- **Every control is a key and a button.** The controls overlay is reachable with `Tab` from the surface (Previous, Next, Go to slide, Laser, Presenter view, Black screen, Exit), all with names and the shortcut in the tooltip, and the overlay appears on focus as well as on mouse movement.
- **Focus**: Play behaves as a dialog (slice 1 of the audit): the rest of the page is inert, `Tab` stays inside, `Esc` leaves and focus returns to the **Play** button.
- **Go to slide…** opens a list (the overview as a listbox) with the slide numbers and names, so a slide can be reached without counting.
- **Motion**: no flights or fades under `prefers-reduced-motion`; the laser trail is shortened; the progress line does not animate.
- **Contrast**: the overlay and the counter use the Play surround colour and `--signal` (checked at 4.5:1 against `--play-bg` in all five themes), and the controls are never the only way to do something (keys exist for each).
- **Notes** in the presenter view are plain text in a region labelled "Speaker notes", with a larger-text control, readable at 200% zoom.
- **Colour** is not the only signal: a hidden slide says "Hidden in Play", the timer's warning is text as well as colour.
- **Presenter on a screen reader.** The presenter view is for a person reading notes, so it is a normal page: headings for Current slide, Next slide and Notes, and the controls as buttons. It does not read every second of the timer.

## Phone and touch

- **Play on a phone** works in landscape or portrait, with the slide letterboxed. Where the Screen Orientation API allows, Play asks for landscape (best effort, not required). A swipe left goes to the next slide and a swipe right to the previous; a tap on the right two thirds goes forward, on the left third back, and a tap in the middle toggles the controls overlay (always shown while a control has focus). Pinch is off in Play. iPhone Safari uses the fixed full-window layer (no Fullscreen API), with `viewport-fit=cover` and safe-area insets.
- **Slides panel** is a bottom sheet (max 85 vh) with the same rows; reordering is a **Move up** and **Move down** pair in the row's menu (and a handle for drag where the pointer allows), and **New slide** is a button at the top of the sheet.
- **Presenter view on a phone** is the one-column layout and is used as a remote-like reading screen; it does not control another device (a phone as a remote for a laptop's Play is a later feature, below).
- **Following on a phone** is the same card and chip; the follower's camera flies to the slide fitted to the phone's window.
- **The laser on a touch screen**: a finger drag draws it while the Laser tool is on; it uses the same awareness field and cadence.

## Permissions and privacy

| Role | Slides and Play |
| --- | --- |
| Owner, editor | Create, reorder, rename, hide, duplicate, delete slides; edit notes; Play; invite; laser; export |
| Commenter | See the panel and thumbnails; Play; invite and follow; laser (as for cursors); export slides they can see |
| Viewer | The same as commenter, without commenting |
| Guest | As the role the board gives them |

- **Notes are board data.** Anyone who can open the board can read the notes (in the panel and in the file formats). The panel says so. Private notes (a presenter-only field not in the document) are a different feature (open question 7).
- **Hidden private-writing notes** are not shown in Play, in thumbnails, in the presenter view, in the PDF or PNG, and the presenter's own are shown only to the presenter.
- **Awareness fields** (`presenting`, `laser`, requests) are not saved, not in history, not in exports. The relay needs no change.
- **Read-only workspaces**: Play, following and export still work; slide editing does not.

## Concurrency and offline

| Case | What happens |
| --- | --- |
| Two people reorder different slides | Each writes its own key; both moves hold. |
| Two people move the same slide | Last write wins on that slide's key. |
| Two people insert at the same place | Both get a key between the same neighbours; equal keys order by id and the next move repairs them. |
| Someone deletes the frame being reordered | The write goes to a deleted object and is dropped. |
| Someone edits a slide's content during Play | It shows (the board is live). A presenter who does not want that asks people to wait; a frozen copy is an open question (11). |
| Two people edit the same notes | A string field written whole: last write wins. Notes are edited by one person in practice. |
| The presenter's connection drops | Play continues from the local document; `presenting` expires with the awareness state and followers see "Ana stopped presenting" after the usual timeout. |
| Everything offline | Slides, Play, the presenter view, thumbnails and PNG export work from the local document; following and the laser need a connection. |

Undo is each person's own and covers slide creation, reordering, renaming, hiding and notes, each a `store.transact`. Version history and its restore cover slides because they are fields of frames.

## Templates, MCP and AI

- **Templates.** A template that contains frames with `slide` keeps them: the field names `slide`, `skip` and `notes` go in the object field lists of `src/custom-templates.ts`, `server/templates.mjs` and `server/board-ops.mjs`; on use the keys are **rewritten** to follow the board's existing slides in the template's order (the template's order, after the last existing slide), and notes and `skip` come with them. Saving a template from a selection keeps the order of the selected slides. Built-in templates can be decks (a retrospective deck, a one-page pitch).
- **MCP.** `get_board` summarises slides (`slides: [{ id, index, title, hidden, hasNotes }]`) and `get_objects` includes the fields; new tools, scope `write`: `list_slides`, `create_slide { name?, size?, afterId? }`, `reorder_slides { ids }` (the order wanted; the server writes keys for those that changed), `set_slide { id, name?, hidden?, notes? }`, `remove_from_slides { id }`. Notes and names are fenced as data, like all board text. Writes carry the MCP origin and are not undoable with `Ctrl+Z`.
- **AI.** Not in v1. A **Slides** chip (listed as unbuilt in `docs/ai-toolbar.md`) could draft a deck from selected stickies as a `create` proposal of frames with ranks, using `slidePlan` and the model of this page; it needs its own spec. Nothing in this page blocks it.

## Limits

| What | Limit |
| --- | --- |
| Slides per board | 200 |
| Notes per slide | 4,000 characters |
| Slide size | 200 to 8,000 board units per side |
| Invitations | One per 10 seconds per presenter |
| Laser updates | One per 33 ms; 40 positions kept per sender |
| Preparation wait before Play | 3 seconds |
| Thumbnails | Rendered for visible rows, refreshed at most every 400 ms |
| PNG export | One zip of at most 200 slides at 2x |

## Tests

Pure modules:

- `src/slides.ts`: `slidePlan` (order by key, ties by id, skip, only top-level frames, reading-order seeding for **Make slides from my frames**), `New slide` placement (right of the last, below when overlapping), key generation for reorder and duplicate, removal rules, the page-list shape for export.
- Play logic (`src/ui/play-logic.ts`): key to action for every row of the table, number entry, the last-slide state, black and white screens, the `Esc` ladder, swipe and tap thresholds, that no board key is acted on in `present` mode.
- Follow logic: the validation of a `slide` request and of `presenting` (ids, ranges, strings), the recipient rules (muted, already following), the fit-to-slide camera, the end-of-presentation message.
- Laser: the ring and ageing, the cadence limit, the validation, that nothing is written to the document.
- Export: the page list, PNG file names, the print document's `@page` sizes.

DOM tests (the fake DOM): the Slides panel (rows, rename, hide, reorder by key and by `Alt+Up`, notes), the controls overlay and its names, the presenter view's content and the one-column layout, the focus handling (inert page, `Esc` restores).

Two-client merge tests on two Yjs docs: concurrent reorder, concurrent insert at one place, delete versus reorder.

Browser (Playwright): Play a three-slide board with fly, fade and none, keys, click and swipe, the counter and progress, entering and leaving full-screen, the presenter view in a second window with the channel, the laser with two contexts, follow from the card and from the chip and the stop rules, the phone width, five themes, reduced motion, axe.

Manual: a real projector with a second screen; a Zoom share of the Play window; a 30-slide deck with images and custom fonts; iPhone Safari and Android Chrome.

## Not in this slice

- A **phone or second device as a remote control** for the presenter's window (a presenter's other signed-in client sending next and previous through awareness).
- **Audience look-ahead** in audience mode (`Left` and `Right` away from the presenter).
- **Interactive slides**: links between slides, click to reveal, builds and per-object animation, polls and votes answered during Play.
- **Per-slide transitions** and per-slide backgrounds beyond the frame's fill.
- **Presenter-only notes** that are not in the board document, and **recording** a presentation.
- **Laser as a drawn annotation** that stays (a pen trail that fades is the laser; keeping ink is the pen).
- **A frozen copy** of the deck for Play (a snapshot immune to edits during the talk).
- **AI deck drafting**, **PPTX** and the **vector PDF writer** (TAB-105 and TAB-146).
- **Pages** (TAB-137), beyond the compatibility notes above.
- **Window placement** with the Window Management API (opening the presenter view on a particular screen).

## Slices

1. **Slides.** The model (`slide`, `skip`, `notes`, the meta keys), `src/slides.ts` and its tests, the whitelists, **Make a slide** and **Remove from slides**, old-client behaviour. No Play yet.
2. **The Slides panel.** Thumbnails, rows, rename, reorder (drag and keys), hide, duplicate, delete, **New slide** with sizes, **Make slides from my frames**, notes, numbers on titles, phone sheet.
3. **Play.** The top bar button and shortcuts, preparation, full-screen and the fallback layer, the frame-clipped view, hidden chrome, keys suspended, navigation by key, click, tap and swipe, the counter and progress, transitions, black and white screen, overview, **Go to slide**, end screen, accessibility (region, announcements, focus), reduced motion.
4. **Presenter view.** The second window and the `BroadcastChannel`, the in-window layout, current and next slide, notes, the timer and target, buttons, the one-column phone layout.
5. **Following.** The `slide` request kind, the `presenting` field, the chip, fit-to-slide following, **Watch full screen**, stop rules, **Use slides as steps** and **Make slides from steps**, tests with the focus-request rules.
6. **Laser.** The awareness field, the cursor-layer drawing, `L` in Play, the rail tool and `Alt+L`, touch, validation.
7. **Export.** The page list, **Print to PDF** (the print route), **PNG per slide**, the entries in the Slides panel and the board menu; coordination with TAB-146 for `exportPages`.
8. **MCP, templates and guide.** The tools, template field lists and rank rewriting, the user guide page, the shortcuts dialog rows, the audit probes.

Slices 1 to 3 are the useful core and ship together: slides, order, Play. Slice 4 is the next most wanted. Slices 5 and 6 each stand alone. Slice 7's PDF waits only on the choice for the writer; the print route does not.

## Files

- New: `src/slides.ts` (pure), `src/ui/slides-panel.ts` and `slides-panel.css`, `src/ui/play.ts`, `src/ui/play-logic.ts` (pure), `src/ui/play.css`, `src/ui/presenter.ts` and `presenter.css`, `src/ui/laser.ts`, `src/slide-thumb.ts` (static SVG of a frame), `src/export-pages.ts` (page list, print document, PNG zip), and tests for each.
- Changed: `src/types.ts` (frame fields, meta keys), `src/store.ts` (slide helpers, rank writes), `src/app.ts` (`mode: 'present'`, key suspension, `flyTo` for Play, fitted follow), `src/render.ts` (clip to a rectangle, hide layers for Play, the laser layer), `src/main.ts` and `src/route.ts` (the presenter window route), `src/flow.ts` and `src/ui/focus.ts` (the `slide` request, the `presenting` chip, follow target), `src/ui/board.ts` (top bar buttons, rail laser tool, menu entries), `src/shortcuts.ts`, `src/themes.ts` (`--play-bg`), `src/custom-templates.ts`, `server/templates.mjs`, `server/board-ops.mjs`, `server/mcp.mjs`, the guide.

## Changes to other specs

- `docs/focus-requests.md`: a request kind `slide` and the long-lived awareness field `presenting`, the follow target "presentation", **Watch full screen**; the shipped rules (mute, one request per 10 seconds, stop on pan, zoom or `Esc`) are unchanged and apply.
- `docs/canvas-keyboard.md`: Play is a region with the slide's objects as the outline; the Play keys are only active in Play, and `Alt+L` is the laser outside it (add to the conflict table: `L` is the connector tool outside Play and the laser inside it).
- `docs/tags.md`: the filter and dimming are off in Play.
- `docs/ai-toolbar.md`: the Slides chip, if it is ever built, drafts frames with ranks (this page's model).
- `docs/facilitation.md`: nothing changes in the steps; the two buttons that convert between slides and steps are added.

## Open questions for Johan

1. **Unify session steps and slides, or keep them separate (drafted)?** Separate means two lists and two buttons that convert between them; unified would give slides a mode, a timer and private writing and make every deck a session. The drafted answer keeps decks simple and sessions powerful, at the cost of that duplication.
2. **Is "a frame with a `slide` rank" the right model**, or do you want slides to be their own thing that can contain a view of a region (several slides showing different parts of one big frame)? The second allows "zoom into this corner" slides and is a larger model.
3. **Play from start or current slide by default**, and the key. PowerPoint uses `F5` and `Shift+F5`; the drafted `Ctrl/Cmd+Alt+P` avoids the browser's reload. Do you want `F5` anyway?
4. **Transitions.** Fly (the camera zooms between frames, which shows the board's spatial layout) is the drafted default; fade and none are the options. Is fly right for a talk, or should the default be a plain cut for people who dislike the motion?
5. **Presenter view as a second window** (drafted, with an in-window fallback). Is a second window acceptable on a laptop with one screen, or should the in-window layout be the default and the second window an option?
6. **PDF.** The print route (vector, browser dialog, no library) is drafted for the first version. Do you accept a PDF dependency (for a download button with no dialog) or would you rather have a small raster-only writer written in the project?
7. **Speaker notes are visible to everyone who can open the board** (drafted). Do you want a presenter-only note, stored in the browser or private to the author, as a second kind?
8. **Hidden slides** are skipped in Play and in the PDF (drafted). Should the PDF include them by default, as some people print the whole deck including backup slides?
9. **Interaction during Play.** Off in v1: no clicks, polls or votes. A facilitator might want to run a poll or a dot vote from a slide. Is that "use session steps" (drafted by decision 3), or do you want Play to be able to start a poll?
10. **Audience look-ahead** (a follower in full-screen audience mode stepping away from the presenter and coming back) is outside v1. Is that acceptable for a first release?
11. **Live or frozen.** Play shows the board as it is, including edits other people make during the talk (drafted). Do you want a **Freeze** option that shows a snapshot and ignores edits until you exit?
12. **Removing a slide's notes.** **Remove from slides** drops the notes (drafted) because the fields go with the slide mark. Should the notes survive on the frame so that making the frame a slide again brings them back?
13. **Pages.** The slide order is board-wide and groups by page when pages exist (drafted). Or should each page have its own deck, so a page is a presentation?
14. **A remote for the presenter** (a phone controlling the laptop's Play) is a likely request after v1. Worth planning the awareness channel for it now, or leave it?
15. **Slide numbers and footers** are one switch (drafted). Do you want a footer text (date, event name) per deck as well?
