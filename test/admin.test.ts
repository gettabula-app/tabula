import { describe, expect, it } from 'vitest';
import { ApiError, createApi, type AuditEntry } from '../src/api';
import {
  activeOwnerCount,
  auditActor,
  auditSentence,
  countLabel,
  disableVerdict,
  isKnownAuditAction,
  KNOWN_AUDIT_ACTIONS,
  matchesQuery,
  removeVerdict,
  revokeVerdict,
  roleLock,
  roleOptions,
  roleVerdict,
  type Actor,
  type Lookup,
  type Target,
  type Verdict,
} from '../src/ui/admin-logic';

const entry = (action: string, detail: Record<string, unknown> = {}, actor: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  ts: 0,
  actorId: 'u1',
  actorName: 'Ana',
  actorEmail: 'ana@example.com',
  action,
  detail,
  ...actor,
});

const known = (names: { user?: Record<string, string>; team?: Record<string, string>; board?: Record<string, string> }): Lookup =>
  (kind, id) => names[kind]?.[id];

const NAMES = known({
  user: { u2: 'bo@example.com' },
  team: { t1: 'Design' },
  board: { b1: 'Roadmap' },
});

describe('auditSentence', () => {
  it.each<[string, AuditEntry, string]>([
    ['auth.login', entry('auth.login'), 'ana@example.com signed in'],
    ['auth.logout', entry('auth.logout'), 'ana@example.com signed out'],
    ['auth.logout_all', entry('auth.logout_all'), 'ana@example.com signed out everywhere'],
    ['me.update without a name', entry('me.update'), 'ana@example.com updated their profile'],
    ['me.update with a name', entry('me.update', { name: 'Anna' }), 'ana@example.com changed their name to “Anna”'],
    ['team.create', entry('team.create', { teamId: 't1', name: 'Design' }), 'ana@example.com created team “Design”'],
    ['team.create without a name', entry('team.create', { teamId: 't1' }), 'ana@example.com created a team'],
    ['team.update archived', entry('team.update', { teamId: 't1', archived: true }), 'ana@example.com archived “Design”'],
    ['team.update unarchived', entry('team.update', { teamId: 't1', archived: false }), 'ana@example.com unarchived “Design”'],
    ['team.update renamed', entry('team.update', { teamId: 't1', name: 'Platform' }), 'ana@example.com renamed “Design” to “Platform”'],
    ['team.member.role', entry('team.member.role', { teamId: 't1', userId: 'u2', role: 'admin' }), 'ana@example.com changed bo@example.com’s role in “Design” to admin'],
    ['team.leave', entry('team.leave', { teamId: 't1', userId: 'u1' }), 'ana@example.com left “Design”'],
    ['team.member.remove', entry('team.member.remove', { teamId: 't1', userId: 'u2' }), 'ana@example.com removed bo@example.com from “Design”'],
    ['invite.create', entry('invite.create', { teamId: 't1', inviteId: 'i1', role: 'member', days: 7 }), 'ana@example.com created an invite link for “Design” as member'],
    ['invite.revoke', entry('invite.revoke', { teamId: 't1', inviteId: 'i1' }), 'ana@example.com revoked an invite link for “Design”'],
    ['invite.accept', entry('invite.accept', { teamId: 't1', inviteId: 'i1', role: 'admin' }), 'ana@example.com joined “Design” as admin'],
    ['board.create', entry('board.create', { boardId: 'b1', teamId: null, adopted: false }), 'ana@example.com created “Roadmap”'],
    ['board.create in a team', entry('board.create', { boardId: 'b1', teamId: 't1', adopted: false }), 'ana@example.com created “Roadmap” in “Design”'],
    ['board.create adopted', entry('board.create', { boardId: 'b1', teamId: null, adopted: true }), 'ana@example.com added “Roadmap” to the workspace'],
    ['board.update renamed', entry('board.update', { boardId: 'b1', title: 'Plan' }), 'ana@example.com renamed “Roadmap” to “Plan”'],
    ['board.update moved to personal', entry('board.update', { boardId: 'b1', teamId: null }), 'ana@example.com moved “Roadmap” to personal'],
    ['board.update moved to a team', entry('board.update', { boardId: 'b1', teamId: 't1' }), 'ana@example.com moved “Roadmap” to “Design”'],
    ['board.delete', entry('board.delete', { boardId: 'b1' }), 'ana@example.com deleted “Roadmap”'],
    ['board.restore', entry('board.restore', { boardId: 'b1' }), 'ana@example.com restored “Roadmap”'],
    ['board.share to a person', entry('board.share', { boardId: 'b1', principalType: 'user', principalId: 'u2', role: 'commenter' }), 'ana@example.com shared “Roadmap” with bo@example.com as commenter'],
    ['board.share to a team', entry('board.share', { boardId: 'b1', principalType: 'team', principalId: 't1', role: 'editor' }), 'ana@example.com shared “Roadmap” with “Design” as editor'],
    ['board.unshare from a team', entry('board.unshare', { boardId: 'b1', principalType: 'team', principalId: 't1' }), 'ana@example.com removed “Design” from “Roadmap”'],
    ['board.unshare from a person', entry('board.unshare', { boardId: 'b1', principalType: 'user', principalId: 'u2' }), 'ana@example.com removed bo@example.com from “Roadmap”'],
    ['board.version.create', entry('board.version.create', { boardId: 'b1', versionId: 'v1', label: 'Before the workshop' }), 'ana@example.com saved the version “Before the workshop” of “Roadmap”'],
    ['board.version.rename', entry('board.version.rename', { boardId: 'b1', versionId: 'v1', label: 'Final' }), 'ana@example.com named a version of “Roadmap” “Final”'],
    ['board.version.delete', entry('board.version.delete', { boardId: 'b1', versionId: 'v1', kind: 'named' }), 'ana@example.com deleted a version of “Roadmap”'],
    ['board.version.restore', entry('board.version.restore', { boardId: 'b1', versionId: 'v1', preRestoreId: 'v2' }), 'ana@example.com restored a version of “Roadmap”'],
    ['member.update role', entry('member.update', { userId: 'u2', role: 'admin' }), 'ana@example.com changed bo@example.com to admin'],
    ['member.update disabled', entry('member.update', { userId: 'u2', disabled: true }), 'ana@example.com disabled bo@example.com'],
    ['member.update enabled', entry('member.update', { userId: 'u2', disabled: false }), 'ana@example.com enabled bo@example.com'],
    ['member.remove uses the email in the detail', entry('member.remove', { userId: 'u2', email: 'bo@example.com' }), 'ana@example.com removed bo@example.com'],
    ['admin.sessions.revoke', entry('admin.sessions.revoke', { userId: 'u2' }), 'ana@example.com revoked all sessions of bo@example.com'],
    ['admin.session.revoke', entry('admin.session.revoke', { sessionId: 's1', userId: 'u2' }), 'ana@example.com revoked a session of bo@example.com'],
    ['cloud.limits from the control plane', entry('cloud.limits', { seatLimit: 5, readOnly: true, banner: null }, { actorId: null, actorName: null, actorEmail: null }), 'System updated the workspace limits (5 seats, read-only)'],
    ['cloud.limits with one seat', entry('cloud.limits', { seatLimit: 1, readOnly: false }), 'ana@example.com updated the workspace limits (1 seat)'],
    ['cloud.limits without limits', entry('cloud.limits', { seatLimit: null, readOnly: false, banner: 'Hi' }), 'ana@example.com updated the workspace limits'],
  ])('%s', (_name, e, sentence) => {
    expect(auditSentence(e, NAMES)).toBe(sentence);
  });

  it.each<[string, AuditEntry, string]>([
    ['member.update without a lookup', entry('member.update', { userId: 'u9', role: 'admin' }), 'ana@example.com changed a member to admin'],
    ['board.update without a lookup', entry('board.update', { boardId: 'b9', title: 'Plan' }), 'ana@example.com renamed a board to “Plan”'],
    ['board.delete with an empty detail', entry('board.delete'), 'ana@example.com deleted a board'],
    ['admin.sessions.revoke with an empty detail', entry('admin.sessions.revoke'), 'ana@example.com revoked all sessions of a member'],
    ['admin.session.revoke with an empty detail', entry('admin.session.revoke'), 'ana@example.com revoked a session of a member'],
    ['board.restore with an empty detail', entry('board.restore'), 'ana@example.com restored a board'],
    ['board.version.create with an empty detail', entry('board.version.create'), 'ana@example.com saved a version of a board'],
    ['board.version.rename with an empty detail', entry('board.version.rename'), 'ana@example.com renamed a version of a board'],
    ['member.remove with an empty detail', entry('member.remove'), 'ana@example.com removed a member'],
    ['team.member.role without a role', entry('team.member.role', { teamId: 't1', userId: 'u2' }), 'ana@example.com changed bo@example.com’s role in “Design” to a new role'],
  ])('tolerates a sparse detail: %s', (_name, e, sentence) => {
    expect(auditSentence(e, NAMES)).toBe(sentence);
  });

  it('names a team neutrally when the caller has no lookup', () => {
    expect(auditSentence(entry('team.update', { teamId: 't1', name: 'Platform' }))).toBe('ana@example.com renamed a team to “Platform”');
  });

  it('falls back to the raw action for an unknown action', () => {
    expect(auditSentence(entry('billing.invoice.paid'), NAMES)).toBe('billing.invoice.paid');
  });

  it.each<[string, Partial<AuditEntry>, string]>([
    ['an email wins over a name', { actorEmail: 'ana@example.com', actorName: 'Ana' }, 'ana@example.com'],
    ['a name stands in for a missing email', { actorEmail: null, actorName: 'Ana' }, 'Ana'],
    ['a system row has no actor', { actorId: null, actorName: null, actorEmail: null }, 'System'],
    ['a deleted user has no name', { actorId: 'gone', actorName: null, actorEmail: null }, 'A deleted user'],
  ])('actor: %s', (_name, actor, label) => {
    expect(auditActor(entry('auth.login', {}, actor))).toBe(label);
  });

  it('gives every action the server writes a sentence of its own', () => {
    const expected = [
      'auth.login', 'auth.logout', 'auth.logout_all', 'me.update',
      'team.create', 'team.update', 'team.member.role', 'team.leave', 'team.member.remove',
      'invite.create', 'invite.revoke', 'invite.accept',
      'board.create', 'board.update', 'board.delete', 'board.share', 'board.unshare',
      'board.version.create', 'board.version.rename', 'board.version.delete', 'board.version.restore',
      'member.update', 'member.remove',
      'admin.sessions.revoke', 'admin.session.revoke', 'board.restore', 'cloud.limits',
    ];
    expect([...KNOWN_AUDIT_ACTIONS].sort()).toEqual([...expected].sort());
  });

  it.each(KNOWN_AUDIT_ACTIONS.map((a) => [a]))('%s is known and reads as a sentence', (action) => {
    expect(isKnownAuditAction(action)).toBe(true);
    expect(auditSentence(entry(action), NAMES)).not.toBe(action);
  });

  it('does not treat an unknown action as known', () => {
    expect(isKnownAuditAction('member.destroy')).toBe(false);
  });
});

