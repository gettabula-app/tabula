# Smart guides

Smart guides show how the object you are moving or resizing lines up with the objects around it. They also snap it into place, so edges and centres align and gaps between objects come out equal.

## What you see

- **Alignment lines.** A thin line appears between the objects that line up, from the moving object to the farthest aligned object. It is drawn only between the objects, not across the whole view.
- **Equal spacing.** When the gap to a neighbour matches a gap elsewhere in the same row or column, or the object sits exactly midway between two neighbours, a bracket appears over each equal gap with its distance on it.
- **Equal size.** While resizing, a width or height can snap to the same dimension as another object. Brackets mark the resized object and up to three nearest matches, with an `=` before the rounded size.

## When they appear

Guides show while you move an object and while you resize it. A multi-selection moves as one block. A selection of connectors alone shows no guides.

When you resize a free edge, only the edge you are dragging snaps and the opposite edge stays where it is. From a corner with proportions locked, the nearer horizontal or vertical match wins; the other edge follows the ratio and the opposite corner stays fixed. This works for **Shift**-resized corners and for images, icons and UML actors. Resizing a rotated object shows no guides.

## How close you need to be

An object snaps when an edge or centre is within about 6 screen pixels of a matching line or gap. The distance stays the same when you zoom in or out.

Alignment and equal spacing take priority over the grid. If an alignment or spacing match is in range, the object snaps to it even when that position is off the grid. Equal spacing gets a head start: it wins unless an alignment is more than 2 screen pixels closer.

## Turn guides off for one drag

Hold `Alt` while you drag. This turns off guides and grid snapping for that drag only. On Mac, hold Option.

## The Snap to grid setting

The **Snap to grid** setting in **Board settings** controls only grid snapping. Guides work whether that setting is on or off, and when the grid is set to none.

## Hidden notes

Notes that are hidden during a session's private writing step are never guide targets. A guide does not reveal where a hidden note sits. See [Sessions and focus requests](sessions.md).

## Colour

Guide lines and gap brackets use the guide colour of the current theme, so they stay readable in every theme. See [Themes](themes.md).

## Related

- [Getting started](getting-started.md): moving, resizing and the grid.
- [Shapes, text and sticky notes](shapes-text-notes.md)
- [Themes](themes.md)
