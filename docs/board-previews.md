# Developer board previews

This demo path stores one uploaded board image so a Boards page can show a real preview. It is disabled by default. Set `TABULA_PREVIEW_DEV=1` in the server process environment to enable it; keep the flag off in production.

The server exposes three cookie-session routes while the flag is on:

- `GET /api/boards/:id/preview-source` returns the server-filtered objects for an editor to render. Private notes and cards stay out until the board is revealed; hidden objects, bound connectors to hidden content, and comments stay out.
- `PUT /api/boards/:id/preview` accepts a static PNG or WebP image from a board owner or editor.
- `GET /api/boards/:id/preview` serves the stored image to anyone who can open the board.

Uploads require a declared `Content-Length` and are limited to 40,960 bytes. Images must be 64–1,280 pixels on each side and no more than 1,000,000 pixels total. Each board accepts one upload every 10 seconds; each user can upload 60 images per hour; the workspace limit is 20 MB per day. This path checks the image container and dimensions but does not inspect its pixels.

Files live in `DATA_DIR/previews-dev/`, beside `directory.sqlite`, outside the served application files. The directory uses mode `0700`; image and metadata files use `0600`. Unloaded board rooms are read from their saved Yjs file into a temporary document, which is destroyed after the response.

This demo does not use the production `board_previews` table and has no cascade delete, stale flag, restore or duplicate invalidation, owner remove action, or per-person preview switch. Board deletion and restore can therefore leave a stored preview behind until the demo store is cleaned up.

Rate limits: `GET preview-source` allows 30 per minute per user and 1 per 2 seconds per board. Every upload attempt is counted on entry, valid or not, before the body is read. The 20 MB per day pool is one pool for the whole server, so one editor can use it up for everyone on a demo server.

Before the flag is ever turned on outside the demo: the stored image needs cascade delete with the board, a stale flag, restore and duplicate invalidation, the owner remove action, and `Clear-Site-Data` on logout (the preview route does not send it yet). A restore from backup does not bring previews back: `previews-dev/` is not part of any backup. Keep `TABULA_PREVIEW_DEV` out of every `fly.toml`, Dockerfile and CI environment; a test checks that `loadConfig` leaves it false by default.

Freshness: a stored image older than 24 hours is no longer served (404, the card shows the schematic) until a new upload. Marking an image stale when a text-bearing object is deleted needs a hook in the relay; the demo does not have it, and the production design must (with the per-board "sensitive: no preview" option and deleting the file with the board).
