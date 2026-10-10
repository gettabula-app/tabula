# Desktop app (Tauri 2)

A desktop build of Tabula: the existing web app in a native window, with `.drift` files opening in it. No rewrite: the shell loads the output of `npm run build`. The web code stays one code base; what only the desktop needs lives in `src/desktop*.ts` and is loaded only there.

Status: Phase 1, the local-first desktop MVP (TAB-100), is built and was checked on macOS. Windows and Linux were not built or run: what this page says about them is read from sources or documentation. Signing, auto-update, a release pipeline, accounts mode and a real app icon do not exist yet (see "Phased plan" for what is done and what is not).

How to read the claims below. Each non-obvious one carries a tag:

- **Verified**: I ran it on macOS 15.1 (arm64; the Phase 1 checks on 15.1.1) with the pinned versions.
- **Source**: read in the sources of the pinned crates (`tauri` 2.12.1, `tauri-utils` 2.10.1, `tao` 0.37.1, `wry` 0.57.0), not run.
- **Docs**: stated in the vendor documentation fetched on 2026-10-08, not run.
- **Unverified**: recollection or inference. Check before relying on it.

## Summary

- Tauri 2 works for this app with no frontend changes to get a window up. IndexedDB, localStorage and a cross-origin font catalogue fetch all work inside the macOS webview (WKWebView). **Verified**
- Boards persist across restarts in `~/Library/WebKit/<identifier>/` on macOS. The origin is `tauri://localhost`. **Verified**
- `.drift` association works on macOS: the bundle declares the type and the running or cold-starting app receives the path, and the page now imports it as a new board (one file or several, at launch or while running). The same Rust code handles the Windows and Linux route (path in `argv`, a second launch forwards its `argv` to the first). **Verified** on macOS, including the second-process route simulated by running the binary again; the Windows installer part is **Docs**.
- Local-only mode is the default on every platform: in the desktop app `auto` means off (`isDesktop()` in `relayUrl()`), which matters on Windows where the origin is `http://tauri.localhost` and `auto` would loop on `ws://tauri.localhost/sync`. An address typed in Board settings still connects. **Source** and unit tests; the Windows case was not run.
- Safari's cap on script-writable storage does reach this app, but with a longer window than the 7 days in the headlines. WebKit tracks `tauri://localhost` (as the domain `localhost`) and, when its record says the last interaction is older than 30 *operating days*, deleted IndexedDB and localStorage within seconds of launch in a test with a doctored statistics database. **Verified** on macOS 15.1.1; real elapsed time, Windows and Linux are not. Details and the escape hatch below.
- The escape hatch is built and was tested end to end: the app keeps a `.drift` copy of every board in its data folder, restores boards that storage lost, and merges the copy into a board that opens empty. See "Safety net: board backups".
- Exports in the desktop app open a native Save dialog and write the file from Rust (`save_export`). The dialog appears (**Verified**); picking a path and writing was not exercised (no way to operate the dialog from here).
- Accounts mode (and so hosted workspaces) does not work from a bundled frontend without server and client changes: cookies, `Origin` checks and CSRF all assume the page is served by the relay. Open mode works today by typing a `wss://` relay URL into Board settings. See "Pointing at a relay".
- Recommended updates: `tauri-plugin-updater` with a static `latest.json` on GitHub Releases, behind a domain you control. Signing costs: Apple Developer Program US$99 a year; Windows from about US$10 a month (Azure Artifact Signing, if you are eligible) to a few hundred dollars a year for a certificate.
- Biggest open product question: is the desktop app for hosted (accounts mode) customers? If yes, phase 3 below is mandatory and large. If it is a local-first app with optional self-hosted relays, it is small.

## What is in the repo

```
desktop/src-tauri/
  Cargo.toml            tauri, tauri-build, tauri-plugin-single-instance, tauri-plugin-dialog, all pinned with =
  Cargo.lock            committed (it is an application)
  build.rs              tauri_build::build()
  tauri.conf.json       window, CSP, bundle, .drift association
  capabilities/default.json   core:default for the main window
  src/main.rs           shell, the opened-file glue, the save_export command, their unit tests
  src/backup.rs         board backups: id check, atomic write, list, read, delete, unit tests
  icons/                six desktop icons made from public/favicon.svg
src/
  desktop-env.ts        isDesktop() and storedWhere(): the only desktop code in the main bundle
  desktop.ts            the glue, imported dynamically and only when isDesktop(): opened files, backups, native save
  desktop-logic.ts      the decisions behind it, free of Tauri and the DOM, so the tests can run them
test/desktop-*.test.ts  environment and relay, locked settings, logic with a fake shell, backups and storage
```

Ignored: `desktop/src-tauri/target/` and `desktop/src-tauri/gen/` (`.gitignore`), and `desktop/src-tauri/target` for oxlint (`.oxlintrc.json`). `tsconfig.json` only includes `src` and `test`, and vitest finds no tests under `desktop/`, so the web checks do not see it.

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | `tauri dev`: starts `npm run dev` (relay on 8787 and Vite on 5173 by default) and opens a window on the selected Vite port. Set `PORT` and `VITE_PORT` to distinct available ports for concurrent sessions; the window follows `VITE_PORT`, and Vite fails clearly if that port is occupied. Since Phase 1 `auto` means off in this window too, so it no longer reaches the Vite-proxied `/sync`: to test sync in dev, type `ws://localhost:<VITE_PORT>/sync` in Board settings |
| `npm run desktop:build` | `tauri build`: runs `npm run build:app` (typecheck plus Vite, no icon sets), embeds `dist/` and bundles `app`, `dmg` and `nsis` for the host OS |
| `npm run desktop:build -- --bundles app` | Only the `.app` (skips the DMG step, which drives Finder through AppleScript) |

Needs Rust 1.90 or newer (`rust-version` in `Cargo.toml`), Xcode command line tools on macOS, and the MSVC build tools plus WebView2 on Windows. CI does not build it yet. The web side has two Tauri packages, both exact: `@tauri-apps/cli` 2.12.1 in `devDependencies` (`npm ci` downloads its platform binary) and `@tauri-apps/api` 2.12.1 in `dependencies`. The API package must stay equal to the `tauri` crate (the CLI warns on a mismatch); the web build puts it in its own lazily loaded chunks (`core-*.js`, `event-*.js`, next to `desktop-*.js`), which the browser never requests: the main chunk contains no Tauri code and only the one `'__TAURI_INTERNALS__' in window` test.

