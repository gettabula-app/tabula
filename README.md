# Tabula

A local-first infinite whiteboard: sticky notes, shapes on a snapping grid, connectors that stay attached, UML, Fontshare typography, Iconify icons, and facilitated team exercises with timers, private writing and dot voting.

Every board lives in your browser first (IndexedDB). A small relay syncs boards between people in real time when it is reachable; without it, everything still works and merges later.

## Run it

Requires Node 22.13 or newer.

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
docker build -t tabula .
docker run -p 8787:8787 -v tabula-data:/data tabula
```

If you ran the old `mira` image, keep mounting your existing volume (`-v mira-data:/data`) so your boards stay.

### Relay settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `./data` | Where each room's document is stored (`<board-id>.yjs`) |
| `DIST_DIR` | `./dist` | Built app to serve |
| `QUIET` | unset | `1` silences logs |

The relay speaks the standard y-websocket protocol at `ws://host:PORT/sync/<boardId>`. In the app, **Menu → Board settings → Relay** accepts `auto` (the server that served the app), `off` (this device only), or any `wss://…/sync` URL.

### Accounts and teams

By default Tabula is open: anyone who can reach the relay and knows a board link can edit it. Set `TABULA_AUTH=on` to switch to **accounts mode**: people sign in with an emailed link, the server keeps members, teams, boards and sharing in a SQLite directory (`<DATA_DIR>/directory.sqlite`), and the relay checks the signed-in person's role on every connection and every update (viewers cannot write). Accounts mode needs Node 22.13 or newer.

