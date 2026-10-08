import type { AuditEntry, UserRole } from '../api';

/** Pure rules and text for the admin dashboard: no DOM, so they can be unit tested. */

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

export interface Actor {
  id: string;
  role: UserRole;
}

export interface Target {
  id: string;
  role: UserRole;
  disabled: boolean;
}

export type Lookup = (kind: 'user' | 'team' | 'board', id: string) => string | undefined;

const ALLOWED: Verdict = { allowed: true };
const deny = (reason: string): Verdict => ({ allowed: false, reason });

const ROLES: UserRole[] = ['owner', 'admin', 'member', 'guest'];
const NOT_OWNER = 'Only an owner can act on an owner.';
const SELF_ROLE = 'You cannot change your own role.';
const SELF_DISABLE = 'You cannot disable your own account.';
const SELF_REMOVE = 'You cannot remove yourself.';
const GRANT_OWNER = 'Only an owner can make someone an owner.';
const LAST_ROLE = 'The last active owner cannot be demoted.';
const LAST_DISABLE = 'The last active owner cannot be disabled.';
const LAST_REMOVE = 'The last active owner cannot be removed.';

/** Active owners: a disabled owner does not count, as on the server. */
export function activeOwnerCount(members: { role: UserRole; disabled: boolean }[]): number {
  return members.filter((m) => m.role === 'owner' && !m.disabled).length;
}

/** The roles the select offers. Only an owner sees or grants owner, and an owner row shows only owner to anyone else. */
export function roleOptions(actor: Actor, target: Target): UserRole[] {
  if (target.role === 'owner' && actor.role !== 'owner') return ['owner'];
  return actor.role === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner');
}

/** Whether the role select can change this row at all. */
export function roleLock(actor: Actor, target: Target, activeOwners: number): Verdict {
  if (actor.id === target.id) return deny(SELF_ROLE);
  if (target.role === 'owner' && actor.role !== 'owner') return deny(NOT_OWNER);
  if (target.role === 'owner' && !target.disabled && activeOwners <= 1) return deny(LAST_ROLE);
  return ALLOWED;
}

export function roleVerdict(actor: Actor, target: Target, next: UserRole, activeOwners: number): Verdict {
  if (next === target.role) return ALLOWED;
  const lock = roleLock(actor, target, activeOwners);
  if (!lock.allowed) return lock;
  return next === 'owner' && actor.role !== 'owner' ? deny(GRANT_OWNER) : ALLOWED;
}

/** Disabling (`disabled: true`) or enabling (`false`). Enabling is never the last-owner problem. */
export function disableVerdict(actor: Actor, target: Target, disabled: boolean, activeOwners: number): Verdict {
  if (actor.id === target.id && disabled) return deny(SELF_DISABLE);
  if (target.role === 'owner' && actor.role !== 'owner') return deny(NOT_OWNER);
  if (disabled && target.role === 'owner' && !target.disabled && activeOwners <= 1) return deny(LAST_DISABLE);
  return ALLOWED;
}

export function removeVerdict(actor: Actor, target: Target, activeOwners: number): Verdict {
  if (actor.id === target.id) return deny(SELF_REMOVE);
  if (target.role !== 'owner') return ALLOWED;
  if (actor.role !== 'owner') return deny(NOT_OWNER);
  const othersActive = activeOwners - (target.disabled ? 0 : 1);
  return othersActive < 1 ? deny(LAST_REMOVE) : ALLOWED;
}

/** Sign out everywhere. Allowed on yourself; on another person it follows the owner rule. */
export function revokeVerdict(actor: Actor, target: Target): Verdict {
  if (actor.id === target.id) return ALLOWED;
  return target.role === 'owner' && actor.role !== 'owner' ? deny(NOT_OWNER) : ALLOWED;
}

export const KNOWN_AUDIT_ACTIONS = [
  'auth.login', 'auth.logout', 'auth.logout_all', 'me.update',
  'team.create', 'team.update', 'team.member.role', 'team.leave', 'team.member.remove',
  'invite.create', 'invite.revoke', 'invite.accept',
  'board.create', 'board.update', 'board.delete', 'board.restore', 'board.share', 'board.unshare',
  'member.update', 'member.remove',
  'admin.sessions.revoke', 'admin.session.revoke',
] as const;

export function isKnownAuditAction(action: string): boolean {
  return (KNOWN_AUDIT_ACTIONS as readonly string[]).includes(action);
}

