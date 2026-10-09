// Off-site backups (docs/backups.md). When TABULA_BACKUP_* is set the relay copies the data directory to an
// S3-compatible bucket on a schedule. Everything is encrypted on the instance before it leaves it: the provider only
// ever sees ciphertext and opaque names.
//
//   <prefix>/objects/<objectId>              one file, content addressed (objectId = HMAC-SHA256(nameKey, plaintext))
//   <prefix>/manifests/<UTC timestamp>.json.enc   the list of files of one backup; written last, so a half done run is invisible
//
// Sealed format of both: version (1) | key id (4) | nonce (12) | AES-256-GCM ciphertext | tag (16). The additional
// authenticated data is the first five bytes plus 'obj:<objectId>' or 'manifest:<file name>', so an object cannot be
// swapped for another one, a manifest cannot be renamed, and the key id in the clear cannot be changed.
//
// The S3 client is a small SigV4 signer over the global fetch (no SDK). Nothing in this file logs, stores or throws
// the master key, the secret key, an Authorization header or a URL: errors carry a status and an S3 error code only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withLegacyEnv } from './env.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A single file above this size fails the run (everything is read into memory once; streaming is later work). */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
const FORMAT_VERSION = 1;
const HEADER_LEN = 5;
const NONCE_LEN = 12;
const TAG_LEN = 16;
/** Bytes a sealed object adds to its plaintext. */
export const OVERHEAD = HEADER_LEN + NONCE_LEN + TAG_LEN;
const CRYPTO_CHUNK = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_FILES = 1_000_000;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY = 64 * 1024;
const MAX_XML_NODES = 200_000;
const MAX_XML_DEPTH = 12;
const MAX_LIST_PAGES = 100_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [500, 2_000, 8_000];
const GC_GRACE_MS = HOUR_MS;
const FIRST_RUN_MIN_MS = MINUTE_MS;
const FIRST_RUN_SPAN_MS = 4 * MINUTE_MS;
const STATUS_KEY = 'backup.status';
/** The settings row that keeps manifests safe from pruning (restore.mjs writes it): a JSON object, manifest name to expiry in ms. */
export const PROTECTED_KEY = 'backup.protected';
const MAX_PREVIOUS_KEYS = 8;
const ERROR_MAX = 200;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const REQUIRED = ['S3_ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY', 'KEY'];
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const REGION_RE = /^[A-Za-z0-9-]{1,40}$/;
const CREDENTIAL_RE = /^[\x21-\x7e]{1,512}$/;
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY_RE = /^[A-Za-z0-9+/_-]{43}={0,1}$/;
const OBJECT_ID_RE = /^[0-9a-f]{64}$/;
const MANIFEST_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.enc$/;
const ROOM_FILE_RE = /^[A-Za-z0-9_-]{1,64}(?:~comments)?\.yjs$/;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const ASSET_PATH_RE = /^assets\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const STALE_TEMP_RE = /^directory\.sqlite\.backup-[0-9a-f]{16}\.tmp(?:-journal|-wal|-shm)?$/;
const S3_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ERRNO_RE = /^[A-Z0-9_]{2,40}$/;

const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
})();

/**
 * A backup operation failed. `code` is stable and meant for tests and callers:
 * bad_format, unknown_key, tamper (GCM cannot tell a flipped bit from a swapped object), content_mismatch,
 * invalid_manifest, invalid_path, not_found, s3 (with `status` and `s3Code`), network, timeout, too_large,
 * readback, inconsistent, aborted. The message never holds a secret, header or URL.
 */
export class BackupError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.s3Code) this.s3Code = extra.s3Code;
    if (extra.retryable) Object.defineProperty(this, 'retryable', { value: true });
  }
}

const aborted = () => new BackupError('aborted', 'The backup was stopped');
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ---------------------------------------------------------------- configuration

const fullName = (name) => `TABULA_BACKUP_${name}`;
const backupVar = (env, name) => (env[fullName(name)] ?? '').trim();

/** The 32 byte key from 64 hex characters, or base64 / base64url (padding optional). null when it is anything else. */
function decodeKey(raw) {
  const value = raw.trim();
  if (HEX_KEY_RE.test(value)) return Buffer.from(value, 'hex');
  if (BASE64_KEY_RE.test(value)) {
    const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (bytes.length === 32) return bytes;
  }
  return null;
}

