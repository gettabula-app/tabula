# Changelog

All notable changes to Driftboard are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- 16 new shapes: pentagon, cross, heart, cloud, right/left/double arrows, chevron, pentagon arrow, speech box, speech bubble, delay, merge, off-page connector, manual operation and display. Shapes are now grouped as Basic, Arrows, Callouts and Flowchart.
- Vertical text alignment (top, middle, bottom) for shapes and sticky notes, stored per object so it syncs.
- Locked items show a small lock badge when you hover them.

### Changed
- Locked items are click-through background: clicks and marquee selection pass over them, Select All skips them, and they can't be edited or used as connector targets. Press and hold for 0.6 seconds to unlock one. Dot voting still works on locked notes.
- Locking an item clears the selection.
- Connector anchors and hover dots now sit on a shape's outline instead of its bounding box, so connectors meet triangles, stars, arrows and the like at the visible edge.
- The default size of a new triangle is now square, like the other symmetric shapes.

### Fixed
- Text in shapes and sticky notes no longer sits at the top while you type and jumps to the centre when you finish. The editor now uses the same box, auto-shrink and layout as the renderer. Use-case, state, lifeline and component elements still use the old editor centring.
