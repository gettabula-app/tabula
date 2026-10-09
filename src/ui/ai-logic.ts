import type { AdminAi, AdminAiPatch, AiConfig, AiFeature, AiKeyInfo } from '../api';

/** Pure rules and text for the AI settings (docs/ai.md): no DOM, so they can be unit tested. */

/** Shown wherever AI is turned on; the data leaves the instance, and the person turning it on should know. */
export const DATA_NOTICE = 'Board content is sent to the chosen provider and processed under its API terms.';

export const UNCONFIGURED_TEXT =
  'This server has no TABULA_AI_SECRET, so keys cannot be stored. Set it to 32 random bytes encoded as base64 (for example the output of openssl rand -base64 32) and restart the relay.';

export const FEATURE_OPTIONS: { id: AiFeature; label: string }[] = [
  { id: 'generate', label: 'Generate stickies' },
  { id: 'summarise', label: 'Summarise' },
  { id: 'cluster', label: 'Cluster stickies' },
];

/** The models an admin can pick; the ids match MODELS in server/ai/anthropic.mjs (a test keeps them equal). */
export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];

export const PROVIDER = 'anthropic';
export const PROVIDER_LABEL = 'Anthropic';
export const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible';
export const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: PROVIDER, label: 'Anthropic' },
  { value: OPENAI_COMPATIBLE_PROVIDER, label: 'OpenAI-compatible' },
];

/** The same bounds the server enforces (server/ai/settings.mjs). */
export const KEY_MIN = 8;
export const KEY_MAX = 512;
export const LIMIT_CAPS = { perPersonHour: 1000, perWorkspaceHour: 10_000 } as const;

export type LimitName = keyof typeof LIMIT_CAPS;
export const LIMIT_LABELS: Record<LimitName, string> = { perPersonHour: 'Runs per person per hour', perWorkspaceHour: 'Runs per workspace per hour' };

const publicAddressProblem = (raw: string): string | null => {
  const baseUrl = raw.trim();
  if (!baseUrl) return 'Enter a base URL.';
  if (baseUrl.length > 200) return 'A base URL has at most 200 characters.';
  if (!/^https:\/\//i.test(baseUrl)) return 'Base URL must be an HTTPS address.';

  let address: URL;
  try {
    address = new URL(baseUrl);
  } catch {
    return 'Base URL must be an HTTPS address.';
  }
  if (address.protocol !== 'https:' || !address.hostname) return 'Base URL must be an HTTPS address.';
  if (address.username || address.password) return 'Base URL cannot include a username or password.';
  if (baseUrl.includes('?') || baseUrl.includes('#')) return 'Base URL cannot include a query or fragment.';

  const host = address.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || ['.localhost', '.local', '.internal'].some((suffix) => host.endsWith(suffix)) || privateAddress(host)) {
    return 'Base URL cannot use a local or private address.';
  }
  return null;
};

function privateAddress(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return privateIpv6(host.slice(1, -1));
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const octets = parts.map(Number);
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function privateIpv6(host: string): boolean {
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)) return true;
  const mapped = host.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return privateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

/** Why a key cannot be saved yet, or null. The server checks the same rules, and then asks the provider. */
export function keyProblem(raw: string, provider = PROVIDER, baseUrl = '', model = ''): string | null {
  const key = raw.trim();
  if (!key) return 'Paste the API key.';
  if (/\s/.test(key)) return 'A key has no spaces.';
  if (key.length < KEY_MIN) return `A key has at least ${KEY_MIN} characters.`;
  if (key.length > KEY_MAX) return `A key has at most ${KEY_MAX} characters.`;
  if (provider === OPENAI_COMPATIBLE_PROVIDER) {
    const addressProblem = publicAddressProblem(baseUrl);
    if (addressProblem) return addressProblem;
    const id = model.trim();
    if (!id) return 'Enter a model id.';
    if (id.length > 100) return 'A model id has at most 100 characters.';
    if (!/^[a-z\d]/i.test(id)) return 'A model id starts with a letter or digit.';
    if (!/^[a-z\d][a-z\d._:/@+-]*$/i.test(id)) return 'A model id uses only letters, digits, ., _, :, /, @, + and -.';
  }
  return null;
}

/** Why a limit field is not a usable number, or null. An empty field is not valid either. */
export function limitProblem(name: LimitName, raw: string): string | null {
  const cap = LIMIT_CAPS[name];
  if (!/^\d{1,6}$/.test(raw.trim())) return `${LIMIT_LABELS[name]}: use a whole number from 1 to ${cap}.`;
  const n = Number(raw);
  return n >= 1 && n <= cap ? null : `${LIMIT_LABELS[name]}: use a whole number from 1 to ${cap}.`;
}

