import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJoinCodeService } from '../server/join-codes.mjs';
import { openDirectory } from '../server/directory.mjs';
import { createHarness, type Account } from './mcp-harness';

const h = createHarness({ accounts: true, settings: { CHAT: 'on', JOIN_CODES: 'on' } });
let owner: Account;

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
});

afterAll(async () => h.cleanup());

function withDatabase<T>(name: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(h.dir, name));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('CDX-54 risk-ranked server coverage', () => {
  it('conceals a chat retry after the caller loses team-share access', async () => {
    const team = await h.newTeam(owner.cookie);
    const member = await h.joinTeam(owner.cookie, team.id);
    const board = await h.newBoard(owner.cookie);
    const share = await h.api(owner.cookie, 'POST', `/api/boards/${board}/shares`, {
      principalType: 'team', principalId: team.id, role: 'commenter',
    });
    expect(share.status).toBe(201);

    const clientId = h.unique('cdx54-chat-');
    const url = `/api/chat/board/${board}/messages`;
    const first = await h.api(member.cookie, 'POST', url, { clientId, text: 'private original message' });
    expect(first.status).toBe(201);

    expect((await h.api(owner.cookie, 'DELETE', `/api/boards/${board}/shares/team/${team.id}`)).status).toBe(204);
    const retry = await h.api(member.cookie, 'POST', url, { clientId, text: 'retry after access loss' });
    const unknown = await h.api(member.cookie, 'POST', `/api/chat/board/${h.unique('missing-board-')}/messages`, {
      clientId: h.unique('missing-client-'), text: 'unrelated',
    });
    expect(retry.status).toBe(404);
    expect(retry.body).toEqual(unknown.body);

    withDatabase('chat.sqlite', (db) => {
      const rows = db.prepare('SELECT body FROM chat_messages WHERE kind = ? AND ref = ? AND client_id = ?')
        .all('board', board, clientId) as { body: string }[];
      expect(rows).toEqual([{ body: 'private original message' }]);
    });
  });

  async function runJoinCodeRace(change: 'revoked' | 'exhausted') {
    const board = await h.newBoard(owner.cookie);
    const created = await h.api(owner.cookie, 'POST', `/api/boards/${board}/join-codes`, {
      role: 'commenter', maxUses: 1,
    });
    expect(created.status).toBe(201);
    const code = created.body as { id: string; code: string; maxUses: number };
    const directory = openDirectory(path.join(h.dir, 'directory.sqlite'));
    const now = Date.now();
    const secret = fs.readFileSync(path.join(h.dir, 'join-code.secret'));
    let preRead: { id: string; uses: number; maxUses: number; revokedAt: number | null } | null = null;
    let changedBetweenReads = false;
    let guestSessionCalls = 0;
    let auditCalls = 0;

    const racingDirectory = new Proxy(directory, {
      get(target, property) {
        if (property === 'findJoinCodeByHash') {
          return (hash: string) => {
            preRead = target.findJoinCodeByHash(hash);
            return preRead;
          };
        }
        if (property === 'transaction') {
          return (fn: () => unknown) => {
            if (change === 'revoked') target.revokeJoinCode(code.id, now);
            else target.db.prepare('UPDATE join_codes SET uses = max_uses WHERE id = ?').run(code.id);
            changedBetweenReads = true;
            return target.transaction(fn);
          };
        }
        if (property === 'createGuestSession') {
          return (...args: unknown[]) => {
            guestSessionCalls++;
            return Reflect.apply(target.createGuestSession, target, args);
          };
        }
        if (property === 'audit') {
          return (...args: unknown[]) => {
            auditCalls++;
            return Reflect.apply(target.audit, target, args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    try {
      const serviceOptions = { directory: racingDirectory, secret, now: () => now };
      const service = createJoinCodeService(serviceOptions);
      const joined = service.join({ code: code.code, name: 'Race Guest', source: `cdx54-${change}` });
      const current = directory.getJoinCode(code.id) as { id: string; uses: number; maxUses: number; revokedAt: number | null } | null;
      const guestCount = Number(directory.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions WHERE join_code_id = ?').get(code.id)!.n);
      const usedAuditCount = Number(directory.db.prepare(`
        SELECT COUNT(*) AS n FROM audit
        WHERE action = 'join-code.used' AND json_extract(detail, '$.joinCodeId') = ?
      `).get(code.id)!.n);
      return {
        codeId: code.id,
        preRead: preRead as { id: string; uses: number; maxUses: number; revokedAt: number | null } | null,
        changedBetweenReads, joined, guestSessionCalls, auditCalls, current, guestCount, usedAuditCount,
      };
    } finally {
      directory.close();
    }
  }

  it('re-reads a join code after a concurrent revoke before creating a guest', async () => {
    const result = await runJoinCodeRace('revoked');
    expect(result.preRead).toMatchObject({ id: result.codeId, uses: 0, revokedAt: null });
    expect(result.changedBetweenReads).toBe(true);
    expect(result.joined).toBeNull();
    expect(result.guestSessionCalls).toBe(0);
    expect(result.auditCalls).toBe(0);
    expect(result.current).toMatchObject({ id: result.codeId, uses: 0 });
    expect(result.current?.revokedAt).not.toBeNull();
    expect(result.guestCount).toBe(0);
    expect(result.usedAuditCount).toBe(0);
  });

  it('re-reads a join code after concurrent exhaustion before spending a use', async () => {
    const result = await runJoinCodeRace('exhausted');
    expect(result.preRead).toMatchObject({ id: result.codeId, uses: 0, revokedAt: null });
    expect(result.changedBetweenReads).toBe(true);
    expect(result.joined).toBeNull();
    expect(result.guestSessionCalls).toBe(0);
    expect(result.auditCalls).toBe(0);
    expect(result.current).toMatchObject({ id: result.codeId, revokedAt: null });
    expect(result.current?.uses).toBe(result.preRead?.maxUses);
    expect(result.guestCount).toBe(0);
    expect(result.usedAuditCount).toBe(0);
  });

  it('does not grant team members board access when the share audit insert fails', async () => {
    const team = await h.newTeam(owner.cookie);
    const member = await h.joinTeam(owner.cookie, team.id);
    const board = await h.newBoard(owner.cookie);
    const visibleBoards = () => h.api(member.cookie, 'GET', '/api/boards');
    expect(((await visibleBoards()).body as { id: string }[]).some((entry) => entry.id === board)).toBe(false);

    const trigger = 'cdx54_fail_board_share_audit';
    withDatabase('directory.sqlite', (db) => db.exec(`
      CREATE TRIGGER ${trigger} BEFORE INSERT ON audit
      WHEN NEW.action = 'board.share'
      BEGIN SELECT RAISE(ABORT, 'CDX-54 injected audit failure'); END;
    `));

    try {
      const response = await h.api(owner.cookie, 'POST', `/api/boards/${board}/shares`, {
        principalType: 'team', principalId: team.id, role: 'commenter',
      });
      expect(response.status).toBe(500);
      expect(((await visibleBoards()).body as { id: string }[]).some((entry) => entry.id === board)).toBe(false);

      withDatabase('directory.sqlite', (db) => {
        const shareCount = db.prepare(`
          SELECT COUNT(*) AS n FROM board_shares
          WHERE board_id = ? AND principal_type = 'team' AND principal_id = ?
        `).get(board, team.id)!.n;
        const auditCount = db.prepare(`
          SELECT COUNT(*) AS n FROM audit
          WHERE action = 'board.share' AND json_extract(detail, '$.boardId') = ?
        `).get(board)!.n;
        expect(Number(shareCount)).toBe(0);
        expect(Number(auditCount)).toBe(0);
      });
    } finally {
      withDatabase('directory.sqlite', (db) => db.exec(`DROP TRIGGER IF EXISTS ${trigger}`));
    }
  });
});
