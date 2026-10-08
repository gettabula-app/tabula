import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const MAIL_MODES = ['log', 'file', 'webhook'];

export function normaliseEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[\s\p{Cc},;<>()[\]\\":]/u.test(email)) return null;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

export function loadConfig(env = process.env) {
  const authEnabled = env.MIRA_AUTH === 'on';
  const port = Number(env.PORT) || 8787;
  const dataDir = path.resolve(env.DATA_DIR || path.join(here, '..', 'data'));

  const ownerRaw = (env.MIRA_OWNER_EMAIL || '').trim();
  const ownerEmail = normaliseEmail(ownerRaw);
  if (ownerRaw && !ownerEmail) throw new Error('MIRA_OWNER_EMAIL is not a valid email address');
  if (authEnabled && !ownerEmail) throw new Error('MIRA_OWNER_EMAIL is required when MIRA_AUTH=on');

  const baseUrl = (env.MIRA_BASE_URL || `http://localhost:${port}`).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`MIRA_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MIRA_BASE_URL must be an http:// or https:// URL');
  }
  const origin = url.origin;
  const secureCookies = origin.startsWith('https:');

  const days = Number(env.MIRA_SESSION_DAYS);
  const sessionMs = (days > 0 && Number.isFinite(days) ? days : 30) * DAY_MS;

  const mode = (env.MIRA_MAIL || 'log').trim();
  if (!MAIL_MODES.includes(mode)) {
    throw new Error(`MIRA_MAIL must be one of ${MAIL_MODES.join(', ')} (got "${mode}")`);
  }
  const webhookUrl = (env.MIRA_MAIL_WEBHOOK_URL || '').trim() || null;
  if (mode === 'webhook' && !webhookUrl) {
    throw new Error('MIRA_MAIL_WEBHOOK_URL is required when MIRA_MAIL=webhook');
  }

  return {
    authEnabled,
    ownerEmail,
    baseUrl,
    origin,
    secureCookies,
    trustProxy: env.MIRA_TRUST_PROXY === '1',
    cookieName: secureCookies ? '__Host-mira_session' : 'mira_session',
    sessionMs,
    loginTokenMs: 15 * 60 * 1000,
    dataDir,
    port,
    mail: { mode, webhookUrl, from: env.MIRA_MAIL_FROM || 'Mira <no-reply@localhost>' },
  };
}
