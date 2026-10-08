import type { Me, Team } from '../api';

/** Dialog to create a team. Calls onDone with the new team. (Stub: replaced by the real implementation.) */
export function openCreateTeam(onDone: (team: Team) => void): void {
  void onDone;
  throw new Error('openCreateTeam is not implemented yet');
}

/** Team settings: rename, members and roles, invite link, leave. onChange fires after any change. (Stub.) */
export function openTeamManager(team: Team, me: Me, onChange: () => void): void {
  void team;
  void me;
  void onChange;
  throw new Error('openTeamManager is not implemented yet');
}

/** Workspace members and roles, for owners and admins. (Stub.) */
export function openWorkspaceMembers(me: Me, onChange: () => void): void {
  void me;
  void onChange;
  throw new Error('openWorkspaceMembers is not implemented yet');
}
