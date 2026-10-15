// DEV ONLY (the relay runs with TABULA_DEV_PREVIEWS=1; server/dev-previews.mjs). Keeps the stored picture of a board up to date for the
// Boards cards: a change is written three seconds after the last one, and again when the board is left. The picture is drawn from what
// everyone may see of the board (src/preview-render.ts). Nothing here runs in a production build (main.ts checks import.meta.env.DEV).
import type { Store } from '../store';
import { storePreviewSvg } from '../preview-render';

/** Three seconds of quiet before a picture is written: a drag or a typed word is one picture, not one per change. */
export const PREVIEW_QUIET_MS = 3000;
/** The relay's cap for a picture (server/dev-previews.mjs DEV_PREVIEW_MAX_BYTES). A larger one is not sent. */
const MAX_CHARS = 200 * 1024;

/** Writes still on their way from this page. The Boards page waits for them before it asks which boards have a picture. */
const inFlight = new Set<Promise<void>>();

/** Resolves once every picture sent from this page has been answered (a refused or failed write counts as answered). */
export function devPreviewWritesSettled(): Promise<void> {
  return Promise.allSettled(inFlight).then(() => undefined);
}

/**
 * Starts writing the picture of the board in `store` after its changes. Returns the function that ends it: called when the board is
 * left, it writes the picture at once if anything changed since the last write, and stops listening. A picture identical to the
 * last one written is not sent again. Callers pass only boards this person may edit.
 */
export function watchBoardPreview(store: Store, boardId: string): () => void {
  let changed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent: string | null = null;

  const write = () => {
    timer = null;
    if (!changed) return;
    changed = false;
    let svg: string;
    try {
      svg = storePreviewSvg(store);
    } catch {
      return;
    }
    if (svg === lastSent || svg.length > MAX_CHARS) return;
    lastSent = svg;
    const sent = fetch(`/api/dev/board-preview/${encodeURIComponent(boardId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'image/svg+xml', 'x-tabula': '1' },
      body: svg,
    }).then(() => undefined, () => undefined);
    inFlight.add(sent);
    void sent.finally(() => inFlight.delete(sent));
  };

  const unsubscribe = store.onChange(() => {
    changed = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(write, PREVIEW_QUIET_MS);
  });

  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    write();
  };
}
