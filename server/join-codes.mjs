// One-board guest links (TAB-144). The clear code is returned once; only its SHA-256 digest reaches the directory.
import crypto from 'node:crypto';

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

export function hashJoinCode(code) {
  return sha256(code).toString('hex');
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

export function createJoinCodeService({ directory, now = Date.now } = {}) {
  if (!directory) throw new TypeError('directory is required');
  const limiter = createAttemptLimiter(now);

  function join({ code, name, source }) {
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const syntaxOk = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,8}$/.test(normalized);
    const candidate = sha256(normalized);
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

  return { join };
}
