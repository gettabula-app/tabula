import type { BoardRole, Member, PrincipalType, Share, ShareRole, Team, TeamMember } from '../api';

export const SHARE_ROLES: { value: ShareRole; label: string; hint: string }[] = [
  { value: 'editor', label: 'Editor', hint: 'Can edit' },
  { value: 'commenter', label: 'Commenter', hint: 'Can comment, not edit' },
  { value: 'viewer', label: 'Viewer', hint: 'Can read only' },
];

export const DEFAULT_SHARE_ROLE: ShareRole = 'viewer';

export interface Candidate {
  type: PrincipalType;
  id: string;
  name: string;
  /** The email for a person; "Team, 3 members" for a team. */
  detail: string;
}

export function canManageShares(role: BoardRole | null, accounts: boolean): boolean {
  return accounts && role === 'owner';
}

const key = (type: PrincipalType, id: string) => `${type}:${id}`;
const rank = (type: PrincipalType) => (type === 'team' ? 0 : 1);
const nameOrder = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

export function buildCandidates(input: {
  selfId: string;
  ownerId: string | null;
  teams: Team[];
  teamMembers: Record<string, TeamMember[]>;
  members: Member[] | null;
  shares: Share[];
}): Candidate[] {
  const taken = new Set(input.shares.map((s) => key(s.principalType, s.principalId)));
  const active = input.teams.filter((t) => !t.archived);
  const people = new Map<string, Candidate>();
  const addPerson = (id: string, name: string, email: string) => {
    if (people.has(id) || id === input.selfId || id === input.ownerId || taken.has(key('user', id))) return;
    people.set(id, { type: 'user', id, name: name.trim() || email, detail: email });
  };
  if (input.members) {
    for (const m of input.members) if (!m.disabled) addPerson(m.id, m.name, m.email);
  } else {
    for (const t of active) for (const m of input.teamMembers[t.id] ?? []) addPerson(m.userId, m.name, m.email);
  }
  const teams = active
    .filter((t) => !taken.has(key('team', t.id)))
    .map((t): Candidate => ({
      type: 'team',
      id: t.id,
      name: t.name,
      detail: `Team, ${t.memberCount} ${t.memberCount === 1 ? 'member' : 'members'}`,
    }));
  return [...teams, ...people.values()].sort((a, b) => rank(a.type) - rank(b.type) || nameOrder(a.name, b.name));
}

export function sortShares(shares: Share[]): Share[] {
  return [...shares].sort((a, b) => rank(a.principalType) - rank(b.principalType) || nameOrder(a.name, b.name));
}

export function shareRoleLabel(role: ShareRole): string {
  return SHARE_ROLES.find((r) => r.value === role)?.label ?? role;
}
