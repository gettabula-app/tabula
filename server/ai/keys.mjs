// Provider API keys at rest (docs/ai.md, "Keys (BYOK)"): the directory migration, the key ring that encrypts them and every
// ai_keys query. The SQL lives here so directory.mjs only registers it (a migration entry and one spread).
//
// A key is sealed with AES-256-GCM under a subkey of TABULA_AI_SECRET. Each row has its own random 96-bit nonce. The
// associated data binds the key version, the scope and the user, so a ciphertext copied to another row (or another
// user) fails to open. The key version is one byte, the first byte of an HMAC of the secret, so an operator never
// numbers secrets: it is stored in `key_version` and is also the first byte of the `ciphertext` blob.
// The version is a hint, not an identity: two secrets share a version byte 1 time in 256, so open() tries every
// secret with that version and lets the GCM tag decide. A collision after a rotation is expected and handled.

import crypto from 'node:crypto';
import { AiError } from './errors.mjs';

export const AI_SCOPES = ['workspace', 'user'];

const SECRET_RE = /^[A-Za-z0-9+/]{43}=$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HINT_CHARS = 4;
const AD_LABEL = 'tabula.ai.key';

export const AI_KEYS_MIGRATION = `
  CREATE TABLE ai_keys (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('workspace', 'user')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    base_url TEXT,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    key_version INTEGER NOT NULL,
    hint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    last_used_at INTEGER,
    CHECK ((scope = 'workspace' AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL))
  );
  CREATE UNIQUE INDEX ai_keys_workspace ON ai_keys(scope) WHERE user_id IS NULL;
  CREATE UNIQUE INDEX ai_keys_user ON ai_keys(user_id) WHERE user_id IS NOT NULL;
`;

/**
 * `null` when the variable is unset or blank. Throws, without ever printing the value, when it is set but is not
 * 32 bytes of standard base64.
 */
export function parseSecret(value, name) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (!SECRET_RE.test(raw) || Buffer.from(raw, 'base64').length !== 32) {
    throw new Error(`${name} must be 32 random bytes encoded as base64, 44 characters (for example the output of: openssl rand -base64 32)`);
  }
  return Buffer.from(raw, 'base64');
}

const fingerprint = (secret) => crypto.createHmac('sha256', secret).update('tabula-ai-key-version').digest()[0];
const subkey = (secret) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'tabula-ai-key-encryption', 32));
const aad = (version, scope, userId) => Buffer.from(JSON.stringify([AD_LABEL, version, scope, userId ?? null]));

/**
 * The secrets of this server: `secret` writes, and opens rows written under it; `previous` (TABULA_AI_SECRET_PREVIOUS)
 * only opens rows written before the last rotation. Without a secret the ring is not `configured` and seals nothing.
 * @param {{ secret?: Buffer | null, previous?: Buffer | null }} [secrets]
 */
export function createKeyRing({ secret = null, previous = null } = {}) {
  const entry = (s) => ({ version: fingerprint(s), key: subkey(s) });
  const current = secret ? entry(secret) : null;
  const older = secret && previous && !previous.equals(secret) ? entry(previous) : null;
  const openers = [current, older].filter(Boolean);

  /** @param {{ scope: string, userId?: string | null }} where */
  function seal({ scope, userId = null }, plaintext) {
    if (!current) throw new AiError('ai_unconfigured');
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', current.key, nonce);
    cipher.setAAD(aad(current.version, scope, userId));
    const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext: Buffer.concat([Buffer.from([current.version]), body]), nonce, keyVersion: current.version };
  }

  /**
   * `{ plaintext, stale }`; stale = written under the previous secret. Throws ai_key_unreadable when nothing opens it.
   * @param {{ scope: string, userId?: string | null, ciphertext: Uint8Array, nonce: Uint8Array, keyVersion: number }} row
   */
  function open({ scope, userId = null, ciphertext, nonce, keyVersion }) {
    if (!current) throw new AiError('ai_unconfigured');
    const blob = Buffer.from(ciphertext ?? []);
    const iv = Buffer.from(nonce ?? []);
    if (blob.length < 1 + TAG_BYTES || iv.length !== NONCE_BYTES || blob[0] !== keyVersion) throw new AiError('ai_key_unreadable');
    for (const candidate of openers) {
      if (candidate.version !== keyVersion) continue;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', candidate.key, iv);
        decipher.setAAD(aad(keyVersion, scope, userId));
        decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
        const plaintext = Buffer.concat([decipher.update(blob.subarray(1, blob.length - TAG_BYTES)), decipher.final()]).toString('utf8');
        return { plaintext, stale: candidate !== current };
      } catch {
        /* a wrong secret or a changed row: try the next secret */
      }
    }
    throw new AiError('ai_key_unreadable');
  }

  return { configured: current !== null, currentVersion: current?.version ?? null, seal, open };
}

