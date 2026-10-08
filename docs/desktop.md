# Desktop app (Tauri 2)

A desktop build of Tabula: the existing web app in a native window, with `.drift` files opening in it. No rewrite: the shell loads the output of `npm run build` and nothing in `src/` or `server/` changes for it.

Status: spike (TAB-100). The shell compiles, bundles and runs on macOS. Windows and Linux were not built or run. Signing, auto-update and the web-side glue for opened files are researched and sketched, not built.

How to read the claims below. Each non-obvious one carries a tag:

- **Verified**: I ran it on macOS 15.1 (arm64) with the pinned versions.
- **Source**: read in the sources of the pinned crates (`tauri` 2.12.1, `tauri-utils` 2.10.1, `tao` 0.37.1, `wry` 0.57.0), not run.
- **Docs**: stated in the vendor documentation fetched on 2026-10-08, not run.
- **Unverified**: recollection or inference. Check before relying on it.

## Summary

- Tauri 2 works for this app with no frontend changes to get a window up. IndexedDB, localStorage and a cross-origin font catalogue fetch all work inside the macOS webview (WKWebView). **Verified**
- Boards persist across restarts in `~/Library/WebKit/<identifier>/` on macOS. The origin is `tauri://localhost`. **Verified**
- `.drift` association works on macOS: the bundle declares the type and the running or cold-starting app receives the path. The same Rust code handles the Windows and Linux route (path in `argv`, a second launch forwards its `argv` to the first). **Verified** on macOS, including the second-process route simulated by running the binary again; the Windows installer part is **Docs**.
- Local-only mode is the default on macOS without any change, because `relayUrl()` returns `null` for non-http(s) pages. On Windows it is not: the origin is `http://tauri.localhost`, so `auto` tries `ws://tauri.localhost/sync`. **Source** (code reading, not run on Windows).
- Accounts mode (and so hosted workspaces) does not work from a bundled frontend without server and client changes: cookies, `Origin` checks and CSRF all assume the page is served by the relay. Open mode works today by typing a `wss://` relay URL into Board settings. See "Pointing at a relay".
- Recommended updates: `tauri-plugin-updater` with a static `latest.json` on GitHub Releases, behind a domain you control. Signing costs: Apple Developer Program US$99 a year; Windows from about US$10 a month (Azure Artifact Signing, if you are eligible) to a few hundred dollars a year for a certificate.
- Biggest open product question: is the desktop app for hosted (accounts mode) customers? If yes, phase 3 below is mandatory and large. If it is a local-first app with optional self-hosted relays, it is small.

## What is in the repo

```
desktop/src-tauri/
  Cargo.toml            tauri, tauri-build, tauri-plugin-single-instance, all pinned with =
  Cargo.lock            committed (it is an application)
  build.rs              tauri_build::build()
  tauri.conf.json       window, CSP, bundle, .drift association
  capabilities/default.json   core:default for the main window
  src/main.rs           shell plus the opened-file glue and its unit tests
  icons/                six desktop icons made from public/favicon.svg
```

Ignored: `desktop/src-tauri/target/` and `desktop/src-tauri/gen/` (`.gitignore`), and `desktop/src-tauri/target` for oxlint (`.oxlintrc.json`). `tsconfig.json` only includes `src` and `test`, and vitest finds no tests under `desktop/`, so the web checks do not see it.

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | `tauri dev`: starts `npm run dev` (relay on 8787 and Vite on 5173) and opens a window on `http://localhost:5173`. If 5173 is busy Vite moves to the next port and the window waits for the wrong URL (the config has no `strictPort`); stop the other dev server first |
| `npm run desktop:build` | `tauri build`: runs `npm run build` (typecheck plus Vite), embeds `dist/` and bundles `app`, `dmg` and `nsis` for the host OS |
| `npm run desktop:build -- --bundles app` | Only the `.app` (skips the DMG step, which drives Finder through AppleScript) |

Needs Rust 1.90 or newer (`rust-version` in `Cargo.toml`), Xcode command line tools on macOS, and the MSVC build tools plus WebView2 on Windows. CI does not build it yet. The only new dependency on the web side is `@tauri-apps/cli` 2.12.1 (exact) in `devDependencies`; `npm ci` now also downloads its platform binary.

Pinned versions: `@tauri-apps/cli` 2.12.1, `tauri` 2.12.1, `tauri-build` 2.7.1, `tauri-plugin-single-instance` 2.5.2 (plus `wry` 0.57.0 and `tao` 0.37.1 through `Cargo.lock`). Tauri 3 exists only as alpha (`3.0.0-alpha.4`); it is not used. Tauri 1 config (`tauri.allowlist`) does not apply: v2 uses capabilities and plugins.

### Choices in `tauri.conf.json`

