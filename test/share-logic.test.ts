import { describe, expect, it } from 'vitest';
import type { BoardRole, Me, Member, Share, Team, TeamMember } from '../src/api';
import { DEFAULT_SHARE_ROLE, SHARE_ROLES, buildCandidates, canChangeProfile, canManageJoinCodes, canManageShares, canSaveTemplate, isRemovedGuestLink, shareRoleLabel, sortShares } from '../src/ui/share-logic';

const team = (id: string, name: string, memberCount = 2, archived = false): Team => ({ id, name, role: 'member', memberCount, archived });
const tm = (userId: string, name: string, email = `${userId}@example.com`): TeamMember => ({ userId, name, email, role: 'member' });
const member = (id: string, name: string, extra: Partial<Member> = {}): Member => ({
  id, email: `${id}@example.com`, name, role: 'member', disabled: false, teams: [], ...extra,
});
const share = (principalType: Share['principalType'], principalId: string, name: string, role: Share['role'] = 'viewer'): Share => ({
  principalType, principalId, name, role,
});
const base = {
  selfId: 'me',
  ownerId: 'owner',
  teams: [] as Team[],
  teamMembers: {} as Record<string, TeamMember[]>,
  members: null as Member[] | null,
  shares: [] as Share[],
};
const keys = (list: { type?: string; principalType?: string; id?: string; principalId?: string }[]) =>
  list.map((c) => `${c.type ?? c.principalType}:${c.id ?? c.principalId}`);

describe('guest-only board controls', () => {
  it.each(['unknown', 'open', 'signed-out', 'signed-in', 'offline'] as const)('keeps profile and template controls for %s sessions', (mode) => {
    expect(canChangeProfile(mode)).toBe(true);
    expect(canSaveTemplate(mode)).toBe(true);
  });

  it('hides profile and template controls from guests', () => {
    expect(canChangeProfile('guest')).toBe(false);
    expect(canSaveTemplate('guest')).toBe(false);
  });

  it('recognises a removed guest link without treating other denials as one', () => {
    expect(isRemovedGuestLink('guest', 'access_removed')).toBe(true);
    expect(isRemovedGuestLink('guest', 'no_access')).toBe(false);
    expect(isRemovedGuestLink('signed-in', 'access_removed')).toBe(false);
    expect(isRemovedGuestLink('guest', null)).toBe(false);
  });
});

describe('canManageShares', () => {
  it.each([
    [null, true, false],
    [null, false, false],
    ['owner', true, true],
    ['owner', false, false],
    ['editor', true, false],
    ['commenter', true, false],
    ['viewer', true, false],
    ['viewer', false, false],
  ] as [BoardRole | null, boolean, boolean][])('role %s with accounts %s gives %s', (role, accounts, expected) => {
    expect(canManageShares(role, accounts)).toBe(expected);
  });
});

describe('canManageJoinCodes', () => {
  it.each([
    [null, 'owner', false],
    [{ joinCodes: false }, 'owner', false],
    [{ joinCodes: true }, 'owner', true],
    [{ joinCodes: true }, 'editor', true],
    [{ joinCodes: true }, 'commenter', false],
    [{ joinCodes: true }, 'viewer', false],
    [{ joinCodes: true }, null, false],
  ] as [Pick<Me, 'joinCodes'> | null, BoardRole | null, boolean][])('setting %s and board role %s gives %s', (me, role, expected) => {
    expect(canManageJoinCodes(me, role)).toBe(expected);
  });
});

