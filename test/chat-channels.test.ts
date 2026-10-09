import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createHarness, type Account } from './mcp-harness';

// docs/chat.md, slice 3: team channels, the workspace channel, the channel list and the settings, over a real relay in
// accounts mode with TABULA_CHAT=on. The relay is also a hosted workspace so the read-only 402 can be switched on.

const CLOUD_TOKEN = 'chat-test-cloud-token-0123456789abcdef';
const h = createHarness({
  accounts: true,
  settings: { CHAT: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'chat-ws' },
});
let owner: Account;

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
});
afterAll(() => h.cleanup());

const cid = () => crypto.randomUUID();
const WS = 'workspace/main';
const channel = (path: string) => `/api/chat/${path}`;
const send = (who: Account, path: string, text: string) => h.api(who.cookie, 'POST', channel(`${path}/messages`), { clientId: cid(), text });
const list = (who: Account, path: string) => h.api(who.cookie, 'GET', channel(`${path}/messages`));
const channels = async (who: Account) => (await h.api(who.cookie, 'GET', '/api/chat/channels')).body.channels as any[];
const internal = (body: unknown) => h.api(undefined, 'PUT', '/api/internal/limits', body, { authorization: `Bearer ${CLOUD_TOKEN}` });

async function member(role: 'member' | 'guest' = 'member') {
  const team = await h.newTeam(owner.cookie);
  const who = await h.joinTeam(owner.cookie, team.id);
  if (role === 'guest') {
    const res = await h.api(owner.cookie, 'PATCH', `/api/members/${who.user.id}`, { role: 'guest' });
    if (res.status !== 200) throw new Error(`could not make a guest (${res.status})`);
  }
  return who;
}

describe('team channels over the API', { timeout: 60_000 }, () => {
  it('lets members talk, and keeps the channel from everyone else with a 404', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const ben = await h.joinTeam(owner.cookie, team.id);
    const outsider = await member();
    const path = `team/${team.id}`;
    const said = await send(ana, path, 'Standup at ten?');
    expect(said.status).toBe(201);
    expect(said.body.message).toMatchObject({ kind: 'team', ref: team.id, authorId: ana.user.id, text: 'Standup at ten?' });
    expect((await list(ben, path)).body.messages.map((m: any) => m.text)).toEqual(['Standup at ten?']);
    expect((await list(outsider, path)).status).toBe(404);
    expect((await send(outsider, path, 'hi')).status).toBe(404);
    expect((await h.api(outsider.cookie, 'GET', channel(path))).status).toBe(404);
  });

  it('gives the people who can read it to the @ list, workspace owners included, outsiders excluded', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const outsider = await member();
    const info = await h.api(ana.cookie, 'GET', channel(`team/${team.id}`));
    const ids = info.body.people.map((p: any) => p.id);
    expect(ids).toContain(ana.user.id);
    expect(ids).toContain(owner.user.id);
    expect(ids).not.toContain(outsider.user.id);
    expect(info.body.access).toMatchObject({ write: true, moderate: false });
  });

  it('lets a workspace admin who is not a member read and remove messages but not post', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const boss = await member();
    expect((await h.api(owner.cookie, 'PATCH', `/api/members/${boss.user.id}`, { role: 'admin' })).status).toBe(200);
    const path = `team/${team.id}`;
    const said = await send(ana, path, 'keep this quiet');
    expect((await list(boss, path)).status).toBe(200);
    expect((await send(boss, path, 'hello')).status).toBe(403);
    expect((await h.api(boss.cookie, 'DELETE', `/api/chat/messages/${said.body.message.id}`)).status).toBe(204);
  });

  it('lets a team admin moderate and a plain member not', async () => {
    const team = await h.newTeam(owner.cookie);
    const admin = await h.joinTeam(owner.cookie, team.id, 'admin');
    const ana = await h.joinTeam(owner.cookie, team.id);
    const ben = await h.joinTeam(owner.cookie, team.id);
    const path = `team/${team.id}`;
    const first = await send(ana, path, 'one');
    const second = await send(ana, path, 'two');
    expect((await h.api(ben.cookie, 'DELETE', `/api/chat/messages/${first.body.message.id}`)).status).toBe(403);
    expect((await h.api(admin.cookie, 'DELETE', `/api/chat/messages/${second.body.message.id}`)).status).toBe(204);
    const rows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?action=chat.delete')).body.entries.filter((e: any) => e.detail.ref === team.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('two');
  });

  it('keeps reading and refuses writing in an archived team', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const path = `team/${team.id}`;
    expect((await send(ana, path, 'before')).status).toBe(201);
    expect((await h.api(owner.cookie, 'PATCH', `/api/teams/${team.id}`, { archived: true })).status).toBe(200);
    expect((await list(ana, path)).body.messages).toHaveLength(1);
    expect((await send(ana, path, 'after')).status).toBe(403);
    expect((await h.api(ana.cookie, 'GET', channel(path))).body.access.write).toBe(false);
  });

  it('loses the channel when a person leaves the team', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const path = `team/${team.id}`;
    expect((await list(ana, path)).status).toBe(200);
    expect((await h.api(owner.cookie, 'DELETE', `/api/teams/${team.id}/members/${ana.user.id}`)).status).toBe(204);
    expect((await list(ana, path)).status).toBe(404);
  });

  it('refuses writes with 402 while a hosted workspace is read-only, and reading goes on', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const path = `team/${team.id}`;
    await send(ana, path, 'before');
    try {
      expect((await internal({ readOnly: true })).status).toBeLessThan(300);
      expect((await send(ana, path, 'blocked')).status).toBe(402);
      expect((await list(ana, path)).status).toBe(200);
    } finally {
      await internal({ readOnly: false });
    }
  });
});

