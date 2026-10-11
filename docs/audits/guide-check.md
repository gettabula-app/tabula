# User guide audit

Audited `docs/guide/*.md`, the emitted static `/docs/` pages, and `docs/images/` at base `3dc5dc8e323d0a5bf8eb70d3c38ab8f9a14cc836`.

## Findings

### Broken published link

- **P2 — Join codes link leaves the guide.** `docs/guide/sharing.md:40` links to `../join-codes.md`. The guide renderer emits this as `/docs/../join-codes`, which resolves to `/join-codes`; `docs/join-codes.md` is not one of the pages published under `/docs/`. The generated `dist/docs/sharing/index.html` confirms the bad URL. **Fix:** publish the join-codes page in `docs/guide/` and link to it as `join-codes.md` (or link to a separately published page with its actual URL).

The generated pages had no other broken internal links or missing heading anchors.

### Feature claims and availability

- **P2 — AI status is outdated.** `docs/guide/admin.md:84` says AI features are still being built and that enabling them has no effect. The current AI run route checks configured workspace features and executes enabled runs (`server/ai/run.mjs:415-425`). **Fix:** remove the obsolete paragraph or replace it with the current availability requirements.
- **P2 — Board chat readership includes join-code guests incorrectly.** `docs/guide/chat.md:89` says everyone who can open a board can read its chat. Join-code guests can open only their granted board, but their API access excludes chat (`docs/join-codes.md:29-33`). **Fix:** limit the statement to workspace users with board access and say guests cannot use chat.
- **P3 — Tracker-link availability is unexplained.** `docs/guide/kanban.md:130,132` mentions tracker links without describing their gate. The server defaults `TABULA_TRACKER` to off (`server/config.mjs:89-93`), and the Kanban menu exposes link actions only when the user is signed in or offline with tracker access (`src/ui/kanban-menus.ts:223-226`). **Fix:** qualify tracker-link actions with the server and user access requirements.
- **P3 — Join-code overview omits accounts mode.** `docs/guide/sharing.md:21` says the server can turn on join codes but does not say they require accounts mode. `TABULA_JOIN_CODES=on` is ignored without `TABULA_AUTH=on` (`server/config.mjs:261-263`); the later section at `docs/guide/sharing.md:38` identifies workspaces but does not state this requirement either. **Fix:** say join codes require accounts mode, or consolidate the two descriptions and include that condition.

The guide correctly says chat requires sign-in and server enablement (`docs/guide/chat.md:3`), and correctly names `TABULA_JOIN_CODES=on` and its default-off behavior in `docs/guide/sharing.md:38`.

### Images and screenshots

- All 13 guide image references resolve to files in `docs/images/`, have nonempty alt text, and are present in the built `/docs/images/` output.
- All 16 source images are referenced by either the guide or `README.md`. Three (`readme-hero.png`, `shapes-panel.png`, `theme-ayu.png`) are README-only; none are unreferenced.
- No stale guide screenshots were confirmed. The rounded-chrome screenshots were regenerated after the radius-token change (`f18c2ac`, then `0382f90`); the Matrix screenshot shows Matrix selected among the same five themes documented by the guide.

## Checks

- `npm run build` — passed on Node 24.10; emitted 24 guide pages. Vite printed non-blocking large-chunk and dynamic-import warnings for the app bundle.
- Generated HTML link, anchor, image-file and alt-text scan — one broken internal link (above); no other failures.
- `npm run changelog:check` — passed, 172 fragments.