describe('buildCandidates', () => {
  it('uses every non-disabled member when the viewer is a workspace admin', () => {
    const out = buildCandidates({
      ...base,
      members: [member('a', 'Ann'), member('b', 'Bo', { disabled: true }), member('c', 'Cy')],
      teams: [team('t1', 'Alpha')],
      teamMembers: { t1: [tm('d', 'Dee')] },
    });
    expect(keys(out)).toEqual(['team:t1', 'user:a', 'user:c']);
  });

  it('takes people from the teams for a non-admin and lists each once across teams', () => {
    const out = buildCandidates({
      ...base,
      teams: [team('t1', 'Alpha'), team('t2', 'Beta')],
      teamMembers: { t1: [tm('a', 'Ann'), tm('b', 'Bo')], t2: [tm('b', 'Bo'), tm('c', 'Cy')] },
    });
    expect(out.filter((c) => c.type === 'user').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('excludes yourself, the owner and existing shares, matching on type and id', () => {
    const out = buildCandidates({
      ...base,
      teams: [team('a', 'Alpha'), team('t2', 'Two')],
      teamMembers: { a: [tm('me', 'Me'), tm('owner', 'Owner'), tm('a', 'Ann'), tm('bo', 'Bo')], t2: [] },
      shares: [share('team', 'a', 'Alpha'), share('user', 'bo', 'Bo')],
    });
    expect(keys(out)).toEqual(['team:t2', 'user:a']);
  });

  it('keeps a team whose id matches a shared person, and a person whose id matches a shared team', () => {
    const teams = [team('a', 'Alpha')];
    const teamMembers = { a: [tm('a', 'Ann')] };
    expect(keys(buildCandidates({ ...base, teams, teamMembers, shares: [share('user', 'a', 'Ann')] }))).toEqual(['team:a']);
    expect(keys(buildCandidates({ ...base, teams, teamMembers, shares: [share('team', 'a', 'Alpha')] }))).toEqual(['user:a']);
  });

  it('drops archived teams and the people who are only in them', () => {
    const out = buildCandidates({
      ...base,
      teams: [team('live', 'Live'), team('old', 'Old', 1, true)],
      teamMembers: { live: [tm('a', 'Ann')], old: [tm('z', 'Zed')] },
    });
    expect(keys(out)).toEqual(['team:live', 'user:a']);
  });

  it('orders teams first, then people, each by name ignoring case', () => {
    const out = buildCandidates({
      ...base,
      teams: [team('t1', 'beta'), team('t2', 'Alpha')],
      members: [member('p1', 'bob'), member('p2', 'Ann'), member('p3', 'cara')],
    });
    expect(out.map((c) => c.name)).toEqual(['Alpha', 'beta', 'Ann', 'bob', 'cara']);
  });

  it('falls back to the email when a name is empty', () => {
    const fromMembers = buildCandidates({ ...base, members: [member('p1', '  ', { email: 'nobody@example.com' })] });
    expect(fromMembers).toEqual([{ type: 'user', id: 'p1', name: 'nobody@example.com', detail: 'nobody@example.com' }]);
    const fromTeams = buildCandidates({ ...base, teams: [team('t1', 'Alpha')], teamMembers: { t1: [tm('q', '', 'q@example.com')] } });
    expect(fromTeams.find((c) => c.type === 'user')?.name).toBe('q@example.com');
  });

  it('gives the team detail with the member count, singular and plural', () => {
    const out = buildCandidates({ ...base, teams: [team('one', 'One', 1), team('three', 'Three', 3), team('none', 'None', 0)] });
    expect(out.map((c) => c.detail)).toEqual(['Team, 0 members', 'Team, 1 member', 'Team, 3 members']);
  });

  it('gives a person the email as detail', () => {
    const out = buildCandidates({ ...base, members: [member('p1', 'Ann')] });
    expect(out[0]).toEqual({ type: 'user', id: 'p1', name: 'Ann', detail: 'p1@example.com' });
  });
});

describe('sortShares', () => {
  it('lists teams first, then people, each by name ignoring case', () => {
    const out = sortShares([share('user', 'u1', 'bob'), share('team', 't1', 'beta'), share('user', 'u2', 'Ann'), share('team', 't2', 'Alpha')]);
    expect(out.map((s) => s.name)).toEqual(['Alpha', 'beta', 'Ann', 'bob']);
  });

  it('keeps the order of equal names and does not change the input', () => {
    const same = [share('user', 'u1', 'Sam'), share('user', 'u2', 'sam'), share('user', 'u3', 'SAM')];
    expect(sortShares(same).map((s) => s.principalId)).toEqual(['u1', 'u2', 'u3']);
    const input = [share('user', 'u1', 'bob'), share('user', 'u2', 'Ann')];
    sortShares(input);
    expect(input.map((s) => s.principalId)).toEqual(['u1', 'u2']);
  });
});

describe('share roles', () => {
  it('has Editor, Commenter and Viewer in that order, with viewer as the default', () => {
    expect(SHARE_ROLES.map((r) => r.value)).toEqual(['editor', 'commenter', 'viewer']);
    expect(SHARE_ROLES.map((r) => r.hint)).toEqual(['Can edit', 'Can comment, not edit', 'Can read only']);
    expect(DEFAULT_SHARE_ROLE).toBe('viewer');
  });

  it('labels a role', () => {
    expect(shareRoleLabel('commenter')).toBe('Commenter');
  });
});