const owner: Actor = { id: 'o1', role: 'owner' };
const admin: Actor = { id: 'a1', role: 'admin' };
const member = (over: Partial<Target> = {}): Target => ({ id: 'm1', role: 'member', disabled: false, ...over });
const ownerTarget = (over: Partial<Target> = {}): Target => ({ id: 'o2', role: 'owner', disabled: false, ...over });

describe('activeOwnerCount', () => {
  it('counts owners who are not disabled', () => {
    const list = [
      { role: 'owner' as const, disabled: false },
      { role: 'owner' as const, disabled: true },
      { role: 'admin' as const, disabled: false },
    ];
    expect(activeOwnerCount(list)).toBe(1);
  });
});

describe('roleOptions', () => {
  it.each<[string, Actor, Target, string[]]>([
    ['an owner picks any role for a member', owner, member(), ['owner', 'admin', 'member', 'guest']],
    ['an admin never offers owner', admin, member(), ['admin', 'member', 'guest']],
    ['an admin sees an owner row as owner only', admin, ownerTarget(), ['owner']],
    ['an owner sees every role for an owner row', owner, ownerTarget(), ['owner', 'admin', 'member', 'guest']],
  ])('%s', (_name, actor, target, options) => {
    expect(roleOptions(actor, target)).toEqual(options);
  });
});

