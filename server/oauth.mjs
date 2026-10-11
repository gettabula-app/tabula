// OAuth 2.1 persistence for the MCP endpoint (docs/mcp-oauth.md). All secret-bearing
// values are returned once; the database stores only SHA-256 digests or AEAD ciphertext.
import crypto from 'node:crypto';

export const OAUTH_MIGRATION = `
  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    max_scope TEXT NOT NULL DEFAULT 'write' CHECK (max_scope IN ('read', 'comment', 'write')),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    last_grant_at INTEGER -- non-null marker retained after grant cleanup to classify used clients
  );
  CREATE TABLE oauth_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);

  CREATE TABLE oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'comment', 'write')),
    board_ids TEXT,
    resource TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    revoked_reason TEXT
  );
  CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
  CREATE INDEX oauth_grants_client ON oauth_grants(client_id);

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'comment', 'write')),
    resource TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);

  CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'comment', 'write')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    replay_ciphertext TEXT,
    replay_until INTEGER,
    replay_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
  CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
`;

export const TOKEN_PREFIX_OAUTH = 'tbo_';
export const REFRESH_TOKEN_PREFIX = 'tbr_';
export const AUTHORIZATION_CODE_PREFIX = 'tbc_';
export const OAUTH_SCOPES = ['read', 'comment', 'write'];
export const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;
export const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_GRANT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const OAUTH_CODE_TTL_MS = 60 * 1000;
export const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
export const OAUTH_REPLAY_TTL_MS = 20 * 1000;
export const OAUTH_UNUSED_CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_USED_CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const OAUTH_CODE_RETENTION_MS = 10 * 60 * 1000;
export const OAUTH_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_OAUTH_CLIENTS = 500;
export const MAX_ACTIVE_OAUTH_GRANTS = 20;
export const MAX_OAUTH_BOARD_IDS = 20;

const SCOPE_RANK = { read: 1, comment: 2, write: 3 };
const ENVELOPE_VERSION = 1;
const ENVELOPE_SIGNATURE_BYTES = 32;
const ENVELOPE_MAX_BYTES = 8192;
const REPLAY_NONCE_BYTES = 12;
const REPLAY_TAG_BYTES = 16;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCESS_TOKEN_RE = /^tbo_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_RE = /^tbr_[A-Za-z0-9_-]{43}$/;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const sha256Hex = (value) => sha256(value).toString('hex');
const newId = () => crypto.randomBytes(16).toString('base64url');
const newAccessToken = () => `${TOKEN_PREFIX_OAUTH}${crypto.randomBytes(32).toString('base64url')}`;
const newRefreshToken = () => `${REFRESH_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
const newAuthorizationCode = () => `${AUTHORIZATION_CODE_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
const rankScope = (scope) => SCOPE_RANK[scope] ?? 0;
const minScope = (a, b) => rankScope(a) <= rankScope(b) ? a : b;

function requireSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('a 32-byte OAuth secret is required');
  return secret;
}

const deriveKey = (secret, label) => Buffer.from(crypto.hkdfSync('sha256', requireSecret(secret), Buffer.alloc(0), label, 32));

export function deriveOAuthKeys(secret) {
  return {
    envelope: deriveKey(secret, 'tabula-oauth/envelope/v1'),
    replay: deriveKey(secret, 'tabula-oauth/replay/v1'),
    nonce: deriveKey(secret, 'tabula-oauth/nonce/v1'),
  };
}

function envelopePayload(fields, now) {
  const clientId = fields.clientId ?? fields.client_id;
  const redirectUri = fields.redirectUri ?? fields.redirect_uri;
  if (typeof clientId !== 'string' || typeof redirectUri !== 'string') throw new TypeError('client and redirect URI are required');
  const issuedAt = Number.isSafeInteger(fields.issuedAt) ? fields.issuedAt : now;
  const expiresAt = Number.isSafeInteger(fields.expiresAt) ? fields.expiresAt : issuedAt + OAUTH_REQUEST_TTL_MS;
  return {
    request_id: typeof fields.requestId === 'string' ? fields.requestId : newId(),
    client_id: clientId,
    redirect_uri: redirectUri,
    state: typeof fields.state === 'string' ? fields.state : null,
    code_challenge: fields.codeChallenge ?? fields.code_challenge,
    scope: Array.isArray(fields.scope) ? fields.scope.join(' ') : fields.scope ?? null,
    resource: fields.resource,
    iat: issuedAt,
    exp: expiresAt,
  };
}

/** Signs a versioned, stateless authorization envelope with its own labelled key. */
export function signAuthorizeEnvelope(fields, secret, now = Date.now()) {
  const payload = envelopePayload(fields, now);
  if (typeof payload.code_challenge !== 'string' || typeof payload.resource !== 'string') throw new TypeError('challenge and resource are required');
  const body = Buffer.concat([Buffer.from([ENVELOPE_VERSION]), Buffer.from(JSON.stringify(payload), 'utf8')]);
  const signature = crypto.createHmac('sha256', deriveKey(secret, 'tabula-oauth/envelope/v1')).update(body).digest();
  return Buffer.concat([body, signature]).toString('base64url');
}

