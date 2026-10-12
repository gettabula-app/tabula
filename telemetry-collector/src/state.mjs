import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_RE } from './registry.mjs';

/**
 * File-backed state shared by the serving collector, the CLI and the lake job (separate processes and containers):
 *  - deletion markers: while one exists the workspace cannot be written to; it also records that backups still hold data
 *  - the workspace allowlist that control-plane tokens must stay inside
 *  - replay keys: one empty file per accepted workspace and hour, created exclusively, so replay protection survives restarts
 */
const safeId = (workspace) => {
  if (typeof workspace !== 'string' || !WORKSPACE_RE.test(workspace)) throw new Error('invalid workspace id');
  return workspace;
};

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const markerFile = (config, workspace) => path.join(config.deletionsDir, `${safeId(workspace)}.json`);

export function isDeleting(config, workspace) {
  return fs.existsSync(markerFile(config, workspace));
}

/** Create (or keep) the marker. Returns `{ created }`. */
export function markDeleting(config, workspace, now = Date.now()) {
  const file = markerFile(config, workspace);
  if (fs.existsSync(file)) return { created: false, marker: readMarker(config, workspace) };
  const marker = { workspace, requestedAt: now, storesPurgedAt: null, backups: 'pending', backupsErasedAt: null };
  writeJson(file, marker);
  return { created: true, marker };
}

export function readMarker(config, workspace) {
  try { return JSON.parse(fs.readFileSync(markerFile(config, workspace), 'utf8')); } catch { return null; }
}

export function updateMarker(config, workspace, patch) {
  const marker = readMarker(config, workspace);
  if (!marker) throw new Error('no deletion marker for that workspace');
  writeJson(markerFile(config, workspace), { ...marker, ...patch });
}

export function listMarkers(config) {
  let names = [];
  try { names = fs.readdirSync(config.deletionsDir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => readMarker(config, n.slice(0, -5))).filter(Boolean);
}

export function clearMarker(config, workspace) {
  fs.rmSync(markerFile(config, workspace), { force: true });
}

function readAllow(config) {
  try {
    const data = JSON.parse(fs.readFileSync(config.workspacesFile, 'utf8'));
    return Array.isArray(data?.workspaces) ? data.workspaces : [];
  } catch { return []; }
}
/** An absent or empty allowlist allows nothing: control-plane tokens fail closed. */
export const isAllowed = (config, workspace) => readAllow(config).includes(workspace);
export const listAllowed = (config) => readAllow(config);
export function allowWorkspace(config, workspace) {
  const list = new Set(readAllow(config));
  list.add(safeId(workspace));
  writeJson(config.workspacesFile, { workspaces: [...list].sort() });
}
export function removeAllowed(config, workspace) {
  writeJson(config.workspacesFile, { workspaces: readAllow(config).filter((w) => w !== workspace) });
}

// Instance reports and fleet snapshots have separate claims for the same hour: a snapshot never blocks a real report, and the reverse.
const hourFile = (config, workspace, hour, kind = 'report') => path.join(config.seenDir, safeId(workspace), `${kind === 'fleet' ? 'fleet-' : ''}${Number(hour)}`);

/** Claim a workspace/hour. False when it was already accepted (even before a restart). */
export function claimHour(config, workspace, hour, kind = 'report') {
  const file = hourFile(config, workspace, hour, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.closeSync(fs.openSync(file, 'wx')); return true; } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}
export function releaseHour(config, workspace, hour, kind = 'report') {
  fs.rmSync(hourFile(config, workspace, hour, kind), { force: true });
}
export function forgetWorkspaceHours(config, workspace) {
  fs.rmSync(path.join(config.seenDir, safeId(workspace)), { recursive: true, force: true });
}
/** Drop claims older than the accepted report age (plus an hour); older reports are refused anyway. */
export function pruneHours(config, now = Date.now()) {
  let removed = 0;
  let workspaces = [];
  try { workspaces = fs.readdirSync(config.seenDir); } catch { return 0; }
  for (const ws of workspaces) {
    const dir = path.join(config.seenDir, ws);
    for (const name of fs.readdirSync(dir)) {
      if (Number(name.replace(/^fleet-/u, '')) < now - config.maxReportAgeMs - 3_600_000) { fs.rmSync(path.join(dir, name), { force: true }); removed += 1; }
    }
    try { fs.rmdirSync(dir); } catch { /* not empty */ }
  }
  return removed;
}
