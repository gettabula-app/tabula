import { describe, expect, it } from 'vitest';
import { chatAccess } from '../server/chat-access.mjs';

// docs/chat.md, "Channels and who may do what", for board channels. The directory is a table here: boardRole answers
// what the real directory would for each person (workspace owners and admins are owners of every board, guests only
// have what was shared with them, a disabled person has nothing).

type Role = 'owner' | 'editor' | 'commenter' | 'viewer' | null;
type Person = { id: string; role: string; disabled?: boolean };

const BOARD = 'board1';
const DELETED = 'gone1';

const people: Record<string, { user: Person; board: Role }> = {
  'workspace owner': { user: { id: 'u-owner', role: 'owner' }, board: 'owner' },
  'workspace admin': { user: { id: 'u-admin', role: 'admin' }, board: 'owner' },
  'member, board owner': { user: { id: 'u-bowner', role: 'member' }, board: 'owner' },
  'team admin of the board team': { user: { id: 'u-tadmin', role: 'member' }, board: 'owner' },
  'team member of the board team': { user: { id: 'u-tmember', role: 'member' }, board: 'editor' },
  'member, editor': { user: { id: 'u-editor', role: 'member' }, board: 'editor' },
  'member, commenter': { user: { id: 'u-commenter', role: 'member' }, board: 'commenter' },
  'member, viewer': { user: { id: 'u-viewer', role: 'member' }, board: 'viewer' },
  'guest given the board as commenter': { user: { id: 'u-guest-c', role: 'guest' }, board: 'commenter' },
  'guest given the board as viewer': { user: { id: 'u-guest-v', role: 'guest' }, board: 'viewer' },
  'guest not on the board': { user: { id: 'u-guest-x', role: 'guest' }, board: null },
  'member, outsider': { user: { id: 'u-outsider', role: 'member' }, board: null },
  'disabled editor': { user: { id: 'u-disabled', role: 'member', disabled: true }, board: 'editor' },
  'disabled workspace owner': { user: { id: 'u-disabled-owner', role: 'owner', disabled: true }, board: 'owner' },
};

const roles = new Map(Object.values(people).map((p) => [p.user.id, p.board]));
const deps = (extra: { readOnly?: boolean; viewersMayPost?: boolean } = {}) => ({
  getBoard: (id: string) => (id === BOARD ? { deletedAt: null } : id === DELETED ? { deletedAt: 1 } : null),
  // the real boardRole returns null for a disabled person; the access function must not depend on that alone
  boardRole: (_board: string, userId: string) => roles.get(userId) ?? null,
  ...extra,
});

const R = { read: true, write: false, moderate: false };
const RW = { read: true, write: true, moderate: false };
const RWM = { read: true, write: true, moderate: true };
type Expect = typeof R | null;

// [person, normal, read-only workspace, viewers may post]
const TABLE: [string, Expect, Expect, Expect][] = [
  ['workspace owner', RWM, R, RWM],
  ['workspace admin', RWM, R, RWM],
  ['member, board owner', RWM, R, RWM],
  ['team admin of the board team', RWM, R, RWM],
  ['team member of the board team', RW, R, RW],
  ['member, editor', RW, R, RW],
  ['member, commenter', RW, R, RW],
  ['member, viewer', R, R, RW],
  ['guest given the board as commenter', RW, R, RW],
  ['guest given the board as viewer', R, R, RW],
  ['guest not on the board', null, null, null],
  ['member, outsider', null, null, null],
  ['disabled editor', null, null, null],
  ['disabled workspace owner', null, null, null],
];

describe('chatAccess on a board channel', () => {
  it.each(TABLE)('%s', (name, normal, readOnly, viewersPost) => {
    const { user, board } = people[name];
    const pick = (a: ReturnType<typeof chatAccess>) => (a ? { read: a.read, write: a.write, moderate: a.moderate } : null);
    expect(pick(chatAccess(user, 'board', BOARD, deps()))).toEqual(normal);
    expect(pick(chatAccess(user, 'board', BOARD, deps({ readOnly: true })))).toEqual(readOnly);
    expect(pick(chatAccess(user, 'board', BOARD, deps({ viewersMayPost: true })))).toEqual(viewersPost);
    const access = chatAccess(user, 'board', BOARD, deps({ readOnly: true }));
    expect(access && { role: access.role, readOnly: access.readOnly }).toEqual(normal && { role: board, readOnly: true });
  });

  it('tells a viewer apart from other people who may not write', () => {
    expect(chatAccess(people['member, viewer'].user, 'board', BOARD, deps())).toMatchObject({ role: 'viewer', write: false, readOnly: false });
  });
});

describe('chatAccess on a deleted board', () => {
  it.each<[string, Expect]>([
    ['workspace owner', R],
    ['workspace admin', R],
    ['member, board owner', null],
    ['team admin of the board team', null],
    ['member, editor', null],
    ['member, commenter', null],
    ['member, viewer', null],
    ['guest given the board as commenter', null],
    ['disabled workspace owner', null],
  ])('%s', (name, expected) => {
    const access = chatAccess(people[name].user, 'board', DELETED, deps({ viewersMayPost: true }));
    expect(access ? { read: access.read, write: access.write, moderate: access.moderate } : null).toEqual(expected);
  });
});

describe('channels that do not exist', () => {
  const owner = people['workspace owner'].user;

  it.each<[string, unknown, unknown]>([
    ['an unknown board', 'board', 'nope'],
    ['a board id with a slash', 'board', 'a/b'],
    ['a board id with a tilde (the comments room)', 'board', `${BOARD}~comments`],
    ['an empty board id', 'board', ''],
    ['a board id that is too long', 'board', 'x'.repeat(65)],
    ['a board id that is not a string', 'board', 42],
    ['an unknown kind', 'room', BOARD],
    ['a kind that is not a string', null, BOARD],
    // team and workspace channels are a later slice: they do not exist yet for anyone
    ['a team channel', 'team', 'team1'],
    ['the workspace channel', 'workspace', ''],
  ])('%s is null even for the workspace owner', (_name, kind, ref) => {
    expect(chatAccess(owner, kind, ref, deps())).toBeNull();
  });

  it('is null without a person', () => {
    expect(chatAccess(null, 'board', BOARD, deps())).toBeNull();
    expect(chatAccess(undefined, 'board', BOARD, deps())).toBeNull();
    expect(chatAccess({ role: 'owner' } as never, 'board', BOARD, deps())).toBeNull();
  });

  it('never looks a board up for a malformed id', () => {
    let asked = 0;
    const counting = { ...deps(), getBoard: () => (asked++, { deletedAt: null }), boardRole: () => (asked++, 'owner' as const) };
    chatAccess(owner, 'board', '../etc', counting);
    expect(asked).toBe(0);
  });
});
