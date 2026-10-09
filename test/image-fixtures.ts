// Hand-built image files for the tests of the asset store. They have the structure the server reads (signatures, headers,
// chunks, segments) and carry personal-data blocks on request, but their pixel data is a stand-in: the server never
// decodes pixels, so a few bytes of filler is enough. Dimensions in the header can be any number, which is how the
// pixel cap is tested without making a huge file.
import { crc32, deflateSync } from 'node:zlib';

const be32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const be16 = (n: number) => Buffer.from([(n >>> 8) & 255, n & 255]);
const le16 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);
const le24 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);

/** What a phone photo has in its Exif block: a recognisable position and camera. */
export const SECRET = 'GPS 59.3293 N 18.0686 E Pixel 8 Pro 2026:01:15 10:00:00';

// ---------------------------------------------------------------- PNG

export const pngChunk = (name: string, data: Buffer = Buffer.alloc(0)) => {
  const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
  return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
};

export interface PngOptions { width?: number; height?: number; text?: boolean; exif?: boolean; time?: boolean; icc?: number; trailing?: boolean; badCrc?: boolean }

export function makePng({ width = 4, height = 3, text = false, exif = false, time = false, icc = 0, trailing = false, badCrc = false }: PngOptions = {}) {
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])]);
  const rows = Buffer.alloc(Math.min(height, 8) * (1 + Math.min(width, 8) * 4)); // filler, not the real size
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('gAMA', be32(45455)),
    ...(text ? [pngChunk('tEXt', Buffer.from(`Comment\0${SECRET}`, 'latin1')), pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`, 'latin1'))] : []),
    ...(exif ? [pngChunk('eXIf', Buffer.from(`Exif\0\0${SECRET}`, 'latin1'))] : []),
    ...(time ? [pngChunk('tIME', Buffer.from([0x07, 0xea, 1, 15, 10, 0, 0]))] : []),
    ...(icc ? [pngChunk('iCCP', Buffer.concat([Buffer.from('profile\0\0', 'latin1'), Buffer.alloc(icc, 1)]))] : []),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND'),
    ...(trailing ? [Buffer.from(`TRAILER ${SECRET}`, 'latin1')] : []),
  ];
  const out = Buffer.concat(parts);
  if (badCrc) out[out.indexOf(Buffer.from('gAMA')) + 4] ^= 0xff;
  return out;
}

// ---------------------------------------------------------------- JPEG

const jpegSegment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), be16(data.length + 2), data]);

export interface JpegOptions { width?: number; height?: number; exif?: boolean; xmp?: boolean; iptc?: boolean; comment?: boolean; icc?: number; adobe?: boolean; trailing?: boolean; truncate?: boolean; noScan?: boolean }

export function makeJpeg({ width = 4, height = 3, exif = false, xmp = false, iptc = false, comment = false, icc = 0, adobe = false, trailing = false, truncate = false, noScan = false }: JpegOptions = {}) {
  const parts = [
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(exif ? [jpegSegment(0xe1, Buffer.from(`Exif\0\0${SECRET}`, 'latin1'))] : []),
    ...(xmp ? [jpegSegment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${SECRET}`, 'latin1'))] : []),
    ...(iptc ? [jpegSegment(0xed, Buffer.from(`Photoshop 3.0\0${SECRET}`, 'latin1'))] : []),
    ...(comment ? [jpegSegment(0xfe, Buffer.from(SECRET, 'latin1'))] : []),
    ...(icc ? [jpegSegment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.alloc(icc, 2)]))] : []),
    ...(adobe ? [jpegSegment(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1'))] : []),
    jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 8)])),
    jpegSegment(0xc0, Buffer.concat([Buffer.from([8]), be16(height), be16(width), Buffer.from([1, 1, 0x11, 0])])),
    jpegSegment(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16, 0), Buffer.from([0])])),
    ...(noScan ? [] : [jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78])]),
    Buffer.from([0xff, 0xd9]),
    ...(trailing ? [Buffer.from(`TRAILER ${SECRET}`, 'latin1')] : []),
  ];
  const out = Buffer.concat(parts);
  return truncate ? out.subarray(0, out.length - 12) : out;
}