/** Who did it. Audit rows carry no name for system rows or for deleted users. */
export function auditActor(entry: AuditEntry): string {
  return entry.actorEmail || entry.actorName || (entry.actorId === null ? 'System' : 'A deleted user');
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const quote = (s: string) => `“${s}”`;

/**
 * One audit row as a sentence. Details hold ids, so names come from `lookup` when the caller has them.
 * Unknown actions read as their raw action string.
 */
export function auditSentence(entry: AuditEntry, lookup: Lookup = () => undefined): string {
  const d = entry.detail ?? {};
  const who = auditActor(entry);
  const named = (kind: 'user' | 'team' | 'board', id: unknown): string | undefined => {
    const key = text(id);
    return key ? lookup(kind, key) : undefined;
  };
  const teamLabelFor = (id: unknown) => {
    const name = named('team', id);
    return name ? quote(name) : 'a team';
  };
  const member = named('user', d.userId) ?? 'a member';
  const teamLabel = teamLabelFor(d.teamId);
  const boardName = named('board', d.boardId);
  const boardLabel = boardName ? quote(boardName) : 'a board';
  const role = text(d.role);

  switch (entry.action) {
    case 'auth.login':
      return `${who} signed in`;
    case 'auth.logout':
      return `${who} signed out`;
    case 'auth.logout_all':
      return `${who} signed out everywhere`;
    case 'me.update': {
      const name = text(d.name);
      return name ? `${who} changed their name to ${quote(name)}` : `${who} updated their profile`;
    }
    case 'team.create': {
      const name = text(d.name);
      return name ? `${who} created team ${quote(name)}` : `${who} created a team`;
    }
    case 'team.update': {
      if (flag(d.archived) === true) return `${who} archived ${teamLabel}`;
      if (flag(d.archived) === false) return `${who} unarchived ${teamLabel}`;
      const name = text(d.name);
      return name ? `${who} renamed ${teamLabel} to ${quote(name)}` : `${who} updated ${teamLabel}`;
    }
    case 'team.member.role':
      return `${who} changed ${member}’s role in ${teamLabel} to ${role ?? 'a new role'}`;
    case 'team.leave':
      return `${who} left ${teamLabel}`;
    case 'team.member.remove':
      return `${who} removed ${member} from ${teamLabel}`;
    case 'invite.create':
      return `${who} created an invite link for ${teamLabel} as ${role ?? 'a member'}`;
    case 'invite.revoke':
      return `${who} revoked an invite link for ${teamLabel}`;
    case 'invite.accept':
      return `${who} joined ${teamLabel} as ${role ?? 'a member'}`;
    case 'board.create': {
      const where = text(d.teamId) ? ` in ${teamLabel}` : '';
      return flag(d.adopted) === true
        ? `${who} added ${boardLabel} to the workspace${where}`
        : `${who} created ${boardLabel}${where}`;
    }
    case 'board.update': {
      const title = text(d.title);
      if (title) return `${who} renamed ${boardLabel} to ${quote(title)}`;
      if (d.teamId === null) return `${who} moved ${boardLabel} to personal`;
      if (text(d.teamId)) return `${who} moved ${boardLabel} to ${teamLabel}`;
      return `${who} updated ${boardLabel}`;
    }
    case 'board.delete':
      return `${who} deleted ${boardLabel}`;
    case 'board.restore':
      return `${who} restored ${boardLabel}`;
    case 'board.share': {
      const principal = d.principalType === 'team' ? teamLabelFor(d.principalId) : (named('user', d.principalId) ?? 'someone');
      return `${who} shared ${boardLabel} with ${principal} as ${role ?? 'a role'}`;
    }
    case 'board.unshare': {
      const principal = d.principalType === 'team' ? teamLabelFor(d.principalId) : (named('user', d.principalId) ?? 'someone');
      return `${who} removed ${principal} from ${boardLabel}`;
    }
    case 'member.update': {
      if (role) return `${who} changed ${member} to ${role}`;
      if (flag(d.disabled) === true) return `${who} disabled ${member}`;
      if (flag(d.disabled) === false) return `${who} enabled ${member}`;
      return `${who} updated ${member}`;
    }
    case 'member.remove':
      return `${who} removed ${text(d.email) ?? member}`;
    case 'admin.sessions.revoke':
      return `${who} revoked all sessions of ${member}`;
    case 'admin.session.revoke':
      return `${who} revoked a session of ${member}`;
    default:
      return entry.action;
  }
}

/** Case-insensitive substring match over the given fields; an empty query matches everything. */
export function matchesQuery(query: string, fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}
