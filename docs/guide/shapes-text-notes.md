# Shapes, text and sticky notes

The tool rail on the left of a board holds everything you draw with. This page covers shapes, sticky notes, text, drawings, frames, icons, the quick-action bar, and locking.

## The tool rail

Each tool has a one-letter shortcut. Hover over a button, or move keyboard focus onto it, to see its name and shortcut.

| Key | Tool |
|---|---|
| `V` | **Select** |
| `H` | **Hand** (pan). Holding `Space` and dragging also pans. |
| `N` or `S` | **Sticky note** |
| `T` | **Text** |
| `R` | Rectangle |
| `O` | Ellipse |
| `D` | Diamond |
| `L` or `X` | **Connector** (see [Connectors](connectors.md)) |
| `P` | **Pen** |
| `F` | **Frame** |
| `C` | **Comment** (see [Comments](comments.md)) |

Shortcuts do not work while you are typing in a text box. `Esc` clears your selection and returns to **Select**.

Below the drawing tools, the rail has drawers for **UML**, **Icons**, **Stickers** and **Templates and team exercises**, plus buttons to start a dot vote or a quick poll, and **Undo** and **Redo**.

If you can only view a board, only **Select** and **Hand** are available.

## Sticky notes

1. Press `N`, or click **Sticky note**.
2. Pick a colour in the **Note colour** tray that appears beside the rail.
3. Click the board to place a note, or drag to set its size.
4. Type. Press `Esc` or click away to finish.

To change a note's colour later, select it and use the **Colour** swatch in the quick-action bar. **Choose any colour** at the end of the swatches opens a colour picker.

## Shapes

Click **Shapes** on the rail to open the Shapes panel. Shapes are grouped as **Basic**, **Arrows**, **Callouts** and **Flowchart**.

- Type in **Search shapes** to filter by name.
- Click a shape, then click the board to place it at its default size, or drag to size it. The shape tool then switches back to **Select** and you can type into the new shape straight away.
- Or drag a shape from the panel onto the board.

`R`, `O` and `D` skip the panel and draw a rectangle, ellipse or diamond.

To change the shape of an existing object, select it and use the **Shape** button in the quick-action bar.

## Text

Press `T` and click or drag on the board to add a text box. You can also double-click empty canvas with **Select** active to create one.

To edit text in a shape, sticky note, connector or frame title, double-click it, or select it and press `Enter`. While editing:

- `Esc` or `Ctrl+Enter` (`Cmd+Enter` on Mac) finishes.
- `Tab` finishes.
- In shapes, notes and text boxes, `Enter` starts a new line. In frame names and connector labels, `Enter` finishes.

### Alignment

![The Text popover with Align, Vertical and Text colour](images/text-options.png)

In the quick-action bar, **Text** sets horizontal alignment (left, centre, right) and text colour. For shapes and sticky notes it also sets **Vertical** alignment: top, middle or bottom.

### Fonts

Open the properties panel (see below) and use **Font**. The font list has a search field (**Search Fontshare fonts**), category filters and a section for fonts already used on the board. Pointing at a font previews it on your selection. Click to keep it, or press `Esc` to put the old one back. You can also set **Size** and **Weight** there. Size changes by 1 with the arrow keys or mouse wheel, and by 10 with `Shift`.

Board-wide heading and body fonts for new objects are set in **Board settings** in the board menu.

## Drawing, frames and icons

- **Pen** (`P`): drag to draw freehand. A tray shows colours and three widths while the pen is active.
- **Frame** (`F`): drag to draw a titled area. Objects fully inside a new frame become its children and move with it. Double-click a frame to rename it.
- **Icons**: open the **Icons** drawer and type in **Search icons**. Search covers all icon sets, or the one you choose in the set list (**All icon sets** by default), and matches names, aliases and categories. Click an icon to add it or drag it onto the board. Each click places the icon 24 pixels right and down from the previous click's icon, so they do not land on top of each other, and the steps start again at the centre of the view after you move the view a step away or move or delete the last icon placed. Change its colour with the properties panel.
- **Offline icons**: with **All icon sets** selected, the row **Popular icon sets (N)** has **Download for offline**. With one set selected, the row shows that set's name instead. Downloaded sets search and preview without a connection; **Update** and **Remove** work as they do for stickers (see [Stickers](stickers.md#offline)). Icons already on the board stay there.
- **Online sets**: this button in the Icons drawer loads more sets from Iconify. Those sets cannot be downloaded, need a connection, and each search sends your query to Iconify.
- **UML**: the **UML** drawer holds classes, actors, lifelines and other UML elements, and the relationship connectors. See [Connectors](connectors.md#uml-relationships).
- **Import Mermaid**: see [Export and import](export-import.md#importing-mermaid).

For emoji, see [Stickers](stickers.md).

## The quick-action bar

Select something and a small bar appears above it (below, if above would cover a connector). It shows only the controls that apply.

![The quick-action bar above a selected ellipse](images/quick-actions.png)

- **Colour**: sticky note colour.
- **Shape**: change the shape kind.
- **Fill** and **Line**: fill and outline colours.
- **Route**: for connectors, **Straight**, **Elbow** or **Curved**.
- **Text**: alignment and text colour.
- **Align**: with two or more objects selected, align edges and centres. With three or more, you can also distribute horizontally or vertically.
- **React with a sticker**: see [Stickers](stickers.md#reactions).
- **Lock** / **Unlock**.
- **Duplicate** (`Ctrl+D`, `Cmd+D` on Mac).
- **Delete** (`Del`).
- **More properties**: opens the properties panel.

## The properties panel

**More properties** opens a panel on the side titled with the object type. Depending on the selection it offers: shape or class kind, fill, line colour, **Width** (1 to 6 px), **Style** (solid, dashed, dotted), font, size, weight, alignment, text colour, **Opacity**, align and distribute, bring to front (`]`), send to back (`[`) (with several items selected they keep their order among themselves), duplicate, lock, **Copy as Mermaid**, and delete. If several objects are selected and differ, a field shows as mixed until you set it.

## Selecting, moving and grouping

- Click to select. `Shift`+click adds or removes an item. Drag on empty canvas to select with a box.
- `Ctrl+A` selects everything that is not locked.
- Drag to move. Arrow keys nudge by 1; with `Shift`, by one grid step.
- Hold `Alt` while dragging to ignore the grid and [smart guides](smart-guides.md).
- Alignment lines and equal-spacing brackets appear while you move or resize; see [Smart guides](smart-guides.md).
- `Shift` while resizing keeps proportions.
- Copy and paste with `Ctrl+C` and `Ctrl+V`. Pasting plain text creates one sticky note per line (up to 50).

There is no separate group command. To keep objects together, put them in a **Frame**: moving the frame moves what is inside it.

## Locking

Lock an item to stop it getting in the way.

1. Select it and click **Lock** in the quick-action bar.
2. The selection clears. A message says "Locked. Long-press to unlock."

![The small lock badge on a locked ellipse](images/locked-badge.png)

Locked items behave as background: clicks and box selection pass over them, **Select All** skips them, and you cannot edit them or attach connectors to them. Hovering one shows a small lock badge.

To unlock, press and hold on the item for 0.6 seconds. A ring fills, then the item unlocks and is selected. Dot voting still works on locked notes.

## Dot voting

The **Start a dot vote (no limit)** button on the rail starts a vote. Click a note to add your dot; `Shift`+click removes one. A bar at the bottom lets you set dots per person. Details are in [Sessions](sessions.md).

## Related

- [Connectors](connectors.md)
- [Stickers](stickers.md)
- [Comments](comments.md)
- [Export and import](export-import.md)
