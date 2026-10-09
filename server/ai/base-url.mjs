// The base URL and the model id of an OpenAI-compatible provider (docs/ai.md, "OpenAI-compatible providers"), checked in one
// place for the key screens (a person typed them) and for the operator's environment (TABULA_AI_BASE_URL, trusted). A key
// is sent to this address, so it is a strict shape: one origin and an optional path, nothing that can hold a secret.

import { assertPublicLiteral } from './net-guard.mjs';

export const BASE_URL_MAX = 200;
export const MODEL_ID_MAX = 100;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/**
 * `{ baseUrl }` (trailing slashes cut) or `{ error }`. Untrusted (a key screen): https only and no address that is not public.
 * `trusted` (the operator's environment): http is allowed too, and so is a local address, for a model server on this machine.
 * @param {unknown} value @param {{ trusted?: boolean }} [options]
 */
export function checkBaseUrl(value, { trusted = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return { error: 'baseUrl must be a web address' };
  const text = value.trim();
  if (text.length > BASE_URL_MAX) return { error: `baseUrl must be at most ${BASE_URL_MAX} characters` };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'baseUrl must be a web address such as https://api.example.com/v1' };
  }
  const schemes = trusted ? ['https:', 'http:'] : ['https:'];
  if (!schemes.includes(url.protocol)) return { error: trusted ? 'baseUrl must start with https:// or http://' : 'baseUrl must start with https://' };
  if (url.username || url.password) return { error: 'baseUrl must not contain a user name or a password' };
  if (url.search || url.hash || text.includes('?') || text.includes('#')) return { error: 'baseUrl must not contain a query or a fragment' };
  if (!trusted) {
    try {
      assertPublicLiteral(url.hostname);
    } catch {
      return { error: 'baseUrl must be a public address' };
    }
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return { error: 'baseUrl must be a public address' };
  }
  return { baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, '') };
}

/** `{ model }` or `{ error }`: an id the provider knows, as text without spaces or markup. @param {unknown} value */
export function checkModelId(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model || model.length > MODEL_ID_MAX || !MODEL_ID_RE.test(model)) {
    return { error: `model must be 1 to ${MODEL_ID_MAX} characters: letters, digits and . _ : / @ + -` };
  }
  return { model };
}

/** The host of a stored base URL, for places that must not show a whole address (an audit row). Null for anything else. @param {string | null | undefined} baseUrl */
export function hostOf(baseUrl) {
  try {
    return baseUrl ? new URL(baseUrl).host : null;
  } catch {
    return null;
  }
}
