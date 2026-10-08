// Errors and log hygiene of the AI layer (docs/ai.md). An AiError carries a code and a fixed, safe message; nothing in
// it comes from a provider response, a request header, the key or board text. Raw provider (SDK) errors never leave
// the provider module, because they can carry the request headers.

/** The HTTP status each code answers with. */
export const AI_STATUS = {
  ai_unconfigured: 409,
  ai_key_invalid: 400,
  ai_key_unreadable: 409,
  ai_rate_limited: 429,
  ai_unavailable: 502,
  ai_aborted: 499,
  ai_timeout: 504,
  ai_refused: 422,
  ai_invalid_proposal: 502,
  forbidden: 403,
  internal: 500,
};

const MESSAGES = {
  ai_unconfigured: 'AI keys cannot be saved because this server has no TABULA_AI_SECRET',
  ai_key_invalid: 'The provider did not accept this key',
  ai_key_unreadable: 'The saved key cannot be read with the current TABULA_AI_SECRET. Enter it again.',
  ai_rate_limited: 'The provider is rate limiting this key. Try again later.',
  ai_unavailable: 'The provider is not available right now. Try again later.',
  ai_aborted: 'The request was cancelled',
  ai_timeout: 'The AI took too long and was stopped. Nothing was changed.',
  ai_refused: 'The AI declined this request. Nothing was changed.',
  ai_invalid_proposal: 'The AI answer could not be used. Nothing was changed.',
  forbidden: 'You no longer have permission to do that',
  internal: 'Something went wrong',
};

export class AiError extends Error {
  /** @param {keyof typeof AI_STATUS} code @param {{ retryAfter?: number | null }} [extra] */
  constructor(code, { retryAfter = null } = {}) {
    super(MESSAGES[code] ?? MESSAGES.internal);
    this.name = 'AiError';
    this.code = code in AI_STATUS ? code : 'internal';
    this.status = AI_STATUS[this.code];
    this.retryAfter = retryAfter;
  }
}

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'set-cookie']);
const SENSITIVE_FIELD_RE = /^(api[-_]?key|authorization|x-api-key|secret|password|token)$/i;
const REDACTED = '[redacted]';
// anything shaped like a provider key or a credential header, for text that was not built by us
const KEY_LIKE_RE = /\bsk-[A-Za-z0-9_-]{6,}/g;
const BEARER_RE = /\bBearer\s+[^\s"',;]+/gi;
const HEADER_LINE_RE = /\b(x-api-key|authorization|cookie)\s*[:=]\s*[^\s"',;}]+/gi;

/** A copy of request headers (a plain object or a Headers) that is safe to log. */
export function redactHeaders(headers) {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers ?? {});
  return Object.fromEntries(entries.map(([name, value]) => [name, SENSITIVE_HEADERS.has(String(name).toLowerCase()) ? REDACTED : value]));
}

/** A copy of a request body (any depth) with the key fields blanked, safe to log. */
export function redactBody(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactBody(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_FIELD_RE.test(k) ? REDACTED : redactBody(v, depth + 1)]));
}

/** Text with anything that looks like a key or a credential header blanked. */
export function scrubText(text) {
  return String(text ?? '').replace(KEY_LIKE_RE, REDACTED).replace(BEARER_RE, `Bearer ${REDACTED}`).replace(HEADER_LINE_RE, `$1: ${REDACTED}`);
}

// An SDK error has the response headers, and a request id; its message can echo parts of the request.
const looksLikeProviderError = (err) =>
  typeof err === 'object' && err !== null && ('headers' in err || 'requestID' in err || 'request_id' in err || ('error' in err && 'status' in err));

/**
 * What to write to a log for any error: for an AI or provider error only its name, code and status, for anything
 * else its stack with key-like text blanked. Never the error object itself, whose properties may hold headers.
 */
export function describeError(err) {
  if (err instanceof AiError || looksLikeProviderError(err)) {
    const code = typeof err.code === 'string' ? err.code : undefined;
    const status = typeof err.status === 'number' ? err.status : undefined;
    return [err.name || 'Error', code && `code=${code}`, status !== undefined && `status=${status}`].filter(Boolean).join(' ');
  }
  return scrubText(err instanceof Error ? (err.stack ?? err.message) : err);
}