function wholeNumber(env, name, fallback, min, max) {
  const raw = backupVar(env, name);
  if (!raw) return fallback;
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${fullName(name)} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Every spelling of a key that could end up in a message: the secrets the scrubber must remove. */
function keySpellings(raw, bytes) {
  return [raw.trim(), bytes.toString('hex'), bytes.toString('hex').toUpperCase(), bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('base64').replace(/=+$/, '')];
}

/**
 * @typedef {object} BackupConfig
 * @property {string} endpoint origin of the S3 endpoint, for example https://fly.storage.tigris.dev
 * @property {string} bucket
 * @property {string} prefix
 * @property {string} region
 * @property {boolean} pathStyle
 * @property {number} intervalMinutes
 * @property {number} keepHourlyHours
 * @property {number} keepDailyDays
 * @property {string} accessKey not enumerable
 * @property {string} secretKey not enumerable
 * @property {Buffer} key the master key, not enumerable
 * @property {Buffer[]} previousKeys keys that can still be read, not enumerable
 * @property {string[]} secrets every spelling of a secret, for the scrubber, not enumerable
 */

/**
 * Reads TABULA_BACKUP_* (the old MIRA_ spelling too). Returns null when backups are off (none of the five required
 * variables is set). Some but not all of them, or any invalid value, throws an error that names the variable and never
 * the value. The secrets sit on non-enumerable properties, so the config cannot be printed or serialised by accident.
 * @param {Record<string, string | undefined>} [rawEnv]
 * @param {(message: string) => void} [warn]
 * @returns {BackupConfig | null}
 */
export function loadBackupConfig(rawEnv = process.env, warn = console.warn) {
  const env = withLegacyEnv(rawEnv, warn);
  const missing = REQUIRED.filter((name) => !backupVar(env, name));
  if (missing.length === REQUIRED.length) return null;
  if (missing.length) {
    throw new Error(`${REQUIRED.map(fullName).join(', ')} must be set together (missing ${missing.map(fullName).join(', ')})`);
  }

  let url;
  try {
    url = new URL(backupVar(env, 'S3_ENDPOINT'));
  } catch {
    throw new Error('TABULA_BACKUP_S3_ENDPOINT is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('TABULA_BACKUP_S3_ENDPOINT must be an https:// URL (http:// is only allowed for localhost)');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('TABULA_BACKUP_S3_ENDPOINT must be a bare address without credentials, a path, a query or a fragment');
  }

  const bucket = backupVar(env, 'BUCKET');
  if (!BUCKET_RE.test(bucket) || bucket.includes('..')) {
    throw new Error('TABULA_BACKUP_BUCKET must be 3 to 63 lowercase letters, digits, dots or hyphens');
  }
  const accessKey = backupVar(env, 'ACCESS_KEY');
  const secretKey = backupVar(env, 'SECRET_KEY');
  if (!CREDENTIAL_RE.test(accessKey)) throw new Error('TABULA_BACKUP_ACCESS_KEY must be printable characters without spaces');
  if (!CREDENTIAL_RE.test(secretKey)) throw new Error('TABULA_BACKUP_SECRET_KEY must be printable characters without spaces');

  const rawKey = backupVar(env, 'KEY');
  const key = decodeKey(rawKey);
  if (!key) throw new Error('TABULA_BACKUP_KEY must be 32 bytes, written as 64 hex characters or as base64');
  const spellings = keySpellings(rawKey, key);
  const previousKeys = [];
  const previousRaw = backupVar(env, 'KEY_PREVIOUS')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (previousRaw.length > MAX_PREVIOUS_KEYS) throw new Error(`TABULA_BACKUP_KEY_PREVIOUS takes at most ${MAX_PREVIOUS_KEYS} keys`);
  previousRaw.forEach((part, i) => {
    const bytes = decodeKey(part);
    if (!bytes) throw new Error(`TABULA_BACKUP_KEY_PREVIOUS entry ${i + 1} must be 32 bytes, written as 64 hex characters or as base64`);
    spellings.push(...keySpellings(part, bytes));
    if (!bytes.equals(key) && !previousKeys.some((k) => k.equals(bytes))) previousKeys.push(bytes);
  });

  const prefix = backupVar(env, 'PREFIX').replace(/^\/+|\/+$/g, '') || 'tabula';
  if (prefix.length > 200 || !PREFIX_RE.test(prefix)) {
    throw new Error('TABULA_BACKUP_PREFIX must be letters, digits, . - _ and / between them, up to 200 characters');
  }
  const region = backupVar(env, 'REGION') || 'auto';
  if (!REGION_RE.test(region)) throw new Error('TABULA_BACKUP_REGION must be letters, digits and hyphens');
  const style = backupVar(env, 'PATH_STYLE') || 'on';
  if (style !== 'on' && style !== 'off') throw new Error('TABULA_BACKUP_PATH_STYLE must be on or off');
  const pathStyle = style === 'on';
  if (!pathStyle && (LOCAL_HOSTS.has(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('['))) {
    throw new Error('TABULA_BACKUP_PATH_STYLE=off needs a DNS name in TABULA_BACKUP_S3_ENDPOINT, not an IP address or localhost');
  }

  const intervalMinutes = wholeNumber(env, 'INTERVAL_MINUTES', 60, 5, 10_080);
  const keepHourlyHours = wholeNumber(env, 'KEEP_HOURLY_HOURS', 48, 0, 8_760);
  const keepDailyDays = wholeNumber(env, 'KEEP_DAILY_DAYS', 30, 0, 3_650);

  const config = {
    endpoint: `${url.protocol}//${url.host}`,
    bucket,
    prefix,
    region,
    pathStyle,
    intervalMinutes,
    keepHourlyHours,
    keepDailyDays,
  };
  Object.defineProperties(config, {
    accessKey: { value: accessKey },
    secretKey: { value: secretKey },
    key: { value: key },
    previousKeys: { value: previousKeys },
    secrets: { value: [accessKey, secretKey, ...spellings] },
  });
  return config;
}

/**
 * Removes what must never reach a log line, an audit row, the status or an error message: the literals it is given,
 * signatures, credential scopes, Authorization headers and the user info of a URL.
 * @param {string[]} [secrets]
 */
export function createScrubber(secrets = []) {
  const literals = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  return (value) => {
    let text = String(value ?? '');
    for (const secret of literals) text = text.split(secret).join('[hidden]');
    return text
      .replace(/(signature=)[0-9a-fA-F]+/gi, '$1[hidden]')
      .replace(/(credential=)[^,&\s]+/gi, '$1[hidden]')
      .replace(/(x-amz-security-token=)[^&\s]+/gi, '$1[hidden]')
      .replace(/AWS4-HMAC-SHA256[^\n]*/g, 'AWS4-HMAC-SHA256 [hidden]')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[hidden]@')
      .replace(/\p{Cc}+/gu, ' ');
  };
}

// ---------------------------------------------------------------- keys and sealing

const hkdf = (master, info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32));

/**
 * Everything derived from one master key. `keyId` (the first four bytes of its own derivation, as 8 hex characters)
 * tells a reader which key sealed an object without revealing the key.
 * @param {Buffer} master 32 bytes
 */
export function deriveKeys(master) {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new BackupError('unknown_key', 'The master key must be 32 bytes');
  const keyIdBytes = hkdf(master, 'tabula-backup/keyid/v1').subarray(0, 4);
  return {
    encKey: hkdf(master, 'tabula-backup/enc/v1'),
    nameKey: hkdf(master, 'tabula-backup/name/v1'),
    keyIdBytes: Buffer.from(keyIdBytes),
    keyId: keyIdBytes.toString('hex'),
  };
}

/**
 * The key used to write and the keys that can still be read.
 * @param {Buffer[]} masters the first one is the key objects are written with
 */
export function createKeyring(masters) {
  const all = masters.map(deriveKeys);
  const byId = new Map();
  for (const keys of all) {
    const other = byId.get(keys.keyId);
    if (other && !other.encKey.equals(keys.encKey)) throw new BackupError('unknown_key', 'Two keys have the same key id');
    byId.set(keys.keyId, keys);
  }
  return { current: all[0], byId };
}

/** The content address of a file: keyed, so the provider cannot confirm a guess about what a file contains. */
export const objectIdOf = (plaintext, keys) => hmac(keys.nameKey, plaintext).toString('hex');

/**
 * @param {Buffer} plaintext
 * @param {string} name 'obj:<objectId>' or 'manifest:<file name>'
 * @param {ReturnType<typeof deriveKeys>} keys
 */
export function seal(plaintext, name, keys) {
  const header = Buffer.concat([Buffer.from([FORMAT_VERSION]), keys.keyIdBytes]);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.encKey, nonce);
  cipher.setAAD(Buffer.concat([header, Buffer.from(name, 'utf8')]));
  const out = Buffer.allocUnsafe(HEADER_LEN + NONCE_LEN + plaintext.length + TAG_LEN);
  header.copy(out, 0);
  nonce.copy(out, HEADER_LEN);
  let pos = HEADER_LEN + NONCE_LEN;
  for (let off = 0; off < plaintext.length; off += CRYPTO_CHUNK) {
    pos += cipher.update(plaintext.subarray(off, off + CRYPTO_CHUNK)).copy(out, pos);
  }
  pos += cipher.final().copy(out, pos);
  cipher.getAuthTag().copy(out, pos);
  return out;
}

/**
 * Decrypts and verifies a sealed buffer. Throws BackupError: bad_format (too short, unknown version), unknown_key
 * (sealed with a key this instance does not hold), tamper (the tag does not match: a flipped bit, truncation, or an
 * object or manifest under another name).
 * @param {Buffer} sealed
 * @param {string} name
 * @param {ReturnType<typeof createKeyring>} keyring
 */
export function unseal(sealed, name, keyring) {
  if (!Buffer.isBuffer(sealed) || sealed.length < OVERHEAD) throw new BackupError('bad_format', 'The backup file is too short to be valid');
  if (sealed[0] !== FORMAT_VERSION) throw new BackupError('bad_format', 'The backup file has an unknown format version');
  const keys = keyring.byId.get(sealed.subarray(1, HEADER_LEN).toString('hex'));
  if (!keys) throw new BackupError('unknown_key', 'The backup file was sealed with a key this instance does not have');
  const header = sealed.subarray(0, HEADER_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keys.encKey, sealed.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN), { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.concat([header, Buffer.from(name, 'utf8')]));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  const cipherText = sealed.subarray(HEADER_LEN + NONCE_LEN, sealed.length - TAG_LEN);
  const plaintext = Buffer.allocUnsafe(cipherText.length);
  try {
    let pos = 0;
    for (let off = 0; off < cipherText.length; off += CRYPTO_CHUNK) {
      pos += decipher.update(cipherText.subarray(off, off + CRYPTO_CHUNK)).copy(plaintext, pos);
    }
    pos += decipher.final().copy(plaintext, pos);
    if (pos !== plaintext.length) throw new Error('length');
  } catch {
    throw new BackupError('tamper', 'The backup file failed its integrity check (damaged, or not the file it claims to be)');
  }
  return { plaintext, keys };
}

// ---------------------------------------------------------------- paths, manifest names, retention

/**
 * A path inside a manifest is relative to the data directory and nothing else. Throws BackupError invalid_path.
 * @param {unknown} value
 * @returns {string}
 */
export function validateRelPath(value) {
  const bad = () => new BackupError('invalid_path', 'A path in the backup manifest is not a plain relative path');
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) throw bad();
  if (/[\p{Cc}\\]/u.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw bad();
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw bad();
  }
  return value;
}

