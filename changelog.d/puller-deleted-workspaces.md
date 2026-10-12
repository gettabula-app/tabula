section: Added
audience: dev

- Backup puller: require at least one day of deleted grace, skip automatic purges when the workspace list is stale, and keep expired skipped purges in the pending metric. Operator purges require `--force` for stale, invalid or unreadable lists, or listed live workspaces; an absent list still permits a manual purge. Rename copies to same-filesystem tombstones before removal, clean and report leftovers, expose list age and leftover metrics, and keep dry runs write-free.
