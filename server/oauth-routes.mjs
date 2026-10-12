// OAuth metadata, client registration, authorization, token and revocation endpoints.
import net from 'node:net';
import { clientIpOf } from './client-ip.mjs';
import { createClientAwareLimiter, createWindowLimiter } from './limiter.mjs';
import { MAX_OAUTH_CLIENTS, OAUTH_SCOPES, oauthClientFingerprint, redirectUriRegistered } from './oauth.mjs';

const BODY_LIMIT = 8 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const CLIENT_IP_NEW_LIMIT = 10;
const INSTANCE_NEW_LIMIT = 100;
const AUTHORIZE_LIMIT = 30;
const TOKEN_LIMIT = 30;
const TOKEN_FAILURE_LIMIT = 10;
const REVOKE_LIMIT = 30;
const REFRESH_GRANT_LIMIT = 30;
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
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
      || a === 100 && b >= 64 && b <= 127
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 0 || b === 168 || b === 88 && host.split('.')[2] === '99')
      || a === 198 && (b === 18 || b === 19 || b === 51)
      || a === 203 && b === 0 && host.split('.')[2] === '113'
      || a >= 224;
  }
  if (family === 6) {
    const lower = host.toLowerCase();
    return lower === '::' || lower === '::1' || lower.startsWith('::ffff:')
      || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^fec[0-9a-f]:/.test(lower)
      || lower.startsWith('ff') || lower.startsWith('2001:db8:');
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

const scopeRank = (scope) => OAUTH_SCOPES.indexOf(scope) + 1;

function parseSingleScope(value) {
  if (value === undefined) return { scope: undefined };
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  const parts = value.split(/\s+/u);
  if (parts.length !== 1 || !OAUTH_SCOPES.includes(parts[0])) return null;
  return { scope: parts[0] };
}

async function parseTokenBody(req) {
  const contentType = String(req.headers['content-type'] ?? '').trim();
  const isJson = /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
  const isForm = /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
  if (!isJson && !isForm) return { error: 'unsupported_media_type' };
  const read = await readBody(req);
  if (read.tooLarge) return { error: 'payload_too_large' };
  if (isJson) {
    let body;
    try {
      body = JSON.parse(read.body);
    } catch {
      return { error: 'invalid_request' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_request' };
    return { body };
  }
  const params = new URLSearchParams(read.body);
  const body = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(body, key)) return { error: 'invalid_request' };
    body[key] = value;
  }
  return { body };
}

function errorPage(res, status = 400, extraHeaders = {}) {
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Request could not be completed</title><body><main><h1>Request could not be completed</h1><p>Check the request and try again.</p></main></body></html>';
  res.writeHead(status, {
    ...NO_STORE,
    ...extraHeaders,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  res.end(html);
}

function redirectUrl(redirectUri, fields, issuer) {
  const target = new URL(redirectUri);
  const params = target.searchParams;
  for (const key of ['code', 'error', 'error_description', 'state', 'iss']) params.delete(key);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  params.set('iss', issuer);
  target.search = params.toString();
  return target.href;
}

function redirectError(res, redirectUri, issuer, error, description, state) {
  const location = redirectUrl(redirectUri, { error, error_description: description, state }, issuer);
  res.writeHead(302, {
    ...NO_STORE,
    location,
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  res.end();
}

export function createOAuthRoutes({ config, directory, now = Date.now }) {
  if (!config?.mcp?.oauth || config.mcp.mode !== 'accounts' || !directory) throw new TypeError('OAuth routes need accounts mode with OAuth enabled');
  const oauthConfig = config.mcp;
  const issuer = oauthConfig.issuer;
  const ipRegistrations = createWindowLimiter(CLIENT_IP_NEW_LIMIT, now, HOUR_MS);
  const instanceRegistrations = createWindowLimiter(INSTANCE_NEW_LIMIT, now, HOUR_MS);
  const metadataIp = createWindowLimiter(120, now);
  const authorizeLimits = createClientAwareLimiter(AUTHORIZE_LIMIT, now);
  const tokenLimits = createClientAwareLimiter(TOKEN_LIMIT, now);
  const tokenFailureLimits = createClientAwareLimiter(TOKEN_FAILURE_LIMIT, now);
  const refreshGrantLimits = createWindowLimiter(REFRESH_GRANT_LIMIT, now);
  const revokeLimits = createClientAwareLimiter(REVOKE_LIMIT, now);
  const clientIp = (req) => clientIpOf(req, config);
  const resource = `${issuer}/mcp`;

  function auditReuse(grantId, kind) {
    const grant = directory.getGrant(grantId);
    if (!grant) return;
    directory.audit(null, 'mcp.oauth.reuse_detected', {
      grantId: grant.id,
      clientName: String(grant.clientName ?? '').slice(0, 60),
      userId: grant.userId,
      kind,
    });
  }

  function limited(res, wait, description = 'Too many requests. Try again later.') {
    return json(res, 429, { error: 'temporarily_unavailable', error_description: description }, { ...NO_STORE, 'retry-after': String(wait) });
  }

  function errorDescription(error) {
    return {
      invalid_client: 'The client is not registered.',
      invalid_grant: 'The grant is invalid.',
      invalid_scope: 'The requested scope is not permitted.',
      invalid_target: 'The resource is not supported.',
      invalid_request: 'The request is not valid.',
      unsupported_grant_type: 'The grant type is not supported.',
    }[error] ?? 'The request could not be completed.';
  }

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
    service_documentation: `${issuer}/docs/ai-tools/`,
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
        clientName: result.client.name.slice(0, 60),
        redirectHosts,
      });
    }
    existing = result.client;
    return json(res, 201, registrationResponse(existing, registration));
  }

  function authorize(req, res, url) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');

    const params = url.searchParams;
    const clientValues = params.getAll('client_id');
    const redirectValues = params.getAll('redirect_uri');
    const clientId = clientValues.length === 1 ? clientValues[0] : null;
    const client = clientId ? directory.getClient(clientId, now()) : null;
    const ip = clientIp(req);
    const wait = authorizeLimits.hit(ip, client?.clientId ?? null);
    if (wait) return errorPage(res, 429, { 'retry-after': String(wait) });

    // The browser is sent nowhere until both identifiers have passed the registry check.
    if (!client || clientValues.length !== 1 || redirectValues.length !== 1
      || !redirectUriRegistered(redirectValues[0], client.redirectUris)) return errorPage(res, 400);

    const redirectUri = redirectValues[0];
    const stateValues = params.getAll('state');
    const state = stateValues.length === 1 && [...stateValues[0]].length <= 512 ? stateValues[0] : null;
    const fail = (error, description) => redirectError(res, redirectUri, issuer, error, description, state);
    const allowed = new Set(['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']);
    const keys = [...params.keys()];
    const hasDuplicate = keys.some((key) => params.getAll(key).length > 1);
    const unknownParameter = keys.some((key) => !allowed.has(key));
    const responseTypes = params.getAll('response_type');
    if (responseTypes.length === 1 && responseTypes[0] !== 'code') {
      return fail('unsupported_response_type', 'Only the authorization code response type is supported.');
    }
    if (hasDuplicate || unknownParameter || responseTypes.length !== 1
      || !params.has('code_challenge') || !params.has('code_challenge_method')
      || stateValues.length > 1 || (params.has('state') && state === null)) {
      return fail('invalid_request', 'The authorization request is not valid.');
    }

    const challenge = params.get('code_challenge');
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9._~-]{43}$/.test(challenge ?? '')) {
      return fail('invalid_request', 'A valid S256 code challenge is required.');
    }

    let offeredScope;
    if (!params.has('scope')) {
      offeredScope = OAUTH_SCOPES.filter((scope) => scopeRank(scope) <= scopeRank(client.maxScope)).join(' ');
    } else {
      const rawScope = params.get('scope');
      const scopes = typeof rawScope === 'string' && rawScope.trim() ? rawScope.trim().split(/\s+/u) : [];
      if (!scopes.length || new Set(scopes).size !== scopes.length || scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) {
        return fail('invalid_scope', 'The requested scope is not supported.');
      }
      const maximum = scopes.reduce((max, scope) => scopeRank(scope) > scopeRank(max) ? scope : max, 'read');
      if (scopeRank(maximum) > scopeRank(client.maxScope)) return fail('invalid_scope', 'The requested scope is not supported.');
      offeredScope = [...scopes].sort((a, b) => scopeRank(a) - scopeRank(b)).join(' ');
    }

    const requestedResource = params.get('resource');
    if (requestedResource !== null && requestedResource !== resource) {
      return fail('invalid_target', 'The requested resource is not supported.');
    }

    const nowAt = now();
    const envelope = directory.signRequest({
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope: offeredScope,
      resource,
    }, nowAt);
    const consent = new URL(issuer);
    consent.hash = `/oauth/consent?${new URLSearchParams({ request: envelope })}`;
    res.writeHead(302, {
      ...NO_STORE,
      location: consent.href,
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    res.end();
  }

  async function token(req, res) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const parsed = await parseTokenBody(req);
    if (parsed.error === 'unsupported_media_type') return json(res, 415, { error: 'invalid_request', error_description: 'Use JSON or URL-encoded form data.' });
    if (parsed.error === 'payload_too_large') return json(res, 413, { error: 'invalid_request', error_description: 'The request body is too large.' });
    if (parsed.error) return json(res, 400, { error: 'invalid_request', error_description: errorDescription('invalid_request') });

    const body = parsed.body;
    const clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
    const ip = clientIp(req);
    const wait = tokenLimits.hit(ip, clientId);
    if (wait) return limited(res, wait);
    const fail = (error, status = 400) => {
      if (error === 'invalid_client' || error === 'invalid_grant') {
        const failureWait = tokenFailureLimits.hit(ip, clientId);
        if (failureWait) return limited(res, failureWait, 'Too many failed token requests. Try again later.');
      }
      return json(res, status, { error, error_description: errorDescription(error) });
    };

    const client = clientId ? directory.getClient(clientId, now()) : null;
    if (!client) return fail('invalid_client', 401);
    if (typeof body.grant_type !== 'string') return fail('invalid_request');
    const scope = parseSingleScope(body.scope);
    if (!scope) return fail('invalid_scope');
    if (body.resource !== undefined && (typeof body.resource !== 'string' || body.resource !== resource)) return fail('invalid_target');

    let result;
    let reuseKind = null;
    if (body.grant_type === 'authorization_code') {
      result = directory.redeemCode({
        code: body.code,
        clientId,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        scope: scope.scope,
        resource: body.resource,
        expectedResource: resource,
        now: now(),
      });
      if (result?.error === 'reuse') reuseKind = 'code';
    } else if (body.grant_type === 'refresh_token') {
      const grant = directory.findRefreshGrant(body.refresh_token);
      if (grant) {
        const grantWait = refreshGrantLimits.hit(grant.grantId);
        if (grantWait) return limited(res, grantWait, 'Too many refresh attempts for this grant. Try again later.');
      }
      result = directory.refresh({
        refreshToken: body.refresh_token,
        clientId,
        scope: scope.scope,
        resource: body.resource,
        expectedResource: resource,
        now: now(),
      });
      if (result?.error === 'reuse') reuseKind = 'refresh';
    } else {
      return fail('unsupported_grant_type');
    }

    if (reuseKind && result.grantId) auditReuse(result.grantId, reuseKind);
    if (result?.error) return fail(result.error === 'reuse' ? 'invalid_grant' : result.error, result.error === 'invalid_client' ? 401 : 400);
    if (!result || typeof result.accessToken !== 'string' || typeof result.refreshToken !== 'string') return fail('invalid_grant');
    return json(res, 200, {
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: result.scope,
    });
  }

  async function revoke(req, res) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const parsed = await parseTokenBody(req);
    if (parsed.error === 'unsupported_media_type') return json(res, 415, { error: 'invalid_request', error_description: 'Use JSON or URL-encoded form data.' });
    if (parsed.error === 'payload_too_large') return json(res, 413, { error: 'invalid_request', error_description: 'The request body is too large.' });
    if (parsed.error) return json(res, 400, { error: 'invalid_request', error_description: errorDescription('invalid_request') });
    const body = parsed.body;
    const clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
    const wait = revokeLimits.hit(clientIp(req), clientId);
    if (wait) return limited(res, wait);
    if (!clientId || !directory.getClient(clientId, now())) return json(res, 401, { error: 'invalid_client', error_description: errorDescription('invalid_client') });
    if (typeof body.token !== 'string') return json(res, 400, { error: 'invalid_request', error_description: errorDescription('invalid_request') });
    const revoked = directory.revokeToken(body.token, clientId, now());
    if (revoked) {
      directory.audit(null, 'mcp.oauth.revoke', {
        grantId: revoked.grantId,
        clientName: String(revoked.clientName ?? '').slice(0, 60),
        userId: revoked.userId,
        by: 'client',
      });
    }
    res.writeHead(200, NO_STORE);
    res.end();
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
    if (path === '/oauth/authorize') return authorize(req, res, url);
    if (path === '/oauth/token') return token(req, res);
    if (path === '/oauth/revoke') return revoke(req, res);
    return notFound(res);
  }

  return { handle };
}
