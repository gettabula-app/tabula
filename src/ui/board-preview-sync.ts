// The picture of a board on its Boards card, kept up to date while an owner or editor works on it (TAB-375, docs/board-previews.md). The
// picture is drawn from what the server sends for everyone's view (GET /api/boards/:id/preview-source, with its revision `rev`), never from
// the live store, and uploaded as WebP or PNG (PUT /api/boards/:id/preview with `x-preview-rev`). It is drawn three seconds after the last
// change, at most every ten seconds while the edits go on, and when the board is left.
//
// Nothing here loops on a refusal. A stale revision (409) is asked again once; every other refusal waits: 404 (a board with no picture or
// one that is off), 401 and 403 stop the watch for this page load, 413 waits an hour, and 429, 503 and a network failure back off. The card keeps its drawn schematic
// whenever a picture is missing or cannot be drawn: the server removes pictures itself, so any GET may answer 404.
import { buildPictureSvg, embedImages } from '../preview-render';
import { rasterizePicture } from '../preview-raster';
import type { Obj } from '../types';

/** Quiet time after the last change before a picture is drawn. */
export const PREVIEW_QUIET_MS = 3000;
/** The longest a picture waits while changes keep coming (so a long edit still shows up). */
export const PREVIEW_MAX_WAIT_MS = 10000;
/** The server's gap between two uploads of one board. */
export const PREVIEW_COOLDOWN_MS = 10000;
/** How long a board waits after a refusal that names no time (or after a network failure). */
export const PREVIEW_BACKOFF_MS = 5 * 60_000;
/** The longest Retry-After the page honours. */
export const PREVIEW_RETRY_AFTER_MAX_MS = 60 * 60_000;
/** Attempts at one picture: the first, and one more after a stale revision (409 preview_stale). Then the page gives up until the next change or leave. */
export const PREVIEW_MAX_TRIES = 2;
/** A tab hidden for longer than this drops its pending picture work. */
export const PREVIEW_HIDDEN_MS = 60_000;

/** When each board's picture was last stored from this page (ms). A card's address takes it as its version, so a new picture is a new address. */
const storedAt = new Map<string, number>();
/** Sent on the window when a picture has been stored: the Boards page draws its cards again, with the new address. */
export const PREVIEW_STORED_EVENT = 'tabula:board-preview-stored';

/** The version of a board's picture as a card asks for it: the board's last edit, or the last picture stored from this page, whichever is later. */
export function previewVersionOf(boardId: string, lastEdit: number): number {
  return Math.max(lastEdit, storedAt.get(boardId) ?? 0);
}

/** Who may keep a picture: the server's flag for this session, and the role on the open board (an owner or an editor). */
export interface PreviewAccess {
  /** `boardPreviews` from the session (or config) answer. */
  enabled: boolean;
  role: string | null;
}

/** Owners and editors may keep a picture, and only while the server has them on. Anyone else gets a watch that does nothing. */
export function mayKeepPreview(access: PreviewAccess): boolean {
  return access.enabled && (access.role === 'owner' || access.role === 'editor');
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
  /** How long the tab has been hidden, in ms (0 when it is visible). */
  hiddenForMs: () => number;
  /** Draws the picture of the objects the server sent (src/preview-render.ts). */
  picture: (objects: readonly Obj[], images: ReadonlyMap<string, string>) => string;
  /** Draws the picture to an encoded image (src/preview-raster.ts), or null when it cannot be stored. */
  rasterize: (svg: string) => Promise<Blob | null>;
}

/** Visibility, recorded from the first listen: the time the tab was hidden, or null while it is shown. */
let hiddenSince: number | null = null;
let listening = false;
function listenForVisibility(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  hiddenSince = document.visibilityState === 'hidden' ? Date.now() : null;
  document.addEventListener('visibilitychange', () => {
    hiddenSince = document.visibilityState === 'hidden' ? (hiddenSince ?? Date.now()) : null;
  });
}

const browserDeps = (): PreviewDeps => {
  listenForVisibility();
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    hiddenForMs: () => (hiddenSince === null ? 0 : Date.now() - hiddenSince),
    picture: (objects, images) => buildPictureSvg(objects, { images }).svg,
    rasterize: (svg) => rasterizePicture(svg),
  };
};

/** Parses a revision the server sent: a whole number, not negative, that fits the digits the header allows. */
function revisionOf(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const text = String(value);
  return /^\d{1,12}$/.test(text) ? text : null;
}

type Attempt = 'stored' | 'stale' | 'done';

