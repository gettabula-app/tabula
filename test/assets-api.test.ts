import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, type Account } from './mcp-harness';
import { SECRET, containsSecret, makeGif, makeJpeg, makePng, makeWebp } from './image-fixtures';

// Images on a board, accounts mode (docs/images.md). The relay runs as a child process; the uploads are raw bytes.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

type Reply = { status: number; body: any; headers: Headers };
type Role = 'editor' | 'commenter' | 'viewer';

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

/** Used by every test below: one harness per describe, so the limits can differ. */
function accountsHarness(settings: Record<string, string> = {}) {
  const h = createHarness({ accounts: true, settings });

  /** A raw-bytes upload as a browser sends it. `csrf: false` leaves out x-tabula; no `who` sends no cookie. */
  async function upload(who: Account | undefined, board: string, bytes: Buffer, type: string, { csrf = true }: { csrf?: boolean } = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': type };
    if (csrf) headers['x-tabula'] = '1';
    if (who) headers.cookie = who.cookie;
    const res = await fetch(`${h.base}/api/boards/${board}/assets`, { method: 'POST', headers, body: new Uint8Array(bytes) });
    return { status: res.status, body: await parse(res), headers: res.headers };
  }

  /** GET or HEAD of one asset. `segment` is already URL-encoded when the caller needs it to be. */
  async function fetchAsset(who: Account | undefined, board: string, segment: string, { method = 'GET', headers = {} as Record<string, string> } = {}) {
    const res = await fetch(`${h.base}/api/boards/${board}/assets/${segment}`, {
      method,
      headers: { 'x-tabula': '1', ...(who ? { cookie: who.cookie } : {}), ...headers },
    });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  return { h, upload, fetchAsset };
}

/** The stored headers of an asset response: the type, the ETag and the security set. */
const expectStoredHeaders = (headers: Headers, mime: string, hash: string) => {
  expect(headers.get('content-type')).toBe(mime);
  expect(headers.get('etag')).toBe(`"${hash}"`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect([name, headers.get(name)]).toEqual([name, value]);
};

// ---------------------------------------------------------------- the main harness

describe('accounts mode', () => {
  const { h, upload, fetchAsset } = accountsHarness();
  let owner: Account;
  let editor: Account;
  let commenter: Account;
  let viewer: Account;
  let stranger: Account;

  const makeBoard = () => h.newBoard(owner.cookie);
  const grant = (board: string, who: Account, role: Role) => h.share(owner.cookie, board, who.user.id, role);
  const auditPage = async () => (await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=200&action=asset.upload')).body;

  /** A board the editor, commenter and viewer may all open, with one image from the editor (EXIF and all). */
  async function seeded() {
    const board = await makeBoard();
    await grant(board, editor, 'editor');
    await Promise.all([grant(board, commenter, 'commenter'), grant(board, viewer, 'viewer')]);
    const up = await upload(editor, board, makePng({ exif: true }), 'image/png');
    if (up.status !== 201) throw new Error(`seed upload failed (${up.status})`);
    return { board, hash: up.body.hash as string };
  }

  beforeAll(async () => {
    await h.start();
    owner = await h.signInOwner();
    const team = (await h.newTeam(owner.cookie, 'Images')).id;
    editor = await h.joinTeam(owner.cookie, team);
    commenter = await h.joinTeam(owner.cookie, team);
    viewer = await h.joinTeam(owner.cookie, team);
    stranger = await h.joinTeam(owner.cookie, team);
  });

  afterAll(() => h.cleanup());

  describe('uploading', () => {
    it('an editor uploads a PNG and gets 201 with the stored fields', async () => {
      const board = await makeBoard();
      await grant(board, editor, 'editor');
      const res = await upload(editor, board, makePng({ width: 4, height: 3 }), 'image/png');
      expect(res.status).toBe(201);
      expect(Object.keys(res.body).sort()).toEqual(['bytes', 'hash', 'height', 'mime', 'width']);
      expect(res.body).toMatchObject({ mime: 'image/png', width: 4, height: 3 });
      expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.bytes).toBeGreaterThan(0);
    });

    it('uploading the same content again gets 200 with the same body', async () => {
      const board = await makeBoard();
      await grant(board, editor, 'editor');
      const first = await upload(editor, board, makePng({ width: 6, height: 2 }), 'image/png');
      const again = await upload(editor, board, makePng({ width: 6, height: 2 }), 'image/png');
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
    });

    it('the owner can upload', async () => {
      const board = await makeBoard();
      expect((await upload(owner, board, makePng(), 'image/png')).status).toBe(201);
    });

    it('a viewer and a commenter get 403', async () => {
      const board = await makeBoard();
      await grant(board, viewer, 'viewer');
      await grant(board, commenter, 'commenter');
      expect((await upload(viewer, board, makePng(), 'image/png')).status).toBe(403);
      expect((await upload(commenter, board, makePng(), 'image/png')).status).toBe(403);
    });

    it('no session gets 401', async () => {
      const board = await makeBoard();
      const res = await upload(undefined, board, makePng(), 'image/png');
      expect(res.status).toBe(401);
    });

    it('a request without the x-tabula header gets 403 csrf', async () => {
      const board = await makeBoard();
      const res = await upload(owner, board, makePng(), 'image/png', { csrf: false });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('csrf');
    });

    it('an unknown board gets 404', async () => {
      expect((await upload(owner, `nope${h.unique('b')}`, makePng(), 'image/png')).status).toBe(404);
    });

    it.each([
      ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ['text/html', Buffer.from('<html><body>hi</body></html>')],
      ['application/octet-stream', makePng()],
    ])('a declared type of %s gets 400 unsupported_type', async (type, bytes) => {
      const board = await makeBoard();
      const res = await upload(owner, board, bytes, type);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_type');
    });

    it('a PNG declared as PNG but holding JPEG bytes gets 400 bad_image', async () => {
      const board = await makeBoard();
      const res = await upload(owner, board, makeJpeg(), 'image/png');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_image');
    });

    it('a text file declared as PNG gets 400 bad_image', async () => {
      const board = await makeBoard();
      const res = await upload(owner, board, Buffer.from('just some text, not a picture'), 'image/png');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_image');
    });

    it('an empty body gets 400', async () => {
      const board = await makeBoard();
      expect((await upload(owner, board, Buffer.alloc(0), 'image/png')).status).toBe(400);
    });

    it('a PNG with a pixel count over the cap gets 413 too_many_pixels', async () => {
      const board = await makeBoard();
      const res = await upload(owner, board, makePng({ width: 40000, height: 40000 }), 'image/png');
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('too_many_pixels');
    });

    it.each([
      ['JPEG', () => makeJpeg(), 'image/jpeg'],
      ['GIF', () => makeGif(), 'image/gif'],
      ['WebP', () => makeWebp(), 'image/webp'],
    ])('a %s is accepted', async (_, make, type) => {
      const board = await makeBoard();
      const res = await upload(owner, board, make(), type);
      expect(res.status).toBe(201);
      expect(res.body.mime).toBe(type);
    });

    it('the stored type is the one the bytes really are, whatever the case of the declared type', async () => {
      const board = await makeBoard();
      const res = await upload(owner, board, makeJpeg(), 'IMAGE/JPEG; charset=binary');
      expect(res.status).toBe(201);
      expect(res.body.mime).toBe('image/jpeg');
      expect((await fetchAsset(owner, board, res.body.hash)).headers.get('content-type')).toBe('image/jpeg');
    });
  });

  describe('personal data', () => {
    it.each([
      ['JPEG', makeJpeg({ exif: true, xmp: true, iptc: true, comment: true, trailing: true }), 'image/jpeg', 'image/jpeg'],
      ['PNG', makePng({ exif: true, text: true, trailing: true }), 'image/png', 'image/png'],
      ['GIF', makeGif({ comment: true, app: true, trailing: true }), 'image/gif', 'image/gif'],
      ['WebP', makeWebp({ exif: true, xmp: true }), 'image/webp', 'image/webp'],
    ])('the position, camera and text are gone from a stored %s', async (_, dirty, declared, mime) => {
      const board = await makeBoard();
      await grant(board, editor, 'editor');
      const res = await upload(editor, board, dirty, declared);
      expect(res.status).toBe(201);
      const got = await fetchAsset(owner, board, res.body.hash);
      expect(got.status).toBe(200);
      expect(containsSecret(got.bytes)).toBe(false);
      expect(got.bytes.includes(Buffer.from(SECRET, 'latin1'))).toBe(false);
      expect(got.headers.get('content-type')).toBe(mime);
      expect(res.body.hash).toBe(sha256(got.bytes));
      expect(res.body.hash).not.toBe(sha256(dirty));
      expect(res.body.bytes).toBe(got.bytes.length);
      expect(got.bytes.length).toBeLessThan(dirty.length);
    });
  });

  describe('reading', () => {
    let seed: { board: string; hash: string };
    beforeAll(async () => {
      seed = await seeded();
    });

    it.each(['owner', 'editor', 'commenter', 'viewer'] as const)('the %s reads the bytes with the exact headers', async (name) => {
      const who = { owner, editor, commenter, viewer }[name];
      const res = await fetchAsset(who, seed.board, seed.hash);
      expect(res.status).toBe(200);
      expectStoredHeaders(res.headers, 'image/png', seed.hash);
      expect(sha256(res.bytes)).toBe(seed.hash);
    });

    it('a matching If-None-Match gets 304 with the ETag and the security headers', async () => {
      const res = await fetchAsset(viewer, seed.board, seed.hash, { headers: { 'if-none-match': `"${seed.hash}"` } });
      expect(res.status).toBe(304);
      expect(res.bytes.length).toBe(0);
      expect(res.headers.get('etag')).toBe(`"${seed.hash}"`);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect([name, res.headers.get(name)]).toEqual([name, value]);
    });

    it('HEAD has the same headers as GET and no body', async () => {
      const res = await fetchAsset(editor, seed.board, seed.hash, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.bytes.length).toBe(0);
      expectStoredHeaders(res.headers, 'image/png', seed.hash);
    });

    it('another board that has the same content but no row for it gets 404', async () => {
      const other = await makeBoard();
      await grant(other, editor, 'editor');
      expect((await fetchAsset(editor, other, seed.hash)).status).toBe(404);
    });

    it('a person with no share on the board gets 404', async () => {
      expect((await fetchAsset(stranger, seed.board, seed.hash)).status).toBe(404);
    });

    it('a board the caller has lost access to gives 404 at once', async () => {
      const board = await makeBoard();
      await grant(board, editor, 'editor');
      const up = await upload(owner, board, makePng({ width: 7, height: 7 }), 'image/png');
      expect((await fetchAsset(editor, board, up.body.hash)).status).toBe(200);
      const gone = await h.api(owner.cookie, 'DELETE', `/api/boards/${board}/shares/user/${editor.user.id}`);
      expect(gone.status).toBe(204);
      expect((await fetchAsset(editor, board, up.body.hash)).status).toBe(404);
    });

    it('a traversal-shaped or malformed hash never gets 200', async () => {
      const bad = ['../../etc/passwd', 'ABC', 'a'.repeat(63), 'a'.repeat(65), '%2e%2e', 'A'.repeat(64)];
      for (const segment of bad) {
        const res = await fetchAsset(owner, seed.board, encodeURIComponent(segment));
        expect({ segment, status: res.status }).toMatchObject({ status: expect.toSatisfy((n: number) => n === 400 || n === 404) });
      }
    });
  });

  describe('claiming', () => {
    it('a hash claimed from a board the caller can read gives 200, and the bytes read on the new board', async () => {
      const source = await makeBoard();
      await grant(source, editor, 'viewer');
      const up = await upload(owner, source, makePng({ width: 5, height: 5 }), 'image/png');
      const target = await makeBoard();
      await grant(target, editor, 'editor');
      expect((await fetchAsset(editor, target, up.body.hash)).status).toBe(404);
      const claimed = await h.api(editor.cookie, 'POST', `/api/boards/${target}/assets/claim`, { hash: up.body.hash });
      expect(claimed.status).toBe(200);
      expect(claimed.body).toMatchObject({ hash: up.body.hash, mime: 'image/png' });
      const read = await fetchAsset(editor, target, up.body.hash);
      expect(read.status).toBe(200);
      expectStoredHeaders(read.headers, 'image/png', up.body.hash);
    });

    it('a hash on a board the caller cannot read gives 404 on claim', async () => {
      const hidden = await makeBoard();
      const up = await upload(owner, hidden, makePng({ width: 9, height: 9 }), 'image/png');
      const target = await makeBoard();
      await grant(target, editor, 'editor');
      const res = await h.api(editor.cookie, 'POST', `/api/boards/${target}/assets/claim`, { hash: up.body.hash });
      expect(res.status).toBe(404);
      expect((await fetchAsset(editor, target, up.body.hash)).status).toBe(404);
    });

    it('a claim with a malformed hash gets 400', async () => {
      const target = await makeBoard();
      await grant(target, editor, 'editor');
      const res = await h.api(editor.cookie, 'POST', `/api/boards/${target}/assets/claim`, { hash: 'not-a-hash' });
      expect(res.status).toBe(400);
    });
  });

  describe('audit and storage', () => {
    it('a new asset writes one asset.upload row with only the board, hash and size', async () => {
      const board = await makeBoard();
      await grant(board, editor, 'editor');
      const res = await upload(editor, board, makePng({ exif: true, text: true }), 'image/png');
      expect(res.status).toBe(201);
      const rows = ((await auditPage()).entries as any[]).filter((e) => e.detail?.boardId === board);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('asset.upload');
      expect(Object.keys(rows[0].detail).sort()).toEqual(['boardId', 'bytes', 'hash']);
      expect(rows[0].detail).toMatchObject({ hash: res.body.hash, bytes: res.body.bytes });
      expect(JSON.stringify(await auditPage())).not.toContain(SECRET);
    });

    it('a repeat upload writes no further audit row', async () => {
      const board = await makeBoard();
      await grant(board, editor, 'editor');
      const bytes = makePng({ width: 3, height: 8 });
      expect((await upload(editor, board, bytes, 'image/png')).status).toBe(201);
      const before = ((await auditPage()).entries as any[]).filter((e) => e.detail?.boardId === board).length;
      expect((await upload(editor, board, bytes, 'image/png')).status).toBe(200);
      const after = ((await auditPage()).entries as any[]).filter((e) => e.detail?.boardId === board).length;
      expect(after).toBe(before);
    });

    it('me reports images: true', async () => {
      const me = await h.api(editor.cookie, 'GET', '/api/me');
      expect(me.body.images).toBe(true);
    });

    it('no file under the asset folder holds personal data, and the temp folder is empty', async () => {
      const root = path.join(h.dir, 'assets');
      const files = (fs.readdirSync(root, { recursive: true }) as string[]).map((f) => path.join(root, f)).filter((f) => fs.statSync(f).isFile());
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const bytes = fs.readFileSync(file);
        expect({ file, found: bytes.includes(Buffer.from(SECRET, 'latin1')) }).toEqual({ file, found: false });
        expect({ file, found: containsSecret(bytes) }).toEqual({ file, found: false });
      }
      expect(fs.existsSync(path.join(root, 'tmp')) ? fs.readdirSync(path.join(root, 'tmp')) : []).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------- limits (tiny caps)

describe('limits', () => {
  // A 1000-byte cap per file, and a board quota of 1 byte, so any image that gets past the checks is refused for space.
  const { h, upload } = accountsHarness({ ASSET_MAX_BYTES: '1000', ASSET_BOARD_QUOTA: '1' });
  let owner: Account;

  beforeAll(async () => {
    await h.start();
    owner = await h.signInOwner();
  });

  afterAll(() => h.cleanup());

  it('a file over the size cap gets 413 payload_too_large', async () => {
    const board = await h.newBoard(owner.cookie);
    const res = await upload(owner, board, Buffer.alloc(2000, 7), 'image/png');
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
  });

  it('a board over its quota gets 402 storage_full', async () => {
    const board = await h.newBoard(owner.cookie);
    const res = await upload(owner, board, makePng(), 'image/png');
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('storage_full');
  });
});

// ---------------------------------------------------------------- switched off

describe('with ASSETS=off', () => {
  const { h, upload, fetchAsset } = accountsHarness({ ASSETS: 'off' });
  let owner: Account;

  beforeAll(async () => {
    await h.start();
    owner = await h.signInOwner();
  });

  afterAll(() => h.cleanup());

  it('the routes answer 404 and /api/me has no images field', async () => {
    const board = await h.newBoard(owner.cookie);
    expect((await upload(owner, board, makePng(), 'image/png')).status).toBe(404);
    expect((await fetchAsset(owner, board, 'a'.repeat(64))).status).toBe(404);
    const claim = await h.api(owner.cookie, 'POST', `/api/boards/${board}/assets/claim`, { hash: 'a'.repeat(64) });
    expect(claim.status).toBe(404);
    const me = await h.api(owner.cookie, 'GET', '/api/me');
    expect(me.body).not.toHaveProperty('images');
  });
});
