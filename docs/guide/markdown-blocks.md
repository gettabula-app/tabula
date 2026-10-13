# Markdown blocks

A Markdown block is a place on the board for longer notes, with headings, lists, task boxes, tables and links. You write it in Markdown, a simple way of marking up text, and Tabula draws it formatted. It is an object like any other: you can move, resize, lock and comment on it, and it appears in exports.

> **One person at a time.** Two people editing the same Markdown block at the same moment overwrite each other: the later change wins. Edit different blocks at the same time instead.

## Add one

Open the **Text**, **Markdown block** and **Link** group in the left toolbar, choose **Markdown block**, then click the board. A box opens for the text: write in Markdown, then press `Esc` (or `Ctrl+Enter`, `Cmd+Enter` on Mac) to see it formatted. Drag instead of clicking to choose the width. There is no single-key shortcut; `M` is for chat.

## Edit

Double-click a block, or select it and press `Enter`, to see and edit its source. `Tab` indents a list item; `Esc` finishes. If you empty the box and finish, the block is removed.

Drag the handles on its left and right sides to change its width; the height follows the text.

## What you can write

| You write | You get |
|---|---|
| `# Heading`, `## Smaller heading` | Headings (up to six levels) |
| `**bold**`, `*italic*`, `~~struck~~` | Bold, italic, struck-through text |
| `` `code` `` and a fenced block with three backticks | Code in a fixed-width font |
| `- item`, `1. item`, indented lines | Lists and nested lists |
| `- [ ] task` and `- [x] done` | Task boxes you can tick on the board |
| `> quote` | A quote |
| `[text](https://example.com)` | A link |
| `[text](#obj:ID)` | A link to another item on the board |
| A table with `\|` and a `---` row | A table |
| `---` | A line |

Everything else is shown as typed. Tabula does not run HTML: if you write `<b>x</b>`, you see `<b>x</b>`. Links work for `https://`, `http://` and `mailto:` addresses and for items on the board; any other kind of link is shown as plain text.

## Tick a task

Select the block, then click a task box to tick or untick it. One `Ctrl+Z` takes it back. People who can only view the board, and blocks that are locked, cannot be ticked.

## Open a link

Select the block first, then click the link (or hold `Ctrl`, `Cmd` on Mac, and click). A web link opens in a new tab. A link to an item on the board selects it and moves the view there. Clicking a block you have not selected only selects it, so you never open a page by accident while dragging.

## Copy the Markdown

Select the block and choose **Copy as Markdown** in the quick-action bar (or the properties panel). The text is copied as you wrote it, to paste into another document.

## Share and export

PNG and SVG exports draw the block formatted. A board file (`.drift`) keeps the text you wrote. The board's Markdown summary, which agents read, includes it. An AI agent connected with an access token can read and write Markdown blocks. Tabula's built-in AI features only read them, through the Markdown summary; they do not write to a block.

## For screen readers

The board outline lists a Markdown block as "Markdown block" with its first heading or line, and reads the whole text and how many tasks are done. See [Keyboard and screen readers](accessibility.md).

## Limits

A block holds up to 20,000 characters. An agent writing through an access token can write up to 4,000 characters at a time. Pictures from the board's own library can be named in a block, but a block shows them as a labelled box for now.
