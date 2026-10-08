# Stickers and emojis

Stickers are emoji placed on a board, drawn in full colour. A sticker is an existing **icon** object whose Iconify set is an emoji set, plus one flag. This slice adds a Stickers drawer, a larger default size, a flag that hides the colour control, and a small reaction picker in the quick-action bar. It adds no object type, no render path, no server endpoint, no schema bump and no service worker change.

## Why the icon type is enough

The design question was whether the icon object can already draw colour emoji. It can, and the code shows it:

- `iconMarkup` (`src/markup.ts`) embeds the stored SVG body. The only transform is `sanitizeSvgBody`, which strips scripts, event handlers and `javascript:` links. Colours are untouched.
- The body's `color` reaches only elements that use `currentColor`. It is the literal `textColor` on icons placed from the library, and otherwise the stroke default `var(--canvas-ink)`, which the themes vary. Emoji sets paint explicit fills, and the sets offered below have no `currentColor` at all, so no theme can recolour them. Themes change many tokens (`src/themes.ts`); only their `currentColor` parts follow `--canvas-ink`.
- Iconify probe, first 60 icons of each set:

| Set | Bodies with explicit colour | Bodies with `currentColor` | Mean body (characters) |
| --- | --- | --- | --- |
| `fluent-emoji-flat` | 60 / 60 | 0 | 1,697 |
| `twemoji` | 60 / 60 | 0 | 1,575 |
| `noto` | 60 / 60 | 0 | 4,110 |
| `fluent-emoji` (3D) | 60 / 60 | 0 | 21,799 |
| `fluent-emoji-high-contrast` | 5 / 60 | 60 / 60 | 1,735 |

`fluent-emoji-high-contrast` is monochrome: its colour comes from `textColor`, so it reads as an icon with a working Colour control. It is an icon, not a sticker, and it is excluded. A 10-icon sample of the first four sets had no `<style>` elements and no `class` attributes.

- Everything else a sticker needs already works for icons: resize keeps aspect (`app.ts`, `keepAspect` for `icon`), rotate, z-order, frames, undo, copy and paste (`insertObjects` clones the body under a fresh id), `.drift` and JSON export and import, offline storage (the body lives in the board document, persisted by `y-indexeddb` in `src/sync.ts`), and PNG and SVG export (`objectMarkup` inlines the body, so export fetches nothing).

A new object type would add a second render path, sanitiser, export branch and schema shape for no visible gain. The `sticker` flag exists only for what differs: no colour control, a "Sticker" label, and a sticker that stays a sticker if its set later leaves the list.

## A bug the icon code has today