describe('role rules', () => {
  it.each<[string, Verdict, boolean]>([
    ['an owner can change a member', roleLock(owner, member(), 1), true],
    ['an admin can change a member', roleLock(admin, member(), 1), true],
    ['nobody changes their own role', roleLock(owner, member({ id: 'o1' }), 1), false],
    ['an admin cannot change an owner', roleLock(admin, ownerTarget(), 2), false],
    ['the last active owner cannot be demoted', roleLock(owner, ownerTarget(), 1), false],
    ['an owner can change an owner when another active owner exists', roleLock(owner, ownerTarget(), 2), true],
    ['a disabled owner does not count as the last owner', roleLock(owner, ownerTarget({ disabled: true }), 1), true],
  ])('lock: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['keeping the current role is always fine', roleVerdict(admin, member({ role: 'admin' }), 'admin', 1), true],
    ['an admin cannot make someone an owner', roleVerdict(admin, member(), 'owner', 1), false],
    ['an owner can make someone an owner', roleVerdict(owner, member(), 'owner', 1), true],
    ['an admin can set a member to guest', roleVerdict(admin, member(), 'guest', 1), true],
    ['the last active owner cannot step down', roleVerdict(owner, ownerTarget(), 'admin', 1), false],
    ['an owner can step down when another owner exists', roleVerdict(owner, ownerTarget(), 'admin', 2), true],
  ])('verdict: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['an owner can disable a member', disableVerdict(owner, member(), true, 1), true],
    ['nobody disables themselves', disableVerdict(owner, member({ id: 'o1' }), true, 2), false],
    ['an admin cannot disable an owner', disableVerdict(admin, ownerTarget(), true, 2), false],
    ['the last active owner cannot be disabled', disableVerdict(owner, ownerTarget(), true, 1), false],
    ['an owner can disable one of two owners', disableVerdict(owner, ownerTarget(), true, 2), true],
    ['an owner can enable a disabled owner', disableVerdict(owner, ownerTarget({ disabled: true }), false, 0), true],
    ['an admin cannot enable an owner', disableVerdict(admin, ownerTarget({ disabled: true }), false, 1), false],
    ['an admin can enable a member', disableVerdict(admin, member({ disabled: true }), false, 1), true],
  ])('disable: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['nobody removes themselves', removeVerdict(owner, member({ id: 'o1' }), 2), false],
    ['an admin cannot remove an owner', removeVerdict(admin, ownerTarget(), 2), false],
    ['the sole active owner cannot be removed', removeVerdict(owner, ownerTarget(), 1), false],
    ['a disabled owner can go when another active owner exists', removeVerdict(owner, ownerTarget({ disabled: true }), 1), true],
    ['a disabled owner cannot go when none is active', removeVerdict(owner, ownerTarget({ disabled: true }), 0), false],
    ['an owner can remove an owner while another stays active', removeVerdict(owner, ownerTarget(), 2), true],
    ['an admin can remove a member', removeVerdict(admin, member(), 1), true],
  ])('remove: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });

  it.each<[string, Verdict, boolean]>([
    ['anyone signs themselves out everywhere', revokeVerdict(admin, { id: 'a1', role: 'admin', disabled: false }), true],
    ['an owner signs themselves out everywhere', revokeVerdict(owner, { id: 'o1', role: 'owner', disabled: false }), true],
    ['an admin cannot sign an owner out everywhere', revokeVerdict(admin, ownerTarget()), false],
    ['an admin can sign a member out everywhere', revokeVerdict(admin, member()), true],
  ])('revoke: %s', (_name, verdict, allowed) => {
    expect(verdict.allowed).toBe(allowed);
    expect(Boolean(verdict.reason)).toBe(!allowed);
  });
});