- **`identifier`: `app.tabula.desktop`.** A placeholder. Use a reverse-DNS name you own and then never change it: it names the data folders (below), the signing identity and the Windows install key.
- **`version`: `../../package.json`**, so the app version has one source. **Source** (`tauri-utils` accepts a path); `cargo check` passes with it.
- **`build.frontendDist`: `../../dist`**, embedded at compile time. Run `npm run build` first when calling `cargo` directly; `tauri build` does it through `beforeBuildCommand`.
- **`useHttpsScheme`: `false`, written down on purpose.** It decides the Windows origin (`http://tauri.localhost` or `https://tauri.localhost`). Changing it between releases makes existing IndexedDB, cookies and localStorage unreachable. **Docs**
- **`dragDropEnabled`: `false`.** By default Tauri replaces the webview's drag and drop handler, which on Windows disables HTML5 drag and drop. The board relies on it (dropping a `.drift` or a shape onto the canvas, `src/ui/board.ts`). **Docs**
- **CSP**: the relay's header (`server/relay.mjs`, `CSP`) does not exist in the bundle, so the same policy is set in `app.security.csp`, plus `ipc: http://ipc.localhost` in `connect-src` (Tauri does not add it for you). **Source**. Tauri adds nonces or hashes only when the HTML has inline `<style>` or `<script>`, and only then does `'unsafe-inline'` stop working; the built `index.html` has none. **Source**. The Fontshare catalogue request succeeded under this policy. **Verified**. I did not look at the rendered UI (no screenshot of the app window was taken), so inline `style` attributes under the policy are inferred, not seen.
- **`bundle.macOS.minimumSystemVersion`: `12.3`.** The app calls `crypto.randomUUID()` (`src/sync.ts`), which needs Safari 15.4. A guess to confirm against the browsers you support; the default would be 10.13. **Unverified**
- **`bundle.targets`: `app`, `dmg`, `nsis`.** NSIS builds per-user installs and needs no admin rights. MSI needs WiX and a Windows host. **Docs**
- **Icons** come from `public/favicon.svg`, which has its rounded corners baked in. A real app icon (full-bleed square for macOS, a document icon for `.drift`) is a design task.
- **`updater` is not configured.** Turning on `createUpdaterArtifacts` makes every `tauri build` demand a signing key, which this spike must not hold.

### What was run

| Command (in the worktree) | Result |
| --- | --- |
| `cargo check --all-targets` in `desktop/src-tauri` | passes, 29 s warm |
| `cargo test` | 3 tests pass (argument parsing, including a Windows path and `file://` URLs) |
| `cargo clippy --all-targets` | no warnings |
| `npm run desktop:build -- --debug --bundles app` | builds `Tabula.app` (24 MiB debug); `beforeBuildCommand` ran the web build from the repo root |
| `npm run desktop:build -- --bundles app` | release `Tabula.app`, 8.9 MiB, arm64 only, unsigned, 1 min 35 s with a cold release cache |
| `npm run desktop:dev -- --config '{"build":{"devUrl":"http://localhost:5174"}}'` | relay and Vite started, the app compiled and attached (Vite had moved to 5174 because 5173 was taken on this machine) |
| `npm run lint`, `npm run typecheck`, `npm test` | pass; 39 test files, 1698 tests. The web checks are unaffected by `desktop/` |

Not run: a DMG, a universal binary, anything on Windows or Linux, any signing or notarization, an end-to-end relay connection from the desktop app, any UI interaction (no clicking, no screenshot of the window).

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

### The missing web side

Nothing in `src/` calls these commands, so today a double click starts the app but imports nothing. The glue is small because the import path already exists: `readBoardFile(file: File)` only uses `file.arrayBuffer()`, and `main.ts` already handles `nav.open(id, { imported })`.

```ts
// desktop.ts, only when '__TAURI_INTERNALS__' in window
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

async function importOpenedFiles(open: HomeNav['open']) {
  for (const path of await invoke<string[]>('take_opened_files')) {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>('read_opened_file', { path }));
    const file = new File([bytes], path.split(/[\\/]/).pop()!);
    const imported = await readBoardFile(file);
    const id = newId();
    touchBoard(id, { name: imported.json.meta?.name || file.name.replace(/\.\w+$/, '') });
    open(id, { imported });
  }
}
// call once at startup, and again on listen('opened-file', ...)
```

That is `home.ts` lines 308 to 318 with a different source for the `File`. It needs `@tauri-apps/api` as a dependency (keep its version equal to the `tauri` crate; the CLI warns on a mismatch). Estimate: half a day with a Windows check.

Decisions it leaves open: should a desktop open of `board.drift` behave as a document (open, edit, save back to the file) instead of importing a copy each time? That changes the product model, not just the glue.

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
2. **The `identifier`.** It names the folders above, so renaming the app's identifier orphans the data.
3. **No switch to a custom data store.** `dataDirectory` and `dataStoreIdentifier` (macOS 14+) point the webview at a different store. **Docs**
4. **Dev and production are different stores.** `desktop:dev` runs on `http://localhost:5173`, a different origin, so boards made there do not show up in an installed build. This follows from the origin rule; I did not inspect the dev run's folder (an unbundled binary has no bundle identifier, so WebKit probably names it after the executable). **Unverified**

Risk not resolved: Safari deletes script-writable storage after 7 days of browser use without interaction on a site. I found no Apple statement on whether a WKWebView with a custom scheme is subject to it, and the sources conflict. **Unverified**. For a local-first app this needs a test on a real timeline before launch (and, whatever the result, an escape hatch: the `.drift` export, a reminder, or a copy of each board in the app data folder written from Rust). `navigator.storage.persist()` is worth calling, but I found nothing confirming it helps here.

