# Large-board performance baseline

This is a report-only baseline for generated boards containing 500, 2,000, and 5,000 mixed objects. It measures a cold board open, camera pan/zoom rendering, a real 50-object mouse drag, and undo. It does not modify application code; it measures the current build.

## Environment and method

- Revision: `3dc5dc8e323d0a5bf8eb70d3c38ab8f9a14cc836` (`origin/main` at fetch time).
- Production client build served by the local relay; Playwright Chromium `156.0.8078.4`; viewport `1440 × 900`.
- Apple M1 Pro, 10 CPU cores, 32 GB RAM.
- Each board has equal counts of sticky notes, shapes, free connectors, and text objects. The generated records are sent through the app store to an isolated relay. Load samples use three fresh browser contexts with empty IndexedDB, so each must sync the populated board from the relay.
- Board-ready time is navigation start through provider sync, the expected object count in the store, and two animation frames. The initial viewport drew 54 SVG object nodes for each board; the rest were outside the viewport.
- Pan/zoom uses 90 successive `requestAnimationFrame` steps that call the renderer's normal `setCamera` path while changing camera position and zoom. The reported values are intervals between animation-frame callbacks, not a standalone measurement of renderer CPU time.
- Drag selects the first 50 mixed objects and sends a Playwright mouse drag through 12 pointer steps. Drag time is wall time from the first input command through pointer-up, including Playwright's input round trip. Undo calls the app's Yjs `UndoManager` directly and measures synchronous undo plus a two-frame render settle.
- System load was already unusually high: macOS `uptime` reported `256.06 / 225.17 / 199.13` at about 23:46 Stockholm time and `358.18 / 327.17 / 261.08` near 23:53. The increasing load makes these single-run comparisons noisy; treat them as a baseline, not an SLO or a clean-machine capacity claim.

## Measurements

Times are milliseconds. “Ready” and “drag” include their three raw samples; pan/zoom uses 89 measured frame intervals per board. Ratios compare medians with the 500-object result.

| Objects (sticky / shape / connector / text) | Cold board ready, raw (median; ratio) | Pan/zoom frame interval (median / p95 / max; >33 ms) | 50-object drag, raw (median; ratio) | 50-object undo sync, raw (median; ratio) | Undo through two frames, raw |
| --- | --- | --- | --- | --- | --- |
| 500 (125 / 125 / 125 / 125) | 359.2 / 360.2 / 378.8 (360.2; 1.00×) | 16.7 / 16.8 / 16.8; 0 of 89 | 237.92 / 220.13 / 241.01 (237.92; 1.00×) | 5.0 / 3.1 / 3.2 (3.2; 1.00×) | 20.3 / 14.1 / 9.4 |
| 2,000 (500 / 500 / 500 / 500) | 435.4 / 407.5 / 396.9 (407.5; 1.13×) | 16.7 / 16.8 / 16.8; 0 of 89 | 309.86 / 325.24 / 212.42 (309.86; 1.30×) | 5.7 / 4.8 / 4.0 (4.8; 1.50×) | 23.1 / 26.2 / 18.8 |
| 5,000 (1,250 / 1,250 / 1,250 / 1,250) | 520.8 / 513.8 / 508.5 (513.8; 1.43×) | 16.7 / 16.8 / 33.3; 1 of 89 | 352.43 / 399.14 / 329.14 (352.43; 1.48×) | 9.5 / 6.7 / 6.5 (6.7; 2.09×) | 30.4 / 19.1 / 11.2 |

The 5,000-object board was 10× the size of the 500-object board. Its median cold-ready time was 1.43×, median drag time was 1.48×, and median synchronous undo time was 2.09×. Compared with 2,000 objects, 5,000 objects took 1.26× as long to become ready, 1.14× as long for the 50-object drag, and 1.40× as long for synchronous undo. Pan/zoom p95 stayed at 16.8 ms; the 5,000-object run had one interval of 33.3 ms.

## Hotspot candidates from code inspection

These are code-path candidates, not proof that each dominates the measured timings.

1. **Initial object hydration:** `src/sync.ts:298` waits for IndexedDB and `src/sync.ts:299` constructs the store. `src/store.ts:115` materializes each Y.Map, followed by separate bound-index, child-index, and orphan-refresh passes at lines 116–118 and 682–803. A single construction pass could populate the cache and indexes together; orphan discovery could avoid work when there are no relevant container records.
2. **Initial camera fit:** `src/app.ts:298` requests full content bounds at board mount. `src/render.ts:564` visits every shown object, and `src/render.ts:544` begins lazy connector-layout construction. Maintain bounds incrementally or defer the fit until derived geometry is ready.
3. **Pan/zoom traversal:** `src/render.ts:420` schedules a render for each camera change; `src/render.ts:637` then traverses the ordered shown-object list and `src/render.ts:641` checks every object's bounds for viewport intersection, even when most are culled. A spatial index or a camera-only path that avoids full reconciliation could reduce per-frame work.
4. **Selection drag work:** `src/app.ts:1838` handles drag updates; on the first move, `src/app.ts:1850` builds guide references from the whole shown board, and `src/app.ts:1865` starts the selected-object transaction. `src/app.ts:1862` looks for a frame target. Store changes invalidate the ordering cache at `src/store.ts:189`, causing another full-board sort on the next render. Preview transforms until commit, spatial queries for guides and targets, and field-aware order invalidation are candidate improvements.
5. **Structural undo cleanup (not exercised by this position-only drag):** parent changes and deletions can reach `src/store.ts:197`, where `emptyGroupIds()` scans the object map at `src/store.ts:510`. Local reparent updates invoke empty-group cleanup at `src/store.ts:459`. Child counts or targeted ancestor cleanup could avoid repeated scans. Plain x/y-only undo avoids this structural scan but still updates the cache and invalidates ordering.

The only measured actions were cold open, camera movement/zoom, a 50-object position drag, and its position-only undo. The report does not measure structural undo, real network latency, persistent-storage failure modes, touch input, or performance on other browsers/devices. A repeat on an otherwise idle machine is needed before setting performance targets.
