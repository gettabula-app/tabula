import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import * as Y from 'yjs';
import { ASSET_MANIFEST, MAX_FILE_ASSETS, packAssets, unpackAssets } from '../src/drift-assets';
import { applyImported, readBoardFile, toDrift, toJson } from '../src/exporters';
import { Store } from '../src/store';
import { Comments } from '../src/comments';
import type { BoardApp } from '../src/app';
import type { BaseObj } from '../src/types';
import { makeGif, makeJpeg, makePng } from './image-fixtures';

// docs/images.md, Export, import and the other formats: a .drift file carries the pictures; a JSON snapshot says it does not.

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const image = (id: string, asset: string, mime = 'image/png'): BaseObj => ({ id, type: 'image', x: 0, y: 0, w: 40, h: 30, rotation: 0, z: id, asset, mime, nw: 4, nh: 3 });

/** The parts of BoardApp that `toDrift` reads, with a picture store that knows `known` by reference. */
function fakeBoard(objects: BaseObj[], known: Record<string, Buffer>) {
  const doc = new Y.Doc();
  const store = new Store(doc);
  store.transact(() => objects.forEach((o) => store.create(o)));
  const app = {
    store,
    conn: { comments: new Comments(new Y.Doc()) },
    flow: { polls: { snapshot: () => ({ polls: [], answers: [] }) } },
    images: { blobOf: async (key: string) => (known[key] ? new Blob([new Uint8Array(known[key])]) : null) },
  };
  return app as unknown as BoardApp;
}

describe('packing and unpacking the pictures of a file', () => {
  const png = makePng();
  const entry = { key: sha(png), mime: 'image/png', bytes: new Uint8Array(png), sha: sha(png) };

  it('stores each picture under the hash of its bytes and names the references in a manifest', () => {
    const files = packAssets([entry, { ...entry, key: 'pending:abc' }])!;
    expect(Object.keys(files).sort()).toEqual([ASSET_MANIFEST, `assets/${entry.sha}`].sort());
    const manifest = JSON.parse(new TextDecoder().decode(files[ASSET_MANIFEST]));
    expect(manifest).toEqual({ v: 1, assets: { [entry.key]: { file: `assets/${entry.sha}`, mime: 'image/png' }, 'pending:abc': { file: `assets/${entry.sha}`, mime: 'image/png' } } });
    expect(packAssets([])).toBeNull();
  });

  it('gives the pictures back by reference, with their sizes', () => {
    const out = unpackAssets(packAssets([entry])!);
    expect(Object.keys(out)).toEqual([entry.key]);
    expect(out[entry.key]).toMatchObject({ mime: 'image/png', width: 4, height: 3 });
    expect(Buffer.from(out[entry.key].bytes).equals(png)).toBe(true);
  });

  it('knows nothing of a file without a manifest, or with one it cannot read', () => {
    expect(unpackAssets({})).toEqual({});
    expect(unpackAssets({ [ASSET_MANIFEST]: strToU8('not json') })).toEqual({});
    expect(unpackAssets({ [ASSET_MANIFEST]: strToU8('{"v":2,"assets":{}}') })).toEqual({});
    expect(unpackAssets({ [ASSET_MANIFEST]: strToU8('{"v":1,"assets":[1]}') })).toEqual({});
  });

  it('leaves out what does not hold up and keeps the rest', () => {
    const good = packAssets([entry])!;
    const hash = sha(makeGif());
    const files = {
      ...good,
      [`assets/${hash}`]: new Uint8Array(makeGif()),
      'assets/notes': strToU8('x'),
      [ASSET_MANIFEST]: strToU8(JSON.stringify({ v: 1, assets: {
        [entry.key]: { file: `assets/${entry.sha}`, mime: 'image/png' },
        [hash]: { file: `assets/${hash}`, mime: 'image/png' }, // a GIF that says it is a PNG
        ['cd'.repeat(32)]: { file: `assets/${'ee'.repeat(32)}`, mime: 'image/png' }, // no such file
        '../../etc/passwd': { file: `assets/${entry.sha}`, mime: 'image/png' }, // not a reference
        ['ab'.repeat(32)]: { file: '../up', mime: 'image/png' }, // not a file of ours
        ['12'.repeat(32)]: { file: `assets/${entry.sha}`, mime: 'image/svg+xml' }, // not a stored type
        ['34'.repeat(32)]: null,
      } })),
    };
    expect(Object.keys(unpackAssets(files))).toEqual([entry.key]);
  });

  it('refuses a picture with a size no board could hold, and one over the file cap', () => {
    const big = makePng({ width: 40000, height: 40000 });
    const bigEntry = { key: sha(big), mime: 'image/png', bytes: new Uint8Array(big), sha: sha(big) };
    expect(unpackAssets(packAssets([bigEntry])!)).toEqual({});
    const huge = Buffer.concat([makePng(), Buffer.alloc(10 * 1024 * 1024)]);
    expect(unpackAssets(packAssets([{ key: sha(huge), mime: 'image/png', bytes: new Uint8Array(huge), sha: sha(huge) }])!)).toEqual({});
  });

  it('keeps at most 500 pictures', () => {
    const entries = Array.from({ length: MAX_FILE_ASSETS + 5 }, (_, i) => {
      const b = makePng({ width: 1 + (i % 50), height: 1 + Math.floor(i / 50) });
      return { key: `pending:p${i}`, mime: 'image/png', bytes: new Uint8Array(b), sha: sha(b) };
    });
    expect(Object.keys(unpackAssets(packAssets(entries)!))).toHaveLength(MAX_FILE_ASSETS);
  });
});

