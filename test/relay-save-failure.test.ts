import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';

// A save that cannot finish (on Windows: the target is held open by another process; here: a directory stands where the
// room file should be) must not take the relay down. The room stays dirty and the save is retried.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on' } });
let owner: Account;
let board: string;

beforeAll(async () => {
  await h.start();
  const workspaceOwner = await h.signInOwner();
  const team = await h.newTeam(workspaceOwner.cookie);
  owner = await h.joinTeam(workspaceOwner.cookie, team.id);
  board = await h.newBoard(owner.cookie);
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('a save that fails', () => {
  it('keeps the relay up, logs it, and saves once the target can be replaced', async () => {
    const client = h.connect(board, owner.cookie);
    await client.synced();
    const objects = client.doc.getMap('objects');
    const file = h.roomFile(board);

    client.doc.transact(() => objects.set('s1', new Y.Map(Object.entries({ id: 's1', type: 'sticky', text: 'first', x: 0, y: 0, w: 192, h: 192 }))), 'local');
    await until(() => fs.existsSync(file));

    // block the target: a rename onto a non-empty directory fails, and keeps failing
    fs.rmSync(file);
    fs.mkdirSync(file);
    fs.writeFileSync(`${file}/keep`, 'x');
    client.doc.transact(() => objects.set('s2', new Y.Map(Object.entries({ id: 's2', type: 'sticky', text: 'second', x: 0, y: 0, w: 192, h: 192 }))), 'local');
    await until(() => /could not save, will retry/.test(h.output()));

    // the relay is still answering
    expect((await h.api(owner.cookie, 'GET', '/api/health')).status).toBeLessThan(500);

    // unblock: the retry saves both stickies
    fs.rmSync(file, { recursive: true, force: true });
    await until(() => fs.existsSync(file) && fs.statSync(file).isFile(), 30_000);
    await until(() => h.savedDoc(board).getMap('objects').has('s2'), 30_000);
    expect(h.savedDoc(board).getMap('objects').has('s1')).toBe(true);
    client.provider.destroy();
  });
});
