#!/usr/bin/env bash
# Creates the data directories with the owners the containers run as. Run as root on the host, once.
# Usage: sudo deploy/telemetry/scripts/init-data.sh /srv/telemetry
set -euo pipefail
root="${1:?data directory, for example /srv/telemetry}"
[[ $EUID -eq 0 ]] || { echo "run as root (it sets owners)" >&2; exit 1; }
mkdir -p "$root"/{state,lake,vm,loki,grafana}
chown 1000:1000 "$root/state" "$root/lake"   # collector and lake job (the node user)
chown 10001:10001 "$root/loki"               # Loki
chown 472:0 "$root/grafana"                  # Grafana
chown 0:0 "$root/vm"                         # VictoriaMetrics
chmod 750 "$root" "$root/state" "$root/lake"
chmod 700 "$root/state"                      # holds the token registry
echo "ready: $root"