describe('a .drift file with pictures', () => {
  const png = makePng();
  const jpeg = makeJpeg();
  const hashA = sha(png);

  it('carries the pictures beside the board, stored not squeezed again, and reads them back', async () => {
    const app = fakeBoard([image('a', hashA), image('b', hashA), image('c', 'pending:xyz', 'image/jpeg')], { [hashA]: png, 'pending:xyz': jpeg });
    const bytes = await toDrift(app);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['assets.json', `assets/${hashA}`, `assets/${sha(jpeg)}`, 'board.json', 'doc.yjs'].sort());
    const back = await readBoardFile(new File([bytes as BlobPart], 'x.drift'));
    expect(Object.keys(back.assets!).sort()).toEqual([hashA, 'pending:xyz'].sort());
    expect(Buffer.from(back.assets!['pending:xyz'].bytes).equals(jpeg)).toBe(true);
    const target = { doc: new Y.Doc(), store: undefined as unknown as Store, comments: new Comments(new Y.Doc()) };
    target.store = new Store(target.doc);
    applyImported(target, back, null);
    expect((target.store.get('c') as BaseObj).asset).toBe('pending:xyz');
  });

  it('leaves a picture out when its bytes cannot be found, and the board still opens', async () => {
    const app = fakeBoard([image('a', hashA)], {});
    const bytes = await toDrift(app);
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(['board.json', 'doc.yjs']);
    const back = await readBoardFile(new File([bytes as BlobPart], 'x.drift'));
    expect(back.assets).toBeUndefined();
    expect(back.update).toBeDefined();
  });

  it('is the same file as before for a board with no pictures', async () => {
    const app = fakeBoard([], {});
    expect(Object.keys(unzipSync(await toDrift(app))).sort()).toEqual(['board.json', 'doc.yjs']);
  });

  it('reads a file whose manifest is hostile as a file with no pictures', async () => {
    const zip = zipSync({ 'board.json': strToU8(JSON.stringify({ format: 'driftboard', schemaVersion: 1, exportedAt: 'x', meta: {}, objects: [], flow: {} })), 'assets.json': strToU8('{"v":1,"assets":{"../x":{"file":"assets/../x","mime":"image/png"}}}') });
    const back = await readBoardFile(new File([zip as BlobPart], 'x.drift'));
    expect(back.assets).toBeUndefined();
  });
});

describe('the JSON snapshot', () => {
  it('says it holds references only when the board has pictures, and says nothing otherwise', () => {
    const png = makePng();
    const withPictures = toJson(fakeBoard([image('a', sha(png))], {}));
    expect(withPictures.note).toMatch(/not included/);
    expect(withPictures.objects[0]).toMatchObject({ type: 'image', asset: sha(png), mime: 'image/png', nw: 4, nh: 3 });
    expect(toJson(fakeBoard([], {})).note).toBeUndefined();
  });
});
