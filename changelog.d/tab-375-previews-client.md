section: Changed
audience: dev

- TAB-375, client of the board pictures (docs/board-previews.md): the picture is made from GET /api/boards/:id/preview-source and sent with its `rev` as `x-preview-rev` on PUT /api/boards/:id/preview. A 409 `preview_stale` is asked again once, then the page waits for the next change or leave. A 404, 413, 429, 503 or network failure backs off quietly, with no loop; a card keeps its drawn schematic whenever no picture is stored.
- A picture is made and sent only for an owner or editor of the board, while the session says `boardPreviews` is on (/api/me, or /api/config for a signed-out page). A viewer makes no request for the source. A tab hidden for more than a minute drops its pending picture work.
- Before drawing, each image of the board is shrunk through a canvas to at most 480 px, as WebP or JPEG at quality 0.7, which strips its metadata; its body is read with a size cap, never trusting content-length. Without a canvas the image is left out. A picture that no encoding fits under 40 KB (Safari has no WebP encoder) is not sent, and the old one stays.
- The owner's and a workspace admin's switch in the board menu, "Show a picture on the card" (GET and PUT /api/boards/:id/preview-off), with its wording in one block in src/ui/board-preview-toggle.ts.
- Removed: the dev-only `TABULA_PREVIEW_DEV` flag, the `tabula.dev.previewRender` switch, and the dev-only card picture path.
