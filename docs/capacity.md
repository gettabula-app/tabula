# Capacity

## Boards-page presence scenario

This is a workload to measure alongside the one-board class run: **N = 100 signed-in Boards-page watchers**, **M = 30 live board rooms**, with a 10-second burst of 10 joins or leaves per second spread across those rooms, followed by one join or leave per second. Each changed room is coalesced for one second and delivered only to its authorized watchers. Measure relay RSS, CPU, event-loop lag, snapshot time and update fan-out; snapshots include at most 200 recent live rooms and eight people per room. This scenario is specified but has not been measured yet.

## Load test for a class

Run `node scripts/load-class.mjs` or `npm run load:class` from the repository. `USERS` counts the teacher and students together; the default steps are 30, 60 and 100 people, with 60 seconds of activity per step. Set `USERS=5,30`, `SECONDS=10`, `CHAT=off`, `RELAY_NODE_ARGS="--max-old-space-size=380"` or `OUT=/path/to/results.json` to change the run. `OUT` defaults to a JSON file under the operating system's temporary directory; the script prints its path.

The harness starts a throwaway accounts-mode relay and one team board per step. The teacher owns each board; the other participants sign in through a team invite and receive editor access from team membership. Each board starts with 150 sticky notes. Participants join over a 10-second burst, then run the activity for the requested duration. The simulated clients use real y-websocket providers, awareness cursors, document edits, and board chat sockets and posts.

For fast remote-mode tests against a local relay only, set `LOAD_CLASS_BURST_MS`, `LOAD_CLASS_SEED_SETTLE_MS`, `LOAD_CLASS_RESULT_SETTLE_MS`, or `LOAD_CLASS_SAMPLE_INTERVAL_MS` to non-negative whole numbers of milliseconds. Defaults are 10000, 250, 100, and 500 respectively. These overrides are ignored when `TARGET_URL` is absent and refused for non-local targets; they are intended for local automated tests, not capacity measurements. `SECONDS` still controls activity duration.

The summary reports relay RSS and CPU, sync-marker latency, time to first sync, generator event-loop lag, sign-in and socket failures, chat 429/5xx responses, relay stderr and relay exit. CPU is shown as a percentage of one local core. A Fly `shared-cpu-1x` gets a fraction of a core with burst capacity, so local CPU percentages are a lower bound on pressure there. A generator lag p95 over 50 ms makes that step's latency untrustworthy; the clients already run in worker threads, so distribute the clients over a second process and rerun.

Before a run, the harness checks the machine's 1-minute load average per core: below 0.5 is quiet, 0.5 through 1.0 is busy (warns and proceeds), and above 1.0 is overloaded (refuses). Set `LOAD_CLASS_ALLOW_BUSY=1` to override the refusal. Other work on a busy machine distorts latency; if the ending load is overloaded, the report marks the run untrustworthy and the latency numbers should not be used.

This is a local relay measurement, not a Fly benchmark: the laptop CPU does not match a Fly shared CPU, the run has no TLS or proxy, and there are no real browsers or rendering costs. Rendering is client-side and is not measured here. The laptop output alone cannot justify a Fly machine size; run the 30, 60 and 100-user cases on a staging machine with the candidate Fly CPU and memory to make that recommendation. A short local smoke run only checks that the harness works.

## Remote run against a throwaway Fly workspace (TAB-227)

Use `npm run fly:load`. The command is a dry run unless `FLY_LOAD_GO` exactly matches the phrase printed for the planned slug. No network requests are made during a dry run.

**Preconditions:** use a machine with a good connection and a healthy local load (the child load harness refuses a busy generator machine). Provide `ADMIN_URL` for tabula-cloud's internal admin listener, `ADMIN_TOKEN` as a bearer token, and `FLY_LOAD_OWNER_EMAIL` for the comp workspace owner. `ADMIN_URL` is an operator-supplied base URL; the script does not invoke `fly proxy`. The owner must be able to receive sign-in mail. `FLY_LOAD_DOMAIN` defaults to `gettabula.app`; set it to the workspace domain configured in tabula-cloud if different. The script defaults to region `eu`, or accepts `FLY_LOAD_REGION=us`.

The planned slug defaults to `tab227-load-YYYYMMDD`; set `FLY_LOAD_SLUG` before the dry run if you want a different name. Use the single go phrase shown by the plan, with no extra characters:

```sh
FLY_LOAD_GO='run the fly load test <slug printed by the plan>' npm run fly:load
```

