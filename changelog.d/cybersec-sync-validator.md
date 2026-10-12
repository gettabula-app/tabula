section: Added
audience: dev

- Add a server-side check of what clients write into board and comment rooms (`server/sync-validate.mjs`, `server/sync-guard.mjs`), set with `TABULA_SYNC_VALIDATE=off|report|enforce`.
  It is off by default. `report` only counts violations by code and kind and logs a summary once a minute; `enforce` reverts a message with a violation and closes a socket after 20 in a minute.
  Each message has a budget of 5,000 keys, 2 MiB and 50,000 values; in `enforce` mode a message that goes over it is reverted.
  The guard's own work per message is bounded (collection and conversion stop at the budget; arrays, texts and keys are measured before they are read, and a key over 256 characters is a violation); in `enforce` mode a check that fails to run rejects the message.
  Counters are under `syncValidate` in `/api/health`.
- Add `scripts/sync-validate-report.mjs` (violation counts per fixture) and `scripts/sync-validate-bench.mjs` (cost per message).
