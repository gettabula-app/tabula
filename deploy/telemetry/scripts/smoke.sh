#!/usr/bin/env bash
# Local end-to-end check with Docker: brings the stack up in a throwaway project with dummy credentials and a temp data
# directory on loopback ports 18480 and 18481, posts a synthetic report, reads it back through Grafana's datasource proxy
# and DuckDB, deletes the workspace, and tears everything down. Never run it on a server that has the real stack.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then echo "docker daemon not available" >&2; exit 2; fi

data="$(mktemp -d)"
export TELEMETRY_DATA="$data" GRAFANA_PORT=18480 INGEST_PORT=18481 GRAFANA_BIND=127.0.0.1 INGEST_BIND=127.0.0.1
GRAFANA_ADMIN_PASSWORD="smoke-$(openssl rand -hex 8)"
export GRAFANA_ADMIN_USER=smoke GRAFANA_ADMIN_PASSWORD
P=(docker compose -p tabula-telemetry-smoke)
teardown() { "${P[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$data"; }
trap teardown EXIT
mkdir -p "$data"/{state,lake,vm,loki,grafana}
chmod -R 777 "$data"   # local scratch only: containers run as different uids

ws=ws_smoketest0001
"${P[@]}" up -d --build --wait
token="$("${P[@]}" run --rm -T collector token issue --workspace "$ws" | sed -n 's/^token (.*): //p')"
[[ -n "$token" ]] || { echo "no token issued" >&2; exit 1; }

echo "== post a synthetic report"
node scripts/synthetic-report.mjs "$ws" | curl -fsS -H "authorization: Bearer $token" -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$INGEST_PORT/v1/telemetry"
echo; echo "== a second post for the same hour is refused (409)"
node scripts/synthetic-report.mjs "$ws" | curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $token" -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$INGEST_PORT/v1/telemetry"

sleep 3
graf() { curl -fsS -u "$GRAFANA_ADMIN_USER:$GRAFANA_ADMIN_PASSWORD" -G "http://127.0.0.1:$GRAFANA_PORT/api/datasources/proxy/uid/$1" "${@:2}"; }
echo "== VictoriaMetrics through Grafana"
graf tabula-vm/api/v1/query --data-urlencode "query=last_over_time(tabula_connections_peak{workspace=\"$ws\"}[3h])"
echo; echo "== Loki through Grafana"
graf tabula-loki/loki/api/v1/query_range --data-urlencode "query={job=\"tabula-telemetry\",workspace=\"$ws\",kind=\"error\"}" --data-urlencode "start=$(( $(date +%s) - 7200 ))000000000"
echo; echo "== dashboards provisioned"
curl -fsS -u "$GRAFANA_ADMIN_USER:$GRAFANA_ADMIN_PASSWORD" "http://127.0.0.1:$GRAFANA_PORT/api/search?tag=tabula" | grep -o '"title":"[^"]*"'
echo "== DuckDB over the spool, then compacted"
"${P[@]}" run --rm -T lake query "SELECT name, value FROM reports_hourly WHERE workspace='$ws' ORDER BY name"
"${P[@]}" run --rm -T lake compact --day "$(date -u +%F)"
"${P[@]}" run --rm -T lake query "SELECT stream, count(*) AS n FROM (SELECT * FROM reports_hourly UNION ALL BY NAME SELECT * FROM errors) GROUP BY stream"
echo "== delete the workspace"
"${P[@]}" run --rm -T collector delete-workspace --workspace "$ws"
sleep 2
graf tabula-vm/api/v1/query --data-urlencode "query=last_over_time(tabula_connections_peak{workspace=\"$ws\"}[3h])"
echo; echo "smoke done"
