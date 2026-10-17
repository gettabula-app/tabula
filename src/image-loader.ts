// Where the renderer gets the pixels of an image object from (docs/images.md, Rendering). One answer per object, ready
// to draw: a `blob:` URL when the bytes are here, otherwise why they are not. The bytes come from this device's cache
// first (an image just added, or one seen before), then from the board's asset route. Nothing here throws.
import type { BaseObj, Id } from './types';
import { assetUrl, imageFields, isHash, isPending } from './images';
import type { BlobCache } from './asset-store';
import { IMAGE_UPLOAD_MESSAGES } from './image-messages';

export type ImageState =
  | { kind: 'ok'; url: string }
  | { kind: 'loading' }
  /** Why there is nothing to draw: shown on the placeholder. */
  | { kind: 'failed'; why: 'not_uploaded' | 'lost' | 'toobig' | 'offline' | 'denied' | 'missing' | 'invalid' };

export const FAILED_LABEL: Record<Extract<ImageState, { kind: 'failed' }>['why'], string> = {
  not_uploaded: 'Image not uploaded yet',
  lost: 'Not uploaded: add this image again',
  toobig: IMAGE_UPLOAD_MESSAGES.tooBigLabel,
  offline: 'Offline',
  denied: 'No access to this image',
  missing: 'Image not found',
  invalid: 'Image can not be shown',
};

/** The path of a `Response` for a blob: what the loader needs from `fetch`. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'blob'>>;

export interface LoaderDeps {
  boardId: string;
  cache: BlobCache;
  fetchFn?: FetchFn;
  /** The local queue state for a pending asset, when this browser has an upload record. */
  uploadState?: (asset: string) => Promise<'queued' | 'lost' | 'refused' | 'toobig' | undefined>;
  /** Called with the ids of the objects whose answer changed, so the renderer redraws them. */
  changed: (ids: Id[]) => void;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

/** How long a cache read may take before the network answers instead: a read that never returns must not hold the picture on "Loading". */
export const CACHE_READ_MS = 5_000;
/** How long one download may take, headers and body together, before it counts as offline. */
export const FETCH_MS = 15_000;