Run `npm run fly:load` first without that phrase. The dry run prints the workspace name, the full admin call sequence, three load commands, manual checkpoints, report paths, the expected workload duration, and the 180-minute cap. It makes no request. For a real run, provide `ADMIN_URL`, `ADMIN_TOKEN`, `FLY_LOAD_OWNER_EMAIL`, and the exact go phrase through the operator's normal environment/secret source. After the workspace is active, the script pauses for the owner session if neither `TARGET_COOKIES` nor `TARGET_LOGIN_TOKENS` was set in advance. In an interactive terminal, paste the cookie or token at the hidden prompt; it is never echoed or written to reports. The user session must belong to the workspace just created.

The script creates one 100-seat comp workspace with expiry at plan time plus three hours, waits for `active`, then runs `scripts/load-class.mjs` for 30, 60, and 100 users at each size: `shared-cpu-1x` / 512 MB, `performance-1x` / 1 GB, and `performance-2x` / 2 GB. Each user step runs for 60 seconds. For each size, verify the machine size in Fly before continuing; between sizes, change it manually in the Fly dashboard because the tabula-cloud admin docs do not document a resize route. During each user step, record machine CPU and memory from Fly metrics, plus relay process CPU and peak RSS from the machine process view. The script reads the load-class JSON report and asks for those manual values after each size. There is no documented admin machine metrics or exec/status route. If one-time login tokens are used, the first load child exchanges them and stores the resulting cookies in a mode-0600 temporary file for the next two size runs; the orchestrator removes that file in its cleanup.

Expected measured activity is 10.5 minutes across the nine user steps and join bursts, plus provisioning and manual pauses. The machine budget is at most 180 machine-minutes across the size ladder, with comp expiry at three hours. The workspace has one 1 GB volume. The dollar amount depends on Fly's current region and size rates; the docs do not provide a price table. If teardown cannot complete, comp expiry suspends the machine, but the comp workspace and volume can remain until the control plane's 30-day deletion schedule, so use the manual teardown below.

After the run, read the JSON report and the Markdown table printed at their output paths. Recommend the smallest size where the 100-user load-class verdict is `OK`, sustained Fly machine CPU is below 70%, and relay RSS is below 70% of that machine's memory. The report includes sync p50/p95/max, join p95, errors, Fly memory, machine and relay CPU, peak RSS, the recommendation checks, and teardown verification.

The `finally` cleanup posts `POST /admin/workspaces/<id>/delete` and polls `GET /admin/workspaces/<id>` until it returns 404 or `state: deleted`. If the process dies before cleanup completes, repeat the exact admin call with the same bearer header, then verify the detail route:

```http
POST ${ADMIN_URL}/admin/workspaces/<workspace-id>/delete
Authorization: Bearer ${ADMIN_TOKEN}
```

```http
GET ${ADMIN_URL}/admin/workspaces/<workspace-id>
Authorization: Bearer ${ADMIN_TOKEN}
```

**Unverified:** the production workspace domain (set `FLY_LOAD_DOMAIN` to match it); the exact Fly dashboard method for changing machine size and reading sustained CPU; how to inspect relay process RSS because no admin exec/status route is documented; and the exact dollar charge for the region and machine sizes. The script has not been run against Fly.

### Local results (2026-10-09, one run, 60 s per step, relay heap capped at 380 MB, a developer laptop)

| People | Relay RSS peak MB | CPU of one core, avg / peak 5 s | Sync p50 / p95 / max ms | Join p95 ms | Errors |
| --- | --- | --- | --- | --- | --- |
| 30 | 126 | 10 / 15 % | 1 / 4 / 61 | 58 | 0 |
| 60 | 155 | 28 / 36 % | 1 / 15 / 449 | 24 | 0 |
| 100 | 262 | 68 / 91 % | 9 / 291 / 1,535 | 30 | 0 |

The generator's own lag stayed under 10 ms p95, so the latencies are the relay's. CPU is what runs out first: the relay is one Node thread, and at 100 people it uses most of a whole fast core while latency p95 climbs from 15 ms to 291 ms. Memory grows with the people on the board (about 1 MB each) and is the second limit. The workload (cursors every 50 ms half of the time, a note every 8-12 s, a move every 4 s, a chat message every 30 s per person) is an estimate of a lively class, not a measurement of one.

## Local baseline (TAB-227, 2026-10-09 and 10)

What the local load test says about a class on one board, for the education copy. **It is a laptop result, not a Fly result**: the relay ran on one core of an Apple M1 Pro (10 cores, 32 GB) with Node's heap capped at 384 MB to mimic the 512 MB machine (`--max-old-space-size=384`), without TLS or a proxy, with no real browsers (so no rendering cost). A Fly `shared-cpu-1x` has a small share of a core and will be slower; the Fly run in the runbook above is what sizes the machine.

