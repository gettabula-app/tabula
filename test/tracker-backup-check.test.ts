import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BackupError, parseManifest } from '../server/backup.mjs';
import { copyDatabase } from '../server/backup-copy-worker.mjs';
import { openDirectory } from '../server/directory.mjs';
import { FINDING_SEVERITY, checkTrackerData } from '../server/tracker/backup-check.mjs';
import { commentTicket, createTicket } from '../server/tracker/tickets.mjs';

const opened: Array<ReturnType<typeof openDirectory>> = [];
const roots: string[] = [];
const trackerDatabaseAvailable = (() => {
  try {
    openDirectory(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

function fixture() {
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
  const actor = { id: owner.id, role: owner.role, name: owner.name };
  const ticket = createTicket({ directory, actor, title: 'Clean ticket', now: 1_000 });
  return { directory, actor, ticket };
}

function linkRow(db: DatabaseSync, id: string, ticketId: string, cardId: string, kanbanId = 'kanban-a') {
  db.prepare(
    `INSERT INTO ticket_links
      (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type)
     VALUES (?, ?, 'board-a', ?, ?, 1, 'system')`,
  ).run(id, ticketId, kanbanId, cardId);
}

function kanbanRow(db: DatabaseSync, id = 'kanban-a') {
  db.prepare(
    `INSERT INTO kanban_tracker_links (id, board_id, kanban_id, workflow_id, created_at)
     VALUES ('kanban-link-a', 'board-a', ?, 'wf_default', 1)`,
  ).run(id);
}

function proveFinding(code: string, mutate: (db: DatabaseSync, ticket: { id: string; key: string }) => void, at?: number) {
  const { directory, ticket } = fixture();
  expect(checkTrackerData(directory.db, at === undefined ? undefined : { at }).findings).toEqual([]);
  mutate(directory.db, ticket);
  expect(checkTrackerData(directory.db, at === undefined ? undefined : { at }).findings).toEqual([{ code, count: 1 }]);
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!trackerDatabaseAvailable)('tracker backup check', () => {
  it('exports the specified finding severities', () => {
    expect(FINDING_SEVERITY).toEqual({
      counter_below_max: 'error', key_mismatch: 'error', orphan_event: 'error', event_missing: 'warn',
      duplicate_active_link: 'error', link_without_board_link: 'error', link_to_missing_ticket: 'error',
      alias_collision: 'error', fts_missing: 'warn', outbox_stale: 'warn', check_failed: 'error',
    });
  });

  it('proves counter_below_max with a clean result followed by a lowered counter', () => {
    expect.assertions(2);
    proveFinding('counter_below_max', (db) => {
      db.prepare("UPDATE ticket_counters SET next_number = 1 WHERE scope = 'trk_default' AND prefix = 'TAB'").run();
    });
  });

  it('proves key_mismatch with a clean result followed by a changed canonical key', () => {
    expect.assertions(2);
    proveFinding('key_mismatch', (db, ticket) => {
      db.prepare('UPDATE tickets SET key = ? WHERE id = ?').run('WRONG-999', ticket.id);
    });
  });

  it('proves orphan_event with a clean result followed by an event whose ticket is absent', () => {
    expect.assertions(2);
    proveFinding('orphan_event', (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare(
        `INSERT INTO ticket_events (ticket_id, event_type, schema_version, actor_type, source, created_at, details_json)
         VALUES ('missing-ticket', 'created', 1, 'system', 'test', 1, '{}')`,
      ).run();
    });
  });

  it('proves event_missing with a clean result followed by a missing updated sequence', () => {
    expect.assertions(2);
    proveFinding('event_missing', (db, ticket) => {
      db.prepare('UPDATE tickets SET updated_seq = 999999 WHERE id = ?').run(ticket.id);
    });
  });

  it('proves duplicate_active_link after removing a pair of links that share one board card', () => {
    const { directory, actor, ticket } = fixture();
    const second = createTicket({ directory, actor, title: 'Second clean ticket', now: 1_001 });
    expect(checkTrackerData(directory.db).findings).toEqual([]);
    directory.db.exec('DROP INDEX ticket_links_active_card');
    kanbanRow(directory.db);
    linkRow(directory.db, 'link-a', ticket.id, 'card-a');
    linkRow(directory.db, 'link-b', second.id, 'card-a');
    expect(checkTrackerData(directory.db).findings).toEqual([{ code: 'duplicate_active_link', count: 1 }]);
  });

  it('proves link_without_board_link with a clean result followed by an unbacked active card link', () => {
    expect.assertions(2);
    proveFinding('link_without_board_link', (db, ticket) => linkRow(db, 'link-a', ticket.id, 'card-a'));
  });

  it('proves link_to_missing_ticket with a clean result followed by an active link to a missing ticket', () => {
    expect.assertions(2);
    proveFinding('link_to_missing_ticket', (db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      kanbanRow(db);
      linkRow(db, 'link-a', 'missing-ticket', 'card-a');
    });
  });

  it('proves alias_collision with an alias that matches another ticket canonical key', () => {
    const { directory, actor, ticket } = fixture();
    const other = createTicket({ directory, actor, title: 'Other clean ticket', now: 1_001 });
    expect(checkTrackerData(directory.db).findings).toEqual([]);
    directory.db.prepare(
      `INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, created_at)
       VALUES ('alias-a', ?, 'test', 'external-a', ?, 1)`,
    ).run(ticket.id, other.key);
    expect(checkTrackerData(directory.db).findings).toEqual([{ code: 'alias_collision', count: 1 }]);
  });

  it('proves fts_missing after deleting a ticket search row', () => {
    expect.assertions(2);
    proveFinding('fts_missing', (db, ticket) => {
      db.prepare('DELETE FROM ticket_search WHERE ticket_id = ?').run(ticket.id);
    });
  });

  it('proves outbox_stale with a clean result followed by a pending row older than 24 hours', () => {
    expect.assertions(2);
    const at = 10 * 24 * 60 * 60 * 1000;
    proveFinding('outbox_stale', (db, ticket) => {
      const eventSeq = Number(db.prepare('SELECT updated_seq FROM tickets WHERE id = ?').get(ticket.id)?.updated_seq ?? 0);
      db.prepare(
        `INSERT INTO ticket_projection_outbox
          (ticket_id, board_id, kanban_id, card_id, event_seq, operation, created_at, next_attempt_at)
         VALUES (?, 'board-a', 'kanban-a', 'card-a', ?, 'upsert', ?, ?)`,
      ).run(ticket.id, eventSeq, at - 2 * 24 * 60 * 60 * 1000, at - 2 * 24 * 60 * 60 * 1000);
    }, at);
  });

  it('reports a failing query as check_failed without leaking its error', () => {
    const { directory } = fixture();
    expect(checkTrackerData(directory.db).findings).toEqual([]);
    const throwingDb = {
      prepare(sql: string) {
        if (sql.includes('FROM ticket_comments')) throw new Error('private error text');
        return directory.db.prepare(sql);
      },
    };
    expect(checkTrackerData(throwingDb as DatabaseSync).findings).toEqual([{ code: 'check_failed', count: 1 }]);
  });

  it('reports an unreadable FTS index as both fts_missing and check_failed', () => {
    const { directory } = fixture();
    expect(checkTrackerData(directory.db).findings).toEqual([]);
    const unreadableFtsDb = {
      prepare(sql: string) {
        if (sql.includes('FROM ticket_search')) throw new Error('private index error');
        return directory.db.prepare(sql);
      },
    };
    expect(checkTrackerData(unreadableFtsDb as DatabaseSync).findings).toEqual([
      { code: 'check_failed', count: 1 }, { code: 'fts_missing', count: 1 },
    ]);
  });

  it('returns absent for an older database with no tickets table', () => {
    const directory = openDirectory(':memory:');
    opened.push(directory);
    directory.db.exec('PRAGMA foreign_keys = OFF');
    directory.db.exec('DROP TABLE tickets');
    expect(checkTrackerData(directory.db)).toEqual({ present: false, summary: null, findings: [] });
  });

  it('skips groups whose optional tables are missing from an older schema', () => {
    const { directory } = fixture();
    directory.db.exec('DROP TABLE ticket_comments');
    const result = checkTrackerData(directory.db);
    expect(result.present).toBe(true);
    expect(result.summary?.comments).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('summarizes integer counts and up to 100 counters sorted by scope and prefix', () => {
    const { directory, actor, ticket } = fixture();
    commentTicket({ directory, actor, key: ticket.key, body: 'summary comment', now: 1_001 });
    directory.db.prepare(
      `INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, created_at)
       VALUES ('alias-a', ?, 'test', 'external-a', 1)`,
    ).run(ticket.id);
    for (let index = 0; index < 105; index++) {
      directory.db.prepare('INSERT INTO ticket_counters (scope, prefix, next_number, updated_at) VALUES (?, ?, 1, 1)')
        .run(`scope-${String(index).padStart(3, '0')}`, 'ZZZ');
    }
    const result = checkTrackerData(directory.db);
    expect(result.findings).toEqual([]);
    expect(result.summary).toMatchObject({
      trackers: 1, tickets: 1, archived: 0, events: 2, maxEventId: 2, comments: 1, aliases: 1,
      links: 0, kanbanLinks: 0, outboxPending: 0, notifications: 0, ftsRows: 1,
    });
    expect(result.summary?.counters).toHaveLength(100);
    expect(result.summary?.counters[0]).toEqual({ scope: 'scope-000', prefix: 'ZZZ', next: 1, maxNumber: 0 });
    expect(Object.values(result.summary ?? {}).filter((value) => typeof value === 'number').every(Number.isInteger)).toBe(true);
    expect(result.summary?.counters.every((row: { next: number; maxNumber: number; scope: string; prefix: string }) => Number.isInteger(row.next) && Number.isInteger(row.maxNumber)
      && typeof row.scope === 'string' && typeof row.prefix === 'string')).toBe(true);
  });

  it('never returns ticket titles, descriptions or comment bodies', () => {
    const { directory, actor } = fixture();
    const secretTitle = 'distinctive tracker title 6db8';
    const secretDescription = 'distinctive tracker description 6db8';
    const secretComment = 'distinctive tracker comment 6db8';
    const ticket = createTicket({ directory, actor, title: secretTitle, description: secretDescription, now: 1_001 });
    commentTicket({ directory, actor, key: ticket.key, body: secretComment, now: 1_002 });
    const encoded = JSON.stringify(checkTrackerData(directory.db));
    expect(encoded).not.toContain(secretTitle);
    expect(encoded).not.toContain(secretDescription);
    expect(encoded).not.toContain(secretComment);
  });

  it('does not change the bytes of a backup copy when checking it read-only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-check-bytes-'));
    roots.push(root);
    const source = path.join(root, 'directory.sqlite');
    const copied = path.join(root, 'snapshot.sqlite');
    const directory = openDirectory(source);
    opened.push(directory);
    const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
    createTicket({ directory, actor: { id: owner.id, role: owner.role, name: owner.name }, title: 'Snapshot check', now: 1_000 });
    directory.close();
    opened.splice(opened.indexOf(directory), 1);
    await copyDatabase(source, copied, 'backup.status');
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(copied)).digest('hex');
    const before = hash();
    let db: DatabaseSync | null = null;
    try { db = new DatabaseSync(copied, { readOnly: true }); } catch { /* exercise the transaction fallback below */ }
    let result;
    if (db) {
      try { result = checkTrackerData(db); } finally { db.close(); }
    } else {
      const writable = new DatabaseSync(copied);
      writable.exec('BEGIN');
      try { result = checkTrackerData(writable); } finally {
        writable.exec('ROLLBACK');
        writable.close();
      }
    }
    expect(result?.present).toBe(true);
    expect(hash()).toBe(before);
  });
});

describe('tracker manifest normalisation', () => {
  const base = {
    version: 1, keyId: 'test-key', createdAt: '2026-10-11T00:00:00.000Z', files: [], totals: { files: 0, bytes: 0 },
  };
  const tracker = {
    checkedAt: 100,
    summary: {
      schema: 12, trackers: 1, tickets: 1, archived: 0, events: 1, maxEventId: 1,
      comments: 0, aliases: 0, links: 0, kanbanLinks: 0, outboxPending: 0, notifications: 0, ftsRows: 1,
      counters: [{ scope: 'trk_default', prefix: 'TAB', next: 2, maxNumber: 1, ignored: true }], ignored: 'also ignored',
    },
    findings: [], ignored: true,
  };
  const parse = (value: unknown) => parseManifest(Buffer.from(JSON.stringify(value)), { keyId: 'test-key' }, '20261011T000000Z.json.enc');

  it('normalizes manifests without tracker data to tracker null', () => {
    expect(parse(base).tracker).toBeNull();
  });

  it('normalizes the optional tracker data and ignores unknown keys', () => {
    expect(parse({ ...base, tracker }).tracker).toEqual({
      checkedAt: 100,
      summary: {
        schema: 12, trackers: 1, tickets: 1, archived: 0, events: 1, maxEventId: 1,
        comments: 0, aliases: 0, links: 0, kanbanLinks: 0, outboxPending: 0, notifications: 0, ftsRows: 1,
        counters: [{ scope: 'trk_default', prefix: 'TAB', next: 2, maxNumber: 1 }],
      },
      findings: [],
    });
  });

  it('rejects invalid tracker data as an invalid manifest', () => {
    let error: unknown;
    try { parse({ ...base, tracker: { ...tracker, checkedAt: -1 } }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(BackupError);
    expect(error).toMatchObject({ code: 'invalid_manifest' });
  });
});
