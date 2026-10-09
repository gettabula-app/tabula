import { describe, expect, it, vi } from 'vitest';
import { BLOB_CACHE_BYTES, backoffMs, createBlobCache, createUploadQueue, evictionPlan, memoryBackend, type UploadRecord, type UploadResult } from '../src/asset-store';

// docs/images.md, Offline and the upload queue: pending images reach the server, in order, with backoff, and a deleted
// object drops its record. The storage is injected, as icon-offline does.

const blob = (n: number, type = 'image/png') => new Blob([new Uint8Array(n)], { type });
const RESULT: UploadResult = { hash: 'a'.repeat(64), mime: 'image/png', width: 4, height: 3 };

function setup(over: Partial<Parameters<typeof createUploadQueue>[0]> = {}) {
  let t = 1000;
  const backend = memoryBackend();
  const cache = createBlobCache(backend, { now: () => t });
  const upload = vi.fn<(boardId: string, blob: Blob, mime: string) => Promise<UploadResult>>(async () => RESULT);
  const apply = vi.fn<(rec: UploadRecord, res: UploadResult) => boolean>(() => true);
  const onRefused = vi.fn<(rec: UploadRecord, status: number, code: string) => void>();
  const queue = createUploadQueue({ cache, upload, apply, onRefused, now: () => t, ...over });
  const add = async (id: string, objectId = `o-${id}`, boardId = 'b1') => {
    await cache.put({ key: `pending:${id}`, blob: blob(10), mime: 'image/png', width: 4, height: 3, boardId, pending: true });
    await queue.enqueue({ id: `pending:${id}`, boardId, objectId, hash: 'h' });
    t += 1;
  };
  return { backend, cache, queue, upload, apply, onRefused, add, tick: (ms: number) => (t += ms) };
}

describe('the upload queue', () => {
  it('uploads a pending image, writes the hash into its object and moves the bytes to the hash', async () => {
    const s = setup();
    await s.add('1');
    await s.queue.run('b1');
    expect(s.upload).toHaveBeenCalledWith('b1', expect.any(Blob), 'image/png');
    expect(s.apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending:1', objectId: 'o-1' }), RESULT);
    expect(await s.queue.pending()).toBe(0);
    expect(await s.backend.getBlob('pending:1')).toBeUndefined();
    expect(await s.backend.getBlob(RESULT.hash)).toMatchObject({ pending: false, key: RESULT.hash });
  });

  it('sends three at a time', async () => {
    let running = 0;
    let peak = 0;
    const s = setup({
      upload: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return RESULT;
      },
    });
    for (const id of ['1', '2', '3', '4', '5']) await s.add(id);
    await s.queue.run();
    expect(peak).toBe(3);
    expect(await s.queue.pending()).toBe(0);
  });

  it('sends the oldest first', async () => {
    const applied: string[] = [];
    const s = setup({ parallel: 1, apply: (rec) => { applied.push(rec.objectId); return true; } });
    for (const id of ['3', '1', '2']) await s.add(id);
    await s.queue.run();
    expect(applied).toEqual(['o-3', 'o-1', 'o-2']);
  });

  it('keeps a failed upload for later with a growing delay', async () => {
    const s = setup({ upload: async () => { throw Object.assign(new Error('offline'), { status: 0 }); } });
    await s.add('1');
    await s.queue.run();
    const [rec] = await s.backend.listUploads();
    expect(rec.tries).toBe(1);
    expect(rec.nextAt).toBe(1001 + backoffMs(0));
    await s.queue.run(); // not due yet: nothing is tried
    expect((await s.backend.listUploads())[0].tries).toBe(1);
    s.tick(backoffMs(0) + 5);
    await s.queue.run();
    expect((await s.backend.listUploads())[0].tries).toBe(2);
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(50)).toBe(60_000);
  });

  it.each([400, 402, 403, 404, 413])('drops the record and says so on a %i, which waiting will not fix', async (status) => {
    const s = setup({ upload: async () => { throw Object.assign(new Error('no'), { status, code: 'x' }); } });
    await s.add('1');
    await s.queue.run();
    expect(await s.queue.pending()).toBe(0);
    expect(s.onRefused).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending:1' }), status, 'x');
    expect(await s.backend.getBlob('pending:1')).toBeDefined(); // the bytes stay on this device
  });

  it.each([0, 401, 429, 500, 502])('keeps the record on a %i', async (status) => {
    const s = setup({ upload: async () => { throw Object.assign(new Error('later'), { status }); } });
    await s.add('1');
    await s.queue.run();
    expect(await s.queue.pending()).toBe(1);
    expect(s.onRefused).not.toHaveBeenCalled();
  });

  it('drops the record and the bytes when the object is gone', async () => {
    const s = setup({ apply: () => false });
    await s.add('1');
    await s.queue.run();
    expect(await s.queue.pending()).toBe(0);
    expect(await s.backend.getBlob('pending:1')).toBeUndefined();
    expect(await s.backend.getBlob(RESULT.hash)).toBeUndefined();
  });

  it('drops a record whose bytes are missing', async () => {
    const s = setup();
    await s.queue.enqueue({ id: 'pending:ghost', boardId: 'b1', objectId: 'o', hash: 'h' });
    await s.queue.run();
    expect(await s.queue.pending()).toBe(0);
    expect(s.upload).not.toHaveBeenCalled();
  });

  it('works on one board at a time and only on a board that can be written now', async () => {
    const s = setup({ canApply: (id) => id === 'b1' });
    await s.add('1', 'o1', 'b1');
    await s.add('2', 'o2', 'b2');
    await s.queue.run();
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(await s.queue.pending('b2')).toBe(1);
    expect(await s.queue.pending('b1')).toBe(0);
    const only = setup();
    await only.add('1', 'o1', 'b1');
    await only.add('2', 'o2', 'b2');
    await only.queue.run('b2');
    expect(only.upload).toHaveBeenCalledTimes(1);
    expect(await only.queue.pending('b1')).toBe(1);
  });

  it('does not start the same record twice when runs overlap', async () => {
    const s = setup({ upload: async () => { await new Promise((r) => setTimeout(r, 10)); return RESULT; } });
    await s.add('1');
    await Promise.all([s.queue.run(), s.queue.run()]);
    expect(s.apply).toHaveBeenCalledTimes(1);
  });

  it('can forget an upload', async () => {
    const s = setup();
    await s.add('1');
    await s.queue.drop('pending:1');
    expect(await s.queue.pending()).toBe(0);
  });
});