describe('countLabel', () => {
  it.each<[number, string]>([
    [0, '0 owners'],
    [1, '1 owner'],
    [2, '2 owners'],
    [12, '12 owners'],
  ])('%i', (n, label) => {
    expect(countLabel(n, 'owner', 'owners')).toBe(label);
  });
});

describe('matchesQuery', () => {
  it.each<[string, string, (string | null | undefined)[], boolean]>([
    ['an empty query matches everything', '', [null], true],
    ['a blank query matches everything', '   ', ['x'], true],
    ['matching ignores case', 'ANA', ['ana@example.com'], true],
    ['any field can match', 'bo', ['Ana', 'bo@example.com'], true],
    ['null fields never match', 'bo', [null, undefined], false],
    ['no field matches', 'zed', ['Ana', 'ana@example.com'], false],
  ])('%s', (_name, query, fields, matched) => {
    expect(matchesQuery(query, fields)).toBe(matched);
  });
});

const headersOf = (c: { init: RequestInit }) => c.init.headers as Record<string, string>;

/** A fetch that answers every call with the same body, and records what was asked. */
function recorder(body: unknown = {}, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('admin API client', () => {
  it.each<[string, (api: ReturnType<typeof createApi>) => Promise<unknown>, string, string]>([
    ['overview', (a) => a.adminOverview(), 'GET', '/api/admin/overview'],
    ['members', (a) => a.adminMembers(), 'GET', '/api/admin/members'],
    ['revoke a member’s sessions', (a) => a.revokeMemberSessions('u 1/x'), 'POST', '/api/admin/members/u%201%2Fx/revoke-sessions'],
    ['sessions', (a) => a.adminSessions(), 'GET', '/api/admin/sessions'],
    ['revoke one session', (a) => a.revokeSession('s1'), 'DELETE', '/api/admin/sessions/s1'],
    ['boards', (a) => a.adminBoards(), 'GET', '/api/admin/boards'],
    ['boards including deleted', (a) => a.adminBoards(true), 'GET', '/api/admin/boards?deleted=1'],
    ['restore a board', (a) => a.restoreBoard('b1'), 'POST', '/api/admin/boards/b1/restore'],
    ['audit first page', (a) => a.adminAudit(), 'GET', '/api/admin/audit'],
    ['audit with every option', (a) => a.adminAudit({ limit: 50, before: 7, action: 'board.' }), 'GET', '/api/admin/audit?limit=50&before=7&action=board.'],
    ['teams go through the existing route', (a) => a.teams(), 'GET', '/api/teams'],
  ])('%s', async (_name, call, method, url) => {
    const { fetchFn, calls } = recorder({});
    await call(createApi(fetchFn));
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([[method, url]]);
  });

  it.each<[string, (api: ReturnType<typeof createApi>) => Promise<unknown>]>([
    ['restore', (a) => a.restoreBoard('b1')],
    ['revoke a member’s sessions', (a) => a.revokeMemberSessions('m1')],
    ['revoke one session', (a) => a.revokeSession('s1')],
  ])('%s carries the CSRF header', async (_name, call) => {
    const { fetchFn, calls } = recorder(undefined, 204);
    await call(createApi(fetchFn));
    expect(calls.map((c) => headersOf(c)['x-tabula'])).toEqual(['1']);
  });

  it('reads send no CSRF header', async () => {
    const { fetchFn, calls } = recorder({});
    await createApi(fetchFn).adminAudit();
    expect(calls.map((c) => headersOf(c)['x-tabula'])).toEqual([undefined]);
  });

  it('turns a forbidden answer into an ApiError', async () => {
    const { fetchFn } = recorder({ error: 'forbidden', message: 'Admins only' }, 403);
    await expect(createApi(fetchFn).adminOverview()).rejects.toBeInstanceOf(ApiError);
  });

  it('keeps the status and code of a forbidden answer', async () => {
    const { fetchFn } = recorder({ error: 'forbidden' }, 403);
    await expect(createApi(fetchFn).adminOverview()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});