Some Iconify bodies carry SVG `id`s that gradients refer to. In the probe, 14 of 60 `noto` bodies and 60 of 60 `fluent-emoji` bodies have them, and two different Fluent icons (`grinning-face` and `grinning-face-with-big-eyes`) share 10 ids. Whether their gradient definitions differ was not checked, and the fix does not depend on it. Board objects are inlined into one document, both in the live renderer (`render.ts` sets each object's `innerHTML`) and in export (`exportSvg` joins every `objectMarkup`). The browser resolves `url(#id)` to the first element with that id, so two stickers can take each other's gradients.

Copy and duplicate keep the body and give the copy a new object id, so the fix cannot be made at placement. It goes in `iconMarkup`: every icon's body has its ids scoped by object id at render and export time. This also changes any existing icon whose body has ids, and changes nothing for icons without them.

## Data model

The object is the existing `icon` object plus one optional field:

```ts
// src/types.ts, BaseObj, icon fields
type: 'icon'
ref: string                                  // 'fluent-emoji-flat:party-popper' (existing)
body: string                                 // SVG body as fetched; stored unscoped (existing)
viewBox: [number, number, number, number]    // existing
sticker?: boolean                            // NEW: true on stickers and reactions; absent on icons
```

Stickers do not set `textColor`. The library sets `'#18212B'` on icons, which has no effect on colour emoji and is left out for stickers.

Example stored object:

```json
{ "id": "V3k…", "type": "icon", "ref": "fluent-emoji-flat:party-popper", "body": "<path …/>",
  "viewBox": [0, 0, 32, 32], "sticker": true, "x": 240, "y": 96, "w": 120, "h": 120,
  "rotation": 0, "z": "a1", "font": "satoshi", "createdBy": "…", "updatedAt": 1789000000000 }
```

Configuration, in the new `src/stickers.ts`:

```ts
export const STICKER_SETS: { prefix: string; label: string; default?: true; large?: true }[];
export const STARTER_STICKERS: string[];   // names shown before any search, from the default set
export const REACTIONS: string[];          // 16 names from fluent-emoji-flat
export const STICKER_SIZE = 120;           // longest side, in board units (icons use 64)
export const REACTION_SIZE = 40;
export const isSticker = (o: Obj): boolean => o.type === 'icon' && o.sticker === true;
export function stickerSize(viewBox: [number, number, number, number]): { w: number; h: number };
export function scopeSvgIds(body: string, objectId: string): string;
```

Sets offered in the drawer (licences from Iconify's collections index):

| Prefix | Name | Licence | Attribution | Body | Status |
| --- | --- | --- | --- | --- | --- |
| `fluent-emoji-flat` | Fluent Emoji Flat | MIT | no | 1.7 KB | default |
| `twemoji` | Twitter Emoji | CC-BY-4.0 | yes | 1.6 KB | offered |
| `noto` | Noto Emoji | Apache-2.0 | no | 4.1 KB | offered |
| `fluent-emoji` | Fluent Emoji (3D) | MIT | no | 21.8 KB | offered, `large` |
| `openmoji` | OpenMoji | CC-BY-SA-4.0 | yes | not sampled | open question |

Left out: `fluent-emoji-high-contrast` (monochrome), `emojione-monotone` (monotone by name, not sampled), `noto-v1` (older revision of `noto`), and `emojione`, `emojione-v1`, `fxemoji` and `streamline-emojis` (not yet sampled; the implementation step samples them before any is listed). Iconify rate-limited the probe (HTTP 429) for some sets.

Each placed sticker copies its body into the board document, and every duplicate copies it again. The 3D set costs about 13 times the flat set per sticker, so it is labelled `large` in the drawer.

## Behaviour

- **Placing.** Dropping or clicking a Stickers tile calls `placeSticker(app, name, at?, longest)`. It awaits `iconData(name)`, sizes the object by the viewBox aspect with the longest side at `STICKER_SIZE`, and calls `app.placeAt` (drop) or `app.placeAtCenter` (click) with `type: 'icon'` and `{ ref, body, viewBox, sticker: true }`. The creator, z-order, frame parenting, snapping and undo come from the existing `makeObj` and `createObject`. The new sticker is selected, as any object is.
- **Rendering.** `iconMarkup` scopes the sanitised body with `scopeSvgIds(body, o.id)`: every `id="X"`, `url(#X)` and `href="#X"` (including `xlink:href`) becomes `i<objectId>-X`. The rewrite is cached with the sanitiser, keyed by body and id. Object ids come from `newId()` and use only `A-Za-z0-9-_`, so the new ids are valid.
- **Colour.** Stickers have no colour control. `HAS_STROKE` excludes stickers, which hides the Colour swatch in the properties panel and the Line swatch in the quick bar. The properties title reads "Sticker".
- **Resize and rotate.** Unchanged from icons: resize keeps aspect, rotation works.
- **Double-click.** Does nothing, as for icons.
- **Reactions.** A React button in the quick bar opens a popover of the 16 `REACTIONS` as a grid. Clicking one calls `placeSticker` at `REACTION_SIZE`, with its centre 20 units right of and 20 units above the top-right corner of the selection's bounds. A reaction is a plain sticker: it does not follow its item, has no count, and is removed like any object (delete or Ctrl+Z). With several items selected, one reaction is placed at the bounds of the selection.
- **Failure.** A sticker that cannot be fetched shows the existing toast ("That icon could not be loaded. Check your connection and try again.") and places nothing.
- **Copy.** Copy, paste and duplicate clone the body and give a new id; the render-time scope keeps the copy's ids apart.
- **Emoji typed as text.** Unchanged. Emoji typed into text and sticky notes are plain Unicode text and are not affected.
- **Strings.** All new text says "Sticker" or "Stickers". No new product-name text and no new `MIRA_*` environment names are added.

## UI

- **Rail.** A Stickers button after Icons, with a new `stickers` glyph in `ICONS` (`src/ui/dom.ts`).
- **Drawer.** Title "Stickers", then:
  - a search box ("Search stickers", 250 ms debounce as in the Icons tab);
  - a row of set chips, one per `STICKER_SETS` entry, with `fluent-emoji-flat` selected by default;
  - a grid of tiles (`.icon-grid` and `.icon-tile`, with a 36 px image in a `.sticker-tile`), each with title and aria-label "`<name>`. Click to add, or drag onto the board.";
  - the starter grid when the search is empty, and `searchIcons` or `collectionIcons` (limit 160) otherwise.
- **Note.** Under the grid: the existing CC BY note when the chosen set has `attribution`, otherwise "Stickers are emoji from open-source sets via Iconify. Placed stickers are stored in the board and work offline."
- **Quick bar.** One React button, placed after the style groups and before More. Its popover uses the quick bar's popover placement (`popover` from `src/ui/common.ts`, class `qb-pop`).
- **Mobile.** At 360 px the quick bar with React must still fit without horizontal scroll.

## Roles

| Role | Stickers drawer | Place a sticker | React |
| --- | --- | --- | --- |
| owner, editor | yes | yes | yes |
| commenter | no (button disabled) | no | no |
| viewer | no (button disabled) | no | no |

Open mode (accounts off): everyone may place and react, as they can add icons today.

Enforcement, all existing:

- The Stickers rail button is disabled while the board is read-only. The read-only sync in `src/ui/board.ts` loops over every rail button, and drawer buttons have no `dataset.tool`, so the Icons button is already disabled for viewers today and the new button needs no extra code. The drawer closes on read-only, as it does today.
- `dropItem` returns early when `app.readOnly` (`src/ui/library.ts`), so a drop does nothing.
- `Store.transact` does nothing while read-only (`src/store.ts`).
- The quick bar is hidden when read-only (`visible()` in `src/ui/quickbar.ts`), so no React button appears.
- Stickers are board-room objects. The relay drops board-room updates from commenters and viewers (`docs/comments.md`), so a modified client cannot write a sticker through.

The comments room holds only comment text, so comments cannot carry stickers.

## Export and import

- **SVG and PNG.** Stickers export as icons do: the body is inlined, the ids are scoped, nothing is fetched. PNG rasterises that SVG.
- **Mermaid.** Skips icons (`src/mermaid.ts`), so it skips stickers too.
- **`.drift`.** Carries the full Yjs state, which includes `body` and `sticker`. Opening it restores both.
- **JSON.** `toJson` writes `objects` verbatim, so `sticker` and `body` are included. `insertImported` clones them through `insertObjects`.
- **Old clients.** A sticker opens as an icon: it shows the Colour control, which changes nothing. `sticker` is optional, and `validate` checks the format, that `objects` is an array, and `schemaVersion`, so `SCHEMA_VERSION` stays at 1.
- **Bodies in imports.** Imported bodies pass through the same sanitiser at render time as any icon. No extra check is added.
- **Credits.** Exports carry no attribution (open question below).

## Offline

- **Placed stickers.** The body is in the board document, persisted in IndexedDB. A placed sticker renders offline with no fetch, and PNG and SVG export work offline.
- **Stickers drawer.** Search, browsing and placing a new sticker need the network, as the Icons tab does. The service worker's stale-while-revalidate cache (`public/sw.js`, the `THIRD_PARTY` rule for `api.iconify.design`) keeps every preview and JSON response the device has fetched, so a set seen once is available offline for its previews and starter grid.
- **Reactions.** The first use of each reaction name fetches its body. After that, the service worker serves the same JSON URL offline. A reaction never fetched on this device fails offline with the existing toast (open question below).
- **Unchanged.** `public/sw.js` is not edited. A custom Iconify host (`setIconHost`) is not in its list, so previews from a custom host are not cached. This is an existing limit.

## Tests

Automated (`npm test`, vitest):

- `test/stickers.test.ts` (new):
  - `scopeSvgIds` rewrites `id`, `url(#…)` and `href="#…"` consistently, and leaves text and other attributes alone;
  - two objects with the same body produce no shared ids in combined markup;
  - `STICKER_SETS` prefixes are unique and exclude `fluent-emoji-high-contrast`;
  - `stickerSize` keeps aspect and sets the longest side to `STICKER_SIZE`, for square and wide viewBoxes;
  - `isSticker` is true only with `sticker: true` on an icon;
  - store round trip: a sticker created in a `Store`, encoded with `Y.encodeStateAsUpdate` and applied to a fresh `Y.Doc`, reads back `sticker`, `body`, `viewBox` and `ref`;
  - a read-only `Store` creates no sticker (same pattern as `test/store-readonly.test.ts`).
- `test/core.test.ts` (extended): an icon with id-bearing body markup contains only scoped ids, and sticker markup has no external `href` or `url(http`.

Manual, in the dev server:

- Place Fluent flat, Twemoji, Noto and Fluent 3D stickers in each theme (Default, Ayu, Kanagawa, Matrix, Evergreen). Colours must not change.
- Duplicate two Fluent stickers (Ctrl+D). Each keeps its own gradients.
- Select a sticker. There is no Colour or Line swatch, the title reads "Sticker", and the quick bar offers arrange, lock, duplicate, delete and React.
- React adds one sticker next to the selection, and Ctrl+Z removes it.
- Go offline (DevTools) and reload. Placed stickers render, and PNG and SVG export work.
- Accounts mode, as a viewer and as a commenter: the Stickers button is disabled, the quick bar is hidden, and a drop does nothing.
- At 360 px width, the quick bar with React fits.
- `npm run lint`, `npm run typecheck` and `npm test` pass.

## Not in this slice

- **Giphy and animated GIFs.** Needs an API key held on the server behind a proxy route under `/api/` (never in the client); an external call per search with rate limits and a content-rating filter; a raster object (`<image href>`), not an SVG body; storage for 0.5 to 5 MB files outside the board document, which means an asset store that does not exist yet; caching for the media CDN in the service worker; Giphy's attribution rules; and PNG export captures one frame.
- **Attached reactions.** Reactions that follow their item, show counts, or record who reacted. This needs a reaction map on the object or a comment-style record, and probably the comments document, so that commenters can react without editing the board.
- **Custom uploads, sticker packs, animated emoji, skin tones, and search across every Iconify set.**
- **Credit lines in exports.**
- **A keyboard shortcut for the Stickers drawer.**

## Files

NEW:

- `docs/stickers.md`: this spec.
- `src/stickers.ts`: `STICKER_SETS`, `STARTER_STICKERS`, `REACTIONS`, the sizes, `isSticker`, `stickerSize` and `scopeSvgIds`. No DOM and no UI imports.
- `src/ui/stickers.ts`: `stickersTab(app, close, draggable)`, `placeSticker(app, name, at?, longest?)`, and `reactionButton(app)` with its popover.
- `test/stickers.test.ts`: the unit tests listed above.

EXISTING (one line each):

- `src/types.ts`: `sticker?: boolean` on the icon fields of `BaseObj`.
- `src/markup.ts`: `iconMarkup` applies `scopeSvgIds(…, o.id)` to every icon body.
- `src/ui/library.ts`: `'stickers'` in `DrawerTab`, its title and body dispatch; a `{ kind: 'sticker' }` variant in `DropItem`, routed to `placeSticker`.
- `src/ui/board.ts`: a Stickers rail button after Icons (the existing read-only loop disables it with the rest), and `'stickers'` added to the `drawerBtn` tab union.
- `src/ui/props.ts`: `HAS_STROKE` excludes stickers; the title reads "Sticker".
- `src/ui/quickbar.ts`: one line that pushes the React button group for non-read-only selections.
- `src/ui/dom.ts`: a `stickers` glyph in `ICONS`.
- `src/styles.css`: `.sticker-tile` (36 px image); the rest reuses `.icon-grid` and `.icon-tile`.
- `test/core.test.ts`: two icon-markup cases.
- `CHANGELOG.md`: an Unreleased entry, at implementation time.

Untouched: `src/app.ts` and `src/render.ts` (the rename is editing them), `src/exporters.ts`, `src/icons.ts`, `src/store.ts`, `src/sync.ts`, `public/sw.js` and `server/`.

## Open questions

1. Default set: `fluent-emoji-flat` (MIT, 1.7 KB), as proposed?
2. OpenMoji (CC-BY-SA-4.0, share-alike): leave out until we decide what share-alike means for an exported board?
3. Fluent 3D (21.8 KB per sticker): offer it with a `large` label, as proposed, or leave it out?
4. Exports: add a credit line when CC BY sets are used, or none, as proposed?
5. Default size: 120 as proposed, or 96?
6. Reactions: keep them in this slice, as proposed, or defer them?
7. Offline first reactions: bake the 16 reaction bodies into the bundle (about 30 to 40 KB of source), or fetch them as proposed?
8. Read-only: disable the Stickers button, as proposed, or hide it?
9. The Icons tab already offers emoji sets (`POPULAR_SETS` in `src/icons.ts` includes `fluent-emoji-flat` and `twemoji`), so stickers can be placed there today without the flag. Should the Icons tab hide emoji sets once Stickers exists?
