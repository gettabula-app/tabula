// createProvider({ kind, apiKey, baseUrl?, model?, trusted?, client? }) -> Provider (docs/ai.md, "Provider layer"). The kinds
// are Anthropic and any OpenAI-compatible server (TAB-222). A provider has `kind`, `models()`, `verify(signal)` (resolves when
// the key is accepted) and `run(req)` (an async iterator of `progress`, then one `result` or `refused`). Every failure is an
// AiError (./errors.mjs).

import { createAnthropicProvider } from './anthropic.mjs';
import { createOpenAiCompatibleProvider } from './openai-compatible.mjs';

export const PROVIDERS = ['anthropic', 'openai-compatible'];

/**
 * `model` and `trusted` are for the OpenAI-compatible kind: the model id the key was saved with, and whether the address comes
 * from the operator's environment (http and a local address allowed) rather than from a key screen.
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
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('baseUrl must be an https:// URL without credentials');
  }
  return createAnthropicProvider({ apiKey, baseUrl, client, ...rest });
}