export interface AdminDraft {
  enabled: boolean;
  features: AiFeature[];
  model: string;
  personalKeys: boolean;
  membersOnly: boolean;
  perPersonHour: string;
  perWorkspaceHour: string;
}

export const draftOf = (s: AdminAi): AdminDraft => ({
  enabled: s.enabled,
  features: [...s.features],
  model: s.model,
  personalKeys: s.personalKeys,
  membersOnly: s.membersOnly,
  perPersonHour: String(s.limits.perPersonHour),
  perWorkspaceHour: String(s.limits.perWorkspaceHour),
});

/** The first thing wrong with the draft, or null. */
export function draftProblem(draft: AdminDraft): string | null {
  return limitProblem('perPersonHour', draft.perPersonHour) ?? limitProblem('perWorkspaceHour', draft.perWorkspaceHour);
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Only what differs from the saved settings, so the audit log records what an admin actually changed. Null when nothing differs. */
export function patchOf(saved: AdminAi, draft: AdminDraft): AdminAiPatch | null {
  const patch: AdminAiPatch = {};
  if (draft.enabled !== saved.enabled) patch.enabled = draft.enabled;
  if (!sameSet(draft.features, saved.features)) patch.features = FEATURE_OPTIONS.map((o) => o.id).filter((id) => draft.features.includes(id));
  if (draft.model !== saved.model) patch.model = draft.model;
  if (draft.personalKeys !== saved.personalKeys) patch.personalKeys = draft.personalKeys;
  if (draft.membersOnly !== saved.membersOnly) patch.membersOnly = draft.membersOnly;
  const limits: NonNullable<AdminAiPatch['limits']> = {};
  if (Number(draft.perPersonHour) !== saved.limits.perPersonHour) limits.perPersonHour = Number(draft.perPersonHour);
  if (Number(draft.perWorkspaceHour) !== saved.limits.perWorkspaceHour) limits.perWorkspaceHour = Number(draft.perWorkspaceHour);
  if (Object.keys(limits).length) patch.limits = limits;
  return Object.keys(patch).length ? patch : null;
}

export const modelLabel = (id: string): string => MODEL_OPTIONS.find((o) => o.value === id)?.label ?? id;

/** A host without its path, credentials, query or fragment; only HTTPS addresses are useful here. */
export function hostOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const address = new URL(baseUrl);
    return address.protocol === 'https:' && address.host ? address.host : null;
  } catch {
    return null;
  }
}

/** A stored key is shown only by its hint, provider and non-secret endpoint/model details. */
export function keyLine(info: Pick<AiKeyInfo, 'provider' | 'hint' | 'baseUrl' | 'model'>): string {
  const provider = info.provider === PROVIDER ? PROVIDER_LABEL : info.provider === OPENAI_COMPATIBLE_PROVIDER ? 'OpenAI-compatible' : info.provider;
  const details = [hostOf(info.baseUrl), info.model?.trim() || null].filter((part): part is string => part !== null);
  return `${provider} key ending …${info.hint}${details.map((part) => ` · ${part}`).join('')}`;
}

/** When the key was added and last used, for the line under it. */
export function keyDates(info: Pick<AiKeyInfo, 'createdAt' | 'lastUsedAt'>, ago: (t: number) => string): string {
  return `Added ${ago(info.createdAt)} · ${info.lastUsedAt === null ? 'never used' : `used ${ago(info.lastUsedAt)}`}`;
}

/** Which key the next run would use, as the app says it. */
export function sourceLabel(source: AiConfig['keySource']): string {
  if (source === 'user') return 'Runs use your key.';
  if (source === 'workspace') return 'Runs use the workspace key.';
  return 'There is no key yet, so AI features cannot run.';
}

/** A plain message for a stored-key check, or null when the shared screen message is more useful. */
export function keyTestErrorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { code?: unknown; status?: unknown; facts?: Record<string, unknown> };
  if (e.code === 'ai_key_invalid') return 'The AI key was rejected.';
  if (e.code === 'ai_model_invalid') return 'The provider does not know this model or this address. Check the base URL and the model.';
  if (e.code === 'ai_bad_output') return 'This model did not answer in the required JSON format. Try a stronger instruction-following model. Nothing was changed.';
  if (e.code === 'ai_unavailable') return "Anthropic isn't responding. Try again in a moment.";
  if (e.code === 'ai_key_unreadable') return "The key can't be read. Enter it again.";
  if (e.status === 429 || e.code === 'ai_rate_limited' || e.code === 'rate_limited') {
    const wait = Number(e.facts?.retryAfter);
    return Number.isFinite(wait) && wait > 0
      ? `Too many checks. Try again in ${Math.ceil(wait)} s.`
      : 'Too many checks. Try again later.';
  }
  return null;
}
