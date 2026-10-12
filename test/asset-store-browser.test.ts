import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// The pending-image cache and upload queue over a real IndexedDB (Chromium): what two tabs of one board do to each other, and what
// a store that refuses writes does to an image the person just added.

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!available) return;
  server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  base = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function tab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' }));
  await page.goto(`${base}__blank`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import { createBlobCache, createUploadQueue, idbBackend } from '/src/asset-store.ts';
      const cache = createBlobCache(idbBackend());
      const log = { uploads: 0, lost: 0, applied: 0 };
      // a slow server, so the two tabs overlap
      const queue = createUploadQueue({
        cache,
        upload: async () => { log.uploads++; await new Promise((r) => setTimeout(r, 150)); return { hash: 'a'.repeat(64), mime: 'image/png', width: 4, height: 3 }; },
        apply: () => { log.applied++; return true; },
        onLost: () => { log.lost++; },
        canApply: () => true,
      });
      window.__q = { cache, queue, log };
      window.__ready = true;
    `,
  });
  await page.waitForFunction('window.__ready === true');
  return page;
}

describe.skipIf(!available)('pending images over IndexedDB', () => {
  it('uploads an added image once', async () => {
    const context = await browser!.newContext();
    const page = await tab(context);
    const result = await page.evaluate(async () => {
      const { cache, queue, log } = (window as any).__q;
      await cache.put({ key: 'pending:one', blob: new Blob([new Uint8Array(1000)], { type: 'image/png' }), mime: 'image/png', width: 4, height: 3, boardId: 'b1', pending: true });
      await queue.enqueue({ id: 'pending:one', boardId: 'b1', objectId: 'o1', hash: 'x' });
      await queue.run('b1');
      return { ...log, left: await queue.pending('b1') };
    });
    expect(result).toEqual({ uploads: 1, lost: 0, applied: 1, left: 0 });
    await context.close();
  });

  it('does not call an image lost when another tab of the same board has just uploaded it', async () => {
    const context = await browser!.newContext();
    const [a, b] = [await tab(context), await tab(context)];
    await a.evaluate(async () => {
      const { cache, queue } = (window as any).__q;
      for (let i = 0; i < 6; i++) {
        await cache.put({ key: `pending:${i}`, blob: new Blob([new Uint8Array(1000)], { type: 'image/png' }), mime: 'image/png', width: 4, height: 3, boardId: 'b1', pending: true });
        await queue.enqueue({ id: `pending:${i}`, boardId: 'b1', objectId: `o${i}`, hash: 'x' });
      }
    });
    const [ra, rb] = await Promise.all([a, b].map((p) => p.evaluate(async () => {
      const { queue, log } = (window as any).__q;
      await queue.run('b1');
      return log;
    })));
    const lost = ra.lost + rb.lost;
    const leftover = await a.evaluate(async () => (window as any).__q.queue.pending('b1'));
    expect({ lost, leftover }).toEqual({ lost: 0, leftover: 0 });
    await context.close();
  });

  it('says so when the browser refuses to keep the image, instead of queueing an upload with no bytes', async () => {
    const context = await browser!.newContext();
    const page = await tab(context);
    const outcome = await page.evaluate(async () => {
      const { cache } = (window as any).__q;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
      try {
        await cache.put({ key: 'pending:q', blob: new Blob([new Uint8Array(10)]), mime: 'image/png', width: 1, height: 1, boardId: 'b1', pending: true });
        return 'stored';
      } catch (e) {
        return `refused:${(e as Error).name}`;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
    });
    expect(outcome).toBe('refused:StorageError');
    await context.close();
  });
});
