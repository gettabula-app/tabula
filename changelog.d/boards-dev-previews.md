section: Changed
audience: dev

- Dev demo (TABULA_DEV_PREVIEWS=1, scripts/dev-boards-real.mjs): the seeded boards have real content, from their built-in templates with some variation per board, and the Boards cards show a picture of what each board holds. The picture is stored per board by the relay (GET and PUT /api/dev/board-preview/<id>, dev only, 404 without the flag) and written three seconds after an editor's last change, or when the board is left. It draws what everyone may see of the board (src/preview-source.ts: no unrevealed private notes, no hidden objects).
