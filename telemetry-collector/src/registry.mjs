import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_RE = /^tt_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;
export const WORKSPACE_RE = /^(?:ws_[A-Za-z0-9_-]{8,64}|[A-Za-z0-9_-]{16,64})$/u;

function hash(secret) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function readFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data?.tokens) ? data : { version: 1, tokens: [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, tokens: [] };
    throw error;
  }
}

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Issue a bearer token. The registry stores only the SHA-256 of the secret part.
 * A token is bound to one workspace, or to the control plane (`workspace: null`), which names the workspace in each report.
 * The plain token is returned once and never stored.
 */
/** @param {string} file @param {{ workspace?: string | null, label?: string, now?: number }} [options] */
export function issueToken(file, { workspace = null, label = '', now = Date.now() } = {}) {
  if (workspace !== null && !WORKSPACE_RE.test(String(workspace))) throw new Error('invalid workspace id');
  if (typeof label !== 'string' || label.length > 60 || /[^\w .:-]/u.test(label)) throw new Error('label must be 60 plain characters at most');
  const data = readFile(file);
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  data.tokens.push({ id, workspace, label, hash: hash(secret).toString('hex'), createdAt: now, revokedAt: null });
  writeFile(file, data);
  return { id, token: `tt_${id}_${secret}` };
}

/** Revoke by token id or by workspace (every token of that workspace). Returns the number revoked. */
/** @param {string} file @param {{ id?: string | null, workspace?: string | null, now?: number }} [options] */
export function revokeTokens(file, { id = null, workspace = null, now = Date.now() } = {}) {
  if (!id && !workspace) throw new Error('give a token id or a workspace');
  const data = readFile(file);
  let n = 0;
  for (const entry of data.tokens) {
    if (entry.revokedAt) continue;
    if ((id && entry.id === id) || (workspace && entry.workspace === workspace)) {
      entry.revokedAt = now;
      n += 1;
    }
  }
  if (n) writeFile(file, data);
  return n;
}

/** Token list without hashes. */
export function listTokens(file) {
  return readFile(file).tokens.map(({ id, workspace, label, createdAt, revokedAt }) => ({ id, workspace, label, createdAt, revokedAt }));
}

/** Verifier that re-reads the registry file when it changes, so the CLI takes effect without a restart. */
export function createRegistry(file) {
  let stamp = '';
  let byId = new Map();
  const dummy = hash('dummy');
  function refresh() {
    let next = '';
    try {
      const stat = fs.statSync(file);
      next = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      next = 'missing';
    }
    if (next === stamp) return;
    stamp = next;
    byId = new Map(readFile(file).tokens.map((entry) => [entry.id, entry]));
  }
  return {
    /** @returns {{ id: string, workspace: string | null } | null} */
    verify(token) {
      refresh();
      const match = TOKEN_RE.exec(typeof token === 'string' ? token : '');
      const entry = match ? byId.get(match[1]) : undefined;
      const expected = entry ? Buffer.from(entry.hash, 'hex') : dummy;
      const actual = hash(match ? match[2] : 'invalid');
      const equal = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!match || !entry || entry.revokedAt || !equal) return null;
      return { id: entry.id, workspace: entry.workspace ?? null };
    },
  };
}
