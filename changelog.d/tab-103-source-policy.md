section: Added

- `TABULA_SOURCE_POLICY=proxy` makes an instance accept connections only from loopback and Fly's proxy range
  (`TABULA_ALLOW_SOURCES` overrides the list), so another app on the same private network cannot reach it directly.
  It is off by default; hosted workspaces turn it on. `GET /api/health` stays open.
