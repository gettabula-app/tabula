# Backups

Tabula can copy its data directory to an S3-compatible bucket on a schedule, **encrypted on the instance before anything leaves it**. The storage provider only ever sees ciphertext and names that tell it nothing. It is generic: any provider that speaks the S3 API will do (Tigris, Cloudflare R2, Backblaze B2, MinIO, AWS S3), and it is off unless you configure it.

> **Losing the key means losing the backups.** Everything in the bucket is encrypted with `TABULA_BACKUP_KEY`. Without that key (and, after a key change, the older keys that sealed older backups) the backups **cannot be read by anyone, including us**. There is no recovery and no reset. Keep a copy of the key somewhere that is not the server it protects, such as a password manager. On the hosted service, the operator holds the master copy of each workspace's key.

What is not in this feature yet: **restore** (a restore engine with a safety backup, staging and verification is the next piece of work, B3) and a **Backups tab in the admin dashboard** (B4). Today you can see that backups work (the status endpoint, the log, the audit log) and read what is in the bucket (see [Reading a backup](#reading-a-backup)); putting it back is manual. The engine has been tested against a faithful in-memory S3 that verifies every signature; it has **not** been run against a real provider yet, and a backup that has never been restored is not a backup. Do a restore drill before you rely on it.

## What is backed up

Everything below is relative to `DATA_DIR`.

| What | How it is read | Backed up |
| --- | --- | --- |
| `directory.sqlite` | `VACUUM INTO` a temporary file next to it, taken while the server runs; the temporary file is deleted afterwards, also on an error | yes (accounts mode; in open mode only if the file exists) |
| `<boardId>.yjs` and `<boardId>~comments.yjs` | a room that is **open** is taken from the server's memory (everything typed so far, including what is not saved yet); any other room from its file | yes |
| `history/<boardId>/index.json` and the version files it lists | `index.json` is read first, then only the versions it lists that still exist; the stored index lists exactly the versions that were stored | yes |
| `*.tmp`, `directory.sqlite-wal`, `directory.sqlite-shm` | working files | no |
| `outbox.jsonl` | the mail outbox of `TABULA_MAIL=file` (sign-in links) | no |
| `history/<boardId>/index.json.corrupt-*`, version files the index does not list | set-aside and unreferenced files (the history sweep removes the latter) | no |
| anything else, links, and files whose names do not fit the patterns above | not Tabula's | no |

This is everything the server writes into `DATA_DIR`. Images and other uploads are **not** separate files: they are embedded in the board documents (`.yjs`), so they are backed up with the board. There is no upload directory.

In the database copy the engine leaves out its own traces (the `backup.status` setting and the `backup.run` and `backup.failed` audit rows) and fixes the SQLite file change counter. Without that, every run would change the database it is about to copy, and no run would ever be "nothing changed". A restored database therefore has no backup status and no backup audit rows.

## Turning it on

Backups are on when the five required variables are set. Some but not all of them is a startup error naming the missing ones; a malformed value is a startup error that names the variable and never prints the value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_BACKUP_S3_ENDPOINT` | required | The S3 endpoint, for example `https://fly.storage.tigris.dev` or `https://<account>.r2.cloudflarestorage.com`. `https://`, or `http://` for `localhost`, `127.0.0.1` and `[::1]` only. A bare address: no credentials, path, query or fragment |
| `TABULA_BACKUP_BUCKET` | required | The bucket (3 to 63 lower case letters, digits, dots, hyphens) |
| `TABULA_BACKUP_ACCESS_KEY` | required | Access key id |
| `TABULA_BACKUP_SECRET_KEY` | required | Secret access key |
| `TABULA_BACKUP_KEY` | required | The encryption key: 32 random bytes as 64 hex characters or as base64. Make one with `openssl rand -hex 32` |
| `TABULA_BACKUP_KEY_PREVIOUS` | none | Older keys, comma separated, for **reading** backups sealed before a key change. Writing always uses `TABULA_BACKUP_KEY` |
| `TABULA_BACKUP_PREFIX` | `tabula` | Everything is stored under this prefix, so several workspaces can share a bucket. Letters, digits, `. - _` and `/` between them |
| `TABULA_BACKUP_REGION` | `auto` | The signing region. `auto` is right for Tigris and R2; AWS needs the bucket's region |
| `TABULA_BACKUP_PATH_STYLE` | `on` | `on`: `https://endpoint/bucket/key`. `off`: `https://bucket.endpoint/key` (needs a DNS name, not an IP address) |
| `TABULA_BACKUP_INTERVAL_MINUTES` | `60` | Time between runs, 5 to 10080 |
| `TABULA_BACKUP_KEEP_HOURLY_HOURS` | `48` | Keep the newest backup of every hour for this long. `0`: no hourly points |
| `TABULA_BACKUP_KEEP_DAILY_DAYS` | `30` | Keep the newest backup of every day (UTC) for this long. `0`: no daily points |

The old `MIRA_BACKUP_*` spelling works with the usual deprecation warning. Two examples of retention: an hourly backup with 48 hours of hourly points and 30 days of daily points is the default; a once-a-day backup that keeps a week is `TABULA_BACKUP_INTERVAL_MINUTES=1440 TABULA_BACKUP_KEEP_HOURLY_HOURS=0 TABULA_BACKUP_KEEP_DAILY_DAYS=7`. The newest backup is always kept, whatever these say.

Give the credentials the least they need on that bucket (or prefix): put, get, head, delete and list. The key and the secret key are never written to the log, the status, the audit log or an error message.

## When it runs

The first run starts a random one to five minutes after the server starts (so a restart loop does not hit the bucket every few seconds), then another one interval after each run ends. A run never overlaps another: a tick that arrives during a run is skipped. A failed run is tried again at the next interval; nothing a backup does can stop the relay or slow a board, with one exception: copying the database is a synchronous SQLite call that holds the server for as long as it takes to copy it (milliseconds for a directory of a few MB).

One run:

1. Copies the database and reads the rooms and history as above, one file at a time. Each file is read once, hashed, and (if needed) uploaded from that same buffer.
2. Compares with the newest manifest. A file whose content is already in the bucket is not uploaded again; after a restart the engine first asks (HEAD) whether each such object is still there, once.
3. Uploads the new objects, then checks that each of them is in the bucket with the right size.
4. If nothing changed since the newest manifest, writes no new manifest and records the success. Otherwise writes the manifest **last**, reads it back, decrypts it and compares it with what it wrote. A manifest that does not read back is deleted and the run fails.
5. Prunes: the manifests the retention settings no longer keep, then objects no kept manifest refers to **and** that are more than an hour old. If any kept manifest cannot be read (damaged, or sealed with a key that is not configured), no object is deleted that time and the status says so.

A crash or a failure before step 4 leaves unreferenced objects in the bucket but no manifest, so the half-finished backup is invisible, and the next run's cleanup removes the objects once they are an hour old.

## How it is encrypted

One page, because you should be able to check it.

- **Keys.** From the master key `K` (32 bytes) three values are derived with HKDF-SHA256 (empty salt): `encKey` (info `tabula-backup/enc/v1`), `nameKey` (`tabula-backup/name/v1`) and the **key id** (the first 4 bytes of the derivation with info `tabula-backup/keyid/v1`, shown as 8 hex characters). The key id says which key sealed a file and tells nothing about the key.
- **Object names.** A file is stored as `<prefix>/objects/<objectId>`, where `objectId = hex(HMAC-SHA256(nameKey, file contents))`. The same contents get the same name (so unchanged files are stored once, across runs and across paths), but the provider cannot compute the name of a file it guesses without `nameKey`, so it cannot confirm what a file contains.
- **Sealing.** Every object and every manifest is `version (1 byte, =1) | key id (4) | nonce (12, random) | AES-256-GCM ciphertext | tag (16)`. The additional authenticated data is the first five bytes followed by `obj:<objectId>` for an object or `manifest:<file name>` for a manifest. So a flipped bit, a truncated file, an object stored under another object's name, a manifest copied over another manifest and a changed key id all fail the integrity check. A reader also checks that the contents hash (with `nameKey`) to the object id.
- **Manifests.** `<prefix>/manifests/<UTC timestamp>.json.enc`, for example `20261008T193000Z.json.enc`, sealed as above. Inside: `{version: 1, keyId, createdAt, appVersion, files: [{path, size, objectId}], totals: {files, bytes}}`. Paths are relative to `DATA_DIR` and are only ever plain relative paths: no `..`, no leading `/`, no backslash, no drive letter, no empty or `.` segment. They are validated when written and again when read.
- **What the provider sees:** the number and sizes of objects (plus 33 bytes each), the times of writes, and the fact that you back up on a schedule. Not paths, board names, counts of boards or any content.
- **Key change.** Set the new key as `TABULA_BACKUP_KEY` and put the old one in `TABULA_BACKUP_KEY_PREVIOUS`. The reader picks the key from the key id in each file; a key id it has no key for is a clear error (`unknown_key`). A new key has a new `nameKey`, so every object gets a new name: **the first run after a key change uploads everything again**. The old objects are removed by the normal cleanup once the manifests that refer to them age out of the retention window. Keep the old key in `TABULA_BACKUP_KEY_PREVIOUS` until then; while a kept manifest cannot be read, object cleanup is skipped (and the old manifests still age out and are deleted).

## Reading a backup

You do not need Tabula to read one. Download a manifest and the objects it names with any S3 tool, then decrypt with Node and your key:

```js
// usage: TABULA_BACKUP_KEY=<key> node decrypt.mjs <downloaded file> <obj:OBJECTID | manifest:FILENAME> > plaintext
import crypto from 'node:crypto';
import fs from 'node:fs';

const [file, name] = process.argv.slice(2);
const raw = process.env.TABULA_BACKUP_KEY.trim();
const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), info, 32));

const sealed = fs.readFileSync(file);
const header = sealed.subarray(0, 5); // version 1, then the key id
const decipher = crypto.createDecipheriv('aes-256-gcm', derive('tabula-backup/enc/v1'), sealed.subarray(5, 17));
decipher.setAAD(Buffer.concat([header, Buffer.from(name)]));
decipher.setAuthTag(sealed.subarray(sealed.length - 16));
process.stdout.write(Buffer.concat([decipher.update(sealed.subarray(17, sealed.length - 16)), decipher.final()]));
```

Decrypt the newest manifest (`manifest:20261008T193000Z.json.enc`), read its `files`, decrypt each object (`obj:<objectId>`) and write it to its `path` under an empty data directory. `directory.sqlite` is a complete SQLite database. That is a manual restore, which has not been drilled; the restore engine will do the same with a safety backup and verification.

In code, the engine exposes the read side that restore will use (`createBackup(...)` in `server/backup.mjs`): `listManifests()` (newest first), `readManifest(name)` (verified, decrypted, paths validated) and `readObject(objectId)` (verified twice: the GCM tag and the keyed hash of the contents). They throw a `BackupError` with a stable `code`: `bad_format`, `unknown_key`, `tamper` (a flipped bit, a truncated file, or an object or manifest under another name look the same to GCM), `content_mismatch`, `invalid_manifest`, `invalid_path`, `not_found`, `s3`, `network`, `timeout`, `too_large`, `readback`.

## Status

In a hosted workspace (see [cloud.md](cloud.md)) the control plane reads the status with the bearer token:

```
GET /api/internal/backup-status
  -> { enabled: false }                                    backups are off
  -> { enabled: true, running, keyId, intervalMinutes,
       lastRunAt, lastSuccessAt, lastError,
       lastFailureAt, lastFailureError, consecutiveFailures,
       lastManifest, bytesStored, objects, manifests, nextRunAt, prune }
```

Times are milliseconds since the epoch (UTC) or `null`.

- `lastRunAt` is when the latest run started, `lastSuccessAt` when the latest successful run ended. A run that finds nothing changed is a success. `lastError` is the error of the latest run (`null` after a success); `lastFailureAt` and `lastFailureError` are the latest failure ever and stay after a later success; `consecutiveFailures` counts failed runs since the last success. Errors are short and contain a status and an S3 error code at most, never a header, a URL, a key or a file's contents. A stopped run (shutdown) is not a failure.
- `lastManifest` is the newest manifest; `bytesStored` is the stored (encrypted) size of the objects it refers to, counting a shared object once; `manifests` is how many manifests are kept and `objects` how many objects the bucket holds under the prefix after the last cleanup.
- `prune` is `{at, manifestsDeleted, objectsDeleted, gcSkipped, error}` for the latest cleanup. `gcSkipped` is `unreadable_manifest` or `inconsistent_listing` when objects were deliberately not deleted. A cleanup that fails (`error`) does not fail the backup.
- `nextRunAt` is the scheduled time of the next run, `null` while a scheduled run is in progress or when stopped; `running` is true during any run.

A sensible alert: `lastSuccessAt` older than three intervals, or `consecutiveFailures` of two or more. The status is kept in the directory's `settings` table (`backup.status`), so it survives a restart. In open mode (no directory) it lives in memory and there is no endpoint.

Each successful run writes an audit row `backup.run` (no actor; only counts: `changed`, `files`, `uploaded`, `bytes`, `skipped`, `manifestsDeleted`, `objectsDeleted`) and each failed run `backup.failed` (the short error). At an hourly interval that is 24 rows a day.

## Limits and caveats

- **256 MB per file.** A bigger file fails the run with a clear error that names the file. Files are read whole into memory, so a run needs memory for a few times the largest file; streaming is later work.
- **Skew.** The database is copied first and the rooms a few seconds later, so a board created or renamed in between can be in one and not yet in the other. A room that has never been saved has no file and is in the next run.
- **History.** A version added after a board's index was read is in the next run. A version the index lists but whose file is gone is left out, and the stored index leaves it out too.
- **A board history index that cannot be read** (the server sets such a file aside on its own) leaves that board's history out of the run; the run still succeeds and counts it as skipped.
- **Redirects are not followed** and a request times out after 10 seconds; 5xx, 429 and network errors are retried up to three times with a growing wait, other 4xx never. Check the endpoint and region if you see a redirect error.
- **Providers.** Path style is the default because it works almost everywhere; some providers want virtual hosted style (`TABULA_BACKUP_PATH_STYLE=off`). Only the plain S3 API is used (PUT, GET, HEAD, DELETE, ListObjectsV2).
- **One instance per prefix.** Two servers backing up to the same prefix would compare against each other's manifests; the one hour grace on cleanup only protects an upload that is in progress.
- **The bucket is not locked.** Someone who can delete in the bucket can delete backups. Use credentials, versioning or object lock on the provider side if that is a concern; the engine itself deletes only what the retention rules say.
