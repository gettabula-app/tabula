# Groups: visual states

TAB-106, slice 2. The look of selecting, hovering, entering and locking a group, and of the Group and Ungroup buttons on touch, for the five themes. It extends [groups.md](groups.md) (which says what happens) with what it looks like. Nothing here changes the data model.

The mocks are drawn from the themes' own variables in `src/themes.ts` and regenerate with `node scripts/groups-visual-mock.mjs`. Each PNG in `docs/groups-visual/` has the five themes side by side (default, ayu, kanagawa, matrix, evergreen).

## Principles

1. **A group reads as one thing with a body.** One solid outline round the whole, the members faintly visible inside it. A set of items you merely selected keeps today's look (dashed box, every member outlined), so "I selected three things" and "this is a group" never look alike.
2. **Colour is never the only cue.** Selected is a solid line, hovered a lighter line, entered a dashed line with a name chip, locked a lock badge. Each also differs in weight or shape, so they hold up in Matrix and for colour-blind people.
3. **Theme variables only.** No literal colours; every token below is built from a variable that `src/themes.ts` already defines (`css-colors.test.ts` enforces this for CSS). The overlay lives in SVG, so the strings are `var(--wire)` and friends, as `GUIDE` already does in `render.ts`.
4. **Constant on screen.** Every length goes through `px()` (1 / zoom), as the other overlays do, so lines and handles keep their thickness at 11% and at 400%.
5. **Quiet.** Nothing animates except the 120 ms fade of the dim; under `prefers-reduced-motion` that is instant.

## Tokens

Defined once, on the board's root (`.chrome` or `:root`, wherever `--guide` is read), derived from the theme. Slice 2 puts them at the top of `src/ui/group-ui.css`.

```css
:root {
  --group-line:       var(--wire);                                       /* selected outline, handles' stroke, entered dashes */
  --group-line-soft:  color-mix(in srgb, var(--wire) 45%, transparent);  /* the members' own outlines inside a selected group */
  --group-hover:      color-mix(in srgb, var(--wire) 70%, transparent);  /* hover outline of what a click would select */
  --group-handle:     var(--paper);                                      /* handle fill (today a literal #fff) */
  --group-dim:        color-mix(in srgb, var(--canvas) 62%, transparent);/* the board outside an entered group */
  --group-locked:     var(--graphite);                                   /* hover outline of a locked group */
  --group-chip-bg:    var(--tray);                                       /* name chip, Done chip, lock badge */
  --group-chip-ink:   var(--tray-text);
  --group-chip-line:  var(--tray-line);
}
```

Contrast of the lines against each theme's canvas (non-text UI needs 3:1; WCAG 1.4.11): `--wire` default 4.0, ayu 9.0, kanagawa 5.9, matrix 11.0, evergreen 4.3; `--graphite` 5.2, 5.2, 6.7, 6.4, 5.2. The chips use the tray pair (10.5 to 15.4:1). The soft member outline (45%) is decoration, not information, and is not held to 3:1.

**Not in slice 2: the single-item selection.** `render.ts` draws every selection, handle and hover with the constant `WIRE = '#2F6FED'` and white handles, in every theme. `--wire` is defined in all five themes and equals `#2F6FED` in default, so the group overlay reads `var(--wire)` and `var(--group-handle)` and looks the same as a single item there; in Ayu, Kanagawa, Matrix and Evergreen it follows the theme while single items keep the old blue until the follow-up below. That interim difference is accepted: copying the constant into the group tokens would bake the Matrix problem (a fixed blue on a green board) into the new feature.

## 1. Selected: item, several items, group

`selected.png`.

| | One item (as today) | Several items (as today) | A group (new) |
|---|---|---|---|
| Outline | 1.5 px solid `--group-line` round the item | dashed 1 px (5 4) box 6 px out, plus every member outlined 1.5 px solid | **solid 1.5 px** box 6 px out round the derived rectangle, members outlined **1 px in `--group-line-soft`** |
| Handles | 8 squares, 9 px, 2 px radius, fill `--group-handle`, stroke 1.5 px `--group-line`; rotate circle 10 px above | corner and edge squares on the dashed box, no rotate | the same 8 squares and rotate circle on the solid box |
| Label | none | none | **name chip** at the outline's top-left, 6 px above it: `Group · 3` (the group's `name` once it has one, else "Group" and the member count), tray colours, 11 px, 600 weight, 20 px high, no radius |

The chip is the one extra mark: it is what tells a group from a plain multiple selection at a glance, and it is where the name is read. It moves with the outline, hides while dragging or resizing (so it never trails behind), and is not drawn below 30% zoom, where the solid box already says "group". Nested: the chip shows the selected group's own name only.

On touch (`pointer: coarse`) handles are 16 px (as `render.ts` already does for a single item) and the chip stays 20 px high.

## 2. Hover over a member of an unselected group

`hover.png`.

Hovering any member outlines the **whole group** a click would select: 1.5 px solid `--group-hover` round the derived rectangle, 6 px out, and nothing round the member itself. A single item (today) keeps its 1.5 px outline at the same 70% (`render.ts` uses 0.6; use `--group-hover` for both so they match). No chip on hover: it would flash as the pointer crosses a board, and the outline is enough to say what the click picks. While a dot vote runs the hover goes back to the single item, because a click votes for the item ([groups.md](groups.md), Selecting).

## 3. Inside a group

`inside.png`.

