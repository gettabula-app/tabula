# Getting started

Tabula is a collaborative whiteboard. You place sticky notes, shapes, text and drawings on an unlimited canvas, and everyone who has the board open sees changes as they happen. This page covers the basics: opening a board, finding your way around, and the keyboard shortcuts.

## Open the app

Open the address of your Tabula server in a browser. You land on the **Boards** page, which lists your boards.

If your workspace uses sign-in, you first see **Sign in to Tabula**. Enter your work email, choose **Email me a link**, and open the link in the email. A page says **Joining as** your email; select **Continue to Tabula** to finish signing in. The link works once and expires after 15 minutes. After you sign in, you land on **Boards**. Without sign-in (open mode), nobody asks who you are: the page opens straight to your boards.

## Create your first board

1. On the **Boards** page, choose **New board**, then **Blank board**.
2. The empty board shows a hint. Press `N` for a sticky note, `R` for a rectangle, or double-click the canvas to write text.
3. Click the board name at the top left and type a name. Press `Enter` to save it.

To start with a ready-made layout instead, choose **Start from a template**. See [Templates](templates.md).

![A new empty board with the first-run hint, the left toolbar, the board name and sync status at the top left, and the share and menu buttons at the top right](images/getting-started-board.png)

## The screen

- **Top left.** The **All boards** button (house icon) returns to the Boards page. Next to it are the board name and the sync status. A **View only** or **Can comment** badge appears here when you cannot edit the board.
- **Top right.** The people on the board (round avatars in one row, as many as fit; a **+N** badge counts the rest), the comments button, **Share**, and the **Menu** button (three dots).
- **On a phone** (a screen up to 480 px wide) both bars share one row. On the left are the house, a shortened board name and the sync dot. On the right are a people chip (hidden while you are alone and no [AI tool](ai-tools.md#seeing-an-agent-at-work) is at work; otherwise it shows up to two avatars and a **+N** count that includes tools at work, and tapping it lists everyone), the comments button with its unread badge, **Share** as an icon, and the **Menu** button. On a screen narrower than 380 px, **Chat** moves into the **Menu**, and a small dot on the **Menu** button tells you that chat has unread messages.
- **Left toolbar.** The tools, listed below.
- **Bottom right.** Zoom out, the zoom level, zoom in, **Fit board**, and a minimap toggle.
- **Bottom.** The session bar for facilitated sessions. See [Sessions and focus requests](sessions.md).

### Left toolbar

From top to bottom:

- **Select** (`V`) and **Hand** (`H`).
- **Sticky note** (`N`), the **Text**, **Table**, **Code block**, **Markdown block** and **Link** group (Text uses `T`; Table uses `G`, see [Tables](tables.md); Code block is for code with colours, see [Code blocks](code-block.md); Markdown block is for longer notes with headings, lists and tick boxes, see [Markdown blocks](markdown-blocks.md), and has no single-key shortcut; Link opens an address field), **Shapes**, **Connector** (`L`), **Pen** (`P`), **Frame** (`F`) and **Comment** (`C`). **Shapes** opens a panel with a search field. Click a shape to draw it, or drag it onto the board.
- Drawers for **UML**, **Icons**, **Stickers**, and **Templates and team exercises**.
- A dot vote button and a quick poll button.
- **Undo** and **Redo**.

Hover over a button for half a second, or move keyboard focus onto it, to see a tooltip with its name and, where it has one, its shortcut as a key chip; `Esc` closes it. Tooltips do not appear on touch screens. On a board you can only view, only **Select** and **Hand** stay active (and **Comment**, if you are allowed to comment).

### Quick-action bar

Select an item and a small bar appears next to it. Depending on what you selected, it offers colour, shape, fill, line, connector route, text options, alignment (with two or more items), a sticker reaction, lock, duplicate and delete. **More properties** (three dots) opens the full properties panel. See [Shapes, text and sticky notes](shapes-text-notes.md).

### Board menu

The **Menu** button at the top right holds board-level actions, with **Search actions** at the top to find one by name: **User guide** (first in the list), **Board settings**, **Version history**, **Your name and colour**, **Show comments**, imports, the **Appearance** themes, exports, and **Keyboard shortcuts**. If your workspace uses sign-in, an **Account** section comes first, and it includes **Your AI key** when your administrator allows personal keys. See [Boards and the home screen](boards.md).

## Move around

- **Pan.** Hold `Space` and drag, use the **Hand** tool, drag with the middle or right mouse button, or scroll. On a trackpad, two fingers pan.
- **Zoom.** Hold `Ctrl` (`Cmd` on Mac) and scroll, or pinch on a trackpad or touch screen. The buttons at the bottom right zoom in steps. Click the percentage to return to 100%. Pinching over a text box you are editing zooms the board too, and `Ctrl+0` (`Cmd+0` on Mac) resets the board to 100% while the focus is on the board; a notice says when the page itself is zoomed.
- **Fit.** **Fit board** (`Shift+1`) shows everything on the board. `Shift+2` fits your selection. When you open a board on a phone, the first view already fits the board between the tool bar and the right edge, once its content has loaded; if you move or zoom first, it leaves your view alone.
- **Minimap.** The map button at the bottom right shows a small overview. Click or drag in it to jump.
- **Go to a person.** Click someone's avatar at the top right to jump to where they are working.

## Select, move, resize

- Click an item to select it. `Shift`+click adds or removes items from the selection.
- Drag on empty canvas to draw a selection box. Hold `Shift` to add to the current selection.
- `Ctrl+A` (`Cmd+A` on Mac) selects everything that is not locked.
- Drag a selected item to move it. Arrow keys nudge by one pixel. `Shift`+arrow moves by one grid step.
- Drag a handle to resize. Hold `Shift` to keep the proportions. Drag the rotate handle to turn an item. `Shift` snaps the turn to 15 degree steps.
- Hold `Alt` while dragging to ignore snapping to the grid.
- Press `Enter` on a single selected item, or double-click it, to edit its text. Double-click empty canvas to add a text box.
- Press `Esc` to deselect and return to the **Select** tool.

## Undo and redo

Press `Ctrl+Z` (`Cmd+Z` on Mac) to undo and `Shift+Ctrl+Z` or `Ctrl+Y` to redo, or use the buttons at the bottom of the left toolbar.

## Saving and sync

Tabula saves every change on your device as you work. You do not press save, and a board keeps working without a network connection.

When a sync server is reachable, changes reach the other people on the board live. The sync status next to the board name is a dot. Its shape tells you the state, and its words show when you hover over it or put keyboard focus on it; screen readers read the words out when the state changes.

| Shape and status | Meaning |
|---|---|
| Dot: **Live** / **Live with 2** | Connected. Changes sync in real time, and the number is how many others are here. |
| Ring: **Saved on this device** | Everything is saved locally. Tabula is waiting to connect and will sync when it can. |
| Ring with a dot in the centre: **Restoring…** | The workspace is being restored from a backup. Your changes are saved on this device. |
| Bar: **Local only** | Sync is off. The board exists only in this browser. |
| Triangle: **Sign in needed** / **No access** | The server refused the connection. Your changes stay on your device. |

Choose **Share** to see and copy the board link. The sync status does not open it. In open mode, anyone with the link can edit with you and does not need an account. If your workspace uses sign-in, only people with access to the board can open the link. See [Sharing, roles and teams](sharing.md).

Clearing your browser data removes boards that were never synced. Export important boards from the board menu. See [Export and import](export-import.md).

## Your name and colour

Your name and colour appear next to your cursor and on the notes you write. Click your own avatar, or choose **Your name and colour** in the board menu, then pick a name and a colour and choose **Save**. If your workspace uses sign-in, the name is your account name and is saved to the server. The colour stays on this device. Your avatar shows the first letter of your name; if your name starts with an emoji, the whole emoji is the initial, the same for everyone who sees it.

## Keyboard shortcuts

On Mac, use `Cmd` where the table says `Ctrl`. The board menu lists every shortcut under **Keyboard shortcuts**.

### Tools

| Key | Action |
|---|---|
| `V` | Select |
| `H` | Hand (pan) |
| `N` or `S` | Sticky note |
| `T` | Text |
| `R` | Rectangle |
| `O` | Ellipse |
| `D` | Diamond |
| `L` or `X` | Connector |
| `P` | Pen |
| `F` | Frame |
| `C` | Comment |
| `Esc` | Deselect and return to Select |

### Selection and editing

| Key | Action |
|---|---|
| `Ctrl+A` | Select all (skips locked items) |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy, cut, paste |
| `Ctrl+D` | Duplicate |
| `Delete` or `Backspace` | Delete the selection |
| `Enter` | Edit text of the selected item |
| Arrow keys | Nudge by 1 pixel |
| `Shift`+arrow keys | Nudge by one grid step |
| `]` | Bring to front |
| `Ctrl+]` | Bring forward one step (`Cmd+]` on Mac) |
| `Ctrl+[` | Send backward one step (`Cmd+[` on Mac) |
| `[` | Send to back |
| `Shift+H` | Flip the selection horizontally |
| `Shift+V` | Flip the selection vertically |
| `Ctrl+Z` | Undo |
| `Shift+Ctrl+Z` or `Ctrl+Y` | Redo |

### View

| Key | Action |
|---|---|
| `Space` + drag | Pan |
| `Ctrl` + scroll | Zoom |
| `Ctrl+=` / `Ctrl+-` | Zoom in / out |
| `Shift+1` | Fit board |
| `Shift+2` | Fit selection |
| `Shift+0` | Reset zoom to 100% |

### While dragging

| Modifier | Effect |
|---|---|
| `Alt` | Ignore the grid and smart guides |
| `Shift` while resizing | Keep proportions |
| `Shift` while rotating | Snap to 15 degrees |
| `Shift`+click | Add to or remove from the selection; during a dot vote, remove a dot |

Shortcuts do not fire while you type in a text field. On a view-only board, only `V`, `H` and `C` (if you may comment) switch tools.

## Related

- [Boards and the home screen](boards.md)
- [Shapes, text and sticky notes](shapes-text-notes.md)
- [Templates](templates.md)
- [Themes](themes.md)
