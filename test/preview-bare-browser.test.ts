import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { deflateSync } from 'node:zlib';
import { validatePreviewImage } from '../server/preview-image.mjs';
import type { Obj } from '../src/types';
import { budget } from './wait-budget';

// The board picture drawn in a real Chromium on a bare page (test/preview-bare-entry.ts): the export of hostile text, a board image that is
// downscaled before it is embedded, and an image that points outside the site. The page loads none of the app (no board.ts, so no Fontshare
// requests). Every request is recorded: none may leave this origin, the encoded picture is a WebP or PNG of at most 40 KB, and a 'blocks'
// picture is drawn only when the export fails.

const PICTURE_CAP = 40_960;
const SHRUNK_CAP = 150_000;
const IMAGE_HASH = 'c'.repeat(64);
const BOARD = 'bare-board';

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let origin = '';
let bigPng: Buffer;
const available = existsSync(chromium.executablePath());

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A real PNG of a plain pattern, `width` x `height`: large enough to need the downscale, and compressible. */
function pngOf(width: number, height: number): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * row + 1 + x * 3;
      raw[o] = (x * 5) & 255;
      raw[o + 1] = (y * 7) & 255;
      raw[o + 2] = ((x ^ y) * 3) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The page: one module, served by the dev server, and nothing else. */
const PAGE = '<!doctype html><meta charset="utf-8"><title>picture</title><script type="module" src="/test/preview-bare-entry.ts"></script>';

beforeAll(async () => {
  if (!available) return;
  bigPng = pngOf(1200, 800);
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'preview-bare-page',
      configureServer(dev) {
        dev.middlewares.use((req, res, next) => {
          if (req.url === '/__picture') {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(PAGE);
            return;
          }
          if (req.url === `/api/boards/${BOARD}/assets/${IMAGE_HASH}`) {
            res.setHeader('content-type', 'image/png');
            res.setHeader('content-length', String(bigPng.length));
            res.end(bigPng);
            return;
          }
          next();
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const HOSTILE = [
  '<script>alert("pwned")</script>',
  '</text><foreignObject><div>x</div></foreignObject><text>',
  ']]> <![CDATA[ still text',
  'url(http://evil.example/a.css) @import "http://evil.example/b.css";',
  '&amp; &lt;b&gt; &#60;img src=x&#62;',
  'مرحبا بالعالم  ‮flip‬',
  'z'.repeat(6000),
].join('\n');

const OBJECTS: Obj[] = [
  { id: 'note', type: 'sticky', text: HOSTILE, fill: '#FFE16B', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'note' } as Obj,
  { id: 'outside', type: 'image', asset: 'https://evil.example/p.png', mime: 'image/png', nw: 8, nh: 8, x: 300, y: 0, w: 120, h: 90, rotation: 0, z: 'outside' } as Obj,
  { id: 'photo', type: 'image', asset: IMAGE_HASH, mime: 'image/png', nw: 1200, nh: 800, x: 300, y: 120, w: 160, h: 110, rotation: 0, z: 'photo' } as Obj,
];

type Picture = {
  mode: string;
  reason: string | null;
  images: string[];
  imageTypes: string[];
  imageBytes: number[];
  blob: { type: string; size: number; bytes: number[] } | null;
};

/** A page of its own, with every request it makes recorded. */
async function openPage(): Promise<{ page: Page; requests: string[] }> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(budget(45_000));
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${origin}/__picture`);
  await page.waitForFunction(() => typeof (window as unknown as { runPicture?: unknown }).runPicture === 'function');
  return { page, requests };
}

/** The requests that leave the origin: any http or https address that is not this server. Data and blob addresses stay local. */
function leaving(requests: string[]): string[] {
  return requests.filter((url) => {
    const { protocol, origin: other } = new URL(url);
    if (protocol === 'data:' || protocol === 'blob:') return false;
    return other !== origin;
  });
}

describe.skipIf(!available)('the board picture on a bare page in Chromium', () => {
  it('draws hostile text and an outside image into a picture of at most 40 KB, and makes no request outside this origin', async () => {
    const { page, requests } = await openPage();
    try {
      const picture = await page.evaluate(
        ([objects, boardId]) => (window as unknown as { runPicture: (o: unknown, b: string) => Promise<unknown> }).runPicture(objects, boardId),
        [OBJECTS, BOARD] as const,
      ) as Picture;
      expect(picture.blob).not.toBeNull();
      expect(picture.blob!.size).toBeLessThanOrEqual(PICTURE_CAP);
      const type = picture.blob!.type as 'image/png' | 'image/webp';
      expect(['image/png', 'image/webp']).toContain(type);
      expect(validatePreviewImage(Buffer.from(picture.blob!.bytes), type)).toMatchObject({ ok: true, width: 480, height: 300 });
      expect(picture.mode === 'export' || (picture.reason ?? '').startsWith('the export failed')).toBe(true);
      expect(leaving(requests)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('embeds only the board image, downscaled and re-encoded; the outside image is never fetched', async () => {
    const { page, requests } = await openPage();
    try {
      const picture = await page.evaluate(
        ([objects, boardId]) => (window as unknown as { runPicture: (o: unknown, b: string) => Promise<unknown> }).runPicture(objects, boardId),
        [OBJECTS, BOARD] as const,
      ) as Picture;
      expect(picture.images).toEqual(['photo']);
      expect(['image/webp', 'image/jpeg']).toContain(picture.imageTypes[0]);
      // a data address: base64 of at most SHRUNK_CAP bytes, and a short prefix
      expect(picture.imageBytes[0]!).toBeLessThanOrEqual(Math.ceil((SHRUNK_CAP * 4) / 3) + 64);
      expect(requests.some((url) => url.includes('evil.example'))).toBe(false);
      expect(leaving(requests)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('when no encoding fits (Safari: no WebP, PNG too large), the picture is null and nothing throws', async () => {
    const { page, requests } = await openPage();
    try {
      await page.evaluate(() => {
        HTMLCanvasElement.prototype.toBlob = function toBlobNull(callback: BlobCallback) {
          callback(null);
        } as HTMLCanvasElement['toBlob'];
      });
      const picture = await page.evaluate(
        ([objects, boardId]) => (window as unknown as { runPicture: (o: unknown, b: string) => Promise<unknown> }).runPicture(objects, boardId),
        [OBJECTS, BOARD] as const,
      ) as Picture;
      expect(picture.blob).toBeNull();
      expect(leaving(requests)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
