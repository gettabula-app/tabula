# The public TLS door for the control plane

The control plane (Fly app `tabula-cloud`) forwards each workspace's hourly telemetry report to the collector. It cannot join an operator tunnel, so the stack has one optional public door: a second Caddy (`door` service, compose profile `door`) with a Let's Encrypt certificate that lets exactly one address through.

## What it lets through

| Client | Request | Answer |
| --- | --- | --- |
| an address in `DOOR_ALLOW` | `POST /v1/telemetry` (body up to 300 KB) | the collector's answer (202, 401, 409, 422 ...) |
| an address in `DOOR_ALLOW` | `GET /healthz` | the collector's health |
| an address in `DOOR_ALLOW` | anything else (other path or method, `/metrics`) | 403 |
| any other address | anything, on port 443 | 403 |
| anyone | anything on port 80 | 403, except Let's Encrypt's own challenge path, which Caddy answers itself |

The client is the TCP peer address. No header (`X-Forwarded-For` and similar) is believed, and `remote_ip` has no trusted proxies. The collector's own bearer token and allow-list of workspaces still apply behind the door, so the address check is a second lock, not the only one.

`Caddyfile.door` was validated with `caddy validate` (Caddy 2.8.4) and the allow-list was exercised against a real Caddy container: an allowed client got 202 on `POST /v1/telemetry` and 200 on `GET /healthz`, 403 on `GET /v1/telemetry`, `POST /healthz`, `/metrics`, `/v1/other` and `/`; a client outside the list got 403 on all of them. The certificate part (ACME) has not been run anywhere.

## Settings (`.env`)

| Variable | Meaning |
| --- | --- |
| `COMPOSE_PROFILES=door` | switches the door on; without it the service does not exist and ports 80 and 443 stay closed |
| `DOOR_HOST` | the DNS name of the door; its A record must already point at `DOOR_BIND` (Let's Encrypt limits repeated failures) |
| `DOOR_BIND` | this server's own public IPv4 address; the only address ports 80 and 443 are published on |
| `DOOR_ALLOW` | space-separated single public IPv4 addresses: the control plane's static egress address from `fly ips allocate-egress` |

`scripts/preflight.sh` refuses the start when the door is on and: the name is not a public DNS name, `DOOR_BIND` is empty, `0.0.0.0`, loopback, private or IPv6, `DOOR_ALLOW` is empty, holds a range, an IPv6 address or a private address, or port 80 or 443 is already listening. IPv6 is left out on purpose: Docker's userland proxy hides an IPv6 client's address, so an allow-list could not tell clients apart. The Fly egress pair has an IPv4 and an IPv6 address; the control plane reaches an A-record-only name over IPv4.

## What does and does not protect the ports

Docker publishes ports around `ufw`: a rule in `ufw` does not open or close `DOOR_BIND:80` or `:443`, and the default deny does not stop them. The controls are, in order: the Caddy allow-list (always on), the collector's token and workspace allow-list, and, recommended, a **Hetzner Cloud Firewall** in front of the server (free, applied before the traffic reaches it): `tcp 443` only from the Fly egress IPv4 address, `tcp 80` from anywhere (Let's Encrypt validates from changing addresses; the door answers 403 to everything but the challenge), SSH as it is today.

The certificate lives in `${TELEMETRY_DATA}/door` (not in the backups: it is issued again if lost; do not delete it needlessly, Let's Encrypt limits duplicate certificates).

## Order of work (the exact commands and Johan's go phrases are in the manager's sheet)

1. Allocate the Fly egress address; read the IPv4 address.
2. Create the DNS A record for the door name.
3. Optionally add the Hetzner Cloud Firewall rules.
4. On the host: set the four `.env` values, `scripts/init-data.sh`, `scripts/preflight.sh`, `docker compose up -d door`; watch `docker compose logs door` for the certificate.
5. Check from outside (403 with a valid certificate) and from Fly (healthz 200).
6. Stage `TELEMETRY_COLLECTOR_URL` and `TELEMETRY_COLLECTOR_TOKEN` on `tabula-cloud` and deploy the control plane that forwards.

Rollback: unset the two Fly secrets and redeploy (or restart) the control plane, `docker compose stop door`, remove `COMPOSE_PROFILES=door`. The egress address can be released later; the DNS record can stay.