/**
 * The hash of an image file when `rel` is `assets/<aa>/<hash>` with the shard matching the hash, else null. Images are
 * stored by the SHA-256 of their content (docs/images.md), so the name says what the bytes must be.
 * @param {unknown} rel
 */
export function assetHashOf(rel) {
  const m = typeof rel === 'string' ? ASSET_PATH_RE.exec(rel) : null;
  return m && m[2].startsWith(m[1]) ? m[2] : null;
}

/**
 * Whether `rel` is a path the engine itself writes: directory.sqlite, a top-level room file, an image file under
 * `assets/<aa>/`, or a board's history index or version file. Restore accepts nothing else from a manifest.
 * @param {unknown} rel
 */
export function isBackupPath(rel) {
  if (typeof rel !== 'string') return false;
  if (rel === 'directory.sqlite' || ROOM_FILE_RE.test(rel) || assetHashOf(rel) !== null) return true;
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[0] !== 'history' || !BOARD_ID_RE.test(parts[1])) return false;
  if (parts[2] === 'index.json') return true;
  return parts[2].endsWith('.yjs.gz') && VERSION_ID_RE.test(parts[2].slice(0, -'.yjs.gz'.length));
}

/**
 * The protections in a stored `backup.protected` value: manifest name to expiry (ms). `active` holds the ones that have
 * not expired at `nowMs`; `changed` says whether the stored value holds anything else (expired or malformed entries).
 * Throws when the value is not a JSON object at all, so a caller can fail closed.
 * @param {string | null | undefined} stored
 * @param {number} nowMs
 * @returns {{ active: Record<string, number>, changed: boolean }}
 */
export function parseProtections(stored, nowMs) {
  if (stored === null || stored === undefined || stored === '') return { active: {}, changed: false };
  const value = JSON.parse(stored);
  if (!isObject(value)) throw new Error('not an object');
  const active = {};
  let changed = false;
  for (const [name, until] of Object.entries(value)) {
    if (parseManifestName(name) !== null && Number.isFinite(until) && until > nowMs) active[name] = until;
    else changed = true;
  }
  return { active, changed };
}

/** '20261008T193000Z.json.enc' for a time in ms. */
export function formatManifestName(ms) {
  return `${new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '')}.json.enc`;
}

/** The time in ms of a manifest file name, or null when it is not one. */
export function parseManifestName(name) {
  const m = typeof name === 'string' ? MANIFEST_NAME_RE.exec(name) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return formatManifestName(ms) === name ? ms : null;
}

/**
 * Which manifests a backup keeps: the newest per UTC hour while younger than `keepHourlyHours`, the newest per UTC day
 * while younger than `keepDailyDays`, and always the newest. Everything else is `drop`. Names that are not manifest
 * names are never dropped, and neither are the `protectedNames` (the safety backups of a restore).
 * @param {string[]} names
 * @param {number} nowMs
 * @param {{ keepHourlyHours: number, keepDailyDays: number, protectedNames?: Iterable<string> }} limits
 */
export function pruneManifests(names, nowMs, { keepHourlyHours, keepDailyDays, protectedNames = [] }) {
  const items = names
    .map((name) => ({ name, at: parseManifestName(name) }))
    .filter((item) => item.at !== null)
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const keep = new Set(items.length ? [items[0].name] : []);
  const known = new Set(items.map((item) => item.name));
  for (const name of protectedNames) if (known.has(name)) keep.add(name);
  const hours = new Set();
  const days = new Set();
  for (const { name, at } of items) {
    const age = Math.max(0, nowMs - at);
    if (age <= keepHourlyHours * HOUR_MS && keepHourlyHours > 0) {
      const bucket = Math.floor(at / HOUR_MS);
      if (!hours.has(bucket)) {
        hours.add(bucket);
        keep.add(name);
      }
    }
    if (age <= keepDailyDays * DAY_MS && keepDailyDays > 0) {
      const bucket = Math.floor(at / DAY_MS);
      if (!days.has(bucket)) {
        days.add(bucket);
        keep.add(name);
      }
    }
  }
  return { keep, drop: items.filter((item) => !keep.has(item.name)).map((item) => item.name) };
}

// ---------------------------------------------------------------- SigV4

/** RFC 3986 encoding of one path segment or query component. S3 signs the path as it is sent, encoded once. */
export const encodeSegment = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** An object key with its slashes kept. */
export const encodeKeyPath = (key) => key.split('/').map(encodeSegment).join('/');

