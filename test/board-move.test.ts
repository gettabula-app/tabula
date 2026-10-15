import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { canMoveBoard } from '../server/board-move.mjs';

type Role = 'owner' | 'admin' | 'member' | 'guest';
type User = NonNullable<ReturnType<ReturnType<typeof openDirectory>['createUser']>>;
type Account = { user: User; cookie: string };
type World = Awaited<ReturnType<typeof setup>>;
const worlds: World[] = [];
let serial = 0;

async function setup({ readOnly = false }: { readOnly?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-board-move-'));
  const clock = { now: Date.now() };
  const config = loadConfig({
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'workspace-owner@example.test',
    DATA_DIR: root,
    TABULA_MAIL: 'file',
  }, () => {});
  const directory = openDirectory(path.join(root, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} }, now: () => clock.now });
  const events = new EventEmitter();
  const cloud = readOnly ? { limits: () => ({ readOnly: true }) } : null;
  const api = createApi({
    directory, auth, config, roomExists: () => false, events,
    now: () => clock.now, cloud: cloud as never,
    dataDir: root, mailer: { send: async () => {} },
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function signIn(role: Role = 'member', name = `${role} ${++serial}`): Account {
    const user = directory.createUser({ email: `move-${++serial}@example.test`, name, role })!;
    const session = directory.createSession(user.id, { ttlMs: 24 * 60 * 60_000, now: clock.now });
    return { user, cookie: `${config.cookieName}=${session.token}` };
  }

  async function call(
    who: Account | null,
    method: string,
    urlPath: string,
    body?: unknown,
    headers: Record<string, string> = {},
    csrf = true,
  ) {
    const response = await fetch(base + urlPath, {
      method,
      headers: {
        ...(csrf ? { 'x-tabula': '1' } : {}),
        ...(who ? { cookie: who.cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }

  let boardSerial = 0;
  const newBoard = (owner: Account, teamId: string | null = null, title = 'Move board') => {
    const board = directory.createBoard({ id: `move_board_${++boardSerial}`, title, ownerId: owner.user.id, teamId });
    if (!board) throw new Error('board creation failed');
    return board;
  };
  const newTeam = (creator: Account, name = `Move team ${++serial}`) => {
    const team = directory.createTeam({ name, creatorId: creator.user.id });
    if (!team) throw new Error('team creation failed');
    return team;
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    directory.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { api, base, call, close, clock, config, directory, events, newBoard, newTeam, signIn };
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

const permissionInput = (overrides: {
  user?: Partial<{ id: string; role: string; disabled: boolean }>;
  board?: Partial<{ ownerId: string | null; deletedAt: number | null }>;
  source?: Partial<{ id: string | null; role: string | null; exists: boolean; hasEnabledAdmin: boolean }>;
  dest?: Partial<{ id: string | null; role: string | null; exists: boolean }>;
} = {}) => ({
  user: { id: 'creator', role: 'member', disabled: false, ...overrides.user },
  board: { ownerId: 'creator', deletedAt: null, ...overrides.board },
  source: { id: 'source', role: 'member', exists: true, hasEnabledAdmin: true, ...overrides.source },
  dest: { id: 'destination', role: 'member', exists: true, ...overrides.dest },
});

describe('canMoveBoard permission table', () => {
  const rows = [
    {
      name: 'workspace owner can move any board to an existing team without membership',
      input: permissionInput({ user: { id: 'owner', role: 'owner' }, board: { ownerId: 'someone-else' }, dest: { role: null } }),
      expected: { ok: true, override: 'admin' },
    },
    {
      name: 'workspace admin can move any board to Personal',
      input: permissionInput({ user: { id: 'admin', role: 'admin' }, board: { ownerId: 'someone-else' }, dest: { id: null, exists: true, role: null } }),
      expected: { ok: true, override: 'admin' },
    },
    {
      name: 'workspace admin cannot use a missing destination',
      input: permissionInput({ user: { id: 'admin', role: 'admin' }, dest: { exists: false } }),
      expected: { ok: false, reason: 'destination_missing' },
    },
    {
      name: 'creator can move a Personal board into a team they belong to',
      input: permissionInput({ source: { id: null, role: null, hasEnabledAdmin: false } }),
      expected: { ok: true, override: 'creator' },
    },
    {
      name: 'creator can move between teams when in both, even if the source has an admin',
      input: permissionInput({ source: { hasEnabledAdmin: true }, dest: { role: 'member' } }),
      expected: { ok: true, override: 'creator' },
    },
    {
      name: 'creator can move a team board to Personal when the source has no enabled admin',
      input: permissionInput({ dest: { id: null, exists: true, role: null }, source: { hasEnabledAdmin: false } }),
      expected: { ok: true, override: 'creator' },
    },
    {
      name: 'creator cannot move a team board to Personal while an enabled source admin remains',
      input: permissionInput({ dest: { id: null, exists: true, role: null }, source: { hasEnabledAdmin: true } }),
      expected: { ok: false, reason: 'source_has_admin' },
    },
    {
      name: 'creator who left the source team has no standing to move the board',
      input: permissionInput({ source: { role: null } }),
      expected: { ok: false, reason: 'source_membership_required' },
    },
    {
      name: 'creator whose workspace role became guest is denied',
      input: permissionInput({ user: { role: 'guest' } }),
      expected: { ok: false, reason: 'user_unavailable' },
    },
    {
      name: 'disabled member is denied',
      input: permissionInput({ user: { disabled: true } }),
      expected: { ok: false, reason: 'user_unavailable' },
    },
    {
      name: 'guest is denied',
      input: permissionInput({ user: { role: 'guest' } }),
      expected: { ok: false, reason: 'user_unavailable' },
    },
    {
      name: 'plain member who is not the creator is denied',
      input: permissionInput({ user: { id: 'member' }, board: { ownerId: 'creator' } }),
      expected: { ok: false, reason: 'not_creator' },
    },
    {
      name: 'team admin who is not the creator is denied',
      input: permissionInput({ user: { id: 'team-admin' }, board: { ownerId: 'creator' }, source: { role: 'admin' } }),
      expected: { ok: false, reason: 'not_creator' },
    },
    {
      name: 'creator cannot move to a team they do not belong to',
      input: permissionInput({ dest: { role: null } }),
      expected: { ok: false, reason: 'destination_unavailable' },
    },
    {
      name: 'missing and unusable creator destinations have the same permission result',
      input: permissionInput({ dest: { role: null, exists: false } }),
      expected: { ok: false, reason: 'destination_unavailable' },
    },
    {
      name: 'a board in the trash is denied',
      input: permissionInput({ board: { deletedAt: 1 } }),
      expected: { ok: false, reason: 'board_deleted' },
    },
    {
      name: 'same-team move is a no-op, not a permitted move',
      input: permissionInput({ dest: { id: 'source' } }),
      expected: { ok: false, reason: 'same_team' },
    },
  ];

  it.each(rows)('$name', ({ input, expected }) => {
    expect(canMoveBoard(input)).toEqual(expected);
  });
});

describe('board move API', () => {
  it('moves a board in one transaction, records the exact audit and emits access-changed once', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const destination = world.newTeam(creator);
    const board = world.newBoard(creator);
    const events: unknown[] = [];
    world.events.on('access-changed', (event) => events.push(event));

    const response = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: null });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: board.id, teamId: destination.id, role: 'owner', title: board.title });
    expect(world.directory.getBoard(board.id)?.teamId).toBe(destination.id);
    expect(world.directory.listAudit(10).filter((row) => row.action === 'board.move').map((row) => row.detail)).toEqual([{
      boardId: board.id,
      from: null,
      to: destination.id,
      by: creator.user.id,
      override: 'creator',
    }]);
    expect(events).toEqual([{ boardId: board.id }]);
  });

  it('lets a workspace admin move a board to a team they do not belong to', async () => {
    const world = await setup();
    worlds.push(world);
    const admin = world.signIn('admin', 'Workspace admin');
    const creator = world.signIn('member', 'Board creator');
    const teamCreator = world.signIn('member', 'Team creator');
    const destination = world.newTeam(teamCreator);
    const board = world.newBoard(creator);

    const response = await world.call(admin, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: null });
    expect(response.status).toBe(200);
    expect(response.body.teamId).toBe(destination.id);
    expect(world.directory.listAudit(10).find((row) => row.action === 'board.move')?.detail).toMatchObject({ override: 'admin', from: null, to: destination.id, by: admin.user.id });
  });

  it('lets a creator move a board between teams even when the source has an admin', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const sourceAdmin = world.signIn('member', 'Source admin');
    const destAdmin = world.signIn('member', 'Destination admin');
    const source = world.newTeam(sourceAdmin);
    const destination = world.newTeam(destAdmin);
    world.directory.addTeamMember(source.id, creator.user.id, 'member');
    world.directory.addTeamMember(destination.id, creator.user.id, 'member');
    const board = world.newBoard(creator, source.id);

    const response = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: source.id });
    expect(response.status).toBe(200);
    expect(response.body.teamId).toBe(destination.id);
    expect(world.directory.getTeamRole(source.id, sourceAdmin.user.id)).toBe('admin');
    expect(world.directory.listAudit(10).find((row) => row.action === 'board.move')?.detail).toMatchObject({ override: 'creator' });
  });

  it('lets a creator move a team board to Personal only after the source has no enabled admin', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const formerAdmin = world.signIn('member', 'Former admin');
    const source = world.newTeam(formerAdmin);
    world.directory.addTeamMember(source.id, creator.user.id, 'member');
    world.directory.updateUser(formerAdmin.user.id, { disabled: true });
    expect(world.directory.getTeamRole(source.id, formerAdmin.user.id)).toBe('admin');
    const board = world.newBoard(creator, source.id);

    const response = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: null, expectedTeamId: source.id });
    expect(response.status).toBe(200);
    expect(response.body.teamId).toBeNull();
    expect(world.directory.listAudit(10).find((row) => row.action === 'board.move')?.detail).toMatchObject({ override: 'creator', to: null });
  });

  it('uses the same forbidden reply for a foreign or missing destination', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const outsider = world.signIn('member', 'Outsider');
    const source = world.newTeam(creator);
    const foreign = world.newTeam(outsider);
    world.directory.addTeamMember(source.id, creator.user.id, 'member');
    const board = world.newBoard(creator, source.id);
    const tryMove = (to: string) => world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to, expectedTeamId: source.id });

    const realForeign = await tryMove(foreign.id);
    const missing = await tryMove('team_does_not_exist');
    expect(realForeign.status).toBe(403);
    expect(missing.status).toBe(realForeign.status);
    expect(missing.body).toEqual(realForeign.body);
    expect(realForeign.body).toMatchObject({ error: 'forbidden', message: 'You cannot move this board there' });
  });

  it('denies a creator removed from the source team and a creator demoted to guest', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const sourceAdmin = world.signIn('member', 'Source admin');
    const destinationAdmin = world.signIn('member', 'Destination admin');
    const source = world.newTeam(sourceAdmin);
    const destination = world.newTeam(destinationAdmin);
    world.directory.addTeamMember(source.id, creator.user.id, 'member');
    world.directory.addTeamMember(destination.id, creator.user.id, 'member');
    const board = world.newBoard(creator, source.id);
    world.directory.removeTeamMember(source.id, creator.user.id);
    const removed = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: source.id });
    expect(removed.status).toBe(403);

    world.directory.addTeamMember(source.id, creator.user.id, 'member');
    world.directory.updateUser(creator.user.id, { role: 'guest' });
    const guestCreator = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: source.id });
    expect(guestCreator.status).toBe(403);
  });

  it('returns 404 for boards the caller cannot open and for boards in the trash', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const outsider = world.signIn('member', 'Outsider');
    const team = world.newTeam(creator);
    const board = world.newBoard(creator, team.id);
    const hidden = await world.call(outsider, 'POST', `/api/boards/${board.id}/move`, { to: null, expectedTeamId: team.id });
    expect(hidden.status).toBe(404);

    world.directory.deleteBoard(board.id);
    const trashed = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: null, expectedTeamId: team.id });
    expect(trashed.status).toBe(404);
  });

  it('requires both POST fields, treats null as Personal, and rejects a stale source with 409 board_moved', async () => {
    const world = await setup();
    worlds.push(world);
    const admin = world.signIn('owner', 'Owner');
    const team = world.newTeam(world.signIn('member', 'Team creator'));
    const board = world.newBoard(admin);

    expect((await world.call(admin, 'POST', `/api/boards/${board.id}/move`, { to: team.id })).status).toBe(400);
    expect((await world.call(admin, 'POST', `/api/boards/${board.id}/move`, { expectedTeamId: null })).status).toBe(400);
    const intoTeam = await world.call(admin, 'POST', `/api/boards/${board.id}/move`, { to: team.id, expectedTeamId: null });
    expect(intoTeam.status).toBe(200);
    const stale = await world.call(admin, 'POST', `/api/boards/${board.id}/move`, { to: null, expectedTeamId: null });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('board_moved');
    world.clock.now += 10_001;
    const back = await world.call(admin, 'POST', `/api/boards/${board.id}/move`, { to: null, expectedTeamId: team.id });
    expect(back.status).toBe(200);
    expect(back.body.teamId).toBeNull();
  });

  it('returns an unchanged no-op without an audit or access event', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const member = world.signIn('member', 'Plain member');
    const source = world.newTeam(creator);
    world.directory.addTeamMember(source.id, member.user.id, 'member');
    const board = world.newBoard(creator, source.id);
    const events: unknown[] = [];
    world.events.on('access-changed', (event) => events.push(event));

    const moved = await world.call(member, 'POST', `/api/boards/${board.id}/move`, { to: source.id, expectedTeamId: source.id });
    const patched = await world.call(member, 'PATCH', `/api/boards/${board.id}`, { teamId: source.id });
    expect(moved.status).toBe(200);
    expect(patched.status).toBe(200);
    expect(world.directory.getBoard(board.id)?.teamId).toBe(source.id);
    expect(world.directory.listAudit(20).filter((row) => row.action === 'board.move' || row.action === 'board.update')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rejects move attempts through PATCH by a non-creator member, a team admin, and a guest', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const sourceAdmin = world.signIn('member', 'Team admin');
    const plainMember = world.signIn('member', 'Plain member');
    const guest = world.signIn('guest', 'Guest');
    const viewer = world.signIn('member', 'Viewer');
    const commenter = world.signIn('member', 'Commenter');
    const destinationCreator = world.signIn('member', 'Destination creator');
    const source = world.newTeam(sourceAdmin);
    const destination = world.newTeam(destinationCreator);
    world.directory.addTeamMember(source.id, creator.user.id, 'member');
    world.directory.addTeamMember(source.id, plainMember.user.id, 'member');
    world.directory.addTeamMember(destination.id, creator.user.id, 'member');
    const board = world.newBoard(creator, source.id);
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: guest.user.id, role: 'viewer' });
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: viewer.user.id, role: 'viewer' });
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: commenter.user.id, role: 'commenter' });

    for (const who of [plainMember, sourceAdmin, guest, viewer, commenter]) {
      const response = await world.call(who, 'PATCH', `/api/boards/${board.id}`, { teamId: destination.id });
      expect(response.status).toBe(403);
      expect(response.body.message).toBe('You cannot move this board there');
    }
    expect(world.directory.getBoard(board.id)?.teamId).toBe(source.id);
  });

  it('keeps title-only PATCH behavior and uses board.move for a PATCH that changes teams', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const destination = world.newTeam(creator);
    const board = world.newBoard(creator);

    const renamed = await world.call(creator, 'PATCH', `/api/boards/${board.id}`, { title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe('Renamed');
    const moved = await world.call(creator, 'PATCH', `/api/boards/${board.id}`, { teamId: destination.id });
    expect(moved.status).toBe(200);
    expect(moved.body.teamId).toBe(destination.id);
    const rows = world.directory.listAudit(10);
    expect(rows.filter((row) => row.action === 'board.move').map((row) => row.detail)).toEqual([{
      boardId: board.id,
      from: null,
      to: destination.id,
      by: creator.user.id,
      override: 'creator',
    }]);
    expect(rows.find((row) => row.action === 'board.update')?.detail).toEqual({ boardId: board.id, title: 'Renamed' });
  });

  it('rejects bearer, MCP, OAuth and AI token headers, and requires CSRF for POST', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const team = world.newTeam(creator);
    const board = world.newBoard(creator);
    const movePath = `/api/boards/${board.id}/move`;

    const bearer = await world.call(null, 'POST', movePath, { to: team.id, expectedTeamId: null }, { authorization: 'Bearer mcp-token' });
    const aiKey = await world.call(null, 'GET', `/api/boards/${board.id}/move-preview?to=${team.id}`, undefined, { 'x-api-key': 'ai-token' });
    expect(bearer.status).toBe(403);
    expect(bearer.body.error).toBe('forbidden');
    expect(aiKey.status).toBe(403);
    expect(aiKey.body.error).toBe('forbidden');

    const noCsrf = await world.call(creator, 'POST', movePath, { to: team.id, expectedTeamId: null }, {}, false);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error).toBe('csrf');
  });

  it('refuses moves while the workspace is read-only with 402', async () => {
    const world = await setup({ readOnly: true });
    worlds.push(world);
    const owner = world.signIn('owner', 'Owner');
    const team = world.newTeam(world.signIn('member', 'Team creator'));
    const board = world.newBoard(owner);
    const response = await world.call(owner, 'POST', `/api/boards/${board.id}/move`, { to: team.id, expectedTeamId: null });
    expect(response.status).toBe(402);
    expect(response.body.error).toBe('read_only');
  });

  it('limits members to 20 moves and workspace admins to 100 moves per hour', async () => {
    const memberWorld = await setup();
    worlds.push(memberWorld);
    const member = memberWorld.signIn('member', 'Member creator');
    const memberTeam = memberWorld.newTeam(member);
    const memberBoards = Array.from({ length: 21 }, () => memberWorld.newBoard(member));
    for (const [index, board] of memberBoards.entries()) {
      const response = await memberWorld.call(member, 'POST', `/api/boards/${board.id}/move`, { to: memberTeam.id, expectedTeamId: null });
      expect(response.status).toBe(index < 20 ? 200 : 429);
    }

    const adminWorld = await setup();
    worlds.push(adminWorld);
    const admin = adminWorld.signIn('admin', 'Workspace admin');
    const teamCreator = adminWorld.signIn('member', 'Team creator');
    const adminTeam = adminWorld.newTeam(teamCreator);
    const adminBoards = Array.from({ length: 101 }, () => adminWorld.newBoard(admin));
    for (const [index, board] of adminBoards.entries()) {
      const response = await adminWorld.call(admin, 'POST', `/api/boards/${board.id}/move`, { to: adminTeam.id, expectedTeamId: null });
      expect(response.status).toBe(index < 100 ? 200 : 429);
    }
  });

  it('limits a board to one move per ten seconds and previews to 60 per minute', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.signIn('owner', 'Owner');
    const team = world.newTeam(world.signIn('member', 'Team creator'));
    const board = world.newBoard(owner);
    const first = await world.call(owner, 'POST', `/api/boards/${board.id}/move`, { to: team.id, expectedTeamId: null });
    const quickUndo = await world.call(owner, 'POST', `/api/boards/${board.id}/move`, { to: null, expectedTeamId: team.id });
    expect(first.status).toBe(200);
    expect(quickUndo.status).toBe(429);
    expect(quickUndo.body.error).toBe('rate_limited');
    expect(world.directory.getBoard(board.id)?.teamId).toBe(team.id);

    const previewBoard = world.newBoard(owner);
    for (let index = 0; index < 61; index++) {
      const preview = await world.call(owner, 'GET', `/api/boards/${previewBoard.id}/move-preview?to=${team.id}`);
      expect(preview.status).toBe(index < 60 ? 200 : 429);
    }
  });

  it('simulates real role changes in preview, rolls the transaction back, and counts the same after moving', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const loser = world.signIn('member', 'Losing member');
    const gainer = world.signIn('member', 'Gaining member');
    const stays = world.signIn('member', 'Explicit share');
    const source = world.newTeam(creator, 'Source team');
    const destination = world.newTeam(creator, 'Destination team');
    world.directory.addTeamMember(source.id, loser.user.id, 'member');
    world.directory.addTeamMember(destination.id, gainer.user.id, 'member');
    const board = world.newBoard(creator, source.id);
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: stays.user.id, role: 'commenter' });
    const auditsBefore = world.directory.db.prepare('SELECT COUNT(*) AS n FROM audit').get()!.n;

    const preview = await world.call(creator, 'GET', `/api/boards/${board.id}/move-preview?to=${destination.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({
      losing: 1,
      gaining: 1,
      sharesKept: 1,
      losingNames: ['Losing member'],
      gainingNames: ['Gaining member'],
    });
    expect(world.directory.getBoard(board.id)?.teamId).toBe(source.id);
    expect(world.directory.db.prepare('SELECT COUNT(*) AS n FROM audit').get()!.n).toBe(auditsBefore);

    const moved = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: source.id });
    expect(moved.status).toBe(200);
    expect(world.directory.boardRole(board.id, loser.user.id)).toBeNull();
    expect(world.directory.boardRole(board.id, stays.user.id)).toBe('commenter');
    expect(world.directory.boardRole(board.id, gainer.user.id)).toBe('editor');
  });

  it('proves directory transactions roll back thrown writes', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator');
    const source = world.newTeam(creator);
    const destination = world.newTeam(creator);
    const board = world.newBoard(creator, source.id);
    const error = new Error('rollback probe');

    expect(() => world.directory.transaction(() => {
      world.directory.updateBoard(board.id, { teamId: destination.id });
      world.directory.audit(creator.user.id, 'board.move', { boardId: board.id });
      throw error;
    })).toThrow(error);
    expect(world.directory.getBoard(board.id)?.teamId).toBe(source.id);
    expect(world.directory.listAudit(10).filter((row) => row.action === 'board.move')).toEqual([]);
  });

  it('keeps explicit shares, join codes, and creator access unchanged after a move', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.signIn('owner', 'Owner');
    const creator = world.signIn('member', 'Creator');
    const viewer = world.signIn('member', 'Viewer');
    const source = world.newTeam(creator, 'Old team');
    const destination = world.newTeam(world.signIn('member', 'New team owner'), 'New team');
    const board = world.newBoard(creator, source.id);
    world.directory.shareBoard(board.id, { principalType: 'user', principalId: viewer.user.id, role: 'viewer' });
    world.directory.shareBoard(board.id, { principalType: 'team', principalId: source.id, role: 'commenter' });
    const code = world.directory.createJoinCode({
      boardId: board.id,
      createdBy: creator.user.id,
      codeHash: 'test-code-hash',
      role: 'editor',
      createdAt: world.clock.now,
      expiresAt: world.clock.now + 60 * 60_000,
      maxUses: 10,
    })!;
    const sharesBefore = world.directory.listShares(board.id);
    const codeBefore = world.directory.getJoinCode(code.id);

    const moved = await world.call(owner, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: source.id });
    expect(moved.status).toBe(200);
    expect(world.directory.boardRole(board.id, creator.user.id)).toBe('owner');
    expect(world.directory.boardRole(board.id, viewer.user.id)).toBe('viewer');
    expect(world.directory.listShares(board.id)).toEqual(sharesBefore);
    expect(world.directory.getJoinCode(code.id)).toEqual(codeBefore);
  });

  it('notifies the creator after an admin override and keeps the notification list readable', async () => {
    const world = await setup();
    worlds.push(world);
    const admin = world.signIn('owner', 'Workspace owner');
    const creator = world.signIn('member', 'Creator');
    const team = world.newTeam(world.signIn('member', 'Team creator'));
    const board = world.newBoard(creator, null, 'Private title');

    const moved = await world.call(admin, 'POST', `/api/boards/${board.id}/move`, { to: team.id, expectedTeamId: null });
    expect(moved.status).toBe(200);
    const row = world.directory.db.prepare('SELECT user_id, kind, actor_id, board_id, team_id, ref FROM user_notifications WHERE user_id = ?').get(creator.user.id);
    expect(row).toEqual({ user_id: creator.user.id, kind: 'board_moved', actor_id: admin.user.id, board_id: board.id, team_id: team.id, ref: null });
    expect(JSON.stringify(row)).not.toContain('Private title');
    const listed = await world.call(creator, 'GET', '/api/notifications');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toContainEqual(expect.objectContaining({ kind: 'board_moved', board: expect.objectContaining({ id: board.id }) }));
  });

  it('notifies enabled source-team admins when the creator moves out, skipping the mover', async () => {
    const world = await setup();
    worlds.push(world);
    const creator = world.signIn('member', 'Creator mover');
    const sourceAdmin = world.signIn('member', 'Source team admin');
    const secondSourceAdmin = world.signIn('member', 'Second source admin');
    const disabledAdmin = world.signIn('member', 'Disabled source admin');
    const destinationAdmin = world.signIn('member', 'Destination team admin');
    const source = world.newTeam(sourceAdmin);
    const destination = world.newTeam(destinationAdmin);
    world.directory.addTeamMember(source.id, secondSourceAdmin.user.id, 'admin');
    world.directory.addTeamMember(source.id, disabledAdmin.user.id, 'admin');
    world.directory.updateUser(disabledAdmin.user.id, { disabled: true });
    world.directory.addTeamMember(source.id, creator.user.id, 'member');
    world.directory.addTeamMember(destination.id, creator.user.id, 'member');
    const board = world.newBoard(creator, source.id, 'Do not reveal after access is lost');

    const moved = await world.call(creator, 'POST', `/api/boards/${board.id}/move`, { to: destination.id, expectedTeamId: source.id });
    expect(moved.status).toBe(200);
    const row = world.directory.db.prepare('SELECT user_id, kind, actor_id, board_id, team_id, ref FROM user_notifications WHERE user_id = ?').get(sourceAdmin.user.id);
    expect(row).toEqual({ user_id: sourceAdmin.user.id, kind: 'board_moved_out', actor_id: creator.user.id, board_id: board.id, team_id: source.id, ref: null });
    expect(world.directory.db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND kind = ?').get(secondSourceAdmin.user.id, 'board_moved_out')!.n).toBe(1);
    expect(world.directory.db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ?').get(disabledAdmin.user.id)!.n).toBe(0);
    expect(world.directory.db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ?').get(creator.user.id)!.n).toBe(0);
    expect(world.directory.boardRole(board.id, sourceAdmin.user.id)).toBeNull();

    const listed = await world.call(sourceAdmin, 'GET', '/api/notifications');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toContainEqual(expect.objectContaining({ kind: 'board_moved_out', board: null }));
    expect(JSON.stringify(listed.body)).not.toContain('Do not reveal after access is lost');
  });
});
