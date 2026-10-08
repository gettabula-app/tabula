# Custom templates (spec, TAB-82)

Status: draft for review. Nothing here is built yet.

People can save part of a board, or the whole board, as a template; find it on the Templates page and the Boards page under **My templates**; start a new board from it or insert it into the current board; and edit, rename, duplicate or delete it. Templates work offline in open mode (stored in the browser) and are shared through the server in accounts mode.

## 1. What a template is

A built-in template (`src/templates.ts`) is code: a `build(b: Builder)` function. A custom template is data: a snapshot of objects and session steps.

```ts
interface CustomTemplate {
  id: string;                 // newId()
  version: 1;                 // format version of `content`
  name: string;               // 1..80 chars
  category: string;           // one of the built-in categories, or free text 1..40 chars
  description: string;        // 0..280 chars
  content: TemplateContent;
  createdBy: string;          // user id (open mode: the local user id)
  createdAt: number;
  updatedAt: number;
  // accounts mode only
  scope?: 'personal' | 'team' | 'workspace';   // see open question Q1
  teamId?: string | null;
}

interface TemplateContent {
  objects: Obj[];             // normalised, see 2
  steps: Step[];              // session steps whose frameId points into `objects`, or none
  bounds: Rect;               // bounding box of `objects`, after normalising (x = y = 0)
  fonts?: { heading: string; body: string };  // board fonts at save time, applied only to a new board
}
```

The objects use the board's own `Obj` shape, so rendering, export and paste need no new code paths.

## 2. Saving: from a selection to `TemplateContent`

1. **Gather.** Reuse `BoardApp.gather(ids)` (the copy/duplicate path). It adds frame children recursively and the connectors whose both ends are in the set. "Whole board" means every top-level object.
2. **Normalise**, in a pure function `toTemplateContent(objs, steps, meta)` in a new `src/custom-templates.ts`, so it's unit-tested without a DOM:
   - Translate so the bounds start at (0, 0). Free connector ends are translated too.
   - Re-key every id to a short local id (`o1`, `o2`, …), rewriting `parent`, connector `from.id` / `to.id` and step `frameId`. A connector end pointing outside the set becomes a free end at the target's centre, exactly as `insertObjects` does today.
   - Drop session and collaboration state: `privateStep`, `locked`, `createdBy`, `updatedAt`, votes, poll answers, timers and comments. Comments are never saved into a template.
   - Keep `z` order but renumber it (fresh fractional keys on insert anyway).
3. **Offline-safe assets.** Icons and stickers already carry their SVG in `body` (sanitised by `sanitizeSvgBody`), and `ref` is only a label, so nothing needs fetching. Fonts are names of Fontshare families the app loads anyway. The board has no raster images today. If images are added later, the format bumps to `version: 2` and inlines them as data URLs with a size cap.
4. **Steps.** Saving the whole board includes the board's session steps. Saving a selection includes only steps whose `frameId` is inside the selection, plus steps without a frame if the user ticks **Include session steps** (default on when the board has steps).
5. **Limits.** At most 2,000 objects and 1 MB of JSON per template. The dialog says so plainly if a selection is too big.

## 3. Using a template

`instantiate(content, origin, userId)` is the inverse of step 2: it maps every local id to `newId()`, offsets by `origin`, sets `createdBy`, and returns `{ objects, steps }`. It's pure and tested, and it shares the remapping helper with `insertObjects` (extract `remapObjects(objs, idMap, offset)` from `app.ts`, used by both).

- **New board from template.** Same flow as built-ins today: `nav.open(newId(), { template })` with `template = 'custom:<id>'`. The board opens, places the content at the grid origin, applies `fonts`, and sets the steps.
- **Insert into this board** (Templates drawer on a board, and a menu item on each card): reuse `insertTemplate` placement (to the right of existing content, snapped to the grid). Insert replaces the board's steps only if the template has steps, with the same confirmation the built-ins use.
- One undo step for the whole insert (`undo.stopCapturing()` + one `transact`), as today.

## 4. Thumbnails

There's no stored image. A thumbnail is rendered on the fly from `content.objects` with the existing `objectMarkup()` into an inline `<svg viewBox="0 0 w h">`, scaled to the card. This is theme-aware for free, since the canvas markup already uses `var(--canvas-ink)` and friends, costs nothing to store, and is always current after an edit. For a template over ~400 objects the card renders a simplified preview (frames and stickies only) to keep the grid fast. Built-in templates get the same treatment by running `build()` into a throwaway `Builder`, so every card has a picture (this also fixes TAB-64's "template card thumbnails" item for free).

## 5. Storage

### Open mode: IndexedDB

A new database `driftboard:templates` (keeps the `driftboard` storage prefix on purpose, see the rename notes), object store `templates`, keyPath `id`, index `updatedAt`. A tiny wrapper `src/template-store.ts` exposes `list()`, `get(id)`, `put(t)`, `remove(id)` and an `onChange` event (BroadcastChannel, so two tabs stay in sync). Templates are per browser, like boards in open mode. Export and import of a template as a `.drift`-style JSON file (`{ format: 'tabula-template', version: 1, template }`) lets people move them between machines.

### Accounts mode: the server

Directory migration N+1:

```sql
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK (scope IN ('personal','team','workspace')),
  team_id TEXT REFERENCES teams(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,          -- JSON TemplateContent, ≤ 1 MB
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX templates_owner ON templates(owner_id);
CREATE INDEX templates_team ON templates(team_id);
```

