# Accessibility audit

TAB-149. Status: audit only. No product code was changed.

This page records what an automated and static audit of Tabula found on 2026-10-09 (main at `1e09821`), ranks the findings, and proposes fixes in slices. It covers keyboard reachability, focus visibility, screen-reader names and live regions, contrast in all five themes, reduced motion, and 200% zoom. Target: WCAG 2.2 level AA.

## Progress

| Slice | State |
|---|---|
| 1. Dialog and popover focus (C2, S1, S2, N3) | Done on `fix/tab-149-s1-focus`. Re-run of the audit on the touched screens: all six dialogs and popovers trap Tab (no Tab-out), return focus to the opener, and are named; axe `aria-dialog-name` and `aria-required-parent` no longer reported. |
| 3. Live regions (S4, M7) | Done on `fix/tab-149-s3-live` (stacked on slice 1). A hidden polite status region (`src/ui/announce.ts`) says: people joining and leaving, sync state changes, delete / add (duplicate, paste) / undo / redo / z-order, new comments and replies from others, timer started / paused / time up, dot count after a pause in clicking, results revealed. Poll "N of M answered" chips are `role=status`. The history load error is `role=alert`. Sign-in and team-name inputs set `aria-invalid` (sign-in also `aria-describedby`). Lock and unlock were already announced by their toast. Not announced: remote edits to objects, and which object is selected (that belongs to slice 7). |
| 2. Radiogroups (S3, N1) | Done on `fix/tab-149-s2-radio` (stacked on slice 3). `rovingRadios()` in `src/ui/focus-scope.ts`: one Tab stop on the checked radio, arrows / Home / End move between radios and choose (not for the dot presets and sticky colours, where a choice closes a popover or writes to the board: there Space or Enter chooses). Used by `swatches()`, `segmented()`, sticky colours, theme choices, dot presets, token options, audit filters and the profile colours. Swatches are named by colour (`colorName()`), the pen tray uses `aria-pressed`, icon / sticker / reaction tiles are plain buttons in a labelled group instead of `role=listitem`. Not changed: the two "Text" and two "Close" duplicate names (N1) still read correctly in context. |
| 5. CSS focus, hidden, motion (S5, M2, M3, M4) | Done on `fix/tab-149-s5-css` (stacked on slice 2). Stickers search has a visible ring; `[hidden]` always hides (a global rule, so `.btn` no longer overrides it); the toast and the timer bar respect reduced motion; rings in the version list, docs results, AI chips and quick-action bar sit inside their scrolling containers instead of being cut off; focus rings on the history preview are ink, not pale yellow. `test/css-a11y.test.ts` fails when a new transition or animation has no reduced-motion rule. |
| 4. Board landmarks and titles (M1) | Done on `fix/tab-149-s4-landmarks` (stacked on slice 5). The canvas surface is the page's `main`; the top-left and top-right trays are labelled regions ("Board", "People and sharing"); the quick-action bar is a labelled region (it was `role=toolbar`, which is not a landmark); a hidden `h1` carries the board name; home's title is "Boards - Tabula". axe now reports nothing on all 9 screens. No skip link yet: the canvas has no tab stops, so there is nothing to skip to; it comes with slice 7. |
| 6. Zoom, touch, preferences (S6, M5, M6, M8) | Done on `fix/tab-149-s6-zoom` (stacked on slice 4). Pinch zoom is blocked on the canvas only (`touch-action: none` moved from the whole board to `.board-surface, .canvas`); the font picker and workspace banner fit a narrow or enlarged window (the banner wraps and the chrome sits below its measured height); forced-colors keeps swatch colours and outlines selected things. Target size (M6) needed no change: the 22px swatches and 20px AI grip are below 24px but their centres are at least 24px from the next target (gap 5px), which WCAG 2.5.8 accepts. Left alone: 11px labels (N6) and the seven-column step list, which still scrolls at 400%. |
| 7. Canvas keyboard (C1) | Spec written: `docs/canvas-keyboard.md` (TAB-149), with open questions for Johan. Nothing built. |

## How it was done

