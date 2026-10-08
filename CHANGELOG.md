# Changelog

All notable changes to Mira are documented here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `npm run dev:accounts` runs the dev server in accounts mode (sign-in links printed to the console).
- `MIRA_MAIL_WEBHOOK_TOKEN`: sent as a bearer token with each mail webhook request, so a hosted mail relay can authenticate the instance.
- Email through your own SMTP server (`MIRA_MAIL=smtp`, `MIRA_SMTP_URL`, `MIRA_MAIL_FROM`) for sign-in links; webhook and outbox payloads now also carry the kind of email (`template`, `params`). The relay reads a `.env` file at startup, and `.env` files are gitignored.
- Comments: threaded comments pinned to a place or an object (C key or the speech-bubble tool), with reply, edit, delete, resolve/reopen, a Comments panel, a show/hide toggle in the board menu and a count badge. Pins follow their object through move, resize and rotate, are hidden for notes that private writing hides, and are left out of image exports. See `docs/comments.md`.
- Commenter role for shared boards (accounts mode): can read and comment but not edit; viewers can read comments.
- Comments data layer: each board has a sibling comments document (synced in its own room, persisted offline, included in .drift and JSON exports); the UI follows.
- Board role `commenter`: can read the board and write its comments, but not edit it (server side; the comments feature itself follows).
- Accounts and teams mode (opt-in with `MIRA_AUTH=on`): email sign-in links, workspace and team roles, per-board sharing, a server-side HTTP API for all of it, and a relay that checks access on every connection and makes viewers read-only. Open mode is unchanged. See `docs/accounts.md`.
- Sign-in screens, team-based home screen, read-only viewer boards, access banners and an Account section in the board menu for accounts mode.
- CI tests and builds on Node 26 as well as 22 and 24, matching the Docker image's Node 26 base.
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
- Minimum Node version is now 22.13 (built-in SQLite for the upcoming accounts mode).
- Swiss design pass: the Select, Hand and Pen icons are re-centred in their 24 px box; every button now has the same 9 px inset on all sides (22 px icons in the 40 px toolbar buttons, 18 px in 36 px buttons, 16 px in labelled buttons); padding is symmetric on the top-right tray, step list, steps popover, quick-action chip, tiles and the sticky colour tray; the close buttons line up with the title inset; drawers and tool trays keep the same gutter when the toolbar narrows on short screens; the running flow-bar step is 36 px high so its end buttons have even spacing.
- The app is now called Mira (it was called Driftboard in the interface and documentation). Saved boards, settings and old .drift files keep working: only user-visible text changed.
- Text, drawings, icons, connectors and frame titles drawn on the canvas now follow the theme's ink colour, and exports (SVG and PNG) always use the light default colours on white.
- The properties panel is hidden until you press More in the quick-action bar, and has a close button. Its Shape list is grouped.
- Locked items are click-through background: clicks and marquee selection pass over them, Select All skips them, and they can't be edited or used as connector targets. Press and hold for 0.6 seconds to unlock one. Dot voting still works on locked notes.
- Locking an item clears the selection.
- Connector anchors and hover dots now sit on a shape's outline instead of its bounding box, so connectors meet triangles, stars, arrows and the like at the visible edge.
- The default size of a new triangle is now square, like the other symmetric shapes.
- Rewrote ternary/short-circuit expression statements in `src/app.ts` as `if` statements and simplified small lint findings in `src/mermaid.ts`, `src/markup.ts` and `test/core.test.ts`, with no change in behaviour.
- In accounts mode the name in Your name and colour is the account name and is saved to the server; the Share dialog explains who can open a board.

### Fixed
- On the home screen, boards that someone shared with you no longer appear under Personal, and the sign-in card is centred on the page.
- The highlighted option in segmented controls and colour swatches now follows your click. In Board settings the Grid control stayed on Dots after choosing Lines, Isometric or None; the same stale highlight affected the quick-action popovers.
- Labels in the board menu were right-aligned next to their icons; they are now left-aligned.
- A locked item that overlaps an unlocked one can now be unlocked with a long press; double-clicking a locked item no longer creates a stray text box; arrow-key nudging a frame no longer moves its locked children; an item locked by a collaborator is dropped from your selection.
- Text boxes in shapes and sticky notes no longer collapse to a negative size when resized very small, and quick-action popovers close when you zoom or pan instead of floating in place.
- Quick-action popovers open away from the selected item instead of over it.
- The arrow in select boxes sat too close to the right edge; it now has the same 10 px padding as the text.
- Text in shapes and sticky notes no longer sits at the top while you type and jumps to the centre when you finish. The editor now uses the same box, auto-shrink and layout as the renderer. Use-case, state, lifeline and component elements still use the old editor centring.

### Removed
- `pnpm-lock.yaml`; npm (`package-lock.json`) is the single package manager, matching the Dockerfile.
