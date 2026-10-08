import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { RestoreError } from '../server/restore.mjs';
import { HOUR, MIN, T0, docBytes, harness, type Harness } from './backup-harness';
import { audits, backedUp, backupNow, becomeB, databaseOf, filesOf, forge, ownerOf, rig, seedA, setting } from './restore-harness';

// docs/backups.md, Restoring, "One board, as a copy".

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function scenario() {
  h = await harness({ accounts: true });
  const world = seedA(h);
  const r = rig(h);
  const a = await backupNow(r.backup);
  const stateA = await backedUp(h, r.backup, a.manifest as string);
  const database = await databaseOf(h);
  h.clock.now += HOUR;
  becomeB(h);
  h.clock.now += MIN;
  return { ...r, ...world, manifest: a.manifest as string, stateA, database, actor: ownerOf(h) };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

const copy = (s: Scenario, boardId = 'b1', actor = s.actor, manifest = s.manifest) => s.restore.restoreBoardCopy({ manifest, boardId, actor });
const failure = async (promise: Promise<unknown>) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(RestoreError);
  return err as RestoreError;
};

const snapshot = (dir: string) => {
  const out = new Map<string, string>();
  for (const [file, bytes] of filesOf(dir)) out.set(file, bytes.toString('base64'));
  return out;
};
const roomFiles = () => fs.readdirSync(h.dir).filter((n) => n.endsWith('.yjs') || n.endsWith('.yjs.tmp')).sort();
const readDoc = (file: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fs.readFileSync(path.join(h.dir, file)));
  return doc;
};

