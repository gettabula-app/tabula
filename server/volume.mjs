// Which workspace a data volume belongs to (docs/backups.md, "Volumes and restores"). DATA_DIR/volume.json is written
// once, on the first start, and says which workspace and which Fly volume the data was last served as. On every start
// the relay compares it with its environment, before it opens the database:
//
//   - another workspace's volume (hosted mode): refuse to start, unless TABULA_ADOPT_VOLUME names this workspace;
//   - the same workspace on another Fly volume (TABULA_FLY_VOLUME_ID changed): a restored snapshot, adopted on its own.
//
// Adopting makes sure no restore is half done, clears what the backup engine left mid-run, ends every session and
// sign-in link, writes a `volume.adopt` audit row and then the marker. Any failure stops the start: a half adopted
// volume is never served.
//
// decideVolume() is the whole rule and touches nothing; the rest reads and writes files.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clearRunState } from './backup.mjs';
import { fsyncDir, restorePending, writeFileDurable } from './restore.mjs';

export const MARKER = 'volume.json';
export const MARKER_VERSION = 1;
/** Adoptions the marker remembers; older ones are dropped (the audit log keeps them in accounts mode). */
export const HISTORY_MAX = 20;
export const AUDIT_ACTION = 'volume.adopt';
const MARKER_MAX_BYTES = 64 * 1024;
const TMP_RE = /^volume\.json\.tmp-[0-9a-f]{16}$/;
// The same shape as TABULA_CLOUD_WORKSPACE_ID (server/config.mjs); Fly volume ids (vol_…) fit it too.
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const VOLUME_ID_RE = /^[0-9a-f]{32}$/;
const DOCS = 'see docs/backups.md, "Volumes and restores"';

export class VolumeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VolumeError';
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOrNull = (value) => (value === null || (typeof value === 'string' && ID_RE.test(value)) ? value : undefined);
const timeOk = (value) => Number.isSafeInteger(value) && value >= 0;
const identity = (value) => (isObject(value) && idOrNull(value.workspaceId) !== undefined && idOrNull(value.flyVolumeId) !== undefined ? { workspaceId: value.workspaceId, flyVolumeId: value.flyVolumeId } : null);

export const newVolumeId = () => crypto.randomBytes(16).toString('hex');

/**
 * A marker as read from disk. Throws VolumeError when the fields that decide whose data this is cannot be trusted;
 * a malformed history entry is dropped instead (it decides nothing).
 * @param {string} text
 */
export function parseMarker(text) {
  const bad = new VolumeError(`The volume marker (${MARKER}) is not valid, so the server will not start: it cannot tell which workspace this data belongs to. Do not delete it unless you are sure this volume belongs to this workspace; ${DOCS}.`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw bad;
  }
  if (
    !isObject(data) ||
    data.version !== MARKER_VERSION ||
    typeof data.volumeId !== 'string' ||
    !VOLUME_ID_RE.test(data.volumeId) ||
    idOrNull(data.workspaceId) === undefined ||
    idOrNull(data.flyVolumeId) === undefined ||
    !timeOk(data.createdAt) ||
    !(data.adoptedAt === null || timeOk(data.adoptedAt)) ||
    !Array.isArray(data.history)
  ) {
    throw bad;
  }
  const history = [];
  for (const entry of data.history) {
    const from = isObject(entry) ? identity(entry.from) : null;
    const to = isObject(entry) ? identity(entry.to) : null;
    if (!from || !to || !timeOk(entry.at) || (entry.reason !== 'operator' && entry.reason !== 'restored-copy')) continue;
    history.push({ at: entry.at, from, to, reason: entry.reason });
  }
  return {
    version: MARKER_VERSION,
    volumeId: data.volumeId,
    workspaceId: data.workspaceId,
    flyVolumeId: data.flyVolumeId,
    createdAt: data.createdAt,
    adoptedAt: data.adoptedAt,
    history: history.slice(-HISTORY_MAX),
  };
}