Pinned versions: `@tauri-apps/cli` 2.12.1, `@tauri-apps/api` 2.12.1, `tauri` 2.12.1, `tauri-build` 2.7.1, `tauri-plugin-single-instance` 2.5.2, `tauri-plugin-dialog` 2.8.1 (it brings `tauri-plugin-fs` and `rfd` as its own dependencies; the app uses neither directly), plus `wry` 0.57.0 and `tao` 0.37.1 through `Cargo.lock`. Tauri 3 exists only as alpha (`3.0.0-alpha.4`, the dialog plugin has 3.0.0-alpha.3); it is not used. Tauri 1 config (`tauri.allowlist`) does not apply: v2 uses capabilities and plugins.

The commands the page can call (all defined in `src/main.rs`; Tauri lets a page call an app's own commands without a capability entry):

| Command | Use |
| --- | --- |
| `take_opened_files`, `read_opened_file` | `.drift` files the system asked us to open; reading is limited to those paths |
| `backup_board` | writes `<local app data>/backups/<id>.drift` from the raw request body (the board id in the `x-board-id` header) |
| `list_backups`, `read_backup`, `delete_backup` | ids that have a backup; one backup's bytes; remove one |
| `save_export` | shows the Save dialog (suggested name in `x-file-name`), writes the raw request body to the file picked, returns the path or null if cancelled |

Bytes go over the IPC as a raw body (`invoke(cmd, Uint8Array, { headers })`), not as a JSON array of numbers, which matters for an image or board of several megabytes.

### Choices in `tauri.conf.json`

- **`identifier`: `app.tabula.desktop`.** A placeholder. Use a reverse-DNS name you own and then never change it: it names the data folders (below), the signing identity and the Windows install key. Locked, see below.
- **`version`: `../../package.json`**, so the app version has one source. **Source** (`tauri-utils` accepts a path); `cargo check` passes with it.
- **`build.frontendDist`: `../../dist`**, embedded at compile time. Run `npm run build:app` first when calling `cargo` directly; `tauri build` does it through `beforeBuildCommand`.
- **No hosted icon sets in the desktop bundle.** `beforeBuildCommand` runs `build:app`, not `build`, so `dist/icons/` (about 92 MB of `.gz` files, see `docs/icons-selfhost.md`) is not embedded: the shell's static server cannot send them with `Content-Encoding: gzip`, and they would quadruple the app's size. Without a relay the Icons and Stickers drawers have no manifest and show their could-not-load message with Retry; icons already on a board still draw, since a placed icon carries its own SVG. Revisit when the desktop app talks to a relay or decompresses in the shell.
- **`useHttpsScheme`: `false`, written down on purpose.** It decides the Windows origin (`http://tauri.localhost` or `https://tauri.localhost`). Changing it between releases makes existing IndexedDB, cookies and localStorage unreachable. **Docs**. Locked, see below.
- **`dragDropEnabled`: `false`.** By default Tauri replaces the webview's drag and drop handler, which on Windows disables HTML5 drag and drop. The board relies on it (dropping a `.drift` or a shape onto the canvas, `src/ui/board.ts`). **Docs**
- **CSP**: the relay's header (`server/relay.mjs`, `CSP`) does not exist in the bundle, so the same policy is set in `app.security.csp`, plus `ipc: http://ipc.localhost` in `connect-src` (Tauri does not add it for you). **Source**. Tauri adds nonces or hashes only when the HTML has inline `<style>` or `<script>`, and only then does `'unsafe-inline'` stop working; the built `index.html` has none. **Source**. The Fontshare catalogue request succeeded under this policy. **Verified**. I did not look at the rendered UI (no screenshot of the app window was taken), so inline `style` attributes under the policy are inferred, not seen.
- **`bundle.macOS.minimumSystemVersion`: `12.3`.** The app calls `crypto.randomUUID()` (`src/sync.ts`), which needs Safari 15.4. A guess to confirm against the browsers you support; the default would be 10.13. **Unverified**
- **`bundle.targets`: `app`, `dmg`, `nsis`.** NSIS builds per-user installs and needs no admin rights. MSI needs WiX and a Windows host. **Docs**
- **Icons** come from `public/favicon.svg`, which has its rounded corners baked in. A real app icon (full-bleed square for macOS, a document icon for `.drift`) is a design task.
- **`capabilities/default.json` is `core:default` and nothing else.** The dialog plugin is registered for the Rust side only and gets no `dialog:*` permission, so the page cannot open dialogs or name a path to write; it can only call `save_export`, which shows the dialog itself.
- **`updater` is not configured.** Turning on `createUpdaterArtifacts` makes every `tauri build` demand a signing key, which this spike must not hold.

### Locked settings

Two settings decide where a user's boards live, and nothing in the app would notice a change: it would start up empty, with every board still on disk but out of reach.

| Setting | Locked value | Why |
| --- | --- | --- |
| `identifier` | `app.tabula.desktop` (a placeholder until the owner picks the final one) | Names the webview data folder on every platform, the app data folder that holds the board backups, the signing identity and the Windows install key |
| `app.windows[main].useHttpsScheme` | `false` | Decides the Windows origin, `http://tauri.localhost` or `https://tauri.localhost`; IndexedDB and localStorage belong to the origin |

`test/desktop-config.test.ts` reads `desktop/src-tauri/tauri.conf.json` and fails, with the reason, if either changes. The only legitimate edit is choosing the final identifier **before the first public release**, in the same commit as the test. Also never switch to a custom data store (`dataDirectory`, `dataStoreIdentifier`) and never change the origin in any other way; "Offline storage" lists the rest.

### What was run

| Command (in the worktree) | Result |
| --- | --- |
| `cargo check --all-targets` in `desktop/src-tauri` | passes, 29 s warm |
| `cargo test` | 3 tests pass (argument parsing, including a Windows path and `file://` URLs) |
| `cargo clippy --all-targets` | no warnings |
| `npm run desktop:build -- --debug --bundles app` | builds `Tabula.app` (24 MiB debug); `beforeBuildCommand` ran the web build from the repo root |
| `npm run desktop:build -- --bundles app` | release `Tabula.app`, 8.9 MiB, arm64 only, unsigned, 1 min 35 s with a cold release cache |
| `VITE_PORT=5174 PORT=8788 npm run desktop:dev` | selects the same Vite port for the server and window; not run in this audit |
| `npm run lint`, `npm run typecheck`, `npm test` | pass; 39 test files, 1698 tests. The web checks are unaffected by `desktop/` |

Phase 1 (macOS 15.1.1, arm64; the harness was a temporary debug build that reported over a local WebSocket and posted key events to the process, none of it committed):

| Command or check | Result |
| --- | --- |
| `cargo check --all-targets`, `cargo clippy --all-targets`, `cargo test` in `desktop/src-tauri` | pass, no warnings; 13 tests (opened-file arguments, board id and path rules, atomic write, list and delete, the suggested file name) |
| `npm run lint`, `npm run typecheck`, `CI=true npm test`, `npm run build` | pass; 47 test files, 1846 tests (50 of them are new, in the four `test/desktop-*.test.ts` files) |
| Main bundle against the commit before Phase 1 | 435.7 kB to 438.3 kB (142.1 kB to 143.3 kB gzip): the environment check, the delete hook, `writeLocalBoard`, `importBoardFile`, the settings text. No Tauri code in it |
| Everything in "Safety net", "Storage purge", "Opened files" and "Manual checks" tagged **Verified** | run in the debug `Tabula.app` |

Not run: a DMG, a universal binary, anything on Windows or Linux, any signing or notarization, an end-to-end relay connection from the desktop app, clicking or typing with a real pointer or keyboard, any screenshot of the window.

### Known advisory: `glib` (Linux only)

Dependabot alert GHSA-wrw7-89jp-8q8g (unsoundness in `glib::VariantStrIter`, fixed in `glib` 0.20.0) names `glib` 0.18.5 in `desktop/src-tauri/Cargo.lock`. It comes in through tauri, tao, muda and wry, the Linux GTK3 backend, and is compiled only for Linux: `cargo tree -i glib --target aarch64-apple-darwin` and `--target x86_64-pc-windows-msvc` print nothing. The app bundles `app`, `dmg` and `nsis` only, and our Rust code does not use `glib`. It cannot be bumped on its own, because wry 0.57 and tauri 2.12 need the gtk 0.18 bindings, which need `glib` 0.18. Re-checked on 2026-10-10 against crates.io: the fixed bindings exist (`gtk` 0.19.0 uses `glib` ^0.22), but nothing we depend on can use them yet. The newest `tao` (0.37.1), `wry` (0.57.0), `webkit2gtk` (2.0.2) and `tauri` 2.x (2.12.2) all still require `gtk` ^0.18, so bumping Tauri alone does not move `glib`, and overriding the version in `Cargo.lock` or with `[patch]` would mean building the Linux backend against an API it was not written for. The alert is therefore not fixable from our side; the proposal is to dismiss it as "vulnerable code is not used" (a Linux-only transitive dependency in a build we do not ship, and our code never calls `glib::VariantStrIter`), and to re-check when `tao` and `wry` release on `gtk` 0.19 or when we move to Tauri 3, or before any Linux build is added.

## `.drift` file association

Configured in `bundle.fileAssociations`:

```json
{ "ext": ["drift"], "name": "Tabula board", "description": "Tabula board",
  "mimeType": "application/x-tabula-board", "role": "Viewer", "rank": "Owner",
  "exportedType": { "identifier": "app.tabula.board", "conformsTo": ["public.data"] } }
```

`role` is `Viewer` because opening a file imports a copy as a new board (`home.ts` `boardFileInput`), it never saves back. `exportedType` declares our own type on macOS; without it the extension would map to a dynamic type. The mime type is made up (`x-`) on purpose: `application/zip` would claim every zip file on Linux.

**Verified**: the built `Info.plist` has `CFBundleDocumentTypes` (extension `drift`, role Viewer, rank Owner, content type `app.tabula.board`) and a `UTExportedTypeDeclarations` entry, and LaunchServices resolved a `.drift` file to `app.tabula.board` after the app was registered.

### How the file reaches the app

| Platform | At launch | While the app runs |
| --- | --- | --- |
| macOS | `RunEvent::Opened { urls }` (`file://` URLs). There is no argv. **Verified**: raised from `application:openURLs:` in `tao`, cfg `macos`, `ios`, `android` | The same event, in the running process. **Verified** with `open -a Tabula.app file.drift`, including a path with a space |
| Windows | The installer registers the extension (how the NSIS and WiX templates do it is **Unverified**); Tauri's own file-association example reads the path from `std::env::args()` (**Source**: the example in the Tauri repository) | Each double click starts a new process. `tauri-plugin-single-instance` ends it and passes its `argv` to the callback of the first. **Verified** by running the binary a second time with arguments (the first received only the `.drift` path, flags and other files dropped); the Windows window-message transport underneath is **Docs** |
| Linux | Same as Windows; file managers may pass `file://` URLs | Same as Windows |

The deep-link plugin is for custom URL schemes (`tabula://...`), not for file associations. It is not needed here. It would matter later for sign-in links.

`src/main.rs` implements the receiving half (about 60 lines):

- `drift_paths(args)` keeps `.drift` paths, decodes `file://` URLs, drops other URLs and flags, and does not mistake `C:\x\a.drift` for a URL (the Tauri example does, since `Url::parse` accepts a drive letter as a scheme).
- `receive()` records each path in managed state (`pending` and a `granted` set) and emits an `opened-file` event. The page may not exist yet at a cold start, so it also pulls.
- Two commands: `take_opened_files()` returns and clears `pending`; `read_opened_file(path)` returns the bytes (a raw `ipc::Response`) only for a path in `granted`, so the page cannot read arbitrary files.
- The command allowlist matters more if the window ever loads remote content (see option B below): then restrict IPC with a capability `remote` scope.

### The web side

Done in Phase 1, in `src/desktop.ts` (the wiring) and `src/desktop-logic.ts` (the decisions, unit-tested with a fake `invoke`). `main.ts` imports `desktop.ts` dynamically when `isDesktop()` and waits for it before the first route, so boards that were restored and files the system opened are already there when the first screen is drawn.

- `startDesktop()` registers the `opened-file` listener first and only then calls `take_opened_files`, so a file that arrives in between is seen by one of the two. Calls queue, so the event firing during the startup batch does not run two imports at once.
- Each file is read with `read_opened_file`, wrapped in a `File` and handed to the existing import path: `importBoardFile()` (the former body of the file input handler in `src/ui/home.ts`, now exported and used by both) reads it with `readBoardFile`, makes a new board id, lists it and calls `nav.open(id, { imported })`. `main.ts` applies the content with `applyImported()` (moved out of `route()` into `src/exporters.ts` unchanged, so the browser path is the same code). **A file is imported as a copy**, as in the browser; there is no save back to the file.
- With several files in one batch only the last one is opened; the others are written into storage under new ids (`writeLocalBoard`) and show up in the list. A file that fails (not a board, newer schema) gives a toast naming the file and does not stop the others.
- **Verified** on macOS: `open -a Tabula.app file.drift` while the app runs (new board opened with its two objects, its backup written), a cold start with two files at once, one of them with spaces in the name (both imported, the second opened, the first openable from the list with its content).
- Windows and Linux use the same code through `argv` and the single-instance callback; the web side is identical. Several files double-clicked at once on Windows start several processes that each forward one path, so the page sees them as separate batches and opens the last; the earlier ones may be opened before it is replaced. Not run.

## Offline storage

The app keeps boards in IndexedDB through `y-indexeddb` (`src/sync.ts`): `driftboard:<id>` for the board and `driftboard:<id>~comments` for its comments. Identity, the board index and the relay setting are in localStorage (`driftboard:user`, `driftboard:boards`, `driftboard:relay`). The `driftboard` prefix is intentional and unchanged.

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Engine | WKWebView | WebView2 (Chromium) | WebKitGTK |
| Origin | `tauri://localhost` **Verified** | `http://tauri.localhost`, or `https://` with `useHttpsScheme` **Docs** | `tauri://localhost` |
| Data folder | `~/Library/WebKit/<identifier>/WebsiteData/Default/<hash>/<hash>/{IndexedDB,LocalStorage}`, caches in `~/Library/Caches/<identifier>` **Verified** | Tauri forces the webview data directory to `%LOCALAPPDATA%\<identifier>` **Source**; WebView2 keeps its profile in `EBWebView` below it **Unverified** | `~/.local/share/<identifier>` **Source** |

**Verified** on macOS: opening a board created two databases (`driftboard:<id>` and `driftboard:<id>~comments`, one SQLite file each), localStorage held `driftboard:boards`, `driftboard:user` and `driftboard:fontshare-catalogue`, and all of it was still there after quitting and relaunching twice. I removed that test data afterwards.

What must stay stable or users lose their boards:

1. **The origin.** `tauri://localhost` on macOS and Linux; on Windows the scheme (`http` or `https`) set by `useHttpsScheme`. Never change either. Moving a user's data across origins is not possible from the web side.
2. **The `identifier`.** It names the folders above and the backup folder, so renaming the app's identifier orphans the data. Locked by a test, see "Locked settings".
3. **No switch to a custom data store.** `dataDirectory` and `dataStoreIdentifier` (macOS 14+) point the webview at a different store. **Docs**
4. **Dev and production are different stores.** `desktop:dev` runs on the selected Vite port (`5173` by default), a different origin, so boards made there do not show up in an installed build. This follows from the origin rule; I did not inspect the dev run's folder (an unbundled binary has no bundle identifier, so WebKit probably names it after the executable). **Unverified**

### Storage purge (the 7 day rule)

The question: Safari deletes a site's script-writable storage (IndexedDB, localStorage, media keys, session storage, service worker registrations and caches) when the site goes unused. Does that reach a WKWebView app on a custom scheme, where "the site" is `tauri://localhost`? Waiting a week to find out was not an option, so this was read from the WebKit sources and then tested by doctoring WebKit's own bookkeeping.

**Conclusion.** The mechanism applies to this app. The window is not 7 calendar days but 30 *operating days* without a logged user interaction, and the check ran on macOS 15.1.1 as described below. The practical exposure is small, because operating days only count while the app runs (an app left alone for months does not age) and every real use is an interaction, but it is not zero and the cost of being wrong is every board. So the backup stays (next section), whatever the answer.

What was found, in the order of the argument:

1. **The rule as published.** **Docs** (WebKit blog, "Full Third-Party Cookie Blocking and More", 24 March 2020): ITP deletes "all of a website's script-writable storage after seven days of Safari use without user interaction on the site". Home screen web apps have their own counter. The post says nothing about WKWebView or apps that embed web content; Apple forum answers and blog posts disagree and none is official. **Unverified** as a source of truth.
2. **wry does not touch the storage policy.** **Source** (wry 0.57.0, `src/wkwebview/mod.rs`, lines 224 to 247): the webview gets `WKWebsiteDataStore.defaultDataStore`, or the non-persistent store in incognito, or a store from `data_store_identifier` on macOS 14 and later. Tauri sets none of them here, and nothing sets tracking-prevention options.
3. **ITP is on for an app that is not a browser.** **Source** (WebKit `Source/WebKit/Shared/Cocoa/DefaultWebBrowserChecks.mm`, `determineTrackingPreventionStateInternal`, main branch on 2026-10-08): for a non-browser app, tracking prevention is on if the app was linked against an SDK new enough to have "session cleanup by default" and the app has not asked for cross-website tracking permission (`NSCrossWebsiteTrackingUsageDescription`). **Verified**: after one start, `~/Library/WebKit/<identifier>/WebsiteData/ResourceLoadStatistics/observations.db` exists.
4. **The origin is tracked.** **Verified**: that database has a row `localhost` in `ObservedDomains` (the registrable domain of `tauri://localhost`), next to `127.0.0.1` and `fontshare.com`. **Source**: `WebsiteDataStoreCocoa.mm` sets `shouldIncludeLocalhost` only for Safari, which makes the store skip `localhost` when classifying trackers; the code that chooses domains for deletion (`registrableDomainsToDeleteOrRestrictWebsiteDataFor`) loops over every row and has no scheme or localhost test, and the test below shows it deletes.
5. **The window.** **Source** (`ResourceLoadStatisticsStore.cpp`): first-party data is removed when the domain's last user interaction is older than the window; the window is 30 operating days (`operatingDatesWindowLong`), or 7 for domains scheduled with a short frequency (bounce-tracking classification), and `localhost` here has the long one. An *operating day* is a calendar day on which the store was opened (an app start) or a user interaction was logged; days without either do not count. A domain that never had an interaction is eligible too, but a deletion run is only allowed once the oldest recorded interaction anywhere in the store is more than an hour old, so a store with no recorded interaction at all deletes nothing. This is the main branch, not necessarily what macOS 15.1.1 ships, which is why the next step exists.
6. **Test with a doctored database.** **Verified** on macOS 15.1.1, debug `Tabula.app`, with a board stored and the app quit between steps: I edited `observations.db` with sqlite3 so that `localhost` had `hadUserInteraction = 1` and a given interaction time, and so that 40 earlier operating days existed (41 in all). Then I started the app and watched the files under `WebsiteData/Default/.../{IndexedDB,LocalStorage}`.

   | Last interaction | Result after launch |
   | --- | --- |
   | 45 days ago | Both IndexedDB databases and the localStorage file were deleted within 10 seconds of launch; the database shows `dataRecordsRemoved = 1` and the interaction cleared. The page had already read its state at startup |
   | 20 days ago | Nothing deleted (watched for 50 seconds), interaction time unchanged |
   | 1 day ago | Nothing deleted (watched for 60 seconds); the same run did clear an expired record of another domain, so the processing did run |

   So deletion between 20 and 45 operating days, consistent with the 30 in the source and not with 7. The next start after the first row came up with an empty board list and the backup brought the board back (below).
7. **What this does not show.** That real clicks and key presses are logged as interactions for `tauri://localhost` (I could not produce trusted input: no accessibility permission; a posted click did not reach the window), so I do not know how quickly `localhost` leaves the "never interacted" state in real use; the elapsed-time behaviour over real weeks; anything on the engines of other platforms.
8. **`navigator.storage.persist()` does not help here.** **Verified**: it resolves `false` in this app, and `persisted()` is `false` too (every run). **Source** (`NetworkStorageManager::persist`): WebKit grants it only to registrable domains it already exempts from deletion (app-bound domains, managed domains, home screen sites, a standalone app's own URL). The call stays in `startDesktop()` because it costs nothing; do not read anything into it.
9. **App-bound domains** (`WKAppBoundDomains`) appear in that exemption list in the source, but an Apple engineer on the developer forums said they do not change ITP for the domain, and they are for http(s) domains with `limitsNavigationsToAppBoundDomains`, which wry does not expose. **Unverified**, not pursued.
10. **Other platforms.** Windows: WebView2 is Chromium, which has no ITP and evicts only best-effort storage under disk pressure; the profile is a normal one in `%LOCALAPPDATA%\<identifier>`. **Unverified.** Linux: WebKitGTK contains the ITP code but I believe it is off unless the app turns it on. **Unverified.**

### Safety net: board backups

The desktop app writes a copy of every board to a folder of its own, restores boards that storage lost, and merges the copy into a board that opens empty. It is a safety net against the purge above, and it also covers any other loss of the webview's storage (clearing it by hand, a corrupt database, the identifier being changed by mistake).

- **Where.** `<local app data dir>/backups/<id>.drift`. macOS: `~/Library/Application Support/<identifier>/backups/` (**Verified**). Windows: `%LOCALAPPDATA%\<identifier>\backups\`; Linux: `~/.local/share/<identifier>/backups/` (**Source**: Tauri's `app_local_data_dir`; not run). Local, not roaming, data on purpose: a roaming profile would copy every backup around at each sign-in.
- **What.** The output of `toDrift()` (`src/exporters.ts`): a zip with a readable `board.json`, the full sync state `doc.yjs` and, if there are comments, `comments.yjs`. It is an ordinary `.drift` file, so a person can recover by hand: copy it out of the folder and use Import file. One file per board, replaced each time; there is no history (version history is the relay's job).
- **Writing.** `backup_board` accepts the bytes as a raw body and the id in a header. The id must match the app's board id format, `^[A-Za-z0-9_-]{1,64}$` (the same expression as `parseRoute` in `src/route.ts`), and must not be a Windows device name (`con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`, any case), so a page cannot make it write outside the folder or to a device; such a board just has no backup. The write goes to `<id>.<n>.tmp` in the same folder, is flushed to disk and then renamed over `<id>.drift`, so a crash or a full disk leaves the previous backup whole (`rename` replaces an existing file on all three platforms). Rust tests cover the id rules, the path, replacing, a failed write, listing and deleting.
- **When.** After a change to the board or its comments document: 3 seconds after the last change and at most 30 seconds after the first unsaved one; when the board is closed; when the window is hidden or the page is hidden (`visibilitychange`, `pagehide`; best effort, since an IPC call may not finish while the window is closing); and 3 seconds after a board opens, which covers imported boards and boards that existed before the app. One write is in flight per board and a newer snapshot replaces one that is still waiting. A board with no objects is never written, so an empty board that opened in place of lost storage cannot replace a fuller backup; the price is that a board cleared on purpose keeps its older backup. A board that is no longer in the board list is not written either, so a write still waiting when a board is deleted (the accounts-mode banner can remove a board that is open) does not bring its backup back. Verified: no file after 1.5 seconds, a file after 5; an edit followed at once by leaving the board is written within 0.8 seconds.
- **Restoring at start.** Before the first screen, every backup whose id is not in the local board list (`driftboard:boards`) is written into IndexedDB under its own id, with its saved name and time, headless (no relay connection, no board UI; `writeLocalBoard` in `src/sync.ts`) and a toast says how many came back. A damaged backup is skipped with a console warning. **Verified**: with the app quit I deleted `~/Library/WebKit/<identifier>` and `~/Library/Caches/<identifier>`; the next start had the board back with its id, name and both objects, and its IndexedDB files were recreated.
- **Merging on open.** WebKit can clear storage while the app runs (the test above did within 10 seconds of launch), and then the list on screen is stale and a listed board opens empty. So when any board is opened, its backup's sync state is merged into it (`mergeBackup`). The state is a CRDT: the merge adds what the backup has and the board lacks, keeps edits made since, and does not bring back an object deleted since (unit-tested; applying a backup the board already contains emits no update, so nothing is written). **Verified**: with only the IndexedDB folder deleted and the board list intact, opening a board showed its two objects.
- **Deleting.** Deleting a board on the home screen also removes its backup (`onBoardDeleted` hook in `deleteBoard`), otherwise the next start would restore it. If that removal fails, the board returns at the next start; there is a console warning. **Verified.**
- **Limits.** The copy trails edits by up to 30 seconds, so a force quit or crash in that window loses nothing that IndexedDB has but the copy does not have yet; and it is not an archive. Two board ids that differ only in case share one file on a case-insensitive disk (ids are random, so only hand-made ids could). A file in the folder that is not a board is ignored with a warning. The backups are as private as any file in the user's profile and are not encrypted. Relay state is not backed up (it is the relay's data).

### Native save for exports

In a browser, `download()` in `src/exporters.ts` clicks an `<a download>` on a blob URL, and every export (PNG, SVG, `.drift`, JSON, the Markdown summaries) goes through it. In the desktop app `startDesktop()` installs a replacement with `setNativeSave()`: the page turns the data into bytes and calls `save_export`, which shows the system Save dialog from Rust (attached to the window, with the export's name as the suggested name and its extension as the filter) and writes the bytes to the path the dialog returns, then the page shows "Saved name". The page never names a path and has no `dialog:*` permission, so it cannot write anywhere the person did not pick. In a browser nothing changes (a test pins both paths).

**Verified**: calling `save_export` makes the dialog appear (a new window of the app, 430 by 167 points, over the board window). **Not exercised**: choosing a path and the write itself, because the dialog could not be operated from here (a posted Escape did not reach it while the app was in the background, and activating the app would have taken the user's screen), nor the PNG export's canvas path in WKWebView, nor Windows.

### Manual checks on macOS

Run with the debug app in the background (`open -g`), key events posted to the process, no screenshots. The harness was not committed.

- Standard edit shortcuts. **Verified**: Cmd+Z and Cmd+Shift+Z reach the page with `metaKey` set and the board's own handler performs undo and redo (two objects, then none, then two); Cmd+Q posted to the process quits the app (the default menu's Quit item). Tauri's default menu (Source: `tauri-2.12.1/src/menu/menu.rs`) has Edit with Undo, Redo, Cut, Copy, Paste and Select All, so the native items do not shadow the page's handlers for Z. **Unverified**: Cmd+C and Cmd+V. The keydowns for Cmd+A and Cmd+C reached the page, but no `paste` event arrived for the following Cmd+V (the app was not the active application, so the menu's Paste may not have been validated). I stopped there instead of writing to the user's clipboard again; that first Cmd+C may already have replaced its content with a board's JSON.
- Drag and drop of a `.drift` onto a board. **Source**: with `dragDropEnabled` false Tauri does not install wry's drag handler (`tauri-runtime-wry` `drag_drop_handler_enabled`), so WKWebView delivers ordinary HTML5 `drop` events with `dataTransfer.files`, which `board.ts` uses. **Unverified** by a real drag (no way to start one from here). On Windows the same setting is what keeps HTML5 drag and drop working **Docs**.
- An unrelated note: a window that is hidden or covered gets App Nap treatment, and the page stopped answering my harness until I set `NSAppSleepDisabled` for the test. Timers in a covered window may run late; the backup flushes on `visibilitychange` for that reason.

### With no relay (local-only)

- **Done: `auto` means off on the desktop.** `relayUrl()` (`src/sync.ts`) returns `null` for `auto` when `isDesktop()`. Before, macOS and Linux got this only because the page is not `http:`; on Windows the page is `http://tauri.localhost`, so `auto` would have built `ws://tauri.localhost/sync`, which nothing serves, and the board would sit in a reconnect loop. An explicit address (`wss://relay.example.com/sync`) and `off` behave as before; so does everything in a browser. Unit-tested for http, https and tauri pages (`test/desktop-env.test.ts`). The app starts and creates its storage in local-only mode on macOS (**Verified**); the Windows case is **Source** plus those tests, not run.
- **Done: wording.** The home screen footer and the templates page say "Boards are stored on this computer" instead of "in this browser" (`storedWhere()` in `src/desktop-env.ts`), and the Relay hint in Board settings explains that `auto` and `off` both keep boards on this computer. Other copy that says "device" is already right.
- `/api/config` goes to a relative URL, which the app protocol answers with the app's own `index.html` or a 404; either way `initAuth` falls into its `catch` and the mode is `open` (or `offline` with a cached `me`). **Source**
- **Done: no service worker on the desktop.** The registration in `src/main.ts` is skipped when `isDesktop()` (it would have tried to register on Windows, over a custom-protocol origin where it adds nothing, since the app files are local).
- Fonts and icons come from Fontshare and Iconify. In a browser the service worker caches them for offline use. Without it, only the webview's HTTP cache helps, so a first launch offline falls back to the built-in font list and system fonts. Bundling them needs a licence check first (the service worker comment says font files are never re-served).
- Version history needs the relay (`historyOffline` in `src/ui/history.ts`) and shows its offline state.
- **Not done:** the share link is `location.href`, which in the desktop app is `tauri://localhost/#/b/<id>`. Meaningless to other people; it needs the relay's public base URL.

### Pointing at a relay

In a browser the app connects to same-origin `/sync` and `/api`. The desktop app has no same origin. What exists and what is missing:

- **Open mode (no accounts): works now.** Board settings, Relay accepts `auto`, `off` or `wss://relay.example.com/sync` (`src/ui/board.ts`), saved as `driftboard:relay`. In open mode the relay does not check `Origin` on the socket (the check at `server/relay.mjs` is `config.authEnabled &&`), and the CSP allows `ws:` and `wss:`. Not run end to end. What it still needs: first-run UI that asks for the URL (the setting sits behind a board's settings dialog; not built), and a default of `off` (done: `auto` means off).
- **Accounts mode: does not work from a bundled frontend.** Four independent reasons, all in code I read:
  1. `src/api.ts` uses relative paths and `credentials: 'same-origin'`; it has no base URL.
  2. The relay refuses a socket whose `Origin` is not its own (`server/relay.mjs`, upgrade handler) when accounts are on. The desktop origin is `tauri://localhost` or `http://tauri.localhost`.
  3. `csrfOk` (`server/auth.mjs`) requires an `Origin` that matches the `Host` header.
  4. The session cookie is `HttpOnly; SameSite=Lax`. A request from the desktop origin to the relay is cross-site, so the cookie is not sent; and WebKit blocks third-party cookies by default, so `SameSite=None` would not rescue it on macOS (**Unverified**).
- **Ways out for accounts mode**, none implemented:
  - A. Bearer tokens for the desktop: sign in through a link that opens the app (deep-link plugin, `tabula://signin?...`), keep a personal access token (the MCP token machinery in `docs/mcp.md` is close) and send it on `/api` and `/sync`. A base URL setting in `api.ts` and `sync.ts`, token auth on the socket upgrade, and CSRF/Origin rules for token requests. The right long-term answer, and real server work.
  - B. Make the window load the hosted workspace URL (`https://<workspace>...`) instead of the bundled files. Cookies, CSRF and `Origin` then work unchanged. Costs: no offline cold start unless service workers work in the webview (limited in WKWebView; **Unverified**), IPC exposed to remote content (needs capability scoping), and the shell no longer loads the build in `dist/`.
  - C. Do not support accounts mode in the desktop app. Decide this first.

## Auto-update

The updater plugin checks a manifest, downloads the artifact, verifies a signature against a public key baked into the app, installs and relaunches. **Docs**

| Option | Notes |
| --- | --- |
| **`tauri-plugin-updater` + static `latest.json` on GitHub Releases** | Recommended. `tauri-apps/tauri-action` builds the matrix, uploads installers and `.sig` files and writes `latest.json`. No server. Needs the release assets to be public (a private repo needs auth the app cannot send). No staged rollout or channels beyond separate files |
| Same plugin, your own endpoint | The endpoint answers `204` for no update or `200` with `{version, url, signature, notes, pub_date}`; URL variables `{{target}}`, `{{arch}}`, `{{current_version}}`. Gives staged rollouts, channels, a forced minimum version and counts. The control plane in `docs/cloud.md` could host it. More to run |
| CrabNebula Cloud | Managed distribution with updates (listed in Tauri's distribution docs). A vendor and a bill; I did not check pricing |
| Store distribution (Mac App Store, Microsoft Store) | The store updates the app. Needs the App Sandbox on macOS and a store review. A later option, not a first release |
| Sparkle (macOS only) | Native, mature, but Windows still needs something else and Tauri does not integrate it. Two systems for little gain |
| No auto-update: "a new version is available" | Cheapest. Fine for the first few releases |

Recommendation: the updater plugin with the manifest at a URL on your own domain (for example `https://updates.<your domain>/latest.json`) that redirects to the GitHub release, so you can move to your own endpoint later without shipping a new client (the `endpoints` list is baked into each build). Whether the updater follows redirects is **Unverified**; test it.

How it is set up, all **Docs**:

- `npm run tauri signer generate -- -w <path>` makes the update key pair. The public key goes in `plugins.updater.pubkey` in `tauri.conf.json` (public, committed). The private key goes in CI as `TAURI_SIGNING_PRIVATE_KEY` (and `..._PASSWORD`). **If it is lost, installed apps can never be updated.** Keep an offline backup. This spike generated no key and committed none.
- `bundle.createUpdaterArtifacts: true` makes the build produce `.sig` files, `Tabula.app.tar.gz` and the Windows installers' signatures. After that every release build needs the key.
- The updater signature is separate from operating-system code signing. The updated app still has to be Developer ID signed and notarized on macOS and Authenticode signed on Windows, or users see warnings.
- The Windows installer closes the app while it installs; `windows.installMode` is `passive` by default (progress window).
- Add `updater:default` to `capabilities/default.json`; the plugin needs Rust 1.90; the JS side is `@tauri-apps/plugin-updater` 2.13.2 (and `plugin-process` for relaunch), the Rust side `tauri-plugin-updater` 2.13.2.
- Updates keep the origin and the identifier, so local data survives them.
- WebView2 on Windows: the default install mode downloads the runtime during installation and needs internet. For an offline-first app, `offlineInstaller` adds about 127 MB; `embedBootstrapper` adds 1.8 MB but still downloads. **Docs**

## Signing and notarization

No keys, secrets or certificates are in the repo, and the CLI never signed anything here (the bundle is ad-hoc linker-signed by the toolchain, **Verified** with `codesign -dv`).

### macOS

- **Needs**: Apple Developer Program, US$99 a year (**Docs**), and a Mac to sign on. A **Developer ID Application** certificate (only the Account Holder can create it) for distribution outside the App Store; Apple Distribution is for the App Store. Notarization is required with Developer ID.
- **Tauri**: set `APPLE_SIGNING_IDENTITY` (or `bundle.macOS.signingIdentity`), then notarization credentials as either `APPLE_ID` + `APPLE_PASSWORD` (an app-specific password) + `APPLE_TEAM_ID`, or an App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`). In CI also `APPLE_CERTIFICATE` (base64 `.p12`) and `APPLE_CERTIFICATE_PASSWORD`. The build signs, notarizes (`notarytool`) and staples. **Docs**
- **Hardened runtime** is on by default in Tauri (`bundle.macOS.hardenedRuntime`, default `true`). **Docs**
- **Entitlements**: a plain shell around WKWebView probably needs none. The web content runs in WebKit's own process, which holds the JIT entitlement itself, so the host app does not. I could not find Tauri or Apple text that settles it. **Unverified**: confirm with a signed, notarized test build and `codesign -d --entitlements -`; add an `Entitlements.plist` (`bundle.macOS.entitlements`) only for what fails. A Mac App Store build is different: it requires the App Sandbox (and then at least network client access for relay sync and user-selected file access for `.drift`), a provisioning profile and its own certificates. **Docs** for the sandbox requirement, the rest **Unverified**.
- Without a paid account an ad-hoc identity (`"-"`) avoids the "damaged" message on Apple Silicon but still needs the user to approve the app in Privacy and Security. **Docs**

### Windows

- **Authenticode** signs the installer and the exe. Signing is not required to run but is needed to avoid the SmartScreen block on downloads and for the Microsoft Store. **Docs**
- **SmartScreen**: since 2024 EV certificates no longer give instant reputation; EV and OV build it the same way, over time and downloads, so early releases may still warn. Sign every release with the same identity so reputation carries over. **Docs**
- **Options**:

| Option | Cost (approximate) | Notes |
| --- | --- | --- |
| **Azure Artifact Signing** (formerly Trusted Signing) | US$9.99 a month Basic (5,000 signatures), US$99.99 Premium; US$0.005 per signature over quota. Estimates from a mirror of Microsoft's pricing, not a quote | Cloud signing, no hardware token. Tauri documents `signCommand` with `artifact-signing-cli`. Organizations in the US, Canada, EU, UK and a few more countries; individuals only in the US and Canada. Needs identity validation and a pay-as-you-go Azure subscription. Check the live docs: the eligibility list changed between versions I found |
| OV certificate | A few hundred US dollars a year (market range, **Unverified**) | Tauri's own OV guide only applies to certificates bought before 1 June 2023, since then keys live on hardware or in a cloud HSM and cannot be exported to a `.pfx`; use `signCommand` with the issuer's tool |
| EV certificate | More than OV (**Unverified**) | No instant SmartScreen reputation any more, see above |

- **Tauri**: `bundle.windows.certificateThumbprint`, `digestAlgorithm` (`sha256`), `timestampUrl`, or `signCommand` with a `%1` placeholder for any other tool. Signing a Windows build from macOS or Linux needs `signCommand` and a cross-compiled NSIS installer, which Tauri calls a last resort; build on a Windows runner instead.

### What the owner has to set up

1. Decide the legal entity and country (it decides Azure eligibility and who can be the Apple Account Holder).
2. Enrol in the Apple Developer Program, create the Developer ID Application certificate, an app-specific password or API key. Enrolment can take days.
3. Choose and enrol the Windows signing route. Identity validation can take days to weeks.
4. Generate the updater key pair (once, offline backup) and store the private key as a CI secret.
5. Choose the final bundle identifier and a domain for update URLs.
6. Create GitHub Actions secrets for all of the above (names listed in this page, no values in the repo) and allow the workflow to write releases.
7. Decide whether release assets can be public.

macOS runner minutes cost more than Linux on GitHub-hosted runners; check the current rates for a private repository. **Unverified**

## Open questions

1. Is the desktop app for hosted workspaces (accounts mode)? Decides whether phase 3 exists.
2. A document or a library? Does opening a `.drift` import a copy (Phase 1: yes, a copy each time) or open and save to the file? Changing it changes the product model, not just the glue.
3. *Answered in part.* Does IndexedDB in WKWebView with `tauri://localhost` survive the 7 day rule? The mechanism applies, with a 30 operating-day window (see "Storage purge"); real clicks being logged as interactions and real elapsed time are still untested, so the backups stay. Decide whether a long-idle test on a real timeline is worth running before launch.
4. *Answered in part.* Do exports work? `download()` is replaced by a native Save dialog on the desktop. The dialog opens; picking a path, the write and the PNG path were not exercised. Try each export once by hand on macOS and Windows.
5. *Answered in part.* Do the board's keyboard shortcuts survive the native menu? Cmd+Z, Cmd+Shift+Z and Cmd+Q: yes. Cmd+C and Cmd+V, and drag and drop of a file: not verified (see "Manual checks on macOS").
6. `http://tauri.localhost` on Windows: does WebView2 persist IndexedDB there as expected? Not tested. The service worker question is closed: it is not registered on the desktop.
7. Does the updater follow a redirect from your own domain to GitHub?
8. May the Fontshare fonts be bundled for offline use?
9. Which operating system versions and browsers are supported? That sets `minimumSystemVersion` (the 12.3 here is a guess) and the Windows WebView2 policy.
10. Do you want Linux builds? The code path is shared and the config allows `deb`/`appimage`, but nothing was built.
11. Mac App Store and Microsoft Store: wanted? They change signing, the sandbox and update delivery.
12. Public or private repository for releases, and whether the control plane should serve update manifests.
13. The final identifier and product name. `app.tabula.desktop` and "Tabula" are placeholders; the identifier is locked by a test and must be settled before the first public release.
14. Should the app ask for the relay address on first run (not built), and should it tell the person once that boards are copied to the app data folder?

## Phased plan

| Phase | Scope | Rough effort |
| --- | --- | --- |
| 0. Spike (this) | Shell, association, glue, findings | done |
| 1. Local-first desktop MVP | See the checklist below | 1 to 1.5 weeks (the code part is done) |
| 2. Release pipeline | GitHub Actions matrix with `tauri-action` (macOS arm64 and x64, Windows), Developer ID signing and notarization, Windows signing, updater key pair, `createUpdaterArtifacts`, `latest.json`, update-from-previous-version test, desktop jobs in CI | about 1 week of work, plus the waiting time for enrolments |
| 3. Accounts mode in the desktop app (if question 1 is yes) | Base URL in `api.ts` and `sync.ts`, bearer-token auth on `/api` and the socket upgrade, token-aware CSRF and Origin rules, sign-in through a deep link, tests on the relay | 2 to 3 weeks, mostly server and tests |
| 4. Native polish (optional) | `tabula://` links to open a board, window state, custom menu, native dialogs, Store builds, Linux | 1 to 2 weeks |

Phase 1 is the first useful build; phases 1 and 2 together are the first public one.

### Phase 1 checklist

Done (macOS only unless said; tags as above):

- [x] `src/desktop.ts` glue, active only when `'__TAURI_INTERNALS__' in window`, `@tauri-apps/api` loaded only by dynamic import in the desktop chunk (checked in `dist/`)
- [x] Opened `.drift` files are imported as copies, at launch and while running, one or several (**Verified**)
- [x] Relay `auto` means off on the desktop; an explicit `wss://` address still works (unit-tested)
- [x] No service worker on the desktop; "stored on this computer" wording
- [x] Locked settings with a test (`identifier`, `useHttpsScheme`)
- [x] WebKit purge researched, confirmed in mechanism, escape hatch built and tested end to end (backups, restore at start, merge on open, delete hook)
- [x] Native Save dialog for exports (dialog opens, **Verified**; write not exercised)
- [x] Edit shortcut check (partly) and drag and drop check (by source only)

Not done:

- [ ] A real app icon and the final name and identifier; a `.drift` document icon (the icons are still the favicon, rounded corners baked in)
- [ ] First-run relay address UI (the setting is still in Board settings)
- [ ] The share link for a board is still `tauri://localhost/#/b/<id>`
- [ ] Windows 10 and 11 QA on real machines or VMs (nothing was run on Windows: relay gate, backups folder, save dialog, opened files, the `http://tauri.localhost` origin), macOS 12 QA, Linux
- [ ] Copy and paste, a real drag of a file onto a board, and saving through the dialog, checked by hand
- [ ] Offline fonts and icons (they need the network, as in a browser without the service worker)
- [ ] Accounts mode (Phase 3), signing, updater and the release pipeline (Phase 2)
