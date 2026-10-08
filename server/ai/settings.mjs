// AI settings of a workspace (accounts mode), kept in the directory's `settings` table under ai.* keys, and the strict
// checks of what the admin console and the account menu may send (docs/ai.md, "Privacy and admin controls").

import { MODELS } from './anthropic.mjs';
import { PROVIDERS } from './providers.mjs';

export const FEATURES = ['generate', 'summarise', 'cluster'];
export const DEFAULT_LIMITS = Object.freeze({ perPersonHour: 20, perWorkspaceHour: 200 });
export const LIMIT_CAPS = Object.freeze({ perPersonHour: 1000, perWorkspaceHour: 10_000 });
export const API_KEY_MIN = 8;
export const API_KEY_MAX = 512;

const KEY = {
  enabled: 'ai.enabled',
  features: 'ai.features',
  model: 'ai.model',
  personalKeys: 'ai.personalKeys',
  membersOnly: 'ai.membersOnly',
  perPersonHour: 'ai.limits.perPersonHour',
  perWorkspaceHour: 'ai.limits.perWorkspaceHour',
};
const SETTING_FIELDS = ['enabled', 'features', 'model', 'personalKeys', 'membersOnly', 'limits'];
const KEY_FIELDS = ['apiKey', 'provider', 'baseUrl'];
const API_KEY_RE = new RegExp(`^\\S{${API_KEY_MIN},${API_KEY_MAX}}$`);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function storedInt(raw, fallback, cap) {
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n >= 1 && n <= cap ? n : fallback;
}

function storedFeatures(raw) {
  if (raw === null) return [...FEATURES];
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return FEATURES.filter((f) => list.includes(f));
  } catch {
    /* falls through */
  }
  return [...FEATURES];
}

/**
 * The workspace's AI settings with their defaults: off, every feature, the configured model, no personal keys, guests
 * allowed, 20 runs per person and 200 per workspace per hour. A stored value that no longer makes sense reads as its default.
 */
export function readAiSettings(directory, config) {
  const get = (name) => directory.getSetting(KEY[name]);
  const model = get('model');
  return {
    enabled: get('enabled') === '1',
    features: storedFeatures(get('features')),
    model: MODELS.includes(model) ? model : config.ai.model,
    personalKeys: get('personalKeys') === '1',
    membersOnly: get('membersOnly') === '1',
    limits: {
      perPersonHour: storedInt(get('perPersonHour'), DEFAULT_LIMITS.perPersonHour, LIMIT_CAPS.perPersonHour),
      perWorkspaceHour: storedInt(get('perWorkspaceHour'), DEFAULT_LIMITS.perWorkspaceHour, LIMIT_CAPS.perWorkspaceHour),
    },
  };
}

/** Writes a patch from validateAdminAi. Call it inside a transaction with the audit row. */
export function writeAiSettings(directory, patch) {
  const set = (name, value) => directory.setSetting(KEY[name], value);
  if (patch.enabled !== undefined) set('enabled', patch.enabled ? '1' : '0');
  if (patch.features !== undefined) set('features', JSON.stringify(patch.features));
  if (patch.model !== undefined) set('model', patch.model);
  if (patch.personalKeys !== undefined) set('personalKeys', patch.personalKeys ? '1' : '0');
  if (patch.membersOnly !== undefined) set('membersOnly', patch.membersOnly ? '1' : '0');
  for (const name of ['perPersonHour', 'perWorkspaceHour']) {
    if (patch.limits?.[name] !== undefined) set(name, String(patch.limits[name]));
  }
}

/** Guests use AI like members unless the admin restricts it to members. */
export const aiEnabledFor = (settings, user) => settings.enabled && !(settings.membersOnly && user.role === 'guest');
export const personalKeysFor = (settings, user) => settings.personalKeys && !(settings.membersOnly && user.role === 'guest');

/** `{ key: { apiKey, provider } }` or `{ error }` for the key fields (the base URL is not supported in v1). */
function checkKey(body, { required }) {
  if (body.apiKey === undefined) {
    if (required) return { error: 'apiKey is required' };
    for (const name of ['provider', 'baseUrl']) {
      if (body[name] !== undefined && body[name] !== null) return { error: `${name} applies together with apiKey` };
    }
    return { key: null };
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!API_KEY_RE.test(apiKey)) return { error: `apiKey must be ${API_KEY_MIN} to ${API_KEY_MAX} characters without spaces` };
  if (body.provider !== undefined && !PROVIDERS.includes(body.provider)) return { error: `provider must be one of ${PROVIDERS.join(', ')}` };
  if (body.baseUrl !== undefined && body.baseUrl !== null) return { error: 'A custom base URL is not supported yet' };
  return { key: { apiKey, provider: body.provider ?? PROVIDERS[0] } };
}

function checkLimits(limits) {
  if (!isObject(limits)) return { error: 'limits must be an object' };
  const patch = {};
  for (const name of Object.keys(limits)) {
    if (!(name in LIMIT_CAPS)) return { error: `Unknown limit: ${name.slice(0, 40)}` };
    const n = limits[name];
    if (!Number.isInteger(n) || n < 1 || n > LIMIT_CAPS[name]) return { error: `${name} must be a whole number from 1 to ${LIMIT_CAPS[name]}` };
    patch[name] = n;
  }
  return Object.keys(patch).length ? { patch } : { error: 'limits must name at least one limit' };
}

/** Strict check of a PUT /api/ai/keys/me body: `{ key: { apiKey, provider } }` or `{ error }`. */
export function validateKeyBody(body) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object' };
  for (const name of Object.keys(body)) {
    if (!KEY_FIELDS.includes(name)) return { error: `Unknown field: ${name.slice(0, 40)}` };
  }
  return checkKey(body, { required: true });
}

/** Strict check of a PUT /api/admin/ai body: `{ patch, key }` (the settings to write, the key to verify and store or null) or `{ error }`. */
export function validateAdminAi(body) {
  if (!isObject(body)) return { error: 'The request body must be a JSON object' };
  for (const name of Object.keys(body)) {
    if (!SETTING_FIELDS.includes(name) && !KEY_FIELDS.includes(name)) return { error: `Unknown field: ${name.slice(0, 40)}` };
  }
  const patch = {};
  for (const name of ['enabled', 'personalKeys', 'membersOnly']) {
    if (body[name] === undefined) continue;
    if (typeof body[name] !== 'boolean') return { error: `${name} must be a boolean` };
    patch[name] = body[name];
  }
  if (body.features !== undefined) {
    const list = body.features;
    if (!Array.isArray(list) || list.length > FEATURES.length || list.some((f) => !FEATURES.includes(f)) || new Set(list).size !== list.length) {
      return { error: `features must list each of ${FEATURES.join(', ')} at most once` };
    }
    patch.features = FEATURES.filter((f) => list.includes(f));
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !MODELS.includes(body.model)) return { error: `model must be one of ${MODELS.join(', ')}` };
    patch.model = body.model;
  }
  if (body.limits !== undefined) {
    const checked = checkLimits(body.limits);
    if (checked.error) return checked;
    patch.limits = checked.patch;
  }
  const checkedKey = checkKey(body, { required: false });
  if (checkedKey.error) return checkedKey;
  if (Object.keys(patch).length === 0 && !checkedKey.key) return { error: 'Nothing to change' };
  return { patch, key: checkedKey.key };
}
