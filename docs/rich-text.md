# Rich text and lists architecture spec

**RECOMMENDED — Status:** Architecture draft for Johan's decision. This file specifies storage and behavior; it does not implement them.

**DECIDED — Product scope:** People can select text and apply bold, italic, underline, or strikethrough; create bulleted or numbered lists; and align paragraphs left, centre, or right.

**DECIDED — Product scope:** A formatting popover sits above the text element. The designer owns the popover's visual design. This spec defines the information and commands it needs.

**OPEN — Scope:** Whether v1 includes stickies, shapes, card titles, card descriptions, or only ordinary text elements is for Johan; see section 17.

**RECOMMENDED — Model:** Keep the current plain-text field as a compatibility projection and add a nested Y.Text as the authoritative collaborative content once an object opts in.

**RECOMMENDED — Capability gate:** Mark a board with meta key feature:rich-text on the first rich-text write, using the existing per-feature gate. Do not convert every board in advance.

**RECOMMENDED — First implementation surface:** Ordinary text elements only. Add more object kinds after rendering, exports, search, templates, and MCP round-trip tests cover them.

**RECOMMENDED — Shared interchange:** Define one small Markdown subset and one parser/serializer module shared by the browser and server.

## Decisions (frozen 2026-10-10)

Johan: "go with your picks". These override any RECOMMENDED or OPEN text elsewhere in this file.

| # | Decision | Effect |
|---|---|---|
| 1 | Text elements first, then stickies and shapes, cards later. | Slices B, D, E of section 15 in that order. |
| 2 | No nested lists. | Depth 1. |
| 3 | No fonts, sizes or colours inside text in v1. | Object-level style only. |
| 4 | No links inside text in v1. | Pasted anchors keep their text, drop the href. |
| 5 | Typing `- ` or `1. ` at an empty paragraph starts a list; one undo returns the literal characters. | Not applied to paste or remote inserts. |
| 6 | A plain MCP text write flattens rich text and returns a warning. | `textMarkdown` is the format-preserving path. |
| 7 | Selections are visible only while two people edit the same object. | Awareness `textSelection` is shown only to co-editors of that object. |
| 8 | 20,000 characters on the board, 4,000 through MCP. | Section 3 limits. |
| 9 | The alignment control with no selection inside the text aligns all paragraphs. | Updates the object default in the same transaction. |
| 10 | YES to a client version floor: the relay refuses edits to rich boards from pre-gate clients. | New work item for slice B: a relay-side client version check on rich boards (open question 10 closed); the exact signal (hello message field or header) to be named in the slice. |
| 11 | Tab moves into the popover; Esc returns to the text; Alt+F10 is the fallback. | Section 18. |
| 12 | No soft line break; Shift+Enter acts like Enter. | Section 18. |
| 13 | Emoji is the last button in the popover. | Design-side. |

## 0. Summary / decisions needed

### Summary

- **DECIDED:** Inline marks are bold, italic, underline, and strikethrough.
- **DECIDED:** Paragraphs support bullet lists, numbered lists, and left, centre, or right alignment.
- **DECIDED:** The popover is above the edited element. The designer defines its layout and appearance.
- **RECOMMENDED:** One Y.Text per rich-text object gives Yjs character-level editing and range formatting without replacing text on each keystroke.
- **RECOMMENDED:** Use the existing object-map field text as a plain projection for older read paths; use richText as the source of truth after lazy initialization.
- **RECOMMENDED:** Put mark attributes on text ranges and list/alignment attributes on the whole paragraph range, including its newline when present.
- **RECOMMENDED:** Use feature:rich-text as a board capability flag. Current clients that do not know the flag already become read-only.
- **RECOMMENDED:** Set the general rich-text object limit to 20,000 Unicode code points and 2,000 paragraphs. Preserve larger legacy strings without truncation.
- **OPEN:** Confirm object kinds in v1, list nesting, link support, font/size/colour support, and automatic list typing.

### Decisions needed before implementation

| Status | Decision | Recommendation in this draft | Cost if wrong |
|---|---|---|---|
| OPEN | Which object kinds are editable in v1? | Text objects first; then stickies and shapes; cards later. | Extending too early multiplies editor, export, MCP, template, and history work. |
| OPEN | Can lists nest? | No nesting in v1; keep a data-version path for later. | Some users may need outlines; adding nesting later changes the parser and renderer. |
| OPEN | Are fonts, size, and colour text-level styles in v1? | No. Keep existing object-level styling and theme colours. | Adding them now increases merge, contrast, export, and sanitisation surface. |
| OPEN | Are links supported inside text? | No for v1. Preserve pasted anchor text and drop its URL. | People may expect clickable links; adding links later needs URL validation and link-safe rendering. |
| OPEN | Do “- ” and “1. ” at line start auto-create lists? | Recommend yes for deliberate typing at an empty line, with a one-step undo. | Auto-format can change literal notes and pasted text unexpectedly. |
| OPEN | Does card title and description formatting ship in v1? | Defer cards until the ordinary canvas path ships. | Cards have separate dialog, search, CSV, MCP, and conversion behavior. |

### Assumptions

- **RECOMMENDED — ASSUMPTION:** The board Y.Doc remains the authority for shared whiteboard text; no separate rich-text service is introduced.
- **RECOMMENDED — ASSUMPTION:** An existing plain string keeps its exact characters when first opened in a rich-text-capable client.
- **RECOMMENDED — ASSUMPTION:** “Alignment” is paragraph alignment. It does not align an individual inline selection.
- **RECOMMENDED — ASSUMPTION:** New formatting affects current text and future typing at the caret, but does not add font-family, font-size, text colour, background colour, code, headings, or tables.
- **RECOMMENDED — ASSUMPTION:** All formats remain data. Text from a board, an export, an MCP caller, or the clipboard is never executable markup or an instruction source.

## 1. Current state

### Object storage

- **DECIDED — Current implementation:** BaseObj in src/types.ts has optional text:string and shared style fields including font, fontWeight, fontSize, textColor, align, and valign.
- **DECIDED — Current implementation:** Align is the union left, center, right. It already controls whole-object text alignment.
- **DECIDED — Current implementation:** ObjType includes text, sticky, shape, and card, along with frames, images, UML types, and other objects.
- **DECIDED — Current implementation:** Store in src/store.ts stores each object as a flat Y.Map under the top-level objects Y.Map.
- **DECIDED — Current implementation:** Store.cache holds ordinary Obj-shaped values so drawing and hit testing do not read Yjs types directly.
- **DECIDED — Current implementation:** Store.create writes the object's own fields as Y.Map entries. Store.update writes only the supplied fields.
- **DECIDED — Current implementation:** Object-map scalar fields merge independently; the comment at the top of src/types.ts says concurrent writes to the same field resolve last-writer-wins.
- **DECIDED — Current implementation:** SCHEMA_VERSION in src/types.ts is currently 1.
- **DECIDED — Current implementation:** Ordinary text objects, stickies, and shapes use text. Kanban cards use text for the title and desc for the description.
- **DECIDED — Current implementation:** Frame, container, and lane headings use name; connector labels use label; UML class text is parsed into attributes and operations.
- **DECIDED — Current implementation:** src/containers.ts converts cards and stickies by splitting and joining title and description strings. A future rich-text field must be preserved or deliberately flattened by those conversions.

### Editing and rendering

- **DECIDED — Current implementation:** TextEditor in src/editor.ts creates a textarea with class text-editor and overlays it in board coordinates.
- **DECIDED — Current implementation:** TextEditor.start selects the whole value and starts an editor for editable, unlocked objects.
- **DECIDED — Current implementation:** TextEditor.onInput calls Store.update with the complete textarea value for every input event.
- **DECIDED — Current implementation:** TextEditor remembers selectionStart and selectionEnd as textarea UTF-16 offsets.
- **DECIDED — Current implementation:** The overlay follows camera movement and uses object style for font, colour, alignment, and sizing.
- **DECIDED — Current implementation:** TextEditor has separate modes for text, class, frame/name, and connector label. Card title and description editing uses the card dialog.
- **DECIDED — Current implementation:** src/text.ts measures and wraps plain strings. wrap splits on newline, then greedily wraps words.
- **DECIDED — Current implementation:** layoutText and textBlock in src/markup.ts create SVG text with tspans and object-level font, weight, colour, and alignment.
- **DECIDED — Current implementation:** Shapes and stickies use labelBox and textBlock; ordinary text uses its stored box. Card titles and descriptions have a separate card renderer in src/markup.ts.
- **DECIDED — Current implementation:** The canvas scene is SVG. Text is omitted from objectMarkup while its textarea is active.
- **DECIDED — Current implementation:** The existing editor writes text during typing so other collaborators see it live.

### Export, search, and interchange

