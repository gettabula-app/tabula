// Who a template is shared with, in accounts mode: the choices in the Save dialog, the labels on the cards and the
// split of the Templates page into "My templates" and "Shared with me". Pure (no DOM), so it is tested without a browser.

import type { Me } from './api';
import type { AuthState } from './auth';
import type { CustomTemplate, TemplateScope } from './custom-templates';
import { OFFLINE_MESSAGE } from './template-server';

export const PERSONAL_LABEL = 'Only me';
export const WORKSPACE_LABEL = 'Everyone in the workspace';
export const GUEST_MESSAGE = 'Guests cannot save templates.';

export interface ShareChoice {
  /** The value of the option in the select. */
  value: string;
  label: string;
  scope: TemplateScope;
  teamId: string | null;
}

type Sharing = Pick<CustomTemplate, 'scope' | 'teamId' | 'teamName'>;

const TEAM_PREFIX = 'team:';

/**
 * The "Share with" options: Only me, each team the person belongs to, and Everyone in the workspace for workspace
 * owners and admins. A template already shared with a team the person is not in (an admin editing it) keeps that team.
 */
export function shareChoices(me: Pick<Me, 'user' | 'teams'>, current?: Sharing): ShareChoice[] {
  const choices: ShareChoice[] = [{ value: 'personal', label: PERSONAL_LABEL, scope: 'personal', teamId: null }];
  for (const team of me.teams) choices.push({ value: `${TEAM_PREFIX}${team.id}`, label: team.name, scope: 'team', teamId: team.id });
  if (current?.scope === 'team' && current.teamId && !me.teams.some((t) => t.id === current.teamId)) {
    choices.push({ value: `${TEAM_PREFIX}${current.teamId}`, label: current.teamName ?? 'Another team', scope: 'team', teamId: current.teamId });
  }
  if (me.user.role === 'owner' || me.user.role === 'admin') {
    choices.push({ value: 'workspace', label: WORKSPACE_LABEL, scope: 'workspace', teamId: null });
  }
  return choices;
}

/** The option value for a template's current sharing; templates without any are personal. */
export function choiceValue(t: Pick<CustomTemplate, 'scope' | 'teamId'>): string {
  if (t.scope === 'team' && t.teamId) return `${TEAM_PREFIX}${t.teamId}`;
  return t.scope === 'workspace' ? 'workspace' : 'personal';
}

/** The choice for a select value; Only me when the value is not on the list. */
export function choiceFor(choices: ShareChoice[], value: string): ShareChoice {
  return choices.find((c) => c.value === value) ?? choices[0];
}

/** One line under the select, saying what the choice means. */
export function shareHint(choice: Pick<ShareChoice, 'scope'>): string {
  if (choice.scope === 'team') return 'Everyone in the team can use it. Team admins can change it.';
  if (choice.scope === 'workspace') return 'Everyone in the workspace can use it. Only workspace owners and admins can change it.';
  return 'Only you can see it.';
}

/** The small label on a card: Only me, the team's name, or Workspace. */
export function scopeLabel(t: Pick<CustomTemplate, 'scope' | 'teamName' | 'createdBy'>, userId: string | null): string {
  if (t.scope === 'team') return t.teamName || 'Team';
  if (t.scope === 'workspace') return 'Workspace';
  return t.createdBy === '' || (userId !== null && t.createdBy !== userId) ? 'Owner removed' : PERSONAL_LABEL;
}

/**
 * Splits the list in accounts mode into the person's own templates and the ones shared with them (team and workspace
 * templates somebody else owns, and the personal ones of a removed member that only admins see). Without accounts
 * everything is the person's own.
 */
export function splitMine(list: CustomTemplate[], userId: string | null): { mine: CustomTemplate[]; shared: CustomTemplate[] } {
  if (userId === null) return { mine: list, shared: [] };
  return { mine: list.filter((t) => t.createdBy === userId), shared: list.filter((t) => t.createdBy !== userId) };
}

/** Whether the person may rename, edit or delete a template. Templates kept in the browser always can be. */
export const mayChange = (t: Pick<CustomTemplate, 'canChange'>): boolean => t.canChange !== false;

/** The person's account id in accounts mode, null otherwise. */
export const accountId = (auth: AuthState): string | null => (auth.mode === 'signed-in' || auth.mode === 'offline' ? (auth.me?.user.id ?? null) : null);

/** Why a template cannot be saved to the server right now, or null when it can. */
export function saveBlocked(auth: AuthState): string | null {
  if (auth.mode === 'offline') return OFFLINE_MESSAGE;
  if (auth.mode === 'signed-in' && auth.me.user.role === 'guest') return GUEST_MESSAGE;
  return null;
}
