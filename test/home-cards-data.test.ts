import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerBoard } from '../src/api';
import { deviceCard, deviceTargets, isMine, moveTargetsFor, toBoardCard, UNTITLED } from '../src/ui/boards-home-data';
import { dropVerdict, type BoardSection } from '../src/ui/boards-cards-view';
import { applyDevMoves, moveBoardStub } from '../src/ui/home';
import type { BoardCardData } from '../src/ui/board-card';

// TAB-375 slice 2: the mapping from a server board to a card, the rules of where a board may move, and where a drop is refused.
// Pure: no page is drawn. The mapping reads what the server serves (lastEditedBy/Kind/At) and the page's live state, passed in.

const NOW = new Date(2026, 9, 15, 12, 0).getTime();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const board = (over: Partial<ServerBoard> = {}): ServerBoard => ({
  id: 'b1', title: 'Q4 roadmap', teamId: 't1', ownerId: 'u1', role: 'owner', createdAt: 1, updatedAt: NOW - 3_600_000, ...over,
});
const TEAMS = [
  { id: 't1', name: 'Design team', role: 'admin' as const, memberCount: 3, archived: false },
  { id: 't2', name: 'Retro team', role: 'member' as const, memberCount: 4, archived: false },
  { id: 't3', name: 'Growth team', role: null, memberCount: 2, archived: false },
  { id: 't4', name: 'Old team', role: 'member' as const, memberCount: 1, archived: true },
];

