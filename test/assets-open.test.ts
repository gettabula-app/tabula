import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness } from './mcp-harness';
import { SECRET, containsSecret, makeGif, makeJpeg, makePng, makeWebp } from './image-fixtures';

// Images on a board, open mode (docs/images.md): no accounts, so no cookie. A write needs the x-tabula header.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

type Reply = { status: number; body: any; headers: Headers };

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'content-disposition': 'inline; filename="image"',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, max-age=31536000, immutable',
};

const parse = async (res: Response) => {
  const text = await res.text();
  return text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
};

function openHarness(settings: Record<string, string> = {}) {
  const h = createHarness({ settings });

  /** A raw-bytes upload. `csrf: false` leaves out x-tabula. */
  async function upload(board: string, bytes: Buffer, type: string, { csrf = true }: { csrf?: boolean } = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': type };
    if (csrf) headers['x-tabula'] = '1';
    const res = await fetch(`${h.base}/api/boards/${board}/assets`, { method: 'POST', headers, body: new Uint8Array(bytes) });
    return { status: res.status, body: await parse(res), headers: res.headers };
  }

  /** GET or HEAD of one asset; `segment` is the raw path piece. */
  async function fetchAsset(board: string, segment: string, { method = 'GET', headers = {} as Record<string, string> } = {}) {
    const res = await fetch(`${h.base}/api/boards/${board}/assets/${segment}`, { method, headers: { 'x-tabula': '1', ...headers } });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  /** A claim, with the x-tabula header unless `csrf` is false. */
  async function claim(board: string, body: unknown, { csrf = true }: { csrf?: boolean } = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (csrf) headers['x-tabula'] = '1';
    const res = await fetch(`${h.base}/api/boards/${board}/assets/claim`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await parse(res), headers: res.headers };
  }

  return { h, upload, fetchAsset, claim };
}

const expectStoredHeaders = (headers: Headers, mime: string, hash: string) => {
  expect(headers.get('content-type')).toBe(mime);
  expect(headers.get('etag')).toBe(`"${hash}"`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect([name, headers.get(name)]).toEqual([name, value]);
};

// ---------------------------------------------------------------- the main harness

describe('open mode', () => {
  const { h, upload, fetchAsset, claim } = openHarness();
  const newBoard = () => h.unique('open');

  beforeAll(async () => {
    await h.start();
  });

  afterAll(() => h.cleanup());

  it('an upload gets 201, and the same content again on that board gets 200 with the same body', async () => {
    const board = newBoard();
    const bytes = makePng({ width: 4, height: 3 });
    const first = await upload(board, bytes, 'image/png');
    expect(first.status).toBe(201);
    expect(Object.keys(first.body).sort()).toEqual(['bytes', 'hash', 'height', 'mime', 'width']);
    expect(first.body).toMatchObject({ mime: 'image/png', width: 4, height: 3 });
    const again = await upload(board, bytes, 'image/png');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
  });

  it('an upload without the x-tabula header gets 403 csrf', async () => {
    const res = await upload(newBoard(), makePng(), 'image/png', { csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf');
  });

  it.each([
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['text/html', Buffer.from('<html></html>')],
    ['application/octet-stream', makePng()],
  ])('a declared type of %s gets 400 unsupported_type', async (type, bytes) => {
    const res = await upload(newBoard(), bytes, type);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_type');
  });

  it('a PNG declared as PNG but holding JPEG bytes gets 400 bad_image', async () => {
    const res = await upload(newBoard(), makeJpeg(), 'image/png');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_image');
  });

  it('the GET returns the stored, stripped bytes with the exact headers', async () => {
    const board = newBoard();
    const dirty = makeJpeg({ exif: true, xmp: true, comment: true });
    const up = await upload(board, dirty, 'image/jpeg');
    expect(up.status).toBe(201);
    const res = await fetchAsset(board, up.body.hash);
    expect(res.status).toBe(200);
    expectStoredHeaders(res.headers, 'image/jpeg', up.body.hash);
    expect(sha256(res.bytes)).toBe(up.body.hash);
    expect(up.body.hash).not.toBe(sha256(dirty));
    expect(containsSecret(res.bytes)).toBe(false);
    expect(res.bytes.includes(Buffer.from(SECRET, 'latin1'))).toBe(false);
  });

  it('a matching If-None-Match gets 304 with the ETag and the security headers', async () => {
    const board = newBoard();
    const up = await upload(board, makeGif(), 'image/gif');
    const res = await fetchAsset(board, up.body.hash, { headers: { 'if-none-match': `"${up.body.hash}"` } });
    expect(res.status).toBe(304);
    expect(res.bytes.length).toBe(0);
    expect(res.headers.get('etag')).toBe(`"${up.body.hash}"`);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect([name, res.headers.get(name)]).toEqual([name, value]);
  });

  it('HEAD has the same headers as GET and no body', async () => {
    const board = newBoard();
    const up = await upload(board, makeWebp({ exif: true }), 'image/webp');
    const res = await fetchAsset(board, up.body.hash, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.bytes.length).toBe(0);
    expectStoredHeaders(res.headers, 'image/webp', up.body.hash);
  });

  it('a GET for a hash the board does not have gets 404', async () => {
    expect((await fetchAsset(newBoard(), 'a'.repeat(64))).status).toBe(404);
  });

  it('a board id with characters outside the allowed set gets 404', async () => {
    const res = await fetchAsset('bad%20id', 'a'.repeat(64));
    expect(res.status).toBe(404);
  });

  it('a hash on one board is 404 on another until it is claimed, then the bytes read there too', async () => {
    const source = newBoard();
    const target = newBoard();
    const up = await upload(source, makePng({ width: 5, height: 5 }), 'image/png');
    expect((await fetchAsset(target, up.body.hash)).status).toBe(404);
    const claimed = await claim(target, { hash: up.body.hash });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ hash: up.body.hash, mime: 'image/png' });
    const read = await fetchAsset(target, up.body.hash);
    expect(read.status).toBe(200);
    expectStoredHeaders(read.headers, 'image/png', up.body.hash);
  });

  it('a claim of a hash that no board has gets 404, a malformed one 400, and one without x-tabula 403', async () => {
    expect((await claim(newBoard(), { hash: 'b'.repeat(64) })).status).toBe(404);
    expect((await claim(newBoard(), { hash: 'nope' })).status).toBe(400);
    expect((await claim(newBoard(), { hash: 'b'.repeat(64) }, { csrf: false })).status).toBe(403);
  });

  it('the files and index.json survive a restart, and the bytes read back the same', async () => {
    const board = newBoard();
    const up = await upload(board, makeJpeg({ exif: true }), 'image/jpeg');
    expect(up.status).toBe(201);
    const root = path.join(h.dir, 'assets');
    expect(fs.existsSync(path.join(root, 'index.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, up.body.hash.slice(0, 2), up.body.hash))).toBe(true);
    const before = await fetchAsset(board, up.body.hash);
    await h.stop();
    await h.start();
    const after = await fetchAsset(board, up.body.hash);
    expect(after.status).toBe(200);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expectStoredHeaders(after.headers, 'image/jpeg', up.body.hash);
    expect((await upload(board, makeJpeg({ exif: true }), 'image/jpeg')).status).toBe(200);
  });

  it('/api/config says images: true', async () => {
    const config = await h.api(undefined, 'GET', '/api/config');
    expect(config.body.images).toBe(true);
  });
});

// ---------------------------------------------------------------- the board quota

describe('open mode, with a tiny board quota', () => {
  const { h, upload } = openHarness({ ASSET_BOARD_QUOTA: '1' });

  beforeAll(async () => {
    await h.start();
  });

  afterAll(() => h.cleanup());

  it('an upload to a board over its 1-byte quota gets 402 storage_full', async () => {
    const res = await upload(h.unique('quota'), makePng(), 'image/png');
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('storage_full');
  });
});
