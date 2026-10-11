// OAuth metadata and RFC 7591 client registration. Authorization, token and revoke
// handlers are added in the next server slice; these routes stay explicitly dark.
import net from 'node:net';
import { clientIpOf } from './client-ip.mjs';
import { createWindowLimiter } from './limiter.mjs';
import { MAX_OAUTH_CLIENTS, OAUTH_SCOPES, oauthClientFingerprint } from './oauth.mjs';

const BODY_LIMIT = 8 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const CLIENT_IP_NEW_LIMIT = 10;
const INSTANCE_NEW_LIMIT = 100;
const RESOURCE_ROOT = '/.well-known/oauth-protected-resource';
const RESOURCE_MCP = `${RESOURCE_ROOT}/mcp`;
const AUTHORIZATION_SERVER = '/.well-known/oauth-authorization-server';
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' };
const META_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=300',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

function json(res, status, body, headers = NO_STORE) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allow) {
  json(res, 405, { error: 'method_not_allowed' }, { ...NO_STORE, allow });
}

function notFound(res) {
  json(res, 404, { error: 'not_found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let tooLarge = Number(req.headers['content-length']) > BODY_LIMIT;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > BODY_LIMIT) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => resolve({ tooLarge, body: tooLarge ? null : Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
  });
}

function cleanClientName(value) {
  if (value === undefined) return 'Unnamed app';
  if (typeof value !== 'string') return null;
  const cleaned = [...value.normalize('NFC')
    .replace(/[\p{C}\u202A-\u202E\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()].slice(0, 80).join('');
  return cleaned || 'Unnamed app';
}

function parseRequestedScope(value) {
  if (value === undefined) return { scopes: OAUTH_SCOPES, response: OAUTH_SCOPES.join(' '), maxScope: 'write' };
  if (typeof value !== 'string' || !value.trim()) return null;
  const scopes = value.trim().split(/\s+/);
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) return null;
  const maxScope = scopes.reduce((max, scope) => OAUTH_SCOPES.indexOf(scope) > OAUTH_SCOPES.indexOf(max) ? scope : max, 'read');
  return { scopes, response: scopes.sort((a, b) => OAUTH_SCOPES.indexOf(a) - OAUTH_SCOPES.indexOf(b)).join(' '), maxScope };
}

function privateOrLinkLocalIp(hostname) {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168 || a >= 224;
  }
  if (family === 6) {
    const lower = host.toLowerCase();
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

function validCustomScheme(url, allowed) {
  const scheme = url.protocol.slice(0, -1);
  return allowed.includes(scheme) && !url.hostname && !url.username && !url.password;
}

function redirectKind(value, oauthConfig) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('*') || value.includes('#')) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.href !== value || url.username || url.password || url.hash) return null;
  if (url.protocol === 'https:') {
    const hostname = url.hostname;
    if (!hostname || privateOrLinkLocalIp(hostname)) return null;
    const exact = oauthConfig.redirectHosts?.includes(hostname) ?? false;
    const wildcard = oauthConfig.redirectWildcard && !oauthConfig.hosted;
    if (!exact && !wildcard) return null;
    return { kind: 'web', host: hostname, verified: exact };
  }
  if (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) {
    return { kind: 'loopback', host: url.hostname, verified: false };
  }
  if (url.protocol === 'http:' && url.hostname === 'localhost') return null;
  if (validCustomScheme(url, oauthConfig.redirectSchemes ?? [])) return { kind: 'custom', host: url.protocol.slice(0, -1), verified: false };
  return null;
}

function validateRegistration(body, oauthConfig) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_client_metadata' };
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 5
    || body.redirect_uris.some((uri) => typeof uri !== 'string') || new Set(body.redirect_uris).size !== body.redirect_uris.length) {
    return { error: 'invalid_redirect_uri' };
  }
  const name = cleanClientName(body.client_name);
  if (name === null) return { error: 'invalid_client_metadata' };
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') return { error: 'invalid_client_metadata' };
  let grantTypes = ['authorization_code', 'refresh_token'];
  if (body.grant_types !== undefined) {
    const allowed = ['authorization_code', 'refresh_token'];
    if (!Array.isArray(body.grant_types) || body.grant_types.length < 1 || new Set(body.grant_types).size !== body.grant_types.length
      || body.grant_types.some((grant) => !allowed.includes(grant)) || !body.grant_types.includes('authorization_code')) {
      return { error: 'invalid_client_metadata' };
    }
    grantTypes = [...body.grant_types];
  }
  if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== 'code')) {
    return { error: 'invalid_client_metadata' };
  }
  const requestedScope = parseRequestedScope(body.scope);
  if (!requestedScope) return { error: 'invalid_client_metadata' };

  if (oauthConfig.hosted && (!oauthConfig.redirectHosts?.length || oauthConfig.redirectWildcard)) return { error: 'invalid_redirect_uri' };
  const redirectUris = [...body.redirect_uris].sort();
  const redirects = redirectUris.map((uri) => redirectKind(uri, oauthConfig));
  if (redirects.some((result) => result === null)) return { error: 'invalid_redirect_uri' };
  return { name, redirectUris, redirects, grantTypes, scope: requestedScope };
}

