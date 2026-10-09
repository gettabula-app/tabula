// Image type and size from the first bytes of a file, without decoding any pixels (docs/images.md, Security 1 and 4).
// Pure functions over a Buffer or Uint8Array. They never throw on hostile input: a file they cannot read gives null.
// The browser has a copy of the same logic in src/images.ts; test/image-header.test.ts pins both to the same cases.

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Decompression bombs: a small file can claim a huge canvas. 36 megapixels and 16384 on a side are far above any
// screenshot or photo that went through the client's 2560 px downscale, and still decode in a browser.
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 36_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (b, bytes, at = 0) => b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v);
const ascii = (b, at, text) => b.length >= at + text.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
const u16be = (b, at) => (b[at] << 8) | b[at + 1];
const u16le = (b, at) => b[at] | (b[at + 1] << 8);
const u24le = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b, at) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;

/** The type the magic bytes say, or null. This is the only way a stored type is decided. */
export function sniffType(b) {
  if (!b || b.length < 12) return null;
  if (startsWith(b, PNG_SIGNATURE)) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  return null;
}

/** True when the size is positive and inside both caps. */
export function sizeOk(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
}

function pngInfo(b) {
  // the first chunk of a PNG is IHDR: length 13, then width and height
  if (b.length < 33 || u32be(b, 8) !== 13 || !ascii(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20), animated: false };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegInfo(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) { // fill bytes
      i += 1;
      marker = b[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before any frame header
    const length = u16be(b, i + 2);
    if (length < 2 || i + 2 + length > b.length) return null;
    if (SOF.has(marker)) {
      if (length < 8) return null;
      return { width: u16be(b, i + 7), height: u16be(b, i + 5), animated: false };
    }
    i += 2 + length;
  }
  return null;
}

function gifInfo(b) {
  if (b.length < 13) return null;
  return { width: u16le(b, 6), height: u16le(b, 8), animated: gifFrames(b) > 1 };
}

/** Number of image descriptors in a GIF, counted by walking its blocks. Stops at the trailer or at a malformed block. */
export function gifFrames(b) {
  if (b.length < 13) return 0;
  let i = 13;
  if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1));
  let frames = 0;
  while (i < b.length) {
    const block = b[i];
    if (block === 0x3b) break;
    if (block === 0x21) {
      i += 2;
      for (;;) {
        if (i >= b.length) return frames;
        const size = b[i];
        i += 1 + size;
        if (size === 0) break;
      }
    } else if (block === 0x2c) {
      if (i + 10 > b.length) return frames;
      const flags = b[i + 9];
      i += 10;
      if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1));
      i += 1; // LZW minimum code size
      for (;;) {
        if (i >= b.length) return frames;
        const size = b[i];
        i += 1 + size;
        if (size === 0) break;
      }
      frames += 1;
    } else {
      break;
    }
  }
  return frames;
}

function webpInfo(b) {
  if (b.length < 30) return null;
  const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (kind === 'VP8X') {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: (b[20] & 0x02) !== 0 };
  }
  if (kind === 'VP8 ') {
    // frame tag (3 bytes), start code 9D 01 2A, then 14-bit width and height
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, animated: false };
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  return null;
}

/** `{ width, height, animated }` from the header of a file of the given type, or null when it cannot be read. */
export function readImageInfo(b, type) {
  try {
    if (type === 'image/png') return pngInfo(b);
    if (type === 'image/jpeg') return jpegInfo(b);
    if (type === 'image/gif') return gifInfo(b);
    if (type === 'image/webp') return webpInfo(b);
  } catch {
    return null;
  }
  return null;
}
