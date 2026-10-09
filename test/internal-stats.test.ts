import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openChat } from '../server/chat.mjs';
import { openDirectory } from '../server/directory.mjs';

const TOKEN = 'stats-report-test-token-123456789012';
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOUD_ENV = {
  TABULA_CLOUD_TOKEN: TOKEN,
  TABULA_CLOUD_URL: 'https://cloud.example.test',
  TABULA_CLOUD_WORKSPACE_ID: 'stats-tests',
};

const tempDirs: string[] = [];
const directories: ReturnType<typeof openDirectory>[] = [];
const chats: ReturnType<typeof openChat>[] = [];

afterEach(() => {
  for (const chat of chats.splice(0)) chat.close();
  for (const directory of directories.splice(0)) directory.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function apiFor({ cloud = true, chatOn = true, authMode = 'on' }: { cloud?: boolean; chatOn?: boolean; authMode?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-internal-stats-'));
  tempDirs.push(dir);
  const env = {
    PORT: '8787',
    TABULA_AUTH: authMode,
    TABULA_OWNER_EMAIL: 'owner@example.test',
    TABULA_CHAT: chatOn ? 'on' : 'off',
    ...(cloud ? CLOUD_ENV : {}),
  };
  const config = loadConfig(env);
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  directories.push(directory);
  const chatStore = chatOn && authMode === 'on' ? openChat(path.join(dir, 'chat.sqlite')) : null;
  if (chatStore) chats.push(chatStore);
  const mailer = { send: async () => {} };
  const auth = createAuth({ directory, config, mailer });
  const cloudService = cloud
    ? {
        tokenOk: (authorization: string | undefined) => authorization === `Bearer ${TOKEN}`,
        limits: () => ({ readOnly: false }),
        seatsAvailable: () => true,
        seatUsage: () => directory.seatUsage(),
      }
    : null;
  const api = createApi({
    directory,
    auth,
    config,
    roomExists: () => false,
    events: new EventEmitter(),
    cloud: cloudService as never,
    chat: (chatStore ? { store: () => chatStore, access: () => null, hub: null } : null) as never,
    now: () => NOW,
    mailer,
  });
  return { api, directory, chatStore, databaseFile: path.join(dir, 'directory.sqlite') };
}

async function call(harness: ReturnType<typeof apiFor>, url: string, authorization?: string) {
  const response = {
    headersSent: false,
    status: 0,
    body: '',
    headerValues: new Map<string, string>(),
    setHeader(name: string, value: string) {
      this.headerValues.set(name.toLowerCase(), value);
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers ?? {})) this.headerValues.set(name.toLowerCase(), value);
    },
    end(body?: string) {
      this.body = body ?? '';
    },
  };
  const headers = authorization === undefined ? {} : { authorization };
  await harness.api.handle({ url, method: 'GET', headers } as never, response as never);
  return {
    status: response.status,
    body: response.body ? JSON.parse(response.body) : undefined,
    header: (name: string) => response.headerValues.get(name.toLowerCase()) ?? null,
  };
}

function updateAuditTime(databaseFile: string, actorId: string, action: string, ts: number) {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare('UPDATE audit SET ts = ? WHERE actor_id = ? AND action = ?').run(ts, actorId, action);
  } finally {
    db.close();
  }
}