/**
 * The start-up rule. Pure: the caller reads the marker and the environment and carries out what comes back.
 *
 * @param {object} input
 * @param {ReturnType<typeof parseMarker> | null} input.marker null when DATA_DIR has no volume.json yet
 * @param {string | null} input.workspaceId TABULA_CLOUD_WORKSPACE_ID when this is a hosted workspace, else null
 * @param {string | undefined} input.flyVolumeId TABULA_FLY_VOLUME_ID
 * @param {string | undefined} input.adoptVolume TABULA_ADOPT_VOLUME
 * @param {number} input.now
 * @param {() => string} [input.newId]
 * @returns {{ action: 'error', message: string }
 *   | { action: 'create' | 'keep', marker: any, write: boolean, notes: string[] }
 *   | { action: 'adopt', marker: any, write: true, reason: 'operator' | 'restored-copy', from: any, to: any, notes: string[] }}
 *   `write`: whether the marker on disk must be (re)written; `notes`: lines to log (ids only).
 */
export function decideVolume({ marker, workspaceId, flyVolumeId, adoptVolume, now, newId = newVolumeId }) {
  const hosted = typeof workspaceId === 'string' && workspaceId !== '';
  const fly = flyVolumeId === undefined || flyVolumeId === '' ? null : flyVolumeId;
  const adopt = adoptVolume === undefined || adoptVolume === '' ? null : adoptVolume;
  const notes = [];

  if (fly !== null && !ID_RE.test(fly)) {
    return { action: 'error', message: 'TABULA_FLY_VOLUME_ID must be 1 to 128 letters, digits, . - or _, so the server will not start.' };
  }
  if (adopt !== null) {
    if (!hosted) {
      return { action: 'error', message: `TABULA_ADOPT_VOLUME is set, but this server is not a hosted workspace (TABULA_CLOUD_* with TABULA_AUTH=on), so it will not start. Remove TABULA_ADOPT_VOLUME; ${DOCS}.` };
    }
    if (adopt !== workspaceId) {
      const shown = ID_RE.test(adopt) ? ` (${adopt})` : '';
      return { action: 'error', message: `TABULA_ADOPT_VOLUME${shown} is not this server's workspace (${workspaceId}), so it will not start. Set it to ${workspaceId} to adopt this volume, or remove it; ${DOCS}.` };
    }
  }
  const removable = 'TABULA_ADOPT_VOLUME is set but there is nothing to adopt: the volume already belongs to this workspace. The variable can be removed.';

  if (marker === null) {
    if (adopt !== null) notes.push(removable);
    return {
      action: 'create',
      write: true,
      notes,
      marker: { version: MARKER_VERSION, volumeId: newId(), workspaceId: hosted ? workspaceId : null, flyVolumeId: fly, createdAt: now, adoptedAt: null, history: [] },
    };
  }

  const from = { workspaceId: marker.workspaceId, flyVolumeId: marker.flyVolumeId };
  const otherWorkspace = hosted && marker.workspaceId !== null && marker.workspaceId !== workspaceId;
  if (otherWorkspace && adopt === null) {
    return {
      action: 'error',
      message:
        `This data volume belongs to workspace ${marker.workspaceId}, but this server is workspace ${workspaceId} ` +
        '(TABULA_CLOUD_WORKSPACE_ID), so it will not start: serving it would show one workspace the data of another. ' +
        `If the wrong volume is attached, attach the right one. To adopt this volume into ${workspaceId} on purpose, ` +
        `start once with TABULA_ADOPT_VOLUME=${workspaceId} (everyone is signed out); ${DOCS}.`,
    };
  }
  if (adopt !== null && !otherWorkspace) notes.push(removable);

  const to = {
    workspaceId: hosted ? workspaceId : marker.workspaceId,
    flyVolumeId: fly ?? marker.flyVolumeId,
  };
  const otherVolume = fly !== null && marker.flyVolumeId !== null && marker.flyVolumeId !== fly;
  if (otherWorkspace || otherVolume) {
    const reason = otherWorkspace ? 'operator' : 'restored-copy';
    return {
      action: 'adopt',
      write: true,
      reason,
      from,
      to,
      notes,
      marker: { ...marker, ...to, adoptedAt: now, history: [...marker.history, { at: now, from, to, reason }].slice(-HISTORY_MAX) },
    };
  }

  // Nothing to adopt. An id the marker did not have yet is recorded: the first start with TABULA_FLY_VOLUME_ID, or
  // the first hosted start of a volume that was not hosted before. Neither signs anyone out.
  const write = to.workspaceId !== marker.workspaceId || to.flyVolumeId !== marker.flyVolumeId;
  if (to.flyVolumeId !== marker.flyVolumeId) notes.push(`volume: recorded Fly volume ${to.flyVolumeId}`);
  if (to.workspaceId !== marker.workspaceId) notes.push(`volume: recorded workspace ${to.workspaceId}`);
  return { action: 'keep', write, notes, marker: write ? { ...marker, ...to } : marker };
}

