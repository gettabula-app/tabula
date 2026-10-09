import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, MAX_SIDE, gifFrames, readImageInfo, sizeOk, sniffType } from '../server/image-header.mjs';
import { makeGif, makeJpeg, makePng, makeWebp } from './image-fixtures';

// docs/images.md, Security 1 and 4: the type comes from the bytes, the size from the header, before anything decodes.

describe('sniffType', () => {
  it.each([
    ['png', makePng(), 'image/png'],
    ['jpeg', makeJpeg(), 'image/jpeg'],
    ['gif', makeGif(), 'image/gif'],
    ['webp', makeWebp(), 'image/webp'],
  ])('knows %s by its first bytes', (_name, file, type) => {
    expect(sniffType(file)).toBe(type);
  });

  it('knows nothing else', () => {
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffType(Buffer.from('%PDF-1.7 and some more text'))).toBeNull();
    expect(sniffType(Buffer.from('BM' + 'x'.repeat(30)))).toBeNull(); // bmp
    expect(sniffType(Buffer.alloc(0))).toBeNull();
    expect(sniffType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffType(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(8)]))).toBeNull();
  });
});

describe('readImageInfo', () => {
  it('reads PNG, JPEG, GIF and WebP sizes', () => {
    expect(readImageInfo(makePng({ width: 640, height: 480 }), 'image/png')).toEqual({ width: 640, height: 480, animated: false });
    expect(readImageInfo(makeJpeg({ width: 1920, height: 1080 }), 'image/jpeg')).toEqual({ width: 1920, height: 1080, animated: false });
    expect(readImageInfo(makeGif({ width: 100, height: 50 }), 'image/gif')).toEqual({ width: 100, height: 50, animated: false });
    expect(readImageInfo(makeWebp({ width: 321, height: 123 }), 'image/webp')).toEqual({ width: 321, height: 123, animated: false });
    expect(readImageInfo(makeWebp({ width: 33, height: 44, kind: 'VP8 ' }), 'image/webp')).toEqual({ width: 33, height: 44, animated: false });
    expect(readImageInfo(makeWebp({ width: 50, height: 60, kind: 'VP8X' }), 'image/webp')).toEqual({ width: 50, height: 60, animated: false });
  });

  it('says which files are animated', () => {
    expect(readImageInfo(makeGif({ frames: 3 }), 'image/gif')?.animated).toBe(true);
    expect(gifFrames(makeGif({ frames: 3 }))).toBe(3);
    expect(readImageInfo(makeWebp({ animated: true }), 'image/webp')?.animated).toBe(true);
  });

  it('finds a JPEG frame header after other segments and fill bytes', () => {
    const file = makeJpeg({ width: 77, height: 88, exif: true, comment: true, icc: 100 });
    expect(readImageInfo(file, 'image/jpeg')).toMatchObject({ width: 77, height: 88 });
  });

  it('gives null for files it cannot read, never an exception', () => {
    const png = makePng();
    expect(readImageInfo(png.subarray(0, 20), 'image/png')).toBeNull();
    expect(readImageInfo(Buffer.concat([png.subarray(0, 12), Buffer.from('XXXX'), png.subarray(16)]), 'image/png')).toBeNull();
    expect(readImageInfo(makeJpeg({ noScan: true }).subarray(0, 14), 'image/jpeg')).toBeNull();
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), 'image/jpeg')).toBeNull();
    expect(readImageInfo(makeGif().subarray(0, 8), 'image/gif')).toBeNull();
    expect(readImageInfo(makeWebp().subarray(0, 25), 'image/webp')).toBeNull();
    expect(readImageInfo(makeWebp(), 'image/png')).toBeNull();
    expect(readImageInfo(png, 'image/svg+xml')).toBeNull();
  });
});

describe('sizeOk', () => {
  it('allows ordinary sizes and refuses bombs', () => {
    expect(sizeOk(1, 1)).toBe(true);
    expect(sizeOk(6000, 6000)).toBe(true); // exactly 36 million pixels
    expect(sizeOk(6001, 6000)).toBe(false);
    expect(sizeOk(MAX_SIDE, 2000)).toBe(true);
    expect(sizeOk(MAX_SIDE + 1, 1)).toBe(false);
    expect(sizeOk(0, 10)).toBe(false);
    expect(sizeOk(-1, 10)).toBe(false);
    expect(sizeOk(1.5, 10)).toBe(false);
    expect(sizeOk(Number.NaN, 10)).toBe(false);
    expect(MAX_PIXELS).toBe(36_000_000);
  });

  it('is what a lying header runs into', () => {
    const info = readImageInfo(makePng({ width: 40000, height: 40000 }), 'image/png')!;
    expect(sizeOk(info.width, info.height)).toBe(false);
  });
});
