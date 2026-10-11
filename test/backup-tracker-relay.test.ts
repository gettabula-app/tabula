import { afterEach, describe, expect, it } from 'vitest';
import { createTicket } from '../server/tracker/tickets.mjs';
import { T0, harness, type Harness } from './backup-harness';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('backup tracker findings (relay harness)', () => {
  it('records a corrupted link in status and audits its new code exactly once across two runs', async () => {
    h = await harness({ accounts: true, seed: false });
    const directory = h.directory!;
    const owner = directory.db.prepare("SELECT id, name, role FROM users WHERE role = 'owner' LIMIT 1").get()!;
    const actor = { id: owner.id, name: owner.name, role: owner.role };
    const ticket = createTicket({ directory, actor, title: 'Backup tracker check', now: T0 });
    directory.db.prepare(
      `INSERT INTO ticket_links
        (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type)
       VALUES ('broken-link', ?, 'board-a', 'kanban-a', 'card-a', ?, 'system')`,
    ).run(ticket.id, T0);

    const engine = h.engine();
    expect(await h.runAt(engine, T0)).toMatchObject({ ok: true, changed: true });
    expect(engine.status().tracker).toEqual({
      checkedAt: T0, tickets: 1, events: 1, findings: [{ code: 'link_without_board_link', count: 1 }],
    });
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    expect(manifest.tracker).toMatchObject({
      checkedAt: T0,
      summary: { tickets: 1, events: 1 },
      findings: [{ code: 'link_without_board_link', count: 1 }],
    });
    const audit = () => directory.db.prepare(
      "SELECT action, detail FROM audit WHERE action = 'backup.tracker_findings' ORDER BY id",
    ).all().map((row) => ({ action: row.action, detail: JSON.parse(String(row.detail)) }));
    expect(audit()).toEqual([{
      action: 'backup.tracker_findings',
      detail: { findings: [{ code: 'link_without_board_link', count: 1 }] },
    }]);

    expect(await h.runAt(engine, T0 + 60_000)).toMatchObject({ ok: true, changed: false, uploaded: 0 });
    expect(engine.status().tracker).toEqual({
      checkedAt: T0, tickets: 1, events: 1, findings: [{ code: 'link_without_board_link', count: 1 }],
    });
    expect(audit()).toHaveLength(1);
  });
});
