// createProvider({ kind, apiKey, baseUrl?, client? }) -> Provider (docs/ai.md, "Provider layer"). Anthropic is the only
// kind in v1. A provider has `kind`, `models()`, `verify(signal)` (resolves when the key is accepted) and `run(req)`
// (an async iterator of `progress`, then one `result` or `refused`). Every failure is an AiError (./errors.mjs).

import { createAnthropicProvider } from './anthropic.mjs';

export const PROVIDERS = ['anthropic'];

/** @param {{ kind: string, apiKey: string, baseUrl?: string | null, client?: any, verifyTimeoutMs?: number }} options */
export function createProvider({ kind, apiKey, baseUrl = null, client = null, ...rest }) {
  if (!PROVIDERS.includes(kind)) throw new Error('Unknown AI provider');
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error('An AI provider needs an API key');
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