/** Starts keeping the picture of `boardId` up to date. Anyone who may not keep one gets a watch that does nothing (no request is made). */
export function watchBoardPreview(boardId: string, access: PreviewAccess, overrides: Partial<PreviewDeps> = {}): PreviewWatch {
  if (!mayKeepPreview(access)) return { touch() {}, leave() {} };
  const deps: PreviewDeps = { ...browserDeps(), ...overrides };
  const base = `/api/boards/${encodeURIComponent(boardId)}`;
  let dirty = false;
  let left = false;
  let running = false;
  let again = false;
  let firstChangeAt: number | null = null;
  let lastUploadAt: number | null = null;
  let backoffUntil = 0;
  let timer: unknown = null;

  const schedule = (at: number) => {
    if (timer !== null) deps.clearTimer(timer);
    const earliest = lastUploadAt === null ? at : Math.max(at, lastUploadAt + PREVIEW_COOLDOWN_MS);
    timer = deps.setTimer(() => {
      timer = null;
      void run();
    }, Math.max(0, earliest - deps.now()));
  };

  /** A refusal that asks for a wait: Retry-After when it is a sensible number, else the default back-off. Never shortens a wait already set. */
  const backOff = (res: Response) => {
    const seconds = Number(res.headers.get('retry-after'));
    const ms = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, PREVIEW_RETRY_AFTER_MAX_MS) : PREVIEW_BACKOFF_MS;
    backoffUntil = Math.max(backoffUntil, deps.now() + ms);
  };

  /** One pass: ask for the source, draw it, upload it. Every refusal is answered here, quietly. */
  async function attempt(): Promise<Attempt> {
    const source = await deps.fetch(`${base}/preview-source`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    // 404: the board is off, or has nothing to draw (the card keeps its schematic); 401 and 403: the role is gone for this page.
    // All three stop the watch for this page load; a 413 (the board is too big to draw) waits the longest back-off there is.
    if (source.status === 404 || source.status === 401 || source.status === 403) {
      backoffUntil = Number.POSITIVE_INFINITY;
      return 'done';
    }
    if (source.status === 413) {
      backoffUntil = Math.max(backoffUntil, deps.now() + PREVIEW_RETRY_AFTER_MAX_MS);
      return 'done';
    }
    if (!source.ok) {
      backOff(source);
      return 'done';
    }
    const body = (await source.json()) as { objects?: unknown; rev?: unknown };
    const rev = revisionOf(body.rev);
    if (rev === null || !Array.isArray(body.objects)) return 'done';
    const objects = body.objects as Obj[];
    // an empty board has no picture: it keeps none, and its card shows the quiet tile (a blank sketch would be a lie)
    if (objects.length === 0) return 'done';
    const images = await embedImages(objects, boardId, (url, signal) => deps.fetch(url, {
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal, headers: { accept: 'image/*' },
    }));
    const svg = deps.picture(objects, images);
    const blob = await deps.rasterize(svg);
    // no encoding fits (Safari has no WebP encoder, and its PNG is too large): the old picture stays, nothing throws
    if (!blob) return 'done';
    const put = await deps.fetch(`${base}/preview`, {
      method: 'PUT', credentials: 'same-origin', headers: { 'content-type': blob.type, 'x-tabula': '1', 'x-preview-rev': rev }, body: blob,
    });
    lastUploadAt = deps.now();
    if (put.status === 204) {
      storedAt.set(boardId, deps.now());
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PREVIEW_STORED_EVENT, { detail: { boardId } }));
      return 'stored';
    }
    if (put.status === 409) return 'stale';
    if (put.status === 404 || put.status === 401 || put.status === 403) {
      backoffUntil = Number.POSITIVE_INFINITY;
      return 'done';
    }
    if (put.status === 429 || put.status === 503) backOff(put);
    if (put.status === 413) backoffUntil = Math.max(backoffUntil, deps.now() + PREVIEW_RETRY_AFTER_MAX_MS);
    return 'done';
  }

  /** The picture, asked again only when the revision moved while it was drawn; then the page waits for the next change or leave. */
  async function renderAndUpload(): Promise<void> {
    for (let tries = 1; tries <= PREVIEW_MAX_TRIES; tries += 1) {
      if ((await attempt()) !== 'stale') return;
    }
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
      // a tab hidden for a long time draws nothing; a board waiting out a refusal asks nothing
      if (deps.hiddenForMs() <= PREVIEW_HIDDEN_MS && deps.now() >= backoffUntil) await renderAndUpload();
    } catch {
      // a network failure or a malformed answer: wait, then the next change or the next leave tries again
      backoffUntil = Math.max(backoffUntil, deps.now() + PREVIEW_BACKOFF_MS);
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
