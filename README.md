# Driftboard

A local-first infinite whiteboard: sticky notes, shapes on a snapping grid, connectors that stay attached, UML, Fontshare typography, Iconify icons, and facilitated team exercises with timers, private writing and dot voting.

Every board lives in your browser first (IndexedDB). A small relay syncs boards between people in real time when it is reachable; without it, everything still works and merges later.

## Run it

Requires Node 22.12 or newer.

```bash
npm install
npm run build
npm start            # app + sync relay on http://localhost:8787
```

Open http://localhost:8787, create a board, and share its URL. Anyone who can reach the same relay (for example `http://<your-ip>:8787/#/b/<board-id>` on your network) edits with you live: cursors, selections, presence and changes all sync.

Development, with hot reload (Vite on :5173 proxies `/sync` to the relay on :8787):

```bash
npm run dev
```

Docker:

```bash
docker build -t driftboard .
docker run -p 8787:8787 -v driftboard-data:/data driftboard
```

### Relay settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `./data` | Where each room's document is stored (`<board-id>.yjs`) |
| `DIST_DIR` | `./dist` | Built app to serve |
| `QUIET` | unset | `1` silences logs |

The relay speaks the standard y-websocket protocol at `ws://host:PORT/sync/<boardId>`. In the app, **Menu → Board settings → Relay** accepts `auto` (the server that served the app), `off` (this device only), or any `wss://…/sync` URL.

## What works today

| Spec area | Implemented |
| --- | --- |
| Local-first storage | Yjs document per board, persisted to IndexedDB; offline editing, reload while offline, merge on reconnect; per-user undo/redo that never reverts collaborators' work |
| Sync | Relay with rooms, on-disk persistence, catch-up for late joiners, presence (named cursors, remote selections, participant list, follow a person), cross-tab sync |
| Infinite canvas | Pan (space/middle-drag/trackpad/hand), zoom 2%–3200% around the pointer, pinch zoom, fit (Shift+1/2/0), minimap, viewport culling |
| Grid | Dots, lines (with major lines), isometric, none; adaptive density; snap to grid, alignment guides to nearby objects, Alt to bypass |
| Geometry | 15 shapes incl. flowchart set, sticky notes with a folded corner (8 colours plus any custom colour, auto-shrinking text, ink switches to white on dark notes), text, frames (nested, carry their contents), freehand pen; resize, rotate (Shift snaps 15°), align, distribute, z-order, lock, duplicate, copy/paste (also plain text → stickies) |
| Sticky colours | Pick a colour before placing (tray beside the toolbar while the sticky tool is on), recolour selected notes, or choose any colour with “+”; custom colours are saved to the board (up to 12) and shared with everyone; your last colour is remembered on your device |
| Connectors | Bound or free ends, straight/elbow/curved routing, 10 arrowheads incl. UML and crow's foot, labels, reverse; drag from a shape's blue dots, or click a dot to add a connected copy; deleting a shape keeps its lines |
| UML | Class/interface/abstract/enum (edited as text: name, `--`, members), actor, use case, lifeline, state, initial/final, package, component, note; 13 relationship presets; Mermaid import (flowchart, classDiagram, stateDiagram-v2, sequenceDiagram) with auto-layout; copy selection as Mermaid |
| Fontshare | Full catalogue (100 families), searchable picker with live previews, weights per family, board heading/body fonts, offline caching via the service worker |
| Iconify | Search 200k+ icons, filter by set, licence notice for CC BY sets, failover to backup hosts; placed icons store their SVG (sanitised) and render offline |
| Team exercises | 14 templates (Start/Stop/Continue, 4Ls, Mad/Sad/Glad, Sailboat, Crazy 8s, Brainstorm + affinity map, Lean Coffee, Impact/Effort, MoSCoW, story map, journey map, empathy map, SWOT, pre-mortem); session bar with steps, shared timer with chime, private writing + reveal, bring everyone to my view, step editor, Markdown summary |
| Dot voting | One-click dot vote from the toolbar on any board (no template needed); dots per person can be any number or unlimited, set per step or changed live for everyone mid-vote, with the number of people on the board and dots placed so far shown alongside; click to add a dot, shift-click to remove; totals hidden until reveal; many dots on one note collapse into a counted badge; results stay on the board after the vote until cleared, with ranked results to copy |
| Import/export | `.drift` (zip of readable `board.json` + full CRDT history), JSON, SVG, PNG (2×, real fonts), Markdown summary, Mermaid; drop files on the board or open them from the home screen |

### Not built yet (from the spec)

End-to-end encryption, enforced roles, comments, version history, the Tauri desktop app, PDF export, groups, tables, images, boolean shape operations, obstacle-avoiding routing and line jumps, character-level text merging (`Y.Text`), Miro/Excalidraw import, downloadable offline icon sets, and peer-to-peer (WebRTC) sync.

## Fonts and icons

Fontshare fonts are free for personal and commercial use under ITF's Free Font License, which restricts redistributing or serving the font files. Driftboard therefore loads fonts only from Fontshare's own servers, caches them in the user's browser for offline use, and stores boards with font names, never font files. The relay never serves fonts. PNG export inlines the fonts temporarily inside the browser to rasterise text; only pixels leave the device.

Iconify icon sets carry their own licences (MIT, Apache 2.0, CC BY 4.0, …). The icon picker shows each set's licence and flags sets that require attribution.

## Tests and checks

```bash
npm test             # vitest
npm run lint         # oxlint
npm run typecheck    # tsc --noEmit
```

Covers CRDT merging of concurrent and offline edits, undo scope, ordering, connector routing, rotated hit-testing, UML text round-trips, Mermaid import/export, markup escaping and XML validity, icon sanitising, the Fontshare catalogue format, and the relay end to end (two clients syncing, offline merge on reconnect, persistence across restarts, invalid room names).

## CI/CD

GitHub Actions (`.github/workflows/`):

- **CI** runs on pushes to `main`, `v*` tags, pull requests and manual dispatch. Lint, typecheck and `npm audit` run once on Linux. Tests and the production build run on Linux, macOS and Windows with Node 22 and 24. The Docker image then builds with layer caching and is pushed to `ghcr.io/saldestechnology/mira` on pushes to `main` and on tags. Use the `CI passed` job as the single required check for branch protection.
- **CodeQL** scans the code on pushes, PRs and weekly. **Dependency review** blocks PRs that add dependencies with high-severity advisories.
- A newer push to the same branch or PR cancels the run in progress, so a burst of commits only builds the last one. Docs-only pushes to `main` skip CI.
- Dependabot opens grouped weekly updates for npm, Actions and the Docker base image.

## Project layout

```
server/relay.mjs     sync relay + static server
src/store.ts         Y.Doc wrapper: objects, meta, flow, votes, undo
src/sync.ts          IndexedDB persistence, relay connection, identity, board list
src/geometry.ts      bounds, hit-testing, anchors, connector routing
src/markup.ts        SVG for every object type (live render and export)
src/render.ts        camera, grid, culling, overlay (selection, handles, guides, votes)
src/app.ts           tools, selection, drag/resize/rotate, snapping, clipboard, presence
src/editor.ts        in-place text editing
src/flow.ts          facilitation: steps, timer, private writing, voting
src/templates.ts     team exercise templates
src/uml.ts, src/mermaid.ts, src/fonts.ts, src/icons.ts, src/exporters.ts
src/ui/              rail, library drawer, properties, font picker, session bar, home
public/sw.js         offline cache for the app, Fontshare and Iconify
```