### With no relay (local-only)

- macOS and Linux: `relayUrl()` (`src/sync.ts`) returns `null` unless the page is `http:` or `https:`, so `auto` means off. Boards open from IndexedDB and the status stays `local`. Home says "Sync is off. Boards are stored in this browser only." (wording to change for the desktop). **Source**; the app starts and creates its storage this way. **Verified**
- Windows: the page is `http:`, so `auto` builds `ws://tauri.localhost/sync`, which nothing serves. The board would sit in a reconnect loop and the share dialog would say the relay is unreachable. Needs a gate (`'__TAURI_INTERNALS__' in window` makes `auto` mean off). **Source**, not run.
- `/api/config` goes to a relative URL, which the app protocol answers with the app's own `index.html` or a 404; either way `initAuth` falls into its `catch` and the mode is `open` (or `offline` with a cached `me`). **Source**
- The service worker (`src/main.ts`, registered when the protocol starts with `http`) does not register on macOS. On Windows it would try to, over a custom-protocol origin where it adds nothing, since the app files are local. Gate it off in the desktop app. **Source**
- Fonts and icons come from Fontshare and Iconify. In a browser the service worker caches them for offline use. Without it, only the webview's HTTP cache helps, so a first launch offline falls back to the built-in font list and system fonts. Bundling them needs a licence check first (the service worker comment says font files are never re-served).
- Version history needs the relay (`historyOffline` in `src/ui/history.ts`) and shows its offline state.
- The share link is `location.href`, which in the desktop app is `tauri://localhost/#/b/<id>`. Meaningless to other people; it needs the relay's public base URL.

### Pointing at a relay

In a browser the app connects to same-origin `/sync` and `/api`. The desktop app has no same origin. What exists and what is missing:

- **Open mode (no accounts): works now.** Board settings, Relay accepts `auto`, `off` or `wss://relay.example.com/sync` (`src/ui/board.ts`), saved as `driftboard:relay`. In open mode the relay does not check `Origin` on the socket (the check at `server/relay.mjs` is `config.authEnabled &&`), and the CSP allows `ws:` and `wss:`. Not run end to end. What it needs: first-run UI that asks for the URL (the setting sits behind a board's settings dialog), a default of `off`, and the Windows gate above.
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
2. A document or a library? Does opening a `.drift` import a copy (today) or open and save to the file?
3. Does IndexedDB in WKWebView with `tauri://localhost` survive the 7 day rule? Needs a real-time test; plan a native safety copy either way.
4. Do exports work? `download()` in `src/exporters.ts` clicks an `<a download>` on a blob URL. I did not test it in either webview; a native save dialog (dialog plugin, then write from Rust) is the safe replacement. High priority.
5. Do the board's keyboard shortcuts survive the native menu? Tauri's default macOS menu has Edit items (Undo, Copy, Paste) that can take Cmd+Z and Cmd+C before the page's own handlers. Not tested.
6. `http://tauri.localhost` on Windows: does WebView2 persist IndexedDB there as expected, and does the service worker register? Not tested.
7. Does the updater follow a redirect from your own domain to GitHub?
8. May the Fontshare fonts be bundled for offline use?
9. Which operating system versions and browsers are supported? That sets `minimumSystemVersion` (the 12.3 here is a guess) and the Windows WebView2 policy.
10. Do you want Linux builds? The code path is shared and the config allows `deb`/`appimage`, but nothing was built.
11. Mac App Store and Microsoft Store: wanted? They change signing, the sandbox and update delivery.
12. Public or private repository for releases, and whether the control plane should serve update manifests.

## Phased plan

| Phase | Scope | Rough effort |
| --- | --- | --- |
| 0. Spike (this) | Shell, association, glue, findings | done |
| 1. Local-first desktop MVP | `desktop.ts` glue (opened files, relay `auto` means off, no service worker, share link), first-run relay URL, native save for exports, menu and shortcut check, drag and drop check, `.drift` document icon, a real app icon, bundle identifier and name decided, manual QA on macOS 12 and 15 and Windows 10 and 11 (real machines or VMs) | 1 to 1.5 weeks |
| 2. Release pipeline | GitHub Actions matrix with `tauri-action` (macOS arm64 and x64, Windows), Developer ID signing and notarization, Windows signing, updater key pair, `createUpdaterArtifacts`, `latest.json`, update-from-previous-version test, desktop jobs in CI | about 1 week of work, plus the waiting time for enrolments |
| 3. Accounts mode in the desktop app (if question 1 is yes) | Base URL in `api.ts` and `sync.ts`, bearer-token auth on `/api` and the socket upgrade, token-aware CSRF and Origin rules, sign-in through a deep link, tests on the relay | 2 to 3 weeks, mostly server and tests |
| 4. Native polish (optional) | `tabula://` links to open a board, window state, custom menu, native dialogs, Store builds, Linux | 1 to 2 weeks |

Phase 1 is the first useful build; phases 1 and 2 together are the first public one.
