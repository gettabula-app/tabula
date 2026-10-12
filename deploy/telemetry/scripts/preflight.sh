#!/usr/bin/env bash
# Refuses to continue when the environment would publish a door on every interface or a port that the host already uses.
# Usage: deploy/telemetry/scripts/preflight.sh [env-file]   (default: ./.env next to compose.yaml)
# Run it before the first start and before every upgrade; PREFLIGHT_SKIP_LISTEN=1 skips the "already listening" check
# when the stack itself is running.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
envfile="${1:-$here/.env}"
[[ -f "$envfile" ]] || { echo "missing $envfile (copy .env.example)" >&2; exit 1; }
get() { grep -E "^$1=" "$envfile" | tail -1 | cut -d= -f2-; }
fail=0
for name in GRAFANA_BIND INGEST_BIND; do
  value="$(get "$name")"
  case "$value" in
    ""|0.0.0.0|::|"[::]"|"*") echo "refused: $name='$value' would publish on every interface" >&2; fail=1 ;;
  esac
done
for name in GRAFANA_PORT INGEST_PORT; do
  value="$(get "$name")"; value="${value:-}"
  case "$value" in
    3000|9090|9093|9100|5432|18100|19100) echo "refused: $name=$value is used by the other project on this host" >&2; fail=1 ;;
  esac
  if [[ -z "${PREFLIGHT_SKIP_LISTEN:-}" ]] && command -v ss >/dev/null && [[ -n "$value" ]] && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${value}$"; then
    echo "refused: port $value is already listening" >&2; fail=1
  fi
done
for name in GRAFANA_ADMIN_USER GRAFANA_ADMIN_PASSWORD; do
  [[ -n "$(get "$name")" ]] || { echo "refused: $name is empty" >&2; fail=1; }
done
data="$(get TELEMETRY_DATA)"
[[ -n "$data" && -d "$data" ]] || { echo "refused: TELEMETRY_DATA '$data' does not exist (run scripts/init-data.sh)" >&2; fail=1; }
((fail)) && exit 1
echo "preflight ok"
