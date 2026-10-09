import http from 'node:http';
import https from 'node:https';
import { AiError } from './errors.mjs';
import { assertPublicLiteral, guardedLookup } from './net-guard.mjs';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 64_000;
const RETRY_AFTER_MAX_S = 3600;

function baseUrlOf(value, trusted) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid baseUrl');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid baseUrl');
  }
  if (
    (parsed.protocol !== 'https:' && !(trusted && parsed.protocol === 'http:')) ||
    !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash ||
    value.includes('?') || value.includes('#')
  ) throw new Error('Invalid baseUrl');
  const path = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + path;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return null;
}

function retryAfterOf(headers) {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const seconds = Number(raw.trim());
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= RETRY_AFTER_MAX_S ? seconds : null;
}

function statusError(status, headers) {
  if (status === 401 || status === 403) return new AiError('ai_key_invalid');
  if (status === 404) return new AiError('ai_model_invalid');
  if (status === 429) return new AiError('ai_rate_limited', { retryAfter: retryAfterOf(headers) });
  return new AiError('ai_unavailable');
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageOf(envelope, model) {
  return {
    model: typeof envelope?.model === 'string' ? envelope.model : model,
    inputTokens: numberOrZero(envelope?.usage?.prompt_tokens),
    outputTokens: numberOrZero(envelope?.usage?.completion_tokens),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function addUsage(total, usage) {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

function parseEnvelope(body) {
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Array.isArray(envelope.choices) || !envelope.choices.length) {
    return null;
  }
  return envelope;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((part) => part?.type !== 'text' || typeof part.text !== 'string')) return null;
  return content.map((part) => part.text).join('');
}

function objectFromAnswer(content, finishReason) {
  if (finishReason === 'length') return null;
  let text = textOf(content);
  if (text === null) return null;
  text = text.trim();
  const fence = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(text);
  if (fence) text = fence[1].trim();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function responseIsSuccess(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function freshFailure(error, signal) {
  if (error instanceof AiError) {
    const retryAfter = error.code === 'ai_rate_limited' &&
      Number.isInteger(error.retryAfter) && error.retryAfter >= 1 && error.retryAfter <= RETRY_AFTER_MAX_S
      ? error.retryAfter
      : null;
    return new AiError(error.code, { retryAfter });
  }
  return new AiError(signal?.aborted ? 'ai_aborted' : 'ai_unavailable');
}

/**
 * A bounded, non-redirecting HTTP transport for compatible chat APIs.
 * Only the authorization header is accepted from the provider; cookies are never copied.
 */
export function httpsTransport({
  url,
  method,
  headers = {},
  body,
  signal,
  maxBytes = DEFAULT_MAX_BYTES,
  trusted = false,
  timeoutMs = 30_000,
  lookup,
}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && !(trusted && target.protocol === 'http:')) {
    return Promise.reject(new Error('Unsupported transport protocol'));
  }
  if (!trusted) assertPublicLiteral(target.hostname);
  const client = target.protocol === 'http:' ? http : https;
  const requestHeaders = {
    accept: 'application/json',
    'user-agent': 'tabula-ai/1',
  };
  if (body !== undefined && body !== null) requestHeaders['content-type'] = 'application/json';
  const authorization = headerValue(headers, 'authorization');
  if (authorization !== null) requestHeaders.authorization = authorization;
  const byteLimit = Number.isInteger(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer;
    const controller = new AbortController();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      controller.abort();
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      finish(reject, error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      const error = new Error('Request timed out');
      error.code = 'ETIMEDOUT';
      finish(reject, error);
    }, Math.max(1, timeoutMs));
    timer.unref?.();

    const requestOptions = { method, headers: requestHeaders, signal: controller.signal };
    if (!trusted) requestOptions.lookup = guardedLookup({ lookup });
    const request = client.request(target, requestOptions, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > byteLimit) {
          const error = new Error('Response exceeded size limit');
          error.code = 'EMAXSIZE';
          finish(reject, error);
          controller.abort();
          response.destroy();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const responseHeaders = Object.fromEntries(
          Object.entries(response.headers).map(([name, value]) => [
            name.toLowerCase(),
            Array.isArray(value) ? value.join(', ') : String(value ?? ''),
          ]),
        );
        finish(resolve, {
          status: response.statusCode ?? 0,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', (error) => finish(reject, error));
      response.on('aborted', () => finish(reject, new Error('Response ended early')));
    });
    request.on('error', (error) => {
      if (timedOut && !signal?.aborted) {
        const timeoutError = new Error('Request timed out');
        timeoutError.code = 'ETIMEDOUT';
        finish(reject, timeoutError);
      } else finish(reject, error);
    });
    request.end(body === undefined || body === null ? undefined : body);
  });
}

function checkedRequest(req) {
  return req !== null && typeof req === 'object' &&
    typeof req.model === 'string' && req.model.length > 0 &&
    typeof req.system === 'string' && typeof req.content === 'string' &&
    req.schema !== null && typeof req.schema === 'object' && !Array.isArray(req.schema) &&
    Number.isInteger(req.maxTokens) && req.maxTokens >= 1 && req.maxTokens <= MAX_OUTPUT_TOKENS;
}

/**
 * @param {{ apiKey: string, baseUrl: string, model: string, trusted?: boolean, transport?: Function,
 *   verifyTimeoutMs?: number, requestTimeoutMs?: number, lookup?: Function }} options
 */
export function createOpenAiCompatibleProvider({
  apiKey,
  baseUrl,
  model,
  trusted = false,
  transport = httpsTransport,
  verifyTimeoutMs = 8000,
  requestTimeoutMs = 30_000,
  lookup,
}) {
  const base = baseUrlOf(baseUrl, trusted);
  const keyText = typeof apiKey === 'string' ? apiKey : '';
  const containsApiKey = (value) => keyText.length > 0 && typeof value === 'string' && value.includes(keyText);
  if (containsApiKey(model)) throw new Error('Invalid model');

  async function send(path, method, requestBody, signal, timeoutMs) {
    const target = base + '/' + path;
    try {
      return await transport({
        url: target,
        method,
        headers: { authorization: 'Bearer ' + apiKey },
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        signal,
        maxBytes: DEFAULT_MAX_BYTES,
        trusted,
        timeoutMs,
        lookup,
      });
    } catch (err) {
      if (signal?.aborted) throw new AiError('ai_aborted');
      // a slow model is not an unavailable provider: the person is told to wait, or to pick a faster model
      throw new AiError(err?.code === 'ETIMEDOUT' ? 'ai_timeout' : 'ai_unavailable');
    }
  }

  function checkStatus(response) {
    if (!response || typeof response !== 'object') throw new AiError('ai_unavailable');
    if (!responseIsSuccess(response.status)) throw statusError(response.status, response.headers);
  }

  return {
    kind: 'openai-compatible',
    models: () => [model],

    /**
     * Two checks. /models answers whether the key is accepted (a server without it answers 404, 405 or 501, and the second
     * check then carries the key alone). Then one 1-token completion with the configured model, because a catalogue can list
     * models that do not answer: a 404 there is `ai_model_invalid`, and a model that takes too long is `ai_timeout`.
     */
    async verify(signal) {
      if (signal?.aborted) throw new AiError('ai_aborted');
      try {
        const models = await send('models', 'GET', undefined, signal, verifyTimeoutMs);
        if (!models || ![404, 405, 501].includes(models.status)) checkStatus(models);
        const completion = await send('chat/completions', 'POST', {
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }, signal, requestTimeoutMs);
        // a server that rejects the request as malformed usually does not know the model either
        if (completion?.status === 400 || completion?.status === 422) throw new AiError('ai_model_invalid');
        checkStatus(completion);
      } catch (error) {
        throw freshFailure(error, signal);
      }
    },

    async *run(req) {
      if (!checkedRequest(req)) throw new AiError('internal');
      if (req.signal?.aborted) throw new AiError('ai_aborted');
      let schema;
      try {
        schema = JSON.stringify(req.schema);
      } catch {
        throw new AiError('internal');
      }
      if (typeof schema !== 'string') throw new AiError('internal');
      yield { type: 'progress' };

      try {
        const system = req.system + '\n\nReply with a single JSON object that matches this JSON Schema, and nothing else:\n' + schema;
        const initialBody = {
          model: req.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: req.content }],
          max_tokens: req.maxTokens,
          temperature: 0,
          response_format: { type: 'json_object' },
        };
        let requestBody = initialBody;
        let attempts = 0;
        const totalUsage = { inputTokens: 0, outputTokens: 0 };

        while (attempts < 2) {
          const response = await send('chat/completions', 'POST', requestBody, req.signal, requestTimeoutMs);
          attempts += 1;
          if (attempts === 1 && (response.status === 400 || response.status === 422)) {
            const { response_format: _responseFormat, ...withoutFormat } = requestBody;
            requestBody = withoutFormat;
            continue;
          }
          checkStatus(response);

          const envelope = parseEnvelope(response.body);
          if (!envelope) throw new AiError('ai_bad_output');
          const usage = usageOf(envelope, req.model);
          addUsage(totalUsage, usage);
          const choice = envelope.choices[0];
          const message = choice?.message;
          if (choice?.finish_reason === 'content_filter' || (typeof message?.refusal === 'string' && message.refusal.length > 0)) {
            yield { type: 'refused', category: null };
            return;
          }

          const value = objectFromAnswer(message?.content, choice?.finish_reason);
          if (value === null) {
            if (attempts < 2) {
              requestBody = {
                ...requestBody,
                messages: [
                  ...requestBody.messages,
                  { role: 'user', content: 'Your previous reply was not valid JSON. Reply again with only the JSON object.' },
                ],
              };
              continue;
            }
            throw new AiError('ai_bad_output');
          }

          const answerText = JSON.stringify(value);
          const answerModel = typeof envelope.model === 'string' ? envelope.model : req.model;
          if (containsApiKey(answerText) || containsApiKey(answerModel)) throw new AiError('ai_bad_output');

          yield {
            type: 'result',
            value,
            usage: {
              model: answerModel,
              inputTokens: totalUsage.inputTokens,
              outputTokens: totalUsage.outputTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
          return;
        }
        throw new AiError('ai_bad_output');
      } catch (error) {
        throw freshFailure(error, req.signal);
      }
    },
  };
}