Tabula was called Mira before: the old `MIRA_*` names of these variables still work, with a deprecation warning at startup, and the `TABULA_` name wins when both are set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_AUTH` | `off` | `on` turns accounts mode on |
| `TABULA_OWNER_EMAIL` | none | The first person to sign in with this address becomes the workspace owner. Required when `TABULA_AUTH=on` |
| `TABULA_BASE_URL` | `http://localhost:<PORT>` | Public URL, used in emailed links and as the only allowed WebSocket `Origin`. An `https://` URL makes the session cookie `Secure` and `__Host-` prefixed |
| `TABULA_MAIL` | `log` | `log` prints each email to the console, `file` appends JSON lines to `<DATA_DIR>/outbox.jsonl`, `smtp` sends through your own SMTP server (`TABULA_SMTP_URL`), `webhook` POSTs `{to, subject, text, from, template, params}` as JSON to `TABULA_MAIL_WEBHOOK_URL` |
| `TABULA_MAIL_WEBHOOK_URL` | none | Target for `TABULA_MAIL=webhook` |
| `TABULA_MAIL_WEBHOOK_TOKEN` | none | Sent as `Authorization: Bearer <token>` with each webhook request |
| `TABULA_MAIL_FROM` | `Tabula <no-reply@localhost>` | Sender address; required with `smtp`, included in webhook payloads as `from` |
| `TABULA_SMTP_URL` | none | SMTP connection for `TABULA_MAIL=smtp`, for example `smtps://user:password@smtp.example.com:465` (any provider's SMTP credentials work, including Mailgun's) |
| `.env` | none | The relay reads a `.env` file in its working directory at startup (existing environment variables take precedence); the file is gitignored |
| `TABULA_SESSION_DAYS` | `30` | Session lifetime |
| `TABULA_TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy: the client IP for rate limiting is the rightmost `X-Forwarded-For` entry. Leave it off without a proxy, because anyone can forge that header |

### Behind a reverse proxy

Terminate TLS in the proxy and keep these four things true (each is covered by `test/proxy.test.ts`):

1. Set `TABULA_BASE_URL` to the public **https** address. The cookie's `Secure` flag, its `__Host-` name and the allowed WebSocket `Origin` come from that value alone; `X-Forwarded-Proto` is never read.
2. Pass the public `Host` header through unchanged (nginx: `proxy_set_header Host $host;`). The CSRF check compares `Origin` with `Host`, so a proxy that rewrites `Host` makes every state-changing request fail with `403 csrf`.
3. Set `TABULA_TRUST_PROXY=1` (exactly `1`, no other value counts) and have the proxy append the real client address to `X-Forwarded-For`; the rate limiter uses the rightmost entry and ignores anything a client put to its left. Without the variable, `X-Forwarded-For` is ignored and every client of the proxy shares one rate limit.
4. Forward WebSocket upgrades (`Upgrade` and `Connection` headers) for `/sync/*`.

An open WebSocket follows role and access changes (usually at once, otherwise within about 5 seconds) and a session that has run out closes it with code 4401 within about 6 seconds. See `test/live-roles.test.ts`.

Try it locally:

```bash
npm run build
TABULA_AUTH=on TABULA_OWNER_EMAIL=you@example.com npm start
```

Open http://localhost:8787, enter that address, and open the sign-in link that the relay prints to its console. When serving the built app from another origin (for example Vite on :5173 in development), set `TABULA_BASE_URL` to that origin, otherwise sockets are refused.

The full design (roles, the HTTP API, the relay rules and the SQLite schema) is in [docs/accounts.md](docs/accounts.md).

## Screenshots

| Shapes panel | Quick actions |
| --- | --- |
| ![Shapes panel with Basic, Arrows, Callouts and Flowchart groups](docs/images/shapes-panel.png) | ![Quick-action bar above a selected ellipse](docs/images/quick-actions.png) |
| **Text options** | **Locked item** |
| ![Text popover with horizontal and vertical alignment](docs/images/text-options.png) | ![Lock badge shown when hovering a locked item](docs/images/locked-badge.png) |
| **Themes (Matrix, with the picker)** | **Ayu** |
| ![Board menu with the theme picker, Matrix theme active](docs/images/themes-menu-matrix.png) | ![Ayu theme on a board](docs/images/theme-ayu.png) |
| **Accounts: sign in** | **Accounts: home screen with teams** |
| ![Sign-in screen](docs/images/signin.png) | ![Home screen with Personal, Shared with you and On this device](docs/images/teams-home.png) |
| **Accounts: access removed** | |
| ![Banner shown when your access to a board is removed](docs/images/access-removed.png) | |

## What works today

| Spec area | Implemented |
| --- | --- |
| Local-first storage | Yjs document per board, persisted to IndexedDB; offline editing, reload while offline, merge on reconnect; per-user undo/redo that never reverts collaborators' work |
| Sync | Relay with rooms, on-disk persistence, catch-up for late joiners, presence (named cursors, remote selections, participant list, follow a person), cross-tab sync |
| Infinite canvas | Pan (space/middle-drag/trackpad/hand), zoom 2%–3200% around the pointer, pinch zoom, fit (Shift+1/2/0), minimap, viewport culling |
| Grid | Dots, lines (with major lines), isometric, none; adaptive density; snap to grid, alignment guides to nearby objects, Alt to bypass |
| Geometry | 31 shapes in four groups (Basic, Arrows, Callouts, Flowchart), picked from one **Shapes** button on the left toolbar that opens a searchable shapes-only panel (click a shape to draw it, or drag it onto the board); sticky notes (own toolbar button) with a folded corner (8 colours plus any custom colour, auto-shrinking text, ink switches to white on dark notes); text (in shapes and sticky notes: aligned left/centre/right and top/middle/bottom, and it stays where it will render while you type), frames (nested, carry their contents), freehand pen; resize, rotate (Shift snaps 15°), align, distribute, z-order, lock (locked items are click-through background; press and hold 0.6 s to unlock; hovering shows a lock badge), duplicate, copy/paste (also plain text → stickies); click an item for a quick-action bar above it (colour, shape, text, align, lock, duplicate, delete); More opens the full properties panel |
| Themes | Default, Ayu, Kanagawa, Matrix and Evergreen, chosen under Appearance in the board menu; the whole app (canvas, grid, toolbars, and the default colour of text, drawings, icons and connectors) follows the theme; the choice is remembered on this device; exports always use the light colours on white |
| Sticky colours | Pick a colour before placing (tray beside the toolbar while the sticky tool is on), recolour selected notes, or choose any colour with “+”; custom colours are saved to the board (up to 12) and shared with everyone; your last colour is remembered on your device |
| Connectors | Bound or free ends, straight/elbow/curved routing, 10 arrowheads incl. UML and crow's foot, labels, reverse; drag from a shape's blue dots, or click a dot to add a connected copy; deleting a shape keeps its lines; connectors meet a shape's visible outline, including triangles, stars, arrows and callouts |
| UML | Class/interface/abstract/enum (edited as text: name, `--`, members), actor, use case, lifeline, state, initial/final, package, component, note; 13 relationship presets; Mermaid import (flowchart, classDiagram, stateDiagram-v2, sequenceDiagram) with auto-layout; copy selection as Mermaid |
| Fontshare | Full catalogue (100 families), searchable picker with live previews, weights per family, board heading/body fonts, offline caching via the service worker |
| Iconify | Search 200k+ icons, filter by set, licence notice for CC BY sets, failover to backup hosts; placed icons store their SVG (sanitised) and render offline |
| Stickers | Fluent, Twemoji and Noto emoji in a Stickers drawer, drawn in full colour; placed stickers are stored in the board, so they work offline and export with it; a React button in the quick-action bar drops a reaction next to the selection |
| Team exercises | 14 templates (Start/Stop/Continue, 4Ls, Mad/Sad/Glad, Sailboat, Crazy 8s, Brainstorm + affinity map, Lean Coffee, Impact/Effort, MoSCoW, story map, journey map, empathy map, SWOT, pre-mortem); session bar with steps, shared timer with chime, private writing + reveal, bring everyone to my view, step editor, Markdown summary |
| Dot voting | One-click dot vote from the toolbar on any board (no template needed); dots per person can be any number or unlimited, set per step or changed live for everyone mid-vote, with the number of people on the board and dots placed so far shown alongside; click to add a dot, shift-click to remove; totals hidden until reveal; many dots on one note collapse into a counted badge; results stay on the board after the vote until cleared, with ranked results to copy |
| Polls | Facilitated polls from the toolbar's quick poll button or as a session step: a question with 2–10 options, single or multiple choice, anonymous by default or named; one answer per person, changeable until the poll closes; a card above the session bar for answering and, after reveal, a ranked list with percentages; reveal, copy results as Markdown, or add them to the board as a sticky; answers sync live and work offline, travel in `.drift` and JSON exports, and appear in the Markdown summary once revealed |
| Comments | Threaded comments pinned to a spot or an object (press C or use the speech-bubble tool): post, reply, edit, delete, resolve and reopen; pins follow the object through move, resize and rotate; a Comments panel lists open and resolved threads and flies to a pin; pins can be hidden from the board menu; comments sync live in their own room, work offline, travel in `.drift` and JSON exports, and never appear in PNG/SVG exports. In accounts mode the new **commenter** role can comment on a board without being able to edit it |
| Import/export | `.drift` (zip of readable `board.json` + full CRDT history), JSON, SVG, PNG (2×, real fonts), Markdown summary, Mermaid; drop files on the board or open them from the home screen |

### Not built yet (from the spec)

End-to-end encryption, SSO, passkeys and two-factor sign-in, email-bound invites, comment mentions and notifications, version history, the Tauri desktop app, PDF export, groups, tables, images, boolean shape operations, obstacle-avoiding routing and line jumps, character-level text merging (`Y.Text`), Miro/Excalidraw import, downloadable offline icon sets, and peer-to-peer (WebRTC) sync.

## Fonts and icons

Fontshare fonts are free for personal and commercial use under ITF's Free Font License, which restricts redistributing or serving the font files. Tabula therefore loads fonts only from Fontshare's own servers, caches them in the user's browser for offline use, and stores boards with font names, never font files. The relay never serves fonts. PNG export inlines the fonts temporarily inside the browser to rasterise text; only pixels leave the device.

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

- **CI** runs on pushes to `main`, `v*` tags, pull requests and manual dispatch. Lint, typecheck and `npm audit` run once on Linux. Tests and the production build run on Linux, macOS and Windows with Node 22 and 24. The Docker image then builds with layer caching and is pushed to `ghcr.io/gettabula-app/tabula` on pushes to `main` and on tags. Use the `CI passed` job as the single required check for branch protection.
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
src/polls.ts         polls: questions, answers, open and closed, reveal, results
src/templates.ts     team exercise templates
src/uml.ts, src/mermaid.ts, src/fonts.ts, src/icons.ts, src/exporters.ts
src/ui/              rail, library drawer, properties, font picker, session bar, home
public/sw.js         offline cache for the app, Fontshare and Iconify
```