describe('a board as a copy', () => {
  it('becomes a new board in the same team, owned by the person who restored it, and the live board is not touched', async () => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const result = await copy(s);

    expect(result).toMatchObject({ ok: true, teamId: s.team.id, title: 'Restored: Roadmap 2026-10-08' });
    expect(result).not.toHaveProperty('fallback');
    expect(result.boardId).toMatch(/^[A-Za-z0-9_-]{9}$/);
    expect(result.boardId).not.toBe('b1');

    // the directory
    const row = h.directory!.getBoard(result.boardId)!;
    expect(row).toMatchObject({ title: result.title, ownerId: s.actor.id, teamId: s.team.id, deletedAt: null });
    expect(h.directory!.boardRole(result.boardId, s.actor.id)).toBe('owner');
    expect(h.directory!.boardRole(result.boardId, s.member.id)).toBeNull();

    // the content of A, under the new id, with the new name in the document so the first save keeps it
    const board = readDoc(`${result.boardId}.yjs`);
    expect(board.getMap('objects').get('note')).toBe('A: board one');
    expect(board.getMap('meta').get('name')).toBe(result.title);
    expect(fs.readFileSync(path.join(h.dir, `${result.boardId}~comments.yjs`)).equals(s.stateA.get('b1~comments.yjs')!)).toBe(true);

    // the live board, its comments and its history are exactly as they were, and the copy has no history
    expect(snapshot(h.dir).get('b1.yjs')).toBe(before.get('b1.yjs'));
    for (const [file, bytes] of before) expect(snapshot(h.dir).get(file), `${file}`).toBe(bytes);
    expect(fs.existsSync(path.join(h.dir, 'history', result.boardId))).toBe(false);
    expect(h.directory!.getBoard('b1')).toMatchObject({ title: 'Roadmap', teamId: s.team.id });
    expect(setting(h.directory!, 'fixture')).toBe('B');

    // no downtime and nothing left behind
    expect(s.restore.status().maintenance).toBe(false);
    expect(s.exits).toEqual([]);
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-') || n.endsWith('.tmp'))).toEqual(['b1.yjs.tmp']);
    expect(audits(h.directory!, 10).filter((r) => r.action.startsWith('restore.')).map((r) => r.action).reverse()).toEqual(['restore.started', 'restore.done']);
    expect(audits(h.directory!, 10).find((r) => r.action === 'restore.done')).toMatchObject({ actorId: s.actor.id, detail: { kind: 'board', manifest: s.manifest, boardId: result.boardId, files: 2, fallback: false } });
    expect(s.restore.status().last).toMatchObject({ kind: 'board', result: 'done', manifest: s.manifest });
  });

  it('can be made twice, and each copy is its own board', async () => {
    const s = await scenario();
    const one = await copy(s);
    const two = await copy(s);
    expect(two.boardId).not.toBe(one.boardId);
    expect(h.directory!.getBoard(two.boardId)).not.toBeNull();
    expect(roomFiles().filter((n) => n.includes(one.boardId) || n.includes(two.boardId))).toHaveLength(4);
  });

  it('copies a board that has no comments room, and one that is personal', async () => {
    const s = await scenario();
    const result = await copy(s, 'b2');
    expect(result).toMatchObject({ ok: true, teamId: null, title: 'Restored: Retro 2026-10-08' });
    expect(result).not.toHaveProperty('fallback');
    expect(fs.existsSync(path.join(h.dir, `${result.boardId}~comments.yjs`))).toBe(false);
    expect(h.directory!.getBoard(result.boardId)).toMatchObject({ teamId: null, ownerId: s.actor.id });
    expect(audits(h.directory!, 5).find((r) => r.action === 'restore.done')!.detail.files).toBe(1);
  });

  it('copies a board that was deleted when the backup was made, as a live one', async () => {
    h = await harness({ accounts: true });
    const world = seedA(h);
    h.directory!.deleteBoard('b2');
    const r = rig(h);
    const a = await backupNow(r.backup);
    const result = await r.restore.restoreBoardCopy({ manifest: a.manifest as string, boardId: 'b2', actor: ownerOf(h) });
    expect(h.directory!.getBoard(result.boardId)!.deletedAt).toBeNull();
    expect(world.member.id).toBeTruthy();
  });

  describe('the team', () => {
    const FALLBACK = 'The original team no longer exists or you cannot see it, so the copy is in your personal space.';

    it('falls back to the personal space with the message when the team no longer exists', async () => {
      const s = await scenario();
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
      db.exec('PRAGMA foreign_keys = ON');
      db.prepare('DELETE FROM teams WHERE id = ?').run(s.team.id);
      db.close();
      const result = await copy(s);
      expect(result).toMatchObject({ ok: true, teamId: null, fallback: 'personal', message: FALLBACK });
      expect(h.directory!.getBoard(result.boardId)).toMatchObject({ teamId: null, ownerId: s.actor.id });
      expect(audits(h.directory!, 5).find((r) => r.action === 'restore.done')!.detail.fallback).toBe(true);
    });

    it('falls back when the team exists but the person is not in it', async () => {
      const s = await scenario();
      h.directory!.removeTeamMember(s.team.id, s.actor.id);
      const result = await copy(s);
      expect(result).toMatchObject({ teamId: null, fallback: 'personal', message: FALLBACK });
    });

    it('never refuses because of the team', async () => {
      const s = await scenario();
      h.directory!.updateTeam(s.team.id, { archived: true });
      h.directory!.removeTeamMember(s.team.id, s.actor.id);
      expect(await copy(s)).toMatchObject({ ok: true, fallback: 'personal' });
    });
  });

  it('keeps a long title within the limit with the date intact, and cleans control characters', async () => {
    h = await harness({ accounts: true });
    const world = seedA(h);
    h.directory!.updateBoard('b1', { title: 'T'.repeat(200) });
    h.directory!.updateBoard('b2', { title: 'Line one\nline\u0007 two end' });
    const r = rig(h);
    const a = await backupNow(r.backup);
    const long = await r.restore.restoreBoardCopy({ manifest: a.manifest as string, boardId: 'b1', actor: ownerOf(h) });
    expect(long.title.length).toBe(200);
    expect(long.title.startsWith('Restored: TTT')).toBe(true);
    expect(long.title.endsWith(' 2026-10-08')).toBe(true);
    const clean = await r.restore.restoreBoardCopy({ manifest: a.manifest as string, boardId: 'b2', actor: ownerOf(h) });
    expect(clean.title).toBe('Restored: Line one line two end 2026-10-08');
    expect(world.team.id).toBeTruthy();
  });

  it('keeps an astral character whole when it cuts a long title', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    h.directory!.updateBoard('b1', { title: '😀'.repeat(150) });
    const r = rig(h);
    const a = await backupNow(r.backup);
    const result = await r.restore.restoreBoardCopy({ manifest: a.manifest as string, boardId: 'b1', actor: ownerOf(h) });
    expect(result.title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(result.title.length).toBeLessThanOrEqual(200);
  });
});