describe('the workspace channel over the API', { timeout: 60_000 }, () => {
  it('lets owners, admins and members talk and keeps guests out', async () => {
    const ana = await member();
    const guest = await member('guest');
    expect((await send(ana, WS, 'Good morning')).status).toBe(201);
    expect((await send(owner, WS, 'Hello all')).status).toBe(201);
    expect((await list(ana, WS)).body.messages.map((m: any) => m.text)).toEqual(expect.arrayContaining(['Good morning', 'Hello all']));
    expect((await list(guest, WS)).status).toBe(404);
    expect((await send(guest, WS, 'let me in')).status).toBe(404);
  });

  it('lets only owners and admins remove other people’s messages', async () => {
    const ana = await member();
    const ben = await member();
    const said = await send(ana, WS, 'oops');
    expect((await h.api(ben.cookie, 'DELETE', `/api/chat/messages/${said.body.message.id}`)).status).toBe(403);
    expect((await h.api(owner.cookie, 'DELETE', `/api/chat/messages/${said.body.message.id}`)).status).toBe(204);
  });

  it('takes the channel away while its switch is off, and gives it back', async () => {
    const ana = await member();
    expect((await send(ana, WS, 'still here')).status).toBe(201);
    expect((await h.api(ana.cookie, 'PUT', '/api/admin/chat', { workspaceChannel: false })).status).toBe(403);
    try {
      const off = await h.api(owner.cookie, 'PUT', '/api/admin/chat', { workspaceChannel: false });
      expect(off.body.workspaceChannel).toBe(false);
      expect((await list(ana, WS)).status).toBe(404);
      expect((await send(owner, WS, 'anyone?')).status).toBe(404);
      expect((await channels(ana)).some((c) => c.kind === 'workspace')).toBe(false);
    } finally {
      expect((await h.api(owner.cookie, 'PUT', '/api/admin/chat', { workspaceChannel: true })).body.workspaceChannel).toBe(true);
    }
    expect((await list(ana, WS)).body.messages.some((m: any) => m.text === 'still here')).toBe(true);
    const rows = (await h.api(owner.cookie, 'GET', '/api/admin/audit?action=chat.settings')).body.entries;
    expect(rows.some((e: any) => e.detail.workspaceChannel === false)).toBe(true);
  });

  it('rejects a workspace channel setting that is not a boolean', async () => {
    expect((await h.api(owner.cookie, 'PUT', '/api/admin/chat', { workspaceChannel: 'no' })).status).toBe(400);
  });

  it('is the 404 for any ref but its own', async () => {
    expect((await list(owner, 'workspace/other')).status).toBe(404);
  });
});

