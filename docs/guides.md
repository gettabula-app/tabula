# Smart guides

While you move or resize objects, the board shows when edges and centres line up with other objects, and when the space between objects is equal, and snaps to both. It builds on the alignment guides and grid snapping that `src/app.ts` already has; it does not replace them.

Status: spec for review. Nothing is built yet.

## Summary

- **Alignment** (move and resize): edges and centres of the dragged object snap to edges and centres of nearby objects. The guide is a line drawn between the aligned objects, not across the viewport.
- **Equal spacing** (move and resize): the gap to the nearest neighbour snaps to an existing gap between other neighbours in the same row or column, or the object snaps to the exact middle between two neighbours. Every equal gap gets a small bracket with its distance.
- **One new pure module**, `src/guides.ts`, builds a sorted index once when a drag starts and answers a query per pointer move. `doMove` and `doResize` call it. No stored data changes.
- **Alt** still turns everything off (grid, alignment and spacing), as today.
- A new theme colour token `--guide`, defined for all five themes and checked for contrast.

## What exists today

- `snapOn(e)` is true when `meta.snap` is on, the grid type is not `none`, and Alt is not held. It drives grid snapping in `doMove`, `doResize`, `snapPoint` and the create drag.
- `doMove` loops over every object on each pointer move (`store.ordered()` plus `r.bounds`), keeps the visible non-moving ones, and snaps left, centre and right (top, middle, bottom) of the selection's `d.bounds` to the nearest candidate within `6 / zoom`. Per axis, an alignment wins, otherwise the grid applies. It draws a full-viewport line from the overlay field `guides`, in a hard-coded `#E0559B`.
- `doResize` only grid-snaps the moving edges, and only when the object is not rotated and the aspect ratio is not locked.
- The guide code ignores `meta.snap`: guides work with snapping to the grid switched off, and with the grid set to `none`.

## Decisions and why

- **Extend `doMove`/`doResize`, do not add a second system.** The new module replaces the inline candidate loop in `doMove` and adds the same call to `doResize`. The overlay field `guides` stays the single channel to the renderer.
- **Pure module, built once per drag.** Today every pointer move walks all objects. The index is built on the first move of a drag and each query is a handful of binary searches. The module takes plain rectangles and imports no DOM, store or renderer code, so it is unit-tested like `geometry.ts`.
- **Body bounds, not renderer bounds.** References and the moving rectangle use `boxBounds`: the axis-aligned bounds of the box, rotation included. A frame's 28 px title band (which `Renderer.bounds` adds) is ignored, so a note aligns with the frame's border and not with the top of its label. See open question 1.
- **Edges that move are the only edges that snap in a resize.** The opposite edge stays put. The centre of a resized object moves at half speed, so snapping it would feel like a pull in the wrong direction.
- **Snap, then show what is true.** The query first picks the correction per axis, then re-checks the corrected rectangle and reports every alignment and every equal gap that holds there. So two lines appear when both edges happen to align, and a gap marker appears on each equal gap, not only the one that caused the snap.
- **Alignment and spacing share the 6 px threshold**, in screen pixels divided by zoom, as today. Equal spacing gets a 2 px head start over alignment (see Choosing a correction).
- **Label text uses the canvas ink on a canvas-coloured pill**, with only the bracket and the pill outline in the guide colour. The label then reads on any content and needs no extra contrast rule for the guide colour (see Colour).
- **No toggle in this slice.** Alt is the bypass. Cmd/Ctrl are not used: Ctrl/Cmd+wheel (and trackpad pinch, which arrives as Ctrl+wheel) zooms in `onWheel`, so it can happen mid-drag; Ctrl/Cmd is the shortcut modifier in `bindKeys` (undo, select all, duplicate); and Ctrl+click is a right click on macOS. Shift keeps selection and aspect-ratio duties.

## Algorithm

All numbers are world units unless marked "screen". `thr = SNAP_PX / zoom` with `SNAP_PX = 6`. `EPS = 0.1` is the tolerance for deciding that two values are equal after a snap. `MIN_GAP = 4 / zoom` (4 screen px): smaller gaps are not matched and get no marker.

