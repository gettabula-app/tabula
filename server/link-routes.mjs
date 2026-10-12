// The link preview endpoint's logic (docs/link-cards.md, "Fetching a preview"): who may ask, how often, the cache, the
// limits on work in flight, then one guarded fetch and the parse. api.mjs (accounts mode) and relay.mjs (open mode) wrap it
// in their own routes; it knows nothing about HTTP, so it throws LinkRouteError and returns a plain object.
// Slice 2a answers text fields only: `image` and `icon` are null until the assets slice stores them.
import { AssetError, readBytes } from './assets.mjs';
import { createWindowLimiter } from './limiter.mjs';
import { LinkFetchError, fetchPage as realFetchPage } from './link-fetch.mjs';
import { LinkGuardError, validateLinkUrl } from './link-guard.mjs';
import { parseLinkHead } from './link-parse.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const LINK_LIMITS = {
  personPerMinute: 30,
  personPerHour: 300,
  workspacePerHour: 2000,
  clientPerMinute: 10, // open mode, counted per client address
  inFlight: 4,
  cacheEntries: 2000,
  okTtlMs: 24 * HOUR,
  failTtlMs: 10 * MINUTE,
};

/** Fetch outcomes the card can show (docs/link-cards.md, data model `unfurlError`). */
const FETCH_CODES = new Set(['blocked', 'timeout', 'too_large', 'not_html', 'http_status', 'unreachable']);

export class LinkRouteError extends Error {
  constructor(status, code, message, retryAfter = undefined) {
    super(message);
    this.name = 'LinkRouteError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const MESSAGES = {
  blocked: 'This address cannot be previewed',
  timeout: 'The site did not answer in time',
  too_large: 'The page is too large to preview',
  not_html: 'This address is not a web page',
  http_status: 'The site did not return a page',
  unreachable: 'The site could not be reached',
};

const fetchFailure = (code) => new LinkRouteError(422, code, MESSAGES[code]);

/** One value from Accept-Language, or `en`: the spec sends a single language so titles come back in the person's own. */
export function pickLanguage(header) {
  const first = String(Array.isArray(header) ? header[0] : header ?? '').split(',')[0].split(';')[0].trim();
  return /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(first) ? first : 'en';
}

/**
 * @param {object} deps
 * `getSetting(key)` reads the workspace setting (null in open mode). `fetchPage` and `fetchOptions` are the test seams for the
 * network: a resolver and a "public range" test injected there reach the real guard and the real fetcher unchanged.
 */
export function createLinkUnfurl({ config, getSetting = () => null, hosted = false, now = Date.now, log = () => {}, fetchPage = realFetchPage, fetchOptions = {} }) {
  const person = { minute: createWindowLimiter(LINK_LIMITS.personPerMinute, now, MINUTE), hour: createWindowLimiter(LINK_LIMITS.personPerHour, now, HOUR) };
  const workspace = createWindowLimiter(LINK_LIMITS.workspacePerHour, now, HOUR);
  const client = createWindowLimiter(LINK_LIMITS.clientPerMinute, now, MINUTE);
  /** key -> { at, ttl, value | error }; insertion order is the eviction order (a hit moves the entry to the back). */
  const cache = new Map();
  /** key -> { promise, controller, refs, host }: the same address asked twice at once is fetched once. */
  const pending = new Map();
  const busyHosts = new Set();

  const forced = () => config.linkPreviews?.forced ?? null;

  /** The kill switch beats everything; an explicit workspace setting beats the default; otherwise `on` for hosted workspaces only. */
  function enabled() {
    if (forced() === 'off') return false;
    const setting = getSetting('linkPreviews.enabled');
    if (setting === '1') return true;
    if (setting === '0') return false;
    return forced() === 'on' || hosted;
  }

  function state() {
    const setting = getSetting('linkPreviews.enabled');
    return { enabled: enabled(), locked: forced() === 'off', setting: setting === null ? null : setting === '1' };
  }

  function admit(rateKeys) {
    const limiters = [];
    if (rateKeys.client) limiters.push([client, rateKeys.client]);
    if (rateKeys.person) limiters.push([person.minute, rateKeys.person], [person.hour, rateKeys.person]);
    if (rateKeys.workspace) limiters.push([workspace, rateKeys.workspace]);
    const wait = Math.max(0, ...limiters.map(([limiter, key]) => limiter.wait(key)));
    if (wait) throw new LinkRouteError(429, 'rate_limited', 'Too many previews. Try again in a moment.', wait);
    for (const [limiter, key] of limiters) limiter.hit(key);
  }

  function remember(key, entry) {
    cache.delete(key);
    cache.set(key, { at: now(), ...entry });
    while (cache.size > LINK_LIMITS.cacheEntries) cache.delete(cache.keys().next().value);
  }

  function recall(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at >= hit.ttl) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  async function work(checked, language, signal) {
    const page = await fetchPage(checked.url.href, { ...fetchOptions, instanceUrl: config.baseUrl, acceptLanguage: language, signal });
    const head = parseLinkHead(page.bytes, { finalUrl: page.finalUrl, charset: page.charset });
    return {
      title: head.title,
      description: head.description,
      siteName: head.siteName,
      image: null,
      imageW: null,
      imageH: null,
      icon: null,
      finalUrl: page.finalUrl,
      fetchedAt: now(),
    };
  }

  function codeOf(error) {
    if (error instanceof LinkGuardError || error instanceof LinkFetchError) return FETCH_CODES.has(error.code) ? error.code : 'unreachable';
    return 'unreachable';
  }

  /**
   * @param {{ url: unknown, acceptLanguage?: string | string[], signal?: AbortSignal, rateKeys: { person?: string, workspace?: string, client?: string } }} request
   * Throws LinkRouteError. The caller has already decided the person may ask (an editor of the board, or open mode).
   */
  async function unfurl({ url, acceptLanguage, signal, rateKeys }) {
    if (!enabled()) throw new LinkRouteError(409, 'previews_off', 'Link previews are off');
    if (typeof url !== 'string' || !url.trim()) throw new LinkRouteError(400, 'bad_request', 'url must be a web address');
    let checked;
    try {
      checked = validateLinkUrl(url.trim(), fetchOptions.allowedPorts ? { allowedPorts: fetchOptions.allowedPorts } : {});
    } catch {
      let parsed = null;
      try { parsed = new URL(url.trim()); } catch { /* not an address at all */ }
      if (parsed && (parsed.username || parsed.password)) throw new LinkRouteError(400, 'credentials_in_url', "Addresses with a user name or password can't be added");
      // a refused scheme or a malformed address is the caller's mistake; a private or local target is a refusal to fetch
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || url.length > 2048) throw new LinkRouteError(400, 'bad_url', 'Enter a web address that starts with http or https');
      throw fetchFailure('blocked');
    }
    admit(rateKeys);

    const key = checked.url.href;
    const cached = recall(key);
    if (cached) {
      if (cached.error) throw fetchFailure(cached.error);
      return cached.value;
    }

    let entry = pending.get(key);
    if (!entry) {
      if (pending.size >= LINK_LIMITS.inFlight || busyHosts.has(checked.hostname)) {
        throw new LinkRouteError(429, 'rate_limited', 'The server is busy fetching previews. Try again in a moment.', 2);
      }
      const controller = new AbortController();
      busyHosts.add(checked.hostname);
      entry = { controller, refs: 0, host: checked.hostname, promise: null };
      entry.promise = work(checked, pickLanguage(acceptLanguage), controller.signal).then(
        (value) => {
          remember(key, { value, ttl: LINK_LIMITS.okTtlMs });
          return value;
        },
        (error) => {
          const code = codeOf(error);
          // an abort because every asker left is not the site's fault and is not remembered
          if (!controller.signal.aborted) remember(key, { error: code, ttl: LINK_LIMITS.failTtlMs });
          log(`link-preview: ${code} ${checked.hostname}`);
          throw fetchFailure(code);
        },
      ).finally(() => {
        pending.delete(key);
        busyHosts.delete(entry.host);
      });
      entry.promise.catch(() => {}); // each asker handles the failure itself
      pending.set(key, entry);
    }

    entry.refs += 1;
    const leave = () => {
      entry.refs -= 1;
      if (entry.refs <= 0) entry.controller.abort(new Error('Nobody is waiting for this preview any more'));
    };
    try {
      if (signal) {
        if (signal.aborted) throw new LinkRouteError(499, 'aborted', 'The request was cancelled');
        const gone = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new LinkRouteError(499, 'aborted', 'The request was cancelled')), { once: true }));
        gone.catch(() => {});
        return await Promise.race([entry.promise, gone]);
      }
      return await entry.promise;
    } finally {
      leave();
    }
  }

  return { enabled, state, unfurl, _cacheSize: () => cache.size };
}

