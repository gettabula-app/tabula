section: Added
audience: dev

- Telemetry back end, not deployed anywhere: a compose stack in `deploy/telemetry/` (Grafana with five provisioned dashboards, Loki, VictoriaMetrics, a Caddy proxy on loopback only, restic backup scripts for a Storage Box) and a dependency-free collector and DuckDB lake job in `telemetry-collector/`.
  The collector reuses `server/telemetry/scrub.mjs`, rejects any report the scrubber would alter, authenticates with hashed per-instance bearer tokens, writes VictoriaMetrics, Loki and a Parquet lake, and deletes a workspace from all of them by id. See `docs/telemetry-stack.md`.
- Collector hardening after review: a persistent deletion barrier and backup-erasure marker, a workspace allowlist for control-plane tokens, per-workspace and fleet rate limits, file-backed replay protection, and a preflight that only accepts loopback, NetBird or an approved private tunnel address.
