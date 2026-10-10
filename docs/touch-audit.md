# Tabula touch audit — CDX-39

Date: 2026-10-10 UTC  
Repository: Tabula, branch codex/touch-audit at 3dc5dc8e323d0a5bf8eb70d3c38ab8f9a14cc836

## Setup and method

Playwright 1.64 with local test data. iPhone-size WebKit used a 390 × 844 CSS viewport; Pixel 7 Chromium used 412 × 915. Touchscreen taps used Playwright's touch API. For gestures without a Playwright touchscreen method, WebKit used touch-typed pointer sequences and Chromium used CDP touch dispatch. This exercises the browser's touch event path but does not replace testing on physical phones. The keyboard check below is explicitly simulated.

The audit exercised sticky creation and editing, drag, resize, pinch zoom, two-finger pan, long press, multi-select, connector creation, emoji, sharing, comments, and undo. The regular controls sampled by the project's touch-target visual check met 44 × 44 px; the canvas editor rendered at 18 px. Share panels fit within the emulated viewports, emoji insertion kept the editor active and preserved text, and comments could be posted.

The gesture harness confirmed create/edit, move, resize, pinch and pan, multi-select, emoji, share, comments, and connector plus undo in WebKit's pointer-sequence run. On Pixel Chromium, create/edit, move, resize, pinch and pan, multi-select, emoji, share, and comments succeeded. The native-touch harness did not open the menu in its multi-select sequence or create a connector in that run; the project's separate native-CDP visual check did open the single-group menu. The combined multi-selection plus Comments-tray case below failed twice.

## Findings

### P2 — Long-press menu does not open for a multi-selection while Comments is open

Reproduced twice in fresh Pixel-size Chromium runs using the project's native-CDP visual check. Select multiple items, open Comments, then long-press a selected item in the narrow canvas gutter (the check places the press at x=70, y=360). The Comments tray remains open, but no context menu appears within three seconds. The single-group menu control state passes. Relevant harness state is in scripts/visual-check.mjs:2292–2296; the touch-menu opens after a 500 ms press in src/ui/touch-menu.ts:41–53.

Evidence: tabula-review/CDX-39-touch-menu-retry/group-menu-ayu-412.png and tabula-review/CDX-39-touch-menu-retry/group-multi-menu-tray-ayu-412-FAILED.png. The independent repeat is tabula-review/CDX-39-multi-menu-repeat/group-multi-menu-tray-ayu-412-FAILED.png.

### P2 — Comment composer remains behind a simulated mobile keyboard

The comment card was placed near the bottom of the canvas, then visualViewport height was reduced by 300 px and a resize event dispatched to simulate keyboard occlusion. On 390 × 844, the card remained at y=540 with height 196 (bottom 736) while the visible viewport was 544 px, clipping 192 px. On 412 × 915, it remained at y=611 with height 196 (bottom 807) while the visible viewport was 615 px, also clipping 192 px. It did not reposition after the simulated resize.

This is a browser-side viewport simulation, not a native iOS or Android keyboard test. src/ui/comments.ts:69–82 positions against window.innerHeight; the card is placed before focus at lines 408–409, with no visualViewport resize repositioning.

### P2 — Connector touch targets are below 44 px

Source measurement: at default zoom, each connection dot is drawn with a 5 px radius (10 px diameter) in src/render.ts:792–800. src/app.ts:812–821 accepts a touch within a 9 px radius (18 px diameter). These are materially smaller than the 44 px touch-target criterion. A dot tap was not separately measured as an isolated action; the target dimensions are derived from rendering and hit-test code. Repro: select a connectable shape and try to touch one of its four connection dots before dragging a connector.

### Needs follow-up — Native Pixel connector gesture did not produce a connector

The Pixel CDP gesture harness produced zero connectors in its connector-draw step, while the WebKit pointer-sequence run produced one. Because this was not independently repeated with a separate connector-specific scenario, treat it as an unresolved cross-browser result rather than a confirmed product defect. The same Pixel harness sequence also did not open its long-press menu; the repeated multi-selection plus Comments failure is documented above.

## Coverage limits

No accidental-scroll failure or persistent stuck state was observed in the successful flows, but scroll offset was not instrumented as a dedicated pass/fail metric. Native keyboard behavior and the Pixel connector gesture need physical-device or repeated targeted confirmation. The visual check emitted one ResizeObserver loop warning during a touch-target state; the run completed successfully. The WebKit run also logged a blocked external Fontshare request, which did not affect the local interaction checks.

## Evidence and checks

Saved interaction metrics: tabula-review/CDX-39-gesture-webkit.json and tabula-review/CDX-39-gesture-chromium.json. Visual screenshots are under tabula-review/CDX-39-webkit and tabula-review/CDX-39-pixel7.

Checks: npm run lint passed; npm run typecheck passed; npm run -s changelog:check passed (172 fragments); npm test passed (Node 24.10.0, 378 files, 8,589 tests). The initial npm test invocation used the login shell's Node 23.6.0, whose SQLite build lacks the required FTS5 tokenizer; rerunning with Node 24.10.0 first on PATH passed. The visual checks and app build completed successfully during the audit.

The report is uncommitted; no source files were changed.