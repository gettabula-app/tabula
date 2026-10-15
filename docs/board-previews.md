# Developer board previews

This demo path stores one uploaded board image so a Boards page can show a real preview. It is disabled by default. Set `TABULA_PREVIEW_DEV=1` in the server process environment to enable it; keep the flag off in production.

The server exposes three cookie-session routes while the flag is on:

- `GET /api/boards/:id/preview-source` returns the server-filtered objects for an editor to render. Private notes and cards stay out until the board is revealed; hidden objects, bound connectors to hidden content, and comments stay out.
- `PUT /api/boards/:id/preview` accepts a static PNG or WebP image from a board owner or editor.
- `GET /api/boards/:id/preview` serves the stored image to anyone who can open the board.

Uploads require a declared `Content-Length` and are limited to 40,960 bytes. Images must be 64–1,280 pixels on each side and no more than 1,000,000 pixels total. Each board accepts one upload every 10 seconds; each user can upload 60 images per hour; the workspace limit is 20 MB per day. This path checks the image container and dimensions but does not inspect its pixels.

Files live in `DATA_DIR/previews-dev/`, beside `directory.sqlite`, outside the served application files. The directory uses mode `0700`; image and metadata files use `0600`. Unloaded board rooms are read from their saved Yjs file into a temporary document, which is destroyed after the response.

This demo does not use the production `board_previews` table and has no cascade delete, stale flag, restore or duplicate invalidation, owner remove action, or per-person preview switch. Board deletion and restore can therefore leave a stored preview behind until the demo store is cleaned up.
