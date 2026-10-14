# Tracker on a board

If your workspace has the tracker, you can put it on a board as a live list of tickets. You pan and zoom to it like any frame, and you work in it right where it sits: look at tickets, open one, create one, or drag a ticket to another state. One key or one click opens it full screen when you want more room.

The tracker is the same list of tickets wherever you see it. A change in the board's tracker shows in full screen and the other way round.

## Put a tracker on a board

Choose **Tracker** in the left toolbar. The tracker appears in the middle of what you see and is selected. If your toolbar has no **Tracker** button, your workspace does not have the tracker, or you are only viewing the board. You can add more than one tracker to a board; they all show the same tickets.

## Live and snapshot

A tracker is **live** when you can use it in place, and a **snapshot** when it is only a picture of it.

| It is | When |
|---|---|
| **Live** | The board is at 40 % zoom or more, the tracker is at least 240 pixels tall on your screen, it is one of the three live trackers on the board, and you are not on a phone. Clicks, typing and scrolling work inside it. |
| **Snapshot** | The board is zoomed out below 40 %, the tracker is small or off screen, there are already three live trackers, or you are on a phone. It behaves like any object: you can drag it, and double-clicking it makes it live when it fits. |

Only three trackers on a board are live at once. The one you selected comes first, then the one under the pointer, then the one with the most of itself in view. The others show as snapshots until you select or zoom to them.

A snapshot shows the tracker's name and how many tickets are open. A tracker whose tickets have not loaded yet says "Zoom in or select this tracker to load its tickets." A snapshot that is not live has an **Open** chip when you select it or point at it, so there is always a way in. On a phone the tracker is always a snapshot card with an **Open** chip, and tapping it opens the tracker full screen.

## Work in the tracker

At the top of a live tracker you find:

- **All**, **My** and **Board**: **All** lists every ticket grouped by state, **My** lists the tickets assigned to you, and **Board** shows the states as lanes.
- **+ New ticket** (a plain **+** in a narrow tracker). It is not there if you cannot create tickets.
- The **expand** icon, **Open full screen**.
- The **⋯** menu. It holds **Copy link** and, when your workspace has saved views, the **Views** menu to switch between them. In a narrow tracker the switch also moves into this menu.

Click a ticket to open it. In a wide tracker (about 720 board units or more) the ticket opens as a panel beside the list, so the list stays visible. In a narrower one the ticket replaces the list, with a **Back** button. Press `Esc` to close the ticket; focus goes back to the ticket's row in the list. Press `Esc` again to leave the tracker and give the keys back to the board; the tracker stays selected.

Keys you press inside the tracker belong to the tracker and do not act on the board: Backspace or Delete on a ticket does not delete the tracker, and a letter does not change the board's tool.

Each row in the list shows the ticket's priority, labels, project, milestone and estimate. The list's shortcuts (for example `S`, `A`, `P`, `X`, `J` and `K`) work on the row you are on, also when `Tab` has put focus on a button inside the row. Only `Enter` and `Space` stay with the button, and focus stays on it after the list redraws.

### The Board view

**Board** shows the states as lanes side by side, with the number of tickets in each. Drag a ticket from one lane to another to change its state. Press `Esc` before you let go to cancel the drag. Each lane has a **+** to create a ticket in that state. Each card has a **⋯** menu that opens a list of states to move it to, which is also the way to change a state with the keyboard.

When you move a ticket, a message "State changed" appears with **Undo**; choose **Undo** to put the ticket back in its old state.

### Open it full screen

**Open full screen** replaces the board with the tracker. It is the same tracker with the same tab and open ticket. Choose **Back to board** or use the browser's Back button to return; the board is where you left it, with the tracker selected.

## Who can do what

- If you can only view the board, you can read the tracker and open tickets, but you cannot create tickets or move them.
- If you do not have access to the tracker, the element says "You do not have access to the tracker" and shows no buttons.
- A tracker with no tickets says "No tickets yet" and offers **+ New ticket**.
- If the tickets cannot be loaded, the tracker says "Could not load tickets" with a **Retry** button.

Your tab, filter and open ticket are yours: other people looking at the same tracker keep their own.

## Related

- [Boards and the home screen](boards.md)
- [Kanban boards](kanban.md): a kanban on a board can be linked to a tracker.
- [Keyboard and screen readers](accessibility.md)
