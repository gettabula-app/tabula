# Telemetry stack: Grafana, Loki, VictoriaMetrics, collector and data lake

Status: built and tested in the repository, **not deployed anywhere and not running anywhere**. No instance sends anything to it yet. Written 2026-10-12 against `docs/telemetry-design.md` (sections 4a and 8), the decisions of 2026-10-13, and the devops runbook on the branch `devops/telemetry-vps`.

Everything lives in two places: `deploy/telemetry/` (compose file, proxy, Loki and VictoriaMetrics config, Grafana provisioning and dashboards, backup scripts) and `telemetry-collector/` (the Node service and the lake job; no npm dependencies).

## Architecture

```
control plane (or an instance)
   | POST /v1/telemetry   Bearer tt_<id>_<secret>   one hourly report, at most 256 KB
   v
proxy (Caddy, plain HTTP, 127.0.0.1:8481)  ->  collector
   collector: auth (hashed token registry) -> rate limit -> scrub with server/telemetry/scrub.mjs
              (reject the whole report if anything had to be dropped) -> write the lake spool (durable)
              -> VictoriaMetrics (import API)  and  Loki (push API)   [bounded retry queue]
   lake job:  nightly DuckDB compaction of closed days -> Parquet partitions; retention; heartbeat
operators --tunnel--> proxy 127.0.0.1:8480 --> Grafana  --> VictoriaMetrics, Loki   (the lake is queried with DuckDB)
```

Six containers in one compose project (`tabula-telemetry`) on its own bridge network: `victoriametrics`, `loki`, `grafana`, `collector`, `lake` (same image as the collector plus the DuckDB CLI), `proxy`. Only the proxy publishes ports.

### Ports

| What | Where | Notes |
| --- | --- | --- |
| Grafana door | `${GRAFANA_BIND}:8480` on the host, default `127.0.0.1` | operators only, over the tunnel |
| Ingest door | `${INGEST_BIND}:8481` on the host, default `127.0.0.1` | routes `/v1/telemetry` and `/healthz` only; `/metrics` is a 404 |
| VictoriaMetrics 8428, Loki 3100 and 9096, Grafana 3000, collector 8481 | inside the compose network only | never published |

No port is published on `0.0.0.0`. `scripts/preflight.sh` refuses an empty or wildcard bind address and the ports 3000, 9090, 9093, 9100, 5432, 18100 and 19100, and a test reads the compose file to check the same. `scripts/preflight.sh` accepts only loopback, a NetBird address (100.64.0.0/10), or the single private address Johan names in `APPROVED_TUNNEL_ADDRESS` (a WireGuard address in 10/8, 172.16/12, 192.168/16 or fd00::/8); everything else, including public addresses, is refused. The proxy speaks plain HTTP (`auto_https off`), so the tunnel is the encryption; set the bind address only after the tunnel exists.

### Resource limits

VictoriaMetrics 512 MB and 0.5 CPU, Loki 512 MB and 0.5, Grafana 384 MB and 0.5, collector 128 MB and 0.25, proxy 64 MB and 0.25, lake job 1 GB and 0.5 (DuckDB itself is capped at 768 MB and one thread, and runs only while a job runs). The sum of the limits is 2.6 GB and 2.5 CPUs; normal use is a fraction of that. Logs rotate at 3 files of 10 MB per container. Containers drop all capabilities, set `no-new-privileges`, and the collector and lake job have a read-only root file system.

## Data flow and what is stored where

The instance sends one report per hour. Counters in it are per-hour increments, not running totals.

| Store | What | Names |
| --- | --- | --- |
| VictoriaMetrics | one sample per series at the report hour, label `workspace` plus the schema labels | gauges `tabula_<name>`; counters `tabula_<name>_hourly` (read with `sum_over_time`, never `rate`); histograms `tabula_<name>_bucket/_sum/_count`; `tabula_report_info{app_version,mode,platform,node_major}`, `tabula_report_received_timestamp_seconds`, `tabula_connections_now/peak`, `tabula_last_activity_timestamp_seconds` |
| Loki | error entries (fingerprint, code, kind, status, top frame, count), the operating events `upgrade_result` and `error_rate_day`, and one counts-only line per report | labels `job="tabula-telemetry"`, `workspace`, `kind` (`error`, `event`, `report`) |
| Lake spool and Parquet | every metric row, status row (version, mode, platform, connections), error row and product event | streams `reports_hourly`, `errors`, `events`, `status` (`alerts` is reserved for the control plane) |

