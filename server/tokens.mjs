// Access tokens for the MCP endpoint (docs/mcp.md): generation, the directory migration and every token query.
// The SQL lives here so directory.mjs only registers it (a migration entry and one spread).

import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'tbl_';
export const SCOPES = ['read', 'comment', 'write'];
export const MAX_ACTIVE_TOKENS = 20;
export const MAX_TOKEN_BOARDS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_AFTER_MS = 30 * DAY_MS;
// the same pattern as BOARD_ID_RE in directory.mjs (a test keeps them equal); not imported to avoid a cycle
export const TOKEN_BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

export const TOKENS_MIGRATION = `
  CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'comment', 'write')),
    board_ids TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX access_tokens_user ON access_tokens(user_id);
`;

export const newAccessToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newId = () => crypto.randomBytes(16).toString('base64url');

/** Anything that is not null or an array of valid board ids reads as "no board" (fail closed), never as "every board". */
export function parseBoardIds(json) {
  if (json === null || json === undefined) return null;
  try {
    const value = JSON.parse(json);
    if (Array.isArray(value) && value.length <= MAX_TOKEN_BOARDS && value.every((id) => typeof id === 'string' && TOKEN_BOARD_ID_RE.test(id))) {
      return value;
    }
  } catch {
    /* falls through */
  }
  return [];
}

const toToken = (r) => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  scope: r.scope,
  boardIds: parseBoardIds(r.board_ids),
  hint: r.hint,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at ?? null,
});

const ACTIVE = 'revoked_at IS NULL AND expires_at > ?';

/** `db` is the small query kit openDirectory builds: get, all, run (returns the change count) and transaction. */
export function createTokenStore({ get, all, run, transaction }) {
  /** @param {{ userId: string, name: string, scope: string, boardIds?: string[] | null, ttlMs: number, now?: number }} fields */
  function createAccessToken({ userId, name, scope, boardIds = null, ttlMs, now = Date.now() }) {
    if (!SCOPES.includes(scope)) throw new Error('invalid scope');
    if (typeof name !== 'string' || !name.trim()) throw new Error('invalid name');
    if (!(ttlMs > 0)) throw new Error('invalid ttl');
    if (boardIds !== null && !(Array.isArray(boardIds) && boardIds.length <= MAX_TOKEN_BOARDS && boardIds.every((id) => TOKEN_BOARD_ID_RE.test(id)))) {
      throw new Error('invalid boards');
    }
    const id = newId();
    const token = newAccessToken();
    transaction(() => {
      run(
        'DELETE FROM access_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?',
        now - SWEEP_AFTER_MS,
        now - SWEEP_AFTER_MS,
      );
      run(
        `INSERT INTO access_tokens (id, user_id, name, token_hash, hint, scope, board_ids, created_at, expires_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        id,
        userId,
        name.trim(),
        hashToken(token),
        token.slice(-4),
        scope,
        boardIds === null ? null : JSON.stringify(boardIds),
        now,
        now + ttlMs,
      );
    });
    return { id, token, expiresAt: now + ttlMs };
  }

  // null when the token is unknown, revoked or expired, or when its user is disabled (or gone)
  function findAccessToken(token, now = Date.now()) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const row = get(
      `SELECT t.*, u.email AS user_email, u.name AS user_name, u.role AS user_role, u.disabled AS user_disabled, u.created_at AS user_created_at
         FROM access_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      hashToken(token),
    );
    if (!row || row.expires_at <= now || row.user_disabled) return null;
    return {
      ...toToken(row),
      user: {
        id: row.user_id,
        email: row.user_email,
        name: row.user_name,
        role: row.user_role,
        disabled: false,
        createdAt: row.user_created_at,
      },
    };
  }

  function touchAccessToken(id, now = Date.now()) {
    run('UPDATE access_tokens SET last_used_at = ? WHERE id = ?', now, id);
  }

  const listAccessTokens = (userId, now = Date.now()) =>
    all(`SELECT * FROM access_tokens WHERE user_id = ? AND ${ACTIVE} ORDER BY created_at DESC, id`, userId, now).map(toToken);

  function listAccessTokensAdmin(now = Date.now()) {
    return all(
      `SELECT t.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
         FROM access_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.revoked_at IS NULL AND t.expires_at > ?
        ORDER BY t.created_at DESC, t.id`,
      now,
    ).map((r) => ({ ...toToken(r), userName: r.user_name, email: r.user_email, userRole: r.user_role }));
  }

  function getAccessToken(id, now = Date.now()) {
    const row = typeof id === 'string' ? get(`SELECT * FROM access_tokens WHERE id = ? AND ${ACTIVE}`, id, now) : undefined;
    return row ? toToken(row) : null;
  }

  const countActiveAccessTokens = (userId, now = Date.now()) =>
    Number(get(`SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ? AND ${ACTIVE}`, userId, now).n);

  const revokeAccessToken = (id, now = Date.now()) =>
    typeof id === 'string' && run('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, id) === 1;

  const revokeUserAccessTokens = (userId, now = Date.now()) =>
    run(`UPDATE access_tokens SET revoked_at = ? WHERE user_id = ? AND ${ACTIVE}`, now, userId, now);

  return {
    createAccessToken,
    findAccessToken,
    touchAccessToken,
    listAccessTokens,
    listAccessTokensAdmin,
    getAccessToken,
    countActiveAccessTokens,
    revokeAccessToken,
    revokeUserAccessTokens,
  };
}
