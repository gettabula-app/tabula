# Capacity

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
