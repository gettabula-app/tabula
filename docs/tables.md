# Tables (TAB-121)

A table is a board object of type `table`. It is drawn as plain SVG (no foreignObject), edited in place, and stored so that concurrent edits of different cells merge.

## Storage: one flat map, one key per part

The object is a flat map like every other object. Its parts are keys of their own (`shared/tables.mjs`):

| Key | Value |
|---|---|
| `r:<rowId>` | the row's rank (fractional-indexing key); rows sort by rank, ties by id |
| `k:<colId>` | the column's rank |
| `w:<colId>` | the column's width in world units (60 to 800; default 160) |
| `a:<colId>` | the column's alignment, `center` or `right` (`left` is the default and has no key) |
| `c:<rowId>:<colId>` | the cell's text (inline Markdown), absent when empty |
| `f:<rowId>:<colId>` | the cell's fill colour, a colour the board can draw |
| `headerRow`, `headerCol` | booleans on the object |

Ids are stable and never positions (`/^[a-z0-9]{1,12}$/`). Every key is its own last-writer-wins value in the shared document, so two people editing different cells, or inserting rows or columns at the same time, merge without conflict; two concurrent inserts at the same place both survive (fractional keys, ties broken by id). A cell whose row or column is gone (a delete that raced with an edit) is simply not read. `test/table-model.test.ts` proves the merges on two real documents.

Why not a nested Y.Map or Y.Text per cell: the store, the validator, the board file and templates all treat an object as a flat map; per-key storage gives cell-level merging with no change to any of them. Two people typing in the *same* cell overwrite each other (the later write wins); a per-cell Y.Text is a follow-up that needs a store change (the same one the Markdown block needs).

TAB-186 (typed columns, formulas, named variables) adds more per-column keys beside `w:` and `a:` and reads the cells through the same model.

## Limits

100 rows, 30 columns, 1,000 characters per cell (the validator counts code points), and 150,000 characters of cell text in one table (`MAX_TABLE_CHARS`, summed over every `c:` key, so it also bounds orphan cell keys). The total keeps a table inside the validator's per-object byte cap (256 KiB) with room for its keys; it is enforced in the model (`setCellPatch`, `fillFromPatch`), in a new-table paste, in MCP `rows`, and in the validator (`table_too_big`). Ranks must be keys fractional-indexing accepts (`isValidRank`): the validator refuses others, and the model tolerates a damaged rank anyway (that row or column sorts last, keeps its cells, and gets a valid rank when it is moved), so a hostile write cannot stop inserts and moves. `parseGrid` reads at most 1 MB. `server/sync-validate.mjs` checks every key by its pattern (`tablePartCheck`) and the counts (`tableCountCodes`).

## Size

A table's `w` and `h` are derived: the sum of the column widths and of the row heights (a row is as tall as its tallest cell, at least one line). `src/table-layout.ts` computes them and the drawing; the app keeps the stored size equal to it after this person's edits (`app.fitTable`), and `src/table-heal.ts` repairs it after remote edits, agent writes and on load, with the rules of the card and Markdown heals (an untracked origin, another editor's size-only write adopted, never re-measured). The object has no resize or rotate handles.

## Cost

A full-size table (100 rows x 30 columns of 40-character cells) measures in about 46 ms cold (3,000 cells) in Chromium; `layoutTable` keeps the last 24 layouts by a fingerprint of the table's keys, its header flags, the style and the text-measure epoch (cleared when fonts load), so asking again costs about 1 ms. The canvas redraws an object only when it changed, not on pan or zoom. That table's SVG is about 6 MB (every word is a text element), so very large tables are slow to redraw after a change; the 150,000-character cap is the bound.

## Drawing

`layoutTable` lays each cell out with `layoutInlineText` (`src/markdown-layout.ts`): the inline subset of the Markdown parser, no blocks. `tableMarkup` (`src/markup.ts`) draws the cell fills (a filled cell's text in the ink that reads on the fill), the header tint, the text and the grid. The selected cells are an outline (`ctx.tableSelection`) that is never in an export, a print or a thumbnail.

## Interaction

`src/table-ui.ts` (`TableController`): cell and range selection, keyboard, the row and column operations, headers, alignment, fill, clear, the clipboard, and the column-border drag; each operation is one undo step. In-place cell editing is `TextEditor.startCell` (`src/editor.ts`), writing the cell's key on every keystroke. The right-click menu entries are `src/ui/table-menu.ts`. The tool is `{ kind: 'table' }`, key `G` (`src/shortcuts.ts`); a click makes 3 x 3, a drag as many columns and rows as fit the box. Pasting tab-separated text makes a table (`app.pasteTable`), or fills cells when some are selected.

## MCP

`create_objects` takes `{ type: 'table', rows: string[][], headerRow?, headerCol?, fontSize?, x, y, parent? }`; `update_objects` takes `rows` (replaces every cell: new row and column ids, so widths, alignment and fills are dropped; TAB-186's stable ids will need a cell-level update instead), `headerRow`, `headerCol`, `fontSize`, position. Reads return `rows` (cleaned text, cut at 20,000 characters in total). `server/board-export.mjs` writes the Markdown summary as a quoted Markdown table.

## Clipboard text

Copying cells writes plain tab-separated text. A cell that starts with `=`, `+`, `-` or `@` can be read as a formula by a program that opens pasted text; nothing is added or removed on copy. If a CSV export is added, prefix such cells with an apostrophe there.

## Not in v1

Merged cells, comments and connectors anchored to a cell, rich text beyond bold, italic, code and links, per-cell Y.Text, PPTX (TAB-105), and scrolling inside the table at phone width (the canvas pans and zooms instead).

Tests: `test/table-model.test.ts`, `test/table-browser.test.ts` (real Chromium), the table cases in `test/sync-validate.test.ts`, `test/board-ops.test.ts` and `test/board-export.test.ts`.