Setup of every run: accounts mode with chat on, one team board of 150 notes, everyone joins in a 10 s burst, then 60 s of activity per person (cursors about 20 times a second while moving, a note every 8 to 12 s, a move every 4 s, a chat message every 30 s). Sync latency is a marker write by one person arriving at the others, measured in the load generator.

| People | Code | Sync p50 / p95 / max (ms) | Relay RSS peak (MB) | CPU of one core, avg / peak 5 s (%) | Generator lag p95 (ms) | Errors | Verdict |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 30 | main e288a33, three runs | 1 / 6 to 18 / 155 to 166 | 115 to 122 | 10 to 11 / 14 to 17 | 3 to 7 | 0 | OK in all three |
| 60 | main e288a33, quiet run | 1 / 8 / 70 | 163 | 28 / 35 | 2 | 0 | OK |
| 60 | older code (9a2cf6a), quiet run | 1 / 8 / 67 | 159 | 27 / 33 | 2 | 0 | OK |
| 100 | main e288a33, quiet run | 8 / 212 / 1,040 | 254 | 71 / 89 | 7 | 0 | OK |
| 100 | older code (9a2cf6a), quiet run | 25 / 458 / 1,302 | 263 | 72 / 93 | 8 | 0 | OK, close to the 500 ms line |

A "quiet run" started with the machine's load average under 8 and the generator's own lag at 2 to 8 ms, so the latencies are the relay's. Other runs were disturbed by other work on the same laptop (load average 20 to 110, generator lag 30 to 350 ms) and are not used: they showed 60 people at p95 1.1 to 3.2 s and 100 people at p95 2.5 to 21 s, which is what an overloaded machine looks like, and the script flags them as untrustworthy. The first run of this test (code from 4 October, quiet) gave 4 ms at 30 people, 15 ms at 60 and 291 ms at 100.

What this supports, and what it does not:

- **A class of 30 on one board** runs with sync under 20 ms at p95, a relay using about a tenth of a core and about 120 MB, no errors. This holds in every run.
- **60 people** is also comfortable (p95 8 ms, a third of a core, 160 MB).
- **100 people** works on a full fast core (p95 0.2 to 0.5 s, 71 % of the core on average and 89 to 93 % at the peaks), but with little headroom: it is the point where the relay's single thread is nearly full. Do not promise 100 on one board without a dedicated CPU.
- The current code is no slower than the code of 4 October (the old and new runs agree within the run-to-run spread; the new run was even lower at 100).
- **Not shown:** anything about `shared-cpu-1x`, real network latency, TLS, browsers' own rendering, or several busy boards at once. Memory grows by about 1 MB per person and stays well under 512 MB at 100.

A claim that can be defended today: "a class of 30 works on one board in our tests; 60 is comfortable; 100 is possible on dedicated hardware". Anything larger or any statement about the cheapest machine waits for the Fly run.

## Sync validation (`TABULA_SYNC_VALIDATE`)

The relay can check the shape of what clients write into a board room or a comments room (`server/sync-validate.mjs`, run by `server/sync-guard.mjs` after the tracker and comments guards). It looks only at the keys one sync message changed, and for an edit of an existing object only at the fields that changed. Set `TABULA_SYNC_VALIDATE` to:

- `off` (the default): the validator does not run.
- `report`: nothing is rejected and no data changes. Violations are counted by code and kind in memory, and one summary line a minute goes to the log (counts and codes only: no board ids, user ids or content; an internal error is logged by its name and code only). A validator error never reaches the sync path.
- `enforce`: a message with a violation is reverted with a Y.UndoManager and the revert goes out in the same broadcast, so every client ends on the state from before the message. A socket with 20 violations within 60 seconds is closed. Text-length caps stay report-only (`ENFORCE_TEXT_CAPS` in `server/sync-validate.mjs`) until the report has run for a release.

Any other value stops the relay at startup. The comments guard runs first and repairs author ids and names as before; a field it repaired is counted as `repaired`, not as a violation.

