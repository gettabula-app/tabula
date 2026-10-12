# MCP tool set v2: review of what exists against TAB-161

Status: review, 2026-10-12. Reads `server/mcp.mjs` (47 tool definitions at origin/main b0230e7), `docs/mcp.md` and the ticket text of TAB-161 (read, propose and act tools). No code changed. Nothing here has been run against a real connector.

## 1. Summary

- The act side of the board is mostly there and well built: all-or-nothing batches, `ref` for connectors created in the same call, caps on items, locked-object failures, fenced untrusted text, per-token call and write limits, OAuth and personal tokens through one actor path. The tracker added 25 more tools (tickets, saved views, projects, milestones) that TAB-161 did not list.
- Of the ticket's list, **10 of 18 items are missing**: board search, `get_session`, `get_changes`, `export`, `propose_changes`, `propose_issues`, `arrange`, `flag`, `run_session` and the `board://` resources. Two promises of the ticket are **not kept**: "each write is one undo step" and "rate limit and daily change cap per token" (the daily cap does not exist). "Client-supplied ids make retries safe" holds for tickets and ticket comments only.
- The biggest risk for v2 is not a missing tool; it is **the size of the tool list** (47 tools in `tools/list`) and **the propose tools**, which need a store and a review screen that do not exist.
- Recommended order, cheapest and safest first: `get_changes`, `export`, board `search`, `arrange`, client ids on `create_objects`, the daily cap, `flag`; then resources; then the proposal store with `propose_changes`; `run_session` last, and only with the facilitator handover rule.

## 2. Coverage matrix

