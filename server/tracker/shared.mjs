import crypto from 'node:crypto';
import { OpsError, stripInvisible } from '../board-ops.mjs';
import { trackerGateState } from './gate.mjs';

export { OpsError, stripInvisible };

export class TrackerRestoringError extends OpsError {
  constructor(floor) {
    super('tracker_restoring', 'Ticket writes are paused while the workspace is being restored.');
    this.floor = floor === 'known' ? 'known' : 'pending';
  }
}

export const invalid = (path, message) => new OpsError('invalid_input', message, path);
export const notFound = (message = 'Ticket not found', path) => new OpsError('not_found', message, path);
export const forbidden = (message = 'Not permitted') => new OpsError('forbidden', message);
export const conflict = (message, path) => new OpsError('conflict', message, path);
export const limitExceeded = (message, path) => new OpsError('limit_exceeded', message, path);

export function getDb({ directory, db } = {}) {
  const result = db ?? directory?.db ?? directory;
  if (!result || typeof result.prepare !== 'function' || typeof result.exec !== 'function') {
    throw new TypeError('tracker commands require a directory or node:sqlite database');
  }
  return result;
}

export function inTransaction({ directory, db } = {}, fn) {
  if (directory && typeof directory.transaction === 'function') return directory.transaction(fn);
  const conn = getDb({ directory, db });
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}

export function requireWritable(readOnly = () => false) {
  if ((typeof readOnly === 'function' ? readOnly() : readOnly) === true) {
    throw new OpsError('read_only', 'This workspace is read-only.');
  }
}

export function requireTrackerGateOpen(directory) {
  const gate = trackerGateState(directory);
  if (gate.closed) throw new TrackerRestoringError(gate.floor);
}

export function actorInfo(actor) {
  const principal = actor?.user ?? actor?.owner ?? actor?.representedUser ?? actor;
  const type = actor?.type ?? actor?.actorType ?? 'user';
  if (!['user', 'mcp_token', 'system'].includes(type)) throw invalid('actor.type', 'Unsupported actor type');
  const id = type === 'mcp_token'
    ? (actor?.tokenId ?? actor?.id ?? null)
    : (actor?.id ?? actor?.userId ?? null);
  const userId = type === 'user'
    ? (principal?.id ?? actor?.userId ?? null)
    : (actor?.ownerUserId ?? principal?.id ?? actor?.userId ?? null);
  const workspaceRole = principal?.workspaceRole ?? actor?.workspaceRole ?? principal?.role ?? actor?.userRole ?? actor?.role ?? null;
  // the token's name, recorded on ticket events and never sent to a client (TAB-330)
  const tokenName = type === 'mcp_token' && typeof actor?.tokenName === 'string'
    ? Array.from(actor.tokenName.trim()).slice(0, 80).join('') || null
    : null;
  return {
    type,
    id,
    userId,
    tokenName,
    // `viewer` is also a board-share role; require the explicit workspace role field to avoid widening board-only access.
    role: workspaceRole === 'viewer' && principal?.workspaceRole !== 'viewer' && actor?.workspaceRole !== 'viewer' ? null : workspaceRole,
    disabled: actor?.disabled === true || principal?.disabled === true,
    userName: principal?.name ?? actor?.userName ?? null,
    trackerScope: actor?.tracker ?? actor?.trackerScope ?? null,
  };
}

export function codePointLength(value) {
  return Array.from(value).length;
}

export function cleanText(value, { path, min = 0, max, singleLine = false, trim = true } = {}) {
  if (typeof value !== 'string') throw invalid(path, 'Must be text');
  const cleaned = stripInvisible(value);
  const text = trim ? cleaned.trim() : cleaned;
  if (singleLine && /[\r\n]/u.test(text)) throw invalid(path, 'Must be a single line');
  const length = codePointLength(text);
  if (length < min || length > max) throw invalid(path, `Must be ${min} to ${max} characters`);
  return text;
}

/** The canonical ticket title validator used by every tracker writer. */
export function cleanTicketTitle(value, path = 'title') {
  return cleanText(value, { path, min: 1, max: 200, singleLine: true });
}

export function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function utcStartOfDay(value) {
  return Date.parse(`${value}T00:00:00.000Z`);
}

export function newId() {
  return crypto.randomBytes(16).toString('base64url');
}

/** Priority names by stored number; shared by ticket JSON and the list rows. */
export const PRIORITIES = Object.freeze(['none', 'urgent', 'high', 'medium', 'low']);