describe('the blob cache', () => {
  const rec = (key: string, size: number, pending = false) => ({ key, blob: blob(size), mime: 'image/png', width: 1, height: 1, boardId: 'b', pending });

  it('plans which entries to drop: oldest first, never one still to be uploaded', () => {
    const records = [
      { key: 'a', at: 1, pending: false }, { key: 'b', at: 2, pending: true }, { key: 'c', at: 3, pending: false }, { key: 'd', at: 4, pending: false },
    ];
    const sizes = new Map([['a', 50], ['b', 50], ['c', 50], ['d', 50]]);
    expect(evictionPlan(records, sizes, 200)).toEqual([]);
    expect(evictionPlan(records, sizes, 120)).toEqual(['a', 'c']);
    expect(evictionPlan(records, sizes, 0)).toEqual(['a', 'c', 'd']);
    expect(BLOB_CACHE_BYTES).toBe(200 * 1024 * 1024);
  });

  it('evicts on put and marks a use on get', async () => {
    let t = 0;
    const cache = createBlobCache(memoryBackend(), { cap: 25, now: () => ++t });
    await cache.put(rec('old', 10));
    await cache.put(rec('keep', 10));
    await cache.get('old'); // used more recently than 'keep'
    await new Promise((r) => setTimeout(r)); // the use is written without waiting
    await cache.put(rec('new', 10));
    expect(await cache.backend.getBlob('keep')).toBeUndefined();
    expect(await cache.backend.getBlob('old')).toBeDefined();
    expect(await cache.backend.getBlob('new')).toBeDefined();
  });

  it('rekeys pending bytes to their hash and can be cleared', async () => {
    const cache = createBlobCache(memoryBackend());
    await cache.put(rec('pending:1', 5, true));
    await cache.rekey('pending:1', 'h1');
    expect(await cache.backend.getBlob('pending:1')).toBeUndefined();
    expect(await cache.backend.getBlob('h1')).toMatchObject({ key: 'h1', pending: false });
    await cache.rekey('missing', 'h2');
    await cache.clear();
    expect(await cache.backend.listBlobs()).toEqual([]);
  });
});