/** `p` when it settles within `ms`, otherwise undefined. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export class ImageLoader {
  private states = new Map<string, ImageState>();
  private waiting = new Map<string, Set<Id>>();
  private urls = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private attempts = new Map<string, number>();
  private destroyed = false;
  private fetchFn: FetchFn;
  private createUrl: (blob: Blob) => string;
  private revokeUrl: (url: string) => void;

  constructor(private deps: LoaderDeps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.createUrl = deps.createUrl ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = deps.revokeUrl ?? ((u) => URL.revokeObjectURL(u));
  }

  /** The answer for an image object right now. Starts loading when there is none. */
  state(o: BaseObj): ImageState {
    const f = imageFields(o);
    if (!f) return { kind: 'failed', why: 'invalid' };
    // every object that asks is registered, not only the first: a second object with the same picture must be redrawn too
    let set = this.waiting.get(f.asset);
    if (!set) this.waiting.set(f.asset, (set = new Set()));
    set.add(o.id);
    const known = this.states.get(f.asset);
    if (known) return known;
    const loading: ImageState = { kind: 'loading' };
    this.states.set(f.asset, loading);
    void this.load(f.asset);
    return loading;
  }

  /** Forget retryable failures so the next draw asks for the current queue state again. */
  retryFailed() {
    for (const [asset, s] of this.states) {
      if (s.kind === 'failed' && (s.why === 'offline' || s.why === 'denied' || s.why === 'not_uploaded' || s.why === 'lost' || s.why === 'toobig' || s.why === 'missing')) {
        this.cancelRetry(asset);
        this.set(asset, undefined, true);
      }
    }
  }

  /** The object that carried `pending:<id>` now carries a hash: its bytes are already here, so show them without a download. */
  alias(pendingKey: string, hash: string) {
    const s = this.states.get(pendingKey);
    if (s?.kind === 'ok') this.states.set(hash, s);
  }

  destroy() {
    this.destroyed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.attempts.clear();
    for (const u of this.urls) this.revokeUrl(u);
    this.urls.clear();
    this.states.clear();
    this.waiting.clear();
  }

  /** An offline answer asks again by itself: after 15 s, then 30 s, then every 60 s, so a picture that stays offline does not poll. */
  private scheduleRetry(asset: string) {
    clearTimeout(this.timers.get(asset));
    const n = this.attempts.get(asset) ?? 0;
    this.attempts.set(asset, n + 1);
    this.timers.set(asset, setTimeout(() => {
      this.timers.delete(asset);
      const s = this.states.get(asset);
      if (s?.kind === 'failed' && s.why === 'offline') this.set(asset, undefined, true);
    }, Math.min(15_000 * 2 ** n, 60_000)));
  }

  /** Drops a pending retry and starts the backoff over. */
  private cancelRetry(asset: string) {
    clearTimeout(this.timers.get(asset));
    this.timers.delete(asset);
    this.attempts.delete(asset);
  }

  private set(asset: string, state: ImageState | undefined, redraw = false) {
    if (this.destroyed) return;
    if (state) this.states.set(asset, state);
    else this.states.delete(asset);
    if (state?.kind === 'ok') this.attempts.delete(asset);
    if (state?.kind === 'failed' && state.why === 'offline') this.scheduleRetry(asset);
    const ids = this.waiting.get(asset);
    if (ids?.size && (state || redraw)) this.deps.changed([...ids]);
  }

  private async load(asset: string): Promise<void> {
    try {
      // a cache read that never answers is a miss: the network path below still answers
      const local = await within(this.deps.cache.get(asset), CACHE_READ_MS).catch(() => undefined);
      if (this.destroyed) return;
      if (local) return this.ready(asset, local.blob);
      if (isPending(asset)) {
        let state: Awaited<ReturnType<NonNullable<LoaderDeps['uploadState']>>>;
        try {
          state = await within(Promise.resolve(this.deps.uploadState?.(asset)), CACHE_READ_MS);
        } catch {
          state = undefined;
        }
        if (this.destroyed) return;
        return this.set(asset, { kind: 'failed', why: state === 'toobig' ? 'toobig' : state === 'lost' || state === 'refused' ? 'lost' : 'not_uploaded' });
      }
      if (!isHash(asset)) return this.set(asset, { kind: 'failed', why: 'invalid' });
      // one deadline for the whole download, headers and body: a stalled answer must not leave the picture on "Loading"
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error('timeout'));
        }, FETCH_MS);
      });
      let blob: Blob;
      try {
        const res = await Promise.race([deadline, this.fetchFn(assetUrl(this.deps.boardId, asset), { credentials: 'same-origin', signal: abort.signal })]);
        if (!res.ok) {
          const why = res.status === 401 || res.status === 403 ? 'denied' : res.status === 404 ? 'missing' : 'offline';
          return this.set(asset, { kind: 'failed', why });
        }
        // raced too: a body that ignores the abort signal must still meet the deadline
        blob = await Promise.race([deadline, res.blob()]);
      } catch {
        return this.set(asset, { kind: 'failed', why: 'offline' });
      } finally {
        clearTimeout(timer);
      }
      if (this.destroyed) return;
      // keeping a copy is a courtesy: the picture is shown from the bytes in hand even when the store refuses them
      await this.deps.cache.put({ key: asset, blob, mime: blob.type, width: 0, height: 0, boardId: this.deps.boardId, pending: false }).catch(() => undefined);
      this.ready(asset, blob);
    } catch {
      this.set(asset, { kind: 'failed', why: 'offline' });
    }
  }

  private ready(asset: string, blob: Blob) {
    if (this.destroyed) return;
    const url = this.createUrl(blob);
    this.urls.add(url);
    this.set(asset, { kind: 'ok', url });
  }
}