### Candidate set (once per drag)

On the first pointer move past the 3 px drag threshold, `app.ts` builds a session:

1. `referenceRects(store.ordered(), skip, isHidden)` returns `boxBounds` of every object that is a box (connectors are not), is not in `skip`, and is not hidden by private writing (`flow.isHidden`). `skip` is the moving set: `d.ids` for a move (it already includes the children of moved frames), and the resized object's id for a resize. Locked objects stay in as references. Freehand paths and frames are references like any other box; a frame's children are references while the frame itself is resized.
2. `startGuides(refs, movers, view)` keeps the references that intersect `view`, which is the current viewport grown by 50% of its width and height on every side, and builds the index. `movers` are the `boxBounds` of the moving boxes. Their union is the moving rectangle for a move (the selection's union bounds, so a multi-selection snaps as one object). A resize passes no movers.
3. If the camera later leaves the built region (a wheel pan or a zoom out during the drag), the next pointer move asks `guidesCover(session, viewport)` and rebuilds when it is false. A pan inside the margin costs nothing.

The index holds, per axis, sorted arrays of every reference's low edge, centre and high edge: `value`, the rectangle it belongs to, and a kind (0 low, 1 centre, 2 high). Rectangles are also kept as they are, in one flat array, for the spacing pass.

### Alignment

For the proposed moving rectangle `R` (move: the union of the moving boxes shifted by the pointer delta; resize: the proposed rectangle with the moving edges at the pointer), per axis:

- The values that may snap are `R`'s low edge, centre and high edge for a move, and only the moving edge for a resize.
- Each value does a binary search in the sorted array. Any pair counts: edge to edge, centre to centre, edge to centre, and low edge to high edge (so objects can be made to touch).
- The correction is the smallest `|candidate - value|` that is at most `thr`. A tie within `EPS` goes to centre-to-centre, then edge-to-edge (same kind), then mixed pairs, then the smaller coordinate. This keeps results stable between pointer moves.

After the final correction, every moving value that lies within `EPS` of any reference value gets a guide line at that coordinate. A line runs from the smallest to the largest extent, on the other axis, of the moving rectangle and of every reference that has a value there. Those references are the equal-value range of the sorted array around the coordinate, found by binary search and walked in `O(k)` for `k` aligned objects.

### Equal spacing

Rows give horizontal gaps and snap `dx`. Columns give vertical gaps and snap `dy`. A column is the row algorithm with the axes swapped; the text below describes rows.

**Row.** The references whose vertical extent overlaps `R`'s vertical extent by more than `EPS`, taken at the proposed position. A reference that fully contains `R` is a container (a frame or a backdrop): it is not a row member and takes no part in spacing, but it still aligns. Row membership is computed per axis from the proposed position before any correction; a vertical correction does not re-open the row choice.

**Free gaps.** Sort the row members by left edge and sweep, keeping the largest right edge seen. Whenever the next member starts beyond it, the stretch between is a free gap with its two flanking members. Overlapping members merge, so a member stacked above another in the row never creates a gap. This is the set `F` of existing gaps between other objects. Gaps below `MIN_GAP` are dropped.

**Neighbours.** The left neighbour `A` is the member with the largest right edge that is at most `R.left + thr`. The right neighbour `B` is the member with the smallest left edge that is at least `R.right - thr`. A member that `R` overlaps by more than `thr` is neither, since the object is on top of it.

**Candidates.**

- **Match.** For every distinct size `g` in `F`: place `R` so `R.left = A.right + g`, and place `R` so `R.right = B.left - g`. This is "the gap to the nearest neighbour equals an existing gap between other neighbours".
- **Midway.** When both neighbours exist, place `R` so `R.left = (A.right + B.left - R.width) / 2`, giving equal gaps on both sides. Only if both resulting gaps are at least `MIN_GAP`.

A candidate is dropped when `|correction| > thr`, or when the corrected `R` would overlap another row member by more than `EPS`. `F` is deduplicated by size and the candidates are tried in order of `|correction|`, stopping at the first valid one, so the overlap check runs on a few candidates, not on all of `F`. The smallest correction wins; a tie within `EPS` goes to the smaller coordinate.

**Resize.** Only the moving edge moves, so only match candidates for that edge apply, plus one extra target: the gap on the moving side may equal the gap on the fixed side (`R.right = B.left - (R.left - A.right)` for the east handle). There is no midway. The row is taken at the proposed vertical extent; a north or south handle snaps through the column of the proposed horizontal extent.

**Markers.** At the corrected position (the row is recomputed there), compute the gaps next to `R` (`R.left - A.right` and `B.left - R.right`, ignoring any below `MIN_GAP`). A marker group is made of:

- each side gap that equals (within `EPS`) any gap in `F`, together with every gap in `F` of that size;
- both side gaps, when they equal each other (the midway case), together with any gap in `F` of that size.

A marker is `{ axis, from, to, at, label }`. `at` is the cross-axis coordinate of the bracket: the middle of the overlap of the two flanking objects, or the middle of `R` when they do not overlap. `label` is the size rounded to a whole number. Markers are capped at six per axis: the one or two next to `R`, then the four nearest to `R`. In a resize only the side of the moving edge is marked.

### Choosing a correction

Per axis the query has up to one alignment correction `a` and one spacing correction `s`. Both are additive offsets.

- If only one exists, it wins.
- Otherwise the smaller `|correction|` wins, except that spacing gets `2 / zoom` of head start: spacing wins when `|s| <= |a| + 2 / zoom`. Alignment candidates are everywhere on a busy board, spacing candidates are rare and deliberate, and without the head start a nearby edge would hide them most of the time.
- If `a` and `s` land on the same position (within `EPS`), nothing is lost: the display pass reports the alignment line and the gap markers together.

Only the winner moves the object. Lines and markers are reported only for an axis that snapped, from the corrected rectangle, so they never describe a position the object is not at.

### Combining with grid snapping

The result has `dx` and `dy` as corrections, or `null` for an axis with no candidate within the threshold. The caller then keeps today's rule per axis:

```
if (snap.dx !== null) dx += snap.dx;           // alignment or spacing beats the grid
else if (this.snapOn(e)) dx = snapTo(...) ...  // otherwise the grid, as now
```

An aligned position can be off-grid; that is intended. With `meta.snap` off or the grid set to `none`, guides still work, as they do now. Holding Alt skips the query, the grid and the overlay lines and markers.

### Move

`dx`/`dy` is the pointer delta. `snapMove(session, dx, dy, zoom)` returns the corrections for it. The moving rectangle is the union of the moving boxes, shifted by the pointer delta. When there are no moving boxes (a selection of only connectors) there is no session: the query is skipped and the grid fallback applies as today.

### Resize

`doResize` runs the guide query when `!e.altKey && !o0.rotation && !keepAspect`. This is the grid snap's condition without `snapOn`, because guides do not depend on `meta.snap`. A rotated object, an icon or UML actor, and a Shift-resize of a corner do not get guides (see Not in this slice). The proposed rectangle is `boxBounds(o0)` with the moving edges replaced by the pointer's position (`l`, `t`, `r`, `b` offset by `o0.x`, `o0.y`). `snapResize(session, rect, handle, zoom)` returns `dx` for the moving x edge (`w` or `e`) and `dy` for the moving y edge (`n` or `s`). A corner handle has one of each; a text object only has `w` and `e`.

The query is skipped while the proposed width or height is below the 8 px minimum, and a snap that would take the size below it is discarded. The existing minimum-size clamp then runs as it does now, after the snap.

## Behaviour

- **Distance labels** show world units, so they do not change with zoom.
- **The line is drawn between objects**, from the end of the moving object to the end of the farthest aligned object. Several aligned objects share one line.
- **Rotated objects** use their axis-aligned bounds, both as references and as the moving object. Resizing a rotated object has no guides, as it has no grid snap today.
- **Multi-select** moves as one rectangle, the union of the selection's bounds. Locked objects are not in the selection, but stay as references. Carried frame children are part of the moving set and are never references during that drag.
- **Hidden notes.** Objects that private writing hides (`flow.isHidden`) are never references, so their positions cannot leak through a guide. The current guides do not make this check and can reveal where a hidden note sits; this fixes it.
- **Pointer drags only.** Arrow-key nudging, the create drag, the pen and connector endpoints are unchanged.
- **Alt** disables guides, markers and the grid together. The shortcut list in the board menu already reads "Alt while dragging: Ignore grid and guides" and stays accurate.
- **Touch** has no Alt, so guides are always on there, as they are today.
- **Performance.** Alignment is a binary search per value, `O(log n + k)`. The spacing pass filters the row and column from the viewport-filtered set with one linear sweep, sorts the `m` row members, and sweeps again, so it is `O(n_view + m log m)`, not `O(log n)`. With `n_view` around 1000 that is a few thousand comparisons per pointer move, well inside a frame. If the smoke test shows it is not, the filter becomes an interval tree over the sorted array without changing the module's API.

## Rendering

- The overlay field `guides` widens from line segments to a union, so the renderer and `onUp`'s reset (`guides: []`) need no new field:

  ```ts
  export type Guide = GuideLine | GapMark;
  export interface GuideLine { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  export interface GapMark { kind: 'gap'; axis: 'x' | 'y'; from: number; to: number; at: number; label: string }
  ```

  The types live in `src/guides.ts`; `src/render.ts` imports them as types.
- **Line**: 1 screen px, `var(--guide, #E0559B)`.
- **Gap marker**: a line from `from` to `to` at `at`, 1 screen px, with an 8 px tick at each end across the gap, in `var(--guide, #E0559B)`. The label sits centred on the line in a pill filled with `var(--canvas, #EEF1F4)`, outlined 1 px in the guide colour, text in `var(--canvas-ink, #18212B)`, 11 px, weight 600, in the font stack the vote badges use. The pill hides the line behind it, as a dimension line does. Sizes are `px(n) = n / zoom`, so everything stays the same on screen at every zoom.
- The fallback hex values are in TypeScript strings, as `CANVAS_INK` in `palette.ts` does. No hex literal is added to any CSS file outside `:root`, so `test/css-colors.test.ts` is unaffected.
- Guides are part of the overlay, so PNG, SVG, `.drift` and the Markdown summary never contain them.

### Colour

A new token `--guide`, one per theme:

| Theme | `--guide` | on `--canvas` | on `--paper` |
| --- | --- | --- | --- |
| Default | `#E0559B` (unchanged from today) | 3.12 | 3.53 |
| Ayu | `#FF7EB6` | 6.59 | 5.87 |
| Kanagawa | `#D27E99` | 5.59 | 4.84 |
| Matrix | `#FF4FA3` | 6.56 | 6.16 |
| Evergreen | `#D6247F` | 4.23 | 4.75 |

It is a pink that no other token uses, so it does not read as selection (`--wire`), activity (`--signal`) or error (`--danger`). The values are proposals; the test is the gate. Lines and brackets are graphics, so the rule is WCAG's 3:1 for non-text contrast against `--canvas` (and, as an extra check, against `--paper`, the default object fill). The label text uses `--canvas-ink` on `--canvas`, a pair `test/themes.test.ts` already holds to 4.5:1.

`--guide` must be added to `THEME_VARS`, to the `vars` of all five themes, and to `:root` in `src/styles.css`. The `:root` entry is required, not optional: `applyTheme('default')` removes the inline overrides, so the default theme gets its colour from `:root`. The existing test that every theme defines every variable covers the first two.

## Out of scope and TAB-74

- No change to stored data: no schema, no Yjs field, no export.
- Placing a new shape at sibling spacing from the connect-handle click (TAB-74, `quickConnect`) is built separately. The module is meant to serve it without being edited: `src/guides.ts` exports `gapsInBand(session, axis, lo, hi)`, the function that returns the free gaps of a row or column, because spacing needs it anyway. `quickConnect` can ask for the gaps in the source's row or column, take the most common one (or the one nearest the source), and use that in place of the fixed `gap = 96`. It can then run `snapMove` on the new shape's rectangle with the source excluded, to pick up alignment with other siblings. `quickConnect` is not changed here, and neither side needs the other to merge.

## Tests

New `test/guides.test.ts`, pure functions only, built on rectangles. `test/core.test.ts` and `test/themes.test.ts` otherwise stay as they are.

1. Alignment pairs: each of the nine value pairs (low, centre, high against low, centre, high) snaps, in x and in y.
2. Threshold and zoom: a candidate at 5.9 px snaps, at 6.1 px does not, at zoom 0.5, 1 and 4; `thr` is `6 / zoom`.
3. Choice: the smallest correction wins; a tie goes to centre-to-centre, then edge-to-edge, then the smaller coordinate; the result is the same on repeated calls.
4. Guide extents: the line spans the moving rectangle and every reference with a value there, including references aligned by centre and by edge; a second line appears when the other edge aligns as well (equal widths).
5. Equal gaps in a column, the reported case: three rectangles, a gap of 50 between the first two; the third snaps to a gap of 50 below, and from above the first; markers on both gaps, label `50`.
6. Equal gaps in a row, the mirror of 5.
7. Row membership: a gap in a row that does not overlap the moving rectangle's span is ignored; a container is not a row member but still aligns.
8. Midway: placed between two neighbours it snaps to the centre and marks both gaps; refused when the space is too small; refused when it would overlap a third member.
9. Alignment versus spacing: the closer one wins; spacing wins with a correction up to 2 px worse; a tie goes to spacing; when both land on the same position, lines and markers are both reported.
10. Grid fallback: `dx` and `dy` are `null` with no candidate in range, and no lines or markers are reported for that axis.
11. Marker cap: more than six equal gaps in a row yields six, the nearest to the moving rectangle.
12. `MIN_GAP`: touching objects (gap 0) and gaps under 4 screen px produce no spacing candidate and no marker.
13. Resize: for each of the eight handles only the moving edges snap; the opposite edge and the centre never do; spacing applies to the moving edge, including the fixed-side-gap target; no midway; a snap below the minimum size is discarded.
14. Multi-select: `startGuides` with three movers snaps their union as one rectangle; a mover is never its own reference.
15. Rotated reference: a rotated box enters as its `boxBounds`, and aligns by those edges.
16. `referenceRects`: connectors excluded, hidden excluded, the moving set excluded, locked included, frames and paths included.
17. Region: references outside the expanded viewport are dropped; `guidesCover` is true inside the margin and false outside.
18. Invariant check over random layouts: after applying a spacing correction, each reported gap in a group differs from the others by less than `EPS`, and each reported line coincides with a moving value.
19. Performance smoke: 1000 rectangles on a loose grid, build once, then 2000 move queries and 2000 resize queries; the whole run must finish under a generous budget (1.5 s, since CI runs three operating systems and three Node versions and Windows runners are slow). Normal runs should take a small fraction of that; the test guards against an accidental `O(n^2)`, not for tuning.

In `test/themes.test.ts`: `--guide` against `--canvas` and against `--paper` must be at least 3:1 in every theme. This is a separate assertion, not an entry in `TEXT_PAIRS`, which checks 4.5:1.

Behaviour in the browser is checked by hand, as the repo has no UI test harness: drag one object past three stacked rectangles and see the equal gaps; drag between two to see midway; resize an edge into a gap; select several and move; Alt bypasses; each theme in light and dark; zoom out to 25% and in to 400%; a frame with children; a board with many objects stays smooth.

Before reporting an implementation: `npm run lint`, `npm run typecheck` and `npm test`.

## Not in this slice

- A setting to turn guides off separately from Alt, or a board-level "smart guides" switch.
- Guides for the create drag, the pen, connector endpoints, rotation and arrow-key nudging.
- Guides while resizing a rotated object, or while the aspect ratio is locked (Shift, icons, UML actors). With the ratio locked, one edge is derived from the other, which needs its own rule.
- Spacing scoped to siblings inside one frame. A container that fully contains the moving rectangle is skipped; objects inside and outside a frame can still be neighbours.
- Equal spacing across a grid of rows and columns together (Figma's distribution of rows and columns), and spacing between more than the nearest neighbours.
- Snapping to a frame's title band, to objects far outside the viewport, or to the rotated outline of a rotated object.
- Extra crosses or tick marks at each aligned point, and a size and position readout while resizing.
- A touch-friendly way to bypass snapping.
- A change to Alt as the bypass, or any use of Cmd/Ctrl.

## Files

### New

- `src/guides.ts`: pure module. `referenceRects`, `startGuides`, `guidesCover`, `snapMove`, `snapResize`, `gapsInBand`, the `Guide` types and the constants (`SNAP_PX`, `EPS`, `MIN_GAP_PX`). It imports types from `./types` and `boxBounds`, `unionRects` from `./geometry`, nothing else.
- `test/guides.test.ts`: the tests above.
- `docs/guides.md`: this document.

### Existing (touched)

- `src/app.ts`, kept small:
  - one new import line, `import { ... } from './guides';`, as its own line below the others. The existing `./geometry` import line is not edited.
  - `Drag`: an optional `guides?: GuideSession` on the `move` and `resize` variants (the two lines that declare them).
  - `doMove`: the inline candidate loop is replaced by a session built on first use and one `snapMove` call; the grid fallback stays as it is.
  - `doResize`: one session and one `snapResize` call before the grid snap, under the gate given in Resize.
  - Nothing else. In particular `onUp` (its `guides: []` reset already clears both kinds), `updateHover`, `anchorAt`, `quickConnect` and the import line from `./geometry` are untouched, because the connector-handle work (TAB-74) edits them.
- `src/render.ts`: `Overlay.guides` becomes `Guide[]`; draw lines and gap markers from the `--guide` token. `emptyOverlay` is unchanged.
- `src/themes.ts`: `'--guide'` in `THEME_VARS` and in the five themes.
- `src/styles.css`: `--guide` in `:root`.
- `test/themes.test.ts`: the `--guide` contrast assertion.
- `README.md`: the Grid row says "alignment guides and equal-spacing guides to nearby objects, Alt to bypass"; `src/guides.ts` goes in the layout list next to `src/render.ts`.
- `CHANGELOG.md`: an Added entry under Unreleased, in the implementation commit.

Not touched: `src/geometry.ts` (all new geometry lives in `src/guides.ts`), `src/store.ts`, `src/types.ts`, `src/flow.ts`, `src/ui/`, `server/`, `src/markup.ts`, `src/exporters.ts`.

## Open questions

1. Frames: ignore the 28 px title band (recommended, body edges) or keep the renderer's bounds as the current guides do? Keeping them is less code but aligns a note with the top of a frame's label.
2. The 2 px head start for spacing over alignment. The alternative is plain nearest-wins with ties going to alignment. Spacing would then often lose on a busy board.
3. Resize with Shift (aspect ratio locked) and rotated objects: no guides in this slice. Is that acceptable? Shift-resize is common; supporting it means choosing which edge snaps and deriving the other.
4. Resize spacing: match the moving edge to existing gaps and to the fixed-side gap, no midway. Enough?
5. Containers: a frame or backdrop that contains the moving rectangle is skipped for spacing. Should spacing instead be limited to siblings of the same frame?
6. A separate switch for guides (board menu) in addition to Alt? Guides today ignore `meta.snap`; someone who turns off grid snapping still gets them.
7. Colours: keep Default at `#E0559B` (3.12:1 against the canvas, just over the line) or deepen it to `#D6247F` (4.19:1)? Evergreen is `#D6247F` because its canvas is light too.
8. Label text in the canvas ink with a guide-coloured outline (recommended) or in the guide colour? The second needs every `--guide` to reach 4.5:1 against the canvas, which changes the Default theme.
9. Labels in world units, rounded. Show one decimal below 10?
10. Candidate region of 50% of the viewport on each side, and a rebuild when the camera leaves it. Larger or smaller?
11. Cap of six markers per axis (two next to the object, four others). Fewer?
12. Should TAB-74 use `gapsInBand` as described, or does the neighbour search it already adds to `geometry.ts` make a shared helper unnecessary? The two could be unified later without changing either public API.