// ---------------------------------------------------------------- GIF

export interface GifOptions { width?: number; height?: number; frames?: number; comment?: boolean; loop?: boolean; app?: boolean; trailing?: boolean }

const subBlocks = (data: Buffer) => Buffer.concat([Buffer.from([data.length]), data, Buffer.from([0])]);

export function makeGif({ width = 4, height = 3, frames = 1, comment = false, loop = false, app = false, trailing = false }: GifOptions = {}) {
  const parts = [
    Buffer.from('GIF89a', 'latin1'), le16(width), le16(height), Buffer.from([0x80, 0, 0]), // a 2-colour global table
    Buffer.from([0, 0, 0, 255, 255, 255]),
    ...(loop ? [Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0', 'latin1'), subBlocks(Buffer.from([1, 0, 0]))] : []),
    ...(app ? [Buffer.from([0x21, 0xff, 11]), Buffer.from('XMP DataXMP', 'latin1'), subBlocks(Buffer.from(SECRET, 'latin1'))] : []),
    ...(comment ? [Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from(SECRET, 'latin1'))] : []),
    ...Array.from({ length: frames }, () => Buffer.concat([
      Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]),
      Buffer.from([0x2c]), le16(0), le16(0), le16(width), le16(height), Buffer.from([0]),
      Buffer.from([2]), subBlocks(Buffer.from([0x44, 0x01])),
    ])),
    Buffer.from([0x3b]),
    ...(trailing ? [Buffer.from(`TRAILER ${SECRET}`, 'latin1')] : []),
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- WebP

const riffChunk = (name: string, data: Buffer) => Buffer.concat([Buffer.from(name, 'latin1'), le32(data.length), data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);

export interface WebpOptions { width?: number; height?: number; exif?: boolean; xmp?: boolean; icc?: number; animated?: boolean; kind?: 'VP8X' | 'VP8L' | 'VP8 ' }

export function makeWebp({ width = 4, height = 3, exif = false, xmp = false, icc = 0, animated = false, kind }: WebpOptions = {}) {
  const extended = exif || xmp || icc > 0 || animated || kind === 'VP8X';
  const image = (kind === 'VP8 ')
    ? riffChunk('VP8 ', Buffer.concat([Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), le16(width), le16(height), Buffer.alloc(10, 5)]))
    : riffChunk('VP8L', Buffer.concat([Buffer.from([0x2f]), le32((width - 1) | ((height - 1) << 14)), Buffer.alloc(10, 5)]));
  const flags = (icc ? 0x20 : 0) | (animated ? 0x02 : 0) | (exif ? 0x08 : 0) | (xmp ? 0x04 : 0);
  const parts = [
    ...(extended ? [riffChunk('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), le24(width - 1), le24(height - 1)]))] : []),
    ...(icc ? [riffChunk('ICCP', Buffer.alloc(icc, 3))] : []),
    ...(animated ? [riffChunk('ANIM', Buffer.alloc(6, 0)), riffChunk('ANMF', Buffer.concat([le24(0), le24(0), le24(width - 1), le24(height - 1), le24(100), Buffer.from([0]), image]))] : [image]),
    ...(exif ? [riffChunk('EXIF', Buffer.from(`Exif\0\0${SECRET}`, 'latin1'))] : []),
    ...(xmp ? [riffChunk('XMP ', Buffer.from(SECRET, 'latin1'))] : []),
  ];
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...parts]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(body.length), body]);
}

export const containsSecret = (b: Buffer) => b.includes(Buffer.from('GPS 59.3293')) || b.includes(Buffer.from('Pixel 8 Pro'));
