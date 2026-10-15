// TAB-375 slice 2, DEV ONLY: real pictures for the Boards cards until the server sends them. A dev seed writes a manifest next to the
// app: { boardId: templateId | null }. A board whose template is built in shows that template's block picture (the same picture as
// the demo). Every export is inert in a production build (import.meta.env.DEV is false there), so nothing is fetched and no board
// gets a picture; the page then draws its quiet tiles.
import { TEMPLATES } from '../templates';
import { builtinBlockThumbnail } from '../template-thumb';
import type { PreviewImage } from './board-preview';

/** Board id to built-in template id, or null for a board that has no picture. */
export type DevBoardManifest = Record<string, string | null>;

const MANIFEST_URL = '/dev-board-images/manifest.json';
let loaded: DevBoardManifest | null = null;
let pending: Promise<void> | null = null;

const isManifest = (value: unknown): value is DevBoardManifest =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((v) => v === null || typeof v === 'string');

/** The picture a manifest gives a board: the block picture of its built-in template, or undefined. Pure. */
export function pictureFor(manifest: DevBoardManifest | null, boardId: string): PreviewImage | undefined {
  if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, boardId)) return undefined;
  const templateId = manifest[boardId];
  if (typeof templateId !== 'string') return undefined;
  const def = TEMPLATES.find((t) => t.id === templateId);
  return def ? { kind: 'svg', markup: builtinBlockThumbnail(def) } : undefined;
}

/** The dev picture of a board once the manifest is in (synchronous). Undefined in a production build. */
export function devBoardImage(boardId: string): PreviewImage | undefined {
  if (!import.meta.env.DEV) return undefined;
  return pictureFor(loaded, boardId);
}

/** True when the pictures are settled: always in production, and in dev once the manifest is in (or failed). */
export function devBoardImagesReady(): boolean {
  return !import.meta.env.DEV || loaded !== null;
}

/** Fetches the manifest once and resolves when it is in. A missing or unreadable manifest means no pictures. Production: no fetch. */
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
  return pending;
}

/** Forgets the manifest (tests only). */
export function resetDevBoardImagesForTests(): void {
  loaded = null;
  pending = null;
}