/** @param {[string, string][]} pairs */
export function canonicalQuery(pairs) {
  return pairs
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** 'YYYYMMDDTHHMMSSZ' */
export const amzDate = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

/**
 * AWS Signature Version 4. `headers` is exactly the set that is signed (lower case or not), `date` is the x-amz-date
 * value. `canonicalUri` is the path as it is sent, already encoded. Returns the pieces, so tests can compare each step
 * with the published examples.
 * @param {object} request
 */
export function signRequest({ method, canonicalUri, query = [], headers, payloadHash, date, region, service = 's3', accessKey, secretKey }) {
  const lowered = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = lowered.map(([name]) => name).join(';');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    lowered.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  let signingKey = hmac(`AWS4${secretKey}`, day);
  for (const part of [region, service, 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    credentialScope: scope,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Where a request for `key` goes: path style puts the bucket in the path, virtual hosted style in the host name.
 * `host` is what the Host header carries (a port that is not the default stays), `canonicalUri` is the signed path.
 * @param {{ endpoint: string, bucket: string, key?: string, pathStyle: boolean, query?: [string, string][] }} target
 */
export function s3Target({ endpoint, bucket, key = '', pathStyle, query = [] }) {
  const base = new URL(endpoint);
  const host = pathStyle ? base.host : `${bucket}.${base.host}`;
  const keyPath = key ? encodeKeyPath(key) : '';
  const canonicalUri = pathStyle ? `/${encodeSegment(bucket)}${keyPath ? `/${keyPath}` : ''}` : `/${keyPath}`;
  const qs = canonicalQuery(query);
  return { host, canonicalUri, url: `${base.protocol}//${host}${canonicalUri}${qs ? `?${qs}` : ''}` };
}

// ---------------------------------------------------------------- XML (the little S3 needs)

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (match, entity) => {
    if (entity[0] === '#') {
      const cp = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * A strict little XML reader for S3 answers: elements and text only (attributes are skipped, namespaces dropped).
 * A DOCTYPE, an unbalanced tag, text outside the root, or a document that is too deep or too large is refused.
 * @param {string} text
 * @returns {{ name: string, text: string, children: any[] }}
 */
export function parseXml(text) {
  const bad = () => new BackupError('s3', 'The storage provider sent an answer that could not be read');
  if (typeof text !== 'string' || text.length > MAX_LIST_BYTES) throw bad();
  const stack = [];
  let root = null;
  let nodes = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt === -1 ? text.length : lt);
    if (stack.length) stack[stack.length - 1].text += decodeEntities(chunk);
    else if (chunk.trim()) throw bad();
    if (lt === -1) break;
    if (text.startsWith('<?', lt) || text.startsWith('<!--', lt)) {
      const close = text.startsWith('<?', lt) ? '?>' : '-->';
      const end = text.indexOf(close, lt + 2);
      if (end === -1) throw bad();
      i = end + close.length;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1 || !stack.length) throw bad();
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw bad();
    const gt = tagEnd(text, lt + 1);
    if (gt === -1) throw bad();
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      const closing = /^\/\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\s*$/.exec(inner);
      const open = stack.pop();
      if (!closing || !open || open.name !== closing[1]) throw bad();
      continue;
    }
    const m = /^(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?:\s[^]*)?$/.exec(inner.replace(/\/$/, ''));
    if (!m || ++nodes > MAX_XML_NODES || stack.length >= MAX_XML_DEPTH) throw bad();
    const node = { name: m[1], text: '', children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) throw bad();
    else root = node;
    if (!inner.endsWith('/')) stack.push(node);
  }
  if (!root || stack.length) throw bad();
  return root;
}

const childText = (node, name) => node.children.find((c) => c.name === name)?.text;

/**
 * A ListObjectsV2 answer. Entries that look wrong (no key, a size or time that does not parse) are left out, which can
 * only make the caller more careful: nothing it cannot read is ever deleted.
 * @param {string} xml
 * @returns {{ contents: { key: string, size: number, lastModified: number }[], truncated: boolean, next: string | null }}
 */
export function parseListXml(xml) {
  const root = parseXml(xml);
  if (root.name !== 'ListBucketResult') throw new BackupError('s3', 'The storage provider sent an unexpected bucket listing');
  const contents = [];
  for (const node of root.children) {
    if (node.name !== 'Contents') continue;
    const key = childText(node, 'Key');
    const size = childText(node, 'Size');
    const modified = Date.parse(childText(node, 'LastModified') ?? '');
    if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || /\p{Cc}/u.test(key)) continue;
    if (typeof size !== 'string' || !/^\d{1,15}$/.test(size) || !Number.isFinite(modified)) continue;
    contents.push({ key, size: Number(size), lastModified: modified });
  }
  const truncated = childText(root, 'IsTruncated') === 'true';
  const next = childText(root, 'NextContinuationToken') ?? '';
  if (truncated && (next.length === 0 || next.length > 2048)) throw new BackupError('s3', 'The storage provider sent an unusable bucket listing');
  return { contents, truncated, next: truncated ? next : null };
}

/** The S3 error code of an error answer, or null. */
export function parseErrorCode(xml) {
  try {
    const root = parseXml(xml);
    const code = root.name === 'Error' ? childText(root, 'Code')?.trim() : undefined;
    return code && S3_CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- S3 client

const EMPTY = Buffer.alloc(0);

function networkCode(err) {
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && ERRNO_RE.test(code) ? code : null;
}

/**
 * The five S3 calls the backup needs, signed with SigV4. A request is retried up to `backoffMs.length` times on a
 * network error, a timeout, a 5xx or a 429, and never on another 4xx. Errors are BackupErrors with a status and an S3
 * error code and nothing else.
 * @param {object} options endpoint, region, bucket, accessKey, secretKey, pathStyle; fetch, now, setTimeout, clearTimeout, signal, requestTimeoutMs, backoffMs for tests
 */
export function createS3Client({
  endpoint,
  region,
  bucket,
  accessKey,
  secretKey,
  pathStyle = true,
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  now = Date.now,
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  signal = null,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  backoffMs = BACKOFF_MS,
}) {
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimer(timer);
        reject(aborted());
      };
      const timer = setTimer(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(undefined);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  async function once(method, key, query, body, payloadHash, maxBytes, notFoundOk) {
    const date = amzDate(now());
    const target = s3Target({ endpoint, bucket, key, pathStyle, query });
    const headers = { host: target.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
    const { authorization } = signRequest({ method, canonicalUri: target.canonicalUri, query, headers, payloadHash, date, region, accessKey, secretKey });
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetchFn(target.url, {
        method,
        headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': date, authorization },
        body: method === 'PUT' ? body : undefined,
        redirect: 'manual',
        signal: combined,
      });
      const status = res.status;
      const header = res.headers?.get?.('content-length');
      const declared = header === null || header === undefined || header === '' ? NaN : Number(header);
      const sizeHeader = Number.isFinite(declared) ? declared : null;
      if (status >= 200 && status < 300) {
        if (method === 'HEAD') return { status, size: sizeHeader, body: EMPTY };
        if (sizeHeader !== null && sizeHeader > maxBytes) throw new BackupError('too_large', 'The storage provider sent more data than expected');
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length > maxBytes) throw new BackupError('too_large', 'The storage provider sent more data than expected');
        return { status, size: data.length, body: data };
      }
      let s3Code = null;
      if (method !== 'HEAD' && (sizeHeader === null || sizeHeader <= MAX_ERROR_BODY)) {
        const text = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_ERROR_BODY).toString('utf8');
        s3Code = parseErrorCode(text);
      } else {
        await res.body?.cancel?.().catch(() => {});
      }
      if (status === 404 && notFoundOk) return { status, size: null, body: EMPTY };
      const detail = `${status}${s3Code ? `, ${s3Code}` : ''}`;
      if (status === 429 || status >= 500) {
        throw new BackupError('s3', `S3 ${method} failed (status ${detail})`, { status, s3Code, retryable: true });
      }
      if (status >= 300 && status < 400) throw new BackupError('s3', `S3 ${method} was redirected (status ${status}); check the endpoint and region`, { status });
      throw new BackupError('s3', `S3 ${method} failed (status ${detail})`, { status, s3Code });
    } catch (err) {
      if (signal?.aborted) throw aborted();
      if (err instanceof BackupError) throw err;
      if (timeout.aborted || err?.name === 'TimeoutError') throw new BackupError('timeout', `S3 ${method} timed out`, { retryable: true });
      const code = networkCode(err);
      throw new BackupError('network', `S3 ${method} could not reach the storage provider${code ? ` (${code})` : ''}`, { retryable: true });
    }
  }

  async function request(method, key, { query = [], body = EMPTY, maxBytes = MAX_LIST_BYTES, notFoundOk = false } = {}) {
    const payloadHash = sha256Hex(body);
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw aborted();
      try {
        return await once(method, key, query, body, payloadHash, maxBytes, notFoundOk);
      } catch (err) {
        if (!err?.retryable || attempt >= backoffMs.length) throw err;
      }
      await sleep(backoffMs[attempt]);
    }
  }

  return {
    async put(key, body) {
      await request('PUT', key, { body });
    },
    /** @returns {Promise<Buffer>} */
    async get(key, { maxBytes = MAX_MANIFEST_BYTES } = {}) {
      const res = await request('GET', key, { maxBytes, notFoundOk: true });
      if (res.status === 404) throw new BackupError('not_found', 'The backup file is not in the bucket', { status: 404 });
      return res.body;
    },
    /** @returns {Promise<{ size: number | null } | null>} null when the object does not exist */
    async head(key) {
      const res = await request('HEAD', key, { notFoundOk: true });
      return res.status === 404 ? null : { size: res.size };
    },
    async del(key) {
      await request('DELETE', key, { notFoundOk: true });
    },
    /** Every key under `prefix`, page after page. */
    async list(prefix) {
      const contents = [];
      let token = null;
      const seen = new Set();
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query = [['list-type', '2'], ['prefix', prefix]];
        if (token) query.push(['continuation-token', token]);
        const res = await request('GET', '', { query });
        const parsed = parseListXml(res.body.toString('utf8'));
        for (const item of parsed.contents) if (item.key.startsWith(prefix)) contents.push(item);
        if (!parsed.next) return contents;
        if (seen.has(parsed.next)) throw new BackupError('s3', 'The storage provider repeated a page of the bucket listing');
        seen.add(parsed.next);
        token = parsed.next;
      }
      throw new BackupError('s3', 'The bucket listing has too many pages');
    },
  };
}

