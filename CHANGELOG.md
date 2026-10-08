# Changelog

All notable changes to Mira are documented here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Toolbars and panels get a hairline outline on the non-default themes so they stay visible on dark canvases.
- App themes: Default, Ayu, Kanagawa, Matrix and Evergreen. Pick one under Appearance in the board menu; the choice is remembered on this device and applied before the page paints. Every text and accent colour pair meets WCAG AA contrast (checked in tests).
- One Shapes button on the left toolbar opens a shapes-only panel with search; click a shape to draw it or drag it onto the board. Sticky notes keep their own toolbar button (the Rectangle and Ellipse buttons are gone; the R, O and D shortcuts still work).
- Quick-action bar above a selected item: colour, shape, fill, line, route, text, align, lock, duplicate and delete. More opens the full properties panel.
- 16 new shapes: pentagon, cross, heart, cloud, right/left/double arrows, chevron, pentagon arrow, speech box, speech bubble, delay, merge, off-page connector, manual operation and display. Shapes are now grouped as Basic, Arrows, Callouts and Flowchart.
- Vertical text alignment (top, middle, bottom) for shapes and sticky notes, stored per object so it syncs.
- Locked items show a small lock badge when you hover them.
- Screenshots of the shapes panel, quick-action bar, text options and lock badge in `docs/images/`, shown in the README.
- GitHub Actions CI: lint, typecheck and `npm audit` on Linux; tests and production build on a Linux/macOS/Windows × Node 22/24 matrix with npm caching; Docker image build with GitHub Actions layer cache, pushed to GHCR on `main` and `v*` tags; a single `CI passed` gate job for branch protection.
- Superseded runs are cancelled per branch/PR so rapid consecutive pushes only build the latest commit; docs-only pushes to `main` skip CI.
- CodeQL analysis (push, PR, weekly), dependency review on PRs, and Dependabot for npm, GitHub Actions and Docker.
- `npm run lint` using oxlint (`.oxlintrc.json`). typescript-eslint does not yet support TypeScript 7.
- `.gitattributes` normalising line endings to LF so Windows checkouts match.

### Changed
- The app is now called Mira (it was called Driftboard in the interface and documentation). Saved boards, settings and old .drift files keep working: only user-visible text changed.
- Text, drawings, icons, connectors and frame titles drawn on the canvas now follow the theme's ink colour, and exports (SVG and PNG) always use the light default colours on white.
- The properties panel is hidden until you press More in the quick-action bar, and has a close button. Its Shape list is grouped.
- Locked items are click-through background: clicks and marquee selection pass over them, Select All skips them, and they can't be edited or used as connector targets. Press and hold for 0.6 seconds to unlock one. Dot voting still works on locked notes.
- Locking an item clears the selection.
- Connector anchors and hover dots now sit on a shape's outline instead of its bounding box, so connectors meet triangles, stars, arrows and the like at the visible edge.
- The default size of a new triangle is now square, like the other symmetric shapes.
- Minimum Node version is now 22.12, which vitest 5 requires.
- Rewrote ternary/short-circuit expression statements in `src/app.ts` as `if` statements and simplified small lint findings in `src/mermaid.ts`, `src/markup.ts` and `test/core.test.ts`, with no change in behaviour.

### Fixed
- Labels in the board menu were right-aligned next to their icons; they are now left-aligned.
- A locked item that overlaps an unlocked one can now be unlocked with a long press; double-clicking a locked item no longer creates a stray text box; arrow-key nudging a frame no longer moves its locked children; an item locked by a collaborator is dropped from your selection.
- Text boxes in shapes and sticky notes no longer collapse to a negative size when resized very small, and quick-action popovers close when you zoom or pan instead of floating in place.
- Quick-action popovers open away from the selected item instead of over it.
- The arrow in select boxes sat too close to the right edge; it now has the same 10 px padding as the text.
- Text in shapes and sticky notes no longer sits at the top while you type and jumps to the centre when you finish. The editor now uses the same box, auto-shrink and layout as the renderer. Use-case, state, lifeline and component elements still use the old editor centring.

### Removed
- `pnpm-lock.yaml`; npm (`package-lock.json`) is the single package manager, matching the Dockerfile.
