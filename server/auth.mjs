import { normaliseEmail } from './config.mjs';

const HOUR_MS = 60 * 60 * 1000;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 20;
const SWEEP_MS = 60 * 1000;
const MAX_LIMITER_KEYS = 50_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const COOKIE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/** A new person would need a seat the workspace does not have (hosted workspaces, docs/cloud.md). */
export class SeatLimitError extends Error {
  constructor() {
    super('no free seat');
    this.name = 'SeatLimitError';
  }
}

function createLimiter(now) {
  const byEmail = new Map();
  const byIp = new Map();
  let lastSweep = 0;

  const recent = (map, key, t) => (map.get(key) ?? []).filter((ts) => ts > t - HOUR_MS);

  function remember(map, key, hits) {
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

  return function allow(email, ip) {
    const t = now();
    sweep(t);
    const ipKey = String(ip || 'unknown').slice(0, 64);
    const emailHits = recent(byEmail, email, t);
    const ipHits = recent(byIp, ipKey, t);
    if (emailHits.length >= EMAIL_LIMIT || ipHits.length >= IP_LIMIT) return false;
    remember(byEmail, email, [...emailHits, t]);
    remember(byIp, ipKey, [...ipHits, t]);
    return true;
  };
}

export function createAuth({ directory, config, mailer, now = Date.now, seatsAvailable = () => true }) {
  const allow = createLimiter(now);

  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;

  function sessionCookie(token, maxAgeMs) {
    if (typeof token !== 'string' || !COOKIE_TOKEN_RE.test(token)) throw new Error('invalid session token');
    return `${config.cookieName}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}; ${cookieFlags}`;
  }

  const clearCookie = () =>
    `${config.cookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${cookieFlags}`;

  const ownerMayBootstrap = (email) =>
    config.ownerEmail !== null && email === config.ownerEmail && directory.countOwners() === 0;

  function sendLoginMail(email, token) {
    const link = `${config.baseUrl}/#/signin/verify?token=${encodeURIComponent(token)}`;
    const minutes = Math.round(config.loginTokenMs / 60000);
    const message = {
      to: email,
      template: 'sign-in',
      params: { link, minutes },
      subject: 'Your Tabula sign-in link',
      text: `Sign in to Tabula with this link:\n\n${link}\n\nThe link works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.\n`,
    };
    // Not awaited and never rethrown: a failure or a slow mail server must not tell the caller
    // whether this address exists.
    const failed = (err) => console.error('mail: could not send a sign-in link:', err?.message ?? err);
    try {
      Promise.resolve(mailer.send(message)).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  async function requestLogin(request) {
    const { email, invite, ip } = request;
    const address = normaliseEmail(email);
    if (!address) return { ok: true };
    if (!allow(address, ip)) return { limited: true };

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
    sendLoginMail(address, token);
    return { ok: true };
  }

  function verifyLogin(token) {
    return directory.transaction(() => {
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
        }
        directory.recordInviteUse(invite.id);
      }

      const session = directory.createSession(user.id, { ttlMs: config.sessionMs, now: t });
      return { user, sessionToken: session.token, maxAgeMs: config.sessionMs };
    });
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
      if (!session) continue;
      const setCookie = session.extended ? sessionCookie(token, session.expiresAt - t) : undefined;
      return { user: session.user, sessionId: session.id, expiresAt: session.expiresAt, setCookie };
    }
    return null;
  }

  function csrfOk(req) {
    if (SAFE_METHODS.has(String(req.method).toUpperCase())) return true;
    if (req.headers['x-tabula'] !== '1' && req.headers['x-mira'] !== '1') return false;
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

  return {
    requestLogin,
    verifyLogin,
    authenticate,
    sessionCookie,
    clearCookie,
    logout: (sessionId) => directory.revokeSession(sessionId),
    logoutAll: (userId) => directory.revokeUserSessions(userId),
    csrfOk,
  };
}
