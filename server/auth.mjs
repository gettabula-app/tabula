import crypto from 'node:crypto';
import { normaliseEmail } from './config.mjs';
import { mailFailureDetails } from './mail-health.mjs';

const HOUR_MS = 60 * 60 * 1000;
const EMAIL_LIMIT = 5;
const DEFAULT_IP_LIMIT = 300;
const SWEEP_MS = 60 * 1000;
const MAX_LIMITER_KEYS = 50_000;
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

function createLimiter(now, ipLimit) {
  const byEmail = new Map();
  const byIp = new Map();
  let lastSweep = 0;

  const recent = (map, key, t) => (map.get(key) ?? []).filter((ts) => ts > t - HOUR_MS);

  // a key in use goes to the back of the map, so the bound forgets the key idle longest, never one that is busy
  function remember(map, key, hits) {
    map.delete(key);
    map.set(key, hits);
    if (map.size > MAX_LIMITER_KEYS) map.delete(map.keys().next().value);
  }

  function sweep(t) {
    if (t - lastSweep < SWEEP_MS) return;
    lastSweep = t;
    for (const map of [byEmail, byIp]) {
      for (const [key, hits] of map) {
        if (!hits.some((ts) => ts > t - HOUR_MS)) map.delete(key);
      }
    }
  }

  // Returns null when the request may go on, else which limit was hit and the real seconds until the oldest hit leaves the window.
  return function allow(email, ip) {
    const t = now();
    sweep(t);
    const ipKey = String(ip || 'unknown').slice(0, 64);
    const emailHits = recent(byEmail, email, t);
    const ipHits = recent(byIp, ipKey, t);
    const emailFull = emailHits.length >= EMAIL_LIMIT;
    const ipFull = ipHits.length >= ipLimit;
    if (emailFull || ipFull) {
      if (emailHits.length) remember(byEmail, email, emailHits);
      if (ipHits.length) remember(byIp, ipKey, ipHits);
      const wait = (hits) => Math.max(1, Math.ceil((hits[0] + HOUR_MS - t) / 1000));
      const emailWait = emailFull ? wait(emailHits) : 0;
      const ipWait = ipFull ? wait(ipHits) : 0;
      return emailWait >= ipWait ? { scope: 'email', retryAfterSec: emailWait } : { scope: 'ip', retryAfterSec: ipWait };
    }
    remember(byEmail, email, [...emailHits, t]);
    remember(byIp, ipKey, [...ipHits, t]);
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

export function createAuth({ directory, config, mailer, now = Date.now, seatsAvailable = () => true, log = (/** @type {string} */ _line) => {}, notifications = /** @type {any} */ (null) }) {
  const allow = createLimiter(now, config.authIpLimit ?? DEFAULT_IP_LIMIT);

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
