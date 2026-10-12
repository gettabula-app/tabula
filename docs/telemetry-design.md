# Telemetry design

Status: design proposal. The instance-side phase builds a local scrubbed preview and Privacy controls only; it has no outbound telemetry call or error collector. Written 2026-10-11 against `main`. Decided by Johan: product analytics uses counts, durations, feature use, and coarse device, browser, and OS classes; never content or raw User-Agent/browser strings. Hosted owners can turn product analytics off while operating data stays on; self-hosted telemetry is off by default and opt-in.

## 0. Summary

- **One pipe.** Each instance aggregates locally once an hour into a small JSON document (about 50 KB at most, usually far less) and posts it to the control plane over the channel it already uses (`server/cloud.mjs`, control token, today used for `usage`). The control plane validates and scrubs it with an allowlist, then forwards: metrics to VictoriaMetrics, logs and error reports to Loki, a few curated product events to PostHog EU. Instances never talk to any of these directly; browsers never load a third-party script.
- **Allowlist, not blocklist.** Every field that can leave an instance is named in one schema file with its type and its allowed values. Anything else is dropped before storage and counted. Free text cannot be expressed in the schema, so it cannot be sent.
- **Two tiers.** *Operating data* the hosted service needs to run (route counts and durations, connections, process resources, workspace scale, seats, version, disk, backup/restore health, and last activity) stays on when product analytics is off. *Product analytics* (feature-use counts, durations, and coarse device/browser/OS classes) follows the hosted owner opt-out and the self-host opt-in. Error reports are a later phase and are not collected yet.
- **Cost.** About 36 MB per workspace per month inside our own network; roughly 3 dollars a month of egress for 100 workspaces at the EU rate and noise below that. The stack runs on the existing Helsinki VPS (a few euros a month for a separate volume, section 4a), and the other cost is the PostHog event budget, which stays under the free tier with daily rollups up to about a thousand workspaces.
- **Order.** Disclosure and the owner switch ship before any new data leaves an instance.
- **Where it lives.** Self-hosted on the Helsinki VPS (section 4a): a separate volume, containers under their own user, Grafana reachable only over WireGuard or an authenticating proxy, and a Parquet data lake queried with DuckDB.

## 1. The pipeline

```
browser ──(UI event counts, no payload text)──► instance (aggregates in memory + a small SQLite table)
instance ──hourly POST /v1/workspaces/:id/telemetry (control token)──► control plane
control plane: validate → scrub (allowlist) → forward
    ├─ metrics ─────────► VictoriaMetrics (remote write)  ─► Grafana   ┐
    ├─ logs + errors + alerts ► Loki (push API)           ─► Grafana   ├ self-hosted on the Helsinki VPS
    ├─ scrubbed reports + alerts ► ingest service ─► spool ─► Parquet data lake (DuckDB) ┘
    └─ product events ──► PostHog EU (server-side batch)
self-hosted (opt-in): instance ──POST https://telemetry.<tabula domain>/v1/telemetry (install id)──► the same scrubber, same sinks
```

**What needs code in the app (`tabula`)**
1. `server/telemetry/schema.mjs` (generated from `server/telemetry/schema.json`): the allowlist, shared by the instance and the control plane (the control plane carries a copy, checked by a test that compares hashes).
2. `server/telemetry/collector.mjs`: in-memory counters and histograms (fixed buckets), `count(name, labels)`, `observe(name, ms, labels)`, `flush()` once an hour and on shutdown (the unflushed hour is at most 50 KB in a `telemetry_outbox` table so a crash does not lose it).
3. Call sites: a handful of one-line `count()` calls in the API, sync, MCP, OAuth, backup and tracker modules, and a wrapper in the error paths (section 5).
4. A browser beacon: `POST /api/telemetry/ui` with a body of enum event names and counts only (no strings, no ids), batched per tab session, rate limited. The instance aggregates it with everything else. The page loads no third-party scripts, so the CSP does not change.
5. The owner switch (section 3) and the Admin → Instance → Privacy panel.
6. `server/cloud.mjs`: a `pushTelemetry()` next to `pushUsage()`, with the same retry and logging style, skipped when telemetry is off.

