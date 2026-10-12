#!/usr/bin/env bash
# Refuses to continue when the environment would publish a door on every interface or a port that the host already uses.
# Usage: deploy/telemetry/scripts/preflight.sh [env-file]   (default: ./.env next to compose.yaml)
# Run it before the first start and before every upgrade; PREFLIGHT_SKIP_LISTEN=1 skips the "already listening" check
# when the stack itself is running.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
envfile="${1:-$here/.env}"
[[ -f "$envfile" ]] || { echo "missing $envfile (copy .env.example)" >&2; exit 1; }
get() { { grep -E "^$1=" "$envfile" || true; } | tail -1 | cut -d= -f2-; }
fail=0
# A door may bind to loopback, to a NetBird address (100.64.0.0/10), or to the one private tunnel address Johan approves in
# APPROVED_TUNNEL_ADDRESS (a WireGuard address inside 10/8, 172.16/12, 192.168/16 or fd00::/8). Anything else is refused:
# the proxy speaks plain HTTP and relies on the tunnel for encryption.
octets() { IFS=. read -r a b c d <<<"$1"; for o in "$a" "$b" "$c" "$d"; do [[ "$o" =~ ^[0-9]{1,3}$ ]] && ((o <= 255)) || return 1; done; }
is_loopback() { [[ "$1" == ::1 || "$1" == localhost ]] || { octets "$1" && [[ "$1" == 127.* ]]; }; }
is_netbird() { octets "$1" && IFS=. read -r a b _ _ <<<"$1" && ((a == 100 && b >= 64 && b <= 127)); }
is_private() {
  [[ "$1" =~ ^[fF][dD][0-9a-fA-F:]+$ ]] && return 0
  octets "$1" || return 1
  IFS=. read -r a b _ _ <<<"$1"
  ((a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168)))
}
approved="$(get APPROVED_TUNNEL_ADDRESS)"
if [[ -n "$approved" ]] && ! is_private "$approved"; then echo "refused: APPROVED_TUNNEL_ADDRESS='$approved' is not a private address" >&2; fail=1; approved=""; fi
for name in GRAFANA_BIND INGEST_BIND; do
  value="$(get "$name")"
  if [[ -z "$value" ]] || ! { is_loopback "$value" || is_netbird "$value" || { [[ -n "$approved" && "$value" == "$approved" ]]; }; }; then
    echo "refused: $name='$value' is not loopback, a NetBird address, or APPROVED_TUNNEL_ADDRESS" >&2; fail=1
  fi
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
# The public TLS door (compose profile "door", COMPOSE_PROFILES=door). Off by default; when on it publishes ports 80 and 443 on ONE explicit public IPv4
# address, so every setting is checked: a real DNS name, a public bind address (never a wildcard, loopback or private address), and an allow-list of
# single public IPv4 addresses (the control plane's static egress address). IPv6 is refused for now: Docker's userland proxy hides an IPv6 client's
# address, so an allow-list could not tell clients apart (it would only ever fail closed).
is_public_ipv4() {
  octets "$1" || return 1
  IFS=. read -r a b _ _ <<<"$1"
  ((a == 0 || a == 10 || a == 127 || a >= 224)) && return 1
  ((a == 100 && b >= 64 && b <= 127)) && return 1
  ((a == 169 && b == 254)) && return 1
  ((a == 172 && b >= 16 && b <= 31)) && return 1
  ((a == 192 && b == 168)) && return 1
  ((a == 192 && b == 0)) && return 1
  return 0
}
if [[ ",$(get COMPOSE_PROFILES)," == *,door,* ]]; then
  door_host="$(get DOOR_HOST)"; door_bind="$(get DOOR_BIND)"; door_allow="$(get DOOR_ALLOW)"
  if ! [[ "$door_host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || [[ "$door_host" =~ \.(invalid|local|localhost|test|example)$ ]]; then
    echo "refused: DOOR_HOST='$door_host' is not a public DNS name" >&2; fail=1
  fi
  if ! is_public_ipv4 "$door_bind"; then
    echo "refused: DOOR_BIND='$door_bind' must be this server's own public IPv4 address (not empty, 0.0.0.0, loopback or private)" >&2; fail=1
  fi
  if [[ -z "$door_allow" ]]; then
    echo "refused: DOOR_ALLOW is empty (the control plane's egress IPv4 address is required; an empty list would open the door to nobody or everybody)" >&2; fail=1
  fi
  for entry in $door_allow; do
    is_public_ipv4 "$entry" || { echo "refused: DOOR_ALLOW entry '$entry' is not a single public IPv4 address (no ranges, no IPv6, no private addresses)" >&2; fail=1; }
  done
  if [[ -z "${PREFLIGHT_SKIP_LISTEN:-}" ]] && command -v ss >/dev/null; then
    for port in 80 443; do
      ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$" && { echo "refused: port $port is already listening (the door needs 80 for the certificate and 443)" >&2; fail=1; }
    done
  fi
fi
for name in GRAFANA_ADMIN_USER GRAFANA_ADMIN_PASSWORD; do
  [[ -n "$(get "$name")" ]] || { echo "refused: $name is empty" >&2; fail=1; }
done
if ! grep -Eq '^\s+image: .*@sha256:' "$here/compose.yaml"; then
  echo "warning: compose.yaml images are pinned by tag only; pin digests (scripts/pin-digests.sh) before a deployment" >&2
fi
data="$(get TELEMETRY_DATA)"
[[ -n "$data" && -d "$data" ]] || { echo "refused: TELEMETRY_DATA '$data' does not exist (run scripts/init-data.sh)" >&2; fail=1; }
((fail)) && exit 1
echo "preflight ok"