describe('GET /api/internal/stats', () => {
  it('counts recorded usage without serialising personal or board data', async () => {
    const harness = apiFor();
    const { directory, chatStore, databaseFile } = harness;
    const owner = directory.createUser({ email: 'owner@example.test', name: 'Workspace Owner', role: 'owner' })!;
    const personalCreated = directory.createUser({
      email: 'stats.person@example.test',
      name: 'Stats Display Name Only',
      role: 'member',
    })!;
    const personalId = 'recognisable-user-id-never-return';
    const db = new DatabaseSync(databaseFile);
    try {
      db.prepare('UPDATE users SET id = ? WHERE id = ?').run(personalId, personalCreated.id);
    } finally {
      db.close();
    }
    const personal = directory.getUser(personalId)!;
    const member2 = directory.createUser({ email: 'member2@example.test', name: 'Member Two', role: 'member' })!;
    const member3 = directory.createUser({ email: 'member3@example.test', name: 'Member Three', role: 'member' })!;
    const member4 = directory.createUser({ email: 'member4@example.test', name: 'Member Four', role: 'member' })!;
    const editor = directory.createUser({ email: 'editor@example.test', name: 'Audited Editor', role: 'member' })!;
    const disabled = directory.createUser({ email: 'disabled@example.test', name: 'Disabled Member', role: 'member' })!;
    directory.updateUser(disabled.id, { disabled: true });
    const guest = directory.createUser({ email: 'guest@example.test', name: 'Guest Person', role: 'guest' })!;

    const personalBoardId = 'recognisable-board-id-never-return';
    const boardTitle = 'Board Title That Must Stay Private';
    directory.createBoard({ id: personalBoardId, title: boardTitle, ownerId: owner.id, teamId: null });
    directory.createBoard({ id: 'second-live-board', title: 'Second board', ownerId: owner.id, teamId: null });
    directory.createBoard({ id: 'deleted-board', title: 'Deleted board', ownerId: owner.id, teamId: null });
    directory.deleteBoard('deleted-board');

    directory.createSession(personal.id, { ttlMs: 60 * DAY_MS, now: NOW - 7 * DAY_MS + 1 });
    directory.createSession(member2.id, { ttlMs: 60 * DAY_MS, now: NOW - 7 * DAY_MS - 1 });
    directory.createSession(member3.id, { ttlMs: 60 * DAY_MS, now: NOW - 30 * DAY_MS + 1 });
    directory.createSession(member4.id, { ttlMs: 60 * DAY_MS, now: NOW - 30 * DAY_MS - 1 });

    directory.audit(personal.id, 'board.update', { boardId: personalBoardId, title: boardTitle });
    updateAuditTime(databaseFile, personal.id, 'board.update', NOW - 2 * DAY_MS);
    directory.audit(editor.id, 'board.update', { boardId: personalBoardId, title: boardTitle });
    updateAuditTime(databaseFile, editor.id, 'board.update', NOW - 2 * DAY_MS);
    directory.audit(owner.id, 'ai.generate', { boardId: personalBoardId });
    updateAuditTime(databaseFile, owner.id, 'ai.generate', NOW - 5 * DAY_MS);
    directory.audit(owner.id, 'ai.key.test', { boardId: personalBoardId });
    updateAuditTime(databaseFile, owner.id, 'ai.key.test', NOW - 5 * DAY_MS);

    chatStore!.insertMessage({
      kind: 'workspace', ref: 'main', authorId: personal.id, authorName: personal.name,
      body: 'private chat content', clientId: 'message-one', now: NOW - 1,
    });
    chatStore!.insertMessage({
      kind: 'workspace', ref: 'main', authorId: guest.id, authorName: guest.name,
      body: 'another message', clientId: 'message-two', now: NOW - 1,
    });
    const deletedMessage = chatStore!.insertMessage({
      kind: 'workspace', ref: 'main', authorId: member2.id, authorName: member2.name,
      body: 'deleted message', clientId: 'deleted-message', now: NOW - 1,
    }).message;
    chatStore!.deleteMessage(deletedMessage.id, owner.id, NOW);

    const response = await call(harness, '/api/internal/stats', `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      boards: 2,
      members: { active: 6, disabled: 1 },
      guests: 1,
      activePeople: { last7d: 2, last30d: 4 },
      aiRuns: { last30d: 1 },
      chatMessages: 2,
    });

    const body = response.body;
    expect(Object.keys(body).sort()).toEqual(['activePeople', 'aiRuns', 'boards', 'chatMessages', 'guests', 'members'].sort());
    expect(Object.keys(body.members).sort()).toEqual(['active', 'disabled']);
    expect(Object.keys(body.activePeople).sort()).toEqual(['last30d', 'last7d']);
    expect(Object.keys(body.aiRuns)).toEqual(['last30d']);
    expect([body.boards, body.members.active, body.members.disabled, body.guests, body.activePeople.last7d,
      body.activePeople.last30d, body.aiRuns.last30d, body.chatMessages].every(Number.isFinite)).toBe(true);

    const serialized = JSON.stringify(body);
    for (const personalString of [
      'stats.person@example.test', 'Stats Display Name Only', boardTitle, personalId, personalBoardId, TOKEN, 'private chat content',
    ]) {
      expect(serialized).not.toContain(personalString);
    }

    const usage = await call(harness, '/api/internal/usage', `Bearer ${TOKEN}`);
    expect(usage.status).toBe(200);
    expect(body.members.active).toBe(usage.body.seats);
    expect(body.guests).toBe(usage.body.guests);
    expect(body.members.active + body.members.disabled + body.guests).toBe(usage.body.members);
  });

  it('uses the same bearer refusal and cloud-mode 404 as internal/version', async () => {
    const hosted = apiFor();
    for (const authorization of [undefined, 'Bearer wrong-stats-token']) {
      const stats = await call(hosted, '/api/internal/stats', authorization);
      const version = await call(hosted, '/api/internal/version', authorization);
      expect(stats.status).toBe(version.status);
      expect(stats.body).toEqual(version.body);
      expect(stats.status).toBe(401);
      expect(stats.header('www-authenticate')).toBe('Bearer');
    }

    const open = apiFor({ cloud: false, chatOn: false, authMode: 'off' });
    const statsAbsent = await call(open, '/api/internal/stats', `Bearer ${TOKEN}`);
    const versionAbsent = await call(open, '/api/internal/version', `Bearer ${TOKEN}`);
    expect(statsAbsent.status).toBe(404);
    expect(statsAbsent.status).toBe(versionAbsent.status);
  });

  it('reports zero chat messages when chat is disabled', async () => {
    const harness = apiFor({ chatOn: false });
    const response = await call(harness, '/api/internal/stats', `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.body.chatMessages).toBe(0);
  });
});
