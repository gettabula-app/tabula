section: Changed
audience: dev

- Off-site backups now stage SQLite databases, rooms, history and assets behind a bounded write barrier, and restore checks the completed snapshot metadata.
