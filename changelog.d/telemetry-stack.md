section: Added
audience: dev

- Telemetry back end, not deployed anywhere: a compose stack in `deploy/telemetry/` (Grafana with five provisioned dashboards, Loki, VictoriaMetrics, a Caddy proxy on loopback only, restic backup scripts for a Storage Box) and a dependency-free collector and DuckDB lake job in `telemetry-collector/`.
  The collector reuses `server/telemetry/scrub.mjs`, rejects any report the scrubber would alter, authenticates with hashed per-instance bearer tokens, writes VictoriaMetrics, Loki and a Parquet lake, and deletes a workspace from all of them by id. See `docs/telemetry-stack.md`.
