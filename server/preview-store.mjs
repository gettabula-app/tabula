import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validatePreviewImage } from './preview-image.mjs';

const INSIDE = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const etagOf = (bytes) => `"${createHash('sha256').update(bytes).digest('hex')}"`;

export function createDevPreviewStore({ dataDir, now = Date.now }) {
  const directory = path.resolve(dataDir, 'previews-dev');

  function realDirectory({ create = false } = {}) {
    if (create) {
      try {
        fs.lstatSync(directory);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        fs.mkdirSync(directory, { mode: 0o700 });
      }
    }
    let info;
    try {
      info = fs.lstatSync(directory);
    } catch (error) {
      if (error?.code === 'ENOENT' && !create) return null;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The preview store must be a real directory');
    const root = fs.realpathSync(directory);
    const parent = fs.realpathSync(path.dirname(directory));
    if (root !== path.resolve(parent, path.basename(directory))) throw new Error('The preview store escaped its data directory');
    if (create) fs.chmodSync(root, 0o700);
    return root;
  }

  function imageName(boardId) {
    if (typeof boardId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(boardId)) throw new TypeError('Invalid board id');
    return `${createHash('sha256').update(boardId).digest('hex')}.img`;
  }

  function safePath(root, filename) {
    const resolved = path.resolve(root, filename);
    if (!INSIDE(root, resolved) || path.dirname(resolved) !== root) throw new Error('The preview path escaped its store');
    try {
      const info = fs.lstatSync(resolved);
      if (info.isSymbolicLink()) throw new Error('The preview store cannot contain symbolic links');
      const real = fs.realpathSync(resolved);
      if (!INSIDE(root, real)) throw new Error('The preview path escaped its store');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return resolved;
  }

  function readFile(root, filename, maxBytes) {
    const target = safePath(root, filename);
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > maxBytes) return null;
      const real = fs.realpathSync(target);
      if (!INSIDE(root, real)) throw new Error('The preview path escaped its store');
      return fs.readFileSync(fd);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return null;
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function writeTemp(root, bytes) {
    const filename = `.preview-${randomUUID()}.tmp`;
    const target = safePath(root, filename);
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { filename, target };
  }

  function read(boardId) {
    const root = realDirectory();
    if (!root) return null;
    const filename = imageName(boardId);
    const metadataName = `${filename.slice(0, -4)}.json`;
    const bytes = readFile(root, filename, 40_960);
    const rawMetadata = readFile(root, metadataName, 4096);
    if (!bytes || !rawMetadata) return null;
    let metadata;
    try {
      metadata = JSON.parse(rawMetadata.toString('utf8'));
    } catch {
      return null;
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const expectedKeys = ['at', 'bytes', 'etag', 'type', 'uploadedBy', 'width', 'height'];
    if (Object.keys(metadata).sort().join(',') !== expectedKeys.sort().join(',')) return null;
    if (!Number.isSafeInteger(metadata.at) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes !== bytes.length
      || typeof metadata.uploadedBy !== 'string' || typeof metadata.type !== 'string'
      || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)) return null;
    const etag = etagOf(bytes);
    if (metadata.etag !== etag) return null;
    const checked = validatePreviewImage(bytes, metadata.type);
    if (!checked.ok || checked.width !== metadata.width || checked.height !== metadata.height) return null;
    return { bytes, type: checked.type, width: checked.width, height: checked.height, uploadedBy: metadata.uploadedBy, at: metadata.at, etag };
  }

  function put({ boardId, bytes, image, uploadedBy }) {
    const root = realDirectory({ create: true });
    const filename = imageName(boardId);
    const metadataName = `${filename.slice(0, -4)}.json`;
    const imagePath = safePath(root, filename);
    const metadataPath = safePath(root, metadataName);
    const etag = etagOf(bytes);
    const at = now();
    const metadata = Buffer.from(JSON.stringify({
      type: image.type,
      width: image.width,
      height: image.height,
      bytes: bytes.length,
      uploadedBy,
      at,
      etag,
    }));
    let imageTemp;
    let metadataTemp;
    try {
      imageTemp = writeTemp(root, bytes);
      metadataTemp = writeTemp(root, metadata);
      safePath(root, filename);
      safePath(root, metadataName);
      fs.renameSync(imageTemp.target, imagePath);
      imageTemp = null;
      fs.chmodSync(imagePath, 0o600);
      fs.renameSync(metadataTemp.target, metadataPath);
      metadataTemp = null;
      fs.chmodSync(metadataPath, 0o600);
    } finally {
      if (imageTemp) fs.rmSync(imageTemp.target, { force: true });
      if (metadataTemp) fs.rmSync(metadataTemp.target, { force: true });
    }
    return { type: image.type, width: image.width, height: image.height, bytes: bytes.length, uploadedBy, at, etag };
  }

  function remove(boardId) {
    const root = realDirectory();
    if (!root) return false;
    const filename = imageName(boardId);
    let removed = false;
    for (const name of [filename, `${filename.slice(0, -4)}.json`]) {
      const target = safePath(root, name);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        removed = true;
      }
    }
    return removed;
  }

  return { directory, read, put, remove };
}