function envelopeShape(payload, now) {
  return payload && typeof payload === 'object'
    && typeof payload.request_id === 'string'
    && typeof payload.client_id === 'string'
    && typeof payload.redirect_uri === 'string'
    && (payload.state === null || typeof payload.state === 'string')
    && typeof payload.code_challenge === 'string'
    && (payload.scope === null || typeof payload.scope === 'string')
    && typeof payload.resource === 'string'
    && Number.isSafeInteger(payload.iat)
    && Number.isSafeInteger(payload.exp)
    && payload.iat <= now
    && payload.exp > now
    && payload.exp > payload.iat
    && payload.exp - payload.iat <= OAUTH_REQUEST_TTL_MS;
}

/** Returns null for a bad signature, unsupported version, malformed envelope or expiry. */
export function verifyAuthorizeEnvelope(envelope, secret, now = Date.now()) {
  if (typeof envelope !== 'string' || envelope.length > ENVELOPE_MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(envelope)) return null;
  const bytes = Buffer.from(envelope, 'base64url');
  if (bytes.toString('base64url') !== envelope || bytes.length <= ENVELOPE_SIGNATURE_BYTES + 1) return null;
  const body = bytes.subarray(0, bytes.length - ENVELOPE_SIGNATURE_BYTES);
  const signature = bytes.subarray(bytes.length - ENVELOPE_SIGNATURE_BYTES);
  if (body[0] !== ENVELOPE_VERSION) return null;
  const expected = crypto.createHmac('sha256', deriveKey(secret, 'tabula-oauth/envelope/v1')).update(body).digest();
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(body.subarray(1).toString('utf8'));
  } catch {
    return null;
  }
  if (!envelopeShape(payload, now)) return null;
  return {
    requestId: payload.request_id,
    clientId: payload.client_id,
    redirectUri: payload.redirect_uri,
    state: payload.state,
    codeChallenge: payload.code_challenge,
    scope: payload.scope,
    resource: payload.resource,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

/** A session-bound nonce helper for the consent API; its key is distinct from envelope and replay keys. */
export function createOAuthNonce({ requestId, sessionId, expiresAt }, secret) {
  if (typeof requestId !== 'string' || typeof sessionId !== 'string' || !Number.isSafeInteger(expiresAt)) throw new TypeError('nonce context is invalid');
  const message = JSON.stringify([requestId, sessionId, expiresAt]);
  return crypto.createHmac('sha256', deriveKey(secret, 'tabula-oauth/nonce/v1')).update(message).digest('base64url');
}

export function verifyOAuthNonce(nonce, fields, secret) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return false;
  let expected;
  try {
    expected = Buffer.from(createOAuthNonce(fields, secret), 'base64url');
  } catch {
    return false;
  }
  const actual = Buffer.from(nonce, 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function oauthClientFingerprint(name, redirectUris) {
  if (typeof name !== 'string' || !Array.isArray(redirectUris) || !redirectUris.every((uri) => typeof uri === 'string')) {
    throw new TypeError('client registration is invalid');
  }
  return sha256Hex(JSON.stringify([name, [...redirectUris].sort()]));
}

function parseRedirectUris(value) {
  try {
    const uris = JSON.parse(value);
    return Array.isArray(uris) && uris.every((uri) => typeof uri === 'string') ? uris : [];
  } catch {
    return [];
  }
}

function parseBoardIds(value) {
  if (value == null) return null;
  try {
    const ids = JSON.parse(value);
    if (Array.isArray(ids) && ids.length <= MAX_OAUTH_BOARD_IDS && ids.every((id) => typeof id === 'string' && BOARD_ID_RE.test(id))) return ids;
  } catch {
    /* fail closed below */
  }
  return [];
}

function redirectHost(uri) {
  try {
    const url = new URL(uri);
    return url.hostname || url.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

const toClient = (row) => ({
  clientId: row.id,
  name: row.name,
  redirectUris: parseRedirectUris(row.redirect_uris),
  fingerprint: row.fingerprint,
  maxScope: row.max_scope,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  lastGrantAt: row.last_grant_at ?? null,
});

const toGrant = (row) => ({
  id: row.id,
  clientId: row.client_id,
  userId: row.user_id,
  scope: row.scope,
  boardIds: parseBoardIds(row.board_ids),
  resource: row.resource,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at ?? null,
  revokedAt: row.revoked_at ?? null,
  revokedReason: row.revoked_reason ?? null,
  clientName: row.client_name ?? null,
  redirectHost: row.redirect_host ?? null,
});

function loopbackRedirectParts(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname, search: url.search };
  } catch {
    return null;
  }
}

export function redirectUriRegistered(redirectUri, registeredUris) {
  if (typeof redirectUri !== 'string' || !Array.isArray(registeredUris)) return false;
  const requestedLoopback = loopbackRedirectParts(redirectUri);
  return registeredUris.some((registered) => {
    if (registered === redirectUri) return true;
    const registeredLoopback = loopbackRedirectParts(registered);
    return Boolean(requestedLoopback && registeredLoopback
      && requestedLoopback.protocol === registeredLoopback.protocol
      && requestedLoopback.hostname === registeredLoopback.hostname
      && requestedLoopback.pathname === registeredLoopback.pathname
      && requestedLoopback.search === registeredLoopback.search);
  });
}

const activeGrantClause = 'revoked_at IS NULL AND expires_at > ?';
const chooseClient = 'SELECT * FROM oauth_clients WHERE id = ?';

/** The SQL lives here so directory.mjs registers one migration and spreads one store. */
export function createOauthStore({ get, all, run, transaction, secret = null }) {
  const secretKeys = secret ? deriveOAuthKeys(secret) : null;
  const requireKeys = () => {
    if (!secretKeys) throw new Error('OAuth secret is unavailable');
    return secretKeys;
  };

  function clientHasActiveGrant(clientId, now) {
    return Boolean(get(`SELECT 1 FROM oauth_grants WHERE client_id = ? AND ${activeGrantClause} LIMIT 1`, clientId, now));
  }

  function clientExpired(row, now) {
    if (!row || clientHasActiveGrant(row.id, now)) return false;
    return row.last_grant_at == null
      ? row.last_used_at + OAUTH_UNUSED_CLIENT_TTL_MS <= now
      : row.last_used_at + OAUTH_USED_CLIENT_TTL_MS <= now;
  }

  function getClientRow(clientId, now = Date.now()) {
    if (typeof clientId !== 'string') return null;
    const row = get(chooseClient, clientId);
    return row && !clientExpired(row, now) ? row : null;
  }

  function clientByFingerprintRow(fingerprint, now = Date.now()) {
    if (typeof fingerprint !== 'string') return null;
    const row = get('SELECT * FROM oauth_clients WHERE fingerprint = ?', fingerprint);
    return row && !clientExpired(row, now) ? row : null;
  }

  function sweepInside(now) {
    run('UPDATE oauth_tokens SET replay_ciphertext = NULL, replay_until = NULL WHERE replay_ciphertext IS NOT NULL AND replay_until <= ?', now);
    run('DELETE FROM oauth_requests WHERE expires_at <= ?', now);
    run('DELETE FROM oauth_codes WHERE expires_at + ? <= ?', OAUTH_CODE_RETENTION_MS, now);
    run('DELETE FROM oauth_tokens WHERE expires_at + ? <= ?', OAUTH_TOKEN_RETENTION_MS, now);
    run('DELETE FROM oauth_grants WHERE (revoked_at IS NOT NULL AND revoked_at + ? <= ?) OR (revoked_at IS NULL AND expires_at + ? <= ?)',
      OAUTH_GRANT_RETENTION_MS, now, OAUTH_GRANT_RETENTION_MS, now);
    run(`DELETE FROM oauth_clients
      WHERE (last_grant_at IS NULL AND last_used_at + ? <= ?)
         OR (last_grant_at IS NOT NULL AND last_used_at + ? <= ?
             AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id AND g.revoked_at IS NULL AND g.expires_at > ?))`,
    OAUTH_UNUSED_CLIENT_TTL_MS, now, OAUTH_USED_CLIENT_TTL_MS, now, now);
  }

  function sweep(now = Date.now()) {
    return transaction(() => sweepInside(now));
  }

  function getClient(clientId, now = Date.now()) {
    const row = getClientRow(clientId, now);
    return row ? toClient(row) : null;
  }

  function getClientByFingerprint(fingerprint, now = Date.now()) {
    const row = clientByFingerprintRow(fingerprint, now);
    return row ? toClient(row) : null;
  }

  function countClients() {
    return Number(get('SELECT COUNT(*) AS n FROM oauth_clients').n);
  }

  function registerClient({ name, redirectUris, maxScope = 'write', now = Date.now() }) {
    if (typeof name !== 'string' || !name || [...name].length > 80) throw new Error('invalid client name');
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5 || !redirectUris.every((uri) => typeof uri === 'string')) {
      throw new Error('invalid redirect URIs');
    }
    if (!OAUTH_SCOPES.includes(maxScope)) throw new Error('invalid client scope');
    const uris = [...new Set(redirectUris)].sort();
    if (uris.length !== redirectUris.length) throw new Error('duplicate redirect URI');
    const fingerprint = oauthClientFingerprint(name, uris);
    return transaction(() => {
      sweepInside(now);
      const existing = clientByFingerprintRow(fingerprint, now);
      if (existing) {
        run('UPDATE oauth_clients SET last_used_at = ?, max_scope = ? WHERE id = ?', now, maxScope, existing.id);
        return { client: toClient({ ...existing, last_used_at: now, max_scope: maxScope }), created: false };
      }
      if (countClients() >= MAX_OAUTH_CLIENTS) return { client: null, created: false, full: true };
      const clientId = newId();
      run(
        `INSERT INTO oauth_clients (id, name, redirect_uris, fingerprint, max_scope, created_at, last_used_at, last_grant_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        clientId, name, JSON.stringify(uris), fingerprint, maxScope, now, now,
      );
      return {
        client: toClient({ id: clientId, name, redirect_uris: JSON.stringify(uris), fingerprint, max_scope: maxScope, created_at: now, last_used_at: now, last_grant_at: null }),
        created: true,
      };
    });
  }

  function createGrantInside({ clientId, userId, scope, boardIds = null, resource, now }) {
    if (!OAUTH_SCOPES.includes(scope)) throw new Error('invalid grant scope');
    if (typeof resource !== 'string' || !resource || resource.length > 2048) throw new Error('invalid grant resource');
    if (boardIds !== null && !(Array.isArray(boardIds) && boardIds.length <= MAX_OAUTH_BOARD_IDS && boardIds.every((id) => typeof id === 'string' && BOARD_ID_RE.test(id)))) {
      throw new Error('invalid grant boards');
    }
    const client = getClientRow(clientId, now);
    const user = get('SELECT id, email, name, role, disabled, created_at FROM users WHERE id = ?', userId);
    if (!client) throw new Error('OAuth client is unavailable');
    if (rankScope(scope) > rankScope(client.max_scope)) throw new Error('OAuth grant scope exceeds client maximum');
    if (!user || user.disabled || user.role === 'guest') throw new Error('OAuth user is unavailable');

    run(`UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'replaced'
         WHERE user_id = ? AND client_id = ? AND ${activeGrantClause}`, now, userId, clientId, now);
    run('UPDATE oauth_tokens SET replay_ciphertext = NULL, replay_until = NULL WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked_reason = \'replaced\')', userId, clientId);
    const count = Number(get(`SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ? AND ${activeGrantClause}`, userId, now).n);
    if (count >= MAX_ACTIVE_OAUTH_GRANTS) {
      const err = new Error('OAuth grant limit reached');
      err.code = 'grant_limit';
      throw err;
    }

    const id = newId();
    run(
      `INSERT INTO oauth_grants (id, client_id, user_id, scope, board_ids, resource, created_at, expires_at, last_used_at, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      id, clientId, userId, scope, boardIds === null ? null : JSON.stringify(boardIds), resource, now, now + OAUTH_GRANT_TTL_MS,
    );
    run('UPDATE oauth_clients SET last_used_at = ?, last_grant_at = COALESCE(last_grant_at, ?) WHERE id = ?', now, now, clientId);
    return {
      id, clientId, userId, scope, boardIds, resource, createdAt: now, expiresAt: now + OAUTH_GRANT_TTL_MS,
      lastUsedAt: null, revokedAt: null, revokedReason: null, clientName: client.name,
      redirectHost: redirectHost(parseRedirectUris(client.redirect_uris)[0] ?? ''),
    };
  }

  function createGrant(fields) {
    const now = Number.isSafeInteger(fields?.now) ? fields.now : Date.now();
    return transaction(() => {
      sweepInside(now);
      return createGrantInside({ ...fields, now });
    });
  }

  function issueCodeInside({ requestId = newId(), grantId, clientId, redirectUri, codeChallenge, scope, resource, now }) {
    const code = newAuthorizationCode();
    const expiresAt = now + OAUTH_CODE_TTL_MS;
    run(
      `INSERT INTO oauth_codes (code_hash, request_id, grant_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      sha256Hex(code), requestId, grantId, clientId, redirectUri, codeChallenge, scope, resource, expiresAt,
    );
    return { code, requestId, expiresAt };
  }

  function issueCode(fields) {
    const now = Number.isSafeInteger(fields?.now) ? fields.now : Date.now();
    if (!fields || typeof fields.grantId !== 'string' || typeof fields.clientId !== 'string'
      || typeof fields.redirectUri !== 'string' || typeof fields.codeChallenge !== 'string'
      || !OAUTH_SCOPES.includes(fields.scope) || typeof fields.resource !== 'string') throw new Error('invalid authorization code fields');
    return transaction(() => {
      sweepInside(now);
      const grant = get('SELECT * FROM oauth_grants WHERE id = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?', fields.grantId, fields.clientId, now);
      if (!grant) throw new Error('OAuth grant is unavailable');
      return issueCodeInside({ ...fields, requestId: fields.requestId ?? newId(), now });
    });
  }

  function readCodeRow(code) {
    if (typeof code !== 'string' || !/^tbc_[A-Za-z0-9_-]{43}$/.test(code)) return null;
    return get('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256Hex(code));
  }

  function revokeGrantInside(id, reason, now) {
    const changed = run('UPDATE oauth_grants SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL', now, reason, id) === 1;
    run('UPDATE oauth_tokens SET replay_ciphertext = NULL, replay_until = NULL WHERE grant_id = ?', id);
    return changed;
  }

  function consumeCode(code, now = Date.now()) {
    return transaction(() => {
      sweepInside(now);
      const row = readCodeRow(code);
      if (!row) return null;
      if (row.used_at != null) {
        revokeGrantInside(row.grant_id, 'reuse', now);
        return { reused: true, grantId: row.grant_id };
      }
      if (row.expires_at <= now) return null;
      if (run('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', now, row.code_hash) !== 1) return null;
      return {
        requestId: row.request_id,
        grantId: row.grant_id,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
        expiresAt: row.expires_at,
        usedAt: now,
      };
    });
  }

  function registerRequestInside(request, now) {
    if (run('INSERT OR IGNORE INTO oauth_requests (id, client_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      request.requestId, request.clientId, now, request.expiresAt) !== 1) return false;
    return true;
  }

  function decideRequest({ envelope, request: signedRequest = undefined, userId, decision = 'allow', scope, boardIds = null, now = Date.now() }) {
    sweep(now);
    const request = readRequest(envelope ?? signedRequest, now);
    if (!request) return null;
    const client = getClientRow(request.clientId, now);
    if (!client || !redirectUriRegistered(request.redirectUri, parseRedirectUris(client.redirect_uris))) return null;
    if (decision === 'deny') return { decision, request, client: toClient(client) };
    if (decision !== 'allow' || typeof userId !== 'string') return null;
    const selectedScope = scope ?? (request.scope ? request.scope.split(' ')[0] : 'read');
    const requestMaxScope = request.scope
      ? request.scope.split(' ').reduce((max, item) => rankScope(item) > rankScope(max) ? item : max, 'read')
      : client.max_scope;
    if (!OAUTH_SCOPES.includes(selectedScope) || rankScope(selectedScope) > rankScope(requestMaxScope)
      || rankScope(selectedScope) > rankScope(client.max_scope)) return null;

    return transaction(() => {
      const currentClient = getClientRow(request.clientId, now);
      if (!currentClient || !redirectUriRegistered(request.redirectUri, parseRedirectUris(currentClient.redirect_uris))) return null;
      if (!registerRequestInside(request, now)) return null;
      const grant = createGrantInside({
        clientId: request.clientId, userId, scope: selectedScope, boardIds, resource: request.resource, now,
      });
      const code = issueCodeInside({
        requestId: request.requestId, grantId: grant.id, clientId: request.clientId,
        redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
        scope: selectedScope, resource: request.resource, now,
      });
      return { decision, request, client: toClient(currentClient), grant, ...code };
    });
  }

  function signRequest(fields, now = Date.now()) {
    sweep(now);
    return signAuthorizeEnvelope(fields, secret, now);
  }

  function readRequest(envelope, now = Date.now()) {
    requireKeys();
    return verifyAuthorizeEnvelope(envelope, secret, now);
  }

  function makeTokenPair(grant, scope, now) {
    const accessToken = newAccessToken();
    const refreshToken = newRefreshToken();
    const accessExpiresAt = Math.min(now + OAUTH_ACCESS_TTL_MS, grant.expires_at);
    const refreshExpiresAt = Math.min(now + OAUTH_REFRESH_TTL_MS, grant.expires_at);
    run(
      `INSERT INTO oauth_tokens (id, grant_id, kind, token_hash, scope, created_at, expires_at, used_at, replay_ciphertext, replay_until, replay_count)
       VALUES (?, ?, 'access', ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
      newId(), grant.id, sha256Hex(accessToken), scope, now, accessExpiresAt,
    );
    run(
      `INSERT INTO oauth_tokens (id, grant_id, kind, token_hash, scope, created_at, expires_at, used_at, replay_ciphertext, replay_until, replay_count)
       VALUES (?, ?, 'refresh', ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
      newId(), grant.id, sha256Hex(refreshToken), scope, now, refreshExpiresAt,
    );
    run('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?', now, grant.client_id);
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.max(0, Math.floor((accessExpiresAt - now) / 1000)),
      accessExpiresAt,
      refreshExpiresAt,
      scope,
    };
  }

  function issueTokens({ grantId, scope, now = Date.now() }) {
    if (!OAUTH_SCOPES.includes(scope)) throw new Error('invalid OAuth token scope');
    return transaction(() => {
      sweepInside(now);
      const grant = get(
        `SELECT g.* FROM oauth_grants g JOIN users u ON u.id = g.user_id
          WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled = 0 AND u.role <> 'guest'`, grantId, now,
      );
      if (!grant) return null;
      if (rankScope(scope) > rankScope(grant.scope)) throw new Error('OAuth token scope exceeds grant');
      if (scope !== grant.scope) run('UPDATE oauth_grants SET scope = ? WHERE id = ?', scope, grantId);
      const current = get('SELECT * FROM oauth_grants WHERE id = ?', grantId);
      return makeTokenPair(current, scope, now);
    });
  }

  function replayAad(refreshHash, replayUntil) {
    const time = Buffer.allocUnsafe(8);
    time.writeBigInt64BE(BigInt(replayUntil));
    return Buffer.concat([Buffer.from(refreshHash, 'hex'), time]);
  }

  function encryptReplay(value, refreshHash, replayUntil) {
    const nonce = crypto.randomBytes(REPLAY_NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', requireKeys().replay, nonce);
    cipher.setAAD(replayAad(refreshHash, replayUntil));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  function decryptReplay(encoded, refreshHash, replayUntil) {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const packed = Buffer.from(encoded, 'base64url');
    if (packed.toString('base64url') !== encoded || packed.length < REPLAY_NONCE_BYTES + REPLAY_TAG_BYTES + 1) return null;
    const nonce = packed.subarray(0, REPLAY_NONCE_BYTES);
    const tag = packed.subarray(REPLAY_NONCE_BYTES, REPLAY_NONCE_BYTES + REPLAY_TAG_BYTES);
    const ciphertext = packed.subarray(REPLAY_NONCE_BYTES + REPLAY_TAG_BYTES);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', requireKeys().replay, nonce);
      decipher.setAAD(replayAad(refreshHash, replayUntil));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const pair = JSON.parse(plain);
      return pair && typeof pair.accessToken === 'string' && typeof pair.refreshToken === 'string' ? pair : null;
    } catch {
      return null;
    }
  }

  function refresh({ refreshToken, clientId, scope = undefined, resource = undefined, expectedResource = undefined, now = Date.now() }) {
    if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_RE.test(refreshToken)) return { error: 'invalid_grant' };
    const tokenHash = sha256Hex(refreshToken);
    return transaction(() => {
      sweepInside(now);
      const row = get(
        `SELECT t.*, g.client_id, g.user_id, g.scope AS grant_scope, g.resource AS grant_resource,
                g.expires_at AS grant_expires_at, g.revoked_at AS grant_revoked_at,
                u.disabled AS user_disabled, u.role AS user_role
           FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
          WHERE t.token_hash = ? AND t.kind = 'refresh'`, tokenHash,
      );
      if (!row) return { error: 'invalid_grant' };
      if (typeof clientId !== 'string' || clientId !== row.client_id || !getClientRow(clientId, now)) return { error: 'invalid_client' };
      if (resource !== undefined && resource !== row.grant_resource) return { error: 'invalid_target' };
      if (expectedResource !== undefined && row.grant_resource !== expectedResource) {
        if (row.grant_revoked_at == null) revokeGrantInside(row.grant_id, 'user_state', now);
        return { error: 'invalid_grant' };
      }
      if (row.used_at != null) {
        if (row.replay_ciphertext && row.replay_until > now && row.replay_count === 0) {
          const pair = decryptReplay(row.replay_ciphertext, tokenHash, row.replay_until);
          if (pair && (scope === undefined || scope === pair.scope)
            && row.grant_revoked_at == null && row.grant_expires_at > now && !row.user_disabled && row.user_role !== 'guest') {
            run('UPDATE oauth_tokens SET replay_ciphertext = NULL, replay_until = NULL, replay_count = 1 WHERE id = ? AND replay_count = 0', row.id);
            return pair;
          }
        }
        run('UPDATE oauth_tokens SET replay_ciphertext = NULL, replay_until = NULL WHERE id = ?', row.id);
        revokeGrantInside(row.grant_id, 'reuse', now);
        return { error: 'reuse', grantId: row.grant_id };
      }
      if (row.expires_at <= now || row.grant_revoked_at != null || row.grant_expires_at <= now || row.user_disabled || row.user_role === 'guest') {
        if (row.grant_revoked_at == null && (row.grant_expires_at <= now || row.user_disabled || row.user_role === 'guest')) revokeGrantInside(row.grant_id, 'user_state', now);
        return { error: 'invalid_grant' };
      }
      const currentScope = minScope(row.scope, row.grant_scope);
      const nextScope = scope === undefined ? currentScope : scope;
      if (!OAUTH_SCOPES.includes(nextScope) || rankScope(nextScope) > rankScope(currentScope)) return { error: 'invalid_scope' };

      if (nextScope !== row.grant_scope) run('UPDATE oauth_grants SET scope = ? WHERE id = ?', nextScope, row.grant_id);
      const grant = get('SELECT * FROM oauth_grants WHERE id = ?', row.grant_id);
      const pair = makeTokenPair(grant, nextScope, now);
      const replayUntil = now + OAUTH_REPLAY_TTL_MS;
      const replay = encryptReplay(pair, tokenHash, replayUntil);
      if (run(
        `UPDATE oauth_tokens SET used_at = ?, replay_ciphertext = ?, replay_until = ?, replay_count = 0
          WHERE id = ? AND used_at IS NULL`, now, replay, replayUntil, row.id,
      ) !== 1) {
        revokeGrantInside(row.grant_id, 'reuse', now);
        return { error: 'reuse', grantId: row.grant_id };
      }
      return pair;
    });
  }

  function redeemCode({ code, clientId, redirectUri, codeVerifier, resource = undefined, expectedResource = undefined, scope = undefined, now = Date.now() }) {
    return transaction(() => {
      sweepInside(now);
      const row = readCodeRow(code);
      if (!row) return { error: 'invalid_grant' };
      if (row.used_at != null) {
        revokeGrantInside(row.grant_id, 'reuse', now);
        return { error: 'reuse', grantId: row.grant_id };
      }
      if (row.expires_at <= now) return { error: 'invalid_grant' };
      if (typeof clientId !== 'string' || !getClientRow(clientId, now)) return { error: 'invalid_client' };
      if (clientId !== row.client_id || redirectUri !== row.redirect_uri) return { error: 'invalid_grant' };
      if (resource !== undefined && resource !== row.resource) return { error: 'invalid_target' };

      const grant = get(
        `SELECT g.*, u.disabled AS user_disabled, u.role AS user_role
           FROM oauth_grants g JOIN users u ON u.id = g.user_id
          WHERE g.id = ?`, row.grant_id,
      );
      if (!grant || grant.revoked_at != null || grant.expires_at <= now) return { error: 'invalid_grant' };
      if (grant.user_disabled || grant.user_role === 'guest') {
        revokeGrantInside(row.grant_id, 'user_state', now);
        return { error: 'invalid_grant' };
      }
      if (expectedResource !== undefined && grant.resource !== expectedResource) {
        revokeGrantInside(row.grant_id, 'user_state', now);
        return { error: 'invalid_grant' };
      }
      const selectedScope = scope === undefined ? minScope(row.scope, grant.scope) : scope;
      if (!OAUTH_SCOPES.includes(selectedScope) || rankScope(selectedScope) > rankScope(minScope(row.scope, grant.scope))) return { error: 'invalid_scope' };

      const verifierDigest = typeof codeVerifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
        ? Buffer.from(sha256(codeVerifier).toString('base64url'))
        : Buffer.alloc(0);
      const challengeDigest = Buffer.from(row.code_challenge);
      const verifierValid = verifierDigest.length === challengeDigest.length
        && verifierDigest.length > 0
        && crypto.timingSafeEqual(verifierDigest, challengeDigest);
      if (run('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', now, row.code_hash) !== 1) {
        revokeGrantInside(row.grant_id, 'reuse', now);
        return { error: 'reuse', grantId: row.grant_id };
      }
      if (!verifierValid) return { error: 'invalid_grant' };
      if (selectedScope !== grant.scope) run('UPDATE oauth_grants SET scope = ? WHERE id = ?', selectedScope, row.grant_id);
      const currentGrant = get('SELECT * FROM oauth_grants WHERE id = ?', row.grant_id);
      return makeTokenPair(currentGrant, selectedScope, now);
    });
  }

  function findAccessToken(token, now = Date.now()) {
    if (typeof token !== 'string' || !ACCESS_TOKEN_RE.test(token)) return null;
    const row = get(
      `SELECT t.id AS token_id, t.scope AS token_scope, t.expires_at AS token_expires_at,
              g.id AS grant_id, g.user_id, g.client_id, g.scope AS grant_scope, g.board_ids, g.resource,
              g.expires_at AS grant_expires_at, g.revoked_at, c.name AS client_name,
              u.email, u.name AS user_name, u.role AS user_role, u.disabled, u.created_at AS user_created_at
         FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         JOIN oauth_clients c ON c.id = g.client_id JOIN users u ON u.id = g.user_id
        WHERE t.token_hash = ? AND t.kind = 'access'`, sha256Hex(token),
    );
    if (!row || row.revoked_at != null || row.grant_expires_at <= now || row.token_expires_at <= now || row.disabled || row.user_role === 'guest') return null;
    const client = getClientRow(row.client_id, now);
    if (!client) return null;
    return {
      id: row.token_id,
      tokenId: row.token_id,
      grantId: row.grant_id,
      userId: row.user_id,
      clientId: row.client_id,
      clientName: row.client_name,
      scope: minScope(row.token_scope, row.grant_scope),
      boardIds: parseBoardIds(row.board_ids),
      resource: row.resource,
      expiresAt: row.token_expires_at,
      user: {
        id: row.user_id,
        email: row.email,
        name: row.user_name,
        role: row.user_role,
        disabled: Boolean(row.disabled),
        createdAt: row.user_created_at,
      },
    };
  }

  function touchGrant(id, now = Date.now()) {
    return transaction(() => {
      const touched = run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)', now, id, now - 60_000);
      if (touched) run('UPDATE oauth_clients SET last_used_at = ? WHERE id = (SELECT client_id FROM oauth_grants WHERE id = ?)', now, id);
      return touched === 1;
    });
  }

  const GRANT_SELECT = `SELECT g.*, c.name AS client_name, c.redirect_uris,
                               u.name AS user_name, u.email AS user_email, u.role AS user_role
                          FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
                          JOIN users u ON u.id = g.user_id`;

  function listGrants(userId, now = Date.now()) {
    return all(`${GRANT_SELECT} WHERE g.user_id = ? AND g.${activeGrantClause} AND u.disabled = 0 ORDER BY g.created_at DESC, g.id`, userId, now)
      .map((row) => toGrant({ ...row, redirect_host: redirectHost(parseRedirectUris(row.redirect_uris)[0] ?? '') }));
  }

  function listGrantsAdmin(now = Date.now()) {
    return all(`${GRANT_SELECT} WHERE g.${activeGrantClause} AND u.disabled = 0 ORDER BY g.created_at DESC, g.id`, now)
      .map((row) => ({
        ...toGrant({ ...row, redirect_host: redirectHost(parseRedirectUris(row.redirect_uris)[0] ?? '') }),
        userName: row.user_name,
        email: row.user_email,
        userRole: row.user_role,
      }));
  }

  function getGrant(id) {
    const row = typeof id === 'string' ? get(`${GRANT_SELECT} WHERE g.id = ?`, id) : undefined;
    return row ? toGrant({ ...row, redirect_host: redirectHost(parseRedirectUris(row.redirect_uris)[0] ?? '') }) : null;
  }

  function revokeGrant(id, reason = 'self', now = Date.now()) {
    return transaction(() => revokeGrantInside(id, reason, now));
  }

  function findRefreshGrant(refreshToken) {
    if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_RE.test(refreshToken)) return null;
    const row = get(
      `SELECT g.id AS grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
        WHERE t.token_hash = ? AND t.kind = 'refresh'`,
      sha256Hex(refreshToken),
    );
    return row ? { grantId: row.grant_id, clientId: row.client_id } : null;
  }

  function revokeToken(token, clientId, now = Date.now()) {
    if (typeof token !== 'string' || typeof clientId !== 'string') return null;
    const isAccess = ACCESS_TOKEN_RE.test(token);
    const isRefresh = REFRESH_TOKEN_RE.test(token);
    if (!isAccess && !isRefresh) return null;
    return transaction(() => {
      const row = get(
        `SELECT g.id AS grant_id, g.user_id, g.client_id, g.revoked_at, g.expires_at,
                c.name AS client_name, t.expires_at AS token_expires_at
           FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
           JOIN oauth_clients c ON c.id = g.client_id
          WHERE t.token_hash = ? AND t.kind = ?`,
        sha256Hex(token), isAccess ? 'access' : 'refresh',
      );
      if (!row || row.client_id !== clientId || row.revoked_at != null || row.expires_at <= now || row.token_expires_at <= now) return null;
      if (!revokeGrantInside(row.grant_id, 'client', now)) return null;
      return { grantId: row.grant_id, userId: row.user_id, clientId: row.client_id, clientName: row.client_name };
    });
  }

  function revokeGrantFamily(id, reason = 'self', now = Date.now()) {
    return revokeGrant(id, reason, now);
  }

  function revokeAllForUser(userId, reason = 'user_state', now = Date.now()) {
    return transaction(() => {
      const rows = all(`SELECT id FROM oauth_grants WHERE user_id = ? AND ${activeGrantClause}`, userId, now);
      for (const row of rows) revokeGrantInside(row.id, reason, now);
      return rows.length;
    });
  }

  function revokeAll(reason = 'restore', now = Date.now()) {
    return transaction(() => {
      const rows = all(`SELECT id FROM oauth_grants WHERE ${activeGrantClause}`, now);
      for (const row of rows) revokeGrantInside(row.id, reason, now);
      run('UPDATE oauth_tokens SET replay_ciphertext = NULL, replay_until = NULL WHERE replay_ciphertext IS NOT NULL');
      return rows.length;
    });
  }

  function invalidateAfterRestore(now = Date.now(), reason = 'restore', purgeClients = false) {
    return transaction(() => {
      const revoked = revokeAll(reason, now);
      run('DELETE FROM oauth_requests');
      run('DELETE FROM oauth_codes');
      run('UPDATE oauth_tokens SET replay_ciphertext = NULL, replay_until = NULL, replay_count = 0');
      const clients = purgeClients ? run('DELETE FROM oauth_clients') : 0;
      return { revoked, clients };
    });
  }

  function purgeClients(_operator, now = Date.now()) {
    return transaction(() => {
      sweepInside(now);
      return run('DELETE FROM oauth_clients');
    });
  }

  function createOAuthNonceForRequest(fields) {
    return createOAuthNonce(fields, secret);
  }

  function verifyOAuthNonceForRequest(nonce, fields) {
    return verifyOAuthNonce(nonce, fields, secret);
  }

  return {
    registerClient,
    getClient,
    getClientByFingerprint,
    countClients,
    purgeClients,
    createGrant,
    issueCode,
    consumeCode,
    issueTokens,
    refresh,
    findRefreshGrant,
    revokeToken,
    signRequest,
    readRequest,
    decideRequest,
    redeemCode,
    findAccessToken,
    findOauthAccessToken: findAccessToken,
    touchGrant,
    listGrants,
    listGrantsAdmin,
    getGrant,
    revokeGrant,
    revokeGrantFamily,
    revokeFamily: revokeGrantFamily,
    revokeAllForUser,
    revokeUserGrants: revokeAllForUser,
    revokeAll,
    revokeAllGrantsInstance: revokeAll,
    invalidateAfterRestore,
    sweep,
    cleanup: sweep,
    createOAuthNonce: createOAuthNonceForRequest,
    verifyOAuthNonce: verifyOAuthNonceForRequest,
  };
}
