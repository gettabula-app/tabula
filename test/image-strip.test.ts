import { describe, expect, it } from 'vitest';
import { ImageError, stripGif, stripImage, stripJpeg, stripPng, stripWebp } from '../server/image-strip.mjs';
import { readImageInfo, sniffType } from '../server/image-header.mjs';
import { SECRET, containsSecret, makeGif, makeJpeg, makePng, makeWebp, pngChunk } from './image-fixtures';

// docs/images.md, Security 3: personal data goes, the picture stays, a file that does not parse is refused.

const names = (png: Buffer) => {
  const out: string[] = [];
  for (let i = 8; i < png.length;) {
    const len = png.readUInt32BE(i);
    out.push(png.subarray(i + 4, i + 8).toString('latin1'));
    i += 12 + len;
  }
  return out;
};

describe('PNG', () => {
  it('drops text, Exif, time and trailing data and keeps what draws the picture', () => {
    const dirty = makePng({ text: true, exif: true, time: true, icc: 100, trailing: true });
    expect(containsSecret(dirty)).toBe(true);
    const clean = stripPng(dirty);
    expect(containsSecret(clean)).toBe(false);
    expect(clean.includes(Buffer.from('TRAILER'))).toBe(false);
    expect(names(clean)).toEqual(['IHDR', 'gAMA', 'iCCP', 'IDAT', 'IEND']);
    expect(readImageInfo(clean, 'image/png')).toEqual(readImageInfo(dirty, 'image/png'));
  });

  it('leaves an already clean file as it is, byte for byte', () => {
    const file = makePng();
    expect(stripPng(file).equals(file)).toBe(true);
  });

  it('drops a large colour profile and refuses broken files', () => {
    expect(names(stripPng(makePng({ icc: 20000 })))).toEqual(['IHDR', 'gAMA', 'IDAT', 'IEND']);
    expect(() => stripPng(makePng({ badCrc: true }))).toThrow(ImageError);
    expect(() => stripPng(makePng().subarray(0, 60))).toThrow(ImageError);
    expect(() => stripPng(Buffer.concat([makePng().subarray(0, 8), pngChunk('IDAT'), pngChunk('IEND')]))).toThrow(ImageError);
    expect(() => stripPng(Buffer.from('not a png at all, not at all, not at all'))).toThrow(ImageError);
  });
});

describe('JPEG', () => {
  it('drops Exif, XMP, IPTC, comments and bytes after the end, keeps JFIF, Adobe and a small profile', () => {
    const dirty = makeJpeg({ exif: true, xmp: true, iptc: true, comment: true, icc: 200, adobe: true, trailing: true });
    expect(containsSecret(dirty)).toBe(true);
    const clean = stripJpeg(dirty);
    expect(containsSecret(clean)).toBe(false);
    expect(clean.includes(Buffer.from('TRAILER'))).toBe(false);
    expect(clean.includes(Buffer.from('JFIF'))).toBe(true);
    expect(clean.includes(Buffer.from('Adobe'))).toBe(true);
    expect(clean.includes(Buffer.from('ICC_PROFILE'))).toBe(true);
    expect(readImageInfo(clean, 'image/jpeg')).toMatchObject({ width: 4, height: 3 });
    expect([...clean.subarray(clean.length - 2)]).toEqual([0xff, 0xd9]);
    expect(clean.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
  });

  it('keeps the entropy-coded data, with its stuffed bytes and restart markers, untouched', () => {
    const clean = stripJpeg(makeJpeg({ exif: true }));
    expect(clean.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]))).toBe(true);
  });

  it('leaves a clean file unchanged and drops a large profile', () => {
    const file = makeJpeg();
    expect(stripJpeg(file).equals(file)).toBe(true);
    expect(stripJpeg(makeJpeg({ icc: 20000 })).includes(Buffer.from('ICC_PROFILE'))).toBe(false);
  });

  it('refuses a truncated file and one with no image data', () => {
    expect(() => stripJpeg(makeJpeg({ truncate: true }))).toThrow(ImageError);
    expect(() => stripJpeg(makeJpeg({ noScan: true }))).toThrow(ImageError);
    expect(() => stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]))).toThrow(ImageError);
    expect(() => stripJpeg(Buffer.from('plainly not a jpeg'))).toThrow(ImageError);
  });
});

