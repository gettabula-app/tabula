// The Anthropic provider (docs/ai.md, "Anthropic (v1)"). The SDK is loaded on first use, so an instance that never
// runs an AI feature never loads it. A raw SDK error can carry the request headers (the key among them), so every
// error leaves this module as a fresh AiError built from a code, never as the SDK error or its message.

import { AiError } from './errors.mjs';

export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const EFFORTS = ['low', 'medium', 'high'];

const VERIFY_TIMEOUT_MS = 5000;
const MAX_OUTPUT_TOKENS = 64_000;
// one progress event per this many streamed deltas (and one for the first), so a long answer is not a flood
const PROGRESS_EVERY = 20;
const RETRY_AFTER_MAX_S = 3600;

// SERVER-SIDE FALLBACKS. The `fallbacks` request field exists only on the SDK's beta messages client, and it is the one
// reason this provider touches the beta API. With `fallbacks: 'default'` and this beta header a request that Claude
// Opus 5.5 or Claude Sonnet 5.5 declines for policy reasons is retried on a suitable model inside the same call, and the
// model that answered is reported in `usage.model`. Claude Haiku 5.5 has no fallback, so it uses the plain client.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

let sdk = null;
const loadSdk = async () => (sdk ??= (await import('@anthropic-ai/sdk')).default);

function retryAfterOf(err) {
  const headers = err?.headers;
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), RETRY_AFTER_MAX_S) : null;
}

/** Maps anything thrown by the SDK to a fresh AiError. Nothing of the original (message, headers, body) is kept. */
const PROXY_ERROR_STATUS = Object.freeze({
  credits_exhausted: 429,
  credits_not_included: 403,
  rate_limited: 429,
  model_not_allowed: 400,
  max_tokens_too_large: 400,
  request_too_large: 413,
  ai_unavailable: 503,
});

async function toAiError(err, { proxyErrors = false, apiKey = '' } = {}) {
  if (err instanceof AiError) return err;
  const Anthropic = await loadSdk();
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') return new AiError('ai_aborted');
  if (proxyErrors) {
    const detail = err?.error?.error;
    if (detail && typeof detail.type === 'string' && Object.hasOwn(PROXY_ERROR_STATUS, detail.type) && typeof detail.message === 'string') {
      const code = /** @type {keyof typeof PROXY_ERROR_STATUS} */ (detail.type);
      const message = apiKey ? detail.message.split(apiKey).join('[redacted]') : detail.message;
      return new AiError(code, {
        message,
        status: PROXY_ERROR_STATUS[code],
        retryAfter: code === 'rate_limited' ? retryAfterOf(err) : null,
      });
    }
    // The configured proxy owns all provider errors. Unknown shapes must not leak their body or be mistaken for a key error.
    return new AiError('ai_unavailable', { status: 503 });
  }
  if (err instanceof Anthropic.APIConnectionError) return new AiError('ai_unavailable');
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status === 401 || status === 403) return new AiError('ai_key_invalid');
  if (status === 429) return new AiError('ai_rate_limited', { retryAfter: retryAfterOf(err) });
  if (status === 408 || status >= 500) return new AiError('ai_unavailable');
  return new AiError('internal');
}

/** Rejects when `signal` aborts even if the client ignores it. */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function checkRequest(req) {
  const ok =
    req !== null && typeof req === 'object' &&
    MODELS.includes(req.model) &&
    typeof req.system === 'string' && req.system !== '' &&
    typeof req.content === 'string' &&
    typeof req.schema === 'object' && req.schema !== null &&
    EFFORTS.includes(req.effort) &&
    Number.isInteger(req.maxTokens) && req.maxTokens >= 1 && req.maxTokens <= MAX_OUTPUT_TOKENS;
  if (!ok) throw new AiError('internal');
}

/** One streaming request. The only place that chooses between the plain and the beta (fallback) client. */
function openStream(client, req) {
  const params = {
    model: req.model,
    max_tokens: req.maxTokens,
    // the frozen system prompt comes first and is cached, so repeated runs of a feature share a prefix
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: req.content }],
    output_config: { format: { type: 'json_schema', schema: req.schema }, effort: req.effort },
  };
  const options = req.signal ? { signal: req.signal } : {};
  if (FALLBACK_MODELS.has(req.model)) {
    return client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, options);
  }
  return client.messages.stream(params, options);
}

function usageOf(message, req) {
  const u = message.usage ?? {};
  return {
    model: typeof message.model === 'string' ? message.model : req.model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * @param {{ apiKey: string, baseUrl?: string | null, client?: any, verifyTimeoutMs?: number, proxyErrors?: boolean, maxRetries?: number }} options
 * `client` is for tests: an object shaped like the SDK client.
 */
export function createAnthropicProvider({ apiKey, baseUrl = null, client = null, verifyTimeoutMs = VERIFY_TIMEOUT_MS, proxyErrors = false, maxRetries }) {
  let made = client;
  const getClient = async () => {
    if (!made) {
      const Anthropic = await loadSdk();
      made = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}), ...(maxRetries === undefined ? {} : { maxRetries }) });
    }
    return made;
  };

  return {
    kind: 'anthropic',
    models: () => [...MODELS],

    /** Resolves when the provider accepts the key; throws an AiError otherwise (a cheap call with a short timeout). */
    async verify(signal) {
      const timeout = AbortSignal.timeout(verifyTimeoutMs);
      const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        const c = await getClient();
        await abortable(c.models.list({ limit: 1 }, { signal: stop, timeout: verifyTimeoutMs, maxRetries: 0 }), stop);
      } catch (err) {
        if (timeout.aborted && !signal?.aborted) throw new AiError('ai_unavailable');
        throw await toAiError(err, { proxyErrors, apiKey });
      }
    },

    async *run(req) {
      checkRequest(req);
      if (req.signal?.aborted) throw new AiError('ai_aborted');
      let stream = null;
      let finished = false;
      try {
        stream = openStream(await getClient(), req);
        let deltas = 0;
        for await (const event of stream) {
          if (event?.type === 'content_block_delta' && deltas++ % PROGRESS_EVERY === 0) yield { type: 'progress' };
        }
        const message = await stream.finalMessage();
        finished = true;

        // a policy decline is a normal answer with this stop reason; read nothing else from it
        if (message.stop_reason === 'refusal') {
          yield { type: 'refused', category: message.stop_details?.category ?? null };
          return;
        }
        if (message.stop_reason === 'max_tokens') throw new AiError('internal');
        const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          throw new AiError('internal');
        }
        yield { type: 'result', value, usage: usageOf(message, req) };
      } catch (err) {
        finished = true;
        throw await toAiError(err, { proxyErrors, apiKey });
      } finally {
        if (!finished) stream?.abort?.();
      }
    },
  };
}
