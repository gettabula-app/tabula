# Capacity

## Load test for a class

Run `node scripts/load-class.mjs` or `npm run load:class` from the repository. `USERS` counts the teacher and students together; the default steps are 30, 60 and 100 people, with 60 seconds of activity per step. Set `USERS=5,30`, `SECONDS=10`, `CHAT=off`, `RELAY_NODE_ARGS="--max-old-space-size=380"` or `OUT=/path/to/results.json` to change the run. `OUT` defaults to a JSON file under the operating system's temporary directory; the script prints its path.

The harness starts a throwaway accounts-mode relay and one team board per step. The teacher owns each board; the other participants sign in through a team invite and receive editor access from team membership. Each board starts with 150 sticky notes. Participants join over a 10-second burst, then run the activity for the requested duration. The simulated clients use real y-websocket providers, awareness cursors, document edits, and board chat sockets and posts.

For fast remote-mode tests against a local relay only, set `LOAD_CLASS_BURST_MS`, `LOAD_CLASS_SEED_SETTLE_MS`, `LOAD_CLASS_RESULT_SETTLE_MS`, or `LOAD_CLASS_SAMPLE_INTERVAL_MS` to non-negative whole numbers of milliseconds. Defaults are 10000, 250, 100, and 500 respectively. These overrides are ignored when `TARGET_URL` is absent and refused for non-local targets; they are intended for local automated tests, not capacity measurements. `SECONDS` still controls activity duration.

The summary reports relay RSS and CPU, sync-marker latency, time to first sync, generator event-loop lag, sign-in and socket failures, chat 429/5xx responses, relay stderr and relay exit. CPU is shown as a percentage of one local core. A Fly `shared-cpu-1x` gets a fraction of a core with burst capacity, so local CPU percentages are a lower bound on pressure there. A generator lag p95 over 50 ms makes that step's latency untrustworthy; the clients already run in worker threads, so distribute the clients over a second process and rerun.

This is a local relay measurement, not a Fly benchmark: the laptop CPU does not match a Fly shared CPU, the run has no TLS or proxy, and there are no real browsers or rendering costs. Rendering is client-side and is not measured here. The laptop output alone cannot justify a Fly machine size; run the 30, 60 and 100-user cases on a staging machine with the candidate Fly CPU and memory to make that recommendation. A short local smoke run only checks that the harness works.

## Remote run against a throwaway Fly workspace (TAB-227)

This is a runbook for a later, approved run. It has not been run against Fly. The remote mode uses an existing accounts-mode workspace and the supplied sign-in sessions; the script creates one personal board per step, seeds 150 sticky objects through sync, then tries to delete its boards. Its latency includes network round trips. The script does not collect Fly CPU or memory; record those from Fly during every step.

**Who:** DevOps runs the script from a machine with a good connection. The tech lead runs the Fly side.

**Preconditions:** Johan's go; a cost cap (for example, a comp workspace for under two hours, 100 seats, and the machine sizes below); and the image with the current relay. The workspace owner must be able to receive the sign-in email. Confirm the operator source address is in `INTERNAL_ALLOW_OPERATORS` before using the operator proxy; see the [TAB-103 source-policy note](cloud.md#source-policy). The TAB-103 operator allowlist detail is in tabula-cloud and was not available in this checkout.

1. **Create the comp workspace.** In tabula-cloud, use `POST /admin/workspaces/comp` with `{slug:'loadtest-<date>', name, ownerEmail:<an address Johan reads>, region:'eu', seats:100, expiresAt: now+3h, note:'TAB-227 load test, delete after'}`. Reach the operator API through `fly proxy 8801:8801 --app tabula-cloud`. The exact operator authentication and request wrapper are unverified here; follow tabula-cloud `docs/comp-workspaces.md`. Expected: a workspace id and `https://loadtest-<date>.gettabula.app`; record the id for cleanup.

2. **Get the owner session.** Open `https://<slug>.gettabula.app/`, sign in with the emailed link in a browser, then read the session cookie from the browser's developer tools (Application, Cookies; the cookie named `__Host-tabula_session`) and put the `Cookie`-style `name=value` into a local file with `umask 077`. Or copy the token from the emailed link (`token=` value) into `TARGET_LOGIN_TOKENS`; it is single use and expires after 15 minutes. Never paste either secret into chat, a ticket, or a commit. Optionally invite 2 to 4 colleagues by email as members for more distinct accounts; each signs in and sends their own cookie or token the same way. With fewer accounts than simulated users, the script reuses accounts round-robin; this represents one person with many tabs, and per-person limits are not multiplied. Expected: the script accepts each session only after `GET /api/me` returns a user; keep each secret out of output and reports.

