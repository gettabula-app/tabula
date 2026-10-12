#!/usr/bin/env bash
# Shared setup for the backup scripts. Sourced, never run. Reads /etc/tabula-telemetry/backup.env (or $BACKUP_ENV).
set -euo pipefail
BACKUP_ENV="${BACKUP_ENV:-/etc/tabula-telemetry/backup.env}"
[[ -r "$BACKUP_ENV" ]] || { echo "cannot read $BACKUP_ENV" >&2; exit 1; }
# shellcheck disable=SC1090
source "$BACKUP_ENV"
: "${STORAGEBOX_USER:?set in $BACKUP_ENV}" "${STORAGEBOX_HOST:?set in $BACKUP_ENV}"
: "${SSH_KEY:?}" "${RESTIC_PASSWORD_FILE:?}" "${TELEMETRY_DATA:?}" "${COMPOSE_DIR:?}"
command -v restic >/dev/null || { echo "restic is not installed" >&2; exit 1; }
[[ -r "$RESTIC_PASSWORD_FILE" ]] || { echo "restic password file missing: $RESTIC_PASSWORD_FILE" >&2; exit 1; }
export RESTIC_REPOSITORY="sftp:${STORAGEBOX_USER}@${STORAGEBOX_HOST}:${RESTIC_REPOSITORY_PATH:-restic-telemetry}"
export RESTIC_PASSWORD_FILE
# Hetzner Storage Box: SFTP on port 23. The host key must already be in root's known_hosts (see docs/telemetry-stack.md).
# shellcheck disable=SC2034
RESTIC_SFTP=(-o "sftp.args=-p 23 -i ${SSH_KEY} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes")
compose() { (cd "$COMPOSE_DIR" && docker compose "$@"); }
