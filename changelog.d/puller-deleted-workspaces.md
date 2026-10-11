section: Added
audience: dev

- Backup puller: require at least one day of deleted grace, skip automatic purges when the workspace list is stale, and rename copies to same-filesystem tombstones before removal. Clean and report leftover tombstones, expose list age and leftover metrics, keep dry runs write-free, and refuse immediate erasure of a listed live workspace unless `--force` is supplied.
