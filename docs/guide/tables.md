# Tables

A table is a grid of cells on the board, for lists, plans, comparisons and anything else that wants rows and columns. Each cell holds a short text, and the table is an object like any other: you can move, lock, copy and comment on it, and it appears in exports.

> **Different cells, no conflict.** Two people can type in different cells of the same table at the same time, and both changes are kept. Two people typing in the *same* cell at the same moment overwrite each other: the later change wins.

## Add one

Press `G`, then click the board for a table of 3 columns and 3 rows, or drag out a box: the table gets as many columns and rows as fit it. The first cell opens for typing.

You can also copy cells from a spreadsheet (Excel, Google Sheets, Numbers) and paste them onto the board: the cells arrive as a table.

## Type in the cells

Double-click a cell, or select the table, click a cell and press `Enter`, to type in it.

| Key | What it does |
|---|---|
| `Enter` | A new line inside the cell |
| `Tab` / `Shift+Tab` | Go to the next or previous cell. `Tab` in the last cell adds a row. |
| `Esc` | Finish |

Cells show **bold**, *italic*, `code` and links as you write them in Markdown (`**bold**`, `*italic*`, `` `code` ``, `[text](https://example.com)`). Headings, lists and other blocks are not used inside a cell. A cell holds up to 1,000 characters and grows taller to fit its text.

## Select cells

Select the table, then click a cell to select it. `Shift`-click another cell, or hold `Shift` and press an arrow key, to select a block of cells. The arrow keys and `Tab` move between cells, `Enter` types in the active cell, and `Esc` lets go of the cells.

With cells selected:

- `Delete` empties them.
- `Ctrl+C` (`Cmd+C` on Mac) copies them as text you can paste into a spreadsheet, and pasting tab-separated text into a selected cell fills cells from there, adding rows and columns as needed.

## Rows, columns and style

Right-click a cell (or press and hold on a touch screen) for the table menu:

- **Insert** a row above or below, a column to the left or right.
- **Move** a row up or down, a column left or right.
- **Delete** the row or column.
- **Header row** and **header column** make the first row or column bold, tinted and ruled off.
- **Align** the column's text left, centre or right.
- **Fill** the selected cells with a colour.
- **Clear cells**, **Copy for a spreadsheet** and **Copy as Markdown**.

Drag the border between two columns to change the column's width. A table has up to 100 rows and 30 columns. A table's size is always the size of its columns and rows, so it has no resize handles.

## Share and export

PNG, SVG and print show the table drawn as it looks on the board, without the selection. A board file (`.drift`) and a JSON snapshot keep every cell. The board's Markdown summary, which agents read, includes the table as a Markdown table. An AI agent connected with an access token can create a table from rows of text and replace its cells. Tabula's built-in AI features only read tables, through the Markdown summary.

## Not yet

Merged cells, cell comments and connectors that attach to a single cell are not part of tables yet. A cell holds plain text with bold, italic, code and links only.
