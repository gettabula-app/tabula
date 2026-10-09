// Restore (docs/backups.md, Restoring). Two operations on top of the backup engine (server/backup.mjs):
//
//   restoreBoardCopy   one board of a backup becomes a NEW board in the live workspace. No downtime, nothing live is touched.
//   restoreWorkspace   the whole data directory is replaced by a backup. The old data is moved aside, never deleted.
//
// A whole restore is a sequence in which nothing live changes until everything has been checked:
//
//   1. safety backup (the live state, protected from pruning for 7 days), 2. download every file into DATA_DIR/.restore-<id>/
//   and verify it three ways, 3. open the staged database and parse every document, 4. prepare the staged database
//   (sessions gone, credentials revoked, status rows written), 5. maintenance mode, 6. a journal (restore.json), then
//   renames only: live files into DATA_DIR/.pre-restore-<ms>/, staged files into place, 7. exit with code 75 so the
//   supervisor starts the server again on the restored data.
//
// recoverOnStart() runs before the database is opened and finishes or undoes a swap that was interrupted, from the journal
// alone. Every branch of it can be run again after a crash of its own. Nothing here logs, stores or returns a key, an
// object id, a signed URL or the contents of a file: errors name a file by its position ("file 3 of 12") and a code.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { BackupError, PROTECTED_KEY, assetHashOf, createScrubber, isBackupPath, parseManifestName, parseProtections, validateRelPath } from './backup.mjs';
import { newObjectId } from './board-ops.mjs';
import { canRead, readSchemaState } from './schema.mjs';

const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The exit code of a restart that is meant: provisioning sets the restart policy to on-failure, so 0 would leave the machine stopped. */
export const EXIT_CODE = 75;
/** What the owner types to confirm a whole restore. */
export const CONFIRM_WORD = 'RESTORE';
export const OLD_DATA_DAYS = 7;
export const PROTECT_DAYS = 7;
const OLD_DATA_MS = OLD_DATA_DAYS * DAY_MS;
const OLD_DATA_MIN_MS = DAY_MS;
const PROTECT_MS = PROTECT_DAYS * DAY_MS;
const WORKSPACE_INTERVAL_MS = 10 * MINUTE_MS;
const BOARD_WINDOW_MS = 10 * MINUTE_MS;
const BOARD_MAX_PER_WINDOW = 10;
const BOARDS_LIST_WINDOW_MS = MINUTE_MS;
const BOARDS_LIST_MAX_PER_WINDOW = 20;
export const BOARDS_LISTED_MAX = 500;
const TEAM_NAME_MAX = 80;
const SPACE_MARGIN_BYTES = 64 * MIB;
const FULL_RATIO = 0.8;
const EXIT_GRACE_MS = 5000;
const SAFETY_WAIT_MS = 2000;
const SAFETY_WAIT_TRIES = 60;
const MAX_LISTED = 200;
const LIST_PARALLEL = 4;
const TITLE_MAX = 200;
const SWEEP_FIRST_MS = MINUTE_MS;
const SWEEP_EVERY_MS = HOUR_MS;
const ERROR_MAX = 200;

export const STATUS_KEY = 'restore.status';
export const KEEP_KEY = 'restore.keep';
const CARRIED_SETTINGS = ['cloud.limits', 'cloud.trialEndingNotified'];

const JOURNAL = 'restore.json';
const JOURNAL_VERSION = 1;
const PHASES = ['swapping', 'moved-old', 'rolling-back', 'moved-new', 'done', 'rolled-back'];
const JOURNAL_TMP_RE = /^restore\.json\.tmp-[0-9a-f]{16}$/;
const STAGING_RE = /^\.restore-[0-9a-f]{16}$/;
const PRE_RE = /^\.pre-restore-(\d{10,16})$/;
const ID_RE = /^[0-9a-f]{16}$/;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROOM_FILE_RE = /^[A-Za-z0-9_-]{1,64}(?:~comments)?\.yjs$/;
// chat.sqlite (docs/chat.md) is swapped with the directory: a restore brings back the conversation of its backup, and a
// backup made before chat existed leaves none behind.
const DB_FILES = ['directory.sqlite', 'directory.sqlite-wal', 'directory.sqlite-shm', 'chat.sqlite', 'chat.sqlite-wal', 'chat.sqlite-shm'];
const ERRNO_RE = /^[A-Z0-9_]{2,40}$/;
const NEWEST_SCHEMA_HINT = 'Update Tabula first, then restore.';

/** HTTP status of each error code (api.mjs). */
export const RESTORE_STATUS = Object.freeze({
  bad_request: 400,
  confirmation_mismatch: 400,
  forbidden: 403,
  manifest_not_found: 404,
  board_not_in_backup: 404,
  backups_off: 409,
  restore_in_progress: 409,
  read_only: 402,
  rate_limited: 429,
  safety_backup_failed: 502,
  s3: 502,
  network: 502,
  timeout: 502,
  too_large: 502,
  not_enough_space: 507,
  space_unknown: 507,
  bad_format: 422,
  unknown_key: 422,
  tamper: 422,
  content_mismatch: 422,
  invalid_manifest: 422,
  invalid_path: 422,
  unexpected_file: 422,
  duplicate_path: 422,
  size_mismatch: 422,
  no_directory: 422,
  invalid_backup: 422,
  backup_incomplete: 422,
  schema_too_new: 422,
  integrity_check_failed: 422,
  no_active_owner: 422,
  restore_failed: 500,
});

/**
 * A restore operation was refused or failed. `code` is stable and meant for callers (see RESTORE_STATUS); `extra` holds
 * plain facts that are safe to show (needed and free bytes, a retry delay). The message never holds a secret.
 */
export class RestoreError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
    this.extra = extra;
  }
}

/** Thrown by a test's crash hook to stop the process "at that instant": the code under test must not clean up after it. */
export class SimulatedCrash extends Error {
  /** @param {string} point */
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
    this.point = point;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const noop = () => {};

// ---------------------------------------------------------------- file system helpers

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

const isRealDirectory = (file) => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

/** A directory entry cannot always be flushed (Windows, some file systems): only a real I/O error is an error. */
export function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EACCES', 'EBADF', 'ENOENT'].includes(err?.code)) throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** `wx` by default: an existing file (or a link) is never written through. */
export function writeFileDurable(file, data, flag = 'wx') {
  const fd = fs.openSync(file, flag, 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const removeTree = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function removeSqliteFiles(file) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
}

// ---------------------------------------------------------------- the journal

/**
 * @typedef {object} Journal
 * @property {number} version
 * @property {string} id
 * @property {'swapping' | 'moved-old' | 'rolling-back' | 'moved-new' | 'done' | 'rolled-back'} phase
 * @property {string} manifest
 * @property {string} stagingDir
 * @property {string} oldDir
 * @property {string[]} files entries moved in from the staging directory
 * @property {string[]} oldFiles entries moved out into oldDir
 * @property {number} startedAt
 * @property {string} [error] why the swap was undone (a code)
 */

// the two directories the swap moves whole: version history and image files
const SWAP_DIRS = ['history', 'assets'];
const isSwapEntry = (name) => typeof name === 'string' && (DB_FILES.includes(name) || ROOM_FILE_RE.test(name) || SWAP_DIRS.includes(name));

function parseJournal(text) {
  const bad = () => new RestoreError('restore_failed', 'The restore journal (restore.json) is not valid, so the server will not start. Do not delete anything: see docs/backups.md, Restoring.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw bad();
  }
  const entries = (list) => Array.isArray(list) && list.length <= 2_000_000 && list.every(isSwapEntry) && new Set(list).size === list.length;
  if (
    !isObject(data) ||
    data.version !== JOURNAL_VERSION ||
    !PHASES.includes(data.phase) ||
    typeof data.id !== 'string' || !ID_RE.test(data.id) ||
    typeof data.manifest !== 'string' || parseManifestName(data.manifest) === null ||
    typeof data.stagingDir !== 'string' || !STAGING_RE.test(data.stagingDir) ||
    typeof data.oldDir !== 'string' || !PRE_RE.test(data.oldDir) ||
    !entries(data.files) || !entries(data.oldFiles) ||
    !Number.isFinite(data.startedAt)
  ) {
    throw bad();
  }
  return {
    version: JOURNAL_VERSION,
    id: data.id,
    phase: data.phase,
    manifest: data.manifest,
    stagingDir: data.stagingDir,
    oldDir: data.oldDir,
    files: data.files,
    oldFiles: data.oldFiles,
    startedAt: data.startedAt,
    ...(typeof data.error === 'string' && /^[a-z_]{1,40}$/.test(data.error) ? { error: data.error } : {}),
  };
}

/** @returns {Journal | null} */
function readJournal(dataDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dataDir, JOURNAL), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new RestoreError('restore_failed', 'The restore journal (restore.json) cannot be read, so the server will not start. Do not delete anything: see docs/backups.md, Restoring.');
  }
  return parseJournal(text);
}

