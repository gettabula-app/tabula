#!/usr/bin/env bash
# Nightly backup of the telemetry data to the Storage Box (restic over SFTP), then forget/prune 7 daily, 4 weekly, 6 monthly.
# VictoriaMetrics is backed up through a snapshot (hard links), never from its live directories.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
exec 9>/run/tabula-telemetry-backup.lock
flock -n 9 || { echo "another backup is running" >&2; exit 0; }

snapshot=""
cleanup() {
  if [[ -n "$snapshot" ]]; then compose exec -T collector node telemetry-collector/src/cli.mjs vm-snapshot delete "$snapshot" >/dev/null || true; fi
}
trap cleanup EXIT

reply="$(compose exec -T collector node telemetry-collector/src/cli.mjs vm-snapshot create)"
snapshot="$(printf '%s' "$reply" | sed -n 's/.*"snapshot":"\([A-Za-z0-9_-]*\)".*/\1/p')"
[[ -n "$snapshot" ]] || { echo "VictoriaMetrics snapshot failed" >&2; exit 1; }

nice -n 15 ionice -c3 restic "${RESTIC_SFTP[@]}" backup \
  --tag nightly --host "$(hostname)" \
  --exclude "$TELEMETRY_DATA/vm/data" --exclude "$TELEMETRY_DATA/vm/indexdb" --exclude "$TELEMETRY_DATA/vm/cache" \
  --exclude "$TELEMETRY_DATA/lake/.staging" \
  "$TELEMETRY_DATA/state" "$TELEMETRY_DATA/lake" "$TELEMETRY_DATA/grafana" "$TELEMETRY_DATA/loki" "$TELEMETRY_DATA/vm/snapshots"

restic "${RESTIC_SFTP[@]}" forget --prune --tag nightly --keep-daily 7 --keep-weekly 4 --keep-monthly 6
echo "backup ok"