Workspace ids are the only identifier. The schema has no field that can hold a name, email, message or board text, and the scrubber's rules (unknown keys, strings that look like emails, URLs, IPv4 addresses or tokens) are the same file the instance uses: `server/telemetry/scrub.mjs` is imported, not copied.

**Strict mode.** The scrubber drops what it does not know. The collector goes further and answers 422 with only the drop counts and reason codes when anything was dropped, so a deviating report is stored nowhere. This differs from the design's "drop and reply with a count"; the instance should log a 422 and not retry the same body. Other answers: 401 bad or revoked token, 403 workspace differs from the token or is not on the allowlist, 409 same workspace and hour already accepted (treat as success), 410 the workspace is being or has been deleted (stop sending), 413, 415, 429 with `Retry-After`, 503 if the spool cannot be written (retry).

**Hours.** Reports older than 72 hours or more than one hour in the future are refused. Replay protection is a file per accepted workspace and hour under `state/seen/<workspace>/<hour>`, created exclusively before the spool write (released if the write fails), so it survives restarts and works across collector processes. The lake job prunes claims older than the accepted report age.

**Lake layout** (under `${TELEMETRY_DATA}/lake`):

```
spool/ingest-YYYY-MM-DD.ndjson                       today's rows, append-only, one file per receive day
stream=reports_hourly/dt=2026-10-11/workspace=ws_.../part-2026-10-11-0.parquet   zstd, one fixed column set
_compacted/2026-10-11.done                           marker so a re-run is a no-op
```

The lake job (`lake` container) runs hourly: it compacts each closed day (spool file dated before today UTC) into a staging directory, checks that the Parquet row count equals the spool row count, moves the files into place, writes the marker and deletes the spool file. Then, once a day, it applies retention. It writes a heartbeat that the container health check reads. The monthly merge of small files from the design is **not implemented**; with hundreds of workspaces the file count stays manageable, and the design's switch to `dt`-only partitions past about 500 workspaces still applies.

### Querying the lake

```
docker compose run --rm lake query "SELECT dt, count(*) FROM errors GROUP BY dt ORDER BY dt"
```

`query` defines the views `reports_hourly`, `errors`, `events`, `status` and `alerts` over the Parquet files plus the spool of days not yet compacted. Columns: `stream, dt, workspace, hour, schema, received_at, name, kind, labels, value, count, sum, buckets, status, fingerprint, top_frame, data` (`labels`, `buckets` and `data` are JSON text). Or point any DuckDB at `lake/stream=<name>/dt=*/workspace=*/*.parquet` with `hive_partitioning=true, hive_types_autocast=false`.

## Retention

| Data | Kept | How it is enforced |
| --- | --- | --- |
| VictoriaMetrics series | 13 months | `-retentionPeriod=13` |
| Loki errors and events | 30 days | `retention_period: 720h` with the compactor's `retention_enabled` |
| Lake `reports_hourly` | 396 days (13 months) | lake job removes older `dt=` directories |
| Lake `events` (product events) | 365 days | same |
| Lake `errors` | 30 days | same |
| Lake `status` and `alerts` | 90 days | same |

The decision says "30 days at full resolution, then hourly rollups for 13 months". The instances already send one value per hour, so there is no finer resolution to roll up: every series is hourly from the start and simply lives 13 months. VictoriaMetrics' downsampling is an enterprise feature and is not needed. Say so if Johan expected a separate 30-day tier.

## Deletion by workspace id

```
docker compose run --rm collector delete-workspace --workspace ws_xxxxxxxx
```