**What needs endpoints in the control plane (`tabula-cloud`)**
1. `POST /v1/workspaces/:id/telemetry` (public listener, control-token authenticated like `usage` and `key-floor`): body at most 256 KB, 6 posts per hour per workspace, `{schema, hour, metrics, events, errors}`. Replies `{ok, dropped}` where `dropped` is the count of fields the scrubber removed (the instance logs it, which catches schema drift).
2. `src/telemetry/scrub.mjs`: the validator and allowlist. `src/telemetry/sinks.mjs`: the three forwarders, each behind its own env switch so they can be turned on one at a time; a failing sink never fails the post (it queues up to an hour in memory and drops with a counter).
3. A small table `telemetry_status(workspace_id, last_at, last_dropped, opted_out, connections_now, connections_peak, last_activity_at, series)` so the operator can see who is reporting, when each instance was last active, and a 24-hour hourly-peak activity series (section 7 of the dashboard spec). This is what the fleet view uses for "last seen"; it needs no live call to any instance. Also an `alerts` table (section 2.5a).
4. Optional, phase 6: `POST /v1/telemetry` for self-hosted installs, unauthenticated, 64 KB, strict rate limit per IP and per install id, same scrubber.
5. The workspace opt-out: the existing owner setting channel (`POST /v1/workspaces/:id/settings`, used today for `autoUpgrade`) carries a new `telemetry: boolean`. The control plane stores it and refuses to forward diagnostics and product data from an opted-out workspace even if an instance misbehaves.

**What runs outside the repos (decided 2026-10-11): the telemetry stack is self-hosted on the Helsinki VPS**, not on Fly and not on Grafana Cloud. See section 4a for the layout. The control plane holds the sink URLs and keys as Fly secrets, listed by name in the dashboard config screen, and nothing else about the VPS.

### 1a. How a report leaves a hosted instance (built)

The design above has the instance post each hour to the control plane. What is built is the other direction, which needs no new egress or token on the tenant: the control plane **pulls** the report over Flycast with the control token it already uses for `/api/internal/usage`, and forwards it.

- **`GET /api/internal/telemetry`** (hosted instances only; a self-hosted server has no route and sends nothing). Bearer token only, like the other `internal` routes: a browser session, a guest cookie or the CSRF header counts for nothing, and the answer to anything else is `401`.
- **`200`** with the report document itself as the body: the last *finished* hour, built by the same collector and scrubber as the Privacy tab's preview, so it already has the schema's shape, is at most 256 KB, carries the workspace id (`ws_...`) and the instance's aggregate counts, and holds no content and no identifier of a person. Asking again for the same hour answers the same document (the collector on the other side drops a duplicate for a workspace and hour).
- **`204`** with no body when collection is off: `TABULA_TELEMETRY=off` forces it. Nothing is built then.
- **`503`** with `no_report_yet` until the first hour after a start has finished, with `stale_report` when the stored report is older than the hour before this one (a missed capture is never served as fresh), and with `restoring` while a restore has the workspace. All mean "ask again later".
- **When it is built, and when it is handed out.** In the last minute of each hour, tried every 10 seconds with the latest kept, in memory only. It cannot be built after the boundary (the collector clears an hour when the next one starts), so the latest build is held back and handed out only once its hour has ended: inside the running hour the route answers `503` (a pull in the last minute would take a partial hour, and the collector drops a second report for the same workspace and hour). A forwarder polling from about minute 2 of the next hour gets the finished hour. The capture is skipped while a restore has the workspace. The hour is pinned when a build starts, and a build that crosses the boundary is discarded, so the label is the hour the numbers cover. A restart loses it, so the hour a process starts in is partial, and the hour a restart interrupts may never be reported. `data_bytes` comes from a streamed directory walk in the background (cached, refreshed when stale), so a large data directory never blocks requests; the first report after a start may leave it out.
- **Release label.** `app_version` is normalised on the instance to the schema's pattern (`2026.10.09-1` becomes `v2026.10.09`); the schema itself is unchanged.
- **Refused attempts.** A request without a valid control token is counted per address on every internal route: more than 30 a minute get `429` with `Retry-After`, and the first each minute is logged once (route and address, never the header).
- **The owner's switch.** As in section 3, turning product analytics off keeps operating data on and removes feature counts. The report therefore still answers `200` with operating data only, without feature-use series, and the feature series of the hour built before the switch are taken out of it, so no feature count from before an opt-out is handed out afterwards. The instance also tells the control plane: `telemetryAnalytics: true|false` is part of every usage push and is sent at once when the switch changes (`docs/cloud.md`), so the forwarder can drop feature-use series itself; a missing value means off.
- **Nothing is sent by the instance.** Delivery to the collector is the control plane's job (tabula-cloud); until that is deployed the report is only ever read by the control plane and by nobody else.