// ---------------------------------------------------------------- manifests

function parseManifest(bytes, keys, name) {
  const bad = (what) => new BackupError('invalid_manifest', `The backup manifest is not valid (${what})`);
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw bad('not JSON');
  }
  if (!isObject(data) || data.version !== FORMAT_VERSION) throw bad('version');
  if (data.keyId !== keys.keyId) throw bad('key id');
  if (typeof data.createdAt !== 'string' || !Array.isArray(data.files) || data.files.length > MAX_MANIFEST_FILES) throw bad('fields');
  const paths = new Set();
  let total = 0;
  const files = data.files.map((entry) => {
    if (!isObject(entry) || typeof entry.objectId !== 'string' || !OBJECT_ID_RE.test(entry.objectId)) throw bad('file entry');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw bad('file size');
    const filePath = validateRelPath(entry.path);
    if (paths.has(filePath)) throw bad('duplicate path');
    paths.add(filePath);
    total += entry.size;
    return { path: filePath, size: entry.size, objectId: entry.objectId };
  });
  if (isObject(data.totals) && (data.totals.files !== files.length || data.totals.bytes !== total)) throw bad('totals');
  return {
    name,
    version: FORMAT_VERSION,
    keyId: keys.keyId,
    createdAt: data.createdAt,
    appVersion: typeof data.appVersion === 'string' ? data.appVersion : null,
    files,
    totals: { files: files.length, bytes: total },
  };
}

// ---------------------------------------------------------------- the engine

const EMPTY_STATUS = Object.freeze({
  lastSuccessAt: null,
  lastRunAt: null,
  lastError: null,
  lastFailureAt: null,
  lastFailureError: null,
  consecutiveFailures: 0,
  lastManifest: null,
  bytesStored: 0,
  objects: 0,
  manifests: 0,
  prune: null,
});

const timeOrNull = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const countOr0 = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

function readStatus(directory, scrub) {
  const status = { ...EMPTY_STATUS };
  try {
    const stored = JSON.parse(directory?.getSetting(STATUS_KEY) ?? 'null');
    if (!isObject(stored)) return status;
    status.lastSuccessAt = timeOrNull(stored.lastSuccessAt);
    status.lastRunAt = timeOrNull(stored.lastRunAt);
    status.lastFailureAt = timeOrNull(stored.lastFailureAt);
    status.lastError = typeof stored.lastError === 'string' ? scrub(stored.lastError).slice(0, ERROR_MAX) : null;
    status.lastFailureError = typeof stored.lastFailureError === 'string' ? scrub(stored.lastFailureError).slice(0, ERROR_MAX) : null;
    status.consecutiveFailures = countOr0(stored.consecutiveFailures);
    status.lastManifest = typeof stored.lastManifest === 'string' && parseManifestName(stored.lastManifest) !== null ? stored.lastManifest : null;
    status.bytesStored = countOr0(stored.bytesStored);
    status.objects = countOr0(stored.objects);
    status.manifests = countOr0(stored.manifests);
    status.prune = isObject(stored.prune) ? stored.prune : null;
  } catch {
    /* unreadable status starts again from nothing */
  }
  return status;
}

const isFileSync = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const megabytes = (bytes) => (bytes >= 1024 * 1024 ? `${Math.ceil(bytes / (1024 * 1024))} MB` : `${bytes} bytes`);
const tooLarge = (rel, size, limit) => new BackupError('too_large', `${rel} is ${megabytes(size)}, more than the ${megabytes(limit)} a backup file may be`);

/**
 * The backup engine. Returns null when backups are off. Nothing here throws out of a timer: a failed run is recorded
 * in the status (and the audit log in accounts mode) and tried again at the next interval.
 *
 * @param {object} options
 * @param {BackupConfig | null} options.config
 * @param {string} options.dataDir
 * @param {any} [options.directory] accounts mode: where the status is kept and the audit rows go; without it the status lives in memory
 * @param {((room: string) => Uint8Array | null) | null} [options.boardState] the current state of a room that is open (a room name is `<boardId>` or `<boardId>~comments`); null or a room that is not open: its file is read
 * @param {(...args: any[]) => void} [options.log]
 * @param {any} [options.fetch]
 * @param {() => number} [options.now]
 * @param {any} [options.setTimeout]
 * @param {any} [options.clearTimeout]
 * @param {() => number} [options.random]
 * @param {number} [options.requestTimeoutMs] tests only
 * @param {number[]} [options.backoffMs] tests only: the waits before each retry of a request
 * @param {number} [options.maxFileBytes] tests only; the limit is MAX_FILE_BYTES
 */