- **DECIDED — Current implementation:** exportSvg in src/exporters.ts calls objectMarkup; exportPng rasterizes that SVG through a canvas.
- **DECIDED — Current implementation:** toJson in src/exporters.ts emits a readable BoardJson snapshot with objects and metadata.
- **DECIDED — Current implementation:** toDrift packages board.json, doc.yjs, comments.yjs when present, and image assets. The CRDT update and readable snapshot serve different purposes.
- **DECIDED — Current implementation:** downloadCardsCsv uses cardRows in src/csv.ts. CSV_COLUMNS has title and description columns; cardRows currently writes card.text and card.desc as plain strings.
- **DECIDED — Current implementation:** The existing Markdown export is a session summary, not a general whole-board Markdown export. Flow.summaryMarkdown in src/flow.ts emits frames, note bullets, kanban summaries, and poll results.
- **DECIDED — Current implementation:** mdText in src/md-text.ts escapes plain user text so it stays one literal Markdown line in generated summaries.
- **DECIDED — Current implementation:** Kanban text filtering in src/ui/kanban-logic.ts lowercases card.text plus card.desc and performs substring matching.
- **DECIDED — Current implementation:** Board search on the Boards page in src/ui/home.ts matches board titles. No full-canvas text index was found in src/.
- **DECIDED — Current implementation:** docs/tracker-architecture.md specifies Markdown ticket descriptions and FTS search, but the tracker is a proposal rather than existing board rich-text storage.

### MCP, validation, and limits

- **DECIDED — Current implementation:** get_objects in server/mcp.mjs returns object details through getObjectsDetail in server/board-ops.mjs and wraps board text in a nonce-fenced JSON string.
- **DECIDED — Current implementation:** create_objects and update_objects currently accept text as a string. board-ops.mjs rejects unknown fields and applies type-specific validation.
- **DECIDED — Current implementation:** LIMITS.text in server/board-ops.mjs is 4,000 UTF-16 code units under the current validator; LIMITS.bodyBytes is 256 KiB; LIMITS.responseChars is 200,000; LIMITS.boardObjects is 5,000 for MCP planning.
- **DECIDED — Current implementation:** shared/containers.mjs sets card title at 200 Unicode code points and card description at 4,000 characters.
- **DECIDED — Current implementation:** server/templates.mjs accepts template object text up to MAX_TEXT, currently 20,000 characters.
- **DECIDED — Current implementation:** stripInvisible in server/board-ops.mjs removes controls, Unicode tag characters, zero-width characters, bidi controls, and several invisible separators.
- **DECIDED — Current implementation:** cleanForModel applies stripInvisible and truncates by code point. fence applies the stripper again to strings in the returned JSON.
- **DECIDED — Current implementation:** The MCP write validator rejects control and tag characters. It does not currently apply the complete stripInvisible set to ordinary object text before validation.

### Compatibility, history, undo, and comments

- **DECIDED — Current implementation:** shared/containers.mjs has per-feature meta keys using FEATURE_PREFIX and featureKey. unknownFeatures identifies unsupported features.
- **DECIDED — Current implementation:** Store.unsupportedFeatures and watchFeatureGate in src/feature-gate.ts support making a board read-only when the client does not know a feature.
- **DECIDED — Current implementation:** docs/kanban.md section “Version skew” describes feature:containers and says clients that predate that gate cannot show the banner.
- **DECIDED — Current implementation:** Store creates a Y.UndoManager for objects, meta, and labels. It tracks LOCAL and uses a 350 ms capture timeout.
- **DECIDED — Current implementation:** Store.transact writes with LOCAL; TextEditor calls undo.stopCapturing on entry and exit.
- **DECIDED — Current implementation:** Browser and relay Y.Docs use garbage collection. docs/history.md records that snapshots preserve current state, not deleted text history.
- **DECIDED — Current implementation:** server/history.mjs stores full board-room Yjs updates. Comments are a separate room and are not included in board snapshots.
- **DECIDED — Current implementation:** src/comments.ts stores comment text as strings. server/comment-authz.mjs checks comment text edits in the comments room.
- **DECIDED — Current implementation:** src/custom-templates.ts and server/templates.mjs validate template object fields. docs/custom-templates.md gives template field and size rules.
- **DECIDED — Current implementation:** Awareness in src/sync.ts currently carries user identity; src/app.ts publishes object selection and board cursor state. Text-range awareness is not present.

## 2. Options compared and recommendation

| Status | Option | Advantages | Costs and failure modes | Verdict |
|---|---|---|---|---|
| RECOMMENDED | Markdown-ish string in text | Human-readable; easy to keep old fields; easy for simple MCP callers. | Whole-string replacements still lose concurrent keystrokes; Markdown punctuation leaks into plain display; parsing and nested list ambiguity; formatting edits rewrite the same scalar. | Reject as canonical Yjs storage. Keep Markdown as interchange. |
| RECOMMENDED | Y.Text with formatting attributes | Character insert/delete CRDT; Yjs format ranges; toDelta gives plain text plus runs; nested Y.Text can live inside an object Y.Map. | Paragraph semantics are conventions on newline-delimited ranges; range formatting needs careful boundary and split/merge tests; toJSON returns plain text and loses marks. | Recommend for v1. |
| RECOMMENDED | Block/inline JSON tree | Explicit paragraphs, lists, alignment, and inline runs; easy static JSON schema. | A single JSON field is a whole-value conflict; using Y.Array/Y.Map per node raises split, merge, move, and tombstone complexity; more structures to normalize. | Do not start here. Revisit if tables or nested block structures arrive. |

**RECOMMENDED — Decision:** Store one nested Y.Text in each object map, with inline and paragraph formatting attributes. Keep block semantics limited to paragraphs and list items identified by newline boundaries.

**RECOMMENDED — Why:** The app already treats newline as a hard text break. A single sequence preserves insertion and deletion order through concurrent edits and avoids copying text into a new block object every time someone presses Enter.

**RECOMMENDED — Trade-off:** Y.Text does not define our product's list commands or alignment policy. The client must normalize those range attributes, and tests must pin behavior against the Yjs version in package-lock.json.

