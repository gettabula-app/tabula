// The image machinery of one open board: the loader the renderer asks, and the queue that sends pending images to the
// relay. Created by BoardApp; the add flow (src/ui/image-add.ts) uses the same cache and queue.
import type { BoardApp } from './app';
import type { BaseObj } from './types';
import { assetUrl, isHash } from './images';
import { api } from './api';
import { createBlobCache, createUploadQueue, idbBackend, type UploadQueue, type UploadRecord, type UploadResult } from './asset-store';
import { ImageLoader } from './image-loader';
import { toast } from './ui/common';

/** One cache for the whole page: the bytes are the person's, not the board's. */
export const assetCache = createBlobCache(idbBackend());

/** Forget every stored image (signing out: the bytes are private to the signed-in person). */
export function clearAssetCache(): Promise<void> {
  return assetCache.clear();
}

const REFUSED: Record<number, string> = {
  400: 'The server could not read an image you added.',
  402: 'This board has used its image storage. Remove images you no longer need, or ask your administrator.',
  403: "You can't add images to this board.",
  404: 'An image could not be added: the board was not found.',
  413: 'An image you added is too large for this server.',
};

export class BoardImages {
  readonly loader: ImageLoader;
  readonly queue: UploadQueue;
  private timer = 0;

  constructor(private app: BoardApp) {
    const boardId = app.conn.id;
    this.loader = new ImageLoader({
      boardId,
      cache: assetCache,
      changed: (ids) => app.r.invalidateObjects(ids),
    });
    app.r.imageState = (o) => this.loader.state(o);
    this.queue = createUploadQueue({
      cache: assetCache,
      upload: async (id, blob, mime): Promise<UploadResult> => {
        const info = await api.uploadAsset(id, blob, mime);
        return { hash: info.hash, mime: info.mime, width: info.width, height: info.height };
      },
      apply: (rec, result) => this.apply(rec, result),
      onRefused: (_rec, status) => toast(REFUSED[status] ?? 'An image could not be uploaded.', 6000),
      canApply: (id) => id === boardId && !app.readOnly,
    });
    const run = () => void this.queue.run(boardId);
    const off = app.conn.onStatus((s) => {
      if (s === 'live') {
        this.loader.retryFailed();
        run();
      }
    });
    const onOnline = () => {
      this.loader.retryFailed();
      run();
    };
    window.addEventListener('online', onOnline, { signal: app.lifetime.signal });
    this.timer = window.setInterval(run, 30_000);
    app.lifetime.signal.addEventListener('abort', () => {
      off();
      window.clearInterval(this.timer);
      this.loader.destroy();
    }, { once: true });
    run();
  }

  /**
   * The picture of an image object as a data URL, for an export: the rasteriser behind PNG export cannot load a `blob:` or
   * a relay URL from inside an SVG. Null when the bytes are neither on this device nor on the relay.
   */
  async dataUrl(o: BaseObj): Promise<string | null> {
    const asset = (o as { asset?: string }).asset;
    if (typeof asset !== 'string') return null;
    let blob = (await assetCache.get(asset))?.blob;
    if (!blob && isHash(asset)) {
      try {
        const res = await fetch(assetUrl(this.app.conn.id, asset), { credentials: 'same-origin' });
        if (res.ok) blob = await res.blob();
      } catch {
        return null;
      }
    }
    if (!blob) return null;
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  }

  /** Writes the real hash into the image object. Not an undo step: undo should never bring the pending key back. */
  private apply(rec: UploadRecord, result: UploadResult): boolean {
    const store = this.app.store;
    const o = store.get(rec.objectId);
    if (!o || (o as { asset?: string }).asset !== rec.id) return false;
    store.transactAs(() => store.update(rec.objectId, { asset: result.hash, mime: result.mime, nw: result.width, nh: result.height }), 'assets');
    this.loader.alias(rec.id, result.hash);
    this.app.r.invalidateObjects([rec.objectId]);
    return true;
  }
}
