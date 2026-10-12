import crypto from 'node:crypto';
import { normaliseEmail } from './config.mjs';
import { mailFailureDetails } from './mail-health.mjs';
import { rateKeyOf } from './client-ip.mjs';

const HOUR_MS = 60 * 60 * 1000;
/** Sign-in link requests per hour for one email address from one client (the pair), so another address cannot use up the owner's own allowance. */
const PAIR_LIMIT = 5;
const DEFAULT_EMAIL_LIMIT = 30;
const DEFAULT_IP_LIMIT = 300;
const SWEEP_MS = 60 * 1000;
const MAX_LIMITER_KEYS = 50_000;
/** A full table sends a new key to one of this many overflow shards, each allowing this many times the per-key limit. */
const OVERFLOW_SHARDS = 256;
const SHARD_FACTOR = 6;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The header every state-changing API request must carry; another site cannot add it without a CORS preflight the server never grants. */
export const CSRF_HEADER = 'x-tabula';
/** Accepted during the rename transition; clients built before it send this one. */
const LEGACY_CSRF_HEADER = 'x-mira';
const COOKIE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** A new person would need a seat the workspace does not have (hosted workspaces, docs/cloud.md). */
/** The invite's last use was taken (by someone else) before this sign-in could take it. */
export class InviteExhaustedError extends Error {}

export class SeatLimitError extends Error {
  constructor() {
    super('no free seat');
    this.name = 'SeatLimitError';
  }
}

// Three in-memory buckets, each an hour long. A request that is limited counts against none of them.
//   pair:  one email address asked for by one client (PAIR_LIMIT). Keyed by both, so a stranger who asks for your address
//          from their own address fills their pair, never yours.
//   email: one email address from anyone (emailLimit, default 30). Bounds how much mail a mailbox can be sent.
//   ip:    one client address, any email (ipLimit).
// Whether the account exists is never an input: the same counts apply to known and unknown addresses, so a 429 tells
// nothing about who has an account.
//
// Each table holds at most MAX_LIMITER_KEYS keys. A live key is never evicted (forgetting it would hand its owner a fresh
// allowance, so an attacker could reset a victim's quota by flooding the table with other keys). When a table is full,
// keys with no hit in the last hour are purged first; if it is still full, a new key goes to one of OVERFLOW_SHARDS shards
// of that table, picked by a keyed hash (a secret random per process, so nobody can aim at a shard). Each shard is its own
// bucket with SHARD_FACTOR times the per-key limit and its own window. Memory stays bounded (256 small arrays per table).
// This is not a cure: an attacker who fills a table can exhaust shards, and the keys that hash to them are refused until
// the hour is up; sharding makes that cost 256 times larger than one shared bucket, not impossible.
/** The default shard of a key: the first 4 bytes of an HMAC-SHA256 under a random per-process secret, mod OVERFLOW_SHARDS. */
function keyedShardOf() {
  const secret = crypto.randomBytes(32);
  return (scope, key) => crypto.createHmac('sha256', secret).update(`${scope}\u0000${key}`).digest().readUInt32BE(0) % OVERFLOW_SHARDS;
}

/** @param {(scope: string, key: string) => number} [shardOf] test seam: which overflow shard (0 to 255) a key falls in */
function createLimiter(now, ipLimit, emailLimit, shardOf = keyedShardOf()) {
  const table = (limit) => ({ map: new Map(), limit, shards: new Map(), lastPurge: 0 });
  const tables = { pair: table(PAIR_LIMIT), email: table(emailLimit), ip: table(ipLimit) };
  let lastSweep = 0;

  const live = (hits, t) => hits.filter((ts) => ts > t - HOUR_MS);

  function purge(tb, t) {
    for (const [key, hits] of tb.map) {
      if (!hits.some((ts) => ts > t - HOUR_MS)) tb.map.delete(key);
    }
    tb.lastPurge = t;
  }

  function sweep(t) {
    if (t - lastSweep < SWEEP_MS) return;
    lastSweep = t;
    for (const tb of Object.values(tables)) {
      purge(tb, t);
      for (const [id, hits] of tb.shards) if (!hits.some((ts) => ts > t - HOUR_MS)) tb.shards.delete(id);
    }
  }

  // Where this key's hits live: its own entry, or its overflow shard when the table is full of live keys.
  function locate(scope, key, t) {
    const tb = tables[scope];
    if (!tb.map.has(key) && tb.map.size >= MAX_LIMITER_KEYS && t - tb.lastPurge >= 1000) purge(tb, t);
    const overflow = !tb.map.has(key) && tb.map.size >= MAX_LIMITER_KEYS;
    const shard = overflow ? Math.abs(Math.trunc(Number(shardOf(scope, key)))) % OVERFLOW_SHARDS : -1;
    const hits = live(overflow ? (tb.shards.get(shard) ?? []) : (tb.map.get(key) ?? []), t);
    return { scope, tb, key, overflow, shard, hits, limit: overflow ? tb.limit * SHARD_FACTOR : tb.limit };
  }

  // Returns null when the request may go on, else which limit was hit (the one with the longest wait) and the real
  // seconds until the oldest hit in it leaves the window. Scope 'pair' and 'email' both mean "this email address".
  return function allow(email, ip) {
    const t = now();
    sweep(t);
    const ipKey = String(rateKeyOf(ip) || 'unknown').slice(0, 64);
    const buckets = [
      locate('pair', `${ipKey}\u0000${email}`, t),
      locate('email', email, t),
      locate('ip', ipKey, t),
    ];
    const wait = (hits) => Math.max(1, Math.ceil((hits[0] + HOUR_MS - t) / 1000));
    let blocked = null;
    for (const b of buckets) {
      if (b.hits.length < b.limit) continue;
      const retryAfterSec = wait(b.hits);
      if (!blocked || retryAfterSec > blocked.retryAfterSec) blocked = { scope: b.scope, retryAfterSec };
    }
    if (blocked) return blocked;
    for (const b of buckets) {
      if (b.overflow) b.tb.shards.set(b.shard, [...b.hits, t]);
      else b.tb.map.set(b.key, [...b.hits, t]);
    }
    return null;
  };
}

