# Markdown blocks

TAB-140. A **Markdown block** is a board object whose content is written in Markdown and drawn as formatted text: headings, lists, task boxes, tables, code, links. It sits on the board like a text object (move, resize, lock, group, comment), and exports, summarises and syncs like one.

## Decisions (v1)

- **A new object type, `markdown`, not a mode of `text`.** Its content is the object's `text` field, so the sync validator, history, templates, MCP and the board summary already carry it. It has its own drawing, its own editing and its own resize rules, which would have been special cases inside `text`.
- **The source is one plain string, last writer wins.** Like every text on the board today. **There is no simultaneous editing inside one block**: if two people type into the same block at the same time, the later write replaces the earlier one. A block edited by one person at a time, and different blocks edited at the same time, are fine. Collaborative editing of one block (a `Y.Text` per block) is a follow-up: it changes the validator, history and snapshot layers, which every other text field shares.
- **Drawn as plain SVG**, with our own layout (`src/markdown-layout.ts`), so the canvas, the SVG export and the PNG export draw the same thing and nothing depends on `foreignObject` (which browsers do not rasterise reliably).
- **A strict allow-list, no raw HTML** (`src/markdown.ts`). Everything the parser does not know is shown as the text it is.

## What is understood

Headings `#` to `######`; paragraphs (a line break is a space, two trailing spaces or a backslash make a hard break); `**bold**`, `*italic*` or `_italic_`, `~~strike~~`; `` `inline code` `` and fenced code blocks (monospace, no highlighting); `>` quotes; `-`, `*`, `+` and `1.` lists, nested; `- [ ]` and `- [x]` task items; GFM tables with `:--`, `:-:`, `--:` alignment; `---` rules; links; and pictures from the board's own asset store.

Not understood on purpose: raw HTML (a `<script>` is text), remote pictures, scripts, iframes, embeds, footnotes, reference-style links, setext headings, indented code.

### Links

Kept only as: `https://` or `http://` (no user name or password), `mailto:`, or a board item, `#obj:<id>`. Anything else (`javascript:`, `data:`, `file:`, a relative path, an address with a space) loses its link and its text stays. A link never contains another link.

On the canvas a link works only on a block that is **already selected** (or with Ctrl/Cmd held), and not on the second click of a double click (which edits). So selecting or dragging a block never opens a page. A web link opens in a new tab with `rel="noopener noreferrer"`; an item link selects that item and flies to it (and says "That item is not on this board." when it is gone). In an exported SVG a link is an anchor.

### Task boxes

A task box ticks on a selected block with a click, in one undo step; it rewrites `[ ]` to `[x]` on the one source line (`toggleTask`). Viewers, locked blocks and read-only boards cannot tick. Because the source is one value, two people ticking at the same moment keep the later write.

### Pictures

`![alt](asset:<sha-256>)` names a picture already in the board's asset store; anything else (an `https://` address, `data:`) is shown as `[image: alt]`. In v1 a board picture is drawn as a labelled placeholder box; drawing the picture itself in a block is a follow-up.

## Editing

Double-click the block, press `Enter` on it, or open the Text/Markdown/Link group in the left toolbar and choose **Markdown block** (no single-key shortcut: `M` is the chat's). The block shows its **source** in a monospace textarea on the canvas colour, with the caret at the end; the block's height follows what you type. `Esc` or `Ctrl/Cmd+Enter` leaves editing and the block is drawn; `Tab` indents (it does not leave). A block emptied of text is removed when editing ends, like a text object.

Resize with the side handles: they set the width the text wraps at, and the height follows the content. There are no corner or rotate handles.

## Height

The stored height `h` is the height of the drawn content (hit areas, selection and layers use it). The editor and a resize write it as you work; a block written from outside (an agent through MCP, a template, a file, another editor with other fonts) gets an estimated height that **`src/markdown-heal.ts`** corrects when the board opens and after remote edits. It follows the rules of the card heights (`src/card-height-heal.ts`): an untracked origin (no undo step), another editor's height-only write is adopted and never re-measured (no ping-pong between machines with different font metrics), and only owners and editors write.

## Where it appears

- **Board summary** (MCP `board summary`, `server/board-export.mjs`): the block's source, quoted, so its headings and lists do not become the summary's.
- **MCP**: `create_objects` accepts `type: "markdown"` with `text` (1 to 4,000 characters over MCP; the board allows 20,000), `x`, `y`, `w?`, `h?`, `fontSize?` and `lineHeight?` (0.8 to 3); `update_objects` can change `text`, `fontSize`, `lineHeight`, `textColor`, `fill` and the box. The text is returned by the read tools like any text.
- **Export**: PNG and SVG draw it; `.drift` keeps the source (it is the `text` field).
- **Copy as Markdown**: a button in the quick-action bar and the properties panel copies the source.
- **Screen readers**: the outline names a block "Markdown block, "<first heading or line>"" and describes it with its plain text and the number of tasks and ticked tasks.
- **Layers**: named by its first heading or line.
- **Templates**: a template may hold Markdown blocks.
- **AI**: the AI bar reads the block's text where it reads other text; it does not write Markdown blocks (follow-up).

Leave `lineHeight` empty and a block uses 1.45. Setting it changes the line spacing of the whole block; headings keep their size relative to the body text.

## Themes and phones

Text, tints and lines are drawn in the object's text colour (default: the canvas ink), so every theme and every text colour gets matching quiet tones; the block's own background (`fill`) is none by default. On a phone the block is as wide as you make it; the editor is the same textarea.

## Not in v1 (follow-ups)

Simultaneous editing in one block (`Y.Text`); drawing board pictures inside a block; AI proposals that create Markdown blocks; variables (`{{name}}`, TAB-136); syntax highlighting in code blocks; an Objects-panel preview.

## Files

`src/markdown.ts` (parser, limits, `toggleTask`, titles), `src/markdown-layout.ts` (layout), `src/markdown-svg.ts` (SVG), `src/markdown-heal.ts` (heights), `src/markup.ts` (`markdownMarkup`, `markdownBoxHeight`), `src/editor.ts` (source editing), `src/app.ts` (tool, link and task clicks), `src/ui/markdown-actions.ts`. Tests: `test/markdown.test.ts` (parser, including hostile input and limits), `test/markdown-layout.test.ts`, `test/markdown-browser.test.ts` (real browser: render, tasks, links, jump, edit, tool, export, screen reader), plus the server tests in `test/board-ops.test.ts` and `test/board-export.test.ts`.