// ---------------------------------------------------------------- open mode

const UNFURL_PATH_RE = /^\/api\/boards\/([A-Za-z0-9_-]{1,64})\/unfurl$/;

/**
 * Open mode has no accounts and no roles, so previews exist only with TABULA_LINK_PREVIEWS=on, and each client address gets
 * a few a minute. A write needs the x-tabula header, which a page on another origin cannot send without a preflight.
 * Answers the request and returns true when the path is the unfurl path, false to let the caller go on.
 */
export function createOpenLinkRoutes({ linkUnfurl, clientIp }) {
  const send = (res, status, body, headers = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(payload);
  };
  return async function handle(req, res, url) {
    if (!UNFURL_PATH_RE.test(url.pathname)) return false;
    if (String(req.method).toUpperCase() !== 'POST') {
      send(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' }, { allow: 'POST' });
      return true;
    }
    const gone = new AbortController();
    const onClose = () => { if (!res.writableEnded) gone.abort(); };
    res.on('close', onClose);
    try {
      if (req.headers['x-tabula'] !== '1') throw new LinkRouteError(403, 'csrf', 'Missing or invalid CSRF protection header');
      let body = {};
      try {
        const parsed = JSON.parse((await readBytes(req, 4 * 1024)).toString('utf8') || '{}');
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed;
      } catch (err) {
        if (err instanceof AssetError) throw new LinkRouteError(err.status, err.code, err.message);
        throw new LinkRouteError(400, 'bad_request', 'The request body is not valid JSON');
      }
      send(res, 200, await linkUnfurl.unfurl({
        url: body.url,
        acceptLanguage: req.headers['accept-language'],
        signal: gone.signal,
        rateKeys: { client: clientIp(req) },
      }));
    } catch (err) {
      if (!(err instanceof LinkRouteError)) throw err;
      if (!res.writableEnded && !res.destroyed) send(res, err.status, { error: err.code, message: err.message }, err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {});
    } finally {
      res.off('close', onClose);
    }
    return true;
  };
}