function registrationResponse(client, registration) {
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: registration.grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: registration.scope.response,
  };
}

function readMetadataRequest(req, res, body) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    res.end();
    return;
  }
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET, OPTIONS');
  json(res, 200, body, META_HEADERS);
}

export function createOAuthRoutes({ config, directory, now = Date.now }) {
  if (!config?.mcp?.oauth || config.mcp.mode !== 'accounts' || !directory) throw new TypeError('OAuth routes need accounts mode with OAuth enabled');
  const oauthConfig = config.mcp;
  const issuer = oauthConfig.issuer;
  const ipRegistrations = createWindowLimiter(CLIENT_IP_NEW_LIMIT, now, HOUR_MS);
  const instanceRegistrations = createWindowLimiter(INSTANCE_NEW_LIMIT, now, HOUR_MS);
  const metadataIp = createWindowLimiter(120, now);
  const clientIp = (req) => clientIpOf(req, config);

  const resourceMetadata = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Tabula boards',
  };
  const authorizationMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/docs/mcp.html`,
  };

  async function register(req, res) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] ?? '').trim())) {
      return json(res, 415, { error: 'invalid_client_metadata', error_description: 'Content-Type must be application/json.' });
    }
    const read = await readBody(req);
    if (read.tooLarge) return json(res, 413, { error: 'invalid_client_metadata', error_description: 'The registration body is too large.' });
    let body;
    try {
      body = JSON.parse(read.body);
    } catch {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'The registration body must be valid JSON.' });
    }
    const registration = validateRegistration(body, oauthConfig);
    if (registration.error) {
      const description = registration.error === 'invalid_redirect_uri'
        ? 'One or more redirect URIs are not allowed.'
        : 'The client metadata is not valid.';
      return json(res, 400, { error: registration.error, error_description: description });
    }

    const nowAt = now();
    const fingerprint = oauthClientFingerprint(registration.name, registration.redirectUris);
    let existing = directory.getClientByFingerprint(fingerprint, nowAt);
    if (!existing) {
      directory.sweep(nowAt);
      if (directory.countClients() >= MAX_OAUTH_CLIENTS) {
        res.setHeader('retry-after', '60');
        return json(res, 429, { error: 'temporarily_unavailable', error_description: 'Client registration is temporarily unavailable.' });
      }
      const ip = clientIp(req);
      const ipWait = ipRegistrations.wait(ip);
      const instanceWait = instanceRegistrations.wait('instance');
      if (ipWait || instanceWait) {
        res.setHeader('retry-after', String(Math.max(ipWait, instanceWait)));
        return json(res, 429, { error: 'temporarily_unavailable', error_description: 'Client registration is temporarily unavailable.' });
      }
      ipRegistrations.hit(ip);
      instanceRegistrations.hit('instance');
    }

    const result = directory.registerClient({
      name: registration.name,
      redirectUris: registration.redirectUris,
      maxScope: registration.scope.maxScope,
      now: nowAt,
    });
    if (!result.client) {
      res.setHeader('retry-after', '60');
      return json(res, 429, { error: 'temporarily_unavailable', error_description: 'Client registration is temporarily unavailable.' });
    }
    if (result.created) {
      const redirectHosts = registration.redirects.map((entry) => entry.host);
      directory.audit(null, 'mcp.oauth.client_registered', {
        clientId: result.client.clientId,
        clientName: result.client.name,
        redirectHosts,
      });
    }
    existing = result.client;
    return json(res, 201, registrationResponse(existing, registration));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const metadataPath = path === RESOURCE_ROOT || path === RESOURCE_MCP || path === AUTHORIZATION_SERVER;
    const oauthPath = path === '/oauth' || path.startsWith('/oauth/');
    const wellKnownOAuthPath = path === '/.well-known/oauth' || path.startsWith('/.well-known/oauth-');
    const openidProbe = path.startsWith('/.well-known/openid-');
    if (!oauthPath && !wellKnownOAuthPath && !openidProbe) return false;

    if (metadataPath) {
      const ip = clientIp(req);
      const wait = metadataIp.hit(ip);
      if (wait) {
        res.setHeader('retry-after', String(wait));
        return json(res, 429, { error: 'temporarily_unavailable' }, { ...NO_STORE, 'retry-after': String(wait) });
      }
      if (path === AUTHORIZATION_SERVER) return readMetadataRequest(req, res, authorizationMetadata);
      return readMetadataRequest(req, res, resourceMetadata);
    }
    if (path === '/oauth/register') return register(req, res);
    return notFound(res);
  }

  return { handle };
}
