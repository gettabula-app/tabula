# Tracker slice 7: backup and restore readiness

Status: contract draft for review by the tech lead and the manager. No code yet. It is binding once reviewed, as `docs/tracker-s5.md` is for slice 5.

Slice 7 is the part of the Linear cutover that answers one question: if the workspace is lost after Linear is cancelled, can the tickets come back, with no reused key, no duplicate link and no card pointing at the wrong ticket? It builds on `docs/tracker-architecture.md` section 9 (targets and checklist), section 3 (counter and key reuse), the open questions 13, 16 and 21, slice 0 (the coherent snapshot barrier, built) and the directory export target (devops' off-site chain, built). Where this document is more specific than the architecture, this document wins.

## 1. Scope

In scope:
1. Tracker data is part of what a backup **checks** (at backup time and at restore time) and **records** (a small summary in each manifest).
2. A whole-workspace restore leaves tickets, events and linked boards consistent, and keeps tracker writes closed (the restore gate) until the key floor is known.
3. The key floor: a ticket key is never reused after a restore (section 6).
4. A board restored as a copy, and a board restored from history, detach tracker identity (section 7).
5. The restore drill with tickets (section 8).
6. The go/no-go readiness report for the cutover (section 9) and the backup schedule it requires (section 10).

Out of scope, and said so: integrations, webhooks and the GitHub inbox (slice 8: their tables do not exist yet; the drill and the report treat them as "not present" until they do, section 8.3); the off-site transport itself (devops, built: `TABULA_BACKUP_TARGET=dir` plus the pull route in `docs/backups.md`); the control plane's own table (tabula-cloud repo; this document specifies the calls the instance makes, section 6.3); billing; changing the backup format version.

## 2. What exists today (read before changing)

- `server/backup.mjs`: encrypted S3 or directory backups; one manifest per run (`version 1`, `files`, `totals`, `appVersion`, `snapshotBarrier{snapshotSeq,startedAt,endedAt}`); `directory.sqlite` copied with `VACUUM INTO` in `server/backup-copy-worker.mjs` inside the snapshot barrier (`server/snapshot-barrier.mjs`); settle (120 s) and interval (60 min default) runs; deep verify (daily slice, decrypt and hash).
- `server/restore.mjs`: `restoreBoardCopy` (a board of a backup becomes a new board), `restoreWorkspace` (stage, verify, `prepareDatabase`, journalled swap, exit 75). `prepareDatabase` already revokes sessions, join codes, access tokens, invites and OAuth grants, and keeps the live `cloud.*` limits. The staged database checks are `PRAGMA integrity_check`, schema generation and `min_reader` against the build (`schema_too_new`), and "can the app open it".
- Tracker tables in `directory.sqlite` (migrations 12 to 15): `trackers`, `ticket_workflows`, `ticket_states`, `tickets`, `ticket_counters(scope=tracker id, prefix, next_number)`, `ticket_field_versions`, `ticket_labels`, `ticket_comments`, `ticket_events`, `ticket_aliases`, `ticket_subscriptions`, `projects`, `ticket_relations`, `saved_views`, `notifications`, `ticket_search` (FTS5), `kanban_tracker_links`, `kanban_state_mappings`, `ticket_links`, `ticket_projection_outbox`. Migration 16 adds the OAuth tables. All of them travel in the `VACUUM INTO` copy, so a backup already contains tracker data; what is missing is checking it, recording it and restoring it safely.
- `server/tracker/projection.mjs` `reconcileTrackerProjection` strips tracker-owned card fields on a board that has no active link for the card, repairs fields that differ from SQL, and in `sql-wins` mode unlinks cards that no longer exist. It runs on room load (slice 4) and from the guard (slice 5).
- `docs/backups.md` describes a local drill (`npm run drill:local`, `test/drill/*.drill.test.ts`, never in CI) with a checklist and a drill record. Slice 7 extends it.

## 3. Invariants

I1. Every restored workspace opens with the same set of tickets, events, aliases, comments, links and counters that its backup's snapshot held, or it does not open for tracker writes at all.
I2. A ticket key (`prefix-number`) that was ever committed is never issued again, also across a restore (section 6). A gap is acceptable, a reuse is not.
I3. After any restore (workspace, board copy, board history) no card carries tracker identity that SQL does not back, and no ticket is linked to a card it was not linked to in the same snapshot.
I4. A board copy never has an active link row, and never shares a card id with another active link (`ticket_links_active_card` stays unique).
I5. Restore never writes ticket or event text anywhere but the restored database: not into the audit log, the status record, the manifest, the readiness report or logs. Counts, ids and codes only.
I6. The checks and the report are read-only on live data. Only the restore, the key floor and the owner's explicit actions change state.
I7. A finding about tracker data never stops a backup from being written (a damaged copy is better than none); it makes the readiness report red and is audited. A restore refuses only on the one structural condition of 5.1.

## 4. Backup side: validate and record

### 4.1 The tracker check

New module `server/tracker/backup-check.mjs`: `checkTrackerData(db)`, a pure read-only function over an open `DatabaseSync` (the snapshot copy at backup time, the staged copy at restore time). It returns `{ present: boolean, summary, findings }`.

`present` is false when the `tickets` table does not exist (an older database); then the summary is `null`, there are no findings and nothing below applies.

`summary` (all integers, no text):

```
{ schema: <user_version>, trackers: n, tickets: n, archived: n, events: n, maxEventId: n,
  comments: n, aliases: n, links: n (active), kanbanLinks: n (active), outboxPending: n,
  notifications: n, ftsRows: n,
  counters: [{ scope, prefix, next, maxNumber }] }
```

`findings` is a list of `{ code, count }` (never ids of tickets, never text). Codes:

| Code | Meaning | Severity |
| --- | --- | --- |
| `counter_below_max` | a counter's `next_number` is not above the highest `number` of its tickets | error |
| `key_mismatch` | `tickets.key` is not `prefix + '-' + number` | error |
| `orphan_event` | an event with no ticket (cannot happen with the foreign keys on; reported when foreign keys were off) | error |
| `event_missing` | a ticket whose `updated_seq` points at no `ticket_events` row | warn |
| `duplicate_active_link` | two active `ticket_links` for one board and card, or one kanban and ticket | error |
| `link_without_board_link` | an active card link whose kanban has no active `kanban_tracker_links` row | error |
| `link_to_missing_ticket` | active link whose ticket row is missing | error |
| `alias_collision` | an alias equal to a canonical key of another ticket (`TAB-123` imported as an alias of a different ticket) | error |
| `fts_missing` | fewer `ticket_search` rows than non-archived tickets | warn (the index is rebuildable, 5.3) |
| `outbox_stale` | outbox rows pending for more than 24 h before the snapshot time | warn |

The function is cheap (indexed counts and two joins, under 2 s at 100 000 tickets; slice 7's timing test prints the number). It must not read `title`, `description` or comment bodies.

### 4.2 Where it runs at backup time

After the snapshot copy of `directory.sqlite` is complete and the barrier is released (the check is outside the hold limit), the backup run opens the **copy** read-only, runs `checkTrackerData`, and records the result:

- in the manifest as a new optional field `tracker: { checkedAt, summary, findings }` (the same normalisation as `snapshotBarrier` in `server/backup.mjs`; a manifest without the field is read as `tracker: null`, a legacy manifest). The field is inside the sealed manifest. No manifest version change.
- in the backup status (`GET /api/internal/backup-status`) as `tracker: { checkedAt, tickets, events, findings: [{code, count}] } | null`.
- as an audit row `backup.tracker_findings` (counts and codes) only when a run has a finding with severity error or warn that the previous run did not have.

A failing check (an exception, a corrupt FTS table) is recorded as the finding `check_failed` and never fails the run (I7).

### 4.3 The counter floor evidence in the manifest

The summary's `counters` array is the evidence the restore uses in section 6: the manifest of every surviving backup says how far the counter had advanced at its snapshot. This is why section 4.2 records `next` per counter, not only totals.

## 5. Restore side

### 5.1 Staging checks

`restoreWorkspace` and the board-picker preview already open the staged database. Slice 7 adds, after the existing integrity and schema checks and before the swap: run `checkTrackerData` on the staged copy.

- Refuse (`422 tracker_data_invalid`, nothing changed) on exactly one structural condition: `duplicate_active_link` or `link_to_missing_ticket` above 0. The foreign keys and partial unique indexes make both impossible in a database this build wrote, so they mean the file was damaged or hand-edited, and a restore must not guess which link is right. Everything else is repaired in `prepareDatabase` (5.2) and reported in the restore record: `key_mismatch` (the key is recomputed as `prefix-number`), `counter_below_max`, `link_without_board_link` (the link is marked removed), `alias_collision` (the alias row is removed and counted), `orphan_event`, `event_missing`, `outbox_stale`, `fts_missing` (5.3).
- `counter_below_max` is repaired, never refused: the counter is raised to `max(next_number, maxNumber + 1)` and then to the floor (section 6.2).
- Findings and the summary go into the restore record (`restore.status.last.tracker = { summary, findings, repaired }`) and into the audit row `restore.done` (counts and codes only).

### 5.2 `prepareDatabase` additions (inside its one transaction)

1. Raise every `ticket_counters.next_number` to the floor of section 6.2.
2. Delete `ticket_projection_outbox` rows that are applied (cheap) and **reset pending ones** (`attempts = 0`, `next_attempt_at = now`). The outbox is replayed by the reconcile of 5.4; a pending row that targets a card the restored boards no longer have is dropped by the existing remove path.
3. Set the restore gate (section 5.5) `tracker.restore_gate = {since, reason: 'restore', floor: 'pending'|'known'}` in `settings` when the staged database has any ticket row or any counter above its initial value (a database with neither sets no gate, as in 6.2).
4. Drop `notifications.next_email_at` retry state for rows older than the backup's `createdAt` (so a restore does not mail again what was mailed after the snapshot): set `suppressed_at = now` for unmailed rows created before the snapshot, never delete.
5. Restore does not append to ticket history; repairs are recorded in the audit log only, as counts (I5). The only ticket event a restore writes is the `unlinked` event with source `restore` that a reconcile writes for a card that no longer exists (built in slice 5).

### 5.3 FTS

`ticket_search` is rebuilt, not trusted: after the swap, at start, if `fts_missing` or the integrity check of the FTS table fails, run `INSERT INTO ticket_search(ticket_search) VALUES('rebuild')` style repopulation inside the gate (a bounded job, tens of ms per 1000 tickets; the timing test prints it). Search answers `503 tracker_restoring` until it is done.

### 5.4 Reconcile after the swap

At the first start after a workspace restore (`recoverOnStart` has finished, rooms not yet opened), and while the gate is closed:

1. For every board with an active `kanban_tracker_links` row, open the room and run `reconcileTrackerProjection` in `sql-wins` mode. Only that mode unlinks a card that no longer exists on its board (with a `restore` event) and resets `parent` and `rank` to the SQL lane; on a coherent barrier snapshot the layout part is a no-op, and the unlinking covers a room file that was missing from the manifest (8.1 step 9).
2. Drain the projection outbox.
3. Boards are processed one at a time, at most 50 boards per second; the report counts `boardsReconciled`, `cardsStripped`, `cardsRepaired`, `unlinked`.
4. A board that fails to open is counted `boardsFailed` and keeps the gate closed for tracker writes **on that board only** (its linked cards are read-only through the existing `read_only` guard notice). The rest open.

### 5.5 The restore gate

While `tracker.restore_gate` is set:

- tracker mutating routes (`/api/tracker/*` writes, MCP tracker tools that write) answer `503 tracker_restoring` with `{ error, message, floor: 'pending'|'known' }`; reads work. The guard treats linked cards as read-only (`read_only` notice), non-linked boards are unaffected, and the outbound slice 8 deliveries are paused.
- it is cleared automatically when the floor is known (section 6.2), the reconcile of 5.4 has finished, and the FTS is ready. Clearing writes the audit row `tracker.gate_cleared` (counts, how long it was closed).
- the owner can read its state at `GET /api/admin/tracker/readiness` (section 9). Nobody can clear it by hand except through the epoch action of 6.4.
- the gate is a setting, so it survives a second restart; a restore of a backup that was itself taken while a gate was set opens with the gate set again (the setting is not carried: the staged database's own value is overwritten by step 5.2.3 whenever tracker rows exist).

Hosted free time: the target is a gate closed for seconds (the floor call is one HTTP request, the reconcile is bounded). The gate being closed longer than 10 minutes makes the readiness report red and is logged once.

## 6. The key floor

### 6.1 The problem

A restore returns the counter to the snapshot's value. Tickets created after the snapshot are lost, and so is the evidence that their keys were allocated; the keys may already have been used in a pull request title, a chat message or a commit. They must never be issued again (I2).

### 6.2 Algorithm

For each counter `(scope, prefix)` the restore sets

```
next_number = max(restored.next_number,
                  restored.maxNumber + 1,
                  liveBefore.next_number,        // the live database just before the swap (below)
                  manifestMax + 0,               // the highest `next` in the summary of any kept manifest
                  controlPlaneFloor)             // hosted only (6.3)
```

Sources, cheapest first, all optional:
1. **The live database before the swap.** `restoreWorkspace` already takes a safety backup of the live data and keeps it in `.pre-restore-<ms>/`. Its `directory.sqlite` counters are read (read-only, a bounded query) before the swap. This covers the common case (restoring an older point on a healthy server) exactly.
2. **Kept manifests.** Every manifest the bucket still holds carries `tracker.summary.counters` (4.3). The restore reads the manifests' summaries (it already lists and decrypts them), not their objects. A manifest from the future of the restored point (the restore is to an older one) is the evidence for the tail.
3. **The control plane floor (hosted).** 6.3.
4. If none of the above can be reached (an empty volume restored on a new machine, bucket unreadable, no control plane), the floor is `unknown`.

An `unknown` floor keeps the gate closed (5.5) until the owner chooses the epoch action (6.4), except when the restored database has no tickets, in which case the gate is not set.

### 6.3 Control plane calls (hosted)

The control plane keeps `workspace_key_floor(workspace_id, scope, prefix, floor, updated_at)` (tabula-cloud repo; the table is its own change). The instance uses the existing `post()` of `server/cloud.mjs` (same bearer token, 10 s timeout):

- `POST /v1/workspaces/:id/key-floor` body `{ counters: [{ scope, prefix, floor }] }`: the control plane stores `max(stored, floor)` per row and answers `{ ok: true }`. Only ever raises, and a single call may raise a row by at most 1,000,000 (a larger jump is refused with `400`), so a buggy instance cannot burn the number space.
- `POST /v1/workspaces/:id/key-floor/read` body `{}`: answers `{ counters: [{ scope, prefix, floor }] }`. (POST because the instance only ever POSTs to the control plane.)

When the instance reports: after a ticket-creating transaction when `next_number` has advanced by 25 or more since the last report, and once a day, and on shutdown (the final backup run). Reports are debounced like `scheduleUsagePush`, queued in memory and retried with the existing backoff; a failed report never fails a ticket create. The floor is a number per counter, no text, so it is safe to hold in the control plane. Because the report lags by up to 25 keys, the floor alone does not prove non-reuse inside the last 25; sources 1 and 2 cover that, and the restore adds a **safety jump** of 25 to the control-plane source (`controlPlaneFloor = reported + 25`). The jump is a gap, never a collision.

Self-hosted instances have no control plane: `createCloud()` is null, sources 1 and 2 apply, and the instance may set `TABULA_TRACKER_KEY_FLOOR_FILE` (optional, an absolute path outside `DATA_DIR`) which it rewrites with the same report so an operator can keep it on another disk. The restore reads it as source 3.

### 6.4 The epoch action (floor unknown)

`POST /api/admin/tracker/key-epoch` (owner, `{ confirm: 'JUMP' }`): sets every counter to `max(current, maxNumber + 1) + 1000`, writes the audit row `tracker.key_epoch` (per counter: scope, prefix, the old `next` and the new `next`, numbers only, never text, so a later reader can see the gap), clears the floor gate. A jump of 1000 makes reuse possible only if more than 1000 keys were allocated after the last copy; with a 15 minute RPO that is not a realistic number. It keeps the `TAB-n` format.

**Decided (D1, tech lead):** the 1000-key jump, not a new prefix epoch (`docs/tracker-architecture.md` question 21 said `TAB2-1`). One key format keeps aliases, deep links and the importer's `--numbering keep` simple.

## 7. Board copy and board history restore

### 7.1 `restoreBoardCopy`

Today the copy is the board's Yjs document as written, plus the new board row, and tracker fields are removed on the first room load by `reconcileTrackerProjection` (a card with tracker fields and no active link on this board id is stripped). Slice 7 makes this immediate and checked:

- `restoreBoardCopy` strips tracker identity **before** writing the copy's `.yjs` file, with the same field list as the reconcile (`SERVER_CARD_FIELDS` for cards, `ext` and `tracker` on containers, `SERVER_TRACKER_FIELDS` of `server/board-ops.mjs`), so the file on disk and any backup of it never carries a live key for a board that has no link. The projected card **title text is kept as plain card text** (it is the card's first line already); the `ticketKey` goes away, so the card is an ordinary card.
- The copy has no `kanban_tracker_links` and no `ticket_links` rows, ever. A test asserts the counts before and after.
- The result gains `trackerDetached: <number of cards and kanbans stripped>` (an integer). No offer to copy the tickets in this slice (question 13's "Copy linked tickets too" is a later, separate action and must allocate new keys through the normal create path).
- The audit row `restore.done` for the board gets `trackerDetached` as a count.

### 7.2 Board history restore (a named version applied to the live board)

The client applies the old state (`src/history.ts` `planRestore` and `applyRestore`) as ordinary Yjs updates, and `src/ui/history.ts` already wraps the apply in `withTrackerRestoreWindow` (the slice 5 restore window, `sql-wins` mode) when the board has linked kanbans. So the server side exists: tracker-owned fields cannot change, a restored card that no longer matches its ticket is corrected, a card the restore deletes is unlinked with the `restore` event, a restore of more than 100 linked cards is refused whole (`bulk_change`), and the window closing runs one reconcile. A card id the old snapshot has that is not linked now is stripped, never bound to a ticket it was not linked to. Slice 7 adds **tests only**, plus one server rule: the restore-window routes must refuse to open a window while the restore gate (5.5) is closed, with the code `tracker_restoring` (a client treats a window failure as best-effort and proceeds, so it must not present this as a failure of the restore itself). Closing the window is delayed: the restored updates travel over the websocket and the window closes over HTTP, which are not ordered, so `withTrackerRestoreWindow` waits a 1500 ms grace period before the DELETE (tl c5f4d4e; y-websocket has no unsynced-changes signal). The 15 s window expiry is the backstop. Undo of a restore (Ctrl+Z) is the ordinary undo manager after the window has closed, so it runs through the normal guard, not `sql-wins`; that is acceptable: it re-creates deleted linked cards through the existing re-activation by `trackerId` and `extKey`, and lane or text edits are normal guarded edits. One extra relay test: a restore that deletes a linked card, then undo, then the link is active again with no duplicate ticket. Tests: restore of a version from before a link existed, from before a card was created, and from before a lane was mapped, each asserting the final state on a fresh client and in the saved file. Offline restore is already blocked (`historyOffline`).

## 8. The restore drill

### 8.1 Scripted drill (CI-free, `npm run drill:local`)

New `test/drill/tracker.drill.test.ts`, same harness as the existing drill (real relay as `npm start` starts it, in-memory S3, fake control plane; the fake control plane gains the two key-floor calls). Steps, each a checklist box in the printed record:

1. Seed: a tracker with prefix `TAB`, 40 tickets (comments, labels, relations, an imported alias that looks like `TAB-7`, a subscription, a notification), two boards each with a linked kanban (twelve linked cards each), one board with a ticket linked on both.
2. Barrier backup; assert `manifest.tracker.summary` equals the live counts and `findings` is empty.
3. Allocate five more tickets after the backup; stop gracefully with the shutdown run **disabled** for this step so the five exist only in the live database.
4. Whole-workspace restore of the earlier manifest. Assert: exit 75 path, tickets, events, aliases, comments, links, the FTS search for the imported alias and for a title, the counters (the five lost keys are **not** reissued: the next ticket created after the restore gets a key above all five), the gate set then cleared, `boardsReconciled = 2`, no duplicate active link, the cards of both boards are projected from SQL.
5. Hosted variant: wipe the data directory (new machine), restore from the bucket with the control plane floor available (counters respect it) and unavailable (gate stays closed, `key-epoch` clears it with the jump).
6. Board copy: restore one board as a copy; assert no tracker fields in its file, zero new link rows, the original's links untouched, and the first room load changes nothing.
7. History restore on a linked board from before a card existed.
8. Key rotation: a manifest sealed with the previous key restores; a missing old key fails with `unknown_key` and changes nothing.
9. A damaged `ticket_search` table (rebuilt), a room file missing from the manifest (the board opens empty and its links are unlinked by reconcile, the rest restore), a database ahead of the binary (`schema_too_new`).
10. A search of every log, the audit log, the status record and the readiness report for ticket titles and comment text (must find none).

The record carries the measured duration of the restore, the reconcile, the FTS rebuild and the checks, labelled local-only as in the existing drill.

### 8.2 The production drill (devops, with Johan's go)

A checklist document (extend `docs/ops-runbook` if present, else this document's section) that the scripted drill cannot cover: a real bucket, a real Fly machine and volume, a real pull of the directory export, real recovery time against the 4 hours RTO and real data loss against the 15 minutes RPO. It ends with the drill record of 9.3.

### 8.3 Slice 8 hooks

The drill and the checks look for the slice 8 tables by name (`integration_connections`, `webhooks`, `webhook_deliveries`, `integration_inbox`). When present they add boxes: secrets present only as ciphertext (`TABULA_AI_SECRET` key id check, never the value), a pending inbound event and an outbound delivery recovered or safely retried (deliveries carry the event id so receivers deduplicate; restore pauses delivery until the gate clears), connection health re-established. When absent they print "not present (slice 8)", and the cutover go/no-go cannot be green until slice 8 is shipped or the owner records "not used" (9.2).

## 9. The go/no-go readiness report

### 9.1 Route

`GET /api/admin/tracker/readiness` (owner only, like every other backup route: a workspace admin who is not the owner gets 403; read-only, 60 requests a minute, never any ticket text). Hosted and self-hosted. Shape:

```
{ at, overall: 'go' | 'no_go' | 'unknown',
  gate: { closed, since, floor: 'pending'|'known' } | null,
  targets: { rpoMinutes: 15, rtoHours: 4, retentionDays: 30 },
  checks: [{ id, label, state: 'pass'|'fail'|'unknown'|'na', detail?: <short fact string, numbers and codes only>, since? }] }
```

`overall` is `go` only when every check is `pass` or `na` (`na` requires the owner's recorded reason where it is not structural). It is `unknown` when any check is `unknown` and none failed. A `fail` makes it `no_go`.

### 9.2 Checks (each maps to a box of architecture section 9)

| id | pass condition | data source |
| --- | --- | --- |
| `offsite_enabled` | backups configured with a target (`s3`, or `dir` with the pull route enabled and a successful pull in the last 24 h) | backup config, pull log |
| `latest_backup_fresh` | newest manifest age <= RPO (15 min) **or** nothing has changed since it (`dirty` false); age is measured from the manifest's snapshot end | backup status |
| `schedule_meets_rpo` | effective interval <= 15 min and settle enabled (section 10) | backup config |
| `backup_decrypts` | deep verify ran within `TABULA_BACKUP_VERIFY_HOURS` with `deepDamaged = 0`, and every key id in kept manifests is held; after a rotation the previous key is still configured | backup status |
| `tracker_data_clean` | newest manifest `tracker.findings` has no error and no warn | manifest |
| `counters_floor_ok` | hosted: the last floor report succeeded within 24 h and is >= `next_number - 25`; self-host: the floor file (if configured) is current, else `na` with the epoch action documented | control plane report state |
| `links_consistent` | the live `checkTrackerData` has no `duplicate_active_link`, `link_*` finding; outbox pending <= 100 and oldest pending < 24 h | live db (bounded query) |
| `search_ok` | `ticket_search` rows >= non-archived tickets | live db |
| `slice8_secrets` | `na` until slice 8 tables exist; then ciphertext check (`TABULA_AI_SECRET` present) | live db |
| `restore_drill_recent` | a drill record (9.3) newer than 30 days whose `schema` equals the running schema, `overall` pass, RTO and RPO measured within the targets | setting `tracker.drill.last` |
| `retention_30d` | kept daily points cover >= 30 days, or the owner's chosen retention (setting) is recorded | backup status |
| `import_verified` | the Linear import verification record exists (`scripts/linear-verify.mjs` result stored by the owner) and the owner accepted the loss report | setting `tracker.cutover.record` |

Every `fail`/`unknown` detail is a number or a code ("newest backup 41 minutes old, target 15"), never a key or a title.

### 9.3 Drill record

`POST /api/admin/tracker/drill-record` (owner): `{ at (a millisecond number or an ISO string), kind: 'production'|'local', schema, restoreSeconds, dataLossSeconds, boxes: [{id, result}] , overall }`, validated strictly (ids from this closed list, numbers bounded), stored as `tracker.drill.last` (one record; a new one replaces it) with an audit row `tracker.drill_record`. The script of 8.1 prints the JSON the owner pastes; the production drill ends with the same JSON. An attestation, honestly labelled `kind`; `local` records never turn `restore_drill_recent` green for hosted production workspaces (`kind: 'production'` required when `createCloud()` is non-null).

Closed box ids: `seed`, `barrier_backup`, `restore_workspace`, `lost_keys_not_reissued`, `gate_cycle`, `reconcile_boards`, `search_rebuilt`, `hosted_floor_available`, `hosted_floor_unknown`, `board_copy_stripped`, `history_restore`, `key_rotation`, `damaged_search`, `missing_room_file`, `schema_too_new`, `no_text_in_logs`, `slice8_secrets_ciphertext`, `slice8_inbound_recovered`, `slice8_delivery_retry_safe`, `slice8_connection_health`. When slice 8 tables are absent, `slice8_connection_health` uses result `not_present`.

### 9.4 Cutover record

`POST /api/admin/tracker/cutover-record` (owner): `{ importVerifiedAt: 'YYYY-MM-DD', lossReportAccepted: true }` (a calendar date string, not a millisecond timestamp), stored as `tracker.cutover.record`, audited. Both are the owner's explicit acts, not inferred.
Invalid or future dates and any other body return `400 cutover_record_invalid`.

### 9.4a Wire shapes the client reads (frozen with the tech lead's tl/tracker-s7-ui a15ce7d)

- Readiness: exactly 9.1. The client has its own wording for the 12 check ids and falls back to `label` for an unknown id.
- `POST /api/admin/tracker/key-epoch` body `{ confirm: 'JUMP' }`: 200 with any JSON; errors `key_epoch_confirmation_mismatch`, `tracker_restoring`, `rate_limited`.
- `POST /api/admin/tracker/drill-record`: the record as the drill script prints it; the client checks shape only (box id a lowercase token, result a short string); the server owns the closed list of box ids; error `drill_record_invalid`. `overall` is `'pass'` or `'fail'`.
- Audit detail shapes (emit exactly these): `tracker.key_epoch` `{ counters: [{ scope, prefix, oldNext, newNext }] }`; `tracker.gate_cleared` `{ closedSeconds }`; `backup.tracker_findings` `{ findings: [{ code, count }] }`; `tracker.drill_record` `{ kind }`; `restore.done` may carry `{ tracker: { tickets, repaired } }`; `tracker.cutover_record` `{ importVerifiedAt }` (the date string only).

### 9.5 Admin UI

A "Tracker readiness" panel in the Backups tab of the admin dashboard (tech lead, `src/ui/backups.ts` area, sentences through `src/ui/backups-logic.ts`): the overall state as a label that is not colour alone, one row per check with its state and detail, the gate banner, the key-epoch action behind a typed confirmation, and the record forms. The panel text says plainly that the drill and cutover rows are owner attestations the server cannot verify. No new design system pieces; copy to be reviewed by the designer. Not part of the server work.

## 10. The schedule the RPO needs

`server/backup.mjs` defaults today are interval 60 minutes and settle 120 s. A 15 minute RPO is not met by a 60 minute interval during continuous activity (settle only fires after activity stops). Contract:

- When `TABULA_TRACKER` is on and a backup target is configured, the default `TABULA_BACKUP_INTERVAL_MINUTES` becomes **15** (an explicit value still wins; the readiness check `schedule_meets_rpo` reads the effective value). Cost: an unchanged workspace writes no manifest (about ten requests per run, `docs/backups.md`), so the cost is the listing calls; the doc states the number (about 100 requests a day when quiet) and devops confirms it is acceptable on the provider.
- The shutdown run and settle run stay as they are.
- A stopped hosted workspace cannot run an interval; its RPO is the shutdown run (4 s budget) plus the pull route (devops): the readiness check treats a stopped workspace's newest manifest as fresh if it is newer than the last write (`dirty` false at shutdown).

## 11. Limits, errors and audit

New error codes, for `docs/tracker-api.md`: `tracker_restoring` (503, `{floor}`), `tracker_data_invalid` (422, restore only), `key_epoch_confirmation_mismatch` (400), `drill_record_invalid` (400), `rate_limited` (429, the existing shape).

Audit actions (counts, codes and ids only, added to `src/ui/admin-logic.ts` `KNOWN_AUDIT_ACTIONS` and `auditSentence`): `backup.tracker_findings`, `tracker.gate_cleared`, `tracker.key_epoch`, `tracker.drill_record`, `tracker.cutover_record`. `restore.done` gains `tracker` counts.

Bounds: checks read indexed counts only; the staged check and the reconcile are bounded as in 5.4; the readiness route does at most one bounded live query set and caches the answer 30 s; the key floor call is one request, 10 s timeout, never on the ticket-create path.

## 12. Migration

None for the instance. `tracker.restore_gate`, `tracker.drill.last` and `tracker.cutover.record` are rows in `settings`. The manifest field is optional inside the sealed JSON. The control plane gets one table (tabula-cloud, its own change, specified in 6.3). If the implementation finds a migration is needed, stop and report; if one is added it must use the `{ sql, minReader: 11 }` form.

## 13. Tests

Unit (injected clocks, in-memory databases): `checkTrackerData` per finding with a mutation proof for each severity-error code; counter floor arithmetic (all five sources, the unknown case, the safety jump); gate state machine (set, floor known, reconcile done, FTS done, cleared; restart in the middle); manifest normalisation with and without the `tracker` field; the readiness aggregator (go, no_go, unknown, `na`) over a table of check states; drill record validation.
Relay-backed (`test/backup-harness.ts`, `test/restore-harness.ts`): a workspace restore with tickets reaches the gate, clears it and reconciles two boards; the five-lost-keys case never reissues; hosted floor available and unavailable; board copy strips before the file is written and creates no link rows; history restore with the window; a staged database with a duplicate active link is refused, and one with a wrong `key_mismatch` is repaired, as 5.1 says; every route 403s a member who is not owner or admin. Each guard/forgery test proves the change reached an observer before asserting the correction (docs/testing.md).
Drill: the scripted drill of 8.1, run by me and a haiku black-box; the production drill is devops'.
Repeat: `npm run test:repeat -- <files> --times 15 --platform win32` for the gate and floor tests.

## 14. Build order (Codex parts, each one worktree, gates run by the orchestrator)

- **A: check and record.** `server/tracker/backup-check.mjs`, the manifest `tracker` field and status, the audit row, unit tests.
- **B: restore.** staging check, `prepareDatabase` additions, floor sources 1 and 2, the gate, reconcile after the swap, FTS rebuild, `restoreBoardCopy` strip, history-restore window, tests.
- **C: floor and report.** the control plane calls and the optional floor file, `key-epoch`, readiness route, drill and cutover records, the schedule default, docs (`docs/backups.md`, `docs/tracker-api.md`, `docs/cloud.md` for the new calls), changelog fragment.
- **D: drill.** `test/drill/tracker.drill.test.ts` and the fake control plane additions.
- **UI (tech lead):** the readiness panel and the audit sentences.
tabula-cloud (control plane): the `workspace_key_floor` table and the two calls of 6.3, before B reaches hosted data.

## 15. Open points

- **D1:** closed: 1000-key jump (6.4).
- **D2 (manager, devops):** the 15 minute default interval (section 10) and the request cost on the chosen provider; whether a stopped workspace's RPO is acceptable as described.
- **D3 (manager):** who attests the production drill and the cutover record (owner is assumed to be Johan).
- **D5:** closed: one apply path, through the window (7.2); the closing grace is tl c5f4d4e.
- **D4:** the tabula-cloud change (6.3) belongs to another repo and another session; this contract only fixes the calls.
- Not verified: nothing here is built or run. The cost numbers in 10 come from `docs/backups.md`, not from a measurement; the check timings in 4.1 and the reconcile rate in 5.4 are targets the tests must print and confirm.
