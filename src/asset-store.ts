// The browser's copy of the bytes behind image objects (docs/images.md, Offline and the upload queue).
//
// Two parts, both in IndexedDB (database `tabula-assets`, separate from the Yjs persistence):
//   blobs    key -> { blob, mime, width, height, boardId, at, pending }. The key is a content hash, or `pending:<id>` while
//            the bytes only exist on this device. A cache with a size cap; entries that still need uploading are never evicted.
//   uploads  { id, boardId, objectId, hash, tries, nextAt }: what still has to reach the server.
//
// The storage is behind `AssetBackend` so the queue's logic is tested with a memory one, as icon-offline does.
import { isPending } from './images';

export const BLOB_CACHE_BYTES = 200 * 1024 * 1024;

export interface BlobRecord {
  key: string;
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  boardId: string;
  /** Last use, for eviction. */
  at: number;
  /** True while the bytes still have to be uploaded: never evicted. */
  pending: boolean;
}

export interface UploadRecord {
  /** The pending key the object carries, `pending:<id>`. */
  id: string;
  boardId: string;
  objectId: string;
  /** What the browser computed from its own bytes; a hint only, the server's hash is the one that counts. */
  hash: string;
  tries: number;
  nextAt: number;
  /** When it was queued, so the oldest goes first. */
  at: number;
}

export interface AssetBackend {
  getBlob(key: string): Promise<BlobRecord | undefined>;
  putBlob(rec: BlobRecord): Promise<void>;
  deleteBlob(key: string): Promise<void>;
  listBlobs(): Promise<BlobRecord[]>;
  putUpload(rec: UploadRecord): Promise<void>;
  deleteUpload(id: string): Promise<void>;
  listUploads(): Promise<UploadRecord[]>;
  clear(): Promise<void>;
}

export function memoryBackend(): AssetBackend {
  const blobs = new Map<string, BlobRecord>();
  const uploads = new Map<string, UploadRecord>();
  return {
    getBlob: async (k) => blobs.get(k),
    putBlob: async (r) => void blobs.set(r.key, r),
    deleteBlob: async (k) => void blobs.delete(k),
    listBlobs: async () => [...blobs.values()],
    putUpload: async (r) => void uploads.set(r.id, r),
    deleteUpload: async (id) => void uploads.delete(id),
    listUploads: async () => [...uploads.values()],
    clear: async () => {
      blobs.clear();
      uploads.clear();
    },
  };
}

const DB_NAME = 'tabula-assets';