**RECOMMENDED — External API fact:** Y.Text supports nested storage in a Y.Map, insert, delete, format, toString, toDelta, and synchronous observation. Its documented index is UTF-16 code units; inserting without explicit attributes inherits the formatting immediately before the insertion point. See the [Y.Text API](https://github.com/yjs/docs/blob/main/api/shared-types/y.text.md).

**RECOMMENDED — JSON fact:** Y.Text.toJSON returns its string representation. BoardJson and templates must therefore serialize toDelta explicitly; calling object-map toJSON alone is lossy for marks.

## 3. Data model

### Authoritative Yjs shape

**RECOMMENDED — Shape:** Keep the object as a Y.Map under objects. Keep text as a plain string projection. Add richText as a nested Y.Text only after the object is first edited with rich formatting or rich editing is enabled for that object.

~~~text
objects: Y.Map<Y.Map<unknown>>
  objectId: Y.Map
    type: "text" | "sticky" | "shape" | "card"
    text: "plain projection of richText"
    richTextVersion: 1
    richText: Y.Text
    align: "left" | "center" | "right"   // existing object default; do not delete
~~~

**RECOMMENDED — JSON view:** The actual richText value is a Y.Text, not a JSON array stored in one Y.Map key.

~~~json
{
  "text": "A bold line\nSecond item",
  "richTextVersion": 1,
  "richTextDelta": [
    { "insert": "A ", "attributes": { "align": "left" } },
    { "insert": "bold", "attributes": { "bold": true, "align": "left" } },
    { "insert": " line\n", "attributes": { "align": "left" } },
    { "insert": "Second item", "attributes": { "list": "bullet", "align": "left" } }
  ]
}
~~~

- **RECOMMENDED:** richTextVersion is an integer on the object Y.Map. Version 1 is the only supported version in this draft.
- **RECOMMENDED:** richTextDelta is an export/interchange field only. It is never written as a JSON value beside Y.Text in the live Y.Map.
- **RECOMMENDED:** text is a derived plain-text projection equal to richText.toString() after richText exists. It contains no Markdown delimiters.
- **RECOMMENDED:** Do not derive rich text from text when richText already exists. A stale projection is repaired from Y.Text.
- **RECOMMENDED:** A legacy object with text and no richText stays unchanged until a user edits its text or formatting.
- **RECOMMENDED:** Lazy initialization creates Y.Text from the existing text in one local transaction, sets richTextVersion to 1, and preserves the original align as the fallback alignment for every paragraph.
- **RECOMMENDED:** Initialize richText and write the feature key in the same transaction as the first rich operation.
- **RECOMMENDED:** A plain-text edit on an opted-in object changes Y.Text with insert/delete operations, then refreshes the text projection in that same transaction.
- **RECOMMENDED:** A remote Y.Text event refreshes the local object cache and the plain projection. Projection repair uses a non-LOCAL derived origin so it does not become a separate undo action.
- **RECOMMENDED:** Do not allow client code, MCP, imports, or templates to write both a different text projection and a richText value. The rich value wins and the projection is recomputed.
- **RECOMMENDED:** If richTextVersion is absent, the object is legacy plain text. If it is 1, read richText. If it is any higher or malformed value, preserve it and make the board read-only unless a future client explicitly supports that version.
- **RECOMMENDED:** Unknown attributes must survive reads, exports, history preview, and imports. A client that cannot preserve unknown attributes must not edit that board.

### Attribute names and ranges

| Status | Attribute | Value | Range | Meaning |
|---|---|---|---|---|
| RECOMMENDED | bold | true or omitted | Inline selection | Bold glyphs. False is represented by removing the attribute. |
| RECOMMENDED | italic | true or omitted | Inline selection | Italic glyphs. |
| RECOMMENDED | underline | true or omitted | Inline selection | Underlined glyphs. |
| RECOMMENDED | strike | true or omitted | Inline selection | Strikethrough glyphs. |
| RECOMMENDED | align | left, center, or right | Whole paragraph, including its newline where one exists | Paragraph alignment. Absent means the object's existing align default, then left. |
| RECOMMENDED | list | bullet or ordered | Whole paragraph, including its newline where one exists | Paragraph is one list item. Absent means a normal paragraph. |

- **RECOMMENDED:** The only supported mark values in v1 are boolean true. A value other than true is treated as unknown and not displayed as a mark.
- **RECOMMENDED:** Align is always one of left, center, or right. Map user-facing “centre” to the existing stored spelling center.
- **RECOMMENDED:** Adjacent list paragraphs of the same list value form one list. A normal paragraph ends the list. Ordered numbering starts at 1 and is computed at render time.
- **RECOMMENDED:** There is no stored list counter, bullet glyph, indentation, font, colour, or list id in v1.
- **RECOMMENDED:** Newline is the paragraph boundary. Soft wrapping from text.ts is not a paragraph boundary and receives no separate list or alignment attribute.
- **RECOMMENDED:** A block-format command applies its attribute to every UTF-16 unit in each selected paragraph and to its newline, if present.
- **RECOMMENDED:** For an empty paragraph, the paragraph's newline carries its block attributes.
- **RECOMMENDED:** At an empty final paragraph after a trailing newline, use the last newline's block attributes as the typing context until that paragraph has content.
- **RECOMMENDED:** A collapsed caret has local pending mark state for the next inserted text. Do not persist a mark on the object or on an unrelated character.
- **RECOMMENDED:** A collapsed caret's list and alignment state comes from its containing paragraph.
- **RECOMMENDED:** Store indexes as UTF-16 offsets to match JavaScript and Y.Text. Keep selection boundaries on grapheme boundaries when a user operation changes text.

### Plain projection and object-level alignment

- **RECOMMENDED:** Keep Store.cache as a plain-object cache for existing consumers and add a separate Store rich-text cache keyed by object id.
- **RECOMMENDED:** Store.richTextDelta(id) returns the normalized Y.Text.toDelta snapshot for rendering, selection state, and export.
- **RECOMMENDED:** Read the nested Y.Text directly from the object Y.Map. Do not use Y.Map.toJSON as the source for formatted runs.
- **RECOMMENDED:** Store's deep observer must recognize Y.Text events and their paths. It must not assume every event has the Y.Map changes.keys shape.
- **RECOMMENDED:** The existing align field remains the default for paragraphs without an explicit richText align attribute.
- **RECOMMENDED:** A rich-text alignment command writes align attributes in Y.Text; it does not overwrite the existing align field.
- **RECOMMENDED:** The Properties panel's existing object alignment control, if used on a rich object, must apply that alignment to every paragraph in one transaction and update the object's default field for future paragraphs.
- **RECOMMENDED:** The plain text field mirrors only characters, including paragraph newlines. It never carries marks, list markers, or alignment metadata.
- **RECOMMENDED:** Search indexes and plain-text callers read text or richText.toString(), not richTextDelta JSON or Markdown punctuation.
- **RECOMMENDED:** Export serializers coalesce adjacent equal attributes. Internal Y.Text event boundaries are not part of the public format.

### Proposed limits

| Status | Limit | Proposal |
|---|---|---|
| RECOMMENDED | General rich text | 20,000 Unicode code points per object. |
| RECOMMENDED | Paragraphs | 2,000 per object. |
| RECOMMENDED | Ordered and bullet list nesting | Depth 1; no nested list. |
| RECOMMENDED | Rich JSON input | 256 KiB per object after UTF-8 encoding. |
| RECOMMENDED | Board-wide indexed text | 2,000,000 Unicode code points before search indexing stops indexing later text. |
| RECOMMENDED | MCP create/update source | 4,000 UTF-16 code units per field to match the current validator until the limit is deliberately changed. |
| RECOMMENDED | Card title/description | Keep current 200/4,000 limits if cards are later enabled. |

- **RECOMMENDED:** These are proposal limits, not current browser editing limits. The browser currently has no general text maximum.
- **RECOMMENDED:** Use code-point counts for product limits, UTF-16 code units for Y.Text offsets, and UTF-8 bytes for transport limits.
- **RECOMMENDED:** Do not truncate oversized legacy text during lazy initialization. Preserve it exactly; allow deletions and formatting, and reject only insertions that would increase it beyond the new limit.
- **RECOMMENDED:** Keep text up to the current template validator's 20,000-character MAX_TEXT so template import does not silently reduce canvas content.
- **RECOMMENDED:** Before raising limits, measure with 5,000 objects and a 2,000,000-code-point aggregate board. The MCP planner currently caps a board at 5,000 objects; that is not stated here as a universal client-side limit. docs/capacity.md should receive the results in the implementation phase.
- **OPEN:** Confirm whether 20,000 is appropriate for object text. The existing MCP limit is 4,000 and the template validator's limit is 20,000.

## 4. Operations and commands the popover needs

**DECIDED — UI placement:** The popover is above the edited text element. This spec does not prescribe its visual arrangement.

**RECOMMENDED — Command API:** Expose a small editor command interface to the popover; do not have the popover mutate Y.Text directly.

~~~ts
type Mark = "bold" | "italic" | "underline" | "strike";
type BlockAlign = "left" | "center" | "right";
type ListKind = "bullet" | "ordered" | null;
type Active = "on" | "off" | "mixed";

type RichTextState = {
  objectId: string;
  selection: { anchor: number; focus: number };
  marks: Record<Mark, Active>;
  alignment: Active;
  alignmentValue: BlockAlign | "mixed";
  list: Active;
  listValue: ListKind | "mixed";
  canEdit: boolean;
};

type RichTextCommand =
  | { type: "toggle-mark"; mark: Mark }
  | { type: "set-alignment"; value: BlockAlign }
  | { type: "set-list"; value: ListKind }
  | { type: "insert-text"; text: string }
  | { type: "insert-paragraph" }
  | { type: "delete-range"; direction: "backward" | "forward" };
~~~

- **RECOMMENDED:** getRichTextState reads a stable snapshot of selected text and paragraphs and returns on, off, or mixed for each control.
- **RECOMMENDED:** For a non-empty selection, a mark is on only if every selected text code point has the mark; off if none do; mixed if some do.
- **RECOMMENDED:** Exclude paragraph separator newlines from the inline mark state unless the selection contains no text. A newline must not make a bold control appear mixed by itself.
- **RECOMMENDED:** For a collapsed selection, mark state is the pending typing mark at the caret.
- **RECOMMENDED:** Alignment state is on when all selected paragraphs share that value. It is mixed when they differ. A selection containing a normal paragraph with inherited object alignment reports that resolved value.
- **RECOMMENDED:** List state reports bullet or ordered only when all selected paragraphs have the same list kind; otherwise it reports off or mixed as appropriate.
- **RECOMMENDED:** Selecting a list button when all selected paragraphs already have that kind removes the list attribute. Selecting the other list kind changes all selected paragraphs.
- **RECOMMENDED:** Setting alignment or list on a selection expands to all paragraphs touched by the selection. With a caret, it changes only the containing paragraph.
- **RECOMMENDED:** A format command captures object id and selection before moving focus to the popover, holds blur commit, applies the change, restores focus and selection, then publishes a fresh state query.
- **RECOMMENDED:** Use the editor's saved selection offsets or Yjs RelativePositions while focus is in the popover. Do not apply a command to whatever text becomes selected after focus changes.
- **RECOMMENDED:** Commands operate through Store.transact and one shared command layer. Each command is one undo unit.
- **RECOMMENDED:** Keyboard shortcuts invoke the same command functions as the popover. Prevent board-level shortcuts from firing while the editor or popover owns focus.
- **RECOMMENDED:** Intercept beforeinput and input for browser editing operations. Do not repeatedly serialize the entire object or rebuild all board text on each keystroke.
- **RECOMMENDED:** The command layer reports disabled when the object is locked, the board is read-only, the selection is invalid, or the object type is not enabled.

### Keyboard hooks

| Status | Shortcut hook | Command |
|---|---|---|
| RECOMMENDED | Ctrl/Cmd+B | Toggle bold. |
| RECOMMENDED | Ctrl/Cmd+I | Toggle italic. |
| RECOMMENDED | Ctrl/Cmd+U | Toggle underline. |
| RECOMMENDED | Ctrl/Cmd+Shift+X | Toggle strikethrough. |
| RECOMMENDED | Ctrl/Cmd+Shift+8 | Toggle bullets. |
| RECOMMENDED | Ctrl/Cmd+Shift+7 | Toggle numbering. |
| RECOMMENDED | Ctrl/Cmd+Shift+L | Align left. |
| RECOMMENDED | Ctrl/Cmd+Shift+E | Align centre. |
| RECOMMENDED | Ctrl/Cmd+Shift+R | Align right. |

- **RECOMMENDED:** Register shortcuts through src/shortcuts.ts and the text editor's keydown path, with platform modifiers resolved once.
- **RECOMMENDED:** Preserve native text selection, copy, paste, Enter, Backspace, Delete, and arrow behavior unless a rich list rule explicitly handles them.
- **RECOMMENDED:** Keep Tab from inserting list indentation in v1; the existing editor commits on Tab. List nesting is an open product choice.
- **OPEN:** Validate the proposed list and alignment chords on macOS and Windows. A browser or OS may reserve a shortcut.

## 5. CRDT merge cases

**RECOMMENDED — Invariant:** Text insertion and deletion use Y.Text sequence operations. Format attributes are range operations over that same sequence. Never write the full richText string into one Y.Map scalar.

**RECOMMENDED — Merge language:** Yjs converges concurrent shared-type updates, but the user interface must still define what a conflict means. The rows below define intended visible outcomes and flag where the exact Yjs attribute winner must be pinned by tests.

| Status | Concurrent scenario | Expected merged result | Policy |
|---|---|---|---|
| RECOMMENDED | Two clients bold the same range. | The characters are bold once; duplicate identical values collapse in the rendered delta. | Same value is idempotent. |
| RECOMMENDED | One client bolds a range while another removes bold from the same range. | Each character in the overlap has one deterministic winning bold value; non-overlapping portions keep their own edits. | No timestamp arbitration; verify the winner against the pinned Yjs version. |
| RECOMMENDED | One client bolds A through D; another removes bold on C through F. | A and B stay bold; E and F stay unbold; C and D follow the deterministic conflict result for the bold key. | Attribute-level conflict, not a whole-object text conflict. |
| RECOMMENDED | One client edits text before a formatted range while another formats that range. | Inserted text stays at its CRDT position. Formatting applies only where the Y.Text format markers cover it. | Do not infer formatting outside marker boundaries. |
| RECOMMENDED | A client inserts inside a formatted span. | Y.Text insertion inherits the preceding attributes by default. | At a span boundary, explicit pending mark state wins over implicit inheritance. |
| RECOMMENDED | Two clients insert at the same UTF-16 position inside a bold run. | Yjs gives both inserts a deterministic sequence order; both remain in the run when the insertion position is interior. | Verify both order and inherited attributes in tests. |
| RECOMMENDED | Two clients type at opposite ends of a formatted span. | Both insertions survive and stay in their respective sequence positions. | Range markers decide whether an edge insertion is included. Test both edges. |
| RECOMMENDED | A user presses Enter in a bulleted or numbered paragraph. | A newline is inserted; both resulting paragraphs inherit list kind and alignment. | New block takes the current block attributes. |
| RECOMMENDED | Two users split the same paragraph at different positions while offline. | Both newline insertions survive and divide the text into the deterministic CRDT order. | An extra empty list item is possible if split points coincide. Do not silently remove it. |
| RECOMMENDED | Two users split at the same position. | Both newline operations converge; if Yjs leaves adjacent separators, render the empty paragraph rather than deleting content. | Test and document exact result. |
| RECOMMENDED | A user deletes the newline between two list items. | The two paragraphs become one. The resulting paragraph takes the left paragraph's list and alignment. | Apply local normalization to the merged paragraph. |
| RECOMMENDED | Two users merge the same adjacent list items. | One visible paragraph remains; repeated delete is harmless. | Y.Text sequence deletion is idempotent. |
| RECOMMENDED | One user merges items while another edits the right item. | The edit remains in the sequence if its characters survive. The merged paragraph uses the left block attributes. | A remote format racing normalization may win on the overlapping range; test it. |
| RECOMMENDED | One user changes a paragraph from bullets to numbering while another changes its alignment. | Both independent keys survive: list becomes ordered and alignment changes. | Separate attributes merge independently. |
| RECOMMENDED | One user changes one paragraph to right aligned while another changes the next paragraph to centre. | Both paragraph alignments survive. | Range boundaries must not include the neighboring paragraph. |
| RECOMMENDED | Two users align the same paragraph differently. | One value wins deterministically for the overlap. | Do not promise wall-clock last writer; display the converged value. |
| RECOMMENDED | A selection spanning several paragraphs changes alignment. | All selected paragraphs receive the command value, including concurrent inserted text only where the Y.Text range includes it. | Query state after merge and preserve unknown attributes. |
| RECOMMENDED | A remote edit arrives while the local user is selecting text. | The selection anchors resolve to the nearest surviving text positions. | Use relative positions for collaboration state; clamp stale local offsets. |
| RECOMMENDED | A board has malformed list or alignment attributes from a future client. | Known values render; unknown values are preserved and ignored. | Unknown version or attributes block editing if the client would erase them. |

- **RECOMMENDED:** A paragraph is the text between adjacent newline characters. A list item is one paragraph with list set to bullet or ordered.
- **RECOMMENDED:** Deleting a paragraph separator merges blocks by keeping left-side block attributes, then applying those attributes over the merged paragraph in the same local transaction.
- **RECOMMENDED:** Splitting a block copies its block attributes to the new paragraph. Inline marks at the caret follow pending mark state.
- **RECOMMENDED:** Concurrent opposite formatting is not resolved by a client timestamp because wall clocks differ and the Yjs format API has no product-level last-writer guarantee.
- **RECOMMENDED:** Before release, confirm Y.Text range ordering, boundary insertion, attribute clearing, and UndoManager behavior against the exact installed Yjs version. Add focused tests in section 14.

## 6. Compatibility and rollout

### Existing boards

- **DECIDED:** Existing boards store plain strings. There is no bulk migration.
- **RECOMMENDED:** On read, if richTextVersion is absent, render the existing text string using the current plain-text renderer.
- **RECOMMENDED:** On the first rich-text edit, seed one nested Y.Text from the existing string, retain all line breaks, preserve the existing object align as the default, and set richTextVersion to 1.
- **RECOMMENDED:** Do not initialize every text-bearing object merely because another object on the board becomes rich.
- **RECOMMENDED:** Keep the text field as a plain projection so current read paths, old snapshots, and simple integrations can still show content.
- **RECOMMENDED:** When richText exists, write its plain projection after every local or remote rich change. New clients treat that projection as derived.
- **RECOMMENDED:** An import with no richTextDelta becomes a legacy plain string and is upgraded lazily.
- **RECOMMENDED:** An import with richTextDelta is validated, rebuilt into Y.Text, and gated before users can edit it.

### Capability marker and old clients

- **RECOMMENDED:** Add rich-text to the feature registry in shared/containers.mjs and write meta key feature:rich-text = true in the first rich-text transaction.
- **RECOMMENDED:** The feature key is a capability marker, not a percentage rollout flag. A separate application release flag may keep writes off during a canary.
- **DECIDED — Existing behavior:** docs/kanban.md says a client that knows the feature gate but not a feature opens the board read-only with a “newer Tabula” banner.
- **RECOMMENDED:** A current pre-rich-text client that includes watchFeatureGate will render the plain text projection, display the unsupported-feature banner, and refuse board writes.
- **RECOMMENDED:** A client built before the feature gate may ignore the unknown richText field and continue editing text as a scalar. The relay currently accepts authorized board-room Yjs updates without interpreting each object field.
- **RECOMMENDED:** If a pre-gate client changes text, its edit changes only the projection. A rich-text-capable client later repairs the projection from authoritative richText; the old client's edit may therefore be lost while richText remains intact.
- **RECOMMENDED:** Do not enable writes until the supported minimum client includes the feature gate. For environments with un-upgradable clients, add a server-side client-version floor before rollout.
- **RECOMMENDED:** Do not rely on the client feature gate to protect clients that predate it. The current docs/kanban.md already documents this limitation for containers.

### Rollout and downgrade

1. **RECOMMENDED:** Ship the shared parser/serializer, rich read path, object projections, export support, and feature gate with writes disabled.
2. **RECOMMENDED:** Run read-only round trips over old plain boards, snapshots, templates, and imported JSON without changing their Yjs state.
3. **RECOMMENDED:** Enable lazy writes behind the application release flag for internal boards first.
4. **RECOMMENDED:** Write feature:rich-text before or atomically with Y.Text so the board does not briefly appear safe to an old client.
5. **RECOMMENDED:** Monitor unsupported-client reports and malformed richTextVersion values before broad rollout.
6. **RECOMMENDED:** To disable the feature, stop new writes but keep readers, exporters, and the feature gate enabled.
7. **RECOMMENDED:** A code downgrade after rich writes must retain a client that recognizes feature:rich-text and opens read-only. Do not downgrade to a pre-gate writer.
8. **RECOMMENDED:** Reverting rich-text data requires restoring a pre-feature history version or backup; deleting richText while retaining formatted text is data loss.
- **RECOMMENDED:** Feature keys are monotonic capability claims. Removing the last rich-text object does not remove feature:rich-text.
- **OPEN:** Decide whether a minimum supported client version is enforceable in the relay or release process before a production rollout.

## 7. Export

| Status | Format | Mapping | Losses and constraints |
|---|---|---|---|
| RECOMMENDED | PNG | Render text marks, lists, and paragraph alignment into the SVG markup before exportPng rasterizes it. | Visual result only; no selectable text, semantic lists, or editing data. Fonts and glyph support remain subject to existing font embedding and browser rendering. |
| RECOMMENDED | Markdown summary | Use the shared serializer for eligible rich text. Serialize marks, paragraphs, and lists with the section 9 subset. | No canvas geometry, object style, comments, collaboration state, or exact line wrapping. Images and votes keep their existing summary rules. |
| RECOMMENDED | Cards CSV | For future rich cards, put Markdown subset text in title and description cells. Run every value through csvCell and preserve the formula guard. | CSV consumers see Markdown delimiters; no style metadata beyond that subset. Current export is cards-only. |
| RECOMMENDED | .drift | Keep doc.yjs as the authoritative Yjs update. Include richTextDelta and richTextVersion in board.json's readable object snapshot. | Full sync state includes current formatting but, with gc enabled, does not recover content deleted before export. |
| RECOMMENDED | Board JSON | Serialize text plainly and add richTextVersion plus normalized richTextDelta. On import, parse and validate the delta into Y.Text. | Older JSON readers may ignore new fields; the feature marker makes the board read-only in clients that know the gate. |

- **RECOMMENDED:** PNG display uses the same measured line layout as the canvas; bold and italic affect measurement; underline and strike are drawn as text decorations.
- **RECOMMENDED:** Lists render as actual bullets or computed ordered markers, not literal bullet characters inserted into the Y.Text.
- **RECOMMENDED:** SVG output escapes all text and emits only generated SVG attributes. Never interpolate imported HTML into SVG.
- **RECOMMENDED:** Markdown output uses a serializer, not mdText on an already formatted run. Continue using mdText for fields that remain plain and one-line.
- **RECOMMENDED:** CSV still uses the existing formula-safe csvCell in src/csv.ts. Apply the guard after Markdown serialization.
- **RECOMMENDED:** .drift keeps the binary Yjs update and the readable snapshot consistent. Do not reconstruct the Yjs update from board.json when the binary update exists.
- **RECOMMENDED:** JSON and .drift import must reject invalid attribute types and versions before applying updates to the live board.
- **RECOMMENDED:** Document that Markdown, CSV, and PNG are interchange/rendering views. Only .drift retains the live CRDT structures and embedded assets.

## 8. MCP read and write

### Read shape

- **DECIDED — Current behavior:** MCP reads return JSON values inside a nonce-fenced text result. Text is cleaned with cleanForModel and fence in server/board-ops.mjs.
- **RECOMMENDED:** For rich objects, retain text as the plain compatibility field and add textMarkdown as a Markdown-subset rendering of the same content.
- **RECOMMENDED:** Do not return raw Yjs updates, internal CRDT identifiers, or unbounded toDelta output to an MCP caller.
- **RECOMMENDED:** For get_board summaries, use plain text for compact previews unless the tool explicitly requests formatting.
- **RECOMMENDED:** For get_objects details, include textMarkdown only when richTextVersion is 1 and the requested detail budget allows it.
- **RECOMMENDED:** The card reader, if rich cards are later enabled, returns title as text and titleMarkdown, plus description as plain text and descriptionMarkdown.
- **RECOMMENDED:** Fence the complete response as today. The Markdown field is still untrusted board data and is not an instruction.

### Write shape

- **RECOMMENDED:** Add optional textMarkdown for create_objects and update_objects. Keep existing text as plain text for current callers.
- **RECOMMENDED:** A caller may supply text or textMarkdown for a field, but not both. Reject ambiguous requests with invalid_input.
- **RECOMMENDED:** Parse textMarkdown with the shared parser and create or update Y.Text in the same board transaction.
- **RECOMMENDED:** A plain text write to an existing rich object removes formatting and becomes one unformatted Y.Text replacement. Return a warning field that formatting was flattened.
- **RECOMMENDED:** A textMarkdown write sets richTextVersion = 1 and feature:rich-text in the same transaction.
- **RECOMMENDED:** Respect the current 4,000-character MCP text limit until the MCP limit is separately reviewed. Enforce the 256 KiB body and 200,000 response-character caps.
- **RECOMMENDED:** Keep unknown-field refusal. Extend server/board-ops.mjs planners to validate textMarkdown rather than accepting arbitrary extra object keys.
- **RECOMMENDED:** Apply stripInvisible to incoming Markdown before parsing and to the serialized Markdown and plain projection on the way out.
- **RECOMMENDED:** Preserve ordinary newline characters; strip zero-width, bidi, tag, control, and invisible-separator characters exactly as the current stripper defines.
- **RECOMMENDED:** Apply the same stripper to Markdown extracted from clipboard HTML after conversion to plain source. Never retain invisible direction controls in a parsed URL or label.
- **RECOMMENDED:** On a write failure, return the same error envelope and path-level field errors used by current tools. Do not partially write a batch.
- **RECOMMENDED:** Summary truncation must not cut inside a UTF-16 surrogate pair or split a Markdown delimiter in a way that changes meaning. Prefer truncating plain content then reserializing.

### MCP limits and permissions

- **DECIDED:** create_objects and update_objects require write scope and owner/editor board roles, according to docs/mcp.md.
- **RECOMMENDED:** Rich-text writes use those existing permissions; no extra MCP scope is needed.
- **RECOMMENDED:** MCP edits remain outside the human's Ctrl/Cmd+Z stack, as documented in docs/mcp.md.
- **RECOMMENDED:** Update tests for fenced outputs, private-note withholding, hidden objects, byte and response budgets, and no partial writes.
- **OPEN:** Confirm whether a plain text MCP write should always clear formatting or whether it should be rejected when the object is already rich.

## 9. Search and shared Markdown subset

### Search behavior

- **DECIDED — Current behavior:** Boards-page search matches board titles; kanban filters match plain card title and description.
- **RECOMMENDED:** Search rich objects by their plain text projection. Do not search Markdown delimiters, list markers, or attribute names.
- **RECOMMENDED:** Search card descriptions by the same plain projection if card rich text is enabled later.
- **RECOMMENDED:** Keep search highlighting character offsets against the same normalized plain string the index searched.
- **RECOMMENDED:** Do not rebuild a whole-board index for each keystroke. Update the changed object's entry from Store's changed-id event.
- **RECOMMENDED:** The tracker descriptions in docs/tracker-architecture.md remain Markdown strings and searchable as rendered plain text. This spec does not alter tracker storage.
- **RECOMMENDED:** Use one parser/serializer implementation for board content and tracker Markdown descriptions so supported syntax has one meaning.

### Proposed shared module

- **RECOMMENDED:** Add a shared plain-JavaScript module such as shared/rich-text.mjs with shared/rich-text.d.ts for TypeScript consumers.
- **RECOMMENDED:** The module exports parseMarkdown, serializeMarkdown, toPlainText, normalizeDelta, and stripUnsupportedHtmlText.
- **RECOMMENDED:** Keep the parser deterministic, DOM-free, locale-independent, and safe for Node. The browser renderer consumes its normalized runs.
- **RECOMMENDED:** Import the same module from src/ and server/ rather than duplicating parsing rules in server/mcp.mjs, flow.ts, and tracker code.
- **RECOMMENDED:** Preserve the parser version in the richTextVersion field, not in the Markdown source string.

### Markdown subset for v1

| Status | Syntax | Meaning | Canonical output |
|---|---|---|---|
| RECOMMENDED | **text** | Bold | Two asterisks around text. |
| RECOMMENDED | *text* | Italic | One asterisk around text. |
| RECOMMENDED | <u>text</u> | Underline extension | Sanitized u tag. |
| RECOMMENDED | ~~text~~ | Strikethrough | Paired tildes. |
| RECOMMENDED | - item | Bullet list item | Hyphen and one space. |
| RECOMMENDED | 1. item | Ordered list item | Number and period; serializer numbers each list from 1. |
| RECOMMENDED | Blank line | Paragraph break | One empty line between normal paragraphs. |
| RECOMMENDED | Single line break | New paragraph | A newline between paragraphs in stored content. |

- **RECOMMENDED:** Support nested inline marks. A parser must produce separate runs and must escape literal Markdown delimiters.
- **RECOMMENDED:** Do not support headings, code blocks, inline code, blockquotes, tables, images, HTML blocks, or arbitrary tags in v1.
- **RECOMMENDED:** Links stay out of v1 pending Johan's decision. For pasted anchors, retain visible anchor text and discard href.
- **RECOMMENDED:** Represent underline with only a literal u element in Markdown interchange. Allow no attributes on that element.
- **RECOMMENDED:** HTML entities are decoded once as text; do not recursively decode entities or treat a decoded tag as markup.
- **RECOMMENDED:** Unsupported syntax is retained as literal text with delimiters escaped by the serializer.
- **RECOMMENDED:** Normalize CRLF and CR to LF before parsing. Preserve visible punctuation and whitespace except where list markers are recognized at a line start.
- **RECOMMENDED:** Markdown typing shortcuts are a separate editor policy. Pasted Markdown parsing and MCP textMarkdown parsing must not depend on that open UI choice.

## 10. Paste and drag-in rules

- **RECOMMENDED:** Continue to accept text/plain and text/html clipboard payloads. Never assign clipboard HTML to innerHTML or contentEditable DOM.
- **RECOMMENDED:** Parse HTML into a small allow-list: p, br, strong, b, em, i, u, s, strike, ul, ol, li.
- **RECOMMENDED:** Read text nodes only. Drop style, class, id, data attributes, event handlers, href, src, SVG, images, forms, embedded content, and all unknown elements.
- **RECOMMENDED:** Preserve list structure only when li elements are inside ul or ol. Convert all other block tags to paragraph boundaries.
- **RECOMMENDED:** Map strong and b to bold; em and i to italic; u to underline; s and strike to strike.
- **RECOMMENDED:** Unsupported markup keeps its visible text in the nearest allowed parent. It contributes no formatting or executable data.
- **RECOMMENDED:** Apply stripInvisible to extracted visible text before it becomes Y.Text, while preserving normal LF paragraph boundaries.
- **RECOMMENDED:** Validate input length and paragraph count after conversion and before changing Y.Text. Reject oversize paste as one operation; do not silently truncate selected content.
- **RECOMMENDED:** For text/plain paste, treat content literally in the editor. A separate “paste Markdown” path may parse the v1 subset.
- **RECOMMENDED:** For drag-in on the canvas, prefer text/html if it passes the allow-list; otherwise use text/plain. Create one text object and one undo step.
- **RECOMMENDED:** A dropped HTML document creates plain text plus the supported marks/lists. Drop layout, styles, fonts, colours, and external links.
- **RECOMMENDED:** Exported board HTML must not be trusted on re-paste. Run the same allow-list and invisible-character filtering every time.
- **RECOMMENDED:** Keep default paste behavior deterministic across browsers by normalizing equivalent b/strong and i/em tags to the same attributes.

## 11. Performance and limits

### Storage and transaction cost

- **DECIDED — Current baseline:** MCP board planners allow up to 5,000 objects through server/board-ops.mjs LIMITS.boardObjects; this is not a universal client-side cap.
- **DECIDED — Current baseline:** TextEditor currently replaces a string on every input event. docs/history.md notes that this creates quadratic typing work when garbage collection is disabled.
- **RECOMMENDED:** Rich text changes only the inserted/deleted/format ranges in Y.Text; never call delete-all then insert-all for an ordinary keystroke.
- **RECOMMENDED:** A typed character should cause one local Y.Doc transaction, one Y.Text delta event, one affected-object cache update, and one affected-object render update.
- **RECOMMENDED:** Do not scan all objects or call toJSON on every text Y.Map for each keystroke.
- **RECOMMENDED:** Observe nested Y.Text events through Store's existing observeDeep path or a per-active-editor observer. Coalesce one browser input batch into one Store change.
- **RECOMMENDED:** Keep plain-projection repair in the same local transaction where possible. For a remote merge, derive the projection from the converged Y.Text and avoid feedback writes when the value already matches.
- **RECOMMENDED:** Keep remote awareness updates separate from Y.Doc content updates.

### Rendering and layout

- **RECOMMENDED:** Keep passive board rendering in SVG through markup.ts. Use a DOM editing overlay only for the actively edited object.
- **RECOMMENDED:** The editing overlay should render semantic paragraphs, marks, and lists and bind changes as incremental Y.Text operations.
- **RECOMMENDED:** Do not create one contentEditable DOM subtree for every object on a large board.
- **RECOMMENDED:** Cache wrapped lines and text metrics per object id, text revision, width, font, font size, weight, marks, and alignment.
- **RECOMMENDED:** Invalidate only the edited object's layout when its Y.Text, width, font, or relevant style changes.
- **RECOMMENDED:** Reuse src/text.ts measure's bounded cache, currently 20,000 entries, and add a bounded rich-layout cache.
- **RECOMMENDED:** Cap the rich-layout cache at 5,000 object entries or 16 MiB of estimated text/run data, whichever comes first.
- **RECOMMENDED:** Cache paragraph line breaks by content revision and available width. Camera pan and zoom must not recompute wrapping.
- **RECOMMENDED:** Compute list markers from paragraph order after wrapping; they do not consume text indexes.
- **RECOMMENDED:** Do not rewrap every text object when one object changes. Only update the affected object and its layout dependents.

### Measurable release targets

| Status | Workload | Target |
|---|---|---|
| RECOMMENDED | One character typed into a 4,000-code-point object on a 1,000-object board | p95 under 16 ms for local model, cache, layout, and render work. |
| RECOMMENDED | One character typed into a 20,000-code-point object | p95 under 50 ms, with no full-board text scan. |
| RECOMMENDED | One format command over 4,000 code points | p95 under 16 ms locally. |
| RECOMMENDED | Board with 5,000 objects, 1,000 rich objects, and 250,000 rich-text code points | Initial passive render stays within the existing board frame budget; measure cold and warm separately. This is a stress workload, not a claim that every client enforces a 5,000-object cap. |
| RECOMMENDED | JSON serialization of a 20,000-code-point object | No more than 256 KiB after normalization. |
| RECOMMENDED | Client observer response | One changed text object reported per local input batch; zero unrelated text objects rebuilt. |

- **RECOMMENDED:** Treat these as benchmark gates, not claims about the current implementation.
- **RECOMMENDED:** Benchmark on a low-end supported laptop and a current mobile device. Include Unicode combining marks, emoji, long unbroken words, 2,000 paragraphs, and maximally fragmented style runs.
- **RECOMMENDED:** If the targets fail, reduce the supported object or paragraph limits before adding editor plugins.
- **OPEN:** Confirm the 5,000-object and 20,000-code-point envelope with the existing capacity target in docs/capacity.md.

## 12. Accessibility

- **RECOMMENDED:** Expose the active editor as a multiline textbox with an accessible name containing the object type and a short object label.
- **RECOMMENDED:** Keep the full editing path keyboard-complete: text selection, all four marks, both list kinds, three alignments, popover navigation, Escape, and undo/redo.
- **RECOMMENDED:** Every popover command uses a real button with a stable accessible name, disabled state, and pressed state from the active-state query.
- **RECOMMENDED:** Use aria-pressed for binary mark buttons. For mixed selections, expose a mixed pressed state supported by the chosen button semantics and announce “mixed formatting”.
- **RECOMMENDED:** List rendering uses real semantic list structures in the edit overlay and equivalent accessible list semantics in the SVG's accessible description.
- **RECOMMENDED:** Announce list kind and alignment when a command changes them. Do not announce every character typed.
- **RECOMMENDED:** Use underlining and strike as visible decorations, not colour changes alone.
- **RECOMMENDED:** Keep text and popover contrast at WCAG AA: 4.5:1 for normal text and 3:1 for large text and essential controls.
- **RECOMMENDED:** Use a visible keyboard focus ring on every popover control and preserve focus when commands complete.
- **RECOMMENDED:** Screen readers must read the text once. Hide the passive duplicate SVG text from the accessibility tree while the DOM editor is active.
- **RECOMMENDED:** Do not encode mark or list state by colour alone. Keep the board's existing foreground, theme, and contrast checks in place.
- **RECOMMENDED:** Test VoiceOver and NVDA for reading, selection, mixed formatting, list navigation, and undo.

## 13. Undo, history, templates, comments, and collaboration cursors

### Undo and redo

- **DECIDED — Current behavior:** Store.undo tracks the objects, meta, and labels roots with tracked origin LOCAL and a 350 ms capture timeout.
- **RECOMMENDED:** Keep text edits and marks inside Store.transact so Store.undo captures nested Y.Text updates through the objects root.
- **RECOMMENDED:** Group ordinary typing using the existing 350 ms capture window.
- **RECOMMENDED:** Call undo.stopCapturing before and after a popover command so a mark or alignment command does not merge with surrounding typing.
- **RECOMMENDED:** One pasted fragment, list conversion, or alignment operation is one transaction and one undo step.
- **RECOMMENDED:** Undo only reverses the local user's tracked operation; it must not undo another collaborator's later edit.
- **RECOMMENDED:** Test local undo after a concurrent remote insertion and remote formatting change.
- **RECOMMENDED:** If the Yjs UndoManager cannot selectively reverse nested Y.Text format attributes without disturbing remote changes, stop rollout until the command layer can do so safely.

### History snapshots and restore

- **DECIDED — Current behavior:** server/history.mjs snapshots the board Y.Doc update. docs/history.md says comments are not included and garbage collection is enabled.
- **RECOMMENDED:** A snapshot containing nested Y.Text preserves the current text and marks as part of the board update.
- **RECOMMENDED:** History preview and restore in src/history.ts must compare richTextDelta, not just Y.Map.toJSON, because the latter returns plain text for Y.Text.
- **RECOMMENDED:** A restore must preserve richTextVersion and feature:rich-text. Feature keys remain monotonic as the existing restore path intends.
- **RECOMMENDED:** Restoring an older plain-string snapshot into a rich-text board leaves that object plain until its next rich edit; it must not remove the board capability key.
- **RECOMMENDED:** Snapshot history does not retain characters deleted before a snapshot. Do not claim that .drift or history stores every keystroke.
- **RECOMMENDED:** Add a preview case where only inline marks change and a restore case where only one paragraph's alignment changes.

### Templates and imports

- **DECIDED — Current behavior:** Custom templates rebuild object fields against a type-specific whitelist and allow text up to 20,000 characters.
- **RECOMMENDED:** Extend the client and server template validators to accept richTextVersion and richTextDelta only for enabled types.
- **RECOMMENDED:** Normalize template deltas, reject unknown versions, enforce character/paragraph/byte limits, and drop unsupported style attributes only when doing so is explicitly safe.
- **RECOMMENDED:** Keep backward compatibility: a template without richTextDelta creates a legacy plain text object.
- **RECOMMENDED:** Built-in templates that supply text strings continue to work without a conversion migration.
- **RECOMMENDED:** Template preview, duplicate, edit, file export, and file import must preserve formatting.
- **RECOMMENDED:** If a template includes an unsupported rich-text version, refuse to use it with a clear error rather than silently flattening it.
- **RECOMMENDED:** A template file's readable JSON carries the same normalized richTextDelta as board JSON.

### Comments

- **DECIDED:** Formatted comments are out of scope.
- **DECIDED:** The comments room remains a separate Y.Doc with plain string bodies.
- **RECOMMENDED:** Do not add richText to comment thread or reply shapes, do not change comment authz behavior, and do not include comments in the board rich-text feature marker.
- **RECOMMENDED:** Any future formatted-comment proposal must revisit server/comment-authz.mjs, comment import/export, notification snippets, search, and the separate comments room.

### Collaboration cursors and selection awareness

- **DECIDED — Current behavior:** src/sync.ts uses Yjs Awareness; src/app.ts currently publishes user, selected object ids, and a throttled board cursor.
- **RECOMMENDED:** Add an ephemeral textSelection awareness field containing objectId, anchor RelativePosition, focus RelativePosition, and a short expiry.
- **RECOMMENDED:** Encode Yjs RelativePositions so a remote insertion shifts the shown selection with the document. Raw integer offsets become stale as collaborators type.
- **RECOMMENDED:** Do not publish the selected text, Markdown, or the object's whole content in Awareness.
- **RECOMMENDED:** Use the user's existing awareness name and colour; do not store selection in board Y.Doc or history.
- **RECOMMENDED:** Clear textSelection when focus leaves the object, the object is deleted, the editor closes, the board becomes read-only, or the client disconnects.
- **RECOMMENDED:** Render remote ranges as a lightweight overlay with a caret and translucent selection. Avoid rerendering object text for cursor movement.
- **RECOMMENDED:** Bound update frequency to 10 updates per second per client and expire stale selection state after 10 seconds.
- **RECOMMENDED:** Local text selection and remote cursors must not steal focus or change the local selection.
- **OPEN:** Confirm whether collaborator text selections are visible to every board editor or only while both people edit the same object.

## 14. Tests required

**RECOMMENDED — Scope:** These are implementation tests required before rollout. This document does not add or run them.

### Data and parser

- **RECOMMENDED:** Legacy text lazily initializes into equivalent Y.Text with no character changes.
- **RECOMMENDED:** Unicode round trips cover astral emoji, combining marks, RTL scripts, mixed direction text, CRLF, and empty paragraphs.
- **RECOMMENDED:** All supported inline marks round-trip through Y.Text.toDelta, BoardJson, template JSON, Markdown, and back.
- **RECOMMENDED:** Block alignment and list attributes survive empty paragraphs, trailing newline, split, merge, and plain projection.
- **RECOMMENDED:** Markdown parsing handles nested inline marks, escapes literal delimiters, recognizes only supported list markers, and rejects unsupported attributes.
- **RECOMMENDED:** Parser output never contains HTML tags other than the allowed underline form.
- **RECOMMENDED:** Unknown versions, attribute values, oversized deltas, excessive paragraphs, and invalid UTF-8 size are refused without writes.

### CRDT and editor operations

- **RECOMMENDED:** Two independent Y.Docs test every row in section 5 in both update-application orders and assert equal final state.
- **RECOMMENDED:** Tests include overlapping bold/unbold, independent mark keys, concurrent insertion within and at a range edge, simultaneous splits, repeated merges, and alignment conflicts.
- **RECOMMENDED:** Tests assert no text loss, stable list order, deterministic rendering, and converged plain text projection.
- **RECOMMENDED:** Local typing, format, paste, and list conversion create expected undo stack items.
- **RECOMMENDED:** Undo after remote insertion or formatting preserves the remote change.
- **RECOMMENDED:** Toolbar focus transfer preserves selection; mixed state queries are correct for marks and block commands.
- **RECOMMENDED:** Keyboard shortcuts do not fire when a dialog, input, or non-text editor owns focus.
- **RECOMMENDED:** Read-only, locked object, deleted object, and unsupported feature states disable commands without changing Y.Doc state.

### Integrations and compatibility

- **RECOMMENDED:** Current feature-aware old client opens feature:rich-text read-only and retains the plain projection.
- **RECOMMENDED:** A pre-gate client can edit the projection without changing richText; a new client repairs the projection from richText and surfaces a stale-client warning.
- **RECOMMENDED:** Rollback and downgrade fixtures verify that a rich board is not writable by a client that does not preserve the feature.
- **RECOMMENDED:** PNG output visually covers marks, lists, alignment, clipping, and hidden/private object rules.
- **RECOMMENDED:** Markdown, CSV, BoardJson, .drift, templates, history preview, and history restore each preserve or explicitly flatten the supported subset.
- **RECOMMENDED:** MCP read includes text and textMarkdown, uses the fence, applies stripInvisible, and respects output caps.
- **RECOMMENDED:** MCP write accepts either text or textMarkdown, rejects both together and unknown fields, applies the stripper, validates limits, and writes atomically.
- **RECOMMENDED:** Pasted hostile HTML tests script, style, event handlers, href, SVG, entity tricks, bidi controls, zero-width characters, and malformed nesting.
- **RECOMMENDED:** Search tests find visible plain text and do not match Markdown delimiters or hidden text.
- **RECOMMENDED:** Comments tests prove the comment room remains plain and the authz guard is unchanged.

### Performance and accessibility

- **RECOMMENDED:** Benchmark the workloads and latency targets in section 11 with cold and warm layout caches.
- **RECOMMENDED:** Measure bytes for initial Y.Text creation, one character typed, one format toggle, one paste, JSON snapshot, and .drift archive.
- **RECOMMENDED:** Board-scale tests use 5,000 objects and at least 1,000 text-bearing objects.
- **RECOMMENDED:** Accessibility tests cover keyboard-only operation, VoiceOver, NVDA, contrast, focus return, mixed formatting announcement, and semantic list reading.

## 15. Slices

| Status | Slice | Size | Shippable result | Reversible boundary |
|---|---|---|---|---|
| RECOMMENDED | A. Shared format core | S | Parser, serializer, normalized delta validation, legacy plain projection, JSON and template representation, and tests; writes remain disabled. | No existing Y.Doc changes. Remove the unused module without data cleanup. |
| RECOMMENDED | B. Text object pilot | M | Lazy Y.Text for ordinary text objects, inline marks, lists, alignment, editing overlay, popover command API, and capability gate behind a release flag. | Stop new writes; keep readers and gate. Boards remain readable and gated. |
| RECOMMENDED | C. Interchange and collaboration | M | PNG, Markdown, BoardJson, .drift, undo, history preview/restore, awareness selection, MCP read/write, and paste sanitizer for text objects. | Each reader can continue displaying the plain projection; disable only write surfaces. |
| RECOMMENDED | D. Stickies and shapes | M | Enable rich editing for stickies and shapes; test card/sticky conversion and shape resizing/layout. | Per-object richTextVersion lets the feature remain mixed with plain objects. |
| RECOMMENDED | E. Cards and tracker | L | Rich title/description, dialog editing, search, CSV, MCP card tools, and shared tracker Markdown parser integration. | Keep title/description plain projections; turn off rich card writes while preserving reads. |
| RECOMMENDED | F. Follow-up syntax | S | Decide links, list nesting, typing shortcuts, and optional font/size/colour after usage data. | Add a new richTextVersion or feature version for incompatible data. |

- **RECOMMENDED:** Each slice lands only after its own parser and compatibility tests pass.
- **RECOMMENDED:** Slice A is safe to ship by itself because it writes no board data.
- **RECOMMENDED:** Slice B should not ship without the capability gate, rich JSON export, and plain projection repair.
- **RECOMMENDED:** Slice C is required before enabling external MCP rich writes.
- **RECOMMENDED:** Slice E is separately scoped because the tracker decision in docs/tracker-architecture.md already uses Markdown descriptions and separate search indexing.
- **OPEN:** Choose whether B and C must ship together. Shipping B alone exposes rich content that some existing export paths would flatten.

## 16. Risks

| Status | Risk | Mitigation |
|---|---|---|
| RECOMMENDED | Old clients predating the feature gate can write stale plain projections. | Gate the rollout on supported client adoption or enforce a server client-version floor. |
| RECOMMENDED | Y.Text.toJSON silently loses attributes. | Serialize richTextDelta explicitly in every JSON-facing path. |
| RECOMMENDED | Concurrent formatting has deterministic but unintuitive winners. | Document per-key conflict behavior; test pinned Yjs version and avoid clock-based promises. |
| RECOMMENDED | Newline split/merge can produce mixed block attributes. | Define left-side merge policy and test normalization races. |
| RECOMMENDED | Whole-board render or observer scans create input lag. | Incremental Y.Text observers, changed-object rendering, and section 11 benchmark gates. |
| RECOMMENDED | Markdown can be misinterpreted as instructions or raw HTML. | Strict shared subset, escaping, nonce fence, and stripInvisible on MCP boundaries. |
| RECOMMENDED | Pasted HTML can carry active or invisible content. | Allow-list tags only, text-node extraction, no innerHTML insertion, and invisible-character stripping. |
| RECOMMENDED | Underline has no standard Markdown syntax. | Use a single sanitized u extension and document lossy plain-text output. |
| RECOMMENDED | Cards have separate data and editor paths. | Defer cards or complete dialog, filter, CSV, MCP, template, and conversion changes in a dedicated slice. |
| RECOMMENDED | Template validators may silently drop fields they do not know. | Update both client and server validators before creating rich templates. |
| RECOMMENDED | History diff may think formatted text is unchanged because plain projection is equal. | Compare normalized richTextDelta in preview and restore plans. |
| RECOMMENDED | Large strings and many style boundaries inflate snapshots and exports. | Enforce proposal limits, normalize adjacent runs, measure Yjs and archive size. |
| RECOMMENDED | Comment room behavior may be accidentally broadened. | Keep comment text out of the feature and test the existing authz path unchanged. |
| RECOMMENDED | Screen readers may read SVG and DOM overlay duplicates. | Expose only one active accessible text source and test real assistive technologies. |
| OPEN | The 20,000-code-point limit may be too high for interactive editing or too low for existing boards. | Benchmark existing board corpus and capacity targets before freezing the value. |

## 17. OPEN QUESTIONS FOR JOHAN

1. **Which elements ship in v1?**
   - **OPEN — Options:** Text objects only; text objects plus stickies/shapes; or all of those plus card titles/descriptions.
   - **RECOMMENDED:** Text objects first. Add stickies and shapes next; keep cards for a separate slice.
   - **OPEN — Cost if wrong:** Starting with cards adds a separate dialog, search, CSV, MCP, tracker, and conversion surface. Starting too narrow delays common sticky-note formatting.

2. **How deep can lists nest?**
   - **OPEN — Options:** No nesting; one nested level; or unrestricted nesting.
   - **RECOMMENDED:** No nesting in v1 (depth 1 including the top list).
   - **OPEN — Cost if wrong:** Users may need outlines. Later nesting changes Markdown parsing, keyboard indentation, canvas measurement, and export.

3. **Are fonts, font size, or text colour in v1?**
   - **OPEN — Options:** Keep object-level settings only; add text-level font and size; add full text-level style including colour.
   - **RECOMMENDED:** No text-level fonts, size, or colour in v1.
   - **OPEN — Cost if wrong:** Adding them now increases merge conflict rules, measurement cache keys, contrast checks, import validation, and Markdown loss.

4. **Are links allowed inside a rich text run?**
   - **OPEN — Options:** No links; links only to safe HTTP(S); or links plus app-internal object links.
   - **RECOMMENDED:** No links in v1. Keep visible anchor text when pasting and discard href.
   - **OPEN — Cost if wrong:** People may expect pasted links to remain clickable. Supporting them requires URL safety checks, keyboard interaction, paste rules, SVG/PNG behavior, and MCP parsing.

5. **Should typing “- ” or “1. ” at the start of a line create a list?**
   - **OPEN — Options:** Always literal; auto-format on Space when the line is empty; or offer a preference.
   - **RECOMMENDED:** Auto-format only when typed by the user at an empty paragraph; do not auto-format paste or remote inserts. Undo restores the literal marker.
   - **OPEN — Cost if wrong:** Auto-format can surprise someone writing literal punctuation; no shortcut makes list entry slower.

6. **What should a plain MCP text write do to a rich object?**
   - **OPEN — Options:** Flatten formatting; reject it; or require textMarkdown for every write once richText exists.
   - **RECOMMENDED:** Flatten deliberately and return a warning. Keep textMarkdown as the preserve-format path.
   - **OPEN — Cost if wrong:** Silent flattening loses user formatting; rejecting breaks existing MCP clients.

7. **Should collaborators see each other's text selections?**
   - **OPEN — Options:** Show all editor selections; show only while editing the same object; or show carets only.
   - **RECOMMENDED:** Show selections only while both people edit the same object, with a clear privacy setting if needed.
   - **OPEN — Cost if wrong:** Selection sharing helps avoid overwrites but exposes what a person is selecting in real time.

8. **Which limit should be frozen?**
   - **OPEN — Options:** 4,000 UTF-16 code units matching the current MCP validator; 20,000 matching template text; or a separate higher canvas-only limit.
   - **RECOMMENDED:** 20,000 for canvas and templates, 4,000 for MCP until the tool limit is reviewed.
   - **OPEN — Cost if wrong:** A low cap limits long notes; a high cap increases Yjs state, layout, snapshot, and model response costs.

9. **Should board alignment control update rich paragraphs?**
   - **OPEN — Options:** Keep it as the default only; apply it to all existing paragraphs; or remove it for rich objects.
   - **RECOMMENDED:** Apply it to all paragraphs and update the default in one transaction.
   - **OPEN — Cost if wrong:** Two separate alignment controls create confusing mixed state; applying globally can overwrite intentional paragraph alignment.

10. **Is a server-side minimum client version required?**
    - **OPEN — Options:** Rely on the current feature gate; add a relay version floor; or require operators to upgrade all clients before write rollout.
    - **RECOMMENDED:** Require the feature-aware client before enabling rich writes; add a version floor where old clients cannot be retired.
    - **OPEN — Cost if wrong:** A pre-gate client can edit the plain projection and lose its own change after rich projection repair.

## 18. Reconciliation with docs/rich-text-ux.md (designer, 70e7e68)

The designer's popover spec is a separate file, `docs/rich-text-ux.md` on branch `docs/rich-text-ux`. It uses the command and state names of section 4 (`toggle-mark`, `set-alignment`, `set-list`, on/off/mixed). Answers to its section 9:

| # | Question | Answer |
|---|---|---|
| 1 | Tab | **RECOMMENDED, accepted:** while the popover is open, `Tab` moves focus into the popover (roving arrows) and `Esc` returns to the editor with the selection restored; `Esc` in the editor commits. This changes today's "Tab commits" behaviour in `src/editor.ts` for rich-capable objects only; plain objects keep it. Reason: keyboard-only users must reach the controls. A dedicated chord (Alt+F10) is the fallback if testing shows Tab-in is disruptive. |
| 2 | Soft line break | **No in-paragraph break in v1.** Every newline is a paragraph (section 3). `Shift+Enter` therefore behaves like `Enter` (new paragraph, new list item inside a list). A soft break (for example U+2028 or a `br` attribute) would change the Markdown subset, the layout and the stripper (U+2028 is on the invisible-separator list), so it is a follow-up in slice F. |
| 3 | Emoji | Fine: the emoji button is the popover's last control on text elements; it inserts text through `insert-text` (one undo unit). |
| 4 | Mixed state | Agreed: `aria-pressed="mixed"` driven by the `mixed` value of section 4, plus ", mixed" in the accessible name. |
| 5 | List keys | Agreed. `Enter` on an empty item leaves the list; `Backspace` at item start removes the marker and keeps text; `Delete` at item end merges the next paragraph (left-side attributes win, section 5). `- ` / `1. ` at an empty paragraph starts a list with one undo step restoring the literal characters: this is open question 5, recommended yes, still Johan's call. |
| 6 | Phone | Agreed, no data impact. The popover reads state from `getRichTextState` and sends commands only. |

The popover never writes Y.Text directly. It sends commands through the editor command layer and reads `RichTextState`.

The popover UI spec is `docs/rich-text-ux.md` (branch `docs/rich-text-ux`, 7a74e45). The two files reference each other and merge together.
