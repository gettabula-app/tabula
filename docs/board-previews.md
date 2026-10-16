# Board previews

Board preview pictures are a derived file cache. The database never points to a preview file, and a missing, empty or partly restored cache is safe: the board can be rendered again and a new image uploaded.

Previews are on by default. A workspace admin can turn them off in Admin > Privacy. `TABULA_PREVIEWS=0` is the server-wide kill switch; it disables the routes, ignores existing files and prevents writes. The workspace setting cannot override it.

The server exposes cookie-session routes while previews are enabled:

- `GET /api/boards/:id/preview-source` returns the server-filtered objects for an editor to render. Private notes and cards stay out until the board is revealed; hidden objects, bound connectors to hidden content, and comments stay out. Its response includes a revision number.
- `PUT /api/boards/:id/preview` accepts a static PNG or WebP image from a board owner or editor. The upload must include the revision returned by `preview-source`; a board change makes an older upload fail with `409 preview_stale`.
- `GET /api/boards/:id/preview` serves the stored image to anyone who can open the board.
- `DELETE /api/boards/:id/preview` lets the board owner or a workspace admin remove the picture.

Uploads require a declared `Content-Length` and are limited to 40,960 bytes. Images must be 64–1,280 pixels on each side and no more than 1,000,000 pixels total. Each board accepts one upload every 10 seconds; each user can upload 60 images per hour; the server-wide pool is 200 MB per day. Source reads allow 30 per minute per user and one per 2 seconds per board. Every upload attempt is counted on entry, valid or not, before the body is read. The server checks the image container and dimensions but does not inspect its pixels. Stored images are not served after 24 hours.

Files live in `DATA_DIR/previews/`, beside `directory.sqlite`, outside the served application files. The directory uses mode `0700`; image and sidecar files use `0600`. Each sidecar records its board id, upload time and image metadata. The cache defaults to 64 MB total; `TABULA_PREVIEWS_MAX_MB` can set a cap from 1 to 1,024 MB. When a new picture would exceed the cap, the oldest stored pictures are evicted first. A sweep runs at startup and hourly to remove orphan files, files for deleted boards and old temporary files.

Keep free disk space at least five times the configured preview cap. With the default 64 MB cap, keep at least 320 MB free. Previews are not part of backups or board exports; the cache is rebuilt when a client next renders the board and uploads a fresh picture. The backup walker has an explicit allowlist for the workspace database, chat database, room files, content-addressed assets and version history; it does not walk `previews/`.

A preview is unlinked when any object is deleted, a note becomes private, an object or layer becomes hidden, or text changes on a sticky, text, shape or frame. Text edits unlink at most once every 30 seconds per board. Room observers attach after persisted Yjs state loads, and the revision is bumped for each sensitive change so an upload already in flight cannot put an older picture back. Board deletion, restore from trash, completed backup restore and volume adoption also clear the relevant cache. Logging and cache failures never identify a board or prevent a board save.

## Limits

The file cache is optional and regenerable, but it still uses local disk. An empty cache or a partially restored directory shows no picture until a fresh upload. A stale image older than 24 hours also falls back to the board schematic.

The server cannot verify what the pixels show. An editor who has a private grant can upload arbitrary pixels, including content others may not see. Treat every stored picture as an untrusted upload, not proof of board content. A board owner or workspace admin can remove it, which returns the card to its schematic fallback.

## Operating notes

- A board purge relies on the hourly orphan sweep to remove its picture file (soft delete and restore remove it at once). That is fine for a cache.
- `TABULA_PREVIEWS=0` is a machine environment variable. An upgrade that recreates the machine drops it unless the control plane carries it over.
- A change to a text, frame name or connector label that falls inside the 30 s throttle window still removes the picture when the window is over.
- A board owner or workspace admin can turn the picture off for one board (`PUT /api/boards/:id/preview-off {off:true}`, audit `board.preview.off`/`on`). The choice lives in the workspace settings, not in the cache directory, so clearing the cache or restoring a backup does not bring the picture back. While it is off, preview-source, upload and read all answer 404 for that board.
- Boards are only soft-deleted today (there is no permanent purge path), so the per-board "off" setting stays with the board id and a restored board keeps its choice. If a permanent purge is added, it must delete the `boardPreview.off.<id>` setting. A duplicate gets a new board id, so the copy has previews on.
