import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { RestoreError } from '../server/restore.mjs';
import { checkTrackerData } from '../server/tracker/backup-check.mjs';
import { commentTicket, createTicket } from '../server/tracker/tickets.mjs';
import { HOUR, T0, harness, type Harness } from './backup-harness';
import { audits, backupNow, ownerOf, reopen, rig, seedA } from './restore-harness';

// Real restores and backups run here; on the Windows runners they take 20 to 50 times longer than on a developer machine and timed out at the 60 s default.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let h: Harness;
const fts5Available = (() => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(value, tokenize = 'unicode61 remove_diacritics 2')");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
})();

afterEach(async () => {
  await h?.close();
});

function trackerActor(owner: ReturnType<typeof ownerOf>) {
  return { type: 'user', userId: owner.id, user: owner };
}

function expectRestoreCode(error: unknown, code: string) {
  expect(error).toBeInstanceOf(RestoreError);
  expect((error as RestoreError).code).toBe(code);
  return error as RestoreError;
}

async function invalidWorkspace(kind: 'duplicate' | 'missing') {
  h = await harness({ accounts: true });
  seedA(h);
  const owner = ownerOf(h);
  const ticket = createTicket({ directory: h.directory!, actor: trackerActor(owner), title: `Structural ${kind}` });
  const db = h.directory!.db;
  if (kind === 'duplicate') db.exec('DROP INDEX ticket_links_active_card');
  else db.exec('PRAGMA foreign_keys = OFF');
  const ticketId = kind === 'duplicate' ? ticket.id : 'missing-ticket-id';
  const add = db.prepare(
    `INSERT INTO ticket_links (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id)
     VALUES (?, ?, 'b1', ?, 'card-1', ?, 'system', NULL)`,
  );
  add.run('restore-link-1', ticketId, 'kanban-1', T0);
  if (kind === 'duplicate') add.run('restore-link-2', ticketId, 'kanban-2', T0 + 1);
  if (kind === 'missing') db.exec('PRAGMA foreign_keys = ON');
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM ticket_links WHERE removed_at IS NULL').get()!.n);
  const engine = rig(h);
  const saved = await backupNow(engine.backup);
  return { owner, ticket, engine, manifest: saved.manifest as string, before };
}