/** The CSRF rule of every state-changing request: the custom header, and an Origin (when sent) that matches the host. */
export function csrfOk(req) {
  if (SAFE_METHODS.has(String(req.method).toUpperCase())) return true;
  if (req.headers[CSRF_HEADER] !== '1' && req.headers[LEGACY_CSRF_HEADER] !== '1') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function createAuth({ directory, config, mailer, now = Date.now, seatsAvailable = () => true, log = (/** @type {string} */ _line) => {}, notifications = /** @type {any} */ (null), limiterShardOf = /** @type {((scope: string, key: string) => number) | undefined} */ (undefined) }) {
  const allow = createLimiter(now, config.authIpLimit ?? DEFAULT_IP_LIMIT, config.authEmailLimit ?? DEFAULT_EMAIL_LIMIT, limiterShardOf);

  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;

  function sessionCookie(token, maxAgeMs) {
    if (typeof token !== 'string' || !COOKIE_TOKEN_RE.test(token)) throw new Error('invalid session token');
    return `${config.cookieName}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}; ${cookieFlags}`;
  }

  const clearCookie = () =>
    `${config.cookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${cookieFlags}`;

  const ownerMayBootstrap = (email) =>
    config.ownerEmail !== null && email === config.ownerEmail && directory.countOwners() === 0;

  function sendLoginMail(email, token, oauthRequest = null, invite = null) {
    const verifyUrl = new URL(config.baseUrl);
    const verifyParams = new URLSearchParams({ token });
    if (oauthRequest) verifyParams.set('oauthRequest', oauthRequest);
    if (invite) verifyParams.set('invite', invite);
    verifyUrl.hash = `/signin/verify?${verifyParams}`;
    const link = verifyUrl.href;
    const minutes = Math.round(config.loginTokenMs / 60000);
    const message = {
      to: email,
      template: 'sign-in',
      params: { link, minutes },
      subject: 'Your Tabula sign-in link',
      text: `Sign in to Tabula with this link:\n\n${link}\n\nThe link works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.\n`,
    };
    // Do not await: the allowed address would otherwise take a different amount of time from an unknown one.
    // The next auth request sees service refusals through the global mail health state.
    const failed = (err) => {
      const { reason } = mailFailureDetails(err);
      log(`auth request mail_failed reason=${reason}`);
    };
    try {
      Promise.resolve(mailer.send(message)).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  async function requestLogin(request) {
    const { email, invite, ip, oauthRequest: requestedOAuth } = request;
    const address = normaliseEmail(email);
    if (!address) return { ok: true };
    const blocked = allow(address, ip);
    if (blocked) {
      log(`auth request rate_limited scope=${blocked.scope}`);
      return { limited: true, ...blocked };
    }

    const t = now();
    const validInvite = typeof invite === 'string' && invite ? directory.findInvite(invite, t) : null;
    const user = directory.getUserByEmail(address);
    const allowed = user ? !user.disabled : validInvite !== null || ownerMayBootstrap(address);
    if (!allowed) return { ok: true };

    const token = directory.createLoginToken({
      email: address,
      inviteId: validInvite?.id ?? null,
      ttlMs: config.loginTokenMs,
      now: t,
    });
    let oauthRequest = null;
    if (config.mcp?.oauth && typeof requestedOAuth === 'string' && requestedOAuth.length <= 8192) {
      try {
        if (directory.readRequest(requestedOAuth, t)) oauthRequest = requestedOAuth;
      } catch {
        // A malformed or expired consent return behaves like an ordinary sign-in request.
      }
    }
    sendLoginMail(address, token, oauthRequest, validInvite ? invite : null);
    return { ok: true };
  }

  /** @param {string} token @param {{ userAgent?: string | null }} [opts] */
  function verifyLogin(token, { userAgent = null } = {}) {
    let inviterToPing = null;
    const result = directory.transaction(() => {
      const t = now();
      const consumed = directory.consumeLoginToken(token, t);
      if (!consumed) return null;

      const invite = consumed.inviteId ? directory.findInviteById(consumed.inviteId, t) : null;
      let user = directory.getUserByEmail(consumed.email);
      if (user) {
        if (user.disabled) return null;
      } else if (ownerMayBootstrap(consumed.email)) {
        user = directory.createUser({ email: consumed.email, role: 'owner' });
      } else if (invite) {
        // Thrown inside the transaction on purpose: the login token and the invite stay unused, so the same link works once a seat is free.
        if (!seatsAvailable()) throw new SeatLimitError();
        user = directory.createUser({ email: consumed.email, role: 'member' });
      } else {
        return null;
      }

      if (invite) {
        const current = directory.getTeamRole(invite.teamId, user.id);
        if (current === null || (current === 'member' && invite.role === 'admin')) {
          directory.addTeamMember(invite.teamId, user.id, invite.role);
          // The inviter hears that someone joined (a new person joining through the link is the classroom case).
          if (current === null && invite.createdBy && notifications) {
            notifications.record({ userId: invite.createdBy, kind: 'team_joined', actorId: user.id, teamId: invite.teamId, ref: invite.id }, { notify: false });
            inviterToPing = invite.createdBy;
          }
        }
        // Check-and-increment in one statement: if the last use was taken meanwhile, undo the whole sign-in.
        if (!directory.recordInviteUse(invite.id)) throw new InviteExhaustedError();
      }

      const session = directory.createSession(user.id, { ttlMs: config.sessionMs, now: t, userAgent });
      return { user, sessionToken: session.token, maxAgeMs: config.sessionMs };
    });
    if (result && inviterToPing) notifications?.ping(inviterToPing);
    return result;
  }

  function authenticate(cookieHeader) {
    if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim() !== config.cookieName) continue;
      const token = part.slice(eq + 1).trim();
      if (!token) continue;
      const t = now();
      const session = directory.getSession(token, t);
      if (session) {
        const setCookie = session.extended ? sessionCookie(token, session.expiresAt - t) : undefined;
        return { user: session.user, sessionId: session.id, expiresAt: session.expiresAt, setCookie };
      }
      if (config.joinCodes !== true) continue;
      const guest = directory.getGuestSession(hashToken(token), t);
      if (!guest) continue;
      return {
        user: {
          id: `guest_${guest.id}`, email: '', name: guest.name, role: 'guest', guest: true,
          guestBoardId: guest.boardId, guestBoardRole: guest.role,
        },
        sessionId: guest.id,
        expiresAt: guest.expiresAt,
        guest: true,
        boardId: guest.boardId,
        boardRole: guest.role,
      };
    }
    return null;
  }

  /** Checks only the one-board guest credential, for HTTP and WebSocket scope gates. */
  function authenticateGuest(cookieHeader) {
    if (config.joinCodes !== true || typeof cookieHeader !== 'string' || !cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim() !== config.cookieName) continue;
      const token = part.slice(eq + 1).trim();
      if (!token || !COOKIE_TOKEN_RE.test(token)) continue;
      const guest = directory.getGuestSession(hashToken(token), now());
      if (!guest) continue;
      return {
        user: {
          id: `guest_${guest.id}`, email: '', name: guest.name, role: 'guest', guest: true,
          guestBoardId: guest.boardId, guestBoardRole: guest.role,
        },
        sessionId: guest.id,
        expiresAt: guest.expiresAt,
        guest: true,
        boardId: guest.boardId,
        boardRole: guest.role,
      };
    }
    return null;
  }

  return {
    requestLogin,
    verifyLogin,
    authenticate,
    authenticateGuest,
    sessionCookie,
    clearCookie,
    logout: (sessionId) => directory.revokeSession(sessionId),
    logoutAll: (userId) => directory.revokeUserSessions(userId),
    csrfOk,
  };
}
