# Capacity

## Load test for a class

Run `node scripts/load-class.mjs` or `npm run load:class` from the repository. `USERS` counts the teacher and students together; the default steps are 30, 60 and 100 people, with 60 seconds of activity per step. Set `USERS=5,30`, `SECONDS=10`, `CHAT=off`, `RELAY_NODE_ARGS="--max-old-space-size=380"` or `OUT=/path/to/results.json` to change the run. `OUT` defaults to a JSON file under the operating system's temporary directory; the script prints its path.

The harness starts a throwaway accounts-mode relay and one team board per step. The teacher owns each board; the other participants sign in through a team invite and receive editor access from team membership. Each board starts with 150 sticky notes. Participants join over a 10-second burst, then run the activity for the requested duration. The simulated clients use real y-websocket providers, awareness cursors, document edits, and board chat sockets and posts.

The summary reports relay RSS and CPU, sync-marker latency, time to first sync, generator event-loop lag, sign-in and socket failures, chat 429/5xx responses, relay stderr and relay exit. CPU is shown as a percentage of one local core. A Fly `shared-cpu-1x` gets a fraction of a core with burst capacity, so local CPU percentages are a lower bound on pressure there. A generator lag p95 over 50 ms makes that step's latency untrustworthy; the clients already run in worker threads, so distribute the clients over a second process and rerun.

This is a local relay measurement, not a Fly benchmark: the laptop CPU does not match a Fly shared CPU, the run has no TLS or proxy, and there are no real browsers or rendering costs. Rendering is client-side and is not measured here. The laptop output alone cannot justify a Fly machine size; run the 30, 60 and 100-user cases on a staging machine with the candidate Fly CPU and memory to make that recommendation. A short local smoke run only checks that the harness works.

### Local results (2026-10-09, one run, 60 s per step, relay heap capped at 380 MB, a developer laptop)

| People | Relay RSS peak MB | CPU of one core, avg / peak 5 s | Sync p50 / p95 / max ms | Join p95 ms | Errors |
| --- | --- | --- | --- | --- | --- |
| 30 | 126 | 10 / 15 % | 1 / 4 / 61 | 58 | 0 |
| 60 | 155 | 28 / 36 % | 1 / 15 / 449 | 24 | 0 |
| 100 | 262 | 68 / 91 % | 9 / 291 / 1,535 | 30 | 0 |

The generator's own lag stayed under 10 ms p95, so the latencies are the relay's. CPU is what runs out first: the relay is one Node thread, and at 100 people it uses most of a whole fast core while latency p95 climbs from 15 ms to 291 ms. Memory grows with the people on the board (about 1 MB each) and is the second limit. The workload (cursors every 50 ms half of the time, a note every 8-12 s, a move every 4 s, a chat message every 30 s per person) is an estimate of a lively class, not a measurement of one.
