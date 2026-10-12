# Manual screen reader test: the whiteboard from the keyboard

For `docs/canvas-keyboard.md`. Slice 1 (the outline and moving between objects) is built; the later slices are listed at the end so the same script grows with them. Do this with a real screen reader. The automated tests check the names, roles and keys in the accessibility tree; they cannot say how a reader speaks them.

Who: a person who uses a screen reader every day, or Q&A with the reader's own tutorial open. Time: about 30 minutes for slice 1. Record what you hear in the "Heard" column and anything that surprised you, even if it is not a bug.

## Setup

- **macOS VoiceOver** (Command+F5): Safari and Chrome. Turn on "Quick Nav" off (left and right arrow together toggles it) so the arrow keys reach the page. VoiceOver cursor keys are Control+Option.
- **NVDA** on Windows with Chrome and Firefox (Insert is the NVDA key). **JAWS** with Chrome if available.
- **iOS VoiceOver and Android TalkBack:** the phone route is the Objects list (slice 6), not the canvas; skip this script on phones until then.
- Use a **local board** so nothing depends on a server: open the app, press **New board**. Add six objects by hand with the pointer or the keyboard shortcuts: three yellow sticky notes with the texts "Alpha", "Beta", "Gamma" in a row; one frame named "Ideas" with a note "Delta" inside it below the row; one text "Q3 goals"; one arrow connector from Alpha to Beta. (Or open the Sprint retro template and use that; the expected names below then differ in the text.)
- Start from the top of the page. Do not use the mouse after setup.

## Slice 1: reaching the whiteboard and moving between objects

| # | Do | Expect to hear (wording may vary by reader) | Heard |
| --- | --- | --- | --- |
| 1 | Press Tab until the focus passes the tool rail (Select, Hand, sticky, text, shapes... down to Redo). | The next stop after Redo is the whiteboard: **"Whiteboard, 7 objects, application"** (the count is how many objects you made), and the help text: "Arrow keys move between objects. Page Down and Page Up read in order. Home and End go to the first and last. Tab leaves the whiteboard." Once per page load also "Arrow keys move between objects." | |
| 2 | Press Right Arrow. | The first object is read with its position: for example **"Sticky note, yellow, Alpha, 1 of 7"** or whichever object is nearest the middle of the view. A square ring appears around it on screen. | |
| 3 | Press Right Arrow again. | The next object to the right: "Sticky note, yellow, Beta, 2 of 7". The ring moves. | |
| 4 | Press Down Arrow. | The object below (the frame's note, or the frame itself): "Frame Ideas, 1 item" or "Sticky note, yellow, Delta, in frame Ideas". | |
| 5 | Press Page Down several times. | Each press reads the next object in reading order (rows top to bottom, left to right; a frame is followed by what is in it). At the last object it stays and repeats it. | |
| 6 | Press Home, then End. | Home reads the first object, End the last. The last one is the connector: "Connector from Alpha to Beta". | |
| 7 | Move to an object at an edge and press the arrow that points off the board. | "No object to the left" (or above, below, to the right). Focus does not move. | |
| 8 | Press Escape. | The ring disappears; nothing is read as current. Press Right Arrow: the reading starts again from the nearest object. | |
| 9 | Press Tab. | Focus leaves the whiteboard to the next control (the quick action bar if something is selected, else the zoom controls). You are not stuck. Shift+Tab comes back to the whiteboard. | |
| 10 | With a note selected by the mouse (before step 2), press Right Arrow on the whiteboard. | The note **moves** a pixel (the old behaviour) and is not announced as a move yet; focus does not jump to another object. | |
| 11 | In the screen reader's element list (VoiceOver rotor: Control+Option+U, NVDA: Insert+F7), look for landmarks and form controls. | A "Whiteboard" application region and a list of objects; no unnamed groups, no "Whiteboard canvas" duplicate from the picture. | |

### What to note whatever you hear

- Does the reader tell you **where you are** (1 of 7) without being asked? Is that too chatty or too quiet?
- Are the **names** in a sensible order (kind, colour, text) or does the useful part come last?
- After a long note: is the text cut at about 120 characters with "…"? Is the rest available (some readers read the description after a pause)?
- Does **Tab** out of the whiteboard ever feel like a trap? Does Shift+Tab return to the same object?
- With the reader's **browse mode** on (NVDA), does it switch to focus mode on entering the whiteboard and back on leaving? If not, what happens to the arrow keys?
- Anything announced twice, or announced when it should not be (for example on every remote edit)?

## Slices to add as they are built

Each later slice appends rows here before it ships; the table has the same columns.

- **Slice 2, select and activate:** Space selects the current object ("Selected: Sticky note, yellow, Alpha"), Shift+Page selects a range, Enter edits (focus lands in the text box; Escape returns to the whiteboard with the same object current), delete moves focus to the neighbour, the AI toolbar's selection context from the keyboard.
- **Slice 3, create:** N then Enter places a note beside the current object and starts editing; "Added: Sticky note".
- **Slice 4, resize and rotate:** Alt+Shift+Arrow and Alt+, Alt+. with the burst totals ("Width 200, height 120").
- **Slice 5, connect:** the connect flow and its four messages.
- **Slice 6, the Objects panel:** open it from the board menu, move through it, the per-row actions.

## Reporting

For each row that did not match: the reader and browser (with versions), the row number, what you heard, what you expected. A screen recording with the reader's speech captions is the most useful thing to attach.
