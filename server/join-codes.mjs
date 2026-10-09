// One-board guest links (TAB-144). The clear code is returned once; only its server-keyed HMAC reaches the directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 8;
export const JOIN_CODE_DEFAULT_HOURS = 3;
export const JOIN_CODE_MAX_HOURS = 24;
export const JOIN_CODE_DEFAULT_USES = 100;
export const JOIN_CODE_MAX_USES = 1000;
export const JOIN_CODE_ERROR = 'This join code is not valid. Ask the board owner for a new one.';

const DUMMY_DIGEST = Buffer.alloc(32, 0xa5);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const digestBuffer = (hex) => typeof hex === 'string' && /^[\da-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : DUMMY_DIGEST;
export const JOIN_CODE_SECRET_FILE = 'join-code.secret';

/** Creates a persistent per-instance key beside directory.sqlite, never inside it. */
export function loadJoinCodeSecret(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, JOIN_CODE_SECRET_FILE);
  try {
    fs.lstatSync(file);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    const temp = path.join(dataDir, `${JOIN_CODE_SECRET_FILE}.tmp-${crypto.randomBytes(8).toString('hex')}`);
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, crypto.randomBytes(32));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        fs.linkSync(temp, file);
      } catch (linkError) {
        if (linkError?.code !== 'EEXIST') throw linkError;
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
    }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The join-code secret must be a regular file');
  if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  const secret = fs.readFileSync(file);
  if (secret.length !== 32) throw new Error('The join-code secret must contain exactly 32 bytes');
  return secret;
}

export function hashJoinCode(code, secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('a 32-byte join-code secret is required');
  return crypto.createHmac('sha256', secret).update(code).digest('hex');
}

export function generateJoinCode() {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) code += JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)];
  return code;
}

/** Display names are plain text: strip controls and invisible formatting, normalise spacing, then enforce the final length. */
export function sanitiseGuestName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim();
  const length = [...name].length;
  return length >= 1 && length <= 40 ? name : null;
}

function createAttemptLimiter(now) {
  const windows = new Map();
  const windowMs = 60_000;
  const sourceLimit = 20;
  const codeLimit = 5;
  const maxBuckets = 20_000;

  function sweep(t) {
    for (const [key, bucket] of windows) if (bucket.start <= t - windowMs) windows.delete(key);
  }

  return {
    hit(source, digest) {
      const t = now();
      const sourceKey = `source:${String(source || 'unknown').slice(0, 80)}`;
      const codeKey = `code:${digest}`;
      let sourceBucket = windows.get(sourceKey);
      let codeBucket = windows.get(codeKey);
      if (sourceBucket?.start <= t - windowMs) sourceBucket = undefined;
      if (codeBucket?.start <= t - windowMs) codeBucket = undefined;
      if (sourceBucket && sourceBucket.count >= sourceLimit) return false;
      if (codeBucket && codeBucket.count >= codeLimit) return false;

      const needed = Number(!sourceBucket) + Number(!codeBucket);
      if (windows.size + needed > maxBuckets) {
        sweep(t);
        sourceBucket = windows.get(sourceKey);
        codeBucket = windows.get(codeKey);
        if (sourceBucket?.start <= t - windowMs) sourceBucket = undefined;
        if (codeBucket?.start <= t - windowMs) codeBucket = undefined;
        if (windows.size + Number(!sourceBucket) + Number(!codeBucket) > maxBuckets) return false;
      }
      if (!sourceBucket) windows.set(sourceKey, (sourceBucket = { start: t, count: 0 }));
      if (!codeBucket) windows.set(codeKey, (codeBucket = { start: t, count: 0 }));
      sourceBucket.count++;
      codeBucket.count++;
      return true;
    },
  };
}

export function createJoinCodeService({ directory, secret, now = Date.now } = {}) {
  if (!directory) throw new TypeError('directory is required');
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('a 32-byte join-code secret is required');
  const limiter = createAttemptLimiter(now);
  const hashCode = (code) => hashJoinCode(code, secret);

  function join({ code, name, source }) {
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const syntaxOk = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,8}$/.test(normalized);
    const candidate = Buffer.from(hashCode(normalized), 'hex');
    if (!limiter.hit(source, candidate.toString('hex'))) return { limited: true };
    const displayName = sanitiseGuestName(name);
    if (displayName === null) return { badName: true };

    const found = directory.findJoinCodeByHash(candidate.toString('hex'));
    const stored = found ? digestBuffer(found.codeHash) : DUMMY_DIGEST;
    const matches = crypto.timingSafeEqual(candidate, stored);
    if (!syntaxOk || !found || !matches) return null;

    return directory.transaction(() => {
      // Re-read under the write lock, compare fixed-size digests again, and atomically spend a use with the session insert.
      const current = directory.getJoinCode(found.id);
      const currentDigest = current ? digestBuffer(current.codeHash) : DUMMY_DIGEST;
      const currentMatches = crypto.timingSafeEqual(candidate, currentDigest);
      if (!current || !currentMatches || current.revokedAt !== null || current.expiresAt <= now() || current.uses >= current.maxUses) return null;
      const token = crypto.randomBytes(32).toString('base64url');
      const guest = directory.createGuestSession(current.id, {
        tokenHash: sha256(token).toString('hex'), name: displayName, now: now(),
      });
      if (!guest) return null;
      directory.audit(null, 'join-code.used', { boardId: guest.boardId, joinCodeId: current.id, role: guest.role });
      return { token, ...guest };
    });
  }

  return { join, hashCode };
}
