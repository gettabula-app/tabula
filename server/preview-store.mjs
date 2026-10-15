import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validatePreviewImage } from './preview-image.mjs';

export const DEFAULT_PREVIEW_STORE_MAX_BYTES = 64 * 1024 * 1024;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INSIDE = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const etagOf = (bytes) => `"${createHash('sha256').update(bytes).digest('hex')}"`;

export function createPreviewStore({ dataDir, now = Date.now, maxBytes = DEFAULT_PREVIEW_STORE_MAX_BYTES, log = () => {} }) {
  const directory = path.resolve(dataDir, 'previews');
  let warned = false;

  function warnOnce() {
    if (warned) return;
    warned = true;
    try { log('warn', 'previews: cache maintenance failed'); } catch { /* logging cannot affect the cache */ }
  }

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
    if (typeof boardId !== 'string' || !BOARD_ID_RE.test(boardId)) throw new TypeError('Invalid board id');
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

  function readFile(root, filename, maxFileBytes) {
    const target = safePath(root, filename);
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > maxFileBytes) return null;
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
    } catch (error) {
      try { fs.rmSync(target, { force: true }); } catch { /* preserve the original write error */ }
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    return { filename, target };
  }

  function metadataFor(root, imageFilename) {
    const raw = readFile(root, `${imageFilename.slice(0, -4)}.json`, 4096);
    if (!raw) return null;
    try {
      const metadata = JSON.parse(raw.toString('utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
      if (Object.keys(metadata).sort().join(',') !== ['at', 'boardId', 'bytes', 'etag', 'height', 'type', 'uploadedBy', 'width'].sort().join(',')) return null;
      if (typeof metadata.boardId !== 'string' || !BOARD_ID_RE.test(metadata.boardId) || imageName(metadata.boardId) !== imageFilename) return null;
      if (!Number.isSafeInteger(metadata.at) || !Number.isSafeInteger(metadata.bytes) || typeof metadata.uploadedBy !== 'string'
        || typeof metadata.type !== 'string' || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)) return null;
      return metadata;
    } catch {
      return null;
    }
  }

  function scan(root) {
    const names = fs.readdirSync(root);
    const files = [];
    let bytes = 0;
    for (const name of names) {
      const target = safePath(root, name);
      const info = fs.lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      files.push({ name, bytes: info.size, at: info.mtimeMs });
      bytes += info.size;
    }
    const byName = new Map(files.map((file) => [file.name, file]));
    const entries = [];
    for (const file of files) {
      if (!file.name.endsWith('.img')) continue;
      const metadata = metadataFor(root, file.name);
      if (!metadata) continue;
      const sidecar = byName.get(`${file.name.slice(0, -4)}.json`);
      if (!sidecar) continue;
      entries.push({ filename: file.name, boardId: metadata.boardId, at: metadata.at, bytes: file.bytes + sidecar.bytes });
    }
    return { files, entries, bytes };
  }

  function removeEntry(root, filename) {
    const base = filename.slice(0, -4);
    let removed = false;
    for (const name of [filename, `${base}.json`]) {
      const target = safePath(root, name);
      try { fs.lstatSync(target); } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      fs.rmSync(target, { force: true });
      removed = true;
    }
    return removed;
  }

  function read(boardId) {
    const filename = imageName(boardId);
    const root = realDirectory();
    if (!root) return null;
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
    const expectedKeys = ['at', 'boardId', 'bytes', 'etag', 'type', 'uploadedBy', 'width', 'height'];
    if (Object.keys(metadata).sort().join(',') !== expectedKeys.sort().join(',')) return null;
    if (metadata.boardId !== boardId || typeof metadata.boardId !== 'string' || !BOARD_ID_RE.test(metadata.boardId)) return null;
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
    const filename = imageName(boardId);
    const root = realDirectory({ create: true });
    const metadataName = `${filename.slice(0, -4)}.json`;
    const imagePath = safePath(root, filename);
    const metadataPath = safePath(root, metadataName);
    const etag = etagOf(bytes);
    const at = now();
    const metadata = Buffer.from(JSON.stringify({
      boardId,
      type: image.type,
      width: image.width,
      height: image.height,
      bytes: bytes.length,
      uploadedBy,
      at,
      etag,
    }));

    const { files, entries } = scan(root);
    const byName = new Map(files.map((file) => [file.name, file]));
    let projectedBytes = files.reduce((total, file) => total + file.bytes, 0)
      - (byName.get(filename)?.bytes ?? 0)
      - (byName.get(metadataName)?.bytes ?? 0)
      + bytes.length + metadata.length;
    const cap = Number.isFinite(maxBytes) ? Math.max(1, maxBytes) : DEFAULT_PREVIEW_STORE_MAX_BYTES;
    const oldest = entries.filter((entry) => entry.boardId !== boardId).sort((a, b) => a.at - b.at || a.filename.localeCompare(b.filename));
    for (const entry of oldest) {
      if (projectedBytes <= cap) break;
      if (removeEntry(root, entry.filename)) projectedBytes -= entry.bytes;
    }
    if (projectedBytes > cap) throw new Error('The preview cache is at its size limit');

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
    try {
      const filename = imageName(boardId);
      const root = realDirectory();
      if (!root) return false;
      return removeEntry(root, filename);
    } catch {
      warnOnce();
      return false;
    }
  }

  // Sync-path invalidation must not wait for disk I/O or let a cache error affect a Yjs write.
  function unlink(boardId) {
    try {
      const filename = imageName(boardId);
      // Use only the configured cache path here: resolving the directory on disk would make the Yjs observer synchronous I/O.
      for (const name of [filename, `${filename.slice(0, -4)}.json`]) {
        // imageName returns a fixed hash filename, so this path needs no synchronous disk check.
        void fs.promises.rm(path.join(directory, name), { force: true }).catch(() => {});
      }
    } catch { /* a preview is optional; a cache failure cannot affect sync */ }
  }

  function clear() {
    try {
      const root = realDirectory();
      if (!root) return 0;
      let removed = 0;
      for (const name of fs.readdirSync(root)) {
        try {
          const target = path.join(root, name);
          const info = fs.lstatSync(target);
          fs.rmSync(target, { force: true, recursive: info.isDirectory() && !info.isSymbolicLink() });
          removed++;
        } catch {
          warnOnce();
        }
      }
      return removed;
    } catch {
      warnOnce();
      return 0;
    }
  }

  /** @param {(boardId: string) => boolean | Promise<boolean>} [existsFn] */
  async function sweep(existsFn = () => true) {
    let removed = 0;
    try {
      let directoryInfo;
      try {
        directoryInfo = await fs.promises.lstat(directory);
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed };
        throw error;
      }
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('The preview store must be a real directory');
      const root = await fs.promises.realpath(directory);
      const parent = await fs.promises.realpath(path.dirname(directory));
      if (root !== path.resolve(parent, path.basename(directory))) throw new Error('The preview store escaped its data directory');
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
      const removeSafe = async (name) => {
        try {
          await fs.promises.rm(path.join(root, name), { force: true });
          removed++;
        } catch {
          warnOnce();
        }
      };
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (/^\.preview-[A-Fa-f0-9-]+\.tmp$/.test(entry.name)) {
          try {
            const info = await fs.promises.stat(path.join(root, entry.name));
            if (now() - info.mtimeMs > TMP_MAX_AGE_MS) await removeSafe(entry.name);
          } catch { warnOnce(); }
          continue;
        }
        if (!/^[a-f0-9]{64}\.(?:img|json)$/.test(entry.name)) continue;
        const base = entry.name.slice(0, -4);
        const image = `${base}.img`;
        const sidecar = `${base}.json`;
        if (!names.has(image) || !names.has(sidecar)) {
          await removeSafe(entry.name);
          continue;
        }
        if (!entry.name.endsWith('.json')) continue;
        let metadata = null;
        let raw = null;
        let handle;
        try {
          const target = path.join(root, sidecar);
          handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          const info = await handle.stat();
          if (info.isFile() && info.size <= 4096 && INSIDE(root, await fs.promises.realpath(target))) raw = await handle.readFile();
        } catch {
          warnOnce();
        } finally {
          try { await handle?.close(); } catch { warnOnce(); }
        }
        if (raw) {
          try {
            const value = JSON.parse(raw.toString('utf8'));
            if (value && typeof value === 'object' && !Array.isArray(value)
              && Object.keys(value).sort().join(',') === ['at', 'boardId', 'bytes', 'etag', 'height', 'type', 'uploadedBy', 'width'].sort().join(',')
              && typeof value.boardId === 'string' && BOARD_ID_RE.test(value.boardId) && imageName(value.boardId) === image
              && Number.isSafeInteger(value.at) && Number.isSafeInteger(value.bytes) && typeof value.uploadedBy === 'string'
              && typeof value.type === 'string' && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)) metadata = value;
          } catch { /* malformed sidecars are treated as absent */ }
        }
        if (!metadata) {
          await removeSafe(image);
          await removeSafe(sidecar);
          continue;
        }
        let exists;
        try {
          exists = await existsFn(metadata.boardId);
        } catch {
          warnOnce();
          continue;
        }
        if (!exists) {
          await removeSafe(image);
          await removeSafe(sidecar);
        }
      }
    } catch {
      warnOnce();
    }
    return { removed };
  }

  function list() {
    try {
      const root = realDirectory();
      if (!root) return { count: 0, bytes: 0 };
      const result = scan(root);
      return { count: result.entries.length, bytes: result.bytes };
    } catch {
      warnOnce();
      return { count: 0, bytes: 0 };
    }
  }

  return { directory, read, put, remove, unlink, clear, sweep, list };
}
