#!/usr/bin/env bash
# One-time setup, run by hand as root on the host. Interactive: it stops before each step.
#   1. creates the SSH key pair (private key stays here, mode 600) and prints the PUBLIC key for the Storage Box sub-account
#   2. creates the restic password file and tells you to copy it to your password manager BEFORE going on
#   3. initialises the restic repository at the sub-account root (path restic-telemetry)
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
BACKUP_ENV="${BACKUP_ENV:-/etc/tabula-telemetry/backup.env}"
# shellcheck disable=SC1090
source "$BACKUP_ENV"
ask() { read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]]; }

if [[ -e "$SSH_KEY" ]]; then echo "key $SSH_KEY exists, not touching it"; else
  ask "Generate the ed25519 key $SSH_KEY?" || exit 1
  install -d -m 700 "$(dirname "$SSH_KEY")"
  ssh-keygen -t ed25519 -N '' -C "tabula-telemetry-backup@$(hostname)" -f "$SSH_KEY"
fi
echo; echo "Public key (install it in the sub-account's .ssh/authorized_keys over port 23, OpenSSH format):"; cat "${SSH_KEY}.pub"
echo; ask "Public key installed, and the Storage Box host key added to /root/.ssh/known_hosts?" || exit 1

if [[ -e "$RESTIC_PASSWORD_FILE" ]]; then echo "password file exists, not touching it"; else
  ask "Create the restic password file $RESTIC_PASSWORD_FILE?" || exit 1
  (umask 077; openssl rand -base64 32 > "$RESTIC_PASSWORD_FILE")
  echo "COPY THE FILE'S CONTENT TO YOUR PASSWORD MANAGER NOW. Without it the backup cannot be read."
  ask "Stored in the password manager?" || exit 1
fi
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ask "Run 'restic init' on ${RESTIC_REPOSITORY}?" || exit 1
restic "${RESTIC_SFTP[@]}" init
echo "repository ready"
