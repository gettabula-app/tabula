// HTTP side of the asset store (docs/images.md, API). The same handlers serve accounts mode (routes registered in
// api.mjs, where the board role is checked) and open mode (createOpenAssetRoutes below, where there are no roles).
// A handler returns `[status, body, headers]` like an api.mjs route and throws AssetError for refusals.
import { AssetError, HASH_RE, assetHeaders, readBytes } from './assets.mjs';

const view = (row) => ({ hash: row.hash, mime: row.mime, bytes: row.bytes, width: row.width, height: row.height });

export function createAssetHandlers({ store, limiter }) {
  return {
    /**
     * `authorize()` runs before the body is read and again after it (a body can take a while, and a person can lose
     * access meanwhile); it throws what the caller wants refused. `onCreated(row)` writes the audit row.
     */
    async upload({ boardId, req, rateKey, userId = null, authorize, onCreated = () => undefined }) {
      authorize();
      const bytes = await readBytes(req, store.limits.maxBytes);
      authorize();
      if (!limiter.take(rateKey, bytes.length)) throw new AssetError(429, 'rate_limited', 'Too many uploads. Wait a minute and try again.');
      const { row, created } = store.put({ boardId, bytes, declaredType: req.headers['content-type'], userId });
      if (created) onCreated(row);
      return [created ? 201 : 200, view(row)];
    },

    claim({ boardId, body, mayReadFrom, userId = null, authorize, onCreated = () => undefined }) {
      authorize();
      const hash = typeof body?.hash === 'string' ? body.hash : '';
      if (!HASH_RE.test(hash)) throw new AssetError(400, 'bad_request', 'hash must be 64 hexadecimal characters');
      const result = store.claim({ boardId, hash, mayReadFrom, userId });
      if (!result) throw new AssetError(404, 'not_found', 'Not found');
      if (result.created) onCreated(result.row);
      return [200, view(result.row)];
    },

    /** The bytes, or 304 when the browser already has them (the hash is the version). */
    get({ boardId, hash, req }) {
      const found = store.read(boardId, hash);
      if (!found) throw new AssetError(404, 'not_found', 'Not found');
      const headers = assetHeaders(found.row);
      if (req.headers['if-none-match'] === headers.etag) {
        const { 'content-length': _length, 'content-type': _type, ...kept } = headers;
        return [304, undefined, kept];
      }
      return [200, found.bytes, headers];
    },

    head({ boardId, hash }) {
      const row = store.stat(boardId, hash);
      if (!row) throw new AssetError(404, 'not_found', 'Not found');
      return [200, undefined, assetHeaders(row)];
    },
  };
}

// ---------------------------------------------------------------- open mode

const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_PATH_RE = /^\/api\/boards\/([^/]+)\/assets(?:\/([^/]+))?$/;
const MAX_JSON = 4 * 1024;

/**
 * Open mode has no accounts: anyone who can reach the relay and knows a board id may add to and read that board, as
 * they may edit it. The quotas and the rate limit are the only limits. A write needs the x-tabula header, which a web
 * page on another origin cannot send without a preflight the relay never answers.
 */
export function createOpenAssetRoutes({ handlers, clientIp }) {
  const sendJson = (res, status, body, extra) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(payload);
  };
  const reply = (res, [status, body, headers = {}], head = false) => {
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, headers);
      res.end(head ? undefined : body);
    } else if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
    } else {
      sendJson(res, status, body, headers);
    }
  };

  async function readSmallJson(req) {
    const bytes = await readBytes(req, MAX_JSON);
    try {
      const data = JSON.parse(bytes.toString('utf8') || '{}');
      return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {};
    } catch {
      throw new AssetError(400, 'bad_request', 'The request body is not valid JSON');
    }
  }

  /** Answers the request and returns true when the path is an asset path, false to let the caller go on. */
  return async function handle(req, res, url) {
    const m = ASSET_PATH_RE.exec(url.pathname);
    if (!m) return false;
    try {
      let boardId;
      let tail;
      try {
        boardId = decodeURIComponent(m[1]);
        tail = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
      } catch {
        throw new AssetError(400, 'bad_request', 'Malformed URL');
      }
      if (!BOARD_ID_RE.test(boardId)) throw new AssetError(404, 'not_found', 'Not found');
      const method = String(req.method).toUpperCase();
      const authorize = () => undefined;
      const rateKey = clientIp(req);
      if (tail === undefined) {
        if (method !== 'POST') throw new AssetError(405, 'method_not_allowed', 'Method not allowed');
        if (req.headers['x-tabula'] !== '1') throw new AssetError(403, 'csrf', 'Missing or invalid CSRF protection header');
        reply(res, await handlers.upload({ boardId, req, rateKey, authorize }));
      } else if (tail === 'claim') {
        if (method !== 'POST') throw new AssetError(405, 'method_not_allowed', 'Method not allowed');
        if (req.headers['x-tabula'] !== '1') throw new AssetError(403, 'csrf', 'Missing or invalid CSRF protection header');
        // with no accounts, whoever may read one board may read them all
        reply(res, handlers.claim({ boardId, body: await readSmallJson(req), mayReadFrom: () => true, authorize }));
      } else if (method === 'GET' || method === 'HEAD') {
        if (!HASH_RE.test(tail)) throw new AssetError(404, 'not_found', 'Not found');
        reply(res, method === 'HEAD' ? handlers.head({ boardId, hash: tail }) : handlers.get({ boardId, hash: tail, req }), method === 'HEAD');
      } else {
        throw new AssetError(405, 'method_not_allowed', 'Method not allowed');
      }
    } catch (err) {
      if (!(err instanceof AssetError)) throw err;
      if (res.headersSent) {
        res.end();
        return true;
      }
      sendJson(res, err.status, { error: err.code, message: err.message }, err.status === 413 ? { connection: 'close' } : err.status === 405 ? { allow: 'GET, HEAD, POST' } : undefined);
    }
    return true;
  };
}