const newId = () => crypto.randomBytes(16).toString('base64url');

function owner(scope, userId) {
  if (scope === 'workspace' && userId == null) return null;
  if (scope === 'user' && typeof userId === 'string' && userId) return userId;
  throw new Error('invalid key owner');
}

const toInfo = (r) => ({
  provider: r.provider,
  baseUrl: r.base_url ?? null,
  hint: r.hint,
  createdAt: r.created_at,
  createdBy: r.created_by ?? null,
  lastUsedAt: r.last_used_at ?? null,
});

/** `db` is the small query kit openDirectory builds: get, all, run (returns the change count) and transaction. */
export function createAiKeyStore({ get, run, transaction }) {
  const find = (scope, userId) => {
    const who = owner(scope, userId);
    return who === null
      ? get('SELECT * FROM ai_keys WHERE scope = ? AND user_id IS NULL', scope)
      : get('SELECT * FROM ai_keys WHERE scope = ? AND user_id = ?', scope, who);
  };
  const remove = (scope, who) =>
    who === null
      ? run('DELETE FROM ai_keys WHERE scope = ? AND user_id IS NULL', scope)
      : run('DELETE FROM ai_keys WHERE scope = ? AND user_id = ?', scope, who);

  /**
   * Replaces the key of that owner. Returns only what may be shown again.
   * @param {{ ring: any, scope: string, userId?: string | null, provider: string, baseUrl?: string | null, apiKey: string, createdBy?: string | null, now?: number }} key
   */
  function saveAiKey({ ring, scope, userId = null, provider, baseUrl = null, apiKey, createdBy = null, now = Date.now() }) {
    if (!ring?.configured) throw new AiError('ai_unconfigured');
    const who = owner(scope, userId);
    if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('invalid key');
    if (typeof provider !== 'string' || !provider) throw new Error('invalid provider');
    const sealed = ring.seal({ scope, userId: who }, apiKey);
    const hint = apiKey.slice(-HINT_CHARS);
    transaction(() => {
      remove(scope, who);
      run(
        `INSERT INTO ai_keys (id, scope, user_id, provider, base_url, ciphertext, nonce, key_version, hint, created_at, created_by, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        newId(),
        scope,
        who,
        provider,
        baseUrl,
        sealed.ciphertext,
        sealed.nonce,
        sealed.keyVersion,
        hint,
        now,
        createdBy,
      );
    });
    return { provider, hint };
  }

  /**
   * Provider, hint and dates of a stored key; never the key, never the ciphertext.
   * @param {string} scope @param {string | null} [userId]
   */
  function getAiKeyInfo(scope, userId = null) {
    const row = find(scope, userId);
    return row ? toInfo(row) : null;
  }

  /** @param {string} scope @param {string | null} [userId] */
  const deleteAiKey = (scope, userId = null) => remove(scope, owner(scope, userId)) === 1;

  // Opens a key without touching the row. Null when there is none.
  /** @param {{ ring: any, scope: string, userId?: string | null }} which */
  function readAiKey({ ring, scope, userId = null }) {
    const row = find(scope, userId);
    if (!row) return null;
    const { plaintext, stale } = ring.open({ scope, userId: row.user_id, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version });
    return { row, apiKey: plaintext, stale };
  }

  /**
   * Whether the stored key opens with the secrets of this server (a key written under a lost secret does not).
   * @param {{ ring: any, scope: string, userId?: string | null }} which
   */
  function aiKeyReadable({ ring, scope, userId = null }) {
    try {
      return readAiKey({ ring, scope, userId }) !== null;
    } catch {
      return false;
    }
  }

  /**
   * The key for a run: opens it, notes the use and, when it was written under the previous secret, seals it again under
   * the current one. Null when there is none; throws ai_unconfigured or ai_key_unreadable when it cannot be opened.
   * @param {{ ring: any, scope: string, userId?: string | null, now?: number }} which
   */
  function useAiKey({ ring, scope, userId = null, now = Date.now() }) {
    const found = readAiKey({ ring, scope, userId });
    if (!found) return null;
    const { row, apiKey, stale } = found;
    if (stale) {
      const sealed = ring.seal({ scope, userId: row.user_id }, apiKey);
      // only if nobody replaced the row since it was read
      run('UPDATE ai_keys SET ciphertext = ?, nonce = ?, key_version = ? WHERE id = ? AND ciphertext = ?', sealed.ciphertext, sealed.nonce, sealed.keyVersion, row.id, row.ciphertext);
    }
    run('UPDATE ai_keys SET last_used_at = ? WHERE id = ?', now, row.id);
    return { provider: row.provider, baseUrl: row.base_url ?? null, apiKey };
  }

  return { saveAiKey, getAiKeyInfo, deleteAiKey, aiKeyReadable, useAiKey };
}