Order, so that live ingestion cannot undo an erasure:

1. **Barrier.** A deletion marker `state/deletions/<id>.json` is written first. Every collector checks it (the files are shared by all processes and containers): new reports for that id get 410, the spool write is re-checked just before it happens, and the sink retry queue drops that id's queued items before each attempt.
2. **Wait.** If it created the marker it waits `COLLECTOR_DELETE_WAIT_MS` (default 15 s, longer than the 5 s sink timeout) for requests already in flight to finish.
3. **Purge.** It revokes the workspace's tokens (`--keep-tokens` to skip), removes the id from the allowlist and the replay claims, then deletes from every store and prints one outcome per store:
   - VictoriaMetrics: `POST /api/v1/admin/tsdb/delete_series?match[]={workspace="<id>"}`.
   - Loki: `POST /loki/api/v1/delete` for `{workspace="<id>"}` over the last 800 days; applied by the compactor after `delete_request_cancel_period` (1 hour) plus `retention_delete_delay` (2 hours).
   - Lake: removes every `workspace=<id>` partition directory in all streams and rewrites the spool files without that workspace's rows (under the spool lock).
4. A ledger line (ids, time, outcomes, no content) goes to `state/deletions.log`.

The marker **stays** after the purge, so a later report from a confused instance or a control-plane token cannot bring the data back. `workspace unblock --workspace <id>` removes it. The exit code is 1 and `ok` is false if any store failed; run it again (the marker already exists, so it does not wait again).

**Backups.** Restic snapshots are immutable, so the marker records `backups: "pending"` and `deletion list` shows every deletion whose snapshots may still hold the data; the nightly backup prints a warning while any are pending. To finish the erasure run `backup/erase-snapshots.sh ws_xxxxxxxx` as root, at least 4 hours after the purge (Loki applies deletes late; `deletion ready` checks this). It takes a clean replacement backup, forgets and prunes **every older snapshot** (`restic forget --prune --keep-last 1`), and marks the deletion complete. That is deliberately blunt: the older history is gone, because it is the history that holds the data. If Johan does not want that, the data ages out of the backups within the keep rules (7 daily, 4 weekly, 6 monthly, so up to about 6 months). **For the CGO:** the privacy text should say which of the two applies to a deletion request, and that deleted data can remain in encrypted backups until the erase step is run or the snapshots age out.

## Tokens

Each instance (or the control plane) has a bearer token `tt_<12 hex>_<43 characters>`. The registry file `state/registry.json` (mode 600) stores only the SHA-256 of the secret part. The collector re-reads the file when it changes, so no restart is needed.

```
docker compose run --rm collector token issue --workspace ws_xxxxxxxx --label goated   # prints the token once
docker compose run --rm collector token issue --control-plane --label control-plane      # reports must carry "workspace"
docker compose run --rm collector token revoke --id <id>       # or --workspace <id>
docker compose run --rm collector token list                   # no hashes
```

A workspace token fixes the workspace: a report naming another workspace gets 403. A **control-plane token** (`--control-plane`) may only write workspaces on the allowlist `state/workspaces.json`; an absent or empty allowlist allows nothing. Manage it with `workspace allow|remove|list --workspace <id>` (the control plane's provisioning step should call it when a workspace is created). Limits: before the body is read, 6 posts per hour for a workspace token and a flood guard of four times the fleet ceiling for a control-plane token; after validation, 6 posts per hour per workspace id and a fleet-wide ceiling of 5000 reports per hour (`COLLECTOR_FLEET_RATE_PER_HOUR`); 20 failed authentications per minute per client address; 256 KB body. The limiter tables are capped in memory. Logs are JSON lines with ids, counts and reason codes only; never a body, token, header or address. The collector's own counters are at `/metrics` inside the network and VictoriaMetrics scrapes them (the dashboard "Fleet overview" has a panel).

## Dashboards

Provisioned from `deploy/telemetry/grafana/dashboards` (folder "Tabula", read-only in the UI): Fleet overview, Per-workspace health (workspace picker), Backups and restore, Product usage counts, Errors. They are generated by `deploy/telemetry/scripts/gen-dashboards.mjs`; edit that file, regenerate, and commit both (a test fails when they differ). Queries read one hour at a time (`last_over_time` for gauges, `sum_over_time` for hourly counters, step 1 hour) because samples are hourly. "Hours since the last successful backup" uses MetricsQL `tlast_over_time`, which exists in VictoriaMetrics only. There are no alert rules yet (no `vmalert`); the design's alerts remain to be built once Johan names a destination.

Grafana runs with anonymous access, sign-up, public dashboards, external snapshots, gravatar, update checks and its own analytics all off. The admin user and password come from `.env`.

## Backup to the Storage Box

Restic over SFTP to Johan's existing Hetzner Storage Box, through a sub-account, repository path `restic-telemetry` at the sub-account root (the devops runbook proposes `telemetry`; this document follows the manager's brief). Scripts are in `deploy/telemetry/backup/`; none has been run.