describe('a board that cannot be copied', () => {
  const nothingChanged = (s: Scenario, before: Map<string, string>, rooms: string[]) => {
    expect(snapshot(h.dir)).toEqual(before);
    expect(roomFiles()).toEqual(rooms);
    expect(h.directory!.listBoardsAdmin({ includeDeleted: true }).map((b) => b.id).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
    expect(s.exits).toEqual([]);
  };

  it('is not in the backup', async () => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const rooms = roomFiles();
    expect((await failure(copy(s, 'b3'))).code).toBe('board_not_in_backup');
    expect((await failure(copy(s, 'nope'))).code).toBe('board_not_in_backup');
    nothingChanged(s, before, rooms);
    expect(s.restore.status().last).toMatchObject({ kind: 'board', result: 'failed', error: 'board_not_in_backup' });
    expect(audits(h.directory!, 5).find((r) => r.action === 'restore.failed')).toMatchObject({ detail: { kind: 'board', manifest: s.manifest, error: 'board_not_in_backup' } });
  });

  it('is in the database of the backup but was never saved', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    h.directory!.createBoard({ id: 'unsaved', title: 'Never saved', ownerId: ownerOf(h).id, teamId: null });
    const r = rig(h);
    const a = await backupNow(r.backup);
    const err = await failure(r.restore.restoreBoardCopy({ manifest: a.manifest as string, boardId: 'unsaved', actor: ownerOf(h) }));
    expect(err.code).toBe('board_not_in_backup');
    expect(h.directory!.listBoardsAdmin().map((b) => b.title)).not.toContain('Restored: Never saved 2026-10-08');
  });

  const forged = (s: Scenario, change: (files: { path: string; data: Buffer }[]) => { path: string; data: Buffer }[]) =>
    forge(h, change([{ path: 'directory.sqlite', data: s.database }, ...[...s.stateA].map(([p, data]) => ({ path: p, data }))]), { at: T0 + 9 * HOUR });

  it.each([
    ['the board document is not Yjs', 'b1.yjs', Buffer.from('definitely not a yjs update')],
    ['the board document is empty', 'b1.yjs', Buffer.alloc(0)],
    ['the comments document is not Yjs', 'b1~comments.yjs', Buffer.from('also not yjs, sorry')],
  ])('%s', async (_what, file, data) => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const rooms = roomFiles();
    const bad = forged(s, (f) => f.map((x) => (x.path === file ? { ...x, data } : x)));
    expect((await failure(copy(s, 'b1', s.actor, bad.name))).code).toBe('invalid_backup');
    nothingChanged(s, before, rooms);
  });

  it('has a database that is damaged, or newer than this Tabula', async () => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const rooms = roomFiles();
    const damaged = Buffer.from(s.database);
    damaged.fill(0xff, 4096 * 2, 4096 * 6);
    const one = forged(s, (f) => f.map((x) => (x.path === 'directory.sqlite' ? { ...x, data: damaged } : x)));
    expect((await failure(copy(s, 'b1', s.actor, one.name))).code).toBe('integrity_check_failed');
    const notSqlite = forge(h, [{ path: 'directory.sqlite', data: Buffer.from('plain text') }, { path: 'b1.yjs', data: docBytes('x') }], { at: T0 + 10 * HOUR });
    expect((await failure(copy(s, 'b1', s.actor, notSqlite.name))).code).toBe('integrity_check_failed');
    nothingChanged(s, before, rooms);
  });

  it('is damaged in the bucket: a flipped bit, a swapped object, a wrong size', async () => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const rooms = roomFiles();
    const one = forged(s, (f) => f);
    const target = one.entries.find((e) => e.path === 'b1.yjs')!;
    h.fake.objects.get(`tabula/objects/${target.objectId}`)!.body[30] ^= 1;
    const err = await failure(copy(s, 'b1', s.actor, one.name));
    expect(err.code).toBe('tamper');
    expect(err.message).not.toContain(target.objectId);
    const sized = forge(h, [{ path: 'directory.sqlite', data: s.database }, { path: 'b1.yjs', data: docBytes('x') }], {
      at: T0 + 11 * HOUR,
      damage: (body) => {
        body.files[1].size += 3;
        body.totals.bytes += 3;
      },
    });
    expect((await failure(copy(s, 'b1', s.actor, sized.name))).code).toBe('size_mismatch');
    nothingChanged(s, before, rooms);
  });

  it('has a manifest with a path it should not, or with another key', async () => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const rooms = roomFiles();
    const bad = forged(s, (f) => [...f, { path: 'notes.txt', data: Buffer.from('x') }]);
    expect((await failure(copy(s, 'b1', s.actor, bad.name))).code).toBe('unexpected_file');
    const other = forge(h, [{ path: 'directory.sqlite', data: s.database }], { at: T0 + 12 * HOUR, key: Buffer.alloc(32, 3) });
    expect((await failure(copy(s, 'b1', s.actor, other.name))).code).toBe('unknown_key');
    expect((await failure(copy(s, 'b1', s.actor, '20200101T000000Z.json.enc'))).code).toBe('manifest_not_found');
    expect((await failure(copy(s, 'b1', s.actor, '../manifest'))).code).toBe('bad_request');
    nothingChanged(s, before, rooms);
  });

  it('is refused for a board id that is not an id, and for people who may not create boards', async () => {
    const s = await scenario();
    for (const id of ['', 'a/b', '../b1', 'b1~comments', 'x'.repeat(65), 'a b', 3 as never]) {
      expect((await failure(copy(s, id))).code, `${String(id)}`).toBe('bad_request');
    }
    h.directory!.createUser({ email: 'guest@example.com', name: 'Guest', role: 'guest' });
    const guest = h.directory!.getUserByEmail('guest@example.com')!;
    expect((await failure(copy(s, 'b1', guest))).code).toBe('forbidden');
    h.directory!.updateUser(s.member.id, { disabled: true });
    expect((await failure(copy(s, 'b1', s.member))).code).toBe('forbidden');
    expect((await failure(copy(s, 'b1', { id: 'nobody' } as never))).code).toBe('forbidden');
    expect((await failure(copy(s, 'b1', null as never))).code).toBe('forbidden');
    expect(h.directory!.listBoardsAdmin().map((b) => b.id).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('removes what it wrote when the directory refuses the new board', async () => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const rooms = roomFiles();
    const broken = Object.create(h.directory!, { transaction: { value: () => { throw new Error('the database is on fire'); } } });
    const r = rig(h, { directory: broken });
    const err = await failure(r.restore.restoreBoardCopy({ manifest: s.manifest, boardId: 'b1', actor: s.actor }));
    expect(err.code).toBe('restore_failed');
    expect(err.message).not.toContain('fire');
    nothingChanged(s, before, rooms);
  });

  it('is refused when there is no room for the database of the backup', async () => {
    const s = await scenario();
    const before = snapshot(h.dir);
    const rooms = roomFiles();
    const r = rig(h, { statfs: async () => ({ bsize: 4096, blocks: 100, bavail: 1 }) });
    const err = await failure(r.restore.restoreBoardCopy({ manifest: s.manifest, boardId: 'b1', actor: s.actor }));
    expect(err.code).toBe('not_enough_space');
    expect(err.extra.free).toBe(4096);
    nothingChanged(s, before, rooms);
  });
});

describe('how often', () => {
  it('allows ten copies in ten minutes, and the eleventh waits', async () => {
    const s = await scenario();
    for (let i = 0; i < 10; i++) await copy(s, 'b2');
    const err = await failure(copy(s, 'b2'));
    expect(err.code).toBe('rate_limited');
    expect(err.extra.retryAfter).toBe(600);
    h.clock.now += 5 * MIN;
    expect((await failure(copy(s, 'b2'))).extra.retryAfter).toBe(300);
    h.clock.now += 5 * MIN;
    expect((await copy(s, 'b2')).ok).toBe(true);
  });

  it('does not count against the limit of whole restores', async () => {
    const s = await scenario();
    await copy(s);
    await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: 'RESTORE', actor: s.actor });
    expect(await s.exited).toBe(75);
  });
});
