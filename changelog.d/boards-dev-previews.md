section: Changed
audience: dev

- Dev demo (`npm run dev:boards-real`): a board card shows the picture the board holds, drawn from its real content by the app's own drawing export through a strict SVG whitelist, rasterised in the browser and stored by the tech lead's preview routes (TABULA_PREVIEW_DEV=1). The picture is written when an editor leaves a board or after three seconds of quiet while editing (at most every ten seconds). Seeded boards get their real content, and their pictures are drawn at launch by opening and leaving each one as its owner. A board with no stored picture shows the quiet tile; no template sketch or seeded picture is drawn anywhere.
- The demo's Boards cards draw from the server's everyone's-view source (GET /api/boards/:id/preview-source) only; the live store is never read for a picture. Dev only: nothing starts in a production build.
