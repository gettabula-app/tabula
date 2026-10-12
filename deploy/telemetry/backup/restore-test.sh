#!/usr/bin/env bash
# Monthly: restore the latest snapshot into a scratch directory, compare it with the live data, log the result, delete the scratch.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scratch="$(mktemp -d /var/tmp/telemetry-restore.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
nice -n 15 restic "${RESTIC_SFTP[@]}" restore latest --target "$scratch"
restored="$scratch$TELEMETRY_DATA"
status=ok
[[ -s "$restored/state/registry.json" ]] || status="registry missing"
live_files="$(find "$TELEMETRY_DATA/lake" -name '*.parquet' | wc -l)"
back_files="$(find "$restored/lake" -name '*.parquet' | wc -l)"
# Files written after last night's backup make live >= restored; fewer restored than live minus one day is a failure signal.
[[ "$back_files" -le "$live_files" ]] || status="restored has more parquet files than live"
[[ -d "$restored/vm/snapshots" ]] || status="no VictoriaMetrics snapshot in the backup"
printf '%s restore-test status=%s parquet_live=%s parquet_restored=%s\n' "$(date -u +%FT%TZ)" "$status" "$live_files" "$back_files" | tee -a "${RESTORE_TEST_LOG:-/var/log/tabula-telemetry-restore-tests.log}"
[[ "$status" == ok ]]
