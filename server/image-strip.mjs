// Removes what carries personal data from an image file without decoding any pixels (docs/images.md, Security 3):
// Exif (GPS position, camera, time), XMP, IPTC, comments and text chunks. The client's canvas re-encode already drops
// them, but the server never relies on that. Pure functions over a Buffer.
//
// Each function returns a new Buffer that is the same image, or throws ImageError when the file is not a well-formed
// container of its type. A file that cannot be parsed is refused, never stored.
//
// What stays: everything needed to show the picture the same way (colour profile when small, animation data, gamma,
// transparency, the JFIF and Adobe markers) and nothing else.
import { crc32 } from 'node:zlib';

export class ImageError extends Error {}

const bad = (why) => new ImageError(why);
const ICC_MAX = 16 * 1024;

const u16be = (b, at) => (b[at] << 8) | b[at + 1];
const u32be = (b, at) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
const tag = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

// ---------------------------------------------------------------- JPEG

/** Keep SOI, APP0 (JFIF), APP14 (Adobe colour transform), a small ICC profile in APP2, every frame, table and scan
 * segment, and EOI. Drop every other APPn and comments. Anything after EOI is dropped. */
export function stripJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw bad('not a JPEG');
  const out = [b.subarray(0, 2)];
  let i = 2;
  let sawScan = false;
  for (;;) {
    if (i + 2 > b.length) throw bad('truncated JPEG');
    if (b[i] !== 0xff) throw bad('bad JPEG marker');
    let marker = b[i + 1];
    while (marker === 0xff) { // fill bytes before a marker
      i += 1;
      if (i + 1 >= b.length) throw bad('truncated JPEG');
      marker = b[i + 1];
    }
    if (marker === 0xd9) {
      if (!sawScan) throw bad('JPEG without image data');
      out.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(out);
    }
    if (marker === 0x00 || marker === 0xd8) throw bad('bad JPEG marker');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // standalone markers
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) throw bad('truncated JPEG');
    const length = u16be(b, i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > b.length) throw bad('truncated JPEG segment');
    const segment = b.subarray(i, end);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    let keep = true;
    if (marker === 0xfe) keep = false; // comment
    else if (isApp) {
      if (marker === 0xe0) keep = segment.subarray(4, 9).toString('latin1') === 'JFIF\0'; // JFXX can hold a thumbnail
      else if (marker === 0xee) keep = segment.subarray(4, 9).toString('latin1') === 'Adobe';
      else if (marker === 0xe2) keep = segment.subarray(4, 15).toString('latin1') === 'ICC_PROFILE' && length <= ICC_MAX;
      else keep = false; // Exif, XMP, IPTC, FlashPix, MPF, Ducky, everything else
    }
    if (keep) out.push(segment);
    i = end;
    if (marker === 0xda) {
      sawScan = true;
      // entropy-coded data up to the next real marker (FF 00 is a stuffed byte, FF D0-D7 a restart)
      const start = i;
      while (i < b.length) {
        if (b[i] === 0xff) {
          const next = b[i + 1];
          if (next === undefined) throw bad('truncated JPEG');
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            i += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      if (i >= b.length) throw bad('truncated JPEG');
      out.push(b.subarray(start, i));
    }
  }
}

// ---------------------------------------------------------------- PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// critical chunks plus the ancillary ones that change how the picture looks
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

/** Keep the chunks in PNG_KEEP (and a small iCCP), verify their CRCs, and drop text, Exif, time and unknown chunks. */
export function stripPng(b) {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) throw bad('not a PNG');
  const out = [PNG_SIGNATURE];
  let i = 8;
  let first = true;
  let idat = false;
  for (;;) {
    if (i + 12 > b.length) throw bad('truncated PNG');
    const length = u32be(b, i);
    const name = tag(b, i + 4);
    const end = i + 12 + length;
    if (length > 0x7fffffff || end > b.length) throw bad('truncated PNG chunk');
    if (first && name !== 'IHDR') throw bad('PNG without IHDR');
    first = false;
    const keep = PNG_KEEP.has(name) || (name === 'iCCP' && length <= ICC_MAX);
    if (keep) {
      if (crc32(b.subarray(i + 4, i + 8 + length)) !== u32be(b, i + 8 + length)) throw bad('bad PNG checksum');
      out.push(b.subarray(i, end));
    }
    if (name === 'IDAT') idat = true;
    i = end;
    if (name === 'IEND') {
      if (!idat) throw bad('PNG without image data');
      return Buffer.concat(out);
    }
  }
}

