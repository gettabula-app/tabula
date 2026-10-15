import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { MAX_PREVIEW_BYTES, validatePreviewImage } from '../server/preview-image.mjs';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([Buffer.from(name), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([length, crcInput, checksum]);
}

function png(width = 480, height = 300, chunks?: Buffer[]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([pngSignature, pngChunk('IHDR', header), ...(chunks ?? [pngChunk('IDAT', deflateSync(raw))]), pngChunk('IEND')]);
}

function webpChunk(name: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(name), length, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webp(chunks: Buffer[]) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const riffLength = Buffer.alloc(4);
  riffLength.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), riffLength, body]);
}

function vp8(width = 480, height = 300) {
  const header = Buffer.alloc(10);
  header[0] = 0;
  header[3] = 0x9d;
  header[4] = 0x01;
  header[5] = 0x2a;
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

function vp8l(width = 480, height = 300) {
  const header = Buffer.alloc(5);
  header[0] = 0x2f;
  header.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return header;
}

function vp8x(width = 480, height = 300, flags = 0) {
  const header = Buffer.alloc(10);
  header[0] = flags;
  const w = width - 1;
  const h = height - 1;
  header[4] = w & 0xff;
  header[5] = (w >>> 8) & 0xff;
  header[6] = (w >>> 16) & 0xff;
  header[7] = h & 0xff;
  header[8] = (h >>> 8) & 0xff;
  header[9] = (h >>> 16) & 0xff;
  return header;
}

const minimalPng = png();
const minimalWebp = webp([webpChunk('VP8 ', vp8())]);

describe('validatePreviewImage', () => {
  it.each([
    ['minimal PNG', minimalPng, 'image/png', { ok: true, type: 'image/png', width: 480, height: 300 }],
    ['minimal VP8 WebP', minimalWebp, 'image/webp', { ok: true, type: 'image/webp', width: 480, height: 300 }],
    ['lossless VP8L WebP', webp([webpChunk('VP8L', vp8l())]), 'image/webp', { ok: true, type: 'image/webp', width: 480, height: 300 }],
    ['extended VP8X WebP', webp([webpChunk('VP8X', vp8x()), webpChunk('VP8 ', vp8())]), 'image/webp', { ok: true, type: 'image/webp', width: 480, height: 300 }],
  ])('accepts %s', (_name, bytes, type, expected) => {
    expect(validatePreviewImage(bytes as Buffer, type as string)).toEqual(expected);
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png', 'unsupported_type'],
    ['GIF', Buffer.from('GIF89a'), 'image/gif', 'unsupported_type'],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg', 'unsupported_type'],
    ['unknown bytes', Buffer.from('not an image'), 'image/png', 'unsupported_type'],
    ['declared type mismatch', minimalPng, 'image/webp', 'type_mismatch'],
    ['truncated PNG signature', pngSignature, 'image/png', 'truncated'],
    ['PNG with IHDR not first', Buffer.concat([pngSignature, pngChunk('IDAT'), pngChunk('IHDR', Buffer.alloc(13)), pngChunk('IEND')]), 'image/png', 'invalid_png'],
    ['PNG with unsupported text chunk', png(480, 300, [pngChunk('tEXt', Buffer.from('secret')), pngChunk('IDAT', Buffer.from([0]))]), 'image/png', 'unsupported_chunk'],
    ['PNG APNG acTL', png(480, 300, [pngChunk('acTL', Buffer.alloc(8)), pngChunk('IDAT', Buffer.from([0]))]), 'image/png', 'animated'],
    ['PNG APNG fcTL', png(480, 300, [pngChunk('fcTL', Buffer.alloc(26)), pngChunk('IDAT', Buffer.from([0]))]), 'image/png', 'animated'],
    ['PNG APNG fdAT', png(480, 300, [pngChunk('fdAT', Buffer.alloc(4)), pngChunk('IDAT', Buffer.from([0]))]), 'image/png', 'animated'],
    ['truncated PNG chunk', Buffer.concat([pngSignature, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(8)]), 'image/png', 'truncated'],
    ['PNG chunk length past end', Buffer.concat([pngSignature, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0xff, 0xff, 0xff, 0xff])]), 'image/png', 'truncated'],
    ['PNG missing IEND', Buffer.concat([pngSignature, pngChunk('IHDR', Buffer.alloc(13)), pngChunk('IDAT', Buffer.from([0]))]), 'image/png', 'truncated'],
    ['PNG with data after IEND', Buffer.concat([minimalPng, Buffer.from('polyglot')]), 'image/png', 'trailing_data'],
    ['PNG width below 64', png(63, 300), 'image/png', 'invalid_dimensions'],
    ['PNG width above 1280', png(1281, 300), 'image/png', 'invalid_dimensions'],
    ['PNG pixel budget exceeded', png(1001, 1000), 'image/png', 'invalid_dimensions'],
    ['WebP RIFF size mismatch', Buffer.from(minimalWebp).fill(0, 4, 8), 'image/webp', 'invalid_riff_size'],
    ['WebP with unsupported first chunk', webp([webpChunk('ICCP', Buffer.alloc(2)), webpChunk('VP8 ', vp8())]), 'image/webp', 'invalid_webp'],
    ['WebP with truncated chunk', Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([20, 0, 0, 0])]), 'image/webp', 'truncated'],
    ['WebP VP8 width below 64', webp([webpChunk('VP8 ', vp8(63, 300))]), 'image/webp', 'invalid_dimensions'],
    ['WebP VP8L height above 1280', webp([webpChunk('VP8L', vp8l(480, 1281))]), 'image/webp', 'invalid_dimensions'],
    ['WebP VP8X pixel budget exceeded', webp([webpChunk('VP8X', vp8x(1001, 1000)), webpChunk('VP8 ', vp8(1001, 1000))]), 'image/webp', 'invalid_dimensions'],
    ['animated WebP VP8X flag', webp([webpChunk('VP8X', vp8x(480, 300, 0x02)), webpChunk('VP8 ', vp8())]), 'image/webp', 'animated'],
    ['animated WebP ANIM chunk', webp([webpChunk('VP8X', vp8x()), webpChunk('ANIM', Buffer.alloc(6)), webpChunk('VP8 ', vp8())]), 'image/webp', 'animated'],
    ['animated WebP ANMF chunk', webp([webpChunk('VP8X', vp8x()), webpChunk('ANMF', Buffer.alloc(16)), webpChunk('VP8 ', vp8())]), 'image/webp', 'animated'],
    ['WebP EXIF chunk', webp([webpChunk('VP8X', vp8x()), webpChunk('EXIF', Buffer.from('metadata')), webpChunk('VP8 ', vp8())]), 'image/webp', 'metadata_chunk'],
    ['WebP XMP chunk', webp([webpChunk('VP8X', vp8x()), webpChunk('XMP ', Buffer.from('metadata')), webpChunk('VP8 ', vp8())]), 'image/webp', 'metadata_chunk'],
    ['WebP unsupported chunk', webp([webpChunk('VP8X', vp8x()), webpChunk('JUNK', Buffer.alloc(0)), webpChunk('VP8 ', vp8())]), 'image/webp', 'unsupported_chunk'],
    ['WebP VP8X without image data', webp([webpChunk('VP8X', vp8x())]), 'image/webp', 'truncated'],
    ['oversize image', Buffer.concat([minimalPng, Buffer.alloc(MAX_PREVIEW_BYTES + 1)]), 'image/png', 'too_large'],
  ])('rejects %s', (_name, bytes, type, reason) => {
    expect(validatePreviewImage(bytes as Buffer, type as string)).toEqual({ ok: false, reason });
  });
});
