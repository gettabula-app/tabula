section: Changed
audience: dev

- The relay now counts what its sync check would flag without blocking anything: `TABULA_SYNC_VALIDATE` defaults to `report` (it was `off`). Nothing is rejected, reverted or closed; the counts are under `syncValidate` in `GET /api/health` and in one log line a minute. `TABULA_SYNC_VALIDATE=off` turns the check off.
