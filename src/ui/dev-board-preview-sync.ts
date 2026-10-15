// The picture of a board on its Boards card, kept up to date while an editor works on it (TAB-375 slice 3 demo). The picture is drawn from
// what the server sends for everyone's view (GET /api/boards/:id/preview-source), never from the live store, and uploaded as WebP or PNG
// (PUT /api/boards/:id/preview). Re-rendered three seconds after the last change, at most every ten seconds while the edits go on, and
// when the board is left. The server allows one upload per board every ten seconds; this module waits for that, and handles a refusal
// quietly. Dev only: main.ts starts it in a development build with the server's preview routes on (TABULA_PREVIEW_DEV=1).
import { buildPictureSvg, embedImages, type PictureMode } from '../preview-render';
import { rasterizePicture } from '../preview-raster';
import type { Obj } from '../types';

/** Quiet time after the last change before a picture is drawn. */
export const PREVIEW_QUIET_MS = 3000;
/** The longest a picture waits while changes keep coming (so a long edit still shows up). */
export const PREVIEW_MAX_WAIT_MS = 10000;
/** The server's gap between two uploads of one board. */
export const PREVIEW_COOLDOWN_MS = 10000;
/** localStorage key of the dev switch: 'export' (default) or 'blocks'. */
export const PREVIEW_RENDER_KEY = 'tabula.dev.previewRender';

/** When each board's picture was last stored from this page (ms). A card's address takes it as its version, so a new picture is a new address. */
const storedAt = new Map<string, number>();
/** Sent on the window when a picture has been stored: the Boards page draws its cards again, with the new address. */
export const PREVIEW_STORED_EVENT = 'tabula:board-preview-stored';

/** The version of a board's picture as a card asks for it: the board's last edit, or the last picture stored from this page, whichever is later. */
export function previewVersionOf(boardId: string, lastEdit: number): number {
  return Math.max(lastEdit, storedAt.get(boardId) ?? 0);
}

/** The drawing the switch asks for. Anything but 'blocks' is the export. Unreadable storage is the export too. */
export function previewModeSetting(): PictureMode {
  try {
    return globalThis.localStorage?.getItem(PREVIEW_RENDER_KEY) === 'blocks' ? 'blocks' : 'export';
  } catch {
    return 'export';
  }
}

export interface PreviewWatch {
  /** A change was made to the board. */
  touch(): void;
  /** The board is left: a picture is drawn (after the cooldown) and nothing more is listened for. */
  leave(): void;
}

export interface PreviewDeps {
  fetch: typeof fetch;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  mode: () => PictureMode;
  /** Draws a picture for the objects the server sent. The default is the app's own drawing (src/preview-render.ts). */
  picture: (objects: readonly Obj[], images: ReadonlyMap<string, string>, mode: PictureMode) => string;
  /** Draws the picture to an encoded image (src/preview-raster.ts), or null when it cannot be stored. */
  rasterize: (svg: string) => Promise<Blob | null>;
}

const browserDeps = (): PreviewDeps => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  mode: previewModeSetting,
  picture: (objects, images, mode) => buildPictureSvg(objects, { mode, images }).svg,
  rasterize: (svg) => rasterizePicture(svg),
});

/** Starts keeping the picture of `boardId` up to date. Callers pass only boards this person may edit. */
export function watchBoardPreview(boardId: string, overrides: Partial<PreviewDeps> = {}): PreviewWatch {
  const deps: PreviewDeps = { ...browserDeps(), ...overrides };
  const base = `/api/boards/${encodeURIComponent(boardId)}`;
  let dirty = false;
  let left = false;
  let running = false;
  let again = false;
  let firstChangeAt: number | null = null;
  let lastUploadAt: number | null = null;
  let timer: unknown = null;

  const schedule = (at: number) => {
    if (timer !== null) deps.clearTimer(timer);
    const earliest = lastUploadAt === null ? at : Math.max(at, lastUploadAt + PREVIEW_COOLDOWN_MS);
    timer = deps.setTimer(() => {
      timer = null;
      void run();
    }, Math.max(0, earliest - deps.now()));
  };

  const retryIn = (res: Response) => {
    const seconds = Number(res.headers.get('retry-after'));
    schedule(deps.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : PREVIEW_COOLDOWN_MS));
  };

  /** Asks the server for what everyone may see, draws it, and uploads it. Any refusal is answered quietly. */
  async function renderAndUpload(): Promise<void> {
    const source = await deps.fetch(`${base}/preview-source`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (source.status === 429) return retryIn(source);
    if (!source.ok) return;
    const body = (await source.json()) as { objects?: unknown };
    if (!Array.isArray(body.objects)) return;
    const objects = body.objects as Obj[];
    // an empty board has no picture: it keeps none, and its card shows the quiet tile (a fake or blank sketch would be a lie)
    if (objects.length === 0) return;
    const images = await embedImages(objects, boardId, (url, signal) => deps.fetch(url, {
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal, headers: { accept: 'image/*' },
    }));
    const svg = deps.picture(objects, images, deps.mode());
    const blob = await deps.rasterize(svg);
    if (!blob) return;
    const put = await deps.fetch(`${base}/preview`, {
      method: 'PUT', credentials: 'same-origin', headers: { 'content-type': blob.type, 'x-tabula': '1' }, body: blob,
    });
    lastUploadAt = deps.now();
    if (put.status === 204) {
      storedAt.set(boardId, deps.now());
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PREVIEW_STORED_EVENT, { detail: { boardId } }));
    }
    if (put.status === 429) retryIn(put);
  }

  async function run(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    dirty = false;
    firstChangeAt = null;
    try {
      await renderAndUpload();
    } catch {
      // a network failure or a malformed answer: the next change or the next leave tries again
    } finally {
      running = false;
    }
    if (again || (dirty && !left)) {
      again = false;
      schedule(deps.now() + PREVIEW_QUIET_MS);
    }
  }

  return {
    touch() {
      if (left) return;
      dirty = true;
      const now = deps.now();
      firstChangeAt ??= now;
      schedule(Math.min(now + PREVIEW_QUIET_MS, firstChangeAt + PREVIEW_MAX_WAIT_MS));
    },
    leave() {
      if (left) return;
      left = true;
      schedule(deps.now());
    },
  };
}