| TAB-161 item | In the build? | Notes |
| --- | --- | --- |
| list_boards | yes | filter by title, limit 100, respects token board restriction |
| get_board (structured, paged by frame) | yes | `frameId`, `types`, `bounds`, `cursor`; private notes of a running session withheld |
| search (across boards or objects) | **no** | only `search_tickets` and the title filter of `list_boards`; no text search over board objects |
| get_session (no hidden notes) | **no** | `get_board` hides private notes but there is no session read (steps, timer, votes) |
| get_changes (from version history) | **no** | versions exist (`GET /api/boards/:id/versions`, `docs/history.md`); no MCP tool reads or diffs them |
| export | **no** | the app exports in the browser; nothing for tools |
| propose_changes, propose_issues | **no** | the in-app AI bar proposes edits to a person (`docs/ai.md`), but there is no stored proposal an MCP token can create and a person approve |
| create_objects (incl. Mermaid) | yes, **without Mermaid** | stickies, shapes, text, frames, connectors; the ticket assumed Mermaid; no diagram input exists |
| update_objects (own objects; others' where allowed) | partly | any object the actor may write, locked ones fail the call; there is no "own objects only" mode; `createdBy` is recorded so it could be offered |
| arrange (grid, clusters, tree, timeline) | **no** | the app has alignment and cluster features client-side; none on the server |
| flag | **no** | no "flag for attention" concept on the server; needs a product decision first |
| apply_template | yes (`use_template`) | adds the template objects; session steps and fonts not applied |
| run_session | **no** | depends on the facilitator handover rule, not decided |
| each write is one undo step | **no, by design** | tool descriptions say edits "cannot be undone with Ctrl+Z" (server writes bypass the client's undo manager). The ticket's promise needs another meaning: see section 4.3 |
| client-supplied ids make retries safe | **only tickets** | `idempotencyKey` on `create_ticket` and `clientId` on `comment_ticket`; `create_objects` and the kanban adds have no retry protection: a retry after a lost answer creates the objects twice |
| rate limit and daily change cap per token | **limit yes, cap no** | 120 calls and 30 mutating per minute, sliding window in memory (reset by a restart); no per-day cap |
| boards as MCP resources (`board://id`) | **no** | the server announces `capabilities: { tools: { listChanged: false } }` only |

Added beyond the ticket: kanban tools, comment tools, ticket, saved-view, project and milestone tools, `whoami`, `get_objects` and `list_templates`.

## 3. Findings about what exists

1. **Tool count.** `tools/list` returns 47 tools with long descriptions. Connectors such as Claude and ChatGPT send all of them to the model on every turn; selection quality and context cost both suffer as the list grows, and some clients cap the number of tools. The kanban label tools (`create_kanban_label`, `update_kanban_label`, `delete_kanban_label`) and lane tools (`add_kanban_lane`, `update_kanban_lane`, `delete_kanban_lane`) could each be one tool with an `action`, and the saved-view and project/milestone families likewise. Before adding the v2 tools, set a budget (for example 40 tools or 12 KB of definitions) and a test that fails above it, and consider scoped tool lists (`tools/list` filtered by the grant's scope already hides write tools for read grants; extend that to hide the tracker group when the tracker is off, which it may already do).
2. **Protocol version.** `SUPPORTED_VERSIONS` stops at `2025-06-18`; the current specification is `2025-11-25`. Negotiation falls back correctly, so nothing breaks, but structured tool output, elicitation and resource links arrive with the later versions. Add it once the response shapes have been checked against it.
3. **Capabilities.** Only `tools`. A client that looks for `resources` or `prompts` finds nothing, which is fine, but TAB-161 wants resources.
4. **Windows are in memory.** The 120 and 30 per minute windows and the 20 failures window reset on restart and are per process; a deliberate restart loop (or a deploy) clears them. The daily cap in section 4.2 needs persistence.
5. **Descriptions repeat a fixed sentence** ("appear for everyone viewing the board at once; the human cannot undo them with Ctrl+Z") in many tools. If the undo promise changes (section 4.3) it must change in one place: move it to `INSTRUCTIONS`, which already says it, and shorten the tool texts.
6. **`update_objects` marks `destructiveHint: true`; `create_objects` and `use_template` mark `destructiveHint: false`.** Consistent. `delete_objects` and the lane/label deletes should be `destructiveHint: true` and `idempotentHint: true`; check them.
7. **Error messages for models.** The OpsError texts are good (field path in the error). The wip_limit and limit_exceeded messages say what the limit is; none of them say what to do next (for example "use get_board with a frameId to find a free lane"). A one-clause hint per error would reduce retry loops.
8. **Responses are capped at 200 KB with `truncated: true`**; a `nextCursor` is returned for the paged tools but not for every tool that can truncate (`fenced(... truncated)` in `list_boards` has no cursor). Add a cursor or say how to narrow.

## 4. Design for the missing items

### 4.1 Read tools (no new risk)

- **`get_changes {boardId, since?, versionId?}`**: from the version snapshots (`history.mjs`). Return the list of versions (id, time, label, author kind) and, for two versions, a compact diff: objects added, removed and changed by id and type with changed field names, **never** the text of changed objects unless the caller can read the board (they can; the text is fenced as everywhere). Cap at the response limit. Needs: a pure diff function over two Yjs states (already exists for the version preview? check `shared/` before writing a new one).
- **`export {boardId, format: 'markdown' | 'json'}`**: text export of a board (frames as headings, stickies as list items). Reuse the app's markdown export if it is in `shared/`; otherwise write the smallest one and share it. JSON is the same as `get_board` with no paging; offer it only up to the response cap.
- **`search {query, boardId?}`**: text search over objects of the boards the actor may read: titles, sticky text, frame names, comments. Needs an index or a scan with a cap; a scan of up to N boards by loading rooms is expensive. Start with one board (`boardId` required) and a case-insensitive scan of the loaded state; cross-board search later through the existing ticket-style FTS if the product wants it.
- **`get_session {boardId}`**: current session (if any): step, timer, votes tally, **not** hidden notes. Only if the product wants agents in sessions.

### 4.2 The daily change cap

Add a persistent counter per token (or per OAuth grant): objects created, changed and deleted per UTC day, stored in the directory database with a small table `mcp_daily_usage(token_id, day, writes)` and cleaned after 8 days. Default cap, for example, 2,000 object writes a day per token, settable by the workspace admin later. Over the cap: `429`-style tool error with the reset time. Count items, not calls (a 100-object batch is 100). This also bounds a prompt-injected agent. Include tracker writes in a separate cap (they already have `TICKET_CREATES_PER_WINDOW`).

### 4.3 What "one undo step" should mean

A human cannot Ctrl+Z a server edit today and cannot be offered that without server-side undo, which Yjs supports only per origin and per live session. Three honest options: (a) **drop the promise** and keep the warning in `INSTRUCTIONS`; (b) **name the write** (each tool call gets a change id returned to the model and recorded in the audit and in version history as "by <token>") and add **`undo_changes {changeId}`** which reverses the objects of one call if they are untouched since; (c) **auto-snapshot** before each mutating call that changes more than N objects, so the owner can restore from the version list. Recommendation: (c) now (cheap, uses the existing history), (b) later for agents that work for a long time. Either way the tool descriptions stop promising an undo.

### 4.4 Client-supplied ids

`create_objects`, `add_kanban_cards`, `create_kanban*` and `use_template` accept an optional `clientRequestId` (8 to 64 characters). The server remembers `(token, tool, clientRequestId)` for 24 hours in the same table as 4.2 with a hash of the arguments; a repeat with the same arguments returns the original result, a repeat with different arguments answers a conflict. This matches what tickets already do (`idempotencyKey`) and makes retries safe after a lost answer.

### 4.5 Propose tools (needs product decisions)

`propose_changes` and `propose_issues` only make sense with a **stored proposal** that a person reviews and applies, which is a feature of its own:
- a table `board_proposals(id, board_id, token_id, created_at, status, payload_hash, summary)` with the payload (the same plan objects `planCreate` and `planUpdate` produce) stored encrypted or as validated JSON, size-capped;
- a review surface in the board UI (the AI bar already renders proposals with accept and reject; reuse it with an author label "proposed by <token>");
- limits: open proposals per token, expiry (7 days), applied by the person with their own rights through the same `applyPlan` path, audit rows for propose, apply and reject.
`propose_issues` should create tracker tickets in a "proposed" state or a draft list once the tracker has a draft concept. Do not build either before the review surface exists; without it, a proposal is just a write with extra steps.

### 4.6 Act tools

- **`arrange {boardId, objectIds | frameId, layout: 'grid' | 'columns' | 'cluster' | 'tree' | 'timeline'}`**: a deterministic layout over existing objects, returning new positions; it must not change text, only `x`, `y` (and `w`, `h` for grid cells), must respect locks, and be all-or-nothing. Reuse the client's alignment helpers if they live in `shared/`; if they do not, move the pure parts there first so the app and MCP cannot drift.
- **`flag`**: define first: a mark on an object that asks a person to look (shows in the UI, listed by a tool). Without that it is a comment. Recommend: skip and use `add_comment` with a convention, until a flag exists in the product.
- **`run_session`**: needs the facilitator handover decision; keep out of v2.

### 4.7 Resources

`resources/list` returning boards as `board://<id>` (title, updatedAt) filtered by the token's board restriction, and `resources/read` returning the same fenced content as `get_board` (first page). Resources are mostly consumed by desktop clients that let the person attach context; they cost nothing for tool-list size. Set `capabilities.resources = { listChanged: false, subscribe: false }`. Resource templates for tickets (`ticket://TAB-12`) are a natural second step.

## 5. Safety rules every new tool must meet

- All text from boards, tickets and comments in a result is fenced and cleaned by the existing helpers; new tools do not return raw strings.
- A new write tool is `mutating: true`, counts against the write window and the daily cap, appears only for a `write` grant, writes an `audit` block, and fails whole.
- A new read tool never returns more than the actor could read in the UI (check the same `authorise` path), including for OAuth grants restricted to boards.
- Descriptions say what the tool does in two sentences and name the limit that most often bites.
- Each tool has a test of: scope gating (hidden for read grants), board restriction (a restricted grant cannot reach another board), oversize input, and the fenced output of hostile text.

## 6. Suggested work packages

| # | Package | Size | Depends on |
| --- | --- | --- | --- |
| 1 | Tool budget test, shorter descriptions, error hints, add `2025-11-25` after checking shapes | small | none |
| 2 | `get_changes` and `export` | small to medium | history module |
| 3 | `search` (one board) | small | none |
| 4 | Daily cap table and `clientRequestId` on create tools | medium | none |
| 5 | Auto-snapshot before large mutating calls (4.3 c) | small | history module |
| 6 | `arrange` | medium | shared layout helpers |
| 7 | Resources | small | none |
| 8 | Proposal store and `propose_changes` | large | product decision, review UI |
| 9 | `run_session`, `flag` | not now | product decisions |

## 7. Questions for the product owner

1. Is the "undo" promise worth building (4.3 b), or is a version snapshot enough (4.3 c)?
2. What should the daily cap be, and should the workspace admin be able to change it per token?
3. Should proposals exist at all in v2, or should agents write directly and the owner rely on versions?
4. Is a "flag" concept wanted, or are comments enough?
5. What is the budget for the number of tools?