3. **Dry run.** This prints the target host, steps, duration, account count, and what the script will create without making a request:

   ```sh
   TARGET_URL=https://<slug>.gettabula.app TARGET_COOKIES="$(cat ~/loadtest.cookie)" USERS=30 TARGET_DRY_RUN=1 node scripts/load-class.mjs
   ```

   Expected result: a remote load plan for the chosen host and one 30-user step, then exit 0. It does not exchange tokens, check sessions, or create a board.

4. **Run the three sizes.** For each size, run 30, 60, and 100 users for 60 seconds per step, in this order: the default workspace machine (`shared-cpu-1x`, 512 MB), `performance-1x` (1 GB), then `performance-2x` (2 GB). For the first size, run:

   ```sh
   TARGET_URL=https://<slug>.gettabula.app TARGET_CONFIRM=<slug>.gettabula.app TARGET_COOKIES="$(cat ~/loadtest.cookie)" USERS=30,60,100 SECONDS=60 OUT=~/loadtest-shared-cpu-1x.json node scripts/load-class.mjs
   ```

   Command template per size:

   ```sh
   TARGET_URL=... TARGET_CONFIRM=<slug>.gettabula.app TARGET_COOKIES=... USERS=30,60,100 SECONDS=60 OUT=~/loadtest-<size>.json node scripts/load-class.mjs
   ```

   Repeat the same command with the matching `OUT` filename for `performance-1x` and `performance-2x`. Each run should print three step verdicts and write the JSON report named by `OUT`; remove the boards automatically, or print their ids if a delete fails. The `TARGET_CONFIRM` value must equal the workspace host printed by the plan. Before each size, check tabula-cloud `docs/comp-workspaces.md` and `docs/spec.md` for the exact admin route and request fields to change `machineSize` and `memoryMb`. Those documents are not in this checkout, so the resize route and fields are unverified. If an existing workspace cannot be resized, create a new comp workspace per size. The expected create call uses `POST /admin/workspaces/comp` with the base fields from step 1 plus `machineSize:'performance-1x', memoryMb:1024`, or `machineSize:'performance-2x', memoryMb:2048`; confirm these fields and values against the comp plan before using them. A workspace created this way should still use the same expiry and cost cap.

5. **Record Fly CPU and memory during each run.** Use `fly status`, the Fly metrics dashboard for the app (CPU %, memory), and `fly ssh console --app tabula-ws-<slug> -C "cat /proc/1/status"` or `top -bn1` (the SSH command and process view are unverified). Write down peak relay RSS and CPU for each user step. A `shared-cpu-1x` can be throttled by CPU steal; recognize it as high latency while CPU in the dashboard remains low.

6. **Pass or fail.** Use the script verdicts: `OK`, `DEGRADED: p95 over 500 ms`, or `FAILING: errors or exit`. Recommend the smallest size where 100 users are `OK`, CPU remains under 70% sustained, and peak RSS stays under 70% of memory.

7. **Clean up.** The script tries to delete every board it created and prints `boards left behind: <ids>` if any delete fails. Delete the comp workspace with `POST /admin/workspaces/<id>/delete` (comp workspaces have no Stripe subscription), then run `fly apps list` and confirm the `tabula-ws-<slug>` app and its volume are gone. Expected: no test boards, workspace app, or volume remain.

8. **Report.** Include a table of size by users with sync p50/p95/max, join p95, errors, peak RSS, and CPU, then state the recommendation. List unverified items: the browser cookie name; how to read Fly metrics; the machine-size change route and fields; and the WAN latency baseline. Before the load run, request `/api/health` a few times and add the measured baseline:

   ```sh
   curl -w '%{time_total}' -o /dev/null -sS https://<slug>.gettabula.app/api/health
   ```

   | Size | Users | Sync p50 / p95 / max | Join p95 | Errors | Peak RSS | CPU |
   | --- | ---: | ---: | ---: | ---: | ---: | ---: |
   |  |  |  |  |  |  |  |

   **Recommendation:**

   **WAN `/api/health` baseline:**

### Local results (2026-10-09, one run, 60 s per step, relay heap capped at 380 MB, a developer laptop)

| People | Relay RSS peak MB | CPU of one core, avg / peak 5 s | Sync p50 / p95 / max ms | Join p95 ms | Errors |
| --- | --- | --- | --- | --- | --- |
| 30 | 126 | 10 / 15 % | 1 / 4 / 61 | 58 | 0 |
| 60 | 155 | 28 / 36 % | 1 / 15 / 449 | 24 | 0 |
| 100 | 262 | 68 / 91 % | 9 / 291 / 1,535 | 30 | 0 |

The generator's own lag stayed under 10 ms p95, so the latencies are the relay's. CPU is what runs out first: the relay is one Node thread, and at 100 people it uses most of a whole fast core while latency p95 climbs from 15 ms to 291 ms. Memory grows with the people on the board (about 1 MB each) and is the second limit. The workload (cursors every 50 ms half of the time, a note every 8-12 s, a move every 4 s, a chat message every 30 s per person) is an estimate of a lively class, not a measurement of one.
