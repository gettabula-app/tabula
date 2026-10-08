# Connectors

Connectors are lines that join shapes and stay attached when you move them. They can have arrowheads, a label, and one of three routing styles.

## Draw a connector

There are three ways:

1. **Connector tool.** Press `L` (or `X`), or click **Connector**. Drag from one shape to another. Release on a shape to attach the end to it, or on empty canvas to leave the end free. The tool then switches back to **Select**.
2. **Connection dots.** With **Select** active, hover a shape. Blue dots appear on its four sides. Drag from a dot to another shape or to empty canvas.
3. **Click a dot.** Click a dot without dragging. See below.

Connectors attach to shapes, sticky notes, text, icons and UML elements. They do not attach to frames or drawings, and not to locked items.

<!-- screenshot: a shape hovered with its four connection dots visible, and a connector being dragged to a second shape -->

## Click a connection dot

Clicking a dot is a fast way to build a diagram.

- If another shape sits next to this one in that direction, a connector is added to it. If they are already connected, that shape is only selected.
- If there is nothing there, Tabula creates a copy of the shape on that side, connects it, and starts text editing so you can type its label. The copy goes just beyond the shape. If other shapes are in that spot, it moves further along the same direction to the nearest free space instead of landing on top of them.

Undo (`Ctrl+Z`, `Cmd+Z` on Mac) reverses it in one step.

## Routing styles

Select a connector. In the quick-action bar choose **Route**:

- **Straight**
- **Elbow** (right-angle bends). This is the default.
- **Curved**

The same choice is in the properties panel. Your last choice becomes the default for the next connectors you draw.

## Line style and colour

In the properties panel, a connector has **Line** colour, **Width** (1 to 6 px) and **Style** (solid, dashed, dotted).

## Arrowheads

Open **More properties** and set **Start** and **End** arrowheads. The options are None, Arrow, Open arrow, Hollow triangle, Filled diamond, Hollow diamond, Circle, Bar, and Crow's foot (many or one). New connectors start with no head at the start and an arrow at the end. **Reverse direction** swaps the two ends.

## Labels

Double-click a connector, or select it and press `Enter`, then type. Press `Enter` or `Esc` to finish. You can also type in the **Label** field of the properties panel. Clear the text to remove the label.

## Move or reconnect an end

Select a connector. A round handle appears on each end. Drag a handle onto another shape to reattach it, or onto empty canvas to leave it free. Moving a shape moves the attached ends with it.

If you delete a shape, connectors attached to it stay on the board with that end left free where it was.

## Several connectors on one side

When more than one connector meets the same side of a shape, their ends spread out along that side, ordered by where each connector goes, instead of piling up at the middle. The ends sit evenly either side of the middle, no further than 28 units apart, on the shape's outline. A single connector stays at the middle. Shapes with a curved or irregular outline (heart, cloud, round speech bubble, document, delay and display) keep every connector at the middle. Exports and template thumbnails show the same layout.

## UML relationships

The **UML** drawer lists relationships under **Relationships**: association, directed association, generalization, realization, dependency, aggregation, composition, sync message, async message, reply, include, extend and transition. Pick one, then drag from one element to another. Each sets the right arrowheads and line style.

To change an existing connector, select it, open **More properties** and use **UML relationship**. Choose **None** to go back to a plain connector. Changing an arrowhead by hand also clears the relationship.

## Related

- [Shapes, text and sticky notes](shapes-text-notes.md)
- [Export and import](export-import.md#copy-as-mermaid)