API, same `compile()` style and CSRF/session rules as the boards routes:

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/templates` | signed in | Metadata only (no `content`): personal ones they own, team ones of teams they're in, workspace ones. |
| GET | `/api/templates/:id` | anyone who can list it | Full template with `content`. |
| POST | `/api/templates` | members and up (not guests) | Body `{ name, category, description, scope, teamId?, content }`. `team` needs team membership; `workspace` see Q2. |
| PATCH | `/api/templates/:id` | owner; team admin for team scope; workspace owner/admin for workspace scope | Any of `name, category, description, content, scope`. |
| POST | `/api/templates/:id/duplicate` | anyone who can read it | Creates a personal copy owned by the caller. |
| DELETE | `/api/templates/:id` | same as PATCH | Soft delete (`deleted_at`), visible in the admin audit log. |

- **Body size:** `MAX_BODY` is 64 KB today; template routes get their own 1 MB limit (a per-route `maxBody` option on `compile`). Content is validated server-side: an array of objects with known `type`s, ids unique, references resolve, and `sanitizeSvgBody` applied again to icon bodies. A template is data the server stores and hands to other people's browsers, so it's treated as untrusted.
- **Audit:** `template.create`, `template.update`, `template.delete`, with name and scope.
- **Offline in accounts mode:** the list and the contents of templates used before are cached in IndexedDB (same store, tagged with the server origin). Saving while offline is disabled with a clear message, the same as creating boards.
- **Read-only workspaces** (hosted, `402 read_only`): saving and editing templates is refused like board writes.

## 6. UI (Swiss style, as approved)

All of this follows `src/ui/admin.css` and the TAB-8 home styles: hairline rows, 11 px uppercase labels, square controls, `--signal` only for the primary action.

- **Save as template.** Shown in three places: the quick-action bar's **More** menu for a selection, the right-click/selection menu, and **Board menu → Save board as template**. It opens a dialog (the shared `dialog()`) with fields Name (prefilled from the frame name or board name), Category (select of the built-in categories plus "Other…" for free text), Description, Include session steps (checkbox, only when relevant), and in accounts mode **Share with**: Only me / a team / Everyone in the workspace (see Q1/Q2). A live thumbnail sits on the right. Buttons: Cancel, **Save template** (primary). A toast confirms with a "View" link to the Templates page.
- **Templates page (`#/templates`).** New first section **My templates** above the built-ins, same card grid (thumbnail on top now), plus a "Shared with me" group in accounts mode. Each custom card has **Use template** (primary) and a `⋯` menu: Insert into a board…, Edit, Rename, Duplicate, Export file, Delete (Delete opens a confirm). Category filter and search cover both groups. An empty state explains how to save one, with a small graphic from TAB-64.
- **Boards page strip.** "Start from a template" shows recently used or created custom templates first (up to 4), then built-ins.
- **Editing a template.** **Edit** opens the template in a scratch board at `#/t/:id/edit`. It's a real board UI with a fixed banner above the chrome: "Editing template **Name**". It has **Cancel** (ghost) and **Save template** (primary), plus a details button for name, category and description. The scratch board is a local, non-synced Y.Doc (no relay room, not listed on Boards); Save runs the same normalise step over the whole scratch board and writes the template; Cancel discards. Leaving with unsaved changes asks first.
- **Built-in templates** stay read-only; see Q3.

## 7. Tests

- `custom-templates.test.ts` (pure): normalise/instantiate round-trip keeps geometry, parents, connector bindings and step frames; external connector ends become free; private and session fields are dropped; ids are fresh on every instantiate; size limits.
- Server: CRUD permissions per scope and role, guests refused, `413` over 1 MB, validation rejects bad references and unsafe SVG, soft delete, audit rows, read-only workspace refusal.
- Template store: list/put/remove and the cross-tab change event (fake IndexedDB as in the existing sync tests).
- CSS: covered by `css-colors.test.ts`; contrast pairs unchanged.

## 8. Build plan (after the spec is approved)

1. `custom-templates.ts` (normalise, instantiate, `remapObjects` extracted from `app.ts`) + tests.
2. `template-store.ts` (IndexedDB) + open-mode Save dialog, Templates page section, use and insert.
3. Thumbnails from `objectMarkup` (custom and built-in).
4. Edit mode (`#/t/:id/edit`), rename, duplicate, delete, export/import.
5. Server table, API, validation, audit + client `api.ts` + accounts-mode UI (Share with).

Steps 1–4 are independent of the server and can ship first. Steps 2–4 build on `feat/home-redesign` (TAB-8), which owns `#/templates`, so this branch merges TAB-8 first.

## Open questions for Johan

- **Q1. Sharing scope.** Personal only at first, or personal + team + workspace from day one? Proposal: all three, with personal as the default.
- **Q2. Workspace templates.** Can any member publish to the whole workspace, or only owners and admins ("admin-published templates")? Proposal: owners and admins only; members share with their teams.
- **Q3. Built-in templates.** Allow "Duplicate to edit" on built-ins, producing a personal custom copy? Proposal: yes; the built-ins themselves stay read-only.
- **Q4. Categories.** Free-text categories, or only the eight built-in ones? Proposal: built-ins plus free text, shown as "Other" in the filter.
- **Q5. Open mode → accounts mode.** When an open-mode user later signs in, offer to upload their browser templates as personal templates? Proposal: yes, one prompt, like "Add to workspace" for boards.
- **Q6. MCP.** Should the MCP endpoint (docs/mcp.md) be able to list and apply templates? Proposal: list and apply, read-only, in a later issue.