## 2. Catalogue: what is sent

Every name below is in the schema. Labels are enums from fixed lists; numbers are counts, durations in milliseconds, or bytes. A field that is a free string does not exist in the schema.

### 2.1 Common envelope (every post)

| Field | Type | Why it holds no content |
| --- | --- | --- |
| `schema` | integer | version of this catalogue |
| `hour` | integer | start of the hour, UTC, truncated to the hour |
| `app_version` | string matching `^v\d+(\.\d+){0,2}$` or `^[0-9a-f]{7,12}$` | the release label |
| `schema_directory`, `schema_chat` | integers | database schema generations |
| `node_major` | integer | runtime generation |
| `platform` | enum `linux`, `darwin`, `win32` | OS family |
| `mode` | enum `hosted`, `self` | which kind of install |
| `connections_now`, `connections_peak` | integers | live and hourly-peak connection counts (decision 2026-10-11: operational, see section 3) |
| `last_activity_at` | integer (ms, truncated to the minute) or null | when the last request from a signed-in user was served; one timestamp, no who or what |
| `workspace` | the workspace id (`ws_...`) or, self-hosted, a random install id | a random token, not derived from a name or an address |

### 2.2 Metrics (hourly, aggregated)

Route-template request counts and durations, connection totals, process resources, workspace scale, and backup/restore health are operating data and stay on. Feature-use metrics and coarse client-class counts follow the product-analytics switch; route counts do not carry feature meaning even when a route maps one-to-one to a feature.

| Metric | Labels | Purpose | Why no content |
| --- | --- | --- | --- |
| `http_requests_total` | `route` (route template from our own route table, e.g. `boards/:id`), `status_class` (2xx, 3xx, 4xx, 5xx) | operating traffic/capacity; no feature meaning | the route template, never the URL, never ids or query |
| `http_duration_ms` | `route`, histogram buckets | operating latency/capacity; no feature meaning | durations only |
| `ws_connections_peak`, `ws_connections_avg` | none | capacity | integers |
| `rooms_open_peak` | none | capacity | integer |
| `sync_save_ms`, `sync_load_ms` | histogram buckets | persistence health | durations |
| `process_rss_bytes`, `event_loop_lag_ms_p95`, `cpu_seconds` | none | sizing and leaks | resource numbers |
| `data_bytes`, `disk_free_bytes` | none | storage planning | sizes |
| `entities_total` | `kind` enum (`boards`, `users_active`, `users_guest`, `tickets`, `trackers`, `chat_channels`, `assets`) | workspace scale, always on | counts only; board counts stay available when product analytics is off |
| `mcp_calls_total` | `tool` (our tool names), `result` (`ok`, `denied`, `error`), `auth` (`token`, `oauth`) | which AI tools are used | tool names are ours; arguments are never sent |
| `oauth_events_total` | `event` (`registered`, `authorized`, `denied`, `token`, `refresh`, `revoked`), `client_kind` (`known`, `unknown`, `loopback`) | adoption of connectors | no client names, no URIs |
| `backup_runs_total`, `backup_duration_ms`, `backup_bytes` | `result` (`ok`, `failed`), `error_code` enum | always-on backup health | approved error-code labels only |
| `restore_runs_total` | `kind` (`board`, `workspace`), `result` | always-on restore health | no names |
| `tracker_ops_total` | `op` enum (`create`, `update`, `comment`, `link`, `attach`, `search`, `import`) | tracker usage | counts |
| `chat_messages_total` | `kind` (`channel`, `direct`) | feature use | a count; text, names and recipients never |
| `uploads_total`, `upload_bytes` | `kind` (`image`, `file`), `size_bucket` | storage planning | counts and sizes |
| `ai_calls_total` | `feature` enum, `result` | AI feature use | no prompts, no outputs |
| `client_sessions_total` | `device` (`phone`, `tablet`, `desktop`), `browser` (`chrome`, `safari`, `firefox`, `edge`, `other`), `os` (`ios`, `android`, `macos`, `windows`, `linux`, `other`), `installed` (`pwa`, `browser`) | product-analytics counts of coarse client classes | derived from the User-Agent by the instance, which discards the header; raw User-Agent and browser strings are never sent |
| `ui_events_total` | `event` enum from section 2.4 | feature use | enum names only |
| `scrubber_dropped_total` | none (control plane only) | catches schema drift | count |