// ---------------------------------------------------------------- GIF

/** Keep header, screen, colour tables, frames, graphic control extensions and the animation loop extension; drop comment,
 * plain text and every other application extension. Anything after the trailer is dropped. */
export function stripGif(b) {
  if (b.length < 14 || !(b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) throw bad('not a GIF');
  let i = 13;
  if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1));
  if (i > b.length) throw bad('truncated GIF');
  const out = [b.subarray(0, i)];
  const subBlocks = () => {
    // returns the offset after the terminator
    let j = i;
    for (;;) {
      if (j >= b.length) throw bad('truncated GIF');
      const size = b[j];
      j += 1 + size;
      if (size === 0) return j;
    }
  };
  let frames = 0;
  while (i < b.length) {
    const block = b[i];
    if (block === 0x3b) {
      if (!frames) throw bad('GIF without image data');
      out.push(Buffer.from([0x3b]));
      return Buffer.concat(out);
    }
    if (block === 0x21) {
      if (i + 2 > b.length) throw bad('truncated GIF');
      const label = b[i + 1];
      let keep = label === 0xf9; // graphic control
      if (label === 0xff) {
        const id = b.subarray(i + 3, i + 14).toString('latin1');
        keep = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0';
      }
      const end = (() => {
        const saved = i;
        i += 2;
        const e = subBlocks();
        i = saved;
        return e;
      })();
      if (keep) out.push(b.subarray(i, end));
      i = end;
    } else if (block === 0x2c) {
      if (i + 10 > b.length) throw bad('truncated GIF');
      const flags = b[i + 9];
      let j = i + 10;
      if (flags & 0x80) j += 3 * (1 << ((flags & 7) + 1));
      j += 1;
      if (j > b.length) throw bad('truncated GIF');
      const saved = i;
      i = j;
      const end = subBlocks();
      out.push(b.subarray(saved, end));
      i = end;
      frames += 1;
    } else {
      throw bad('bad GIF block');
    }
  }
  throw bad('GIF without trailer');
}

// ---------------------------------------------------------------- WebP

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

/** Keep the image, alpha and animation chunks (and a small ICCP); drop EXIF and XMP and unknown chunks, then fix the RIFF
 * size and the VP8X flags. Frames of an animation are kept whole: their sub-chunks are not rewritten. */
export function stripWebp(b) {
  if (b.length < 20 || b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') throw bad('not a WebP');
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length || riffEnd < 20) throw bad('truncated WebP');
  const chunks = [];
  let i = 12;
  let image = false;
  let icc = false;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) throw bad('truncated WebP chunk');
    const name = tag(b, i);
    const size = u32le(b, i + 4);
    const end = i + 8 + size + (size & 1);
    if (end > riffEnd + (size & 1) || i + 8 + size > riffEnd) throw bad('truncated WebP chunk');
    const keep = WEBP_KEEP.has(name) || (name === 'ICCP' && size <= ICC_MAX);
    if (keep) {
      const body = Buffer.from(b.subarray(i, Math.min(end, riffEnd)));
      if (name === 'VP8X') {
        if (size < 10) throw bad('bad WebP header');
        body[8] &= ~0x0c; // the Exif (0x08) and XMP (0x04) flags
        if (!(chunks.length === 0)) throw bad('misplaced WebP header');
      }
      if (name === 'VP8 ' || name === 'VP8L' || name === 'ANMF') image = true;
      if (name === 'ICCP') icc = true;
      chunks.push(body.length % 2 ? Buffer.concat([body, Buffer.from([0])]) : body);
    }
    i = end;
  }
  if (!image) throw bad('WebP without image data');
  if (!icc && chunks.length && chunks[0].subarray(0, 4).toString('latin1') === 'VP8X') chunks[0][8] &= ~0x20; // the profile was too large to keep
  const total = chunks.reduce((n, c) => n + c.length, 4);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(total, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, ...chunks]);
}

/** Strips by type; throws ImageError for a file that does not parse. */
export function stripImage(b, type) {
  if (type === 'image/jpeg') return stripJpeg(b);
  if (type === 'image/png') return stripPng(b);
  if (type === 'image/gif') return stripGif(b);
  if (type === 'image/webp') return stripWebp(b);
  throw bad('unsupported type');
}
