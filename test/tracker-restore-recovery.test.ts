import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDirectory } from '../server/directory.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';
import { createTrackerRestoreRecovery } from '../server/tracker/restore-recovery.mjs';
import { readRestoreGate, setRestoreGate } from '../server/tracker/gate.mjs';
import { searchTickets } from '../server/tracker/search.mjs';

// Real restores and backups run here; on the Windows runners they take 20 to 50 times longer than on a developer machine and timed out at the 60 s default.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const opened: ReturnType<typeof openDirectory>[] = [];
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
const open = () => {
  const directory = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};

function seed(directory: ReturnType<typeof openDirectory>, floor: 'known' | 'pending' = 'known') {
  const owner = directory.createUser({ email: `owner-${opened.length}@example.com`, name: 'Owner', role: 'owner' })!;
  const actor = { id: owner.id, role: owner.role, name: owner.name };
  const ticket = createTicket({ directory, actor, title: 'Recovery searchable phrase', now: 100 });
  const manifest = '20261008T193000Z.json.enc';
  setRestoreGate(directory, { since: 100, reason: 'restore', floor });
  directory.setSetting('restore.status', JSON.stringify({
    kind: 'workspace', result: 'done', at: 100, manifest,
    tracker: { summary: { tickets: 1, archived: 0 }, findings: [], repaired: {} },
  }));
  directory.audit(owner.id, 'restore.done', { kind: 'workspace', manifest, tracker: { tickets: 1, repaired: 0 } });
  return { owner, actor, ticket, manifest };
}

