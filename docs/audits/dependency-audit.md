# Production dependency and licence audit

**Snapshot:** 2026-10-10
**Repository/base:** the tabula repository, `0028c5b420525552967b8d905b6338f212d61f79` (`origin/main` after fetch)
**Product licence:** `AGPL-3.0-only` (`package.json`, root `LICENSE`)

> **Note, 16 October 2026:** the product licence is now `FSL-1.1-ALv2` from v5.4.3 (`AGPL-3.0-only` up to v5.4.2). This audit is a snapshot of 10 October 2026 and is left as written; the findings below were made when the product licence was `AGPL-3.0-only`.

This is a source and manifest audit, not a legal opinion or a rebuilt-artifact SBOM. It covers the npm runtime closure in `package-lock.json`, Tauri's Cargo runtime closure across target-specific dependencies, Dockerfile installs, runtime-loaded fonts and icon data, and checked-in art/icon assets. Licence expressions below are the package metadata recorded in the lockfiles; where a package offers alternatives, the report identifies a permissive choice where possible.

## Findings and actions

| Priority | Finding | Evidence and recommended action |
| --- | --- | --- |
| **High — rights clearance** | The Fontshare font picker appears to exceed the current ITF Free Font License grant. | The production shell loads Switzer, Cabinet Grotesk and Satoshi from Fontshare; the normal picker also fetches the Fontshare catalogue and can load other families. The service worker caches Fontshare CSS/font responses. Fontshare's current FFL 2.0 (dated 17 Aug 2026) allows use on the licensee's own sites/apps, but says the font software must not be made available to third parties through a SaaS/design tool, including as a selectable font for users creating or editing their own content. Tabula's board editor has that selectable-font use. Obtain written permission for this product/use or remove the selectable Fontshare feature and its cache path before distributing it. The README's older summary does not describe this new restriction. [Fontshare FFL page](https://www.fontshare.com/fonts/clash-display) |
| **Medium — product metadata** | The desktop crate declares `MIT`, while the root application declares `AGPL-3.0-only`. | `desktop/src-tauri/Cargo.toml` has `license = "MIT"`; no separate desktop `LICENSE` was found. This might be an intentional separately licensed shell, but the boundary and ownership are not documented. Confirm the intended licence and either correct the metadata or add a clearly scoped desktop licence/notice. |
| **Medium — shipped notices** | There is no root `NOTICE` or consolidated third-party licence file. | The repository has the root `LICENSE` and the brand asset licence only. The desktop Cargo closure contains MPL-2.0 and Unicode-3.0 packages; runtime npm packages and icon sets also carry notices/attribution conditions. The icon build generates `dist/icons/LICENSES.txt`, but no built output was inspected here. Ensure release artifacts retain upstream licence texts/notices and CC BY credits, especially for the Tauri bundle; do not rely on lockfile metadata alone. [Apache-2.0 notice terms](https://www.apache.org/licenses/LICENSE-2.0.html) |
| **Medium — PR not verifiable** | Dependabot PR #14 is not present in the configured GitHub repository. | `gh pr view 14` returned “Could not resolve to a PullRequest”; `gh pr list --state all --search glib` returned no matches for `gettabula-app/tabula`. The current Cargo graph does contain Linux-only `glib`/GTK crates, but the PR's proposed version/change cannot be verified. The Docker image has no `apt`/`apk` installs and no glib dependency. Ask for the PR URL or the correct repository before attributing a change to it. |
| **Low — asset provenance** | Checked-in product icon files have no per-file licence/provenance record. | `public/favicon.svg` and `desktop/src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.ico}` are shipped/referenced assets, but no licence or source is recorded for those exact files. Confirm they are Tabula-owned and add their provenance/licence to the asset inventory. The separate `design/brand/assets/` kit is documented below. |

## npm runtime dependencies

`npm ls --package-lock-only --omit=dev --all --parseable` and the v3 lockfile dependency closure contain 19 production packages. All declared licences are permissive/public-domain choices compatible with an AGPL-3.0-only application, subject to retaining the applicable notices. For `@tauri-apps/api`, choose the MIT option if avoiding Apache-2.0 notice handling.

| Package | Locked version | Declared licence | AGPL-3.0 status |
| --- | ---: | --- | --- |
| `@anthropic-ai/sdk` | 0.128.0 | MIT | Compatible; retain notice |
| `@babel/runtime` | 7.29.10 | MIT | Compatible; retain notice |
| `@stablelib/base64` | 1.0.1 | MIT | Compatible; retain notice |
| `@tauri-apps/api` | 2.12.1 | Apache-2.0 OR MIT | Compatible; MIT is an available choice |
| `fast-sha256` | 1.3.0 | Unlicense | Compatible |
| `fflate` | 0.8.3 | MIT | Compatible; retain notice |
| `fractional-indexing` | 4.0.0 | CC0-1.0 | Compatible |
| `isomorphic.js` | 0.2.5 | MIT | Compatible; retain notice |
| `json-schema-to-ts` | 3.1.1 | MIT | Compatible; retain notice |
| `lib0` | 0.2.119 | MIT | Compatible; retain notice |
| `nodemailer` | 10.0.16 | MIT-0 | Compatible |
| `standardwebhooks` | 1.1.1 | MIT | Compatible; retain notice |
| `ts-algebra` | 2.0.0 | MIT | Compatible; retain notice |
| `ws` | 8.22.0 | MIT | Compatible; retain notice |
| `y-indexeddb` | 9.0.12 | MIT | Compatible; retain notice |
| `y-protocols` | 1.0.7 | MIT | Compatible; retain notice |
| `y-websocket` | 3.1.0 | MIT | Compatible; retain notice |
| `yjs` | 13.6.33 | MIT | Compatible; retain notice |
| `zod` | 4.6.5 | MIT | Compatible; retain notice |

The `npm audit --omit=dev` command completed on this snapshot and reported **0 vulnerabilities**.

## Tauri / Cargo runtime dependencies

`desktop/src-tauri/Cargo.toml` directly uses `tauri 2.12.1`, `tauri-plugin-dialog 2.8.1`, and `tauri-plugin-single-instance 2.5.2`; each declares `Apache-2.0 OR MIT`. `tauri-build 2.7.1` is build-only. The locked runtime closure contains **436 third-party crates** across target-specific runtime edges; `cargo metadata --locked` returned a declared licence for every crate. The full package-by-package list is in the appendix, grouped by exact Cargo licence expression. The root `tabula-desktop` package's own `MIT` metadata is not counted as a dependency and is the metadata discrepancy above.

All recorded expressions have a permissive route or are compatible with an AGPL larger work if their terms are preserved:

- The MIT, ISC, BSD, 0BSD, Unlicense, Zlib and CC0 choices are permissive/public-domain-style terms. Apache-2.0 is compatible with AGPL-3.0; dual `OR` expressions offer an MIT/Apache or other permissive choice. For `AND` expressions, satisfy every listed licence.
- Five crates declare MPL-2.0: `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, and `selectors`. A scan of their packaged text/source files found no “Incompatible With Secondary Licenses” opt-out notice. MPL-2.0 section 3.3 permits an AGPL larger work where that opt-out is absent; keep the MPL notices and make the covered source available. [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/), [GNU compatibility guidance](https://www.gnu.org/licenses/license-compatibility.en.html)
- `unicode-ident` declares `(MIT OR Apache-2.0) AND Unicode-3.0`; keep the Unicode notice as well as the selected MIT/Apache notice. The Unicode project describes Unicode-3.0 as an OSI-approved permissive licence. [Unicode licence FAQ](https://unicode.org/faq/unicode_license.html)
- `r-efi` versions in the all-target lock graph declare `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; a permissive option is available. Neither version is selected for the checked Linux, macOS or Windows target graphs.

No GPL-only, non-commercial, or share-alike Rust runtime licence expression was found. This conclusion is based on Cargo registry licence metadata and the targeted MPL notice scan, not a manual legal review of every crate source file.

## Docker, OS packages, and deployment dependencies

- `Dockerfile` uses `node:26-alpine` for build and runtime stages. It has no `apt-get` or `apk add` install lines. The Alpine/Node base image is a mutable tag, not a pinned digest; its full OS package SBOM/licences were not resolved in this source-only audit.
- The build stage runs `npm ci` (including dev dependencies) and uses `@iconify/json 2.2.540` (package metadata: MIT) to produce icon assets. The final stage runs `npm ci --omit=dev` and copies the generated app, icons, server and importer files. The runtime npm closure is the 19-package table above; build-only npm packages are not copied as `node_modules` into the final stage.
- Tauri's configured bundle targets are `app`, `dmg`, and `nsis` (macOS/Windows formats). Linux `glib`, `glib-sys`, `glib-macros`, `gio`, `gtk` and `gtk-sys` appear in the Linux-only Cargo target graph, not in macOS or Windows graphs. The Docker server image does not install or use these packages. No Linux Tauri bundle target is configured in `tauri.conf.json`.

| Docker input | Declared/licence status | AGPL-3.0 assessment |
| --- | --- | --- |
| `node:26-alpine` (build and runtime stages) | Node.js uses MIT; Alpine base packages have mixed licences. The tag is not pinned to an image digest and its package SBOM was not resolved. | Node is compatible; the full base-image layer is **unverified** until the release digest/SBOM is recorded. |
| `apt-get` / `apk add` | No such install commands in `Dockerfile`. | No additional package-manager dependencies found. |
| Final-stage `npm ci --omit=dev` | The 19 locked npm runtime packages listed above. | Compatible with their stated notice conditions. |
| Build-stage `npm ci` icon source | `@iconify/json@2.2.540` package metadata is MIT; icon files retain each set's separate licence. | Package is compatible; generated art remains subject to the allowlist and per-set notices below. |

## Fonts, icons, and art

### Fonts

`index.html` fetches Switzer, Cabinet Grotesk and Satoshi CSS from `api.fontshare.com`; `src/fonts.ts` loads chosen families from Fontshare and `public/sw.js` caches Fontshare CSS/font responses. The normal picker obtains Fontshare's larger catalogue; the nine `BUILTIN_FONTS` in `src/font-policy.ts` are only its offline/demo list, not the normal-mode allowlist. The font software is not vendored into `public/`. Under the current Fontshare FFL 2.0 page, the direct third-party selectable-font use described in the High finding is not cleared by the general personal/commercial-use grant. Treat the Fontshare feature as **not cleared for AGPL product distribution** until ITF confirms this product use in writing or the feature is changed.

The brand kit states that the Bodoni Moda ExtraBold outlines in its wordmark/monograms use an SIL OFL 1.1 font source; the outlines themselves are reserved Tabula marks. No font binaries are checked into the product assets.

### Icon sets

`@iconify/json` is a build-time devDependency, not a runtime npm package. Tabula's build and runtime filters allow only CC0-1.0, Unlicense, 0BSD, MIT, ISC, Apache-2.0, BSD-2-Clause/3-Clause, OFL-1.1 and CC-BY-3.0/4.0 sets. They reject missing/compound/unknown, non-commercial, share-alike, and copyleft licences, and hidden/unmaintained sets. These licences can accompany an AGPL application when each licence's own terms are met. CC BY sets are marked for credit; the UI has an icon credits dialog and the build emits `dist/icons/LICENSES.txt`. Logo sets are separately marked as trademarks: the icon licence does not grant trademark rights. Iconify itself is MIT, but the icon data keeps each set's own licence. [Iconify set data and per-set licence catalogue](https://github.com/iconify/icon-sets), [collection licence metadata](https://github.com/iconify/icon-sets/blob/master/collections.md)

This audit checked the filtering and notice-generation code, not a freshly generated `dist/icons/` artifact; the per-release `LICENSES.txt` should be reviewed with the actual shipped set list.

### Art and vendored assets

`design/brand/assets/LICENSE.md` licenses the `cutouts/`, `marks/`, `paper/`, `tape/` and `board/` art under CC BY 4.0, with the required credit text “Art by Tabula, CC BY 4.0” and a link to the licence. CC BY 4.0 can accompany an AGPL distribution as a separately licensed asset if its attribution terms are met. It describes the art as generated for Tabula and says it contains no stock or third-party artwork. The wordmark and monograms are reserved rather than CC BY or generally reusable under the root AGPL licence; the torn-edge SVG/CSS is under the repository licence. The production `src/`, `public/` and `index.html` references do not load that design kit, so those art files are not in the current web asset output based on this source inspection. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

The product does reference `public/favicon.svg` and Tauri bundles the five desktop icon files noted in the Low finding. Those exact product images have no separate source/asset licence record in the repository. No additional vendored third-party source tree or root-level `NOTICE`, `THIRD-PARTY-LICENSES`, or `COPYING` file was found.

## Dependabot PR #14 (glib)

The requested `gh pr view 14` was run read-only from the configured remote `gettabula-app/tabula`; GitHub returned that PR #14 could not be resolved. A read-only search of all states for `glib` returned no matching PR. Cargo's Linux-target metadata shows `glib 0.18.5`, `glib-sys 0.18.1`, `glib-macros 0.18.5`, `gio 0.18.4`, `gtk 0.18.2` and `gtk-sys 0.18.2`; the same crates are absent from the macOS and Windows target graphs. Because the PR itself is missing, its proposed update and whether it intersects the currently configured releases remain unverified. The Docker image is unaffected by a Linux Tauri `glib` crate update based on the current Dockerfile.

## Verification and limits

- `npm audit --omit=dev`: passed, 0 vulnerabilities.
- `gh pr view 14`: no such PR resolvable in the configured repository; see limitation above.
- `npm run changelog:check`: passed, 171 fragments OK.
- No build, source-code change, dependency update, `npm audit fix`, or PR mutation was performed.

## Appendix: complete locked Tauri runtime crate inventory

The appendix is generated from `Cargo.lock` via `cargo metadata --manifest-path desktop/src-tauri/Cargo.toml --locked --format-version 1`, following runtime (`kind = null`) edges across all targets. Each `crate@version` inherits the licence expression shown in its group. Build-only crates are excluded. Cargo.lock is the version authority.


- **(MIT OR Apache-2.0) AND Unicode-3.0** — compatible; include Unicode notice (1): `unicode-ident@1.0.26`
- **0BSD OR MIT OR Apache-2.0** — compatible; choose a permissive stated alternative and preserve its notice (1):
  `adler2@2.0.1`
- **Apache-2.0** — compatible; retain applicable notice (2): `sync_wrapper@1.0.2`, `tao@0.37.1`
- **Apache-2.0 / MIT** — compatible; retain applicable notice (1): `fnv@1.0.7`
- **Apache-2.0 AND MIT** — compatible; satisfy every conjunct and preserve notices (1): `dpi@0.1.2`
- **Apache-2.0 OR MIT** — compatible; choose a permissive stated alternative and preserve its notice (43):
  `async-channel@2.5.0`, `async-executor@1.14.0`, `async-io@2.6.0`, `async-lock@3.4.2`, `async-process@2.5.0`
  `async-signal@0.2.14`, `async-task@4.7.1`, `atomic-waker@1.1.2`, `bit-set@0.8.0`, `bit-vec@0.8.0`
  `blocking@1.7.0`, `concurrent-queue@2.5.0`, `ctor@1.0.13`, `equivalent@1.0.2`, `event-listener-strategy@0.5.4`
  `event-listener@5.4.2`, `fastrand@2.5.0`, `futures-lite@2.6.1`, `idna_adapter@1.2.2`, `indexmap@1.9.3`
  `indexmap@2.14.2`, `libappindicator-sys@0.9.0`, `libappindicator@0.9.0`, `muda@0.20.0`, `parking@2.2.1`
  `pin-project-lite@0.2.17`, `polling@3.11.0`, `portable-atomic-util@0.2.8`, `portable-atomic@1.15.0`
  `rustc-hash@2.1.3`, `tauri-codegen@2.7.1`, `tauri-macros@2.7.1`, `tauri-plugin-dialog@2.8.1`
  `tauri-plugin-fs@2.6.0`, `tauri-plugin-single-instance@2.5.2`, `tauri-runtime-wry@2.12.1`, `tauri-runtime@2.12.1`
  `tauri-utils@2.10.1`, `tauri@2.12.1`, `utf8_iter@1.0.4`, `uuid@1.27.0`, `window-vibrancy@0.8.1`, `wry@0.57.0`
- **Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT** — compatible; choose a permissive stated alternative and preserve its notice (5):
  `linux-raw-sys@0.12.1`, `rustix@1.1.5`, `wasi@0.11.1+wasi-snapshot-preview1`, `wasip2@1.0.4+wasi-0.2.12`
  `wit-bindgen@0.57.1`
- **Apache-2.0/MIT** — compatible; retain applicable notice (3): `cesu8@1.1.0`, `dbus@0.9.12`, `libdbus-sys@0.2.7`
- **BSD-3-Clause** — compatible; retain applicable notice (2): `alloc-no-stdlib@3.0.0`, `alloc-stdlib@0.3.0`
- **BSD-3-Clause AND MIT** — compatible; satisfy every conjunct and preserve notices (1): `brotli@9.0.0`
- **BSD-3-Clause OR MIT OR Apache-2.0** — compatible; choose a permissive stated alternative and preserve its notice (2):
  `num_enum_derive@0.7.6`, `num_enum@0.7.6`
- **BSD-3-Clause/MIT** — compatible; retain applicable notice (1): `brotli-decompressor@6.0.1`
- **CC0-1.0 OR MIT-0 OR Apache-2.0** — compatible; choose a permissive stated alternative and preserve its notice (1):
  `dunce@1.0.5`
- **ISC** — compatible; retain applicable notice (1): `libloading@0.7.4`
- **MIT** — compatible; retain applicable notice (102): `atk-sys@0.18.2`, `atk@0.18.2`, `block2@0.6.2`
  `bytes@1.12.1`, `cairo-rs@0.18.5`, `cairo-sys-rs@0.18.2`, `cargo_metadata@0.19.2`, `cfb@0.14.0`, `combine@4.6.8`
  `darling_core@0.24.1`, `darling_macro@0.24.1`, `darling@0.24.1`, `derive_more-impl@2.1.1`, `derive_more@2.1.1`
  `dlopen2_derive@0.4.3`, `dlopen2@0.8.2`, `dom_query@0.28.0`, `endi@1.1.1`, `gdk-pixbuf-sys@0.18.0`
  `gdk-pixbuf@0.18.5`, `gdk-sys@0.18.2`, `gdk@0.18.2`, `gdkwayland-sys@0.18.2`, `gdkx11-sys@0.18.2`, `gdkx11@0.18.2`
  `generic-array@0.14.7`, `gio-sys@0.18.1`, `gio@0.18.4`, `glib-macros@0.18.5`, `glib-sys@0.18.1`, `glib@0.18.5`
  `gobject-sys@0.18.0`, `gtk-sys@0.18.2`, `gtk@0.18.2`, `gtk3-macros@0.18.2`, `http-body-util@0.1.5`
  `http-body@1.1.0`, `hyper-util@0.1.21`, `hyper@1.12.0`, `ico@0.5.0`, `infer@0.22.0`, `javascriptcore-rs-sys@1.1.1`
  `javascriptcore-rs@1.1.2`, `libredox@0.1.25`, `memoffset@0.9.1`, `mio@1.2.4`, `new_debug_unreachable@1.0.6`
  `objc2-encode@4.1.0`, `objc2-foundation@0.3.2`, `objc2@0.6.5`, `pango-sys@0.18.0`, `pango@0.18.3`
  `phf_generator@0.13.1`, `phf_macros@0.13.1`, `phf_shared@0.13.1`, `phf@0.13.1`, `plist@1.10.1`
  `precomputed-hash@0.1.1`, `quick-xml@0.42.0`, `redox_syscall@0.5.18`, `redox_users@0.5.3`, `rfd@0.16.0`
  `schemars_derive@0.8.22`, `schemars@0.8.22`, `schemars@0.9.0`, `schemars@1.2.2`, `simd-adler32@0.3.10`
  `slab@0.4.12`, `soup3-sys@0.5.0`, `soup3@0.5.0`, `strsim@0.11.1`, `synstructure@0.14.0`, `tokio-util@0.7.19`
  `tokio@1.53.2`, `tower-http@0.6.11`, `tower-layer@0.3.3`, `tower-service@0.3.3`, `tower@0.5.3`
  `tracing-attributes@0.1.31`, `tracing-core@0.1.36`, `tracing@0.1.44`, `try-lock@0.2.5`, `uds_windows@1.2.1`
  `urlpattern@0.6.0`, `want@0.3.2`, `webkit2gtk-sys@2.0.2`, `webkit2gtk@2.0.2`, `webview2-com-macros@0.8.1`
  `webview2-com-sys@0.39.1`, `webview2-com@0.39.1`, `winnow@0.5.40`, `winnow@1.0.4`, `x11-dl@2.21.0`, `x11@2.21.0`
  `zbus_macros@5.19.0`, `zbus_names@4.3.4`, `zbus@5.19.0`, `zcheapstr@1.1.0`, `zmij@1.0.23`
  `zvariant_derive@5.15.0`, `zvariant_utils@4.2.0`, `zvariant@5.15.0`
- **MIT OR Apache-2.0** — compatible; choose a permissive stated alternative and preserve its notice (200):
  `android_system_properties@0.1.6`, `anyhow@1.0.104`, `async-broadcast@0.7.2`, `async-recursion@1.2.0`
  `async-trait@0.1.92`, `base64@0.21.7`, `base64@0.22.1`, `base64@0.23.1`, `bitflags@2.13.2`, `block-buffer@0.10.4`
  `bumpalo@3.20.3`, `camino@1.2.6`, `cargo-platform@0.1.9`, `cfg-if@1.0.5`, `chrono@0.4.45`, `cookie@0.18.2`
  `core-foundation-sys@0.8.7`, `core-foundation@0.10.1`, `core-graphics-types@0.2.0`, `core-graphics@0.25.0`
  `cpufeatures@0.2.17`, `crc32fast@1.5.2`, `crossbeam-channel@0.5.17`, `crossbeam-utils@0.8.23`
  `crypto-common@0.1.7`, `defmt-macros@1.1.1`, `defmt-parser@1.0.0`, `defmt@1.1.1`, `deranged@0.5.8`
  `digest@0.10.7`, `dirs-sys@0.5.0`, `dirs@7.0.0`, `displaydoc@0.2.7`, `dtoa@1.0.11`, `dyn-clone@1.0.20`
  `embed_plist@1.2.2`, `enumflags2_derive@0.7.12`, `enumflags2@0.7.12`, `erased-serde@0.4.10`, `errno@0.3.14`
  `fdeflate@0.3.7`, `field-offset@0.3.6`, `flate2@1.1.10`, `form_urlencoded@1.2.2`, `futures-channel@0.3.34`
  `futures-core@0.3.34`, `futures-executor@0.3.34`, `futures-io@0.3.34`, `futures-macro@0.3.34`
  `futures-sink@0.3.34`, `futures-task@0.3.34`, `futures-util@0.3.34`, `getrandom@0.3.4`, `getrandom@0.4.3`
  `glob@0.3.4`, `hashbrown@0.12.3`, `hashbrown@0.17.1`, `heck@0.4.1`, `heck@0.5.0`, `hermit-abi@0.5.3`, `hex@0.4.3`
  `html5ever@0.39.0`, `http@1.5.0`, `httparse@1.10.1`, `iana-time-zone-haiku@0.1.2`, `iana-time-zone@0.1.65`
  `idna@1.1.0`, `ipnet@2.12.2`, `itoa@1.0.18`, `jni-sys-macros@0.4.1`, `jni-sys@0.3.1`, `jni-sys@0.4.1`
  `js-sys@0.3.106`, `jsonptr@0.7.1`, `keyboard-types@0.8.3`, `libc@0.2.190`, `lock_api@0.4.14`, `log@0.4.34`
  `markup5ever@0.39.0`, `mime@0.3.17`, `ndk-context@0.1.1`, `ndk-sys@0.6.0+11769913`, `ndk@0.9.0`, `num-conv@0.2.2`
  `num-traits@0.2.19`, `once_cell@1.21.4`, `ordered-stream@0.2.0`, `parking_lot_core@0.9.12`, `parking_lot@0.12.5`
  `percent-encoding@2.3.2`, `piper@0.2.5`, `png@0.17.16`, `png@0.18.1`, `powerfmt@0.2.1`, `proc-macro-crate@1.3.1`
  `proc-macro-crate@2.0.2`, `proc-macro-crate@3.5.0`, `proc-macro-error-attr@1.0.4`, `proc-macro-error@1.0.4`
  `proc-macro2@1.0.107`, `quote@1.0.47`, `ref-cast-impl@1.0.27`, `ref-cast@1.0.27`, `regex-automata@0.4.18`
  `regex-syntax@0.8.11`, `regex@1.13.1`, `reqwest@0.13.5`, `rustversion@1.0.23`, `scopeguard@1.2.0`, `semver@1.0.28`
  `serde_core@1.0.229`, `serde_derive_internals@0.29.1`, `serde_derive@1.0.229`, `serde_json@1.0.151`
  `serde_repr@0.1.21`, `serde_spanned@0.6.9`, `serde_spanned@1.1.2`, `serde_with_macros@3.24.0`, `serde_with@3.24.0`
  `serde-untagged@0.1.9`, `serde@1.0.229`, `serialize-to-javascript-impl@0.1.2`, `serialize-to-javascript@0.1.2`
  `servo_arc@0.4.3`, `sha2@0.10.9`, `signal-hook-registry@1.4.8`, `siphasher@1.0.4`, `smallvec@1.16.2`
  `socket2@0.6.5`, `softbuffer@0.4.8`, `stable_deref_trait@1.2.1`, `string_cache@0.9.0`, `swift-rs@1.0.8`
  `syn@1.0.109`, `syn@2.0.119`, `syn@3.0.6`, `tao-macros@0.1.4`, `tempfile@3.27.0`, `tendril@0.5.1`
  `thiserror-impl@1.0.69`, `thiserror-impl@2.0.21`, `thiserror@1.0.69`, `thiserror@2.0.21`, `time-core@0.1.9`
  `time-macros@0.2.32`, `time@0.3.55`, `toml_datetime@0.6.3`, `toml_datetime@1.1.2+spec-1.1.0`, `toml_edit@0.19.15`
  `toml_edit@0.20.2`, `toml_edit@0.25.16+spec-1.1.0`, `toml_parser@1.1.4+spec-1.1.0`, `toml_writer@1.1.3+spec-1.1.0`
  `toml@1.1.7+spec-1.1.0`, `tray-icon@0.25.1`, `typeid@1.0.3`, `typenum@1.20.1`, `unicode-segmentation@1.13.3`
  `url@2.5.8`, `wasm-bindgen-futures@0.4.79`, `wasm-bindgen-macro-support@0.2.129`, `wasm-bindgen-macro@0.2.129`
  `wasm-bindgen-shared@0.2.129`, `wasm-bindgen@0.2.129`, `wasm-streams@0.5.0`, `web_atoms@0.2.6`, `web-sys@0.3.106`
  `web-time@1.1.0`, `windows_aarch64_gnullvm@0.42.2`, `windows_aarch64_gnullvm@0.53.1`
  `windows_aarch64_msvc@0.42.2`, `windows_aarch64_msvc@0.53.1`, `windows_i686_gnu@0.42.2`, `windows_i686_gnu@0.53.1`
  `windows_i686_gnullvm@0.53.1`, `windows_i686_msvc@0.42.2`, `windows_i686_msvc@0.53.1`, `windows_x86_64_gnu@0.42.2`
  `windows_x86_64_gnu@0.53.1`, `windows_x86_64_gnullvm@0.42.2`, `windows_x86_64_gnullvm@0.53.1`
  `windows_x86_64_msvc@0.42.2`, `windows_x86_64_msvc@0.53.1`, `windows-collections@0.3.2`, `windows-core@0.62.2`
  `windows-future@0.3.2`, `windows-implement@0.60.2`, `windows-interface@0.59.3`, `windows-link@0.2.1`
  `windows-numerics@0.3.1`, `windows-result@0.4.1`, `windows-strings@0.5.1`, `windows-sys@0.45.0`
  `windows-sys@0.60.2`, `windows-sys@0.61.2`, `windows-targets@0.42.2`, `windows-targets@0.53.5`
  `windows-threading@0.2.1`, `windows-version@0.1.7`, `windows@0.62.2`
- **MIT OR Apache-2.0 OR LGPL-2.1-or-later** — compatible route via the stated MIT/Apache alternative (2):
  `r-efi@5.3.0`, `r-efi@6.0.0`
- **MIT OR Apache-2.0 OR Zlib** — compatible; choose a permissive stated alternative and preserve its notice (1):
  `raw-window-handle@0.6.2`
- **MIT OR Zlib OR Apache-2.0** — compatible; choose a permissive stated alternative and preserve its notice (2):
  `miniz_oxide@0.8.9`, `miniz_oxide@0.9.1`
- **MIT/Apache-2.0** — compatible; retain applicable notice (11): `bitflags@1.3.2`, `bs58@0.5.1`
  `foreign-types-macros@0.2.4`, `foreign-types-shared@0.3.1`, `foreign-types@0.5.0`, `ident_case@1.0.1`
  `jni@0.21.1`, `json-patch@4.2.0`, `winapi-i686-pc-windows-gnu@0.4.0`, `winapi-x86_64-pc-windows-gnu@0.4.0`
  `winapi@0.3.9`
- **MPL-2.0** — AGPL-compatible under MPL section 3.3 if no opt-out; retain MPL notices/source (5):
  `cssparser-macros@0.7.1`, `cssparser@0.37.0`, `dtoa-short@0.3.5`, `option-ext@0.2.0`, `selectors@0.38.0`
- **Unicode-3.0** — compatible; include Unicode notice (18): `icu_collections@2.3.0`, `icu_locale_core@2.3.0`
  `icu_normalizer_data@2.3.0`, `icu_normalizer@2.3.0`, `icu_properties_data@2.3.0`, `icu_properties@2.3.0`
  `icu_provider@2.3.1`, `litemap@0.8.3`, `potential_utf@0.1.6`, `tinystr@0.8.4`, `writeable@0.6.4`
  `yoke-derive@0.8.4`, `yoke@0.8.3`, `zerofrom-derive@0.1.8`, `zerofrom@0.1.8`, `zerotrie@0.2.5`
  `zerovec-derive@0.11.6`, `zerovec@0.11.8`
- **Unlicense OR MIT** — compatible; choose a permissive stated alternative and preserve its notice (9):
  `aho-corasick@1.1.5`, `byteorder@1.5.0`, `jiff-core@0.1.1`, `jiff-static@0.2.38`, `jiff-tzdb-platform@0.1.3`
  `jiff-tzdb@0.1.9`, `jiff@0.2.38`, `memchr@2.8.3`, `winapi-util@0.1.11`
- **Unlicense/MIT** — compatible; retain applicable notice (2): `same-file@1.0.6`, `walkdir@2.5.0`
- **Zlib** — compatible; retain applicable notice (2): `foldhash@0.2.0`, `zlib-rs@0.6.8`
- **Zlib OR Apache-2.0 OR MIT** — compatible; choose a permissive stated alternative and preserve its notice (17):
  `bytemuck@1.25.2`, `dispatch2@0.3.1`, `objc2-app-kit@0.3.2`, `objc2-cloud-kit@0.3.2`, `objc2-core-data@0.3.2`
  `objc2-core-foundation@0.3.2`, `objc2-core-graphics@0.3.2`, `objc2-core-image@0.3.2`, `objc2-core-location@0.3.2`
  `objc2-core-text@0.3.2`, `objc2-exception-helper@0.1.1`, `objc2-io-surface@0.3.2`, `objc2-quartz-core@0.3.2`
  `objc2-ui-kit@0.3.2`, `objc2-user-notifications@0.3.2`, `objc2-web-kit@0.3.2`, `tinyvec@1.13.3`
