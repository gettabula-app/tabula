// TAB-375 slice 2 (accounts mode): the pure part of the Boards page's cards. A server board becomes a card (what its line says, who is
// here, how much is unread), and the rules say where a board may move. No DOM here, so the tests need no page.
import type { BoardRole, ServerBoard, Team } from '../api';
import { presenceView, type PresenceSummary } from './presence-logic';
import type { BoardCardData, HereUser, MoveTarget } from './board-card';
import type { PreviewImage } from './board-preview';

export const UNTITLED = 'Untitled board';

/** What the page knows about one board beside the server's record: who is on it, its unread messages, a dev picture. */
export interface LiveBoard {
  presence?: PresenceSummary | null;
  unread?: number;
  mention?: boolean;
  image?: PreviewImage;
}

/** Board lists cached before the API reported owners have no ownerId: there, own boards are the ones with the owner role. */
export function isMine(b: { ownerId?: string | null; role: BoardRole }, userId: string): boolean {
  return b.ownerId === undefined ? b.role === 'owner' : b.ownerId === userId;
}

/**
 * A server board as a card. The line under the name is the last edit: its editor (a person's name, or an agent's, from the server)
 * and when. `updatedAt` is that edit's time when the server has one (so the line and the sort agree), else the board's own time.
 */
export function toBoardCard(b: ServerBoard, live: LiveBoard = {}): BoardCardData {
  const card: BoardCardData = { id: b.id, name: b.title || UNTITLED, updatedAt: b.lastEditedAt ?? b.updatedAt, role: b.role };
  const editor = typeof b.lastEditedBy === 'string' ? b.lastEditedBy.trim() : '';
  if (editor !== '') card.editedBy = b.lastEditedKind === 'agent' ? { name: editor, agent: true } : { name: editor };
  const view = presenceView(live.presence ?? null);
  if (view) {
    // the squares (a colour when the person has one, else the ink fallback), then "You" when the viewer has the board open too
    const here: HereUser[] = view.squares.map((s) => ({ initials: s.initial, color: s.colour ?? '' }));
    if (view.you) here.push({ initials: 'You', color: '' });
    if (here.length) card.here = here;
    if (view.more > 0) card.hereMore = view.more;
  }
  if (live.unread) card.unread = live.unread;
  if (live.mention) card.mention = true;
  if (live.image) card.image = live.image;
  return card;
}

/** A device board (not on the server) as a card: its name and its time; the menu adds it to the workspace or deletes it. */
export function deviceCard(entry: { id: string; name: string; updatedAt: number }, targets: MoveTarget[]): BoardCardData {
  return { id: entry.id, name: entry.name || UNTITLED, updatedAt: entry.updatedAt, onDevice: true, targets };
}

/**
 * Where a server board may move. Team: anyone who may move it. A workspace owner or admin may move any board to any team; anyone else
 * may move a board they own to a team they are in. Personal: only the owner, and only from a team (a board is in one place).
 * The team the board is in now is not a target. Archived teams are never targets.
 */
export function moveTargetsFor(
  b: Pick<ServerBoard, 'teamId' | 'ownerId' | 'role'>,
  me: { id: string; admin: boolean },
  teams: Pick<Team, 'id' | 'name' | 'role' | 'archived'>[],
): MoveTarget[] {
  const owned = isMine(b, me.id);
  const out: MoveTarget[] = [];
  if (owned && b.teamId !== null) out.push({ id: null, name: 'Personal' });
  for (const t of teams) {
    if (t.archived || t.id === b.teamId) continue;
    if (me.admin || (owned && t.role !== null)) out.push({ id: t.id, name: t.name });
  }
  return out;
}

/** Where a device board may be added: Personal, and the teams the person is in. */
export function deviceTargets(teams: Pick<Team, 'id' | 'name' | 'role' | 'archived'>[]): MoveTarget[] {
  return [{ id: null, name: 'Personal' }, ...teams.filter((t) => t.role !== null && !t.archived).map((t) => ({ id: t.id, name: t.name }))];
}