**Budget per message.** At most 5,000 keys, and for each of two stages (turning the changed Yjs values into plain values, and checking them) 2 MiB of serialized bytes and 50,000 values. The bound applies to the guard's own work, whatever the message holds: once 5,000 keys are recorded the observer reads nothing more from the event, an event with more changed keys than are left is not expanded, and a nested value is copied incrementally with a budget and abandoned the moment it runs out (a Yjs array or a plain array longer than the remaining value budget is refused by its length before one item is read, a Yjs text is refused by its length before `toString()`, and maps and objects are walked with a counter, never with `toArray()` or `Object.keys` on the whole value), so a hostile value is never materialised in full. The copy uses an explicit stack, not recursion, and abandons a value nested deeper than any valid one before descending into it (`too_deep`), so nesting of any depth cannot overflow the call stack; an observer that fails for any reason is caught (report mode ignores it, enforce mode rejects the message). The event walk has budgets of its own besides the key cap (20,000 events and 100,000 changes per message), because many events under one key do not raise the key count; what is left is counted as one number and, in `enforce` mode, rejects the message as `too_many_keys`. A nested object that Yjs decoded with a changed prototype (an own `__proto__` key in the update) is a `forbidden_key` violation: the copy sees own properties only, so it is flagged at the source. A key longer than 256 characters (object ids are 9) is a `key_too_long` violation: it is counted, never stored and never joined into another string. The relay accepts frames of up to 32 MiB (`maxPayload` in `server/relay.mjs`); decoding a frame is Yjs's own cost, and everything the guard does after it is bounded as above. Each value is read once, and a field edit of an existing object reads only the changed fields. What is left over is counted as `skipped` (`skippedBudget` for the byte and value budget). (Yjs's own decoding of the update, its event construction and the undo manager's bookkeeping are linear in the message and outside the guard.) In `enforce` mode a message with skipped keys is reverted with the violation `too_many_keys`, because what was not looked at cannot be let through. A client that writes a very large board has to split it into several messages.

**Check errors.** If the check itself fails (an exception in the validator or while setting it up), `report` mode ignores it and counts `checkErrors` (the summary line carries the last error name and code, never a message). `enforce` mode rejects the message exactly as for a violation, counts `check_error`, and closes the socket after repeated errors; if the check cannot even be set up, the message is not applied.

**Counters** (`mode`, `updates`, `keys`, `skipped`, `skippedBudget`, `tooManyKeys`, `checkErrors`, `violations`, `repaired`, `rejected`, `closed`, `reportOnly`, `byCode`, `byKind`) are under `syncValidate` in `GET /api/health` unless the mode is `off`. `node scripts/sync-validate-report.mjs` runs the validator over the templates, the demo board and one object of every type, to see what the real client writes.

**Cost** (re-measured after the bounded collection; `nice node scripts/sync-validate-bench.mjs --rounds 7`, Node 24.10, 10 cores, measured on a machine with a load average of about 400, so the p99 figures are mostly scheduling noise and `min` is the figure to read). Time to apply one client message to the room, guard off against `report` (`enforce` also tracks the change for the revert):

| Message | off p50 | report p50 | report p99 | overhead p50 / min | enforce overhead (min) |
|---|---|---|---|---|---|
| Typing, one sticky text change (1,000 messages) | 4 us | 8 us | 54 us | +4 us / +4 us | +7 us |
| Bulk edit, 500 objects moved (40 messages) | 0.45 ms | 1.38 ms | 17 ms (noise) | +0.93 ms / +0.80 ms | +0.82 ms |
| Paste, 5,000 new objects in one message (8 rooms) | 115 ms | 127 ms | 305 ms (noise) | +12 ms / +24 ms | +97 ms |
| 20,000-character text edit (200 messages) | 35 us | 42 us | 105 us | +7 us / +8 us | +10 us |

In `report` mode a keystroke costs about 4 microseconds and the largest message stays well under 50 ms over the apply itself, which on this machine is the larger part (about 80 to 140 ms for 5,000 objects). `enforce` roughly doubles the apply of a very large message because the undo manager records every new item.

## Sync limits (`server/sync-caps.mjs`)

Bounds on the `/sync` WebSocket, chosen so real editing never reaches them (drawing, typing, multi-object drags, a large board paste or import). Images are board assets, not document content, so a legitimate update is small. Each number is a named constant; the ones in the last column can be changed with an environment variable (sizes take bytes or a K/M/G suffix; a bad value stops the relay at start with a message naming the variable).

