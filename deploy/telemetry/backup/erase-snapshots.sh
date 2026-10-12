#!/usr/bin/env bash
# Erases a deleted workspace from the restic repository. Restic snapshots are immutable, so this takes a clean replacement
# backup (taken after the stores were purged and Loki applied its delete) and then forgets and prunes EVERY older snapshot.
# The cost is the loss of the older backup history: only the new snapshot remains. Interactive; run by hand as root.
#   backup/erase-snapshots.sh ws_xxxxxxxx
set -euo pipefail
ws="${1:?workspace id}"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cli() { compose exec -T collector node telemetry-collector/src/cli.mjs "$@"; }
cli deletion ready --workspace "$ws" || { echo "wait: run delete-workspace first, then at least 4 hours" >&2; exit 1; }
echo "This forgets all restic snapshots older than a new one. Backup history before today will be gone."
read -r -p "Continue for $ws? [y/N] " a; [[ "$a" == y || "$a" == Y ]] || exit 1
"$(dirname "${BASH_SOURCE[0]}")/backup.sh"
restic "${RESTIC_SFTP[@]}" forget --prune --keep-last 1
cli deletion complete --workspace "$ws"
echo "backups erased for $ws"