/** IndexedDB, opened lazily. Every call resolves (a failure to open acts as an empty, unwritable store) so images still show. */
export function idbBackend(): AssetBackend {
  let opened: Promise<IDBDatabase | null> | null = null;
  const open = () => (opened ??= new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('blobs', { keyPath: 'key' });
        req.result.createObjectStore('uploads', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
  const run = async <T>(store: 'blobs' | 'uploads', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | null, fallback: T): Promise<T> => {
    const db = await open();
    if (!db) return fallback;
    return new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
        tx.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  };
  return {
    getBlob: (k) => run<BlobRecord | undefined>('blobs', 'readonly', (s) => s.get(k), undefined),
    putBlob: (r) => run<void>('blobs', 'readwrite', (s) => s.put(r), undefined),
    deleteBlob: (k) => run<void>('blobs', 'readwrite', (s) => s.delete(k), undefined),
    listBlobs: () => run<BlobRecord[]>('blobs', 'readonly', (s) => s.getAll(), []),
    putUpload: (r) => run<void>('uploads', 'readwrite', (s) => s.put(r), undefined),
    deleteUpload: (id) => run<void>('uploads', 'readwrite', (s) => s.delete(id), undefined),
    listUploads: () => run<UploadRecord[]>('uploads', 'readonly', (s) => s.getAll(), []),
    clear: async () => {
      await run<void>('blobs', 'readwrite', (s) => s.clear(), undefined);
      await run<void>('uploads', 'readwrite', (s) => s.clear(), undefined);
    },
  };
}

/** Keys to drop so the cache fits `cap`: oldest first, never one that still has to be uploaded. */
export function evictionPlan(records: Pick<BlobRecord, 'key' | 'at' | 'pending'>[], sizes: Map<string, number>, cap = BLOB_CACHE_BYTES): string[] {
  let total = 0;
  for (const r of records) total += sizes.get(r.key) ?? 0;
  const out: string[] = [];
  for (const r of [...records].filter((x) => !x.pending).sort((a, b) => a.at - b.at)) {
    if (total <= cap) break;
    out.push(r.key);
    total -= sizes.get(r.key) ?? 0;
  }
  return out;
}

/** The cache over a backend: put, get (which marks a use) and eviction. */
export function createBlobCache(backend: AssetBackend, { cap = BLOB_CACHE_BYTES, now = Date.now } = {}) {
  return {
    backend,
    async get(key: string): Promise<BlobRecord | undefined> {
      const rec = await backend.getBlob(key);
      if (rec) void backend.putBlob({ ...rec, at: now() });
      return rec;
    },
    async put(rec: Omit<BlobRecord, 'at'>): Promise<void> {
      await backend.putBlob({ ...rec, at: now() });
      const all = await backend.listBlobs();
      const drop = evictionPlan(all, new Map(all.map((r) => [r.key, r.blob.size])), cap);
      for (const key of drop) await backend.deleteBlob(key);
    },
    /** The bytes of a pending key now belong to the hash the server gave. */
    async rekey(from: string, to: string): Promise<void> {
      const rec = await backend.getBlob(from);
      if (!rec) return;
      await backend.putBlob({ ...rec, key: to, pending: false, at: now() });
      await backend.deleteBlob(from);
    },
    clear: () => backend.clear(),
  };
}

export type BlobCache = ReturnType<typeof createBlobCache>;

// ---------------------------------------------------------------- upload queue

export interface UploadResult { hash: string; mime: string; width: number; height: number }

/** What the queue needs from the page. */
export interface QueueDeps {
  cache: BlobCache;
  /** Sends the bytes. Rejects with an object that has a numeric `status` (0 for no network). */
  upload: (boardId: string, blob: Blob, mime: string) => Promise<UploadResult>;
  /**
   * Writes the real hash into the object, in one transaction. False when the object is gone or no longer points at the
   * pending key (deleted, or replaced); the queue then drops the record.
   */
  apply: (rec: UploadRecord, result: UploadResult) => boolean;
  /** A refusal that will not go away by waiting: tell the person. */
  onRefused?: (rec: UploadRecord, status: number, code: string) => void;
  now?: () => number;
  /** Boards whose objects can be written right now (the one that is open). */
  canApply?: (boardId: string) => boolean;
  parallel?: number;
}

export const backoffMs = (tries: number) => Math.min(60_000, 1000 * 2 ** Math.min(tries, 6));

/** Statuses that will not change by trying again: the record is dropped and the person told. */
const FINAL = new Set([400, 402, 403, 404, 413]);

export function createUploadQueue(deps: QueueDeps) {
  const { cache } = deps;
  const now = deps.now ?? Date.now;
  const parallel = deps.parallel ?? 3;
  let running: Promise<void> | null = null;
  const inFlight = new Set<string>();

  async function one(rec: UploadRecord): Promise<void> {
    inFlight.add(rec.id);
    try {
      const blob = await cache.backend.getBlob(rec.id);
      if (!blob) {
        await cache.backend.deleteUpload(rec.id);
        return;
      }
      try {
        const result = await deps.upload(rec.boardId, blob.blob, blob.mime);
        const applied = deps.apply(rec, result);
        if (applied) await cache.rekey(rec.id, result.hash);
        else await cache.backend.deleteBlob(rec.id);
        await cache.backend.deleteUpload(rec.id);
      } catch (err) {
        const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 0;
        const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
        if (FINAL.has(status)) {
          await cache.backend.deleteUpload(rec.id);
          deps.onRefused?.(rec, status, code);
        } else {
          await cache.backend.putUpload({ ...rec, tries: rec.tries + 1, nextAt: now() + backoffMs(rec.tries) });
        }
      }
    } finally {
      inFlight.delete(rec.id);
    }
  }

  async function pass(boardId?: string): Promise<void> {
    const due = (await cache.backend.listUploads())
      .filter((r) => r.nextAt <= now() && !inFlight.has(r.id) && (boardId === undefined || r.boardId === boardId) && (deps.canApply?.(r.boardId) ?? true))
      .sort((a, b) => a.at - b.at);
    for (let i = 0; i < due.length; i += parallel) await Promise.all(due.slice(i, i + parallel).map(one));
  }

  return {
    /** Remembers that a pending image has to be uploaded. */
    async enqueue(rec: Omit<UploadRecord, 'tries' | 'nextAt' | 'at'>): Promise<void> {
      await cache.backend.putUpload({ ...rec, tries: 0, nextAt: 0, at: now() });
    },
    /** One pass over what is due. Calls do not overlap: a second call waits for the first and then runs again. */
    run(boardId?: string): Promise<void> {
      const next = (running ?? Promise.resolve()).then(() => pass(boardId));
      running = next.finally(() => {
        if (running === next) running = null;
      });
      return next;
    },
    pending: async (boardId?: string) => (await cache.backend.listUploads()).filter((r) => boardId === undefined || r.boardId === boardId).length,
    /** Forget uploads of an object that was deleted. */
    async drop(id: string): Promise<void> {
      await cache.backend.deleteUpload(id);
    },
  };
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;

export { isPending };
