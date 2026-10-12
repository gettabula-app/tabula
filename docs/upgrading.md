# Upgrading and rolling back a self-hosted Tabula

For operators who run Tabula themselves. The rules come from [migrations.md](migrations.md); this page is the short version.

## Upgrade

1. **Back up first.** Either use the built-in backups ([backups.md](backups.md)) and check that the newest one succeeded, or stop the server and copy the whole `DATA_DIR` (`/data` in Docker), including any `-wal` and `-shm` files next to the SQLite files. Keep `TABULA_BACKUP_KEY` somewhere other than the server.
2. **Get the new version.** Pull or build the new image (`docker build -t tabula .` from the new source), or update the checkout and run `npm ci` and `npm run build`.
3. **Start it on the same data.** Stop the old container, start the new one with the same volume and the same environment. Migrations run at start, inside one transaction each. Watch the log until the relay listens, then check `GET /api/health`.

Migrations are written to be expand-only: new tables and columns, nothing dropped or rewritten. The previous version can usually keep reading the data after an upgrade. That is what makes a rollback possible, and the next section says when it is.

## What a database remembers

Both `directory.sqlite` and `chat.sqlite` have a `schema_meta` table with a `min_reader` row: the lowest build generation (the number of migrations a build knows) that can still read the file. Look at it with:

```sh
sqlite3 /data/directory.sqlite 'select * from schema_meta'
```

A build that knows `K` migrations opens a database when `min_reader <= K`. An older build that knows fewer migrations than the file's `min_reader` **refuses to start**, and leaves the file unchanged: no migration runs and nothing is lowered. A refused start therefore never damages data.

A database without a `schema_meta` row (a very old one) is strict: only a build that knows at least its `user_version` opens it.

## Roll back

A rollback to an older version O after running a newer version N is safe for the data when

> O's schema generation is at least N's `maxReader`

`npm run release-info` prints both numbers for the checkout you run it in (directory and chat, `schema` and `maxReader`). Example, main at the time of writing: directory `schema` 17, `maxReader` 11; chat `schema` 1, `maxReader` 0. A build that knows at least 11 directory migrations can read what that version wrote.

- Compare the older version's `schema` with the newer version's `maxReader`. If it is at least as high, stop the server, start the older image on the same volume.
- If it is lower, the older build will refuse the data. Do not edit `schema_meta`. Restore a backup taken **before** the upgrade instead (below), or stay on the newer version.
- A rollback does not undo data written by the newer version that the older one does not know; it simply ignores it. Anything created with features only the newer version has may not show.

## Restoring a backup across versions

A restore accepts a backup when its `min_reader` lets the running build read it; an older, legacy backup is strict ([backups.md](backups.md)). So a backup made before an upgrade can be restored onto the older build, and a backup from a newer version is refused by a build that is too old, with the reason. To go back after an upgrade: stop, start the older image on an empty or replaced volume, restore the pre-upgrade backup (whole workspace, from the Backups tab), and sign in again.

## Contracting changes

Anything that removes an old representation takes two releases: first an expand-only release, later the removal ([migrations.md](migrations.md), "Contracting"). Do not skip a release that the release notes mark as a step in such a pair.
