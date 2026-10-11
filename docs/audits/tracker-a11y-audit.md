# Tracker UI Accessibility Audit

- **Task:** CDX-30, revision 1
- **Base:** `0028c5b420525552967b8d905b6338f212d61f79`
- **Viewport:** 390px
- **Scope:** All issues, New issue, ticket page, and Inbox; top ten findings

## Top ten findings

1. **[P1] Tracker shortcuts consume Enter and Space on native buttons.** In [src/tracker/ui/shell.ts:1128] the global handler assigns every non-text target to the tracker shortcut layer; [src/tracker/ui/keys.ts:90] maps Enter and Space to tracker actions. In the rendered All issues list, pressing Enter while focused on “Select TAB-101” opened the ticket instead of activating selection. **Fix:** Skip shortcut handling when focus is on a native control, and handle grid commands only while the grid owns focus.

2. **[P2] Section tabs have no tab-list keyboard pattern.** [src/tracker/ui/shell.ts:332] gives every section button `role="tab"` and `aria-selected`, but all five tabs remain in the normal Tab order and the tab list has no Left/Right arrow navigation. **Fix:** Use roving `tabindex` and move focus between tabs with arrow keys.

3. **[P2] The All issues grid has invalid structure and incomplete selection semantics.** Group headings are direct grid children with `role="rowheader"` ([src/tracker/ui/shell.ts:595]); each selection button is a direct row child ([src/tracker/ui/shell.ts:628-637]); Load more is appended directly to the grid ([src/tracker/ui/shell.ts:642-644]); and the grid does not declare `aria-multiselectable` ([src/tracker/ui/shell.ts:702]). The rendered accessibility tree shows these invalid levels. **Fix:** Put headings and selection controls in valid rows/cells, move Load more outside the grid, and expose multi-selection.

4. **[P2] New issue property buttons announce only their current values.** The State, Assignee, Priority, Labels, and Due date buttons are created without property names ([src/tracker/ui/new-issue.ts:116-126]); the accessibility tree reports names such as “To do” and “No one.” **Fix:** Include the property in each name, such as “State: To do” and “Assignee: No one.”

5. **[P2] The ticket heading hides the actual ticket title from assistive technology.** The `aria-label` on the H1 overrides its visible ticket title ([src/tracker/ui/ticket-page.ts:750]); the rendered accessibility tree announces “Title, press Enter to edit.” **Fix:** Let the H1 text provide its name and leave edit instructions on the separate Edit title button.

6. **[P2] Ticket actions claim menu semantics without menu keyboard behavior.** The actions container has `role="menu"`, but contains ordinary buttons, and the key handler supports Escape without menu arrow navigation ([src/tracker/ui/ticket-page.ts:714-718, 1124-1130]). **Fix:** Use a group with ordinary buttons, or implement menu-item roles and arrow-key navigation.

7. **[P2] Ticket controls fall below 44×44px at 390px.** Browser measurements found More ticket actions at 38×36px, Close ticket at 36×36px, property buttons at 233×34px, and activity filters at 32px high. The mobile minimum-height rule ([src/tracker/ui/ticket-page.css:142]) loses to more specific control rules ([src/tracker/ui/ticket-page.css:15, 27, 82, 86]). **Fix:** Raise the specific mobile control rules to at least 44×44px.

8. **[P2] Ticket and Inbox rerenders lose or steal keyboard focus.** The ticket renderer saves only `data-focus-id` and restores it after replacing the page ([src/tracker/ui/ticket-page.ts:618-623, 1051]); property controls such as State and Assignee have no such ID. Notification preference selection restores focus only for the arrow-key path, not click/Space/Enter ([src/tracker/ui/notification-prefs.ts:45-47, 83-90]). Inbox refresh restores the cursor row even when focus was outside the list ([src/tracker/ui/inbox.ts:169, 222, 395-398]). **Fix:** Preserve focus on the equivalent control only when focus was inside the region being rerendered.

9. **[P2] Ticket signal text and New issue error copy miss 4.5:1 in light themes.** Ticket link and “New comments” text use `--signal` at [src/tracker/ui/ticket-page.css:101, 121], yielding 1.44:1 in Default and 2.01:1 in Evergreen. New issue error/offline copy uses `--danger` on the tray at [src/tracker/ui/tracker.css:288; src/tracker/ui/new-issue.ts:172-181], yielding 3.11:1 in Default and 2.96:1 in Evergreen. **Fix:** Choose text foregrounds that reach 4.5:1 against each actual background; keep signal as a border or underline.

10. **[P2] Pending ticket comment timestamps fail 4.5:1 in all five themes.** Pending comments apply 72% opacity ([src/tracker/ui/ticket-page.css:113]) to timestamps colored with `--graphite` ([src/tracker/ui/tracker.css:45; src/tracker/ui/ticket-page.ts:1067]); contrast is 3.19:1 Default, 3.14:1 Ayu, 3.72:1 Kanagawa, 3.69:1 Matrix, and 3.23:1 Evergreen. **Fix:** Remove row opacity and indicate pending state with a non-text cue.

## Coverage and checks

- Inspected the rendered All issues list, New issue dialog, ticket page, Inbox, and notification settings at 390px with the visual build. The visible All issues and Inbox controls met 44×44px; the ticket controls above did not.
- Checked keyboard focus visibility; shared tracker focus-visible outlines are present, while the reported issues concern activation, tab order, and focus retention.
- Reviewed contrast against the active theme values for Default, Ayu, Kanagawa, Matrix, and Evergreen. The base ink/paper pair passes in all five; the failures above are context-specific.
- Reduced motion passes in the reviewed tracker CSS: transitions and animations are disabled and scrolling is set to `auto` under `prefers-reduced-motion: reduce` ([src/tracker/ui/tracker.css:141-146], [src/tracker/ui/ticket-page.css:148-150]).
- `npm run build:app` passed during visual-build setup; `npm run changelog:check` passed (171 fragments).
- The full `npm run visual` fixture could not start its relay: the available Node 23.6 and Node 22.13 SQLite builds both lack FTS5, required by directory migration 12. I used the successful static visual build for the mock-based browser inspection; the real-server fixture was unavailable. The report is source-only and uncommitted.
