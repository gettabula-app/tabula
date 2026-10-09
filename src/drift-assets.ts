// Images inside a `.drift` file (docs/images.md, Export, import and the other formats). The file is a zip; the pictures
// are stored beside the board as `assets/<sha256 of the bytes>` and `assets.json` says which picture each `asset`
// reference of the board means. Pure functions over bytes, so both directions are tested without a browser.
import { IMAGE_TYPES, readImageInfo, sizeOk, sniffType } from './images';
import { MAX_FILE_BYTES, type ImportedAsset } from './images';

export const ASSET_MANIFEST = 'assets.json';
/** What a file may hold: far more than a board has, and a bound on what opening a hostile file can allocate. */
export const MAX_FILE_ASSETS = 500;
export const MAX_TOTAL_ASSET_BYTES = 300 * 1024 * 1024;

const FILE_RE = /^assets\/[0-9a-f]{64}$/;
const KEY_RE = /^(?:[0-9a-f]{64}|pending:[A-Za-z0-9_-]{1,64})$/;

export interface PackedAsset { key: string; mime: string; bytes: Uint8Array; sha: string }

/** The zip entries for the pictures of a board (the caller stores them without compressing again) and the manifest that names them; null when there are none. */
export function packAssets(entries: PackedAsset[]): Record<string, Uint8Array> | null {
  if (!entries.length) return null;
  const files: Record<string, Uint8Array> = {};
  const map: Record<string, { file: string; mime: string }> = {};
  for (const e of entries) {
    const file = `assets/${e.sha}`;
    files[file] = e.bytes;
    map[e.key] = { file, mime: e.mime };
  }
  files[ASSET_MANIFEST] = new TextEncoder().encode(JSON.stringify({ v: 1, assets: map }, null, 2));
  return files;
}

/**
 * The pictures of an opened `.drift` file, by the `asset` reference they stand for. Anything that does not hold up (a
 * reference that is not a hash or pending key, a missing file, bytes that are not the image type they claim, a size
 * over the caps) is left out, so the object shows a placeholder, and nothing else about the file is refused.
 */
export function unpackAssets(files: Record<string, Uint8Array>): Record<string, ImportedAsset> {
  const raw = files[ASSET_MANIFEST];
  if (!raw) return {};
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return {};
  }
  const entries = (manifest as { v?: unknown; assets?: unknown })?.v === 1 ? (manifest as { assets: unknown }).assets : null;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
  const out: Record<string, ImportedAsset> = {};
  let total = 0;
  let count = 0;
  for (const [key, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (count >= MAX_FILE_ASSETS) break;
    if (!KEY_RE.test(key) || !entry || typeof entry !== 'object') continue;
    const { file, mime } = entry as { file?: unknown; mime?: unknown };
    if (typeof file !== 'string' || !FILE_RE.test(file) || typeof mime !== 'string' || !IMAGE_TYPES.includes(mime)) continue;
    const bytes = files[file];
    if (!bytes || bytes.length === 0 || bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_TOTAL_ASSET_BYTES) continue;
    if (sniffType(bytes) !== mime) continue;
    const info = readImageInfo(bytes, mime);
    if (!info || !sizeOk(info.width, info.height)) continue;
    out[key] = { bytes, mime, width: info.width, height: info.height };
    total += bytes.length;
    count += 1;
  }
  return out;
}
