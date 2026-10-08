# Self-hosted icon sets

TAB-101. The Icons and Stickers drawers fetch every preview, every search and every icon body from the Iconify API at runtime, and its rate limit (HTTP 429) breaks both drawers. This slice builds the icon sets into the app at build time, serves them from our own relay, loads them lazily in the browser, and keeps them for offline use. The Iconify API stays only as an explicit, online-only fallback for sets we do not host.

This is a plan with measurements. Nothing here is implemented. It was written against `origin/main` at `8b6e855`; `origin/main` has since moved to `7fab011`, and among the files read for this plan only the `packageManager` line in `package.json` differs.

## Decision in short

- **Host a curated list of 22 sets, baked into the image.** 76,746 icons, 18.6 MB on the wire (gzip), about 0.5 MB of search index. The image grows from about 67 MB to about 86 MB (+28%).
- **Not "all".** The 213 sets whose licence we may ship are 357,248 icons and 78.3 MB gzip: the image would more than double (about 147 MB, +119%). "All" is possible later as a build-time opt-in or a separate image tag, not as a runtime download (see [Why not all, and not a runtime download](#why-not-all-and-not-a-runtime-download)).
- **Sets we do not host stay reachable online through the existing Iconify API layer**, only when the person picks them, never for a hosted set, and only if their licence passes the same allowlist. Hosted sets never touch the API, which is what ends the 429s.
- **Build step `scripts/build-icons.mjs`**, run by `npm run build` after `vite build`. Per-set index, 96-icon or 64 KiB shards, a manifest, all gzip-9 and content-hashed, into `dist/icons/`. Gzip only: brotli-11 took 184 s for the full corpus, gzip took 3.4 s, and brotli saves about 15%.
- **Search is client side**, over a per-set name index. Previews are `data:` URLs built from shards. Cache Storage through the service worker keeps what was fetched; "Download for offline" fetches every shard of a set. No IndexedDB.
- **Licence allowlist** read from each set's `info.license.spdx`: CC0, Unlicense, MIT, ISC, Apache-2.0, BSD, OFL-1.1, CC-BY-3.0 and CC-BY-4.0. Everything else, and every set Iconify marks `hidden`, is not built and not offered.

## Why

Every icon-related request goes to a third party today (`src/icons.ts`):

| Where | What it calls | Cost |
| --- | --- | --- |
| Icons tab opens | `/collections` (every set), then `/search?query=arrow&prefix=lucide&limit=48` | 2 requests, then one `<img>` request per tile |
| Search, 250 ms after the last key | `/search?...&limit=96` | 1 request, then up to 96 `<img>` requests |
| Pick a set with an empty search | `/collection?prefix=` | 1 request, then up to 160 `<img>` requests |
| Place or drag an icon or sticker | `/<prefix>.json?icons=<name>` | 1 request |
| Stickers tab opens | same as Icons, for one set | up to 160 `<img>` requests |
| Reaction picker in the quick-action bar | 16 `<img>` requests | 16 requests the first time it opens (the service worker keeps them) |

A burst of up to 96 image requests per search, or 160 per set, is the likely trigger. Placed icons are not a problem: the body is stored in the board, so a placed icon renders offline and never calls the API again. The new design keeps that and changes nothing in the board format.

## Measurements

Measured on 2026-10-08 with `@iconify/json` 2.2.540 (tarball 104,181,765 bytes, 487,161,383 bytes unpacked) and the registry sizes of the `@iconify-json/*` packages. The prototype of the build step lives outside the repo; it reads the same fields the real script will, writes the formats below, and compresses with gzip level 9 and brotli quality 11. "MB" means 1,048,576 bytes. The Docker daemon was not running, so no image was built: image figures are arithmetic from measured parts and the published base image size.

### Everything upstream

| | Value |
| --- | --- |
| Set files in `json/` | 244 (`collections.json` lists 239; the 5 not listed are `bubbles`, `devicon-line`, `devicon-original`, `emblemicons`, `streamline-guidance`) |
| Icons / aliases | 392,114 / 33,108 (`collections.json` totals 380,955 for its sets and differs from the files on 93 sets: the set files are the truth here) |
| Upstream JSON as shipped (tab-indented) | 464.4 MB |
| In our shard format (body plus only the sizes that differ from the set default, no whitespace) | 448.3 MB raw, 99.8 MB gzip, 81.4 MB brotli |
| Build time, all 244 sets | brotli-11 plus gzip: 184 s on 6 workers; gzip only, 213 sets: 3.4 s |

Iconify's JSON has no per-icon tags or keywords. The searchable fields are the icon names, the alias names and, for 75 of the 213 allowlisted sets, the category names (`categories`, a map from category to icon names; per-set packages keep it in `metadata.json`).

### Licences

Every one of the 244 sets has an SPDX id, so "unclear" is a rule for the future, not a case today. 31 sets would not be built: 16 that Iconify marks `hidden` (including `fluent-emoji`, the 3D set: 98.8 MB raw, 13.9 MB gzip), and 18 by licence, 3 of which are also hidden.

| Licence | Built: sets / icons / raw MB / gzip MB | Not built: sets / icons / gzip MB | Class |
| --- | --- | --- | --- |
| MIT | 108 / 183,240 / 140.0 / 34.1 | 5 / 3,824 / 14.0 (all hidden) | notice |
| CC-BY-4.0 | 52 / 66,318 / 73.1 / 17.0 | 1 / 428 / 0.1 (hidden) | attribution |
| Apache-2.0 | 30 / 85,171 / 68.7 / 13.4 | 1 / 89 / 0.0 (hidden) | notice |
| CC0-1.0 | 10 / 11,865 / 19.4 / 6.9 | - | public |
| CC-BY-3.0 | 1 / 4,134 / 6.1 / 2.6 | - | attribution |
| ISC | 3 / 3,244 / 1.8 / 0.6 | - | notice |
| OFL-1.1 | 7 / 2,636 / 1.4 / 0.5 | 6 / 3,606 / 0.6 (all hidden) | notice |
| Unlicense, BSD-3-Clause | 2 / 640 / 0.2 / 0.0 | - | public, notice |
| CC-BY-SA-4.0, CC-BY-SA-3.0 | 0 | 9 / 22,857 / 8.1 | blocked: ShareAlike |
| CC-BY-NC-4.0, CC-BY-NC-SA-4.0 | 0 | 2 / 2,234 / 1.7 | blocked: NonCommercial |
| GPL-2.0-only, GPL-2.0-or-later, GPL-3.0, GPL-3.0-or-later, MPL-2.0 | 0 | 7 / 1,828 / 0.2 | blocked: copyleft |
| Total | 213 / 357,248 / 310.7 / 75.2 | 31 / 34,866 / 24.6 | |

Gzip figures in this table use 256-icon shards; the chosen 96-icon shards add about 4%. Of the built sets, 53 (70,452 icons) need attribution (CC-BY).

### Candidate lists

| List | Sets | Icons | Raw MB | Gzip MB (96-icon shards) | Files | Index gzip | Image |
| --- | --- | --- | --- | --- | --- | --- | --- |
| (a) all allowlisted | 213 | 357,248 | 310.7 | 78.3 | 5,983 | 1.9 MB | +80 MB, to about 147 MB |
| (b) curated | 22 | 76,746 | 82.7 | 18.6 | 1,588 | 478 KB | +19 MB, to about 86 MB |
| (c) sticker sets alone | 3 | 11,162 | 42.1 | 6.8 | 695 | 80 KB | +7 MB |
| `POPULAR_SETS` alone | 12 | 59,856 | 52.7 | 13.0 | 1,045 | 382 KB | +13 MB |

The curated list (b) is `POPULAR_SETS` (12), the three sticker sets (`noto` is the only addition to the 12), and nine broadly useful sets:

`lucide tabler ph mdi material-symbols carbon heroicons logos simple-icons fluent-emoji-flat twemoji devicon` (the 12 existing), `noto` (stickers), `bi ri ion iconoir octicon fa6-solid fa6-regular fa6-brands circle-flags`.

| Set | Licence | Icons | Raw MB | Gzip MB | Shards | Index gzip KB |
| --- | --- | --- | --- | --- | --- | --- |
| noto | Apache-2.0 | 3,819 | 23.97 | 3.91 | 400 | 27 |
| logos | CC0-1.0 | 2,199 | 7.27 | 2.69 | 121 | 9 |
| simple-icons | CC0-1.0 | 3,737 | 4.47 | 1.85 | 74 | 16 |
| devicon | MIT | 1,065 | 4.94 | 1.75 | 77 | 4 |
| twemoji | CC-BY-4.0 | 4,169 | 9.59 | 1.62 | 157 | 31 |
| fluent-emoji-flat | MIT | 3,174 | 8.48 | 1.30 | 138 | 22 |
| material-symbols | Apache-2.0 | 16,422 | 7.22 | 1.22 | 172 | 132 |
| ph | MIT | 9,161 | 4.17 | 0.96 | 96 | 27 |
| mdi | Apache-2.0 | 7,638 | 2.44 | 0.68 | 80 | 83 |
| ion, tabler, carbon, ri | MIT, MIT, Apache-2.0, Apache-2.0 | 14,652 | 5.23 | 1.34 | 155 | 72 |
| fa6-solid, bi, fa6-brands, heroicons, octicon, iconoir, circle-flags, lucide, fa6-regular | various | 10,710 | 4.96 | 1.25 | 118 | 54 |
| Total | | 76,746 | 82.73 | 18.57 | 1,588 | 478 |

Biggest sets that stay out of the curated list, by gzip MB: `token-branded` 3.60 (MIT), `thesvg-color` 3.16 (MIT), `selfhst` 2.75 (CC-BY-4.0), `game-icons` 2.67 (CC-BY-3.0), `fluent` 2.51 (MIT, 20,265 icons), `solar` 2.30 (CC-BY-4.0), `material-symbols-light` 1.79 (Apache-2.0). Heavy colour sets dominate: `noto` alone is 21% of the curated gzip total. In the corpus, bodies average 870 characters; in the curated list 1,085, with the largest at 350,029 characters (`devicon:nano-wordmark`).

### Search index

Per set: the icon names in shard order, aliases as `[alias, parentIndex]`, categories as lists of indexes, and the shard list. Built as one combined file with names, aliases and categories, for the lists above:

| Index | Raw | Gzip | Brotli | Names only, gzip |
| --- | --- | --- | --- | --- |
| (a) all allowlisted | 8.65 MB | 1.89 MB | 1.05 MB | 1.2 MB |
| (b) curated | 2.13 MB | 482 KB | 311 KB | 273 KB |
| (c) stickers | 371 KB | 81 KB | 34 KB | |

One combined file is no smaller than the per-set files added up (curated: 482 KB against 478 KB), so the index ships per set. The largest per-set indexes are `iconmind` 170 KB (31,722 icons), `material-symbols` 132 KB, `material-symbols-light` 130 KB and `mdi` 83 KB, gzip. A linear scan over every curated name takes 17 to 28 ms in Node and over all 213 sets 70 to 85 ms, so no inverted index is needed.

### Shard size

A shard is a run of icons in browse order, closed at 96 icons or 64 KiB of raw JSON, whichever comes first. Browse order is name order, except that a set with categories is laid out in its own category order (each category's icons in listed order, then icons with no category by name), which is what the Iconify API's `/collection` shows today. The tables below were measured in name order; category order changed the curated total by less than 1% (18.47 MB, index 482 KB) and the cross-set search cost by about 10% either way (searching inside `noto` got cheaper: "heart" 262 KB instead of 411 KB), and makes the first screen of an emoji set a screen of faces instead of `1st-place-medal, 2nd-place-medal, a-button-blood-type`. Its cost is the first 160 icons of the heavy emoji sets: `noto` 11 requests and 262 KB instead of 9 and 151 KB, `twemoji` 5 requests and 120 KB instead of 4 and 64 KB. Measured on the curated list. The search column is a cold cross-set query taking the best 48 results and at most 8 per set, over seven queries (home, arrow, rocket, heart, arrow left, server, lock):

| Shard limit | Files | Gzip total | `lucide`, first 160 icons | `noto`, first 160 icons | Cross-set search, requests and gzip |
| --- | --- | --- | --- | --- | --- |
| 256 icons or 192 KiB | 556 | 17.3 MB | 1 request, 11 KB | 3 requests, 148 KB | 14 to 31 requests, 387 to 811 KB |
| **96 icons or 64 KiB** | **1,588** | **18.6 MB** | **2 requests, 8 KB** | **9 requests, 151 KB** | **15 to 35 requests, 156 to 349 KB** |
| 48 icons or 32 KiB | 3,270 | 20.5 MB | 4 requests, 8 KB | 18 requests, 153 KB | 20 to 40 requests, 106 to 205 KB |

Smaller shards trade bytes for requests. 96 and 64 KiB is the middle: file count and size stay near the large-shard figures, and the heavy sticker sets still fetch in about nine requests for a screen of 160. Ordering icons by how many sets share the name was tried at 48-icon shards and was worse (157 to 250 KB against 106 to 205 KB), because hits cluster by name prefix.

### Search cost

The scatter is the real cost. The top 96 results of a cross-set query come from 10 to 19 sets and touch 21 to 59 shards (206 to 636 KB). Taking 48 results instead of 96, at most 8 per set, roughly halves that (15 to 35 shards, 156 to 349 KB) but still costs a shard or more per matching set. So the cold cross-set query is bounded by the design: first 48 results, at most 8 per set, sets in priority order, previews filled in as shards arrive.

A loopback test serving the real files with gzip and a 6-connection agent, for a cold "home", "arrow", "heart" or "lock" query (12 popular indexes, scan, then 15 to 33 shards for 48 results): 42 to 56 ms with no added latency, and 306 to 449 ms with 50 ms added per request. A second query is served from memory and the cache. This is a floor, not a browser measurement; the browser check is in the manual tests.

### Docker image

| Part | Compressed size |
| --- | --- |
| `node:26-alpine` (Docker Hub, amd64) | 64.0 MB |
| Production `node_modules` (`npm ci --omit=dev`, 15.8 MB on disk) | 2.6 MB |
| `server/` and `dist/` (2.5 MB on disk, 1.8 MB of it the source map) | 0.7 MB |
| Today | about 67 MB |
| Curated icons: shards 18.6 MB, index 0.5 MB | +19 MB, about 86 MB |
| All allowlisted: shards 78.3 MB, index 1.9 MB | +80 MB, about 147 MB |

Gzip files do not compress further, so the compressed and on-disk sizes are about the same (curated 21.6 MB on disk with 4 KiB blocks, all 90.1 MB). Shipping the raw JSON beside them would add 82.7 MB (curated) or 310.7 MB (all) on disk for no benefit; the design ships only the gzip files. Adding 22 `@iconify-json/*` devDependencies adds 87 MB unpacked to the build stage and to each CI install (the 9 test jobs and the Docker build), not to the final image. `@iconify/json` would be a 104 MB download on every install, which is why the per-set packages are used.

## Decision

### Curated, not all

The curated list covers the sets people already pick (every `POPULAR_SETS` entry, all three sticker sets) plus common UI, brand and flag sets. "All" is 4.2 times the bytes for a tail of 191 more sets that the picker does not feature, and several of the heaviest are colour and brand sets (`token-branded`, `thesvg-color`, `selfhst`, `game-icons`). The list is a plain file (`scripts/icon-sets.json`), so a set is added by listing it and adding its devDependency.

### Why not all, and not a runtime download

The question was whether "all" could be an opt-in download from our server instead of baked into the image. The server is the image: bytes it can serve either ship in it or arrive from somewhere else at run time.

| Option | Verdict |
| --- | --- |
| Curated baked in (this plan) | Recommended. +19 MB. |
| Build-time opt-in `--all` (reads `@iconify/json`, applies the allowlist) | Cheap to add and the UI follows the manifest. Costs +80 MB, and the build stage downloads 104 MB. Not in this slice. |
| A second image tag with everything (`:full`) | Needs the option above plus a CI job. Not in this slice. |
| Operator builds `dist/icons`-shaped files into `DATA_DIR/icons` and the relay prefers them | No image growth, set choice by the operator. Not in this slice. |
| Relay downloads `@iconify/json` at first start and builds | Outbound network from the server, a build pipeline and 104 MB in the runtime image, a slow cold start. Rejected. |
| Browser downloads sets on demand | Already the design: any hosted set can be fetched whole ("Download for offline"). This is per person, not per instance. |

### Keep the API as an online-only fallback

Dropping it would remove most of the 239 sets the picker lists today and the "200,000+" claim. Instead:

- A hosted prefix never calls the API, for search, browsing, previews or bodies.
- A prefix we do not host works as today (the `api(path, signal)` layer, including whatever error handling and abort support `fix/icons-retry` adds) but only after the person asks for online sets, so opening a drawer makes no request to Iconify. "All icon sets" means all hosted sets.
- The list of online sets is filtered by the same licence rule as the build, so NonCommercial, ShareAlike, copyleft and unclear sets are never offered, hosted or not. Today they are all offered.
- The content security policy and the service worker's Iconify rule are unchanged.

## Build step

`scripts/build-icons.mjs` is plain Node ESM with no new runtime dependency (`fs`, `zlib`, `crypto`; it must run on Linux, macOS and Windows and on Node 22.13 and later). The pure parts (licence rule, packer, index builder, body check) are exported from `scripts/lib/icons-build.mjs` so the tests import them.

`package.json`: `"build": "tsc --noEmit && vite build && node scripts/build-icons.mjs"` and `"build:icons": "node scripts/build-icons.mjs"`. The order matters: `vite build` empties `dist/`. The script writes `dist/icons/` and nothing else.

**Input.** `scripts/icon-sets.json`:

```json
{
  "sets": ["lucide", "tabler", "ph", "mdi", "material-symbols", "carbon", "heroicons", "logos", "simple-icons", "fluent-emoji-flat", "twemoji", "devicon", "noto", "bi", "ri", "ion", "iconoir", "octicon", "fa6-solid", "fa6-regular", "fa6-brands", "circle-flags"],
  "pinned": ["fluent-emoji-flat:thumbs-up", "…the 16 REACTIONS…"],
  "shard": { "icons": 96, "bytes": 65536 }
}
```

The order is the priority order in the picker and in cross-set search. Each set is read from `node_modules/@iconify-json/<prefix>/`: `icons.json` (icons, aliases, set-wide `width`, `height`), `info.json` (name, author, licence, category, palette, `hidden`) and the optional `metadata.json` (categories). No new environment variable: the set list is this file.

**For each set:**

1. Check the licence (below). A set that fails stops the build with the set, its licence id and the reason.
2. Check every body (below). Any hit stops the build with `prefix:name` and the pattern.
3. Order the icons: category order for a set that has categories, name order otherwise. Aliases that carry a transform (rotate, flip) or a size of their own are turned into icons with their own body (`<g transform>` around the parent body, rotation in 90 degree steps about the view box centre); there are 36 in the allowlisted corpus (`fa` 29, `fluent-emoji-flat` 6, `fluent-emoji-high-contrast` 1), 6 of them in the curated list. The current `iconData` ignores these transforms (a bug), so this fixes hosted sets. Plain aliases stay pointers.
4. Pack names into shards. A shard closes at 96 icons or 64 KiB of raw JSON.
5. Write each shard and index as sorted-key minified JSON, gzip level 9, named by the first 8 hex characters of the SHA-256 of the uncompressed content (not of the gzip bytes: Node's gzip header differs by platform, and the content must hash the same everywhere). The manifest is written the same way but keeps the fixed name `manifest.json`.

**Output** in `dist/icons/`. Files are stored as `<name>.gz`; the URL has no `.gz` (the relay maps it and sets `Content-Encoding`):

```
manifest.json                       set metadata and, per set, its index hash and total shard size
i/<prefix>.<hash>.json              per-set index
s/<prefix>.<n>.<hash>.json          shard n of a set
pin.<hash>.json                     bodies of the pinned names (the 16 reactions)
LICENSES.txt                        every hosted set: name, author, licence id and URL (plain text, not hashed)
```

Manifest:

```json
{ "v": 1, "sets": [
  { "p": "lucide", "name": "Lucide", "n": 1941, "h": 24, "cat": "UI 24px", "pal": false,
    "lic": { "id": "ISC", "title": "ISC", "url": "https://github.com/lucide-icons/lucide/blob/main/LICENSE", "tier": "notice" },
    "au": { "name": "Lucide Contributors", "url": "https://github.com/lucide-icons/lucide" },
    "idx": "3f9a1c07", "sh": 21, "gz": 91234, "raw": 560116 }
], "pin": { "f": "5e6f7a8b", "names": ["fluent-emoji-flat:thumbs-up"] } }
```

`n` is the real icon count from the set file, not `info.total`. `gz` and `raw` feed the offline button ("download 0.1 MB, stores 0.5 MB"). The manifest is small (curated about 8 KB raw) because each set's shard list lives in its index.

Index (`i/<prefix>.<hash>.json`):

```json
{ "n": ["a-arrow-down", "a-arrow-up", "…"],
  "a": [["arrow-down-a", 0], ["flip", 12]],
  "c": { "Arrows": [0, 1, 7] },
  "sh": [["9f8e7d6c", 96], ["1a2b3c4d", 96]] }
```

`n` is in shard order (browse order), `a` lists `[alias, index of the icon it points at]`, `c` maps a category to icon indexes, `sh` is `[hash, icon count]` per shard in order, so the shard of icon `i` is found by prefix sums.

Shard (`s/<prefix>.<n>.<hash>.json`), set defaults once, overrides only where an icon differs:

```json
{ "w": 24, "h": 24, "i": { "home": "<path d=\"…\"/>", "wide": { "b": "<path …/>", "w": 32, "l": -2 } } }
```

Only the body and `width`, `height`, `left`, `top` survive; the rest of the Iconify fields are dropped. `w`, `h`, `l` and `t` default to the set's width, height, 0 and 0.

**Determinism and layers.** Keys and names are sorted, nothing contains a timestamp, and the script sets every output file's modification time to a fixed date, so rebuilding unchanged inputs gives byte-identical files and an identical Docker layer. In the Dockerfile the build stage moves the output out of `dist/` (`RUN npm run build && mv dist/icons /icons`) and the final stage copies `/icons` to `dist/icons` in its own layer, before it copies `dist/`. Because `dist/` no longer contains the icons, they are not copied twice, and an app-only deploy reuses the 19 MB layer instead of pushing it again.

**Dev.** `dist/icons/` must exist for `npm run dev`. `scripts/dev.mjs` runs the script first when `dist/icons/manifest.json` is missing (about 1 s for the curated list), and `vite.config.ts` proxies `/icons` to the relay on 8787. The relay serves `/icons/` without needing `dist/index.html` (today it answers 503 for everything until the app is built).

**CI.** `npm ci` installs the 22 packages in each job (87 MB unpacked, cached by `actions/setup-node`), and the build step costs about 1 s. Dependabot gets its own group for `@iconify-json/*` (monthly, separate from the dev-dependencies group) because icon sets publish often and a bump can rename icons; the tests below catch a renamed reaction.

## Serving

`server/relay.mjs` (about 30 lines), for `/icons/` only:

- If `<file>.gz` exists, send it with `Content-Encoding: gzip`, `Content-Type: application/json` (or `text/plain` for `LICENSES.txt`), `Vary: Accept-Encoding` and its `Content-Length`. A client that does not accept gzip gets the same bytes through `zlib.createGunzip()`, so no uncompressed copy ships.
- Cache headers: `public, max-age=31536000, immutable` for everything with a hash in its name (today only `/assets/` gets this; the rest of the app gets `no-cache`). `manifest.json` and `LICENSES.txt` get `no-cache`.
- A missing file under `/icons/` is a real `404`, not the single-page app's `index.html` with `200`. Without this the client cannot tell "not hosted" from "offline", and an HTML page would be cached as an icon file.
- `serveIcons` does not depend on `dist/index.html`, for the dev server.
- The relay has no rate limit on static files, so the 429 cannot come back from our side. The relay serves no other compressed file today (the 415 KB script goes out raw); this change could be extended to them later and is not.

`public/sw.js`:

- A new branch before the generic same-origin rule, for `/icons/`. Today every same-origin request is cache-first into the shell cache, which would pin an old manifest until `VERSION` changes and would drop 19 MB of icons on every shell version bump.
- `/icons/manifest.json`: network first, falling back to the cached copy, so the first drawer open offline works after one online visit.
- Everything else under `/icons/`: cache first into a dedicated `tabula-icons-v1` cache, storing only `200` JSON responses. Every `match` on that cache, here and in `src/icon-offline.ts`, passes `ignoreVary: true`: the relay sends `Vary: Accept-Encoding`, and a browser-set `Accept-Encoding` is not reliably the same on the stored request, which would otherwise be a silent cache miss.
- The activate step deletes every cache whose name does not start with `VERSION`; it must keep `tabula-icons-v1`.

## Runtime

### Modules

- `src/icons.ts` keeps its public names so `src/ui/library.ts` and `src/ui/stickers.ts` change little. It owns the manifest, the loaded indexes and shards, and the choice between hosted and online.
- `src/icon-search.ts` (new, pure): tokenising and ranking. No DOM and no fetch, so it is tested directly.
- `src/icon-licences.ts` (new, pure): the same licence rule as the build, for filtering the online list at run time. A test runs both over one table of licence ids and requires identical answers.
- `src/icon-offline.ts` (new): Cache Storage download, status and removal.

### API surface

`api(path, signal)` stays as the Iconify API fetch layer. A sibling `local(path, signal)` fetches `/icons/<path>` and returns parsed JSON; it throws on a non-200 status or a non-JSON body, and honours the abort signal. Neither depends on the other's error handling.

```ts
export interface IconSet {
  prefix: string; name: string; total: number; license: string; licenseUrl?: string; attribution: boolean; category?: string;
  hosted: boolean; tier: 'public' | 'notice' | 'attribution'; author?: string; authorUrl?: string; gzBytes?: number; rawBytes?: number;
}
export const POPULAR_SETS: string[];                                   // unchanged

iconSets(signal?): Promise<Record<string, IconSet>>                    // hosted sets, from the manifest; no Iconify request
onlineIconSets(signal?): Promise<Record<string, IconSet>>              // /collections, minus hosted, minus blocked licences; on request only
searchIcons(query, prefix?, limit = 96, signal?): Promise<string[]>    // 'prefix:name'; no prefix = all hosted sets, local
collectionIcons(prefix, limit = 160, signal?): Promise<string[]>       // first names of a set, local if hosted
iconData(full, signal?): Promise<IconData>                             // body and view box; local if hosted, aliases resolved
loadPreviews(names, signal?, onIcon?): Promise<void>                   // NEW: fetch the shards the names live in, six at a time
previewUrl(full): string                                               // sync after loadPreviews
```

Behaviour:

- **Search.** On the first query the indexes of the popular sets are fetched (12 requests, 382 KB), the rest in the background. The scan runs over what has arrived and re-runs as more arrives, so the first results come from `lucide` (9 KB) within one round trip. Ranking: every query token must match; a whole-token match beats a token prefix beats a substring; shorter names first; ties go to the set earlier in the list. An alias hit returns the canonical name, and an icon found by both name and alias appears once. Query terms also match category names, ranked below name matches. The default is the best 48 results with at most 8 per set; "Show more" asks for the next 48. A new query aborts the previous one's requests.
- **Browsing a set.** `collectionIcons('lucide')` is the first `limit` names in browse order: the index plus the first shard or two.
- **Previews.** Tiles stay `<img>`. `previewUrl` returns a `data:image/svg+xml,` URL built from the shard (`encodeURIComponent` of `<svg xmlns xmlns:xlink viewBox width height>` plus `sanitizeSvgBody(body)`; bodies contain `#`, quotes and `<`). `loadPreviews` runs before the tiles are created, or the tiles are created empty and `onIcon` sets each `src` as its shard arrives. For a prefix that is not hosted `previewUrl` returns the Iconify API URL, as today. Why `<img>` and not inline `<svg>`: an image is its own document, so the gradient id collision described in `docs/stickers.md` cannot happen between tiles, scripts cannot run in it, and the tile code and the white tile background (`.icon-tile`) stay as they are. `currentColor` renders black, as it does now. Inline SVG would need `scopeSvgIds` per tile and 160 live SVG subtrees. A `blob:` URL is the alternative if `data:` strings for `noto` (about 9 KB each) show up in memory profiles.
- **Placing.** `iconData` loads the set's index and the shard if they are not already in memory, and returns `{ body, width, height, left, top }` exactly as before; the board stores the same fields, so there is no schema change and old boards are untouched.
- **Reactions.** `pin.<hash>.json` holds the 16 reaction bodies (about 6 KB gzip), so the picker costs one request, not 16, and the service worker can keep it. A test requires the pinned list to equal `REACTIONS`.
- **Memory.** Parsed shards are kept in a least-recently-used map of 64 entries; indexes stay loaded (the curated total is about 2 MB of strings).
- **After a deploy.** A drawer opened before a deploy may hold shard or index hashes that no longer exist. On a `404` for a hashed file the client refetches the manifest and that set's index once, then retries the request.
- **Failure.** If the manifest cannot be fetched, the drawer shows "Icons could not be loaded" with a Retry button. The offline message that says icons need a connection the first time is replaced by one that points to Download for offline.

### UI changes

- Icons tab: placeholder "Search 76,000+ icons" computed from the manifest; the set list is "Popular" and "Hosted sets" (both work offline once downloaded) plus an "Online sets" button below it, which calls `onlineIconSets` and adds an "Online only" group, each labelled `(licence)` as today. The note under the grid keeps its CC BY sentence and adds a Licences link.
- Stickers tab: unchanged apart from the offline row.
- Home footer: "Icons by Iconify" becomes "Icon sets by their authors, see Icon credits" with a button.

## Offline

**Recommendation: Cache Storage through the service worker, not IndexedDB.** Shards are immutable files with hashed names, which is what a URL-keyed cache stores best; the service worker already caches every one the first time it is fetched, so browsing needs no extra code, and "Download for offline" is "fetch every shard URL of this set" with a progress count. IndexedDB would add a schema, a second copy of the data and per-icon queries nobody needs, since a search scans names and a placement needs one shard. Safari's seven-day cap on script-writable storage applies to both stores alike.

- **Which sets.** An offline row in the Icons tab (for the selected set, or "all 22 sets" when All is selected) and in the Stickers tab (the three sticker sets, 6.8 MB). It shows the transfer size and the stored size: Cache Storage keeps the decoded body, so downloading the sticker sets sends about 6.8 MB and stores about 42 MB, and all 22 curated sets send 19 MB and store about 83 MB. Check the stored figure with `navigator.storage.estimate()` in the manual tests.
- **States.** Not downloaded (button with sizes), Downloading n of m with Cancel, Available offline with Remove, Update available (the manifest's index hash for the set differs from the cached one). The state comes from `caches.match` over the set's shard URLs; a small per-device list of downloaded set prefixes, `driftboard:icons-offline` in `localStorage` (existing key prefix; wrapped in try/catch, the UI works without it), says which sets to keep fresh.
- **Updates.** After loading a newer manifest, a downloaded set whose index hash changed re-fetches only the shards that are new and deletes the shard URLs the new index no longer lists. Sets that were only browsed are not pruned. Remove deletes a set's entries; the cache is not cleared as a whole.
- **Guards.** The row is hidden when `caches` is undefined (a page that is not a secure context has no service worker either). Before a download it compares the stored size with `navigator.storage.estimate()` and asks for `navigator.storage.persist()` after the first download, best effort. The download uses the same six-at-a-time limit and the abort signal.
- **Offline without a download.** Anything fetched once is in the cache (shards, indexes, manifest), as the Fontshare and Iconify responses are today.
- **Read-only boards.** The row only touches this device's cache, so it is allowed for viewers; the drawers are already disabled for them.

## Licences and attribution

The build and the client share one rule, keyed on `info.license.spdx` exactly (a value that is not a single id, such as `MIT OR Apache-2.0`, is unknown and blocked):

| Class | SPDX ids | Obligation | What the app does |
| --- | --- | --- | --- |
| public | `CC0-1.0`, `Unlicense`, `0BSD` | none | listed in credits |
| notice | `MIT`, `ISC`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `OFL-1.1` | keep the copyright and licence notice with copies of the data | credits dialog, `LICENSES.txt` shipped in `dist/icons/` |
| attribution | `CC-BY-3.0`, `CC-BY-4.0` | credit the author, link the licence, say if changed | the existing drawer note ("licensed CC BY and need attribution when you publish"), plus the credits dialog |
| blocked | anything else | | not built, not offered, even online |

Blocked in particular: any id containing `-NC` or a title containing "NonCommercial" (checked on its own as well, so an allowlist edit cannot let one through), `-SA-` ShareAlike (the stickers spec already left OpenMoji out for this), GPL, LGPL, AGPL, MPL and EPL families, a missing `spdx`, any other id, and any set with `hidden: true`.

- **Credits.** A dialog (new `src/ui/icon-credits.ts`, opened from the Icons and Stickers notes and the home footer) lists the hosted sets from the manifest by class: name, author link, licence id linking to the licence. `LICENSES.txt` is the same list as plain text. Per-set packages do not ship licence texts (the nine files in `@iconify-json/lucide` have none), so the notice is the id and the upstream URL; whether that is enough is an open question.
- **Brand logos.** `logos`, `simple-icons` and `devicon` are CC0 or MIT as artwork, but the marks are trademarks of their owners. The licence metadata does not say so. Not decided here.
- **Unchanged.** Exports carry no credit line (as in `docs/stickers.md`).

## Security

- **Build gate.** The script fails the build if any body, in any set it hosts, matches: `<script`, `<foreignObject`, `<iframe`, `<object`, `<embed`, an `on*=` attribute, `javascript:`, `<image`, `<style`, a `data:image`, an external `href` or `url(http`, or an animation element that targets `href`. The scan of all 357,248 allowlisted bodies found none of these. It found 1,489 bodies with `<animate>` or `<set>` elements in `line-md`, `meteocons`, `svg-spinners` and `eos-icons`, none in the curated list; those sets would pass the gate only if nothing animates `href`.
- **Supply chain.** Versions are pinned by `package-lock.json` and reviewed by Dependabot's own group and the dependency-review check. The relay serves only bytes the build produced.
- **Run time.** Bodies still go through `sanitizeSvgBody` before they are shown or placed, and `scopeSvgIds` still runs in `iconMarkup`. Nothing about the board path changes. A hosted preview is an `<img>` with a `data:` URL, which the content security policy already allows (`img-src ... data:`), and an SVG loaded as an image cannot run script.
- **Privacy.** Searching hosted sets sends nothing to a third party. Online sets send the query to Iconify, only after the person asks for them.
- **Cache poisoning.** The service worker stores only `200` JSON responses under `/icons/`, and the relay no longer answers a missing icon file with `200` HTML.

## Tests

Automated (`npm test`, vitest):

- `test/icons-build.test.ts` (new):
  - the licence rule: each allowed id gives its class; CC-BY-NC-4.0, CC-BY-NC-SA-4.0, CC-BY-SA-4.0 and 3.0, GPL-2.0-only, GPL-3.0-or-later, MPL-2.0, `MIT OR Apache-2.0`, an empty string, a missing licence and `hidden: true` are blocked;
  - the packer: every icon lands in exactly one shard, in name order, both limits hold, and a single oversized body gets its own shard;
  - defaults and overrides: an icon with the set's width and height has no `w` or `h`; `left` and `top` survive; the shard round-trips to the source body;
  - the index: alias positions point at the right icon, a nested alias resolves, a dangling alias is dropped, a transformed alias becomes an icon whose body wraps the parent's, categories become index lists, and the shard list adds up to `n`;
  - the body gate fails on `<script`, `onload=`, `javascript:`, `<foreignObject`, `<style` and an external `href`, and passes ordinary bodies;
  - a build over a two-set fixture (a temp directory shaped like `node_modules/@iconify-json`): the manifest, the file names, `.gz` contents, a second build giving byte-identical output, and a failure for a blocked licence.
- `test/icon-search.test.ts` (new): exact token over prefix over substring, several tokens, alias and category hits, set-priority ties, the per-set cap and the limit, an empty query, and canonical names with no duplicates.
- `test/icons-client.test.ts` (new, a stub `fetch`): `iconData` returns the set's defaults and resolves an alias; an HTML body with status 200 and a 404 are errors; a hosted prefix makes no request to an Iconify host while an online prefix does; the abort signal cancels in-flight loads; `previewUrl` is a `data:image/svg+xml` URL, carries the view box, and has a `<script>` stripped; `licenceTier` agrees with the build rule over the shared table; the offline status with a fake `caches`.
- `test/relay-icons.test.ts` (new, a relay on a fixture `DIST_DIR`): a hashed shard returns gzip with `immutable` when gzip is accepted and plain bytes when it is not; `manifest.json` is `no-cache`; a missing `/icons/` path is `404` with a JSON body, not `index.html`; `/icons/` works with no `index.html`.
- `test/stickers.test.ts` (extended): build the curated list into a temp directory from the installed packages (about 1 s) and check that every `STICKER_SETS` and `POPULAR_SETS` prefix is hosted, that all 16 `REACTIONS` resolve and equal the `pinned` list, and that the total gzip size stays under a budget of 21 MB (about 10% above the 19 MB measured, so an accidental addition is noticed and a deliberate one raises the number).

Manual, in the dev server and in a built image:

- Network tab, filter `iconify`: opening the Icons and Stickers drawers, searching, browsing and placing from hosted sets makes no request to an Iconify host. Choosing an online set does.
- Throttle to Fast 4G, clear the cache, search "arrow" across all sets: results appear within about a second and previews fill in as shards arrive; repeat for the loopback figure of 306 to 449 ms at 50 ms per request.
- Go offline after one visit and reload: the drawer opens, searches and previews what was visited. Download a set, go offline, clear the HTTP cache: the whole set works.
- Download the three sticker sets and compare `navigator.storage.estimate()` before and after with the 42 MB stored estimate. Remove and check it shrinks.
- Place one icon from each of `lucide`, `fluent-emoji-flat`, `noto` and an alias-with-transform icon, then compare the placed body with the old API's.
- Reaction picker opens with one request, and a reaction places.
- Each theme: tiles stay white with dark icons.
- Docker: `docker build`, then compare `docker image ls` with the figures above (not measured in this plan).
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass; `npm run build` leaves `dist/icons/` with the manifest.

## Not in this slice

- **"All" sets**: the `--all` flag, a `:full` image, an operator-provided `DATA_DIR/icons`. All sit on the same manifest and need no client change.
- **Credit lines in exports and a "credits used on this board" list.**
- **Brotli**, HTTP/2 on the relay, compressing the app's own script and stylesheet.
- **Storing compressed shards in the cache** (4 to 6 times less stored space, a decompress per read).
- **Search in a worker.** The scan is 17 to 28 ms for the curated list and 70 to 85 ms for all 213 sets.
- **Synonyms and fuzzy matching.** Matching is on names, aliases and categories only.
- **Alias transforms on the online path.** The Iconify fallback keeps ignoring them, as today.
- **A size limit for a placed body.** `devicon:nano-wordmark` is 350 KB in every board that uses it; that already happens today.
- **Trademark guidance for logo sets and a decision on sets Iconify files under "Archive / Unmaintained"** (see questions).
- **Removing the Iconify API.** It remains the online fallback.

## Files

NEW:

- `docs/icons-selfhost.md`: this plan.
- `scripts/build-icons.mjs`, `scripts/lib/icons-build.mjs`: the build step and its pure parts.
- `scripts/icon-sets.json`: the set list, pinned names and shard limits.
- `src/icon-search.ts`, `src/icon-licences.ts`, `src/icon-offline.ts`: pure search, the licence rule, Cache Storage.
- `src/ui/icon-credits.ts`, and the offline row (in `src/ui/icon-offline.ts`).
- `test/icons-build.test.ts`, `test/icon-search.test.ts`, `test/icons-client.test.ts`, `test/relay-icons.test.ts`.

EXISTING (one line each):

- `package.json`, `package-lock.json`: `build` and `build:icons` scripts; 22 `@iconify-json/*` devDependencies.
- `src/icons.ts`: manifest, hosted and online paths, `loadPreviews`. The Iconify host list, failover and `setIconHost` stay for the online path (nothing calls `setIconHost` today).
- `src/ui/library.ts`: the Icons tab calls `loadPreviews`, the Online sets button, the offline row and the licences link; `dropItem` is unchanged.
- `src/ui/stickers.ts`: `loadPreviews` for the grid and the reaction picker, the offline row.
- `src/ui/home.ts`: the footer credit.
- `src/styles.css`: the offline row and progress, theme variables only.
- `public/sw.js`: the `/icons/` branch and the activate filter.
- `server/relay.mjs`: `serveIcons` (gzip mapping, cache headers, 404).
- `vite.config.ts`: dev proxy for `/icons`. `scripts/dev.mjs`: build icons when missing.
- `Dockerfile`: the build stage moves `dist/icons` aside and the final stage copies it as its own layer.
- `.github/dependabot.yml`: a group for `@iconify-json/*`.
- `README.md`: the Iconify row, "downloadable offline icon sets" leaves the not-built list, the project layout. `CHANGELOG.md`: an Unreleased Added entry. `docs/stickers.md`: the Offline section, which describes the old service-worker behaviour.

Untouched: `src/app.ts`, `src/render.ts`, `src/markup.ts`, `src/stickers.ts`, `src/store.ts`, the board format and schema version.

## Decisions and open questions

Proposed, awaiting a yes:

1. Curated list of 22 sets baked in; "all" is not baked in.
2. Hosted sets never call the Iconify API; other sets are online-only, on request, and licence-filtered.
3. Gzip only; the relay serves the `.gz` files with `Content-Encoding`.
4. Shards of 96 icons or 64 KiB, in category order where a set has categories and name order otherwise; search results capped at 48 and 8 per set.
5. Cache Storage via the service worker; no IndexedDB.
6. Previews are `data:` URLs in `<img>`.
7. The allowlist in the licences table, with `hidden` sets blocked.
8. No new environment variable; the set list is `scripts/icon-sets.json`.

Open:

- The three Font Awesome 6 sets (CC-BY-4.0) are filed by Iconify under "Archive / Unmaintained". Keep them for recognition, or swap in a maintained set such as `fluent` (2.5 MB gzip) or `solar` (2.3 MB, CC-BY-4.0)?
- `logos`, `simple-icons` and `devicon` are trademarks. Fine to host, as they are in `POPULAR_SETS` today?
- Is "licence id plus upstream URL" enough notice for MIT, Apache-2.0 and OFL sets, or should the build also bundle each licence text (the per-set packages have none, so it would be a list kept in the repo)?
- Is OFL-1.1, written for fonts, acceptable for icon data? It is 7 built sets and 0.5 MB.
- Is the online fallback wanted at all, given the privacy line, or should unhosted sets simply go away?
- Is a `:full` image tag worth a CI job, or is the build-time flag enough?
- `fix/icons-retry` rewrites the top of `src/icons.ts`. Which lands first? This plan assumes that branch merges first and the work here rebases onto its `api(path, signal)`.