describe('GIF', () => {
  it('drops comments, other application blocks and bytes after the trailer, keeps frames and the loop', () => {
    const dirty = makeGif({ frames: 2, comment: true, loop: true, app: true, trailing: true });
    expect(containsSecret(dirty)).toBe(true);
    const clean = stripGif(dirty);
    expect(containsSecret(clean)).toBe(false);
    expect(clean.includes(Buffer.from('TRAILER'))).toBe(false);
    expect(clean.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
    expect(clean.includes(Buffer.from('XMP Data'))).toBe(false);
    expect(readImageInfo(clean, 'image/gif')).toEqual({ width: 4, height: 3, animated: true });
    expect(clean[clean.length - 1]).toBe(0x3b);
  });

  it('leaves a clean file unchanged and refuses broken ones', () => {
    const file = makeGif();
    expect(stripGif(file).equals(file)).toBe(true);
    expect(() => stripGif(makeGif().subarray(0, 30))).toThrow(ImageError);
    expect(() => stripGif(Buffer.from('GIF89a plus nothing sensible after it'))).toThrow(ImageError);
  });
});

describe('WebP', () => {
  it('drops EXIF and XMP, clears their flags and fixes the size', () => {
    const dirty = makeWebp({ exif: true, xmp: true, icc: 50 });
    expect(containsSecret(dirty)).toBe(true);
    const clean = stripWebp(dirty);
    expect(containsSecret(clean)).toBe(false);
    expect(clean.subarray(0, 4).toString()).toBe('RIFF');
    expect(clean.readUInt32LE(4)).toBe(clean.length - 8);
    expect(clean.includes(Buffer.from('EXIF'))).toBe(false);
    expect(clean.includes(Buffer.from('XMP '))).toBe(false);
    expect(clean.includes(Buffer.from('ICCP'))).toBe(true);
    expect(clean[20] & 0x0c).toBe(0); // the Exif and XMP flags
    expect(clean[20] & 0x20).toBe(0x20); // the profile is still there
    expect(readImageInfo(clean, 'image/webp')).toEqual(readImageInfo(dirty, 'image/webp'));
  });

  it('clears the profile flag when a large profile is dropped', () => {
    const clean = stripWebp(makeWebp({ icc: 20000 }));
    expect(clean.includes(Buffer.from('ICCP'))).toBe(false);
    expect(clean[20] & 0x20).toBe(0);
  });

  it('keeps animation and leaves a clean file unchanged', () => {
    expect(readImageInfo(stripWebp(makeWebp({ animated: true })), 'image/webp')?.animated).toBe(true);
    for (const file of [makeWebp(), makeWebp({ kind: 'VP8 ' }), makeWebp({ kind: 'VP8X' })]) expect(stripWebp(file).equals(file)).toBe(true);
  });

  it('refuses broken files', () => {
    expect(() => stripWebp(makeWebp().subarray(0, 22))).toThrow(ImageError);
    expect(() => stripWebp(Buffer.from('RIFF\x04\0\0\0WEBPxxxxxxxxxxxxxxxx'))).toThrow(ImageError);
    expect(() => stripWebp(Buffer.from('not a webp, not a webp, not a webp'))).toThrow(ImageError);
  });
});

describe('stripImage', () => {
  it.each([
    ['image/png', makePng({ text: true })],
    ['image/jpeg', makeJpeg({ exif: true })],
    ['image/gif', makeGif({ comment: true })],
    ['image/webp', makeWebp({ exif: true })],
  ])('dispatches %s and keeps the type', (type, file) => {
    const clean = stripImage(file, type);
    expect(sniffType(clean)).toBe(type);
    expect(clean.includes(Buffer.from(SECRET))).toBe(false);
  });

  it('refuses a type it does not know', () => {
    expect(() => stripImage(makePng(), 'image/svg+xml')).toThrow(ImageError);
  });
});
