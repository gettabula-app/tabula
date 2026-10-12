#!/usr/bin/env bash
# Weekly: verify the repository structure and read back 5 percent of the data.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
nice -n 15 restic "${RESTIC_SFTP[@]}" check --read-data-subset=5%
echo "check ok"