describe('the channel list', { timeout: 60_000 }, () => {
  it('lists the workspace, the person’s teams and recently active boards, with unread counts', async () => {
    const team = await h.newTeam(owner.cookie, 'Design');
    const ana = await h.joinTeam(owner.cookie, team.id);
    const ben = await h.joinTeam(owner.cookie, team.id);
    const board = await h.newBoard(ana.cookie, { title: 'Roadmap' });
    await h.share(ana.cookie, board, ben.user.id, 'commenter');
    // Ben is caught up everywhere (a first look starts a person at the newest message); then Ana speaks in all three places
    await h.api(ben.cookie, 'GET', '/api/chat/unread');
    await send(ana, `team/${team.id}`, 'team news');
    await send(ana, WS, 'workspace news');
    await send(ana, `board/${board}`, 'board news');
    const list = await channels(ben);
    const by = (kind: string, ref: string) => list.find((c) => c.kind === kind && c.ref === ref);
    expect(by('workspace', 'main')).toMatchObject({ name: 'Workspace', unread: 1, write: true });
    expect(by('team', team.id)).toMatchObject({ name: 'Design', unread: 1, member: true, write: true });
    expect(by('board', board)).toMatchObject({ unread: 1 });
    expect(by('board', board).name).toBeTruthy();
    expect(by('team', team.id).lastAt).toBeGreaterThan(0);
  });

  it('includes teams a workspace owner has not joined, marked as not a member, and no one else’s', async () => {
    const team = await h.newTeam(owner.cookie, 'Elsewhere');
    const ana = await h.joinTeam(owner.cookie, team.id);
    const stranger = await member();
    const mine = await channels(ana);
    expect(mine.some((c) => c.kind === 'team' && c.ref === team.id)).toBe(true);
    expect((await channels(stranger)).some((c) => c.kind === 'team' && c.ref === team.id)).toBe(false);
    const other = await h.newTeam(stranger.cookie, 'Strangers only');
    const asOwner = (await channels(owner)).find((c) => c.kind === 'team' && c.ref === other.id);
    expect(asOwner).toMatchObject({ member: false, write: false });
  });

  it('leaves out boards the person cannot read and boards with no recent chat', async () => {
    const ana = await member();
    const ben = await member();
    const mine = await h.newBoard(ana.cookie);
    const quiet = await h.newBoard(ana.cookie);
    await send(ana, `board/${mine}`, 'only for me');
    expect((await channels(ana)).some((c) => c.kind === 'board' && c.ref === mine)).toBe(true);
    expect((await channels(ana)).some((c) => c.kind === 'board' && c.ref === quiet)).toBe(false);
    expect((await channels(ben)).some((c) => c.kind === 'board' && c.ref === mine)).toBe(false);
  });

  it('counts a mention separately and never counts your own messages', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const ben = await h.joinTeam(owner.cookie, team.id);
    await h.api(ben.cookie, 'GET', channel(`team/${team.id}`)); // joins caught up
    await channels(ben);
    await h.api(ana.cookie, 'POST', channel(`team/${team.id}/messages`), { clientId: cid(), text: `@{${ben.user.id}} look` });
    await send(ben, `team/${team.id}`, 'my own');
    const entry = (await channels(ben)).find((c) => c.ref === team.id);
    expect(entry).toMatchObject({ unread: 1, mentions: 1 });
  });

  it('needs a session', async () => {
    expect((await h.api(undefined, 'GET', '/api/chat/channels')).status).toBe(401);
  });

  it('shows the unread of team and workspace channels in the summary', async () => {
    const team = await h.newTeam(owner.cookie);
    const ana = await h.joinTeam(owner.cookie, team.id);
    const ben = await h.joinTeam(owner.cookie, team.id);
    await channels(ben);
    await send(ana, `team/${team.id}`, 'summary');
    await send(ana, WS, 'summary');
    const summary = (await h.api(ben.cookie, 'GET', '/api/chat/unread')).body.channels as any[];
    expect(summary.find((c) => c.kind === 'team' && c.ref === team.id)?.unread).toBe(1);
    expect(summary.find((c) => c.kind === 'workspace')?.unread).toBeGreaterThanOrEqual(1);
  });
});
