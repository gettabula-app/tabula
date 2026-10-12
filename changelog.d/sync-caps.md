section: Security
audience: dev

- The sync socket now has limits: a frame-size cap by role (64 MiB for owners, 16 MiB for others), a 128 MiB document cap,
  per-socket frame rate limits, a cap of 40 sockets per person and 400 per client address, and 120 upgrades per minute per
  address. Each can be tuned with a `TABULA_SYNC_*` variable; see `docs/capacity.md`.
