// Structural validation for the small, untrusted board preview images. This never decodes pixels.
export const MAX_PREVIEW_BYTES = 40_960;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'sBIT', 'bKGD', 'iCCP']);
const WEBP_CHUNKS = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP']);

const invalid = (reason) => ({ ok: false, reason });

function validDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width >= 64 && width <= 1280
    && height >= 64 && height <= 1280
    && width * height <= 1_000_000;
}

function dimensionResult(width, height) {
  return validDimensions(width, height)
    ? { ok: true, width, height }
    : invalid('invalid_dimensions');
}

function validatePng(bytes) {
  if (bytes.length < 33) return invalid('truncated');
  const firstLength = bytes.readUInt32BE(8);
  if (bytes.toString('ascii', 12, 16) !== 'IHDR' || firstLength !== 13) return invalid('invalid_png');
  if (8 + 12 + firstLength > bytes.length) return invalid('truncated');

  const dimensions = dimensionResult(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (!dimensions.ok) return dimensions;

  let offset = 8;
  let first = true;
  let hasData = false;
  let hasEnd = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return invalid('truncated');
    const length = bytes.readUInt32BE(offset);
    const name = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return invalid('truncated');
    if (first && name !== 'IHDR') return invalid('invalid_png');
    first = false;
    if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') return invalid('animated');
    if (!PNG_CHUNKS.has(name)) return invalid('unsupported_chunk');
    if (name === 'IHDR' && offset !== 8) return invalid('invalid_png');
    if (name === 'IDAT') hasData = true;
    if (name === 'IEND') {
      if (length !== 0) return invalid('invalid_png');
      if (end !== bytes.length) return invalid('trailing_data');
      hasEnd = true;
      break;
    }
    offset = end;
  }
  if (!hasEnd || !hasData) return invalid('truncated');
  return { ok: true, type: 'image/png', width: dimensions.width, height: dimensions.height };
}

function readVp8Dimensions(bytes, offset, length) {
  if (length < 10 || (bytes[offset] & 1) !== 0
    || bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 0x01 || bytes[offset + 5] !== 0x2a) {
    return invalid(length < 10 ? 'truncated' : 'invalid_webp');
  }
  const width = bytes.readUInt16LE(offset + 6) & 0x3fff;
  const height = bytes.readUInt16LE(offset + 8) & 0x3fff;
  return dimensionResult(width, height);
}

function readVp8lDimensions(bytes, offset, length) {
  if (length < 5) return invalid('truncated');
  if (bytes[offset] !== 0x2f) return invalid('invalid_webp');
  const bits = bytes.readUInt32LE(offset + 1);
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >>> 14) & 0x3fff) + 1;
  return dimensionResult(width, height);
}

function readVp8xDimensions(bytes, offset, length) {
  if (length !== 10) return invalid(length < 10 ? 'truncated' : 'invalid_webp');
  if (bytes[offset] & 0x02) return invalid('animated');
  const width = 1 + bytes[offset + 4] + (bytes[offset + 5] << 8) + (bytes[offset + 6] << 16);
  const height = 1 + bytes[offset + 7] + (bytes[offset + 8] << 8) + (bytes[offset + 9] << 16);
  return dimensionResult(width, height);
}

function validateWebp(bytes) {
  if (bytes.length < 20) return invalid('truncated');
  if (bytes.readUInt32LE(4) + 8 !== bytes.length || bytes.toString('ascii', 8, 12) !== 'WEBP') return invalid('invalid_riff_size');

  let offset = 12;
  let first = true;
  let imageType = null;
  let dimensions = null;
  let hasImage = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) return invalid('truncated');
    const name = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    const next = end + (length & 1);
    if (next > bytes.length) return invalid('truncated');
    if (first && name !== 'VP8 ' && name !== 'VP8L' && name !== 'VP8X') return invalid('invalid_webp');
    first = false;
    if (name === 'ANIM' || name === 'ANMF') return invalid('animated');
    if (name === 'EXIF' || name === 'XMP ') return invalid('metadata_chunk');
    if (!WEBP_CHUNKS.has(name)) return invalid('unsupported_chunk');

    if (offset === 12) {
      imageType = name;
      if (name === 'VP8X') dimensions = readVp8xDimensions(bytes, dataOffset, length);
      else if (name === 'VP8 ') dimensions = readVp8Dimensions(bytes, dataOffset, length);
      else dimensions = readVp8lDimensions(bytes, dataOffset, length);
      if (!dimensions.ok) return dimensions;
      hasImage = name === 'VP8 ' || name === 'VP8L';
    } else if (name === 'VP8 ' || name === 'VP8L') {
      if (hasImage) return invalid('invalid_webp');
      hasImage = true;
      if (imageType !== 'VP8X') return invalid('invalid_webp');
    } else if (name === 'VP8X') {
      return invalid('invalid_webp');
    }
    offset = next;
  }
  if (offset !== bytes.length || !hasImage) return invalid('truncated');
  return { ok: true, type: 'image/webp', width: dimensions.width, height: dimensions.height };
}

/** Validate the declared format and bounded container structure without decoding image data. */
export function validatePreviewImage(bytes, declaredType) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) return invalid('invalid_bytes');
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length > MAX_PREVIEW_BYTES) return invalid('too_large');

  let detectedType;
  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) detectedType = 'image/png';
  else if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') detectedType = 'image/webp';
  else return invalid('unsupported_type');

  if (typeof declaredType !== 'string' || declaredType.trim().toLowerCase() !== detectedType) return invalid('type_mismatch');
  return detectedType === 'image/png' ? validatePng(data) : validateWebp(data);
}
