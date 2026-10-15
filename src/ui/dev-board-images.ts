// DEV ONLY: the picture of a board card in the development build (TAB-375 slice 3 demo). The card asks the server for the picture the board has
// stored (GET /api/boards/:id/preview), cache-busted by the board's last edit. A board with no stored picture (the server answers 404) shows
// the quiet tile. There is no template sketch and no seeded picture anywhere: a card shows what the board holds, or nothing. A production
// build gives the card no picture at all.
import type { PreviewImage } from './board-preview';
import { previewVersionOf } from './dev-board-preview-sync';

/** The address of a board's stored picture. The version is the board's last edit, so an edit is a new address. Pure. */
export function previewSrc(boardId: string, version: number): string {
  return `/api/boards/${encodeURIComponent(boardId)}/preview?v=${Number.isFinite(version) ? Math.floor(version) : 0}`;
}

/** The picture of a board card in the development build; undefined in a production build. */
export function devBoardImage(boardId: string, version: number): PreviewImage | undefined {
  if (!import.meta.env.DEV) return undefined;
  return { kind: 'url', src: previewSrc(boardId, previewVersionOf(boardId, version)) };
}