- **Key and password are made on the host.** `init.sh` (interactive, root) generates the ed25519 key `/root/.ssh/telemetry-backup`, prints the public key for the sub-account's `authorized_keys` (port 23, OpenSSH format), creates the restic password file and stops until it is copied to the password manager, then runs `restic init`. Nothing secret is in the repository or passes through an agent.
- **Nightly** (03:15, `tabula-telemetry-backup.timer`): takes a VictoriaMetrics snapshot through the collector container, backs up `state`, `lake`, `grafana`, `loki` and `vm/snapshots` (live VictoriaMetrics directories excluded), deletes the snapshot, then `restic forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6`.
- **Weekly** (Sunday 04:30): `restic check --read-data-subset=5%`.
- **Monthly** (the 1st, 05:00): restore the latest snapshot into a scratch directory, compare with the live data, append the result to `/var/log/tabula-telemetry-restore-tests.log`, delete the scratch directory. Do one by hand after the first backup and record it in the runbook.
- Config is `/etc/tabula-telemetry/backup.env` (see `backup.env.example`). The restic options for Hetzner (`-o sftp.args='-p 23 -i <key> ...'`) follow the runbook and are **unverified** until the first real `restic init`.
- The token registry is in the backup, so the restic password protects live bearer hashes; keep it in the password manager only.

## Interim layout on the Hetzner backup host (`pricefc-backup`)

That host already runs another project's Grafana (3000), Prometheus (9090), Alertmanager (9093), node_exporter (9100) and Postgres (5432) on loopback, plus an ssh forward on 18100 and 19100. This stack does not share any of it:

