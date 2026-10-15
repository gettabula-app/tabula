// The picture of a board card (TAB-375, docs/board-previews.md): the picture the board has stored, cache-busted by the board's last edit or
// by a picture this page stored, and asked for only while the server says board previews are on for this session. A board with no stored
// picture answers 404, and the card keeps its drawn schematic (imageTile's error path).
import { boardPreviewsAvailable } from '../auth';
import type { PreviewImage } from './board-preview';
import { previewVersionOf } from './board-preview-sync';

/** The address of a board's stored picture. The version is the board's last edit, so an edit is a new address. Pure. */
export function previewSrc(boardId: string, version: number): string {
  return `/api/boards/${encodeURIComponent(boardId)}/preview?v=${Number.isFinite(version) ? Math.floor(version) : 0}`;
}

/** The picture of a board card, or undefined when this session has board previews off (the card then draws its schematic). */
export function boardPicture(boardId: string, version: number): PreviewImage | undefined {
  if (!boardPreviewsAvailable()) return undefined;
  return { kind: 'url', src: previewSrc(boardId, previewVersionOf(boardId, version)) };
}
