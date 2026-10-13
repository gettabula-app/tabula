section: Security
audience: dev

- The sync socket now has limits: a frame-size cap by role (128 MiB for owners, 96 MiB for editors, 8 MiB in comment rooms), a 256 MiB document cap,
  per-socket frame rate limits, a cap of 40 sockets per person and 400 per client address, and 120 upgrades per minute per account
  (600 per address before sign-in). Each can be tuned with a `TABULA_SYNC_*` variable; see `docs/capacity.md`.