- its own compose project `tabula-telemetry` and its own bridge network, container names prefixed by the project;
- published ports 8480 and 8481 on loopback only (the devops runbook's native-binary ports 3001, 8428 and 3100 are not used here because the services are not published at all);
- data under `/srv/telemetry/{state,lake,vm,loki,grafana}`, nothing on the root disk, owners set by `scripts/init-data.sh`;
- no data source, dashboard or alert rule is added to the other project's Grafana, Prometheus or Alertmanager.

**Docker is needed.** The runbook records that the host has no container runtime and proposes native binaries under systemd. This compose stack needs Docker Engine (or Podman with compose) installed by Johan as root. Docker edits iptables and bypasses ufw for published ports, which is harmless here only because every published port is bound to loopback or the tunnel address; do not change that.

The data volume, disk alert and the headroom rules of the runbook (root disk alerts, memory caps for the backup puller) still apply and are Johan's decisions.

## Upgrade and rollback

0. Pin digests: `scripts/pin-digests.sh` prints `image: name:tag@sha256:...` for every image (needs network and Docker); copy them into `compose.yaml`. Until then preflight warns that images are pinned by tag only, and tags are not immutable.
1. `git pull` the checkout, then `scripts/preflight.sh` (use `PREFLIGHT_SKIP_LISTEN=1` while the stack runs).
2. Take a backup first (`systemctl start tabula-telemetry-backup.service`) and wait for "backup ok".
3. Change image tags in `compose.yaml` one service at a time (pin the digest of the pulled image beside the tag), then `docker compose pull && docker compose up -d --build`. Collector and lake job are rebuilt from the repository.
4. Check `docker compose ps` (all healthy), the Fleet overview dashboard, and `docker compose logs collector --since 10m`.
5. Rollback: put the previous tags and the previous commit back and `docker compose up -d --build`. Data directories are not touched by an image change. Loki and VictoriaMetrics storage formats can move forward only: before a major upgrade of either, restore-test the backup, and to go back restore the pre-upgrade backup into `${TELEMETRY_DATA}`.

## What Johan must provide before a deployment

1. **Server access with root** on the host (interim `pricefc-backup`, later the dedicated server), and a go for installing Docker Engine there.
2. **Firewall go**: the devops `firewall-apply.sh` plan and the Hetzner Cloud Firewall. The stack itself needs no inbound rule while the doors are on loopback or the tunnel.
3. **Tunnel decision**: NetBird (hosted free plan after the CGO's four conditions) or plain WireGuard; the tunnel address becomes `GRAFANA_BIND` and `INGEST_BIND`.
4. **Key install**: the public key from `backup/init.sh` into the Storage Box sub-account, the sub-account user and host name for `backup.env`, and the restic password stored in the password manager.
5. **Fly egress address**, or another answer to the question below.
6. A Grafana admin user and password chosen on the host, and a destination (webhook or email) for alerts when alert rules are built.

**Open question: how the control plane reaches the ingest door.** The doors are tunnel-only by the brief, but the control plane runs on Fly and cannot join a NetBird or WireGuard tunnel without extra work. The runbook's answer is one public TLS door allow-listed to the Fly static egress address. Options: (a) that public door (the proxy then needs TLS and a firewall rule for the Fly address); (b) a WireGuard peer on the Fly machine; (c) keep ingest on the tunnel and have an operator machine relay for now. Until Johan chooses, ingest works only from machines on the tunnel.

## Deploy checklist

Nothing below has been done.

- [ ] Johan confirms host, root access, Docker install, tunnel choice, and the ingest-door answer.
- [ ] Hetzner volume mounted at `/srv/telemetry`; `sudo deploy/telemetry/scripts/init-data.sh /srv/telemetry`.
- [ ] Checkout at `/opt/tabula-telemetry`; `cp deploy/telemetry/.env.example deploy/telemetry/.env`, fill the Grafana login and bind addresses on the host, `chmod 600`.
- [ ] `deploy/telemetry/scripts/preflight.sh`, then `docker compose config` and `docker compose up -d --build`; all six services healthy.
- [ ] Through the tunnel, log in to Grafana, check the five dashboards load and the datasources test green.
- [ ] Issue a token for one test workspace, post `scripts/synthetic-report.mjs` output, see it in Grafana and with `lake query`, then `delete-workspace` it and revoke the token. (`scripts/smoke.sh` does this on a laptop with Docker; it has not been run.)
- [ ] Backup: `backup/init.sh`, first `backup.sh`, one by-hand `restore-test.sh`, record the result, enable the three timers.
- [ ] Disk alert on the data volume at 80 percent; read the runbook's cap rules for the shared host.
- [ ] Only then issue the control-plane token and let the control plane forward (a separate change in `tabula-cloud`).

## Validation status

Run in the repository: the unit and integration tests (`test/telemetry-stack-*.test.ts`), a real DuckDB 1.4.3 compaction test, `docker compose config` (parses and shows loopback-only publishing), shellcheck on the scripts. **Not run:** the stack itself (the Docker daemon was not running on the build machine), so the container health checks (BusyBox `wget` inside the VictoriaMetrics, Loki, Grafana and Caddy images), Grafana provisioning, Loki's deletion API, VictoriaMetrics' import API against real servers, the DuckDB download in the image build, and restic over the Storage Box are unverified. `scripts/smoke.sh` exists to run exactly that on a machine with Docker.
