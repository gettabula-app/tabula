# Kanban boards

A kanban board is a set of columns, called lanes, with cards in them. You drag a card from one lane to another as the work moves along. It sits on the canvas like any other object.

## Add a kanban

1. Open the **Shapes** panel and select **Kanban** under **Boards**. You can also type "kanban" in **Search shapes**.
2. Click on the board to place it, or drag to set its size.

You get three lanes, **To do**, **Doing** and **Done**, and the first lane opens **+ Add card** so you can type the first card at once.

If you can only view a board, you cannot add one.

## Add cards

- Select **+ Add card** at the bottom of a lane, or double-click empty space in a lane.
- Type a title. `Enter` adds the card and starts the next one. `Esc` stops.

A card shows its title (up to three lines) and, once they are set, label chips, a due date, a comment count and its owner. Deleting a card works like deleting any other object.

## Move cards

- **Drag a card** to another place in its lane, to another lane, or into an empty lane (it says **Drop here**). A line shows where it will land. Nothing changes until you let go, and the whole move is one step in Undo.
- **With the keyboard**, select a card and press `Alt` with an arrow key: up or down moves it within its lane, left or right moves it to the next lane. A ring and the word "Moving" show it, and a screen reader hears where it went, for example "Moved to Doing, position 2 of 5".
- Drop a card away from the kanban and it becomes a loose card on the board.
- Viewers and commenters can look but cannot drag cards.

## Lanes and the whole kanban

- Each lane shows how many cards it holds. If a limit is set, it shows for example `3 / 3`, with a red mark when the lane is full.
- Click a card, a lane or the container to select it.
- Deleting a lane moves its cards to the lane on its left, or on its right for the first lane. Deleting the whole kanban deletes its lanes and cards.
- When you zoom far out, card titles become bars and lane headers keep only their names.

## Older versions

A board that contains a kanban opens read only in a Tabula version that does not know kanban boards yet, with a banner that says so. Reload the page to get the current version.

## Not yet

Editing a card's details (description, owner, due date, labels), the lane menu, work-in-progress limits that block drops, and filters are coming. Until then cards have a title only.

## Related

- [Shapes, text and sticky notes](shapes-text-notes.md)
- [Comments](comments.md)