export function createBackup({
  config,
  dataDir,
  directory = null,
  boardState = null,
  log = (...args) => console.error(...args),
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  now = Date.now,
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  random = Math.random,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  backoffMs = BACKOFF_MS,
  maxFileBytes = MAX_FILE_BYTES,
}) {
  if (!config) return null;

  const scrub = createScrubber(config.secrets ?? []);
  const say = (message) => {
    try {
      log(`backup: ${scrub(message)}`);
    } catch {
      /* a broken logger must not break a backup */
    }
  };
  const describe = (err) => {
    if (err instanceof BackupError) return scrub(err.message).slice(0, ERROR_MAX);
    const code = typeof err?.code === 'string' && ERRNO_RE.test(err.code) ? err.code : null;
    return scrub(`${code ?? err?.name ?? 'Error'}: ${err?.message ?? ''}`).slice(0, ERROR_MAX);
  };

  const keyring = createKeyring([config.key, ...(config.previousKeys ?? [])]);
  const keys = keyring.current;
  const stop = new AbortController();
  const s3 = createS3Client({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    pathStyle: config.pathStyle,
    fetch: fetchFn,
    now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    signal: stop.signal,
    requestTimeoutMs,
    backoffMs,
  });

  const intervalMs = config.intervalMinutes * MINUTE_MS;
  const prefix = config.prefix;
  const objectKey = (id) => `${prefix}/objects/${id}`;
  const manifestKey = (name) => `${prefix}/manifests/${name}`;

  let state = readStatus(directory, scrub);
  let running = false;
  let started = false;
  let stopped = false;
  let timer = null;
  let nextRunAt = null;
  let inFlight = null;
  let tempFile = null;
  /** Objects this process has seen in the bucket, so an unchanged file is not asked about again every run. */
  let verified = new Set();
  /** Objects uploaded by a run that did not get as far as its manifest: asked about before they are uploaded again. */
  const unpublished = new Set();

  function persist() {
    try {
      directory?.setSetting(STATUS_KEY, JSON.stringify({ ...state, nextRunAt, running: false }));
    } catch (err) {
      say(`could not store the status (${describe(err)})`);
    }
  }

  function auditRow(action, detail) {
    try {
      directory?.audit(null, action, detail);
    } catch (err) {
      say(`could not write the audit row (${describe(err)})`);
    }
  }

  // ------------------------------------------------------------ read side

  /** Newest first. */
  async function listManifests() {
    const dir = `${prefix}/manifests/`;
    const items = await s3.list(dir);
    return items
      .map((item) => ({ name: item.key.slice(dir.length), size: item.size, lastModified: item.lastModified }))
      .filter((item) => MANIFEST_NAME_RE.test(item.name))
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  async function readManifest(name) {
    if (parseManifestName(name) === null) throw new BackupError('invalid_manifest', 'Not a backup manifest name');
    const sealed = await s3.get(manifestKey(name), { maxBytes: MAX_MANIFEST_BYTES });
    const { plaintext, keys: used } = unseal(sealed, `manifest:${name}`, keyring);
    return parseManifest(plaintext, used, name);
  }

  /**
   * The file behind an object id, verified twice: the GCM tag (with the id in the additional data) and the keyed hash
   * of the plaintext, which must be the id. A different expected hash can be passed to check against a manifest.
   */
  async function readObject(objectId, { expectedPlaintextHmac } = {}) {
    if (typeof objectId !== 'string' || !OBJECT_ID_RE.test(objectId)) throw new BackupError('not_found', 'Not a backup object id');
    const sealed = await s3.get(objectKey(objectId), { maxBytes: MAX_FILE_BYTES + OVERHEAD });
    const { plaintext, keys: used } = unseal(sealed, `obj:${objectId}`, keyring);
    const mac = objectIdOf(plaintext, used);
    if (mac !== objectId || (expectedPlaintextHmac !== undefined && expectedPlaintextHmac !== mac)) {
      throw new BackupError('content_mismatch', 'The backup object does not contain what its name says');
    }
    return plaintext;
  }

  // ------------------------------------------------------------ what gets backed up

  function removeTemp(file) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  }

  function cleanStaleTemps() {
    try {
      for (const name of fs.readdirSync(dataDir)) if (STALE_TEMP_RE.test(name)) fs.rmSync(path.join(dataDir, name), { force: true });
    } catch (err) {
      say(`could not clean up old temporary files (${describe(err)})`);
    }
  }

  /** A consistent copy of the directory database, taken while the server uses it. The engine's own rows are left out. */
  async function copyDirectory(source) {
    const tmp = path.join(dataDir, `directory.sqlite.backup-${crypto.randomBytes(8).toString('hex')}.tmp`);
    tempFile = tmp;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const live = new DatabaseSync(source);
      try {
        live.exec('PRAGMA busy_timeout = 5000');
        live.prepare('VACUUM INTO ?').run(tmp);
      } finally {
        live.close();
      }
      // Without this, the status and audit rows of every run would make the next run's copy differ and nothing would ever be unchanged.
      const copy = new DatabaseSync(tmp);
      try {
        const has = (table) => copy.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
        copy.exec('PRAGMA journal_mode = DELETE');
        if (has('settings')) copy.prepare('DELETE FROM settings WHERE key = ?').run(STATUS_KEY);
        if (has('audit')) {
          copy.exec("DELETE FROM audit WHERE action IN ('backup.run', 'backup.failed')");
          if (has('sqlite_sequence')) copy.exec("UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM audit) WHERE name = 'audit'");
        }
        copy.exec('VACUUM');
      } finally {
        copy.close();
      }
      const size = fs.statSync(tmp).size;
      if (size > maxFileBytes) throw tooLarge('directory.sqlite', size, maxFileBytes);
      const data = await fs.promises.readFile(tmp);
      // The file change counter (and the copy of it SQLite keeps for validity) counts the writes made to this temporary
      // copy, which differ from run to run. SQLite recomputes it, so a fixed value keeps an unchanged database unchanged.
      if (data.length >= 100 && data.toString('latin1', 0, 15) === 'SQLite format 3') {
        data.writeUInt32BE(1, 24);
        data.writeUInt32BE(1, 92);
      }
      return data;
    } finally {
      removeTemp(tmp);
      tempFile = null;
    }
  }

  async function readCapped(file, rel) {
    const size = (await fs.promises.stat(file)).size;
    if (size > maxFileBytes) throw tooLarge(rel, size, maxFileBytes);
    const data = await fs.promises.readFile(file);
    if (data.length > maxFileBytes) throw tooLarge(rel, data.length, maxFileBytes);
    return data;
  }

  const readIfThere = async (file, rel) => {
    try {
      return await readCapped(file, rel);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  };

  /** One file at a time, so only one is in memory. `skipped` counts what was left out because it vanished or is damaged. */
  async function* snapshotFiles(counters) {
    const database = path.join(dataDir, 'directory.sqlite');
    if (isFileSync(database)) yield { path: 'directory.sqlite', data: await copyDirectory(database) };

    const names = (await fs.promises.readdir(dataDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && ROOM_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const file of names) {
      const room = file.slice(0, -'.yjs'.length);
      let data = null;
      if (boardState) {
        try {
          const live = boardState(room);
          if (live) data = Buffer.from(live.buffer, live.byteOffset, live.byteLength);
        } catch (err) {
          say(`could not read the open room ${room} (${describe(err)}); using its file`);
        }
        if (data && data.length > maxFileBytes) throw tooLarge(file, data.length, maxFileBytes);
      }
      data ??= await readIfThere(path.join(dataDir, file), file);
      if (data) yield { path: file, data };
      else counters.skipped++;
    }

    // Images: one file per distinct content, never changed once written, so after the first run an asset costs nothing again.
    // The name is the SHA-256 of the bytes; a file that no longer matches its name is damaged and is left out, so a restore
    // never meets it.
    const assetsRoot = path.join(dataDir, 'assets');
    let shards = [];
    try {
      shards = (await fs.promises.readdir(assetsRoot, { withFileTypes: true })).filter((e) => e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name)).map((e) => e.name).sort();
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const shard of shards) {
      let names = [];
      try {
        names = (await fs.promises.readdir(path.join(assetsRoot, shard), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      for (const name of names) {
        const rel = `assets/${shard}/${name}`;
        if (assetHashOf(rel) === null) continue;
        const data = await readIfThere(path.join(assetsRoot, shard, name), rel);
        if (!data) {
          counters.skipped++;
          continue;
        }
        if (crypto.createHash('sha256').update(data).digest('hex') !== name) {
          say('an image file does not match its name; it is left out of the backup');
          counters.skipped++;
          continue;
        }
        yield { path: rel, data };
      }
    }

    const root = path.join(dataDir, 'history');
    let boards = [];
    try {
      boards = (await fs.promises.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && BOARD_ID_RE.test(e.name)).map((e) => e.name).sort();
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const board of boards) {
      // The index comes first; only the versions it lists are read, and the index stored lists only the ones that were.
      const rawIndex = await readIfThere(path.join(root, board, 'index.json'), `history/${board}/index.json`);
      if (!rawIndex) continue;
      let index;
      try {
        index = JSON.parse(rawIndex.toString('utf8'));
        if (index?.v !== 1 || !Array.isArray(index.versions)) throw new Error('shape');
      } catch {
        say(`the version history index of a board is unreadable; its history is left out`);
        counters.skipped++;
        continue;
      }
      const ids = [...new Set(index.versions.map((v) => v?.id).filter((id) => typeof id === 'string' && VERSION_ID_RE.test(id)))];
      const present = new Set();
      for (const id of ids) {
        const rel = `history/${board}/${id}.yjs.gz`;
        const data = await readIfThere(path.join(root, board, `${id}.yjs.gz`), rel);
        if (!data) continue;
        present.add(id);
        yield { path: rel, data };
      }
      const complete = index.versions.every((v) => present.has(v?.id));
      const stored = complete ? rawIndex : Buffer.from(JSON.stringify({ ...index, versions: index.versions.filter((v) => present.has(v?.id)) }));
      yield { path: `history/${board}/index.json`, data: stored };
    }
  }

  // ------------------------------------------------------------ one run

  async function putObject(objectId, data) {
    const sealed = seal(data, `obj:${objectId}`, keys);
    await s3.put(objectKey(objectId), sealed);
    return sealed.length;
  }

  async function execute(startedAt) {
    cleanStaleTemps();
    const listed = await listManifests();
    let previous = null;
    if (listed.length) {
      try {
        previous = await readManifest(listed[0].name);
      } catch (err) {
        const transient = err?.code === 'network' || err?.code === 'timeout' || err?.code === 'aborted' || (err?.code === 's3' && (err.status === 429 || err.status >= 500));
        if (!(err instanceof BackupError) || transient) throw err;
        say(`the newest manifest could not be read (${err.code}); everything is uploaded again`);
      }
    }
    const reusable = new Set(previous && previous.keyId === keys.keyId ? previous.files.map((f) => f.objectId) : []);

    const counters = { skipped: 0 };
    const entries = [];
    const handled = new Set();
    const uploaded = new Map();
    let repaired = 0;
    for await (const file of snapshotFiles(counters)) {
      if (stop.signal.aborted) throw aborted();
      const objectId = objectIdOf(file.data, keys);
      entries.push({ path: validateRelPath(file.path), size: file.data.length, objectId });
      if (handled.has(objectId)) continue;
      handled.add(objectId);
      if (reusable.has(objectId) || unpublished.has(objectId)) {
        if (verified.has(objectId) && reusable.has(objectId)) continue;
        const found = await s3.head(objectKey(objectId));
        if (found && (found.size === null || found.size === file.data.length + OVERHEAD)) continue;
        if (reusable.has(objectId)) repaired++;
      }
      uploaded.set(objectId, await putObject(objectId, file.data));
      unpublished.add(objectId);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const unchanged =
      previous !== null &&
      previous.keyId === keys.keyId &&
      previous.files.length === entries.length &&
      previous.files.every((f, i) => f.path === entries[i].path && f.objectId === entries[i].objectId);

    // Every object is checked before a manifest names it, so a bad upload never leaves a manifest behind.
    for (const [objectId, sealedLength] of uploaded) {
      const found = await s3.head(objectKey(objectId));
      if (!found || (found.size !== null && found.size !== sealedLength)) {
        throw new BackupError('readback', 'An uploaded backup object could not be found again in the bucket');
      }
    }

    let manifest = previous;
    let manifestName = previous?.name ?? null;
    if (!unchanged) {
      const taken = new Set(listed.map((m) => m.name));
      let at = startedAt;
      while (taken.has(formatManifestName(at))) at += 1000;
      manifestName = formatManifestName(at);
      const body = {
        version: FORMAT_VERSION,
        keyId: keys.keyId,
        createdAt: new Date(startedAt).toISOString(),
        appVersion: VERSION,
        files: entries,
        totals: { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) },
      };
      const bytes = Buffer.from(JSON.stringify(body), 'utf8');
      await s3.put(manifestKey(manifestName), seal(bytes, `manifest:${manifestName}`, keys));
      try {
        const back = unseal(await s3.get(manifestKey(manifestName), { maxBytes: MAX_MANIFEST_BYTES }), `manifest:${manifestName}`, keyring);
        if (!back.plaintext.equals(bytes)) throw new BackupError('readback', 'The manifest read back from the bucket is not the one that was written');
        manifest = parseManifest(back.plaintext, back.keys, manifestName);
      } catch (err) {
        await s3.del(manifestKey(manifestName)).catch(() => {});
        if (err instanceof BackupError && (err.code === 'readback' || err.code === 'aborted')) throw err;
        throw new BackupError('readback', `The manifest could not be read back from the bucket (${err?.code ?? 'error'})`);
      }
    }
    verified = new Set(manifest.files.map((f) => f.objectId));
    unpublished.clear();

    const unique = new Map(manifest.files.map((f) => [f.objectId, f.size]));
    return {
      changed: !unchanged,
      manifestName,
      files: manifest.files.length,
      uploaded: uploaded.size,
      repaired,
      skipped: counters.skipped,
      bytesStored: [...unique.values()].reduce((sum, size) => sum + size + OVERHEAD, 0),
      bytesUploaded: [...uploaded.values()].reduce((sum, n) => sum + n, 0),
    };
  }

  /**
   * The manifests a restore has protected from pruning (restore.mjs writes them): names whose protection has not run out.
   * The ones that ran out are dropped from the stored value. null when the value cannot be read, which stops the prune.
   */
  function activeProtections(nowMs) {
    if (!directory) return [];
    try {
      const { active, changed } = parseProtections(directory.getSetting(PROTECTED_KEY), nowMs);
      if (changed) directory.setSetting(PROTECTED_KEY, JSON.stringify(active));
      return Object.keys(active);
    } catch {
      return null;
    }
  }

  /** Old manifests first, then objects nothing refers to (older than an hour), and only on complete knowledge. */
  async function prune(newestName, nowMs) {
    const outcome = { at: nowMs, manifestsDeleted: 0, objectsDeleted: 0, gcSkipped: null, error: null, manifests: null, objects: null };
    try {
      const listed = await listManifests();
      outcome.manifests = listed.length;
      if (!listed.some((m) => m.name === newestName)) {
        outcome.gcSkipped = 'inconsistent_listing';
        return outcome;
      }
      const protectedNames = activeProtections(nowMs);
      if (protectedNames === null) {
        outcome.gcSkipped = 'unreadable_protection';
        say('the list of protected backups could not be read, so nothing is deleted this time');
        return outcome;
      }
      const { drop } = pruneManifests(listed.map((m) => m.name), nowMs, { keepHourlyHours: config.keepHourlyHours, keepDailyDays: config.keepDailyDays, protectedNames });
      for (const name of drop) {
        if (name === newestName) continue;
        await s3.del(manifestKey(name));
        outcome.manifestsDeleted++;
      }
      const kept = listed.filter((m) => !drop.includes(m.name));
      outcome.manifests = kept.length;

      const dir = `${prefix}/objects/`;
      const objects = (await s3.list(dir)).filter((item) => OBJECT_ID_RE.test(item.key.slice(dir.length)));
      outcome.objects = objects.length;
      const referenced = new Set();
      let unreadable = 0;
      for (const item of kept) {
        try {
          for (const file of (await readManifest(item.name)).files) referenced.add(file.objectId);
        } catch (err) {
          if (err?.code === 'aborted') throw err;
          unreadable++;
        }
      }
      if (unreadable) {
        outcome.gcSkipped = 'unreadable_manifest';
        say(`${unreadable} manifest(s) could not be read, so no objects are deleted this time`);
        return outcome;
      }
      for (const item of objects) {
        const id = item.key.slice(dir.length);
        if (referenced.has(id) || nowMs - item.lastModified <= GC_GRACE_MS) continue;
        await s3.del(objectKey(id));
        outcome.objectsDeleted++;
      }
      outcome.objects = objects.length - outcome.objectsDeleted;
    } catch (err) {
      outcome.error = describe(err);
      say(`pruning failed (${outcome.error})`);
    }
    return outcome;
  }

  function recordSuccess(startedAt, summary, pruned) {
    const finishedAt = now();
    state = {
      ...state,
      lastRunAt: startedAt,
      lastSuccessAt: finishedAt,
      lastError: null,
      consecutiveFailures: 0,
      lastManifest: summary.manifestName,
      bytesStored: summary.bytesStored,
      objects: pruned.objects ?? state.objects,
      manifests: pruned.manifests ?? state.manifests,
      prune: { at: pruned.at, manifestsDeleted: pruned.manifestsDeleted, objectsDeleted: pruned.objectsDeleted, gcSkipped: pruned.gcSkipped, error: pruned.error },
    };
    persist();
    // A run that found nothing to do is in the status (lastSuccessAt) but not in the audit log: at hourly that would be 24 rows a day of nothing.
    if (summary.changed || summary.uploaded > 0 || summary.repaired > 0 || pruned.manifestsDeleted > 0 || pruned.objectsDeleted > 0) {
      auditRow('backup.run', {
        changed: summary.changed,
        files: summary.files,
        uploaded: summary.uploaded,
        bytes: summary.bytesUploaded,
        skipped: summary.skipped,
        manifestsDeleted: pruned.manifestsDeleted,
        objectsDeleted: pruned.objectsDeleted,
      });
    }
    say(
      summary.changed
        ? `ok: ${summary.files} files, ${summary.uploaded} uploaded, manifest ${summary.manifestName}`
        : `ok: nothing changed (${summary.files} files)`,
    );
  }

  function recordFailure(startedAt, err) {
    const message = describe(err);
    state = {
      ...state,
      lastRunAt: startedAt,
      lastError: message,
      lastFailureAt: now(),
      lastFailureError: message,
      consecutiveFailures: state.consecutiveFailures + 1,
    };
    persist();
    auditRow('backup.failed', { error: message });
    say(`failed: ${message}`);
    return message;
  }

  async function run() {
    if (stopped) return { ok: false, aborted: true };
    if (running) return { ok: false, skipped: 'running' };
    running = true;
    const startedAt = now();
    try {
      const summary = await execute(startedAt);
      const pruned = await prune(summary.manifestName, now());
      recordSuccess(startedAt, summary, pruned);
      return { ok: true, changed: summary.changed, manifest: summary.manifestName, files: summary.files, uploaded: summary.uploaded };
    } catch (err) {
      if (err?.code === 'aborted') return { ok: false, aborted: true };
      return { ok: false, error: recordFailure(startedAt, err) };
    } finally {
      running = false;
    }
  }

  /** Runs a backup now unless one is running. Never rejects. */
  function runNow() {
    const promise = run().catch((err) => ({ ok: false, error: describe(err) }));
    inFlight = promise;
    return promise;
  }

  // ------------------------------------------------------------ schedule

  function schedule(delayMs) {
    if (timer !== null) clearTimer(timer);
    nextRunAt = now() + delayMs;
    timer = setTimer(tick, delayMs);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    nextRunAt = null;
    try {
      await runNow();
    } catch (err) {
      say(`unexpected failure (${describe(err)})`);
    } finally {
      if (started && !stopped) schedule(intervalMs);
    }
  }

  return {
    keyId: keys.keyId,
    /** The first run comes 1 to 5 minutes after start (so a restart loop does not hammer the bucket), then every interval. */
    start() {
      if (started || stopped) return;
      started = true;
      schedule(FIRST_RUN_MIN_MS + Math.floor(random() * FIRST_RUN_SPAN_MS));
    },
    /** Cancels the schedule and aborts a run in progress; resolves once it has stopped. */
    async stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      nextRunAt = null;
      stop.abort();
      if (tempFile) removeTemp(tempFile);
      await inFlight?.catch(() => {});
    },
    runNow,
    status() {
      return { enabled: true, running, keyId: keys.keyId, intervalMinutes: config.intervalMinutes, ...state, nextRunAt };
    },
    listManifests,
    readManifest,
    readObject,
  };
}