/** Atomic and durable: written next to the journal, flushed, renamed over it, and the directory flushed. */
function writeJournal(dataDir, journal, step) {
  const tmp = path.join(dataDir, `${JOURNAL}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  writeFileDurable(tmp, JSON.stringify(journal));
  step('journal-tmp-written');
  fs.renameSync(tmp, path.join(dataDir, JOURNAL));
  fsyncDir(dataDir);
  step(`journal-${journal.phase}`);
}

function dropJournal(dataDir, step) {
  fs.rmSync(path.join(dataDir, JOURNAL), { force: true });
  fsyncDir(dataDir);
  step('journal-removed');
}

// ---------------------------------------------------------------- the swap and its recovery

/**
 * @typedef {object} RecoveryContext
 * @property {string} dataDir
 * @property {(message: string) => void} log
 * @property {(point: string) => void} step called at every boundary; a test throws SimulatedCrash from it
 * @property {string} [reason] the error code recorded when the swap is undone
 */

function setPhase(ctx, journal, phase, extra = {}) {
  const next = { ...journal, ...extra, phase };
  writeJournal(ctx.dataDir, next, ctx.step);
  return next;
}

/** The live files move back out of oldDir. Idempotent: what is already back is skipped. */
function moveOldBack(ctx, journal) {
  const old = path.join(ctx.dataDir, journal.oldDir);
  for (const name of journal.oldFiles) {
    const from = path.join(old, name);
    if (!exists(from)) continue;
    const to = path.join(ctx.dataDir, name);
    if (exists(to)) throw new RestoreError('restore_failed', 'The restore cannot be undone because a file is in the way. Do not delete anything: see docs/backups.md, Restoring.');
    fs.renameSync(from, to);
    ctx.step('recover-old-back');
  }
  fsyncDir(ctx.dataDir);
}

/** Whatever of the new data is in place goes back to the staging directory. Only called when every old file is out of the way. */
function moveNewOut(ctx, journal) {
  const staging = path.join(ctx.dataDir, journal.stagingDir);
  for (const name of journal.files) {
    const from = path.join(ctx.dataDir, name);
    if (!exists(from)) continue;
    fs.mkdirSync(staging, { recursive: true });
    const to = path.join(staging, name);
    if (exists(to)) throw new RestoreError('restore_failed', 'The restore cannot be undone because a file is in the way. Do not delete anything: see docs/backups.md, Restoring.');
    fs.renameSync(from, to);
    ctx.step('recover-new-out');
  }
  fsyncDir(ctx.dataDir);
}

function newIsInPlace(ctx, journal) {
  const staging = path.join(ctx.dataDir, journal.stagingDir);
  return journal.files.every((name) => exists(path.join(ctx.dataDir, name)) && !exists(path.join(staging, name)));
}

function tidyAfterRollback(ctx, journal) {
  removeTree(path.join(ctx.dataDir, journal.stagingDir));
  try {
    fs.rmdirSync(path.join(ctx.dataDir, journal.oldDir));
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTEMPTY') throw err;
  }
  fsyncDir(ctx.dataDir);
  ctx.step('recover-tidied');
}

/**
 * Brings an interrupted or finished swap to a rest, from the journal alone. The data directory ends up either wholly
 * old or wholly new, never mixed: the phase says which files can be where, and each move checks before it renames, so a
 * crash inside this function is recovered by running it again.
 *
 *   swapping      no new file has moved: the old files go back                        -> rolled-back
 *   moved-old     every old file is out of the way. All new files in place: forward.  -> moved-new
 *                 Otherwise the new files go out again                                -> rolling-back
 *   rolling-back  the old files go back                                               -> rolled-back
 *   moved-new     the staging directory is removed                                    -> done
 *   done          the journal is deleted
 *   rolled-back   stays until start() has recorded the failure in the database
 *
 * @param {RecoveryContext} ctx
 * @returns {{ action: 'none' | 'completed' | 'rolled-back', manifest?: string, error?: string, forward?: boolean }}
 */
function recoverJournal(ctx) {
  let journal = readJournal(ctx.dataDir);
  if (!journal) return { action: 'none' };
  let forward = false;
  for (let guard = 0; guard < 16; guard++) {
    switch (journal.phase) {
      case 'swapping':
        ctx.log(`restore: an interrupted restore is being undone (the old files go back)`);
        moveOldBack(ctx, journal);
        journal = setPhase(ctx, journal, 'rolled-back', { error: ctx.reason ?? journal.error ?? 'interrupted' });
        tidyAfterRollback(ctx, journal);
        break;
      case 'moved-old':
        if (newIsInPlace(ctx, journal)) {
          ctx.log('restore: an interrupted restore is being finished (the new files are all in place)');
          journal = setPhase(ctx, journal, 'moved-new');
        } else {
          ctx.log('restore: an interrupted restore is being undone (the new files go out, the old files go back)');
          moveNewOut(ctx, journal);
          journal = setPhase(ctx, journal, 'rolling-back', { error: ctx.reason ?? journal.error ?? 'interrupted' });
        }
        break;
      case 'rolling-back':
        moveOldBack(ctx, journal);
        journal = setPhase(ctx, journal, 'rolled-back', { error: ctx.reason ?? journal.error ?? 'interrupted' });
        tidyAfterRollback(ctx, journal);
        break;
      case 'moved-new':
        forward = true;
        removeTree(path.join(ctx.dataDir, journal.stagingDir));
        fsyncDir(ctx.dataDir);
        ctx.step('staging-removed');
        journal = setPhase(ctx, journal, 'done');
        break;
      case 'done':
        dropJournal(ctx.dataDir, ctx.step);
        return { action: 'completed', manifest: journal.manifest, forward };
      case 'rolled-back':
        return { action: 'rolled-back', manifest: journal.manifest, error: journal.error ?? 'interrupted' };
      default:
        throw new RestoreError('restore_failed', 'The restore journal has an unknown phase');
    }
  }
  throw new RestoreError('restore_failed', 'The restore did not come to a rest');
}

/** The staging directories of crashed attempts (by name only) and the journal's leftover temporary files. */
function removeLeftovers(dataDir, log) {
  let removed = 0;
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (STAGING_RE.test(entry.name) && isRealDirectory(path.join(dataDir, entry.name))) {
      removeTree(path.join(dataDir, entry.name));
      removed++;
    } else if (JOURNAL_TMP_RE.test(entry.name) && entry.isFile()) {
      fs.rmSync(path.join(dataDir, entry.name), { force: true });
    }
  }
  if (removed) log(`restore: removed ${removed} staging director${removed === 1 ? 'y' : 'ies'} left by an interrupted attempt`);
}

/**
 * Whether a restore is still in the middle of something: a journal in any phase but `rolled-back`, or a staging
 * directory. After recoverOnStart this is a check, not a repair (server/volume.mjs asks before adopting a volume): the
 * only journal it leaves is a `rolled-back` one, which is settled (the old data is back) and waits for the restore
 * engine to record the failure. A journal that cannot be read counts as pending.
 * @param {string} dataDir
 */
export function restorePending(dataDir) {
  let journal;
  try {
    journal = readJournal(dataDir);
  } catch {
    return true;
  }
  if (journal && journal.phase !== 'rolled-back') return true;
  return fs.readdirSync(dataDir).some((name) => STAGING_RE.test(name) || JOURNAL_TMP_RE.test(name));
}

/**
 * Runs before the database is opened (and in any mode): finishes or undoes an interrupted restore, then removes the
 * staging directories of crashed attempts. Throws a RestoreError when the journal cannot be trusted; the relay then
 * refuses to start rather than guess. Safe to run again after a crash of its own.
 * @param {{ dataDir: string, log?: (message: string) => void, step?: (point: string) => void }} options
 */
export function recoverOnStart({ dataDir, log = noop, step = noop }) {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) return { action: 'none' };
  for (const entry of fs.readdirSync(dataDir)) {
    if (JOURNAL_TMP_RE.test(entry)) fs.rmSync(path.join(dataDir, entry), { force: true });
  }
  const result = recoverJournal({ dataDir, log, step });
  if (result.action === 'completed') log(`restore: ${result.forward ? 'finished' : 'completed'} a restore; the server runs on the restored data`);
  if (result.action === 'rolled-back') log(`restore: the last restore was undone (${result.error}); the server runs on the data it had before`);
  removeLeftovers(dataDir, log);
  return result;
}

// ---------------------------------------------------------------- the engine

/**
 * @typedef {object} RestoreHooks what the relay supplies
 * @property {() => void | Promise<void>} [enterMaintenance] answer 503 from now on, close every socket with the restoring code, save every open room and then stop saving them, stop the timers that use the database
 * @property {() => void | Promise<void>} [closeDirectory] close the database (default: directory.close())
 */

/**
 * @typedef {object} RestoreOptions
 * @property {any} backup the backup engine (createBackup); restore is off (null) without it
 * @property {any} directory the directory (accounts mode); restore is off (null) without it
 * @property {{ secrets?: string[] } | null} [config] the backup configuration, used only to scrub log lines
 * @property {string} dataDir
 * @property {RestoreHooks} [hooks]
 * @property {(code: number) => void} [exit] leaves the process (default process.exit)
 * @property {(message: string) => void} [log]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(dir: string) => Promise<{ bsize: number | bigint, blocks: number | bigint, bavail: number | bigint }>} [statfs]
 * @property {(point: string) => void} [crashAt] tests only: called at every boundary of the swap
 * @property {any} [setTimeout]
 * @property {any} [clearTimeout]
 * @property {number} [exitDelayMs] how long to wait after the response before leaving (tests of the relay)
 * @property {number} [boardsListedMax] tests only: how many boards one backup's list holds (BOARDS_LISTED_MAX)
 */

/**
 * @typedef {object} Actor
 * @property {string} id
 */

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statfsReal = (dir) => fs.promises.statfs(dir);
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function fromBackupError(err, where = '') {
  if (!(err instanceof BackupError)) return err;
  if (err.code === 'not_found') {
    return where
      ? new RestoreError('backup_incomplete', `A file of the backup is missing from the bucket${where}`)
      : new RestoreError('manifest_not_found', 'That backup is not in the bucket');
  }
  if (err.code === 'unknown_key') {
    return new RestoreError('unknown_key', `This backup was sealed with a key this server does not have. Add the old key to TABULA_BACKUP_KEY_PREVIOUS and restart${where}`);
  }
  return new RestoreError(err.code, `${err.message}${where}`);
}

/**
 * @param {RestoreOptions} options
 */
export function createRestore({
  backup,
  directory,
  config = null,
  dataDir,
  hooks = {},
  exit = (code) => process.exit(code),
  log = (...args) => console.error(...args),
  now = Date.now,
  sleep = sleepReal,
  statfs = statfsReal,
  crashAt = noop,
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  exitDelayMs = 0,
  boardsListedMax = BOARDS_LISTED_MAX,
}) {
  if (!backup || !directory) return null;

  const scrub = createScrubber(config?.secrets ?? []);
  const say = (message) => {
    try {
      log(`restore: ${scrub(message)}`);
    } catch {
      /* a broken logger must not break a restore */
    }
  };
  /** The code of an error, or its short safe message: never an fs message (it holds a path) or an unknown error's text. */
  const describe = (err) => {
    if (err instanceof RestoreError) return err.code;
    if (err instanceof BackupError) return err.code;
    const code = typeof err?.code === 'string' && ERRNO_RE.test(err.code) ? err.code : null;
    return code ?? 'restore_failed';
  };
  const keepOldWords = (mode) => (mode === 'next-backup' ? 'until the next successful backup (at least 24 h)' : '7 days');
  const step = (point) => crashAt(point);
  const stepCtx = (extra = {}) => ({ dataDir, log: say, step, ...extra });

  let busy = /** @type {null | 'workspace' | 'board'} */ (null);
  let maintenance = false;
  let lastWholeAt = -Infinity;
  let boardStarts = /** @type {number[]} */ ([]);
  const boardListStarts = /** @type {Map<string, number[]>} */ (new Map());
  let sweepTimer = null;
  let sweeping = false;
  let stopped = false;

  // ------------------------------------------------------------ small pieces

  const audit = (actor, action, detail) => {
    try {
      directory.audit(actor?.id ?? null, action, detail);
    } catch (err) {
      say(`could not write the audit row ${action} (${describe(err)})`);
    }
  };

  /** A stored restore record, cut down to the fields that are shown: codes, counts, times and names, never anything else. */
  function cleanRecord(value) {
    if (!isObject(value)) return null;
    const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined);
    return {
      kind: value.kind === 'board' ? 'board' : 'workspace',
      result: value.result === 'done' ? 'done' : 'failed',
      at: count(value.at) ?? null,
      manifest: typeof value.manifest === 'string' && parseManifestName(value.manifest) !== null ? value.manifest : null,
      ...(typeof value.error === 'string' && /^[A-Za-z_]{1,40}$/.test(value.error) ? { error: value.error } : {}),
      ...(count(value.files) !== undefined ? { files: count(value.files) } : {}),
      ...(count(value.bytes) !== undefined ? { bytes: count(value.bytes) } : {}),
      ...(count(value.boards) !== undefined ? { boards: count(value.boards) } : {}),
      ...(value.keepOldFor === keepOldWords('days') || value.keepOldFor === keepOldWords('next-backup') ? { keepOldFor: value.keepOldFor } : {}),
    };
  }

  function readLast() {
    try {
      return cleanRecord(JSON.parse(directory.getSetting(STATUS_KEY) ?? 'null'));
    } catch {
      return null;
    }
  }

  let last = readLast();

  function setLast(record) {
    last = record;
    try {
      directory.setSetting(STATUS_KEY, JSON.stringify(record));
    } catch (err) {
      say(`could not store the restore status (${describe(err)})`);
    }
  }

  function readKeep() {
    try {
      const value = JSON.parse(directory.getSetting(KEEP_KEY) ?? 'null');
      if (!isObject(value)) return {};
      const keep = {};
      for (const [name, info] of Object.entries(value)) {
        if (PRE_RE.test(name) && isObject(info) && (info.mode === 'days' || info.mode === 'next-backup')) keep[name] = { at: Number(info.at) || 0, mode: info.mode };
      }
      return keep;
    } catch {
      return {};
    }
  }

  async function volume() {
    let stat;
    try {
      stat = await statfs(dataDir);
    } catch {
      throw new RestoreError('space_unknown', 'The free disk space could not be determined, so nothing was changed');
    }
    const bsize = Number(stat?.bsize);
    const blocks = Number(stat?.blocks);
    const bavail = Number(stat?.bavail);
    if (![bsize, blocks, bavail].every((n) => Number.isFinite(n) && n >= 0) || bsize === 0 || blocks === 0) {
      throw new RestoreError('space_unknown', 'The free disk space could not be determined, so nothing was changed');
    }
    return { free: bavail * bsize, size: blocks * bsize, used: (blocks - bavail) * bsize };
  }

  /** Keeping the old data costs no extra space (the swap only renames), but it stops the old space being freed. */
  function decideRetention(vol, pendingBytes) {
    const ratio = (vol.used + pendingBytes) / vol.size;
    if (ratio > FULL_RATIO) {
      const percent = Math.min(100, Math.round(ratio * 100));
      return {
        mode: /** @type {'days' | 'next-backup'} */ ('next-backup'),
        keepOldFor: keepOldWords('next-backup'),
        reason: `The disk would be ${percent}% full with the old data kept, so it is kept only until the next successful backup after the restore, and at least 24 hours.`,
      };
    }
    return { mode: /** @type {'days' | 'next-backup'} */ ('days'), keepOldFor: keepOldWords('days'), reason: 'There is room on the disk, so the old data is kept for 7 days.' };
  }

  /** Writes the protection into the live database now; start() carries it into the restored one. */
  function protect(manifestName, nowMs) {
    let active = {};
    try {
      active = parseProtections(directory.getSetting(PROTECTED_KEY), nowMs).active;
    } catch {
      say('the list of protected backups was unreadable and is rewritten');
    }
    active[manifestName] = nowMs + PROTECT_MS;
    directory.setSetting(PROTECTED_KEY, JSON.stringify(active));
    return active;
  }

  function protections(nowMs) {
    try {
      return parseProtections(directory.getSetting(PROTECTED_KEY), nowMs).active;
    } catch {
      return {};
    }
  }

  async function readManifestChecked(name) {
    if (typeof name !== 'string' || parseManifestName(name) === null) throw new RestoreError('bad_request', 'manifest must be the name of a backup');
    try {
      return await backup.readManifest(name);
    } catch (err) {
      throw fromBackupError(err);
    }
  }

  /** What a manifest would put on disk, or why it must not be used. Needs no download. */
  function planFromManifest(manifest) {
    const total = manifest.files.length;
    const lower = new Set();
    const topLevel = new Set();
    let hasDirectory = false;
    let boards = 0;
    manifest.files.forEach((file, i) => {
      const position = `(file ${i + 1} of ${total})`;
      try {
        validateRelPath(file.path);
      } catch {
        throw new RestoreError('invalid_path', `The backup lists a path that is not a plain relative path ${position}`);
      }
      if (!isBackupPath(file.path)) throw new RestoreError('unexpected_file', `The backup lists a file Tabula does not write ${position}`);
      const key = file.path.toLowerCase();
      if (lower.has(key)) throw new RestoreError('duplicate_path', `The backup lists the same file twice ${position}`);
      lower.add(key);
      if (file.path === 'directory.sqlite') hasDirectory = true;
      else if (ROOM_FILE_RE.test(file.path) && !file.path.endsWith('~comments.yjs')) boards++;
      topLevel.add(file.path.startsWith('history/') ? 'history' : file.path.startsWith('assets/') ? 'assets' : file.path);
    });
    if (!hasDirectory) throw new RestoreError('no_directory', 'This backup has no workspace database (it was made without accounts), so it cannot be restored here');
    return { topLevel: [...topLevel].sort(), boards, files: total, bytes: manifest.totals.bytes };
  }

  async function mapLimit(items, limit, fn) {
    const out = Array.from({ length: items.length });
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i], i);
        }
      }),
    );
    return out;
  }

  // ------------------------------------------------------------ listing and preview

  const summaries = new Map();

  /**
   * The backups in the bucket, newest first (at most 200), each with what is in it. A backup that cannot be read (damaged,
   * or sealed with a key this server lacks) is listed with `readable: false` and the reason.
   */
  async function listBackups() {
    let listed;
    try {
      listed = await backup.listManifests();
    } catch (err) {
      const failure = fromBackupError(err);
      throw failure instanceof RestoreError ? failure : new RestoreError('restore_failed', 'The backups could not be listed');
    }
    const nowMs = now();
    const kept = protections(nowMs);
    const shown = listed.slice(0, MAX_LISTED);
    const rows = await mapLimit(shown, LIST_PARALLEL, async (item) => {
      const createdAt = parseManifestName(item.name);
      const base = { name: item.name, createdAt, protected: Object.hasOwn(kept, item.name), protectedUntil: kept[item.name] ?? null };
      let summary = summaries.get(item.name);
      if (!summary) {
        try {
          const manifest = await backup.readManifest(item.name);
          summary = { readable: true, files: manifest.totals.files, bytes: manifest.totals.bytes, keyId: manifest.keyId };
          summaries.set(item.name, summary);
          if (summaries.size > 500) summaries.delete(summaries.keys().next().value);
        } catch (err) {
          return { ...base, readable: false, error: err instanceof BackupError ? err.code : 'restore_failed' };
        }
      }
      return { ...base, ...summary };
    });
    return { backups: rows, truncated: listed.length > shown.length };
  }

  /** What restoring one backup would do, before anything is downloaded; the confirmation step shows it. */
  async function previewManifest(name) {
    const manifest = await readManifestChecked(name);
    const plan = planFromManifest(manifest);
    const vol = await volume();
    const retention = decideRetention(vol, plan.bytes);
    const needed = 2 * plan.bytes + SPACE_MARGIN_BYTES;
    return {
      name,
      createdAt: parseManifestName(name),
      appVersion: manifest.appVersion,
      keyId: manifest.keyId,
      files: plan.files,
      bytes: plan.bytes,
      boards: plan.boards,
      protected: Object.hasOwn(protections(now()), name),
      confirmWord: CONFIRM_WORD,
      keepOldFor: retention.keepOldFor,
      reason: retention.reason,
      space: { needed, free: vol.free, enough: vol.free >= needed },
    };
  }

  // ------------------------------------------------------------ download and verification

  /** Creates the staging directory and downloads, checks and writes every file of the plan into it. */
  async function stageFiles(manifest) {
    const dir = path.join(dataDir, `.restore-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    const root = path.resolve(dir);
    const realRoot = fs.realpathSync(dir);
    const made = new Set([dir]);
    try {
      const total = manifest.files.length;
      for (const [i, file] of manifest.files.entries()) {
        const where = ` (file ${i + 1} of ${total})`;
        const target = path.resolve(root, ...validateRelPath(file.path).split('/'));
        if (!target.startsWith(root + path.sep)) throw new RestoreError('invalid_path', `A path in the backup leads outside the staging directory${where}`);
        let data;
        try {
          data = await backup.readObject(file.objectId);
        } catch (err) {
          throw fromBackupError(err, where);
        }
        if (data.length !== file.size) throw new RestoreError('size_mismatch', `A file in the backup is not the size its manifest says${where}`);
        const parent = path.dirname(target);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const realParent = fs.realpathSync(parent);
        if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) throw new RestoreError('invalid_path', `A path in the backup leads outside the staging directory${where}`);
        for (let d = parent; d !== root && d.startsWith(root); d = path.dirname(d)) made.add(d);
        writeFileDurable(target, data);
        if (stopped) throw new RestoreError('restore_failed', 'The server is stopping');
      }
      for (const d of made) fsyncDir(d);
    } catch (err) {
      removeTree(dir);
      throw err;
    }
    return dir;
  }

  /** Opens the staged database read-only on a copy, runs the checks, and lets the app's own code open it (migrations included). */
  async function verifyDatabase(stagingDir) {
    const { MIGRATIONS, openDirectory } = await import('./directory.mjs');
    const { DatabaseSync } = await import('node:sqlite');
    const copy = path.join(stagingDir, 'verify.sqlite');
    fs.copyFileSync(path.join(stagingDir, 'directory.sqlite'), copy);
    try {
      let version;
      let schema;
      try {
        const db = new DatabaseSync(copy, { readOnly: true });
        try {
          const rows = db.prepare('PRAGMA integrity_check').all();
          if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new RestoreError('integrity_check_failed', 'The database in the backup failed its integrity check, so nothing was changed');
          version = Number(db.prepare('PRAGMA user_version').get().user_version);
          schema = readSchemaState(db);
        } finally {
          db.close();
        }
      } catch (err) {
        if (err instanceof RestoreError) throw err;
        throw new RestoreError('integrity_check_failed', 'The database in the backup cannot be read, so nothing was changed');
      }
      if (!Number.isInteger(version) || version < 1) throw new RestoreError('invalid_backup', 'The database in the backup is not a Tabula database');
      // newer than this build, but only when this build cannot read it (an expand-only newer build's database it can: docs/migrations.md)
      if (!canRead(schema, MIGRATIONS.length)) {
        throw new RestoreError('schema_too_new', `The database in the backup was written by a newer Tabula (schema ${version}, this one knows ${MIGRATIONS.length}). ${NEWEST_SCHEMA_HINT}`);
      }
      let counts;
      try {
        const opened = openDirectory(copy);
        try {
          const users = opened.listUsers();
          const owners = users.filter((u) => u.role === 'owner');
          if (owners.length > 0 && owners.every((u) => u.disabled)) {
            throw new RestoreError('no_active_owner', 'Every owner in the backup is disabled, so nobody could manage the workspace after a restore');
          }
          const stats = opened.adminStats();
          counts = { users: users.length, boards: stats.boards.total, teams: stats.teams.total };
        } finally {
          opened.close();
        }
      } catch (err) {
        if (err instanceof RestoreError) throw err;
        throw new RestoreError('invalid_backup', 'The database in the backup could not be opened by this version of Tabula, so nothing was changed');
      }
      return counts;
    } finally {
      removeSqliteFiles(copy);
    }
  }

  /** Every room is applied to a throwaway document and every history file read, so nothing unreadable goes live. */
  function verifyDocuments(stagingDir, manifest) {
    const total = manifest.files.length;
    for (const [i, file] of manifest.files.entries()) {
      if (file.path === 'directory.sqlite') continue;
      const where = ` (file ${i + 1} of ${total})`;
      if (file.path === 'chat.sqlite') continue; // verifyChat
      const bytes = fs.readFileSync(path.join(stagingDir, ...file.path.split('/')));
      try {
        if (assetHashOf(file.path) !== null) {
          // an image is named by the SHA-256 of its bytes
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== assetHashOf(file.path)) throw new Error('hash');
        } else if (ROOM_FILE_RE.test(file.path)) {
          applyToThrowaway(bytes);
        } else if (file.path.endsWith('/index.json')) {
          const index = JSON.parse(bytes.toString('utf8'));
          if (!isObject(index) || index.v !== 1 || !Array.isArray(index.versions)) throw new Error('shape');
        } else {
          applyToThrowaway(zlib.gunzipSync(bytes));
        }
      } catch {
        throw new RestoreError('invalid_backup', `A document in the backup cannot be read, so nothing was changed${where}`);
      }
    }
  }

  /** The chat database of a backup, when it has one: readable, intact and not from a newer Tabula. Checked on a copy. */
  async function verifyChat(stagingDir, manifest) {
    const index = manifest.files.findIndex((f) => f.path === 'chat.sqlite');
    if (index === -1) return;
    const where = ` (file ${index + 1} of ${manifest.files.length})`;
    const { DatabaseSync } = await import('node:sqlite');
    const { CHAT_MIGRATIONS } = await import('./chat.mjs');
    const file = path.join(stagingDir, 'chat.sqlite');
    const copy = path.join(stagingDir, 'verify-chat.sqlite');
    fs.copyFileSync(file, copy);
    try {
      let version;
      let schema;
      try {
        const db = new DatabaseSync(copy, { readOnly: true });
        try {
          const rows = db.prepare('PRAGMA integrity_check').all();
          if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('integrity');
          version = Number(db.prepare('PRAGMA user_version').get().user_version);
          schema = readSchemaState(db);
        } finally {
          db.close();
        }
      } catch {
        throw new RestoreError('integrity_check_failed', `The chat database in the backup failed its integrity check, so nothing was changed${where}`);
      }
      if (!Number.isInteger(version) || !canRead(schema, CHAT_MIGRATIONS.length)) {
        throw new RestoreError('schema_too_new', `The chat database in the backup was written by a newer Tabula. ${NEWEST_SCHEMA_HINT}`);
      }
    } finally {
      removeSqliteFiles(copy);
    }
  }

  function applyToThrowaway(bytes) {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, bytes);
    } finally {
      doc.destroy();
    }
  }

  // ------------------------------------------------------------ the staged database, made ready

  /**
   * Everything that must be true of the database the server wakes up with, written into the staged file now (so a swap
   * that is finished after a crash needs nothing more): nobody is signed in, no credential from the backup works, the
   * engine's own traces are gone, the hosted workspace's limits are the live ones, and the restore, the protection of the
   * safety backup and the retention of the old data are recorded.
   */
  async function prepareDatabase(stagingDir, info) {
    const { openDirectory } = await import('./directory.mjs');
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(stagingDir, 'directory.sqlite');
    openDirectory(file).close();
    const nowMs = now();
    const carried = {};
    for (const key of CARRIED_SETTINGS) carried[key] = directory.getSetting(key);
    const keep = {};
    for (const [name, entry] of Object.entries(readKeep())) if (isRealDirectory(path.join(dataDir, name))) keep[name] = entry;
    keep[info.oldDir] = { at: info.swapAt, mode: info.mode };
    const protectedNow = protections(nowMs);

    let removed;
    let record;
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
      const has = (table) => db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
      const count = (table) => (has(table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) : 0);
      const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
      db.exec('BEGIN IMMEDIATE');
      try {
        removed = {
          sessions: count('sessions'), loginTokens: count('login_tokens'),
          guestSessions: count('guest_sessions'), joinCodes: count('join_codes'),
        };
        db.exec('DELETE FROM sessions; DELETE FROM login_tokens');
        if (has('guest_sessions')) db.exec('DELETE FROM guest_sessions');
        if (has('join_codes')) db.prepare('UPDATE join_codes SET revoked_at = ? WHERE revoked_at IS NULL').run(nowMs);
        if (has('access_tokens')) db.prepare('UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(nowMs);
        if (has('invites')) db.exec('UPDATE invites SET revoked = 1 WHERE revoked = 0');
        db.exec("DELETE FROM settings WHERE key = 'backup.status' OR key LIKE 'cloud.%'");
        db.exec("DELETE FROM audit WHERE action IN ('backup.run', 'backup.failed')");
        for (const [key, value] of Object.entries(carried)) if (value !== null) upsert.run(key, value);
        upsert.run(PROTECTED_KEY, JSON.stringify(protectedNow));
        upsert.run(KEEP_KEY, JSON.stringify(keep));
        record = {
          kind: 'workspace',
          result: 'done',
          at: nowMs,
          manifest: info.manifest,
          files: info.files,
          bytes: info.bytes,
          boards: info.boards,
          keepOldFor: info.keepOldFor,
        };
        upsert.run(STATUS_KEY, JSON.stringify(record));
        db.prepare('INSERT INTO audit (ts, actor_id, action, detail) VALUES (?, ?, ?, ?)').run(
          nowMs,
          info.actorId,
          'restore.done',
          JSON.stringify({ kind: 'workspace', manifest: info.manifest, files: info.files, bytes: info.bytes, boards: info.boards, users: info.users,
            sessionsRemoved: removed.sessions, guestSessionsRemoved: removed.guestSessions, joinCodesRevoked: removed.joinCodes, keepOldFor: info.keepOldFor }),
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const rows = db.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new RestoreError('integrity_check_failed', 'The prepared database failed its integrity check, so nothing was changed');
    } finally {
      db.close();
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (exists(`${file}${suffix}`)) throw new RestoreError('restore_failed', 'The prepared database left a side file behind, so nothing was changed');
    }
    return { ...removed, record };
  }

  // ------------------------------------------------------------ the whole workspace

  function chooseOldDir() {
    let stamp = now();
    while (exists(path.join(dataDir, `.pre-restore-${stamp}`))) stamp++;
    return { name: `.pre-restore-${stamp}`, stamp };
  }

  /** The live entries the swap moves: the database with its side files, every room file, the history and image directories. */
  function liveEntries() {
    const out = [];
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!isSwapEntry(entry.name)) continue;
      const ok = SWAP_DIRS.includes(entry.name) ? entry.isDirectory() : entry.isFile();
      if (!ok) throw new RestoreError('restore_failed', 'The data directory holds something that is not a plain file where Tabula keeps its data, so nothing was changed');
      out.push(entry.name);
    }
    return out.sort();
  }

  /** The safety backup: the live state, in the bucket, before anything is touched. A backup already running is waited for. */
  async function safetyBackup() {
    let detail = null;
    for (let attempt = 0; attempt < SAFETY_WAIT_TRIES; attempt++) {
      if (stopped) break;
      const result = await backup.runNow();
      if (result?.ok === true && typeof result.manifest === 'string' && parseManifestName(result.manifest) !== null) return result.manifest;
      if (result?.skipped === 'running') {
        await sleep(SAFETY_WAIT_MS);
        continue;
      }
      detail = typeof result?.error === 'string' ? result.error.slice(0, ERROR_MAX) : result?.aborted ? 'aborted' : null;
      break;
    }
    throw new RestoreError('safety_backup_failed', 'The backup of the current data that comes before a restore failed, so nothing was changed', detail ? { detail: scrub(detail) } : {});
  }

  function scheduleExit(responseDone) {
    let finished = false;
    const leave = () => {
      if (finished) return;
      finished = true;
      setTimer(() => {
        say(`leaving with code ${EXIT_CODE} so the server starts again`);
        exit(EXIT_CODE);
      }, exitDelayMs);
    };
    const grace = setTimer(leave, EXIT_GRACE_MS + exitDelayMs);
    Promise.resolve(responseDone).then(() => {
      clearTimer(grace);
      leave();
    }, () => {
      clearTimer(grace);
      leave();
    });
  }

  /**
   * Replaces the whole workspace with a backup. Resolves after the swap, before the process leaves; the caller sends its
   * response and `responseDone` (a promise that settles when it has been flushed) lets the exit follow. Nothing live
   * changes before everything has been verified. After the point of no return the process always exits, also on failure.
   * @param {{ manifest: string, confirm: string, actor: Actor, responseDone?: Promise<unknown> }} input
   */
  async function restoreWorkspace({ manifest: name, confirm, actor, responseDone = Promise.resolve() }) {
    if (typeof name !== 'string' || parseManifestName(name) === null) throw new RestoreError('bad_request', 'manifest must be the name of a backup');
    if (confirm !== CONFIRM_WORD) throw new RestoreError('confirmation_mismatch', `Type ${CONFIRM_WORD} to confirm the restore`);
    if (!actor || typeof actor.id !== 'string') throw new RestoreError('forbidden', 'Only the workspace owner can restore');
    if (busy || maintenance) throw new RestoreError('restore_in_progress', 'A restore is already running');
    const startedAt = now();
    const wait = lastWholeAt + WORKSPACE_INTERVAL_MS - startedAt;
    const persisted = Number(last?.kind === 'workspace' ? last.at : 0);
    const wait2 = persisted + WORKSPACE_INTERVAL_MS - startedAt;
    if (Math.max(wait, wait2) > 0) {
      const seconds = Math.ceil(Math.max(wait, wait2) / 1000);
      throw new RestoreError('rate_limited', `A workspace restore was started a moment ago. Try again in ${Math.ceil(seconds / 60)} minute(s)`, { retryAfter: seconds });
    }
    busy = 'workspace';
    lastWholeAt = startedAt;
    let stagingDir = null;
    let pointOfNoReturn = false;
    let crashed = false;
    try {
      audit(actor, 'restore.started', { kind: 'workspace', manifest: name });
      say(`started a restore of ${name}`);

      // The backup being restored is looked at first and protected before the safety backup runs: that run prunes like any
      // other, and with a tight retention it would otherwise delete the very backup the owner chose.
      const manifest = await readManifestChecked(name);
      const plan = planFromManifest(manifest);
      protect(name, now());
      liveEntries();

      const safetyName = await safetyBackup();
      protect(safetyName, now());
      say('the live data is backed up and protected from pruning for 7 days');
      const before = await volume();
      const needed = 2 * plan.bytes + SPACE_MARGIN_BYTES;
      if (before.free < needed) throw new RestoreError('not_enough_space', 'There is not enough free disk space to restore this backup, so nothing was changed', { needed, free: before.free });

      stagingDir = await stageFiles(manifest);
      const counts = await verifyDatabase(stagingDir);
      verifyDocuments(stagingDir, manifest);
      await verifyChat(stagingDir, manifest);
      const retention = decideRetention(await volume(), 0);
      const oldDir = chooseOldDir();
      const prepared = await prepareDatabase(stagingDir, {
        manifest: name,
        files: plan.files,
        bytes: plan.bytes,
        boards: plan.boards,
        users: counts.users,
        actorId: actor.id,
        oldDir: oldDir.name,
        swapAt: oldDir.stamp,
        mode: retention.mode,
        keepOldFor: retention.keepOldFor,
      });
      say(`checked ${plan.files} files; ${prepared.sessions} sessions end with the restore`);
      const record = prepared.record;

      pointOfNoReturn = true;
      await enterMaintenance();
      const oldFiles = liveEntries();
      const journal = {
        version: JOURNAL_VERSION,
        id: crypto.randomBytes(8).toString('hex'),
        phase: 'swapping',
        manifest: name,
        stagingDir: path.basename(stagingDir),
        oldDir: oldDir.name,
        files: plan.topLevel,
        oldFiles,
        startedAt: oldDir.stamp,
      };
      swap(journal);
      last = record;
      return { ok: true, restarting: true, keepOldFor: retention.keepOldFor, reason: retention.reason };
    } catch (err) {
      if (err instanceof SimulatedCrash) {
        crashed = true;
        throw err;
      }
      return failWorkspace(err, { name, actor, stagingDir, pointOfNoReturn });
    } finally {
      if (!pointOfNoReturn) busy = null;
      else if (!crashed) scheduleExit(responseDone);
    }
  }

  async function enterMaintenance() {
    maintenance = true;
    await hooks.enterMaintenance?.();
    await backup.stop();
    if (hooks.closeDirectory) await hooks.closeDirectory();
    else directory.close();
  }

  /** The renames. Synchronous on purpose: a signal cannot arrive between two of them. */
  function swap(journal) {
    step('before-journal');
    const ctx = stepCtx();
    writeJournal(dataDir, journal, step);
    try {
      const old = path.join(dataDir, journal.oldDir);
      const staging = path.join(dataDir, journal.stagingDir);
      fs.mkdirSync(old);
      fsyncDir(dataDir);
      step('old-dir-made');
      journal.oldFiles.forEach((entry, i) => {
        fs.renameSync(path.join(dataDir, entry), path.join(old, entry));
        step(`moved-old-${i}`);
      });
      fsyncDir(dataDir);
      fsyncDir(old);
      let current = setPhase(ctx, journal, 'moved-old');
      current.files.forEach((entry, i) => {
        fs.renameSync(path.join(staging, entry), path.join(dataDir, entry));
        step(`moved-new-${i}`);
      });
      fsyncDir(dataDir);
      current = setPhase(ctx, current, 'moved-new');
      removeTree(staging);
      fsyncDir(dataDir);
      step('staging-removed');
      setPhase(ctx, current, 'done');
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      say(`the swap failed (${describe(err)}); undoing it`);
      const outcome = recoverJournal({ ...ctx, reason: 'swap_failed' });
      if (outcome.action === 'completed' && outcome.forward) return;
      throw new RestoreError('restore_failed', 'The restore could not be completed and was undone. The server restarts on the data it had before', { restarting: true });
    }
  }

  /** @returns {never} */
  function failWorkspace(err, { name, actor, stagingDir, pointOfNoReturn }) {
    const failure = err instanceof RestoreError ? err : fromBackupError(err);
    const code = describe(failure);
    say(`failed (${code})`);
    if (!pointOfNoReturn) {
      if (stagingDir) {
        try {
          removeTree(stagingDir);
        } catch {
          /* the next start removes it by name */
        }
      }
      setLast({ kind: 'workspace', result: 'failed', at: now(), manifest: name, error: code });
      audit(actor, 'restore.failed', { kind: 'workspace', manifest: name, error: code });
    }
    if (pointOfNoReturn) {
      const message = failure instanceof RestoreError ? failure.message : 'The restore could not be completed. The server restarts on the data it had before';
      throw new RestoreError(failure instanceof RestoreError ? failure.code : 'restore_failed', message, { ...failure.extra, restarting: true });
    }
    if (failure instanceof RestoreError) throw failure;
    throw new RestoreError('restore_failed', 'The restore failed. See the server log');
  }

  // ------------------------------------------------------------ one board, as a copy

  const cleanLabel = (value, fallback) => {
    const text = String(value ?? '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim();
    return text || fallback;
  };
  const cleanTitle = (value) => cleanLabel(value, 'Untitled board');

  /** At most `max` UTF-16 units, never cutting a character in half. */
  const cutText = (text, max) => {
    let kept = '';
    for (const character of text) {
      if (kept.length + character.length > max) break;
      kept += character;
    }
    return kept.trim();
  };

  // The directory cuts a title at 200 UTF-16 units, so the copy is cut before that and the date at the end survives.
  function copyTitle(original, nowMs) {
    const prefix = 'Restored: ';
    const suffix = ` ${dateOf(nowMs)}`;
    const room = TITLE_MAX - prefix.length - suffix.length;
    let kept = '';
    for (const character of cleanTitle(original)) {
      if (kept.length + character.length > room) break;
      kept += character;
    }
    return `${prefix}${kept.trim()}${suffix}`;
  }

  /**
   * Puts one board of a backup into the live workspace as a NEW board owned by `actor`, with a fresh id and no history.
   * The live board, its history and everything else are never touched. The original team is used only if it still exists
   * and the actor is a member of it (the rule board creation has); otherwise the copy is in the actor's personal space.
   * @param {{ manifest: string, boardId: string, actor: Actor }} input
   */
  async function restoreBoardCopy({ manifest: name, boardId, actor }) {
    if (typeof name !== 'string' || parseManifestName(name) === null) throw new RestoreError('bad_request', 'manifest must be the name of a backup');
    if (typeof boardId !== 'string' || !BOARD_ID_RE.test(boardId)) throw new RestoreError('bad_request', 'boardId must be 1 to 64 letters, digits, - or _');
    if (busy || maintenance) throw new RestoreError('restore_in_progress', 'A restore is already running');
    const person = actor && typeof actor.id === 'string' ? directory.getUser(actor.id) : null;
    if (!person || person.disabled || person.role === 'guest') throw new RestoreError('forbidden', 'Only a member of the workspace can restore a board');
    const startedAt = now();
    boardStarts = boardStarts.filter((t) => t > startedAt - BOARD_WINDOW_MS);
    if (boardStarts.length >= BOARD_MAX_PER_WINDOW) {
      throw new RestoreError('rate_limited', 'Too many boards were restored in the last minutes. Try again later', { retryAfter: Math.ceil((boardStarts[0] + BOARD_WINDOW_MS - startedAt) / 1000) });
    }
    boardStarts.push(startedAt);
    busy = 'board';
    let stagingDir = null;
    const written = [];
    try {
      audit(actor, 'restore.started', { kind: 'board', manifest: name });
      const manifest = await readManifestChecked(name);
      const plan = planFromManifest(manifest);
      const entryOf = (rel) => {
        const index = manifest.files.findIndex((f) => f.path === rel);
        return index === -1 ? null : { file: manifest.files[index], where: ` (file ${index + 1} of ${plan.files})` };
      };
      const download = async (rel) => {
        const entry = entryOf(rel);
        if (!entry) return null;
        let data;
        try {
          data = await backup.readObject(entry.file.objectId);
        } catch (err) {
          throw fromBackupError(err, entry.where);
        }
        if (data.length !== entry.file.size) throw new RestoreError('size_mismatch', `A file in the backup is not the size its manifest says${entry.where}`);
        return data;
      };

      const vol = await volume();
      const databaseEntry = entryOf('directory.sqlite');
      if (vol.free < 2 * databaseEntry.file.size + SPACE_MARGIN_BYTES) {
        throw new RestoreError('not_enough_space', 'There is not enough free disk space to read this backup, so nothing was changed', { needed: 2 * databaseEntry.file.size + SPACE_MARGIN_BYTES, free: vol.free });
      }
      stagingDir = path.join(dataDir, `.restore-${crypto.randomBytes(8).toString('hex')}`);
      fs.mkdirSync(stagingDir, { mode: 0o700 });
      const database = await download('directory.sqlite');
      const databaseFile = path.join(stagingDir, 'directory.sqlite');
      writeFileDurable(databaseFile, database);
      const row = await findBoardRow(databaseFile, boardId);
      if (!row) throw new RestoreError('board_not_in_backup', 'That board is not in this backup');

      const boardBytes = await download(`${boardId}.yjs`);
      if (!boardBytes) throw new RestoreError('board_not_in_backup', 'That board has no saved content in this backup');
      const commentBytes = await download(`${boardId}~comments.yjs`);

      const title = copyTitle(row.title, startedAt);
      let boardDoc;
      try {
        boardDoc = new Y.Doc();
        Y.applyUpdate(boardDoc, boardBytes);
        if (commentBytes) applyToThrowaway(commentBytes);
        boardDoc.transact(() => boardDoc.getMap('meta').set('name', title));
      } catch {
        boardDoc?.destroy();
        throw new RestoreError('invalid_backup', 'The board in the backup cannot be read, so nothing was changed');
      }
      const boardOut = Buffer.from(Y.encodeStateAsUpdate(boardDoc));
      boardDoc.destroy();

      const teamOk = typeof row.team_id === 'string' && directory.getTeam(row.team_id) !== null && directory.getTeamRole(row.team_id, person.id) !== null;
      const fallback = typeof row.team_id === 'string' && !teamOk;
      let id = newObjectId();
      for (let tries = 0; tries < 20 && (directory.getBoard(id) || exists(path.join(dataDir, `${id}.yjs`)) || exists(path.join(dataDir, `${id}~comments.yjs`))); tries++) id = newObjectId();
      if (directory.getBoard(id) || exists(path.join(dataDir, `${id}.yjs`))) throw new RestoreError('restore_failed', 'No free board id was found');

      const put = (rel, data) => {
        const final = path.join(dataDir, rel);
        const tmp = `${final}.tmp`;
        written.push(tmp);
        writeFileDurable(tmp, data, 'w');
        fs.renameSync(tmp, final);
        written[written.length - 1] = final;
      };
      // The pictures of the board (docs/images.md): the files come from the backup unless the live store already has them,
      // and the copy gets a row for each, so it shows what the original showed. A picture the backup lacks shows as missing.
      const pictures = [];
      for (const r of await findBoardAssets(databaseFile, boardId)) {
        const rel = `assets/${r.hash.slice(0, 2)}/${r.hash}`;
        if (assetHashOf(rel) !== r.hash) continue;
        const target = path.join(dataDir, ...rel.split('/'));
        if (!exists(target)) {
          const data = await download(rel);
          if (!data || crypto.createHash('sha256').update(data).digest('hex') !== r.hash) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          put(rel, data);
        }
        pictures.push(r);
      }
      put(`${id}.yjs`, boardOut);
      if (commentBytes) put(`${id}~comments.yjs`, commentBytes);
      fsyncDir(dataDir);
      const detail = { kind: 'board', manifest: name, boardId: id, files: commentBytes ? 2 : 1, ...(pictures.length ? { images: pictures.length } : {}), fallback };
      directory.transaction(() => {
        directory.createBoard({ id, title, ownerId: person.id, teamId: teamOk ? row.team_id : null });
        for (const r of pictures) directory.putAsset({ boardId: id, hash: r.hash, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, createdBy: person.id, createdAt: now() });
        directory.audit(person.id, 'restore.done', detail);
      });
      written.length = 0;
      setLast({ kind: 'board', result: 'done', at: now(), manifest: name, files: detail.files });
      say(`restored a board from ${name} as a copy`);
      return {
        ok: true,
        boardId: id,
        title,
        teamId: teamOk ? row.team_id : null,
        ...(fallback ? { fallback: 'personal', message: 'The original team no longer exists or you cannot see it, so the copy is in your personal space.' } : {}),
      };
    } catch (err) {
      for (const file of written) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* nothing more can be done */
        }
      }
      const failure = err instanceof RestoreError ? err : fromBackupError(err);
      const code = describe(failure);
      say(`board copy failed (${code})`);
      setLast({ kind: 'board', result: 'failed', at: now(), manifest: name, error: code });
      audit(actor, 'restore.failed', { kind: 'board', manifest: name, error: code });
      if (failure instanceof RestoreError) throw failure;
      throw new RestoreError('restore_failed', 'The board could not be restored. See the server log');
    } finally {
      if (stagingDir) {
        try {
          removeTree(stagingDir);
        } catch {
          /* the next start removes it by name */
        }
      }
      busy = null;
    }
  }

  /** The image rows of one board in a backed-up database: none when it is older than the images table or the board has none. */
  async function findBoardAssets(databaseFile, boardId) {
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get();
        if (!table) return [];
        return db.prepare('SELECT hash, mime, bytes, width, height FROM assets WHERE board_id = ? ORDER BY hash').all(boardId)
          .filter((r) => typeof r.hash === 'string' && typeof r.mime === 'string' && Number.isSafeInteger(r.bytes) && Number.isSafeInteger(r.width) && Number.isSafeInteger(r.height));
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }


  /** Opens a database from a backup read-only, runs the checks every restore object gets, and hands it to `read`. */
  async function withBackupDatabase(databaseFile, read) {
    const { MIGRATIONS } = await import('./directory.mjs');
    const { DatabaseSync } = await import('node:sqlite');
    try {
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        const rows = db.prepare('PRAGMA integrity_check').all();
        if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new RestoreError('integrity_check_failed', 'The database in the backup failed its integrity check, so nothing was changed');
        const version = Number(db.prepare('PRAGMA user_version').get().user_version);
        if (version < 1) throw new RestoreError('invalid_backup', 'The database in the backup is not a Tabula database');
        if (!canRead(readSchemaState(db), MIGRATIONS.length)) throw new RestoreError('schema_too_new', `The database in the backup was written by a newer Tabula. ${NEWEST_SCHEMA_HINT}`);
        return read(db);
      } finally {
        db.close();
      }
    } catch (err) {
      if (err instanceof RestoreError) throw err;
      throw new RestoreError('integrity_check_failed', 'The database in the backup cannot be read, so nothing was changed');
    }
  }

  const findBoardRow = (databaseFile, boardId) =>
    withBackupDatabase(databaseFile, (db) => db.prepare('SELECT title, team_id FROM boards WHERE id = ?').get(boardId) ?? null);

  // ------------------------------------------------------------ the boards inside one backup

  /**
   * The boards of one backup that have saved content in it (so each can be restored), most recently edited first, at
   * most 500. Only the backup's database is downloaded, verified like any other restore object, and read from a
   * temporary copy that is deleted again whatever happens. Reading is not restoring: nothing is recorded as a restore,
   * and the audit row (written by the caller) holds a count, never a title or an id. At most 20 reads a minute per owner.
   * @param {string} name
   * @param {Actor} actor
   */
  async function listBoardsInBackup(name, actor) {
    if (typeof name !== 'string' || parseManifestName(name) === null) throw new RestoreError('bad_request', 'manifest must be the name of a backup');
    if (!actor || typeof actor.id !== 'string') throw new RestoreError('forbidden', 'Only the workspace owner can read a backup');
    if (busy || maintenance) throw new RestoreError('restore_in_progress', 'A restore is already running');
    const startedAt = now();
    const recent = (boardListStarts.get(actor.id) ?? []).filter((t) => t > startedAt - BOARDS_LIST_WINDOW_MS);
    if (recent.length >= BOARDS_LIST_MAX_PER_WINDOW) {
      boardListStarts.set(actor.id, recent);
      throw new RestoreError('rate_limited', 'The boards of backups were read too often in the last minute. Try again in a moment', { retryAfter: Math.max(1, Math.ceil((recent[0] + BOARDS_LIST_WINDOW_MS - startedAt) / 1000)) });
    }
    recent.push(startedAt);
    boardListStarts.set(actor.id, recent);
    let stagingDir = null;
    try {
      const manifest = await readManifestChecked(name);
      const plan = planFromManifest(manifest);
      const index = manifest.files.findIndex((f) => f.path === 'directory.sqlite');
      const entry = manifest.files[index];
      const where = ` (file ${index + 1} of ${plan.files})`;
      const vol = await volume();
      const needed = 2 * entry.size + SPACE_MARGIN_BYTES;
      if (vol.free < needed) throw new RestoreError('not_enough_space', 'There is not enough free disk space to read this backup, so nothing was changed', { needed, free: vol.free });
      let data;
      try {
        data = await backup.readObject(entry.objectId);
      } catch (err) {
        throw fromBackupError(err, where);
      }
      if (data.length !== entry.size) throw new RestoreError('size_mismatch', `A file in the backup is not the size its manifest says${where}`);
      stagingDir = path.join(dataDir, `.restore-${crypto.randomBytes(8).toString('hex')}`);
      fs.mkdirSync(stagingDir, { mode: 0o700 });
      const databaseFile = path.join(stagingDir, 'directory.sqlite');
      writeFileDurable(databaseFile, data);
      const withContent = new Set(manifest.files.filter((f) => ROOM_FILE_RE.test(f.path) && !f.path.endsWith('~comments.yjs')).map((f) => f.path.slice(0, -'.yjs'.length)));
      return await withBackupDatabase(databaseFile, (db) => {
        const rows = db
          .prepare('SELECT b.id AS id, b.title AS title, b.team_id AS team_id, b.deleted_at AS deleted_at, t.name AS team_name FROM boards b LEFT JOIN teams t ON t.id = b.team_id ORDER BY b.updated_at DESC, b.id')
          .iterate();
        const boards = [];
        let truncated = false;
        for (const row of rows) {
          if (typeof row.id !== 'string' || !withContent.has(row.id)) continue;
          if (boards.length >= boardsListedMax) {
            truncated = true;
            break;
          }
          boards.push({
            id: row.id,
            title: cutText(cleanTitle(row.title), TITLE_MAX),
            teamId: typeof row.team_id === 'string' && BOARD_ID_RE.test(row.team_id) ? row.team_id : null,
            teamName: typeof row.team_name === 'string' ? cutText(cleanLabel(row.team_name, 'Team'), TEAM_NAME_MAX) : null,
            deleted: row.deleted_at !== null && row.deleted_at !== undefined,
          });
        }
        return { boards, truncated };
      });
    } catch (err) {
      const failure = err instanceof RestoreError ? err : fromBackupError(err);
      say(`could not list the boards of a backup (${describe(failure)})`);
      if (failure instanceof RestoreError) throw failure;
      throw new RestoreError('restore_failed', 'The boards of this backup could not be listed. See the server log');
    } finally {
      if (stagingDir) {
        try {
          removeTree(stagingDir);
        } catch {
          /* the next start removes it by name */
        }
      }
    }
  }

  // ------------------------------------------------------------ the old data

  /**
   * Deletes `.pre-restore-<ms>` directories whose time has come: 7 days after the restore (or 24 hours when the disk was
   * nearly full), and never before a backup has succeeded after it. Only exact names, only real directories, only when the
   * age can be told.
   */
  async function sweepOldData() {
    if (sweeping || busy || maintenance || stopped) return { removed: [] };
    sweeping = true;
    const removed = [];
    try {
      const nowMs = now();
      const keep = readKeep();
      const lastSuccess = Number(backup.status?.()?.lastSuccessAt);
      for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
        const m = PRE_RE.exec(entry.name);
        if (!m) continue;
        const dir = path.join(dataDir, entry.name);
        if (!isRealDirectory(dir)) {
          say('an old-data directory is not a plain directory and is left alone');
          continue;
        }
        const stamp = Number(m[1]);
        if (!Number.isSafeInteger(stamp) || stamp < Date.UTC(2020, 0, 1) || stamp > nowMs + DAY_MS) {
          say('an old-data directory has an age that cannot be told and is left alone');
          continue;
        }
        const mode = keep[entry.name]?.mode ?? 'days';
        const minAge = mode === 'next-backup' ? OLD_DATA_MIN_MS : OLD_DATA_MS;
        if (nowMs - stamp < minAge) continue;
        if (!(Number.isFinite(lastSuccess) && lastSuccess > stamp)) continue;
        await fs.promises.rm(dir, { recursive: true, force: true });
        removed.push(entry.name);
        audit(null, 'restore.old_data_removed', { ageDays: Math.floor((nowMs - stamp) / DAY_MS), mode });
        say('removed the old data of a restore');
      }
      if (removed.length) {
        const next = readKeep();
        for (const name of removed) delete next[name];
        try {
          directory.setSetting(KEEP_KEY, JSON.stringify(next));
        } catch {
          /* the entry is only a hint */
        }
      }
    } catch (err) {
      say(`sweeping the old data failed (${describe(err)})`);
    } finally {
      sweeping = false;
    }
    return { removed };
  }

  function armSweep(delay) {
    if (stopped) return;
    sweepTimer = setTimer(async () => {
      sweepTimer = null;
      await sweepOldData();
      armSweep(SWEEP_EVERY_MS);
    }, delay);
    sweepTimer?.unref?.();
  }

  // ------------------------------------------------------------ status and life cycle

  function status() {
    const nowMs = now();
    return {
      inProgress: busy,
      maintenance,
      last,
      protectedBackups: Object.entries(protections(nowMs)).map(([manifest, until]) => ({ manifest, until })),
      oldData: Object.entries(readKeep()).map(([dir, info]) => ({ name: dir, restoredAt: info.at, keepOldFor: keepOldWords(info.mode) })),
    };
  }

  /**
   * Once the database is open: records a restore that was undone by recoverOnStart (the failure could not be written
   * while the database was not open yet), then starts the hourly sweep of old data.
   */
  function start() {
    try {
      const journal = readJournal(dataDir);
      if (journal?.phase === 'rolled-back') {
        const error = journal.error ?? 'interrupted';
        setLast({ kind: 'workspace', result: 'failed', at: now(), manifest: journal.manifest, error });
        audit(null, 'restore.failed', { kind: 'workspace', manifest: journal.manifest, error });
        dropJournal(dataDir, noop);
        say(`recorded that the last restore was undone (${error})`);
      }
    } catch (err) {
      say(`could not record the outcome of an earlier restore (${describe(err)})`);
    }
    if (sweepTimer === null) armSweep(SWEEP_FIRST_MS);
  }

  function stop() {
    stopped = true;
    if (sweepTimer !== null) clearTimer(sweepTimer);
    sweepTimer = null;
  }

  return {
    listBackups,
    previewManifest,
    listBoardsInBackup,
    restoreBoardCopy,
    restoreWorkspace,
    recoverOnStart: () => recoverOnStart({ dataDir, log: say, step }),
    status,
    start,
    stop,
    sweepOldData,
  };
}
