// createProvider({ kind, apiKey, baseUrl?, model?, trusted?, client? }) -> Provider (docs/ai.md, "Provider layer"). The kinds
// are Anthropic and any OpenAI-compatible server (TAB-222). A provider has `kind`, `models()`, `verify(signal)` (resolves when
// the key is accepted) and `run(req)` (an async iterator of `progress`, then one `result` or `refused`). Every failure is an
// AiError (./errors.mjs).

import { createAnthropicProvider } from './anthropic.mjs';
import { createOpenAiCompatibleProvider } from './openai-compatible.mjs';

export const PROVIDERS = ['anthropic', 'openai-compatible'];

/**
 * `model` and `trusted` are for the OpenAI-compatible kind, except that trusted Anthropic addresses may use loopback http in
 * tests. The trusted flag never permits a non-loopback Anthropic address over http.
 * @param {{ kind: string, apiKey: string, baseUrl?: string | null, model?: string | null, trusted?: boolean, client?: any, verifyTimeoutMs?: number }} options
 */
export function createProvider({ kind, apiKey, baseUrl = null, model = null, trusted = false, client = null, ...rest }) {
  if (!PROVIDERS.includes(kind)) throw new Error('Unknown AI provider');
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error('An AI provider needs an API key');
  if (kind === 'openai-compatible') return createOpenAiCompatibleProvider({ apiKey, baseUrl, model, trusted, ...rest });
  if (baseUrl !== null && baseUrl !== undefined) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('baseUrl is not a valid URL');
    }
    const loopbackHttp = trusted && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password) throw new Error('baseUrl must be an https:// URL without credentials');
  }
  return createAnthropicProvider({ apiKey, baseUrl, client, ...rest });
}