### 2.3 Error reports

Error reports are not collected yet. When they are added they will stay on and contain only an error code and the software version, never anything from the workspace's boards. Backup and restore health continue to use only their approved error-code labels as operating metrics.

### 2.4 Curated product events (to PostHog)

Sent from the control plane, never from the browser, as **daily rollups** per workspace plus a few milestones. PostHog is used for workspace-level groups only (group type `workspace`); no person profiles are created and no user, email, IP or device id is sent.

| Event | Properties | Purpose |
| --- | --- | --- |
| `workspace_day` | `dau`, `wau` (integers from the instance's own counts), `boards`, `tickets` (integers), `features_used` (list of enum feature names), `app_version`, `mode` | engagement per workspace per day |
| `feature_used` | `feature` enum, `count` | which features matter (see below) |
| `milestone` | `name` enum: `first_board`, `first_ticket`, `first_member_invited`, `first_mcp_connect`, `first_oauth_grant`, `first_backup`, `first_chat_message`, `tracker_enabled` | the activation funnel |
| `upgrade_result` | `from`, `to`, `result` (`ok`, `rolled_back`), `duration_ms` | upgrade health (from the control plane's own data) |
| `error_rate_day` | `top_codes` (up to 5 codes with counts) | stability trend |

Feature enum (fixed list, extended by changing the schema): `board_text`, `board_kanban`, `board_sticky`, `board_drawing`, `board_image`, `tracker_ticket`, `tracker_view`, `tracker_import`, `chat`, `mcp_token`, `mcp_oauth`, `backup_restore`, `ai_assist`, `export`, `guest_invite`.

### 2.5 Never sent

No field of the following kinds exists in the schema, so none can be added without a reviewed schema change:

- Any user content: board titles and text, object text, card and ticket titles, descriptions and comments, chat messages, file names, image and file contents, search queries, AI prompts and outputs, saved view and filter text, label and state names.
- Any identity: emails, names, user ids, session ids, tokens or token hints, IP addresses, raw User-Agent and browser strings, cookies, OAuth client names, redirect URIs and `state`. Coarse device, browser-family, and operating-system classes are sent as product-analytics counts only.
- Any address: board ids, ticket ids and keys, room ids, URLs and URL paths with ids or queries.
- Any error message text, SQL, stack frames from outside our code, request or response bodies, headers, environment variables.
- Server environment: anything from the server's own network or machine beyond the runtime generation and OS family.

### 2.5a Alerts

The control plane stores every alert it raises in an `alerts` table (the dashboard shows the history) and forwards a structured entry into the pipeline, next to the metrics and errors. Alerts are produced by the control plane itself, so they never pass through an instance.

| Field | Type | Why no content |
| --- | --- | --- |
| `kind` | enum: `backup_failing`, `backup_stale`, `upgrade_rolled_back`, `upgrade_job_gave_up`, `rollout_halted`, `disk_high`, `payment_failed`, `sign_in_failures`, `sink_failing`, `other` | closed set |
| `severity` | enum `info`, `warn`, `page` | closed set |
| `workspace` | workspace id or null | a random token |
| `at` | integer | time |

The free-text message of an alert (it can name a slug or an email) stays in the control plane's own table, redacted as today, and is not sent to Loki. Loki receives the entry as a log line with these labels; Grafana alert rules can use it.

### 2.6 The scrubber

Lives in `src/telemetry/scrub.mjs` (control plane) with the same schema on the instance side before sending, so a bug on one side is caught on the other.

1. **Allowlist by event and field name.** Unknown event, unknown field, or a field in the wrong event is removed; the removal is counted in `scrubber_dropped_total{reason}` and returned as `dropped` to the instance.
2. **Type and shape per field.** Integers must be safe integers within a stated range; enums must be members; the few string fields must match their anchored regular expression (version, code, hex fingerprint, `file:line`, workspace id). A string that does not match is dropped, never truncated.
3. **Labels are closed sets.** A label value outside its set is replaced by `other` for metrics (so cardinality stays bounded) and the event is counted.
4. **Cardinality limits.** At most 200 distinct label combinations per metric per post and at most 50 error fingerprints per post.
5. **Size limits.** 256 KB per post, 1,000 events per post.
6. **No raw pass-through.** The forwarders build their payloads from the validated structure, never from the original JSON.
7. **Tests.** A table-driven test per schema entry, a fuzz test that feeds random strings, emails, URLs and 10 KB blobs into every field and asserts none reaches a sink, and a test that fails if a sink payload contains any email-, URL- or token-shaped string.
8. **Change control.** `server/telemetry/schema.json` changes only through a reviewed commit; proposed: a rule in AGENTS.md that the tech lead reviews any change to it, and the designer/legal wording in the Privacy panel changes with it.

## 3. Opt-out, opt-in, and what the owner sees

**Hosted workspaces.**
- Product analytics is on by default with a disclosure, and the owner can turn it off. The switch stops feature-use counts and durations (including how many boards were opened) and coarse device/browser/OS class counts. Raw User-Agent and browser strings are discarded on the instance. Operating data stays on either way: route-template request counts and durations, current and hourly peak connections, process resource use, workspace sizes only (how many boards, members and items, never content), seats and guests, version, disk, backup/restore health, and last activity. Error reports are not collected yet; when added, they will stay on and contain only an error code and software version.
- Setting: stored in the instance's settings (`telemetry.enabled`, default true when hosted) and pushed to the control plane through the existing settings channel, so both sides enforce it. Env override for the operator: `TABULA_TELEMETRY=off` on the machine disables it regardless.
- **Admin → Instance → Privacy** (owner only; admins see it read-only): hosted workspaces use a "Product analytics" switch. A plain-language list distinguishes product analytics from operating data that stays on, explains that nothing has been sent in this version, includes a closed "What is never sent" list, and offers a local preview of the exact scrubbed report with a docs link. Turning off product analytics stops collection at once; already-sent data can be deleted on request.
- Disclosure: the signup page, the terms and the privacy page say it in one paragraph; the first owner sign-in after the feature ships shows a one-time notice with the switch.

**Self-hosted installs.**
- Off by default. Env var `TABULA_TELEMETRY=on` turns it on (any other value, or unset, is off); `TABULA_TELEMETRY_URL` overrides the destination (default: the Tabula collector, only used when `on`). The Admin panel shows the same switch, but it can only be turned on if the operator has not forced it off with the env var, and it shows the install id and a "Regenerate install id" button. The install id is random and local; it is never derived from the hostname, the domain or the owner email.
- The first-run text of a self-hosted install mentions the option once and never asks again.

## 4. Volume and cost

**Volume.** A typical hourly post is 2 to 10 KB (a few hundred metric samples). Budget 50 KB per hour as a ceiling, which is 36.5 MB per workspace per month.

| Workspaces | Posts per month | Data per month | Egress at 0.02 USD/GB (EU) if it all left Fly |
| --- | --- | --- | --- |
| 10 | 7,300 | 0.4 GB | 0.01 USD |
| 100 | 73,000 | 3.7 GB | 0.07 USD |
| 1,000 | 730,000 | 36.5 GB | 0.73 USD |
| 10,000 | 7.3 million | 365 GB | 7.30 USD |

Instance to control plane traffic is inside the Fly network and is a small fraction of that. The sinks run on Fly in the same region, so only the PostHog forward leaves our network, and that is a few KB a day per workspace.

**Stack.** Self-hosted on the existing Helsinki VPS (4 CPU, 7.6 GB RAM, 22 GB free disk, already running Prometheus, Grafana, Alertmanager and Postgres). The added software is small: VictoriaMetrics about 200 to 300 MB of RAM at this scale, Loki about 300 MB, a Grafana of its own about 150 MB, the ingest service about 50 MB, and DuckDB only while a query or the nightly compaction runs (capped at 1 GB). That fits beside what is there, but the VPS is shared with other duties, so the isolation in section 4a matters more than the cost. Incremental money cost is a 10 to 20 GB Hetzner volume (a few euros a month). Switching to Grafana Cloud later stays a URL change in the control plane.

**PostHog events.** Per workspace per day: one `workspace_day`, up to 15 `feature_used`, one `error_rate_day`, plus rare milestones and upgrade results: about 20 events a day, 600 a month. One million events (the free allowance as of writing; check current pricing before relying on it) covers about 1,600 workspaces. Sending hourly events instead would be 24 times more and would not fit; that is why rollups are the design.

## 4a. Self-hosted stack and data lake (Helsinki VPS)

**Isolation.**
- A **separate Hetzner volume** mounted at `/srv/telemetry` (start with 20 GB, grow online). Nothing telemetry-related writes to the root disk, so a runaway query or a retention bug cannot fill the disk the databases live on. Alert on 80 percent use of that volume.
- **Containers under a dedicated system user** (`telemetry`), one compose project with its own network, memory limits per container (VictoriaMetrics 512 MB, Loki 512 MB, Grafana 256 MB, ingest 128 MB, a DuckDB job 1 GB) and no access to the host's Postgres or the existing Prometheus. The existing Prometheus and Alertmanager stay as they are; telemetry does not reuse them.
- **Grafana is not public.** It listens on `127.0.0.1` only. The operator reaches it over WireGuard, or through an authenticating proxy (for example `oauth2-proxy` in front of Caddy) restricted to the one operator address, with a passkey or the same emailed-link flow as the dashboard. No anonymous access, no public dashboards, no shared accounts. Loki and VictoriaMetrics are never exposed at all.
- **The one public door is the ingest service**, `https://telemetry-ingest.<domain>/v1/ingest`, behind Caddy: TLS, bearer token (the control plane's sink key, rotated by changing a secret on both sides), 1 MB body limit, 10 requests a second, and a firewall allow-list if the Fly app gets a static egress IP (recommended: allocate one). Only the control plane calls it. Instances never reach the VPS.
- **Backups.** Nightly copy of `/srv/telemetry/lake` and of the VictoriaMetrics snapshot to the same off-site target the other VPS data uses. The lake is rebuildable from the spool for the last 7 days only, so off-site copies are the real safety net. Test a restore once before relying on it.
- **Secrets.** Sink keys in the compose project's env file owned by `telemetry`, mode 600, never in the repo or in logs; Fly secrets on the control plane side, listed by name only.

**Data lake: what goes in.** Scrubbed hourly reports (the validated structure of section 2.2 and 2.3, flattened to rows), daily rollups, alerts (section 2.5a) and the `telemetry_status` history. Never the raw post. Metrics for dashboards go to VictoriaMetrics; the lake is for analysis over time (cohorts, retention, version adoption, feature funnels) and as the long-term, queryable record.

**Format and layout.** Parquet files with zstd compression, hive-partitioned:

```
/srv/telemetry/lake/
  stream=reports_hourly/dt=2026-10-11/workspace=ws_Qz43ux4p5HNJ/part-0.parquet
  stream=errors/dt=2026-10-11/workspace=ws_.../part-0.parquet
  stream=alerts/dt=2026-10-11/part-0.parquet                    (few rows: no workspace partition)
  stream=status/dt=2026-10-11/part-0.parquet
  spool/ingest-<epoch>.ndjson                                    (today and yesterday, not yet compacted)
```

- **Ingest.** The ingest service appends each validated batch to an NDJSON spool file (one write path, append-only, no partial files for readers).
- **Compaction.** A nightly job (cron, DuckDB) reads the previous day's spool and writes `dt=/workspace=` Parquet partitions with `COPY ... TO ... (FORMAT PARQUET, PARTITION_BY (stream, dt, workspace), COMPRESSION zstd)`, then deletes the spooled file after a checksum of the row counts matches. A monthly job merges a workspace's daily files into one file per workspace per month, so file counts stay low (about 12 files per workspace per stream per year).
- **Why the workspace is a partition.** Deletion on request by workspace id becomes removing directories, and a single workspace's history is one directory scan. The cost is many small files; at the planned scale (hundreds of workspaces) that is fine with the monthly merge. **Past about 500 workspaces** switch to `dt` partitions only, with rows sorted by workspace so Parquet statistics still prune, and make deletion a monthly rewrite per affected partition.
- **Row schema.** One row per workspace per hour per metric family, columns typed from the schema file (no free text). A `schema` column carries the catalogue version so old files stay readable.
- **Retention.** Hourly reports kept 13 months (the decision in section 8), then dropped by removing `dt=` partitions older than that. Errors 30 days. Alerts and status 90 days to 13 months as set in section 8. Deletion on request: remove `workspace=<id>` directories in every stream, rewrite the open spool, record the deletion in a log kept without the content.

**What DuckDB does well here.** It reads Parquet files in place with SQL, prunes by partition and column statistics, needs no server (a binary or a Python/Node library), handles tens to hundreds of millions of rows on this VPS, runs the compaction job itself, and can join the lake with a small CSV or a SQLite export (the control plane's billing and plan tables) for questions like "retention of paid versus comp workspaces". It is read-only for analysts by default, which fits an operator-only dataset.

**Where it stops, and where ClickHouse would come in later.** DuckDB is a single-process, mostly single-writer engine: it is not a service for many concurrent dashboard users, it does not ingest streams (batch only, hence the spool), and it is not meant for sub-second dashboards over billions of rows. Add **ClickHouse** (it can run in one more container on the same VPS and reads the same Parquet files) when one of these becomes true: the lake exceeds roughly a billion rows or a few hundred GB; several people or many Grafana panels query it at once; near-real-time ingest (under a minute) is wanted; or the retention and deletion work should happen inside a database instead of file jobs. The migration is incremental: keep writing Parquet, point ClickHouse's file/S3 table functions at it, then move hot streams into native tables.

**Grafana and the lake.** Dashboards use VictoriaMetrics and Loki. The lake is queried from the DuckDB CLI or a notebook; if panels over the lake are wanted, expose a small read-only query endpoint on the VPS (loopback only, behind the same proxy) rather than giving Grafana a file path.

**Operating it.** A runbook page for the VPS: start and stop the compose project, disk alerts, the compaction and retention cron jobs and their logs, rotating the sink key, restoring from backup, and the deletion-on-request procedure. The compaction job writes a one-line result to its log and to Loki; a missed night alerts.

## 5. Capturing errors safely

This is a later phase. The current instance implementation keeps `errors: []` and has no error collector. If error reports are added, they will remain on when product analytics is off and contain only an error code and the software version. Messages, stacks, fingerprints, file paths, request data, and board content are not included.

Operational logs stay on the machine; none are shipped. Any future log shipping needs its own scrubber and a separate decision.

## 6. Rollout phases

| Phase | What | Gate |
| --- | --- | --- |
| 0 | This document, decisions on the questions below, schema file drafted | Johan's answers |
| 1 | Schema, collector and scrubber with tests (instance and control plane); nothing sent anywhere. The Privacy panel and the owner switch ship, the disclosure text goes live on the site and the first-sign-in notice | designer reviews the text; security re-review of the scrubber |
| 2 | Hourly post to the control plane, which validates and stores only the operator-visible status (`telemetry_status`), no sinks | tabulahq and acme only, then all hosted |
| 3 | Provision the stack on the Helsinki VPS (separate volume, containers, ingest service, WireGuard or proxy for Grafana, backups) and send metrics to VictoriaMetrics with Grafana dashboards (fleet health, latency, errors, devices) | stack deployed, isolated, backed up and a restore tested |
| 4 | Error reports and alerts to Loki, and the Parquet data lake (ingest, spool, nightly compaction, retention job) | phase 3 stable |
| 5 | Daily rollups and milestones to PostHog EU | PostHog project created in the EU region, privacy settings checked (no autocapture, no IP, no person profiles) |
| 6 | Self-hosted opt-in and the public collector endpoint | legal text for self-hosters; rate limits tested |

Each phase can be turned off by an env switch on the control plane without redeploying instances.

## 7. Control-plane items to fold into the operator dashboard spec

(`tabula-cloud/docs/admin-dashboard-spec.md`, section 3 and screen 7.)
- `GET /admin/telemetry` for the fleet: reporting / silent / opted-out counts, last post per workspace, scrubber drops last 24 hours by reason, and the state of each sink (configured by name, last error).
- A fleet-list column "telemetry: on / off / last post", the "last seen" and activity trend from `telemetry_status`, and a filter for workspaces that have been silent for 3 hours or more.
- `GET /admin/alerts` backed by the stored alerts (section 2.5a).
- The sink URLs and keys listed by name in the config screen, never values.
- A per-sink on/off switch and a "pause all telemetry" switch in Settings (phase 4 there), with an audit row.
- A global default for new workspaces and a per-workspace override on the workspace screen.

## 8. Decisions (Johan, 2026-10-11, "go with recommended" on all of them)

1. **Identifiers.** Workspace-only. No person identifier anywhere; PostHog receives group events for the group type `workspace` only.
2. **Retention.** Metrics at full resolution for 30 days, then hourly rollups for 13 months; error entries 30 days; PostHog events 12 months; `telemetry_status` 90 days; deletion on request by workspace id in every store.
3. **Security releases and version freezes.** A security release may override an owner's freeze, within these limits: only releases the operator marked security; the owner gets an email at least 24 hours before unless it is an active-exploit emergency; the update waits for the quiet window unless the emergency rule applies; the automatic rollback stays; one sentence in the terms; and the dashboard lists every override.
4. **Opt-out.** Owners only, and only for product analytics. Operating data remains on; future error reports will also remain on.
5. **Self-hosted.** Through Tabula's own collector only, so the scrubber always runs.
6. **Device class.** Device, browser-family, and operating-system classes are kept as product-analytics counts. The raw User-Agent and browser strings are read on the instance and discarded.
7. **"Send diagnostics now" button.** Later, not in the first phases.
8. **DAU.** Total only, no role distribution.
9. **Stack hosting.** Self-hosted on the Helsinki VPS: Grafana + Loki + VictoriaMetrics, plus a data lake of scrubbed hourly reports and alerts as Parquet queried with DuckDB (section 4a). This replaces the earlier recommendation (Grafana Cloud's free tier, then Fly).
10. **Legal wording.** Drafted by the CGO; nothing is published without his go.
11. **Last seen as operating data.** Connections now, hourly peak and last-activity time are sent even for a workspace that opted out of telemetry, with one line saying so in the Privacy panel.
12. **Alerts in the data lake.** Only the closed kind, severity, workspace id and time are forwarded; the free-text message stays in the control plane.

Retention and identifiers above replace the proposals in the questions below, which are kept for the record.

## 9. Questions as first asked (answered above)

1. **Security fixes and version freezes.** Owners can already turn automatic updates off (`updates.auto`). Today a security release already overrides that (the upgrade policy ignores the opt-out for releases marked security), (`docs/second-deploy.md` in tabula-cloud says so). **Recommendation: yes, security releases may override a freeze, with limits.** Only releases marked security by the operator; the owner gets an email at least 24 hours before unless it is an active-exploit emergency; the update waits for the quiet window unless the emergency rule applies; the automatic rollback stays; the terms say so in one sentence; and the dashboard keeps a list of every override. A freeze that blocks a fix for a known hole puts every other customer on the same platform at risk.
2. **Retention.** Recommendation: metrics at full resolution for 30 days, then hourly rollups for 13 months; error entries 30 days; PostHog events 12 months; the `telemetry_status` table 90 days; deletion on request by workspace id in all three stores. Is 13 months enough for year-on-year comparisons?
3. **Default on for hosted.** The decision is "disclosure plus owner opt-out". Should the opt-out also be offered to every admin, or to owners only (recommended: owners)?
4. **Self-hosted destination.** Tabula's own collector (simple) or a pass-through to PostHog directly? Recommendation: our collector only, so the scrubber always runs.
5. **Stack hosting.** Start on Grafana Cloud's free tier (no ops) or self-host on Fly from day one (about 15 USD a month, full control)? Recommendation: free tier until phase 4, then self-host.
6. **Legal wording.** The terms and privacy page need the new paragraph (categories, EU hosting, retention, deletion). Who writes and approves it, and does it need a data processing addendum for business customers?
7. **Device class from the User-Agent.** Answered: coarse device, browser-family, and operating-system classes stay as counts under product analytics; the header is discarded on the instance, and the raw string is never sent.
8. **Error detail for customers.** If a customer reports a problem, is a one-off "send diagnostics now" button (owner-triggered, shows exactly what will be sent, includes the last hour's fingerprints) in scope?
9. **Daily active user counts.** `dau` and `wau` are integers from the instance. Do we also want a distribution by role (owner, member, guest) or is the total enough?
10. **Last seen as operational.** The hourly post carries connection counts and the last-activity time even for a workspace that opted out of telemetry, because the service needs them (upgrade deferral, dead-instance detection). Recommendation: yes, stated in one line in the Privacy panel. The alternative is no last seen for opted-out workspaces.
11. **Alerts in the data lake.** Only the closed kind, severity, workspace id and time are forwarded; the free-text message stays in the control plane. Agreed?