// ---------------------------------------------------------------- files

/** The marker in dataDir, or null when there is none. Leftover temporary files of an interrupted write go first. */
export function readMarker(dataDir) {
  for (const name of fs.readdirSync(dataDir)) {
    if (TMP_RE.test(name)) fs.rmSync(path.join(dataDir, name), { force: true });
  }
  const file = path.join(dataDir, MARKER);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return parseMarker('');
  return parseMarker(fs.readFileSync(file, 'utf8'));
}

/** Atomic and durable, like the restore journal: a temporary file next to it, flushed, renamed over it, the directory flushed. */
export function writeMarker(dataDir, marker) {
  const tmp = path.join(dataDir, `${MARKER}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    writeFileDurable(tmp, `${JSON.stringify(marker, null, 2)}\n`);
    fs.renameSync(tmp, path.join(dataDir, MARKER));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dataDir);
}

/**
 * Reads the marker and decides. Runs right after the restore recovery and before the database is opened, so a volume
 * that is not this workspace's is refused before anything of it is read.
 * @param {{ dataDir: string, env: Record<string, string | undefined>, workspaceId: string | null, now?: number }} options
 */
export function planVolume({ dataDir, env, workspaceId, now = Date.now() }) {
  return decideVolume({
    marker: readMarker(dataDir),
    workspaceId,
    flyVolumeId: env.TABULA_FLY_VOLUME_ID,
    adoptVolume: env.TABULA_ADOPT_VOLUME,
    now,
  });
}

/**
 * Carries out a plan: for an adoption, every step in order, and the marker last. Throws on the first step that fails
 * (the relay then exits); the next start finds the old marker and adopts again, which is safe to repeat.
 * @param {{ dataDir: string, plan: ReturnType<typeof decideVolume>, directory?: any, log?: (...args: any[]) => void }} options
 * @returns {boolean} whether the volume was adopted
 */
export function applyVolume({ dataDir, plan, directory = null, log = () => {} }) {
  if (plan.action === 'error') throw new VolumeError(plan.message);
  for (const note of plan.notes) log(note);
  if (plan.action === 'adopt') {
    // (a) The restore recovery ran before this; a restore still in the middle of something is not adopted.
    if (restorePending(dataDir)) throw new VolumeError(`The volume holds a restore that is not finished, so it was not adopted and the server will not start; ${DOCS}.`);
    // (b) what a backup run left behind
    clearRunState({ dataDir, directory });
    // (c) and (d) together: nobody stays signed in, and the audit log says why.
    if (directory) {
      directory.transaction(() => {
        directory.revokeAllSessions();
        directory.audit(null, AUDIT_ACTION, { from: plan.from, to: plan.to, reason: plan.reason });
      });
    }
  }
  // (e)
  if (plan.write) writeMarker(dataDir, plan.marker);
  if (plan.action === 'create') log(`volume: marked this volume (${plan.marker.volumeId}) as workspace ${plan.marker.workspaceId ?? '(none)'}, Fly volume ${plan.marker.flyVolumeId ?? '(unknown)'}`);
  if (plan.action === 'adopt') {
    const show = (id) => `workspace ${id.workspaceId ?? '(none)'}, Fly volume ${id.flyVolumeId ?? '(unknown)'}`;
    log(`volume: adopted volume ${plan.marker.volumeId} (${plan.reason}) from ${show(plan.from)} to ${show(plan.to)}; every session was signed out`);
  }
  return plan.action === 'adopt';
}

/** What GET /api/internal/volume answers. */
export function volumeReport(marker, startedAt) {
  return {
    volumeId: marker.volumeId,
    workspaceId: marker.workspaceId,
    flyVolumeId: marker.flyVolumeId,
    adoptedAt: marker.adoptedAt,
    startedAt,
    lastAdoption: marker.history.at(-1) ?? null,
  };
}