function addLinkedBoard(directory: ReturnType<typeof openDirectory>, ownerId: string, boardId = 'board-a') {
  directory.createBoard({ id: boardId, title: 'Linked board', ownerId, teamId: null });
  directory.db.prepare(
    `INSERT INTO kanban_tracker_links (id, board_id, kanban_id, workflow_id, created_at, created_by, removed_at)
     VALUES (?, ?, ?, 'wf_default', 100, ?, NULL)`,
  ).run(`link-${boardId}`, boardId, `kanban-${boardId}`, ownerId);
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('post-restore tracker recovery', () => {
  it.skipIf(!fts5Available)('sets both completion signals and clears a known-floor gate after recovery', async () => {
    const directory = open();
    const { manifest } = seed(directory);
    const recovery = createTrackerRestoreRecovery({
      directory,
      roomAccess: { read: () => undefined, write: () => undefined },
      now: () => 2100,
    });

    const result = await recovery.run();

    expect(result).toMatchObject({ boardsReconciled: 0, boardsFailed: 0, ftsReady: true, floor: 'known', gateCleared: true });
    expect(directory.getSetting('tracker.reconcile_done')).toBe('1');
    expect(directory.getSetting('tracker.fts_ready')).toBe('1');
    expect(readRestoreGate(directory)).toBeNull();
    expect(JSON.parse(String(directory.getSetting('restore.status')))).toMatchObject({
      tracker: { boardsReconciled: 0, cardsStripped: 0, cardsRepaired: 0, unlinked: 0, boardsFailed: 0 },
    });
    const detail = JSON.parse(String(directory.db.prepare("SELECT detail FROM audit WHERE action = 'restore.done' ORDER BY id DESC LIMIT 1").get()!.detail));
    expect(detail).toMatchObject({ manifest, tracker: { tickets: 1 } });
    expect(detail.tracker).not.toHaveProperty('boardsReconciled');
    expect(directory.listAudit(10).filter((row) => row.action === 'tracker.gate_cleared')).toHaveLength(1);
  });

  it.skipIf(!fts5Available)('keeps a pending floor gated after FTS and reconciliation finish for key-epoch to clear', async () => {
    const directory = open();
    seed(directory, 'pending');
    const recovery = createTrackerRestoreRecovery({ directory, roomAccess: {}, now: () => 2100 });

    const result = await recovery.run();

    expect(result).toMatchObject({ ftsReady: true, floor: 'pending', gateCleared: false });
    expect(readRestoreGate(directory)).toMatchObject({ floor: 'pending' });
    expect(directory.getSetting('tracker.reconcile_done')).toBe('1');
    expect(directory.getSetting('tracker.fts_ready')).toBe('1');
  });

  it.skipIf(!fts5Available)('counts a board that fails to open in the restore record without freezing the tracker', async () => {
    const directory = open();
    const { owner } = seed(directory);
    addLinkedBoard(directory, owner.id);
    let openedBoards = 0;
    const recovery = createTrackerRestoreRecovery({
      directory,
      roomAccess: { read: () => undefined, write: () => undefined },
      reconcile: () => { openedBoards++; throw new Error('hidden board error'); },
      drain: () => ({ applied: 0, projectionPending: false }),
      log: () => {},
      now: () => 2100,
    });

    const result = await recovery.run();
    expect(openedBoards).toBe(1);
    expect(result).toMatchObject({ boardsFailed: 1, boardsReconciled: 0, gateCleared: true });
    expect(readRestoreGate(directory)).toBeNull();
    expect(JSON.parse(String(directory.getSetting('restore.status')))).toMatchObject({ tracker: { boardsFailed: 1, boardsReconciled: 0 } });
    const rows = directory.listAudit(20).filter((row) => row.action === 'tracker.restore_boards_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ count: 1 });
  });

  it.skipIf(!fts5Available)('reconciles every linked board in sql-wins mode and counts what it changed', async () => {
    const directory = open();
    const { owner } = seed(directory);
    addLinkedBoard(directory, owner.id);
    let reconciled = 0;
    const recovery = createTrackerRestoreRecovery({
      directory,
      roomAccess: { read: () => undefined, write: () => undefined },
      reconcile: ({ mode }: { mode: string }) => { expect(mode).toBe('sql-wins'); reconciled++; return { stripped: 2, repaired: 3 }; },
      drain: () => ({ applied: 1, projectionPending: false }),
      now: () => 3100,
    });
    const recovered = await recovery.run();
    expect(reconciled).toBe(1);
    expect(recovered).toMatchObject({ boardsReconciled: 1, cardsStripped: 2, cardsRepaired: 3, boardsFailed: 0, gateCleared: true });
    expect(readRestoreGate(directory)).toBeNull();
  });

  it.skipIf(!fts5Available)('rebuilds missing ticket-search rows in batches and makes them searchable before clearing the gate', async () => {
    const directory = open();
    const { actor } = seed(directory);
    createTicket({ directory, actor, title: 'Second recovery searchable phrase', now: 101 });
    directory.db.exec('DELETE FROM ticket_search');
    expect(Number(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get()!.n)).toBe(0);

    const recovery = createTrackerRestoreRecovery({ directory, roomAccess: {}, now: () => 2100 });
    const result = await recovery.run();

    expect(result).toMatchObject({ ftsReady: true, ftsRepaired: 2, gateCleared: true });
    expect(Number(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get()!.n)).toBe(2);
    expect(searchTickets({ directory, actor, query: 'second recovery searchable', limit: 10 }).entries).toHaveLength(1);
  });
  it.skipIf(!fts5Available)('yields to the event loop between rebuild batches and rebuilds the table exactly as a fresh database defines it', async () => {
    const directory = open();
    const { actor } = seed(directory);
    for (let i = 0; i < 1100; i++) createTicket({ directory, actor, title: `Bulk ticket ${i}`, now: 200 + i });
    const fresh = String(open().db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ticket_search'").get()!.sql);
    directory.db.exec('DROP TABLE ticket_search');
    expect(directory.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = 'ticket_search'").get()).toBeUndefined();
    const sleeps: number[] = [];
    const recovery = createTrackerRestoreRecovery({
      directory, roomAccess: {}, now: () => 2100,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    const result = await recovery.run();
    // 1101 tickets in batches of 500 is 3 batches, each followed by a yield
    expect(sleeps.length).toBeGreaterThanOrEqual(Math.ceil(1101 / 500));
    expect(result).toMatchObject({ ftsReady: true, gateCleared: true });
    expect(Number(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get()!.n)).toBe(1101);
    expect(String(directory.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ticket_search'").get()!.sql)).toBe(fresh);
  });
});