describe('toBoardCard', () => {
  it('takes the title, and the last edit as the editor and the time', () => {
    const card = toBoardCard(board({ lastEditedBy: 'Maja', lastEditedKind: 'person', lastEditedAt: NOW - 720_000 }));
    expect(card).toMatchObject({ id: 'b1', name: 'Q4 roadmap', updatedAt: NOW - 720_000, role: 'owner', editedBy: { name: 'Maja' } });
    expect(card.editedBy?.agent).toBeUndefined();
  });

  it('marks an agent as an agent', () => {
    const card = toBoardCard(board({ lastEditedBy: 'Claude', lastEditedKind: 'agent', lastEditedAt: NOW }));
    expect(card.editedBy).toEqual({ name: 'Claude', agent: true });
  });

  it('shows no editor when the server names none, and keeps the board time', () => {
    const card = toBoardCard(board({ lastEditedBy: null, lastEditedKind: null, lastEditedAt: null }));
    expect(card.editedBy).toBeUndefined();
    expect(card.updatedAt).toBe(NOW - 3_600_000);
  });

  it('tolerates a board from an older server, without the last-edit fields', () => {
    const { lastEditedBy: _a, lastEditedKind: _b, lastEditedAt: _c, ...old } = board();
    const card = toBoardCard(old as ServerBoard);
    expect(card.editedBy).toBeUndefined();
    expect(card.updatedAt).toBe(NOW - 3_600_000);
  });

  it('names an untitled board', () => {
    expect(toBoardCard(board({ title: '' })).name).toBe(UNTITLED);
  });

  it('keeps a viewer or commenter role for the role chip, and an editor or owner without one', () => {
    expect(toBoardCard(board({ role: 'viewer' })).role).toBe('viewer');
    expect(toBoardCard(board({ role: 'editor' })).role).toBe('editor');
  });

  it('draws the people here as squares, with the count of the rest, and "You" when the viewer is on it too', () => {
    const card = toBoardCard(board(), {
      presence: {
        boardId: 'b1', count: 5, me: true,
        people: [
          { userId: 'a', name: 'Maja', colour: '#326DD3', joinedAt: 1 },
          { userId: 'b', name: 'Omar', colour: null, joinedAt: 2 },
        ],
      },
    });
    expect(card.here).toEqual([
      { initials: 'M', color: '#326DD3' },
      { initials: 'O', color: '' },
      { initials: 'You', color: '' },
    ]);
    expect(card.hereMore).toBe(3);
  });

  it('leaves here and hereMore out when nobody else is on the board', () => {
    const card = toBoardCard(board(), { presence: null });
    expect(card.here).toBeUndefined();
    expect(card.hereMore).toBeUndefined();
  });

  it('carries the unread count, the mention flag and a picture when the page has them', () => {
    const image = { kind: 'svg' as const, markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>' };
    const card = toBoardCard(board(), { unread: 4, mention: true, image });
    expect(card).toMatchObject({ unread: 4, mention: true, image });
    const quiet = toBoardCard(board(), { unread: 0 });
    expect(quiet.unread).toBeUndefined();
    expect(quiet.mention).toBeUndefined();
  });
});

describe('moveTargetsFor', () => {
  const owner = { id: 'u1', admin: false };

  it('lets the owner move a board to a team they are in, and not to one they are not in', () => {
    const targets = moveTargetsFor(board({ teamId: null }), owner, TEAMS);
    expect(targets.map((t) => t.name)).toEqual(['Design team', 'Retro team']);
  });

  it('gives an owner in a team Personal as well, and never the team the board is in now', () => {
    const targets = moveTargetsFor(board({ teamId: 't1' }), owner, TEAMS);
    expect(targets.map((t) => t.name)).toEqual(['Personal', 'Retro team']);
  });

  it('gives a board that is not the person\'s own no targets: an editor or a viewer cannot move it', () => {
    expect(moveTargetsFor(board({ ownerId: 'u9', role: 'editor' }), owner, TEAMS)).toEqual([]);
    expect(moveTargetsFor(board({ ownerId: 'u9', role: 'viewer' }), owner, TEAMS)).toEqual([]);
  });

  it('lets a workspace admin move any board to any team, and never to Personal (which is someone else\'s)', () => {
    const admin = { id: 'u7', admin: true };
    const targets = moveTargetsFor(board({ ownerId: 'u9', role: 'viewer', teamId: null }), admin, TEAMS);
    expect(targets.map((t) => t.name)).toEqual(['Design team', 'Retro team', 'Growth team']);
    expect(targets.some((t) => t.id === null)).toBe(false);
  });

  it('never lists an archived team', () => {
    const targets = moveTargetsFor(board({ teamId: null }), { id: 'u7', admin: true }, TEAMS);
    expect(targets.map((t) => t.name)).not.toContain('Old team');
  });

  it('offers no Personal for a board that is already personal', () => {
    expect(moveTargetsFor(board({ teamId: null }), owner, TEAMS).some((t) => t.id === null)).toBe(false);
  });
});

describe('deviceTargets and deviceCard', () => {
  it('adds a device board to Personal or to a team the person is in, not archived ones', () => {
    expect(deviceTargets(TEAMS).map((t) => t.name)).toEqual(['Personal', 'Design team', 'Retro team']);
  });

  it('makes a card for a board on this device, with its own targets', () => {
    const card = deviceCard({ id: 'd1', name: '', updatedAt: NOW }, deviceTargets(TEAMS));
    expect(card).toMatchObject({ id: 'd1', name: UNTITLED, onDevice: true, updatedAt: NOW });
    expect(card.targets?.length).toBe(3);
  });
});

describe('isMine', () => {
  it('uses the owner id, and for a list cached before owners were reported, the owner role', () => {
    expect(isMine({ ownerId: 'u1', role: 'viewer' }, 'u1')).toBe(true);
    expect(isMine({ ownerId: 'u2', role: 'owner' }, 'u1')).toBe(false);
    expect(isMine({ role: 'owner' }, 'u1')).toBe(true);
    expect(isMine({ role: 'editor' }, 'u1')).toBe(false);
  });
});

describe('dropVerdict', () => {
  const card = (over: Partial<BoardCardData> = {}): BoardCardData => ({ id: 'b1', name: 'Q4', updatedAt: NOW, ...over });
  const section = (over: Partial<BoardSection> = {}): Pick<BoardSection, 'teamId' | 'boards'> => ({ teamId: 't2', boards: [], ...over });
  const targets = [{ id: 't2', name: 'Retro team' }, { id: null, name: 'Personal' }];

  it('allows a drop on a section the board may move to', () => {
    expect(dropVerdict(section(), card({ targets }))).toBe('allowed');
    expect(dropVerdict(section({ teamId: null }), card({ targets }))).toBe('allowed');
  });

  it('refuses a drop on a team the board may not go to (a team the person is not in, or no targets at all)', () => {
    expect(dropVerdict(section({ teamId: 't3' }), card({ targets }))).toBe('refused');
    expect(dropVerdict(section(), card({ targets: [] }))).toBe('refused');
    expect(dropVerdict(section(), card())).toBe('refused');
  });

  it('refuses a drop on a section that takes no boards (Shared with you, this device)', () => {
    expect(dropVerdict(section({ teamId: undefined }), card({ targets }))).toBe('refused');
  });

  it('treats a drop on the board\'s own section as nothing to do', () => {
    const here = section({ boards: [card({ id: 'b1' })] });
    expect(dropVerdict(here, card({ targets }))).toBe('same');
  });
});

describe('the dev move stub', () => {
  const moved = 'move-stub-only';

  it('does nothing in a production build: the list is what the server sent', () => {
    vi.stubEnv('DEV', false);
    const list = [board({ id: moved, teamId: 't1' })];
    moveBoardStub(moved, 't2');
    expect(applyDevMoves(list)).toBe(list);
  });

  it('moves the board in this tab and nothing else, in dev', () => {
    vi.stubEnv('DEV', true);
    const list = [board({ id: moved, teamId: 't1' }), board({ id: 'other', teamId: 't1' })];
    moveBoardStub(moved, null);
    const out = applyDevMoves(list);
    expect(out.find((b) => b.id === moved)?.teamId).toBeNull();
    expect(out.find((b) => b.id === 'other')?.teamId).toBe('t1');
    expect(list.find((b) => b.id === moved)?.teamId).toBe('t1');
  });
});