- **Runtime harness**: `scripts/a11y-audit.mjs`, headless Playwright (the pinned 1.64.0, no new dependency). It opens nine screens (home, templates, board, board with a selection, board menu, shapes drawer, comments panel, share dialog, settings dialog) in each of the five themes. Per screen it does a Tab sweep (counts tab stops, detects traps, screenshots with and without focus to see whether a ring appears), lists accessible names, computes contrast, and runs axe. It also opens each dialog and checks focus on open, Escape and focus on close, and probes the canvas, `prefers-reduced-motion`, and 200% and 400% zoom.
- **axe-core** is not in the repo. The harness loads it from a copy outside the repo (`--axe <path>`, with Playwright `bypassCSP` because the app's CSP blocks injected scripts). Without `--axe` the other probes still run. Run: `node scripts/a11y-audit.mjs --axe <axe.min.js> --out audit.json`. axe rule sets: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa and best-practice; only `color-contrast` in the four non-default themes.
- **Contrast** also relies on the existing `test/themes.test.ts` (text pairs 4.5:1, guide colour 3:1, paper on ink, danger on trays), which this audit did not change.
- **Static survey** of `src/**/*.ts` and `src/**/*.css` for what a runtime probe cannot see (handlers, live regions, rules that remove outlines, fixed sizes). Done by reading the source and an AST scan of every `h(...)` call.

### Limits

- axe runs on nine screens, not every state. Dialogs other than share, settings, keyboard shortcuts and save-as-template, the AI bar, history preview, polls, admin, teams and sign-in were checked statically only.
- No real screen reader was used. Names and roles come from the accessibility tree and the source. Announcement order and verbosity are unverified.
- The motion probe sampled running animations on six screens and saw none; the reduced-motion findings below come from reading the CSS.
- The Tab sweep reports "missed" elements on templates and in the board menu. All of them appear in the recorded tab sequence, so this is the probe's element matching, not a defect. The "no focus ring" result for nine toolbar buttons while the board menu is open is also not trusted (see N4).
- Touch and pointer-only gestures were not exercised beyond what the code shows.

## Summary

| Area | Result |
|---|---|
| Accessible names | Pass. Every interactive element built through `h()` has a name; no icon-only control without `aria-label`. A few wrong roles and weak names (S3, S4). |
| Contrast | Pass. 0 failures across 5 themes by 9 screens; axe `color-contrast` clean. Sticky fills against the default text colour are 9.3:1 to 13.9:1. |
| Keyboard, chrome | Mostly pass. Home, templates and board chrome are fully reachable in a sensible order, with no traps. Menus and popovers are the exception (S2). |
| Keyboard, canvas | **Fail.** Objects cannot be selected, focused or operated from the keyboard (C1). |
| Focus management | **Fail.** No dialog traps, restores or inerts (C2). |
| Live regions | Partial. Toasts and errors announce; status that changes in place does not (S5). |
| Reduced motion | Partial. Most motion is covered; two places are not (M2). |
| 200% zoom | Pass with notes. No horizontal overflow on any screen; the rail and menus scroll. At 400% little canvas is left (M5). |

axe reported three rules across all screens: `aria-required-parent` (critical, 1 screen), `aria-dialog-name` (serious, 1 screen), `region` (moderate, every board screen). Nothing else.

## Findings

Severity: **Critical** blocks a task for some users; **Serious** makes it hard; **Moderate** is a barrier with a workaround or a narrow case; **Minor** is polish. WCAG criteria in brackets.

### Critical

**C1. The canvas has no keyboard operation.** [2.1.1 Keyboard, 4.1.2 Name, Role, Value]
`src/render.ts:132` gives the SVG `role="application"` and an `aria-label` ("Whiteboard canvas") but no `tabindex`; none of the six objects on the test board is focusable and focus is on `body` after load. Selection, move-by-drag, resize, rotate, connector drawing, the object context menu (`src/app.ts:446-461`, `contextmenu` handler) and drawing tools are pointer-driven. The only keyboard operations on objects are on a selection that already exists: arrow nudge, Delete, Enter to edit text, copy, paste, duplicate and z-order (`src/app.ts:1150-1209`). There is also no text alternative for what is on the board: object text exists only inside the SVG, and images have alt text only if the author typed one (`src/markup.ts:242`, `src/ui/quickbar.ts:200`). The minimap is a pointer-only `canvas` (`src/ui/board.ts:381-384`).
Effect: a keyboard or screen-reader user can create objects with tool shortcuts but cannot select, review or edit what already exists.

**C2. Modal dialogs do not manage focus.** [2.4.3 Focus Order, 2.1.2 No Keyboard Trap (inverse: nothing keeps focus in), 4.1.2]
`dialog()` (`src/ui/common.ts:93-127`) sets `role="dialog"` and `aria-modal="true"` and moves focus into the box, but: Tab leaves the dialog after 1 to 5 stops (measured on share, board settings, keyboard shortcuts, save-as-template), nothing makes the page behind `inert`, and focus does not return to the opener on close; it lands on `body` in all four dialogs tested. 26 call sites use it (listed in the static survey). If the dialog has no `input`, `textarea` or `button.primary`, focus is not moved at all (`common.ts:125`) and stays behind the backdrop. Escape closes only the topmost dialog and only if no handler calls `stopPropagation`; the backdrop closes on `pointerdown`.

### Serious

**S1. Popovers are unnamed dialogs that do not take focus.** [4.1.2, 2.4.3]
`popover()` (`src/ui/common.ts:6-45`) uses `role="dialog"` with no name (axe `aria-dialog-name`, serious, board menu). It does not move focus in, does not restore it, and is appended at the end of `body`, so Tab from the opener walks the whole toolbar before reaching the first menu item (the recorded sequence for the board menu reaches "Board settings" after "Toggle minimap"). Nine callers: poll, font picker, dots per person, steps, quick properties, home row menu, board menu, object context menu, template "More actions". Openers (for example the board Menu button, `src/ui/board.ts:106`) lack `aria-haspopup` and `aria-expanded`; quick-bar buttons set `aria-haspopup` only (`src/ui/quickbar.ts:115,127`).

**S2. The board menu's theme items have an invalid structure.** [4.1.2]
`src/ui/board.ts` (around line 401) renders the five theme choices as `role="menuitemradio"` inside a container that is not a `menu` or `group` (axe `aria-required-parent`, critical in axe's scale; 5 nodes). Screen readers may ignore them or announce them without context. The rest of the board menu items are plain buttons.

**S3. Radiogroups do not follow the radio pattern.** [2.1.1, 4.1.2]
`swatches()` and `segmented()` (`src/ui/common.ts:129-170`) expose `role="radiogroup"` / `role="radio"` / `aria-checked`, but every radio is a tab stop and Arrow keys do nothing. Keyboard users tab through every swatch; screen-reader users who expect arrows get nothing. The board-colour swatches in the "Your name and colour" dialog are named by raw hex and expose no selected state (`src/ui/board.ts:527-534`). The icon tile is a `button` with `role="listitem"` (`src/ui/library.ts:264-266`), so it is announced as a list item, not a button.

**S4. Status that changes in place is silent.** [4.1.3 Status Messages]
Present and fine: toasts (`role="status"`), alerts for errors, the focus-request stack, access banners, share status. Missing: the sync pill ("Live with 2", "Local only", "No access", `src/ui/board.ts:63-84`), people joining and leaving (`board.ts:104`), comment count and arrivals (`src/ui/comments.ts:117,398`), poll "N of M answered" and the results reveal (`src/ui/polls.ts:16-23,150-170`), votes left (`src/ui/flowbar.ts:262`), the session timer (`role="timer"` is not live; only the one-minute toast announces, `flowbar.ts:136-148`), lock and unlock (`quickbar.ts:86-89`), the version-history load error (`src/ui/history.ts:113-116`, plain `<p>`). Object edits (delete, paste, duplicate, undo, z-order, remote changes) are not announced either.

**S5. No visible focus on the stickers search.** [2.4.7 Focus Visible]
`src/styles.css:125` removes the outline from `.input`; the replacement `.stickers .input:focus` sets `border-bottom-color` to the colour it already has (`src/styles.css:240-241`). No change is visible when the field is focused (`src/ui/stickers.ts:72`).

**S6. Pinch-zoom is blocked on the board.** [1.4.4 Resize Text, 1.4.10 Reflow]
`touch-action: none` on `.board-root` (`src/styles.css:61`) disables browser pinch-zoom for the whole editor page, including the toolbar and panels. The viewport meta itself is fine (no `user-scalable=no`). Browser zoom with the keyboard still works; see M5.

### Moderate

**M1. Board page landmarks and headings.** [1.3.1, 2.4.1, 2.4.6]
The board has `nav` "Tools", `aside`s for comments, history, properties and library, and a labelled application canvas, but no `main`, no `h1`, and no skip link (axe `region`, every board screen: the board-name input, `.people`, and the quick-action bar fall outside any landmark). Home, templates, sign-in and admin are well structured. The board name is an `input`, not a heading. Home's `document.title` is just "Tabula" (`src/ui/home.ts:44,101`).

**M2. Motion with no reduced-motion override.** [2.3.3 Animation from Interactions, advisory]
`src/styles.css` has overrides at lines 75 and 79, `src/ui/ai-bar.css:25,92` and `src/ui/tooltip.css:15`. Not covered: `.timer-fill` (`src/styles.css:347`) and `.toast` (`src/styles.css:464`). The long-press ring (`.lp-ring`) is covered. Remote cursor movement and canvas pan and zoom easing were not probed.

**M3. Hidden attribute overridden.** [4.1.2, 1.3.1]
There is no global `[hidden] { display: none }`. `.btn` sets `display: inline-flex` (`src/styles.css:111`), which beats the UA rule, so `resolveBtn.hidden = ...` in `src/ui/comments.ts:338` probably leaves the Resolve button visible when it should be hidden. Unverified at runtime. Other `hidden` users have explicit overrides (`offline-row`, `workspace-banner`, `poll-card`, `docs-results`, the AI dock).

**M4. Focus rings that are clipped or low-contrast.** [2.4.7, 2.4.11 Focus Not Obscured, 1.4.11 Non-text Contrast]
The default ring is 2px signal yellow with 2px offset (`src/styles.css:51`). It is adequate on the dark trays but weak on light surfaces: the history preview buttons (`src/ui/history.css:77-98`) use it on `--canvas`. Rings are clipped by overflow containers in `.history-body` (`history.css:45`), `#docs-results` (`docs.css:37`), `.aibar-chips` (`ai-bar.css:28`), `.quickbar` (`styles.css:507`) and `.tokens-boards` (`tokens.css:40`). Containers that take programmatic focus (`.history-panel`, `.history-preview`, `.aibar-pop`) have no outline, which is acceptable only because they are never a tab stop. Several inputs replace the ring with a border colour change of 1px (`.num-field`, `.admin .input`, `.modal .input`); that is visible but below 3:1 against the surrounding border in some themes (not measured).

**M5. Zoom and reflow.** [1.4.4, 1.4.10]
At 200% (640 by 360 CSS px) no screen has horizontal overflow. The rail and the board menu extend beyond the viewport and scroll inside their own container; nothing is unreachable. At 400% (320 CSS px wide) the rail, top bar and a panel leave a few hundred pixels for the canvas. Specific hazards: `.font-picker` is a fixed 340px (`styles.css:400`), `.workspace-banner` is a fixed 28px bar that truncates (`src/ui/workspace.css:10-11`), `.top-left` and `.flowbar` reserve 380px and 456px (`styles.css:137,322`), and the step list has seven fixed columns with no breakpoint (`styles.css:375`). Minimum text is 11px in many labels and on three controls (set tabs, history tabs and links), and `.swatch` is 22 by 22px.

**M6. Target size.** [2.5.8 Target Size (Minimum), 24px]
Meets 24px in nearly all places. Close calls: `.swatch` 22 by 22px (`styles.css:293`) and `.aibar-grip` 20px wide (`ai-bar.css:41`) are below 24px. Default icon buttons are 36px; board-row actions are 44px on coarse pointers.

**M7. Missing error association on forms.** [3.3.1 Error Identification, 1.3.1]
Errors are shown with `role="alert"` (announced), but no input has `aria-invalid` or `aria-describedby` pointing at the message (sign-in email `src/ui/signin.ts:35-43`, team name `src/ui/teams.ts:19-25` which uses a toast). The number field is a `spinbutton` with `aria-valuenow` but its min and max were not verified (`src/ui/controls.ts:37`).

**M8. Forced colours and contrast preferences.** [1.4.11, advisory]
No `forced-colors` or `prefers-contrast` rules. Selection states drawn with `box-shadow` (the signal bars on `.menu-item[aria-checked]`, `.font-row.on`, `.swatch.on`) vanish in Windows high-contrast mode. State often relies on fill colour alone (`.icon-btn.on`, `.segmented button.on`, `.chip.on`, `.tile.on`); most expose `aria-pressed` or `aria-checked`, so the information is present for assistive tech, and many have a shape change; a handful do not (the session timer warning, `.votes-left.none`, sync pill state).

### Minor

- **N1.** Duplicate names on one screen: two buttons named "Text" when a note is selected (rail and quick bar) and two "Close" in board settings (header X and footer). Fine for sighted users; confusing in a rotor list.
- **N2.** The comment card and AI bar popover use `role="dialog"` for non-modal surfaces (`src/ui/comments.ts:155`, `src/ui/ai-bar.ts:836`). They are named; keep, but they need focus handling like S1.
- **N3.** The dialog name is `aria-label` copied from the title, not `aria-labelledby` the `h2` (`common.ts:96-97`).
- **N4.** While the board menu is open, the probe saw no focus ring on nine background toolbar buttons. The menu is a popover that does not move focus, so this is probably an artefact of the screenshot comparison (the popover overlay changes the clip). Re-check once S1 is fixed.
- **N5.** Several controls are named only after first render (`lock`, AI model button, zoom label). Harmless in practice.
- **N6.** `.stickers`, `.icon-tile` and set tabs use 11px text; `.comment-count` is 10px and `aria-hidden`. Prefer 12px minimum.
- **N7.** `Dialog` backdrop closes on `pointerdown`, which also fires at the end of a text selection drag that leaves the box. Not an accessibility barrier by itself.

## What passes

- Names: all native controls have names; icon buttons use `aria-label` and tooltips are a visual extra (`data-tip`) rather than the only name. No `img` without `alt`; icons are `aria-hidden`.
- Keyboard order on home, templates and the board chrome is logical and has no trap: tool rail in visual order, then undo and redo, zoom controls, minimap, then the selection bar. Tool shortcuts are listed in the keyboard shortcuts dialog, which is reachable.
- Visible focus on all toolbar, rail, menu and dialog buttons in all five themes (global ring, plus the tray override on dark surfaces).
- Contrast: all five themes pass the unit tests and axe. Sticky note fills against the default text colour are 9.3:1 to 13.9:1.
- `lang="en"`, per-view `document.title` (except home), viewport zoom allowed.
- Combobox and listbox (`src/ui/controls.ts:255-283`, `src/ui/fontpicker.ts`), number field, AI chips (roving tabindex) and history rows all handle arrow keys properly.
- Reduced motion: five existing overrides cover the long-press ring, AI bar transitions, tooltip transitions and the main transitions in `styles.css`.

## Fix plan

Slices are ordered so each one can ship and be verified on its own. A slice is sized for one worker and one review.

**Slice 1: dialog and popover focus (C2, S1, S2, N3).** The biggest gain for the smallest change, all in `src/ui/common.ts` and `src/ui/board.ts`.
- `dialog()`: remember `document.activeElement`, restore it on close; make the rest of the page `inert` while open (or trap Tab); fall back to focusing the close button when there is no first field; use `aria-labelledby`.
- `popover()`: name it (`aria-label` from the caller, default the opener's name); move focus to the first item and restore on close; render it next to its opener in DOM order, or trap Tab; set `aria-haspopup` and `aria-expanded` on openers in one helper.
- Theme items: wrap in `role="group"` with a name, or make the menu a real `role="menu"` like `context-menu.ts`.
- Verify: re-run `scripts/a11y-audit.mjs` (dialog table, axe); add a vitest for `dialog()` focus return in the existing DOM test setup.

**Slice 2: radiogroups and swatches (S3, N1).** Roving tabindex and arrow keys in `swatches()` and `segmented()`; name board-colour swatches with colour names and expose the selected state; fix the `listitem` role on icon tiles; make duplicate names distinct ("Close dialog", "Text colour and alignment").

**Slice 3: live regions (S4, M7).**
- One visually hidden `role="status"` announcer in `common.ts` with an `announce(text)` function, used for: sync state changes (debounced), people joining and leaving, new comments, poll answered counts and reveal, votes left, lock and unlock, undo and redo, delete, duplicate and paste.
- `role="alert"` on the history load error; `aria-invalid` and `aria-describedby` on sign-in and team-name inputs.
- Do not announce the session timer every second; announce at start, one minute and end.

**Slice 4: board landmarks and titles (M1).** `main` around the canvas (or on the board root), a visually hidden `h1` with the board name, a skip link to the canvas and tools, a title for home, and landmarks for `.people` and the quick-action bar.

**Slice 5: focus and CSS fixes (S5, M2, M3, M4, N6).**
- A real focus indicator on the stickers search.
- Global `[hidden] { display: none !important }` (check comments Resolve and the empty-state hint).
- Padding on `.history-body`, `#docs-results`, `.aibar-chips`, `.quickbar` and `.tokens-boards` so rings are not clipped; a dark ring on light surfaces (`.history-preview`).
- `prefers-reduced-motion` for `.timer-fill` and `.toast`.
- Add a Playwright check to `npm run visual` or the audit script that fails on a missing ring.

**Slice 6: zoom, touch and preferences (S6, M5, M6, M8).** Allow pinch-zoom outside the canvas (`touch-action: none` on `.canvas` only, `pan-x pan-y pinch-zoom` elsewhere); clamp fixed widths with `min()`; let the workspace banner wrap; `forced-colors` rules that use outlines instead of shadows; 24px minimum targets for swatches and the AI grip; 12px minimum text.

**Slice 7: keyboard canvas, design needed (C1).** This needs a spec before code, because it changes how the board works for everyone. Outline for the spec:
- Make the canvas a tab stop. Provide a roving "object cursor": Tab or `]` / `[` moves between objects in z-order or reading order, arrows with a modifier move to the nearest object in that direction, Enter selects, Esc returns to the canvas.
- Announce the focused object (type, text, colour, position in the list) with the Slice 3 announcer; expose the selected object's text through `aria-label` on a focus proxy element that follows selection.
- Resize and rotate with keys (for example `Alt+arrows` and `R`), a keyboard path to the object context menu (`Shift+F10` or the Menu key), and to start a connector between two objects.
- Provide a list view of all objects (an alternative to the canvas) for screen readers: sortable by type, with edit actions. This also gives images and shapes a text alternative.
- The minimap gets either a keyboard equivalent (`Fit board`, `Zoom to selection` shortcuts) or `aria-hidden` with those equivalents documented.

Suggested order: 1, 3, 2, 5, 4, 6, then spec 7. Slices 1 to 6 are small and independent of each other; 7 is the largest piece of work and should be scoped with Johan.

## Re-running the audit

```
npm run build:app && node scripts/a11y-audit.mjs --axe /path/to/axe.min.js --out audit.json
```

Needs a built app; the script starts and stops its own throwaway relay. `--only names,keyboard,contrast,dialogs,motion,zoom,axe` selects probes. Without `--axe`, the keyboard, names, contrast, dialog, canvas, motion and zoom probes still run. The JSON has one section per probe; compare `dialogs`, `canvas` and axe `violations` before and after each slice.
