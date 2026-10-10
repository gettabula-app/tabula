import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { rankBetween } from '../shared/containers.mjs';
import { createHarness, until, type Account } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on' }, env: { ROOM_UNLOAD_MS: '1200' } });
const kanbanId = 'qa-v5-kanban';
const labelId = 'qa-v5-label';
let owner: Account;
let board: string;
let writeToken: { token: string; id: string };
let readToken: { token: string; id: string };

beforeAll(async () => {
  await h.start();
  const workspaceOwner = await h.signInOwner();
  const team = await h.newTeam(workspaceOwner.cookie);
  owner = await h.joinTeam(workspaceOwner.cookie, team.id);
  board = await h.newBoard(owner.cookie);
  writeToken = await h.newToken(owner.cookie, {
    name: 'v5 acceptance write token', scope: 'write', boardIds: [board],
  });
  readToken = await h.newToken(owner.cookie, {
    name: 'v5 acceptance read token', scope: 'read', boardIds: [board],
  });

  const live = h.connect(board, owner.cookie);
  await live.synced();
  const todo = { id: 'qa-v5-todo', type: 'lane', parent: kanbanId, rank: rankBetween(null, null, kanbanId), name: 'To do', stage: 'todo', x: 0, y: 0, w: 280, h: 300, rotation: 0, z: 'a0' };
  const doing = { id: 'qa-v5-doing', type: 'lane', parent: kanbanId, rank: rankBetween(todo.rank, null, kanbanId), name: 'Doing', stage: 'doing', x: 300, y: 0, w: 280, h: 300, rotation: 0, z: 'a0' };
  const done = { id: 'qa-v5-done', type: 'lane', parent: kanbanId, rank: rankBetween(doing.rank, null, kanbanId), name: 'Done', stage: 'done', x: 600, y: 0, w: 280, h: 300, rotation: 0, z: 'a0' };
  const container = { id: kanbanId, type: 'container', layout: 'kanban', name: 'QA v5', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a0' };
  live.doc.transact(() => {
    const objects = live.doc.getMap('objects');
    for (const object of [container, todo, doing, done]) objects.set(object.id, new Y.Map(Object.entries(object)));
    live.doc.getMap('labels').set(labelId, { id: labelId, name: 'QA label', color: 'blue', order: 0 });
  }, 'local');
  await until(() => h.savedDoc(board).getMap('objects').has('qa-v5-done'));
  live.provider.destroy();
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

function runCli(write: string, read: string) {
  const child = spawnSync(process.execPath, [
    path.resolve('scripts/qa-v5-acceptance.mjs'), '--url', h.base, '--board', board, '--kanban', kanbanId,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, TABULA_TOKEN_WRITE: write, TABULA_TOKEN_READ: read },
    encoding: 'utf8',
    timeout: 55_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return child;
}

function runWithoutBoard() {
  return spawnSync(process.execPath, [
    path.resolve('scripts/qa-v5-acceptance.mjs'), '--url', h.base,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, TABULA_TOKEN_WRITE: writeToken.token, TABULA_TOKEN_READ: readToken.token },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

describe('v5 kanban MCP acceptance CLI', () => {
  it('passes the local accounts-mode relay round trip and deletes its cards', () => {
    const child = runCli(writeToken.token, readToken.token);
    expect(child.error).toBeUndefined();
    if (child.status !== 0) throw new Error(child.stdout);
    expect(child.status).toBe(0);
    for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      expect(child.stdout).toMatch(new RegExp(`PASS ${number}\\.`));
    }
    expect(child.stdout).toContain('PASS summary: 13 passed, 0 failed');
    expect(child.stdout).not.toContain(writeToken.token);
    expect(child.stdout).not.toContain(readToken.token);
  });

  it('fails safely when the read token is supplied as the write token', () => {
    const child = runCli(readToken.token, readToken.token);
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stdout).toMatch(/FAIL 1\./);
    expect(child.stdout).toMatch(/FAIL 5\./);
    expect(child.stdout).not.toContain(writeToken.token);
    expect(child.stdout).not.toContain(readToken.token);
  });

  it('refuses to run without --board', () => {
    const child = runWithoutBoard();
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toContain('--board is required');
    expect(child.stdout).not.toContain(writeToken.token);
    expect(child.stdout).not.toContain(readToken.token);
  });
});
