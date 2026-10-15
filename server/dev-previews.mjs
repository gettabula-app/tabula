// DEV ONLY (TABULA_DEV_PREVIEWS=1, server/config.mjs). The stored picture of a board for the Boards cards: one SVG file per board in
// <dataDir>/dev-previews/<id>.svg, written by the board's editor when the board is left or has been quiet for a few seconds
// (src/ui/dev-board-preview-sync.ts). Routes: server/api.mjs, the dev/ block. Nothing here runs unless that flag is on.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { scanSvg } from '../shared/svg-safety.mjs';
import { renameSyncRetry } from './fs-retry.mjs';

export const DEV_PREVIEW_DIR = 'dev-previews';
/** The largest picture the route takes. A block picture of a 400-object board is well under this. */
export const DEV_PREVIEW_MAX_BYTES = 200 * 1024;

/** The file of a board's picture. The id is checked by the caller (BOARD_ID_RE), so it is one file name inside the folder. */
export function previewFile(dataDir, id) {
  return path.join(dataDir, DEV_PREVIEW_DIR, `${id}.svg`);
}

/** The version of a stored picture: its file time in whole milliseconds, or null when the board has none yet. */
export function previewVersion(dataDir, id) {
  try {
    return Math.floor(fs.statSync(previewFile(dataDir, id)).mtimeMs);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** The stored picture as a Buffer, or null when there is none. */
export function readPreview(dataDir, id) {
  try {
    return fs.readFileSync(previewFile(dataDir, id));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Why a picture may not be stored, or null when it may. The body must be an SVG document that the shared SVG policy accepts
 * (the one templates on the server use): no scripts, no event handlers, no links, no DOCTYPE, comments or character references.
 */
export function previewProblem(text) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('<svg')) return 'is not an SVG document';
  return scanSvg(text, { maxLength: DEV_PREVIEW_MAX_BYTES }).problems[0] ?? null;
}

/** Writes the picture atomically: a temporary file beside it, then a rename over the old one. A reader sees the old or the new file. */
export function writePreview(dataDir, id, text) {
  const dir = path.join(dataDir, DEV_PREVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = previewFile(dataDir, id);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    renameSyncRetry(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