describe('tracker restore staging and preparation', () => {
  it.skipIf(!fts5Available).each(['duplicate', 'missing'] as const)(
    'refuses %s tracker links before preparation and leaves live tracker rows alone',
    async (kind) => {
      const s = await invalidWorkspace(kind);
      const expectedFinding = kind === 'duplicate' ? 'duplicate_active_link' : 'link_to_missing_ticket';
      expect(checkTrackerData(h.directory!.db).findings).toContainEqual(expect.objectContaining({ code: expectedFinding, count: 1 }));
      const observedBefore = Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM ticket_links WHERE removed_at IS NULL').get()!.n);
      expect(observedBefore).toBe(s.before);

      const pickerError = await s.engine.restore.listBoardsInBackup(s.manifest, s.owner).then(() => null, (error) => error);
      expectRestoreCode(pickerError, 'tracker_data_invalid');
      const restoreError = await s.engine.restore.restoreWorkspace({
        manifest: s.manifest, confirm: 'RESTORE', actor: s.owner,
      }).then(() => null, (error) => error);
      expectRestoreCode(restoreError, 'tracker_data_invalid');

      expect(Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM ticket_links WHERE removed_at IS NULL').get()!.n)).toBe(observedBefore);
      expect(Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB')!.n)).toBe(1);
      expect(s.engine.restore.status().last).toMatchObject({ result: 'failed', error: 'tracker_data_invalid' });
      expect(s.engine.exits).toEqual([]);
    },
  );

  it.skipIf(!fts5Available)('keeps five lost keys from being reissued, repairs a mismatched key, suppresses old mail, and records no ticket text', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const owner = ownerOf(h);
    const actor = trackerActor(owner);
    const initial = Array.from({ length: 10 }, (_, index) => createTicket({
      directory: h.directory!, actor, title: index === 0 ? 'RESTORE_TITLE_CANARY_7B' : `Snapshot ticket ${index + 1}`,
      now: T0 + index,
    }));
    const comment = commentTicket({ directory: h.directory!, actor, key: initial[0].key, body: 'RESTORE_COMMENT_CANARY_7B', now: T0 + 20 });
    h.directory!.db.prepare('UPDATE tickets SET key = ? WHERE id = ?').run('BROKEN-KEY', initial[0].id);
    expect(checkTrackerData(h.directory!.db).findings).toContainEqual(expect.objectContaining({ code: 'key_mismatch', count: 1 }));
    h.directory!.db.prepare(
      `INSERT INTO notifications (id, user_id, ticket_id, kind, dedupe_key, created_at, next_email_at)
       VALUES (?, ?, ?, 'assigned', ?, ?, ?)`,
    ).run('restore-notice', owner.id, initial[0].id, 'restore-notice', T0 - 1, T0 + HOUR);

    const engine = rig(h);
    const saved = await backupNow(engine.backup);
    h.clock.now += HOUR;
    for (let index = 0; index < 5; index++) {
      createTicket({ directory: h.directory!, actor, title: `Lost after snapshot ${index + 1}`, now: h.clock.now + index });
    }
    expect(Number(h.directory!.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?')
      .get('trk_default', 'TAB')!.next_number)).toBe(16);

    await engine.restore.restoreWorkspace({ manifest: saved.manifest as string, confirm: 'RESTORE', actor: owner });
    const restored = reopen(h);
    try {
      const counter = Number(restored.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?')
        .get('trk_default', 'TAB')!.next_number);
      expect(counter).toBe(16);
      expect(restored.db.prepare('SELECT key FROM tickets WHERE id = ?').get(initial[0].id)!.key).toBe('TAB-1');
      expect(restored.db.prepare('SELECT suppressed_at FROM notifications WHERE id = ?').get('restore-notice')!.suppressed_at)
        .toBe(h.clock.now);
      expect(JSON.parse(String(restored.getSetting('tracker.restore_gate')))).toMatchObject({ floor: 'known', reason: 'restore' });
      const record = JSON.parse(String(restored.getSetting('restore.status')));
      expect(record).toMatchObject({
        result: 'done', tracker: { repaired: { key_mismatch: 1 }, summary: { tickets: 10 } },
      });
      const completion = audits(restored, 100).find((row) => row.action === 'restore.done')!;
      expect(completion.detail.tracker).toMatchObject({ tickets: 10, repaired: 1 });
      const serialized = JSON.stringify({ record, completion: completion.detail });
      expect(serialized).not.toContain('RESTORE_TITLE_CANARY_7B');
      expect(serialized).not.toContain('RESTORE_COMMENT_CANARY_7B');
      expect(comment.id).toBeTruthy();

      const next = createTicket({
        directory: restored, actor: trackerActor(restored.getUserByEmail('owner@example.com')!), title: 'Post restore key', now: h.clock.now + 1,
      });
      expect(Number(next.key.slice(next.key.lastIndexOf('-') + 1))).toBeGreaterThan(15);
    } finally {
      restored.close();
    }
  });

  it.skipIf(!fts5Available)('adds the control-plane 25-key margin to the restored counter', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const owner = ownerOf(h);
    createTicket({ directory: h.directory!, actor: trackerActor(owner), title: 'Hosted floor ticket', now: T0 });
    const cloud = { async readKeyFloor() { return { counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 100 }] }; } };
    const engine = rig(h, { cloud });
    const saved = await backupNow(engine.backup);

    await engine.restore.restoreWorkspace({ manifest: saved.manifest as string, confirm: 'RESTORE', actor: owner });
    const restored = reopen(h);
    try {
      expect(Number(restored.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?')
        .get('trk_default', 'TAB')!.next_number)).toBeGreaterThanOrEqual(125);
      expect(JSON.parse(String(restored.getSetting('tracker.restore_gate')))).toMatchObject({ floor: 'known' });
    } finally {
      restored.close();
    }
  });

  it.skipIf(!fts5Available)('leaves the floor pending when all external evidence is unavailable', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const owner = ownerOf(h);
    createTicket({ directory: h.directory!, actor: trackerActor(owner), title: 'Pending floor ticket', now: T0 });
    const cloud = { async readKeyFloor() { throw new Error('unavailable'); } };
    const engine = rig(h, { cloud });
    const saved = await backupNow(engine.backup);
    engine.backup.listManifests = async () => [];
    h.directory!.db.exec('DROP TABLE ticket_counters');

    await engine.restore.restoreWorkspace({ manifest: saved.manifest as string, confirm: 'RESTORE', actor: owner });
    const restored = reopen(h);
    try {
      expect(JSON.parse(String(restored.getSetting('tracker.restore_gate')))).toMatchObject({ floor: 'pending' });
      expect(Number(restored.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?')
        .get('trk_default', 'TAB')!.next_number)).toBe(2);
    } finally {
      restored.close();
    }
  });

  it.skipIf(!fts5Available)('strips card and kanban tracker fields before writing a board copy and creates no copied links', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const owner = ownerOf(h);
    const actor = trackerActor(owner);
    const ticket = createTicket({ directory: h.directory!, actor, title: 'Linked source ticket' });
    h.directory!.db.prepare(
      `INSERT INTO kanban_tracker_links (id, board_id, kanban_id, workflow_id, created_at, created_by)
       VALUES ('source-link', 'b1', 'kanban-source', 'wf_default', ?, ?)`,
    ).run(T0, owner.id);
    h.directory!.db.prepare(
      `INSERT INTO ticket_links (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id)
       VALUES ('source-card-link', ?, 'b1', 'kanban-source', 'card-source', ?, 'user', ?)`,
    ).run(ticket.id, T0, owner.id);

    const doc = new Y.Doc();
    doc.getMap('objects').set('kanban-source', new Y.Map([
      ['id', 'kanban-source'], ['type', 'container'], ['layout', 'kanban'],
      ['ext', { provider: 'tabula', tracker: 'trk_default' }], ['tracker', { ticketKey: ticket.key }],
    ]));
    doc.getMap('objects').set('card-source', new Y.Map([
      ['id', 'card-source'], ['type', 'card'], ['text', 'Keep this card title'], ['parent', 'lane-source'],
      ['extProvider', 'tabula'], ['extKey', ticket.key], ['extUrl', `https://tabula.test/t/${ticket.key}`],
      ['trackerId', 'trk_default'], ['tracker', { ticketKey: ticket.key }], ['ext', { provider: 'tabula' }],
      ['trackerUnmappedState', false],
    ]));
    expect((doc.getMap('objects').get('card-source') as Y.Map<unknown>).has('extKey')).toBe(true);
    h.write('b1.yjs', Buffer.from(Y.encodeStateAsUpdate(doc)));
    doc.destroy();
    const engine = rig(h);
    const saved = await backupNow(engine.backup);
    const linkCount = Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM ticket_links').get()!.n);
    const kanbanCount = Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM kanban_tracker_links').get()!.n);

    const copied = await engine.restore.restoreBoardCopy({ manifest: saved.manifest as string, boardId: 'b1', actor: owner });
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, fs.readFileSync(path.join(h.dir, `${copied.boardId}.yjs`)));
      const objects = copy.getMap('objects');
      const card = objects.get('card-source') as Y.Map<unknown>;
      const container = objects.get('kanban-source') as Y.Map<unknown>;
      expect(card.get('text')).toBe('Keep this card title');
      for (const field of ['extProvider', 'extKey', 'extUrl', 'trackerId', 'tracker', 'ext', 'trackerUnmappedState']) {
        expect(card.has(field)).toBe(false);
      }
      expect(container.has('ext')).toBe(false);
      expect(container.has('tracker')).toBe(false);
      expect(copied.trackerDetached).toBe(2);
      expect(Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM ticket_links').get()!.n)).toBe(linkCount);
      expect(Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM kanban_tracker_links').get()!.n)).toBe(kanbanCount);
      expect(Number(h.directory!.db.prepare('SELECT COUNT(*) AS n FROM ticket_links WHERE board_id = ?').get(copied.boardId)!.n)).toBe(0);
      expect(audits(h.directory!, 10).find((row) => row.action === 'restore.done')!.detail.trackerDetached).toBe(2);
    } finally {
      copy.destroy();
    }
  });
});