- **Dim**: everything outside the entered group is covered by a `--group-dim` wash (the canvas colour at 62%), drawn between the outside items and the group's members, so members stay fully lit and the rest recede but stay legible. This reuses the dimming that exists for a focused frame step (`docs/groups.md`, "Entered state"); only the colour token is new, which makes it follow the theme on dark boards.
- **Bounds**: 1.5 px **dashed** (6 4) `--group-line` round the group's rectangle, 6 px out. Dashed against the solid of selection is the second cue besides the dim.
- **Name chip** at the top-left, as in section 1, with the **path** when nested: `Header › Notes` (names joined by a right angle quote, truncated in the middle past about 28 characters, the full path in `title`/`aria-label`).
- **Done chip** at the top-right of the bounds, same line: `Done · Esc`. It is a button (tray colours, 20 px high on a pointer, **44 px on touch**, where there is no Esc to show, so it reads just `Done`). Clicking it, pressing Esc, or tapping empty canvas leaves one level.
- Nothing else changes: members select, move, and resize as normal items inside; the chips ride at the top of the bounds and stay on screen (clamped 8 px inside the viewport, under the top bars).

Esc moves the dim and chips to the parent group if there is one, so the breadcrumb loses its last part: that is the "one level at a time" rule drawn.

## 4. A locked group

`locked.png`.

Locked things are quiet in Tabula today: nothing marks them at rest, and the badge appears when the pointer is over one (`ov.lockedHover`). Groups keep that.

- **At rest**: no mark, as for any locked item.
- **Pointer over it**: outline 1.5 px solid `--group-locked` round the group's rectangle (graphite, not wire: it is *not* about to be selected, and a blue outline would promise that), and the lock badge at the top-right corner: a 22 px circle in tray colours with a 1.5 px `--group-chip-ink` ring and the lock glyph (`render.ts` draws it with literal `#18212B` and white; use `--group-chip-bg` and `--group-chip-ink`).
- The long-press unlock lifts to the outermost locked ancestor, so the badge and outline are those of the group, never of a member inside it.
- Locked **inside** an unlocked group (a member locked on its own): the hover badge shows on the member as today.

## 5. Group and Ungroup in the quick-action bar on touch

`touch.png`.

- **Group** shows when two or more items are selected at one level; **Ungroup** shows instead when exactly one group is selected. Never both.
- Each is an **icon plus a text label** (`qb-text` button): the two icons are not common enough to carry the meaning alone, and a label costs 70 px on a bar that scrolls (TAB-239). Height 44 px and min width 44 px, which `icon-btn` already gets on `pointer: coarse`.
- Position in the bar: right after the colour and text controls, before lock, duplicate and delete, with a separator on each side, so the destructive buttons stay together at the end.
- The mock shows Group in the `.on` (signal) state only to show where it sits. Do not ship it permanently highlighted; it is a normal button.
- Icons, on the 24 px grid, 2 px stroke, `currentColor` (the SVG is in `scripts/groups-visual-mock.mjs`): **Group** is four corner brackets round a small square; **Ungroup** is two separate squares joined by a dashed path. Slice 2 adds them to `src/ui/icons.ts` as `group` and `ungroup`.
- Keyboard users have the same buttons, in the same bar, in tab order after the text controls. `aria-label` "Group" and "Ungroup"; the chip's name chip is `aria-hidden` (the layers panel and the selection announcement carry the name).

## What changes in code (for slice 2)

| Where | Change |
|---|---|
| `src/ui/group-ui.css` (new) | the tokens above; `.group-chip`, `.group-done` (the Done chip as an HTML button over the board, positioned from the bounds like the quick bar); 44 px `.group-done` under `(pointer: coarse)` |
| `src/render.ts` | `WIRE` to `'var(--wire, #2F6FED)'` for outlines and handles; handle fill `var(--group-handle, #fff)`; group selection: solid box plus members at `--group-line-soft` plus chip; hover: `--group-hover` on the group's rectangle; entered: dim wash between outside and members plus dashed bounds; locked hover: `--group-locked` and the tray-coloured badge |
| `src/ui/quickbar.ts`, `src/ui/icons.ts` | Group and Ungroup buttons and the two icons |
| `test/css-colors.test.ts` | no new allowlist entries: every colour here is a variable (the SVG strings in `render.ts` are outside that test, so add a small test that the group overlay contains no `#` literal) |
| `scripts/visual-check.mjs` | states `group-selected`, `group-hover`, `group-entered`, `group-locked` (and the touch bar at 360 and 390), across the five themes |

## Open points

1. **Name chip at rest on selection** adds a second mark to a selection that otherwise shows only lines. If it feels busy on boards with many groups, show it only when the group has a name, and rely on the solid box alone otherwise.
2. **Dim strength** (62%) is the one value to judge on a real board: on Matrix the outside items almost vanish (which is probably right), on the light themes they stay readable.
## Follow-up (own change, own review, own changelog fragment)

**Move single-item selection to the theme variables.** In `render.ts`, `WIRE` becomes `'var(--wire, #2F6FED)'` for `outline()`, the hover outline, handles, the rotate stem and the connection anchors, and the handle fill `#fff` becomes `var(--group-handle, #fff)`. Single items then follow the theme like groups do; in default nothing changes, and in the dark themes the selection turns from `#2F6FED` to the theme's `--wire` (contrast against the canvas goes up: 9.0 in Ayu, 11.0 in Matrix). Needs the five-theme visual check of `board-selected`, and a glance from Johan, since it is a visible change unrelated to groups.