| Limit | Default | Over the limit | Setting |
| --- | --- | --- | --- |
| Frame size, owners (and open mode), board rooms | 128 MiB | socket closed, code 1009 `message_too_big` | `TABULA_SYNC_MAX_FRAME_OWNER` |
| Frame size, editors, board rooms | 96 MiB | same | `TABULA_SYNC_MAX_FRAME_OTHER` |
| Frame size, comments rooms (every role that may write) | 8 MiB (200 threads with a 4,000-character reply each are about 1.7 MB) | same | `TABULA_SYNC_MAX_FRAME_COMMENTS` |
| Frame size, sockets that may not write the room (viewers and commenters on a board, viewers in comments) | 1 MiB | same | `TABULA_SYNC_MAX_FRAME_SMALL` |
| Frame size, a socket being refused (no session, no access, over a limit) | 1 KiB | same | none |
| Document size (encoded state) | 256 MiB, 0 = off | an update bigger than 8 KiB is refused and its socket closed, code 4413 `document_too_large`; smaller frames (deleting, typing) still pass so the board can be cleaned up | `TABULA_SYNC_MAX_DOC_BYTES` |
| SyncStep1 frames per socket | burst 20, 5 per second | frame dropped | none |
| Update frames per socket | burst 500, 200 per second | frame dropped | none |
| Sustained over the frame rate | 10 s without a 1 s break | socket closed, code 4429 `rate_limited` | none |
| Sockets per signed-in person (all rooms, all tabs) | 40 | the new socket is closed, code 4430 `too_many_connections` | `TABULA_SYNC_MAX_SOCKETS_PER_USER` |
| Sockets per client address (guests, and everyone in open mode) | 400 | same | `TABULA_SYNC_MAX_SOCKETS_PER_ADDRESS` |
| `/sync` upgrades per account or guest (accounts mode, cookie known) | 120 per minute | the handshake completes, then the socket is closed with 4429 `rate_limited` (the browser sees a code and backs off) | `TABULA_SYNC_UPGRADES_PER_MINUTE` |
| `/sync` upgrades per client address, only for sockets with no session (and all of open mode) | 600 per minute | same | `TABULA_SYNC_UPGRADES_PER_ADDRESS_PER_MINUTE` |

The client address is the one every other limit uses (`server/client-ip.mjs`, `TABULA_TRUST_PROXY`). Schools share an address, which is why the address numbers are wide. The counters are in memory, bounded (the upgrade maps hold at most 10,000 addresses and fails open for a new one beyond that), and reset on restart. The document size is measured on the encoded state at most once per 1 MiB of accepted updates, and early only when one frame could cross the cap; it is a soft cap, not an exact one: a room can pass it by up to that margin, and a board already over it keeps working for small edits. A client that is closed with 4413 or 4429 reconnects like after any close.

**Measured sizes behind the numbers** (Yjs `encodeStateAsUpdate` of generated boards, one transaction, so also the size of the step 2 frame that sends the whole board): 2,000 stickies with 100-character text, 0.79 MiB; 5,000 objects (the MCP board limit) with 200-character text, 2.4 MiB; 5,000 objects with 4,000-character text each, 20.6 MiB; 500 strokes of 2,000 points, 15.3 MiB; 2,000 objects plus 2,000 strokes of 500 points, 16.5 MiB (the heaviest realistic board). A pen stroke adds a point every 2 screen pixels, so one stroke is about 16 KiB and ordinary editing frames are bytes to kilobytes. An editor reconnecting after offline work sends only what the relay lacks. An import or a history restore is one transaction and so one frame, for an editor too: the editor allowance (96 MiB) is more than 4x the largest measured board (20.6 MiB), the owner allowance 128 MiB. A frame that size is held in memory while it is read, which is why the allowances are not larger. The upgrade limit is charged only after the route is known to be a sync room; a class behind one address is counted per pupil, not per address.

**Close codes the browser understands.** `1009` and `4413` (too large): the app stops syncing this board, keeps the local copy and says "This board is too large to sync" with a Reload button. `4429` (rate limit) and `4430` (too many connections): the app stops, keeps local edits, says so, and reconnects by itself after 30 s, then 60 s, 120 s and so on up to 5 minutes (two minutes of stable connection reset the wait). None of them removes local data.

**Reconnecting without a close code.** A refused handshake, a restarting relay or a proxy drop reaches the browser as close code 1006. The app then waits 2 s doubling to a 60 s ceiling with up to 50% random added, also at the ceiling (so 60 to 90 s there; two stable minutes reset it), per room, instead of y-websocket's own unjittered 8 s maximum, so a class does not return in one wave after a relay restart.

**Receive limits are set before the frame is buffered.** The relay keeps one WebSocket server per limit and hands each upgrade to the one that fits, once the Origin, session, board role and room are known (all before the handshake), so an oversized frame is refused with 1009 while it arrives, not after 128 MiB sit in memory. A foreign Origin gets an HTTP 403 and no socket. A refusal for a missing session or access still completes the handshake, because the browser needs the close code (4401, 4403, 4404) to say why; that socket has a 1 KiB limit. A role that changes after connecting is re-checked at the next frame (and the old receive limit stays for that socket until it reconnects). Open mode has no roles: board rooms get the owner limit and comments rooms the comments limit, so run it only on a trusted network.
