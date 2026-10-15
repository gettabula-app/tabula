// DEV ONLY: real pictures for the Boards cards. Two sources, in this order:
//  1. the picture an editor stored for the board (the relay's dev previews, server/dev-previews.mjs, written by ui/dev-board-preview-sync.ts):
//     the card shows it as an <img> from the relay, cache-busted by its version. The lookup of versions is asked again on every page render.
//  2. until a board has a stored picture, the block picture of the built-in template named in the seed's manifest
//     (scripts/dev-seed-boards.mjs writes it), so a board that was seeded without content still has a picture.
// Every export is inert in a production build (import.meta.env.DEV is false there): nothing is fetched and no board gets a picture; the
// page then draws its quiet tiles.
import { TEMPLATES } from '../templates';
import { builtinBlockThumbnail } from '../template-thumb';
import type { PreviewImage } from './board-preview';
import { devPreviewWritesSettled } from './dev-board-preview-sync';

/** Board id to built-in template id, or null for a board that has no picture. */
export type DevBoardManifest = Record<string, string | null>;
/** Board id to the version of its stored picture (the file time in milliseconds). Only boards with a picture are listed. */
export type DevPreviewVersions = Record<string, number>;

const MANIFEST_URL = '/dev-board-images/manifest.json';
const PREVIEWS_URL = '/api/dev/board-previews';
const previewUrl = (boardId: string) => `/api/dev/board-preview/${encodeURIComponent(boardId)}`;

let loaded: DevBoardManifest | null = null;
let pending: Promise<void> | null = null;
let versions: DevPreviewVersions | null = null;

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

const isManifest = (value: unknown): value is DevBoardManifest =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((v) => v === null || typeof v === 'string');

const isVersions = (value: unknown): value is DevPreviewVersions =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v));

/** The manifest's picture of a board: the block picture of its built-in template, or undefined. Pure. */
export function pictureFor(manifest: DevBoardManifest | null, boardId: string): PreviewImage | undefined {
  if (!manifest || !hasOwn(manifest, boardId)) return undefined;
  const templateId = manifest[boardId];
  if (typeof templateId !== 'string') return undefined;
  const def = TEMPLATES.find((t) => t.id === templateId);
  return def ? { kind: 'svg', markup: builtinBlockThumbnail(def) } : undefined;
}

/** The stored picture of a board at its version: an <img> of its address. Undefined when the board has none. Pure. */
export function previewPictureFor(stored: DevPreviewVersions | null, boardId: string): PreviewImage | undefined {
  if (!stored || !hasOwn(stored, boardId)) return undefined;
  return { kind: 'url', src: `${previewUrl(boardId)}?v=${stored[boardId]}` };
}

/** The dev picture of a board: its stored picture, else the manifest's (synchronous). Undefined in a production build. */
export function devBoardImage(boardId: string): PreviewImage | undefined {
  if (!import.meta.env.DEV) return undefined;
  return previewPictureFor(versions, boardId) ?? pictureFor(loaded, boardId);
}

/** True when the pictures are settled: always in production, and in dev once the manifest and the lookup are in (or failed). */
export function devBoardImagesReady(): boolean {
  return !import.meta.env.DEV || (loaded !== null && versions !== null);
}

/** Asks the relay which boards have a stored picture, and at which version, once the pictures in flight have been answered. */
export function refreshDevBoardPreviews(): Promise<void> {
  if (!import.meta.env.DEV) return Promise.resolve();
  return (async () => {
    await devPreviewWritesSettled();
    const response = await fetch(PREVIEWS_URL, { cache: 'no-store', credentials: 'same-origin' });
    const json: unknown = response.ok ? await response.json() : null;
    versions = isVersions(json) ? json : {};
  })().catch(() => {
    // a relay without the dev routes, or one that did not answer: no stored pictures
    versions = {};
  });
}

/** Fetches the manifest once, and the stored pictures' versions if they are not in yet. A missing manifest means no pictures from it. */
export function loadDevBoardImages(): Promise<void> {
  if (!import.meta.env.DEV) return Promise.resolve();
  // async: a missing fetch or a bad response is a rejection, which lands in the catch (no picture for anyone)
  pending ??= (async () => {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
    const json: unknown = response.ok ? await response.json() : null;
    loaded = isManifest(json) ? json : {};
  })().catch(() => {
    loaded = {};
  });
  return Promise.all([pending, versions === null ? refreshDevBoardPreviews() : Promise.resolve()]).then(() => undefined);
}

/** Forgets the manifest and the lookup (tests only). */
export function resetDevBoardImagesForTests(): void {
  loaded = null;
  pending = null;
  versions = null;
}
