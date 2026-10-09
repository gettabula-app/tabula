import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDirectory } from '../server/directory.mjs';
import { AUDIT_ACTION, HISTORY_MAX, MARKER, VolumeError, applyVolume, decideVolume, parseMarker, planVolume, readMarker, volumeReport, writeMarker } from '../server/volume.mjs';

// docs/backups.md, "Volumes and restores". decideVolume is the whole start-up rule; the rest is files.

const T0 = 1_700_000_000_000;
const VID = 'a'.repeat(32);
const marker = (over: Record<string, unknown> = {}) => ({ version: 1, volumeId: VID, workspaceId: 'ws_a', flyVolumeId: 'vol_1', createdAt: T0 - 1000, adoptedAt: null, history: [] as any[], ...over });
const decide = (over: Record<string, unknown>) => decideVolume({ marker: null, workspaceId: null, flyVolumeId: undefined, adoptVolume: undefined, now: T0, newId: () => 'b'.repeat(32), ...over } as any);

describe('decideVolume', () => {
  describe('no marker yet', () => {
    it('creates one for a hosted workspace with the Fly volume id', () => {
      const plan = decide({ workspaceId: 'ws_a', flyVolumeId: 'vol_1' });
      expect(plan).toEqual({ action: 'create', write: true, notes: [], marker: { version: 1, volumeId: 'b'.repeat(32), workspaceId: 'ws_a', flyVolumeId: 'vol_1', createdAt: T0, adoptedAt: null, history: [] } });
    });

    it('creates one without a workspace outside hosted mode, and without a Fly id when there is none', () => {
      const plan = decide({}) as any;
      expect(plan.action).toBe('create');
      expect(plan.marker).toMatchObject({ workspaceId: null, flyVolumeId: null });
    });

    it('says TABULA_ADOPT_VOLUME can go when it names this workspace', () => {
      const plan = decide({ workspaceId: 'ws_a', adoptVolume: 'ws_a' }) as any;
      expect(plan.action).toBe('create');
      expect(plan.notes).toEqual([expect.stringContaining('can be removed')]);
    });
  });

  describe('the same volume again', () => {
    it('keeps it and writes nothing', () => {
      const m = marker();
      expect(decide({ marker: m, workspaceId: 'ws_a', flyVolumeId: 'vol_1' })).toEqual({ action: 'keep', write: false, notes: [], marker: m });
    });

    it('keeps it when TABULA_FLY_VOLUME_ID is not set (the id on record stays)', () => {
      expect(decide({ marker: marker(), workspaceId: 'ws_a' })).toMatchObject({ action: 'keep', write: false, marker: { flyVolumeId: 'vol_1' } });
    });

    it('only records the Fly volume id the first time it is set: no adoption, so nobody is signed out', () => {
      const plan = decide({ marker: marker({ flyVolumeId: null }), workspaceId: 'ws_a', flyVolumeId: 'vol_1' }) as any;
      expect(plan.action).toBe('keep');
      expect(plan.write).toBe(true);
      expect(plan.marker).toEqual(marker({ flyVolumeId: 'vol_1' }));
      expect(plan.marker.adoptedAt).toBeNull();
      expect(plan.marker.history).toEqual([]);
      expect(plan.notes).toEqual(['volume: recorded Fly volume vol_1']);
    });

    it('records the workspace of a volume that was not hosted before', () => {
      const plan = decide({ marker: marker({ workspaceId: null }), workspaceId: 'ws_a' }) as any;
      expect(plan).toMatchObject({ action: 'keep', write: true, marker: { workspaceId: 'ws_a', adoptedAt: null } });
    });

    it('serves a hosted volume outside hosted mode and leaves its workspace on record', () => {
      expect(decide({ marker: marker() })).toMatchObject({ action: 'keep', write: false, marker: { workspaceId: 'ws_a' } });
    });

    it('says TABULA_ADOPT_VOLUME can go when the volume is already this workspace', () => {
      const plan = decide({ marker: marker(), workspaceId: 'ws_a', adoptVolume: 'ws_a' }) as any;
      expect(plan.action).toBe('keep');
      expect(plan.notes).toEqual([expect.stringContaining('TABULA_ADOPT_VOLUME is set but there is nothing to adopt')]);
    });
  });

  describe('another workspace', () => {
    it('refuses to start, naming both workspaces and how to adopt', () => {
      const plan = decide({ marker: marker(), workspaceId: 'ws_b', flyVolumeId: 'vol_1' }) as any;
      expect(plan.action).toBe('error');
      expect(plan.message).toContain('workspace ws_a');
      expect(plan.message).toContain('workspace ws_b');
      expect(plan.message).toContain('TABULA_ADOPT_VOLUME=ws_b');
    });

    it('adopts when TABULA_ADOPT_VOLUME names this workspace (reason operator)', () => {
      const plan = decide({ marker: marker(), workspaceId: 'ws_b', flyVolumeId: 'vol_2', adoptVolume: 'ws_b' }) as any;
      const from = { workspaceId: 'ws_a', flyVolumeId: 'vol_1' };
      const to = { workspaceId: 'ws_b', flyVolumeId: 'vol_2' };
      expect(plan).toEqual({
        action: 'adopt',
        write: true,
        reason: 'operator',
        from,
        to,
        notes: [],
        marker: marker({ workspaceId: 'ws_b', flyVolumeId: 'vol_2', adoptedAt: T0, history: [{ at: T0, from, to, reason: 'operator' }] }),
      });
    });

    it('keeps the Fly id on record when an operator adopts without TABULA_FLY_VOLUME_ID', () => {
      const plan = decide({ marker: marker(), workspaceId: 'ws_b', adoptVolume: 'ws_b' }) as any;
      expect(plan.to).toEqual({ workspaceId: 'ws_b', flyVolumeId: 'vol_1' });
    });
  });

  describe('another Fly volume of the same workspace', () => {
    it('adopts a restored copy on its own', () => {
      const plan = decide({ marker: marker(), workspaceId: 'ws_a', flyVolumeId: 'vol_2' }) as any;
      expect(plan.action).toBe('adopt');
      expect(plan.reason).toBe('restored-copy');
      expect(plan.from).toEqual({ workspaceId: 'ws_a', flyVolumeId: 'vol_1' });
      expect(plan.to).toEqual({ workspaceId: 'ws_a', flyVolumeId: 'vol_2' });
      expect(plan.marker).toMatchObject({ volumeId: VID, flyVolumeId: 'vol_2', adoptedAt: T0, createdAt: T0 - 1000 });
    });

    it('adopts a restored copy outside hosted mode too', () => {
      const plan = decide({ marker: marker({ workspaceId: null }), flyVolumeId: 'vol_2' }) as any;
      expect(plan).toMatchObject({ action: 'adopt', reason: 'restored-copy', to: { workspaceId: null, flyVolumeId: 'vol_2' } });
    });

    it('calls it operator when the workspace changes as well', () => {
      expect(decide({ marker: marker(), workspaceId: 'ws_b', flyVolumeId: 'vol_2', adoptVolume: 'ws_b' })).toMatchObject({ reason: 'operator' });
    });

    it('keeps the last 20 adoptions', () => {
      const old = Array.from({ length: HISTORY_MAX }, (_, i) => ({ at: i, from: { workspaceId: 'ws_a', flyVolumeId: `vol_${i}` }, to: { workspaceId: 'ws_a', flyVolumeId: `vol_${i + 1}` }, reason: 'restored-copy' }));
      const plan = decide({ marker: marker({ history: old }), workspaceId: 'ws_a', flyVolumeId: 'vol_new' }) as any;
      expect(plan.marker.history).toHaveLength(HISTORY_MAX);
      expect(plan.marker.history[0].at).toBe(1);
      expect(plan.marker.history.at(-1)).toMatchObject({ at: T0, to: { flyVolumeId: 'vol_new' } });
    });
  });

  describe('misuse', () => {
    it('refuses TABULA_ADOPT_VOLUME outside hosted mode', () => {
      for (const m of [null, marker()]) {
        const plan = decide({ marker: m, adoptVolume: 'ws_a' }) as any;
        expect(plan.action).toBe('error');
        expect(plan.message).toContain('not a hosted workspace');
      }
    });

    it('refuses TABULA_ADOPT_VOLUME that is not this workspace, even when the marker matches', () => {
      for (const m of [null, marker(), marker({ workspaceId: 'ws_c' })]) {
        const plan = decide({ marker: m, workspaceId: 'ws_a', adoptVolume: 'ws_b' }) as any;
        expect(plan.action).toBe('error');
        expect(plan.message).toContain('TABULA_ADOPT_VOLUME (ws_b) is not this server\'s workspace (ws_a)');
      }
    });

    it('does not echo a malformed TABULA_ADOPT_VOLUME', () => {
      const plan = decide({ marker: marker(), workspaceId: 'ws_a', adoptVolume: 'x y\n' }) as any;
      expect(plan.action).toBe('error');
      expect(plan.message).not.toContain('x y');
    });

    it('refuses a malformed TABULA_FLY_VOLUME_ID', () => {
      expect(decide({ marker: marker(), workspaceId: 'ws_a', flyVolumeId: 'vol 1' })).toMatchObject({ action: 'error' });
    });

    it('treats empty variables as not set', () => {
      expect(decide({ marker: marker(), workspaceId: 'ws_a', flyVolumeId: '', adoptVolume: '' })).toMatchObject({ action: 'keep', write: false });
    });
  });
});

describe('parseMarker', () => {
  it('reads what decideVolume writes', () => {
    const m = marker({ history: [{ at: 1, from: { workspaceId: 'ws_a', flyVolumeId: null }, to: { workspaceId: 'ws_b', flyVolumeId: 'vol_1' }, reason: 'operator' }] });
    expect(parseMarker(JSON.stringify(m))).toEqual(m);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['another version', JSON.stringify(marker({ version: 2 }))],
    ['a bad volume id', JSON.stringify(marker({ volumeId: 'x' }))],
    ['a bad workspace id', JSON.stringify(marker({ workspaceId: 'a b' }))],
    ['a missing Fly id', JSON.stringify({ ...marker(), flyVolumeId: undefined })],
    ['a bad adoptedAt', JSON.stringify(marker({ adoptedAt: 'now' }))],
    ['no history', JSON.stringify({ ...marker(), history: undefined })],
  ])('refuses %s', (_name, text) => {
    expect(() => parseMarker(text)).toThrow(VolumeError);
  });

  it('drops malformed history entries and keeps at most 20', () => {
    const good = { at: 1, from: { workspaceId: 'ws_a', flyVolumeId: null }, to: { workspaceId: 'ws_a', flyVolumeId: 'vol_1' }, reason: 'restored-copy' };
    const m = parseMarker(JSON.stringify(marker({ history: [null, { ...good, reason: 'other' }, { ...good, at: -1 }, ...Array(25).fill(good)] })));
    expect(m.history).toHaveLength(HISTORY_MAX);
    expect(m.history[0]).toEqual(good);
  });
});

describe('volumeReport', () => {
  it('reports the ids and the last adoption', () => {
    const entry = { at: T0, from: { workspaceId: 'ws_a', flyVolumeId: 'vol_1' }, to: { workspaceId: 'ws_a', flyVolumeId: 'vol_2' }, reason: 'restored-copy' };
    expect(volumeReport(marker({ adoptedAt: T0, history: [entry] }), 5)).toEqual({ volumeId: VID, workspaceId: 'ws_a', flyVolumeId: 'vol_1', adoptedAt: T0, startedAt: 5, lastAdoption: entry });
    expect(volumeReport(marker(), 5).lastAdoption).toBeNull();
  });
});

// ---------------------------------------------------------------- files and the directory

const dirs: string[] = [];
const handles: { close(): void }[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-volume-'));
  dirs.push(d);
  return d;
};

describe('the marker file', () => {
  it('is written atomically and read back, and a leftover temporary file is removed', () => {
    const d = tmpDir();
    expect(readMarker(d)).toBeNull();
    writeMarker(d, marker());
    fs.writeFileSync(path.join(d, `${MARKER}.tmp-0123456789abcdef`), 'half');
    expect(readMarker(d)).toEqual(marker());
    expect(fs.readdirSync(d)).toEqual([MARKER]);
  });

  it('refuses a marker that is not a file', () => {
    const d = tmpDir();
    fs.mkdirSync(path.join(d, MARKER));
    expect(() => readMarker(d)).toThrow(VolumeError);
  });

  it('planVolume reads the environment variables', () => {
    const d = tmpDir();
    writeMarker(d, marker());
    expect(planVolume({ dataDir: d, env: { TABULA_FLY_VOLUME_ID: 'vol_2' }, workspaceId: 'ws_a', now: T0 })).toMatchObject({ action: 'adopt', reason: 'restored-copy' });
    expect(planVolume({ dataDir: d, env: { TABULA_ADOPT_VOLUME: 'ws_c' }, workspaceId: 'ws_a', now: T0 })).toMatchObject({ action: 'error' });
  });
});

describe('applyVolume', () => {
  function rig() {
    const d = tmpDir();
    const directory = openDirectory(path.join(d, 'directory.sqlite'));
    handles.push(directory);
    const user = directory.createUser({ email: 'ana@example.com', name: 'Ana', role: 'owner' });
    const session = directory.createSession(user!.id, { ttlMs: 60_000 });
    const link = directory.createLoginToken({ email: 'ana@example.com', ttlMs: 60_000 });
    return { d, directory, session, link };
  }

  it('adopting ends every session and sign-in link, clears backup temporaries, writes the audit row and then the marker', () => {
    const { d, directory, session, link } = rig();
    const owner = directory.getUserByEmail('ana@example.com')!;
    const board = directory.createBoard({ id: 'guest-board', ownerId: owner.id })!;
    const code = directory.createJoinCode({
      boardId: board.id, createdBy: owner.id, codeHash: 'c'.repeat(64), role: 'commenter',
      createdAt: T0, expiresAt: T0 + 60_000, maxUses: 10,
    })!;
    const guestTokenHash = 'd'.repeat(64);
    directory.createGuestSession(code.id, { tokenHash: guestTokenHash, name: 'Guest', now: T0 });
    writeMarker(d, marker());
    const tmp = 'directory.sqlite.backup-0123456789abcdef.tmp';
    fs.writeFileSync(path.join(d, tmp), 'x');
    directory.setSetting('backup.status', JSON.stringify({ lastManifest: null, bytesStored: 7, running: true, nextRunAt: 5 }));
    const plan = planVolume({ dataDir: d, env: { TABULA_FLY_VOLUME_ID: 'vol_2' }, workspaceId: 'ws_a', now: T0 });
    const lines: string[] = [];
    expect(applyVolume({ dataDir: d, plan, directory, log: (l: string) => lines.push(l) })).toBe(true);

    expect(directory.getSession(session.token)).toBeNull();
    expect(directory.listActiveSessions()).toEqual([]);
    expect(directory.consumeLoginToken(link)).toBeNull();
    expect(directory.getGuestSession(guestTokenHash, T0)).toBeNull();
    expect(directory.getJoinCode(code.id)?.revokedAt).not.toBeNull();
    expect(fs.existsSync(path.join(d, tmp))).toBe(false);
    expect(JSON.parse(String(directory.getSetting('backup.status')))).toEqual({ lastManifest: null, bytesStored: 7, running: false, nextRunAt: null });
    const rows = directory.listAudit(10).filter((r: any) => r.action === AUDIT_ACTION);
    expect(rows).toEqual([expect.objectContaining({ actorId: null, detail: { from: { workspaceId: 'ws_a', flyVolumeId: 'vol_1' }, to: { workspaceId: 'ws_a', flyVolumeId: 'vol_2' }, reason: 'restored-copy' } })]);
    expect(readMarker(d)).toMatchObject({ flyVolumeId: 'vol_2', adoptedAt: T0, history: [{ reason: 'restored-copy' }] });
    expect(lines).toEqual([expect.stringMatching(/^volume: adopted volume a{32} \(restored-copy\)/)]);
  });

  it('recording a Fly id the first time signs nobody out and writes no audit row', () => {
    const { d, directory, session } = rig();
    writeMarker(d, marker({ flyVolumeId: null }));
    const plan = planVolume({ dataDir: d, env: { TABULA_FLY_VOLUME_ID: 'vol_1' }, workspaceId: 'ws_a', now: T0 });
    expect(applyVolume({ dataDir: d, plan, directory })).toBe(false);
    expect(directory.getSession(session.token)).not.toBeNull();
    expect(directory.listAudit(10).filter((r: any) => r.action === AUDIT_ACTION)).toEqual([]);
    expect(readMarker(d)).toEqual(marker({ flyVolumeId: 'vol_1' }));
  });

  it('does not adopt while a restore is pending, and leaves the marker and the sessions alone', () => {
    const { d, directory, session } = rig();
    writeMarker(d, marker());
    fs.writeFileSync(path.join(d, 'restore.json'), '{}');
    const plan = planVolume({ dataDir: d, env: { TABULA_FLY_VOLUME_ID: 'vol_2' }, workspaceId: 'ws_a', now: T0 });
    expect(() => applyVolume({ dataDir: d, plan, directory })).toThrow(/restore that is not finished/);
    expect(directory.getSession(session.token)).not.toBeNull();
    expect(readMarker(d)).toEqual(marker());
  });

  it('adopts over a rolled-back restore journal, which recovery leaves for the restore engine to record', () => {
    const { d, directory, session } = rig();
    writeMarker(d, marker());
    const journal = { version: 1, id: '0123456789abcdef', phase: 'rolled-back', manifest: '20260115T093000Z.json.enc', stagingDir: '.restore-0123456789abcdef', oldDir: '.pre-restore-1700000000000', files: [], oldFiles: [], startedAt: T0 - 5, error: 'interrupted' };
    fs.writeFileSync(path.join(d, 'restore.json'), JSON.stringify(journal));
    const plan = planVolume({ dataDir: d, env: { TABULA_FLY_VOLUME_ID: 'vol_2' }, workspaceId: 'ws_a', now: T0 });
    expect(applyVolume({ dataDir: d, plan, directory })).toBe(true);
    expect(directory.getSession(session.token)).toBeNull();
    expect(fs.existsSync(path.join(d, 'restore.json'))).toBe(true);
  });

  it('does not adopt next to a staging directory', () => {
    const d = tmpDir();
    writeMarker(d, marker());
    fs.mkdirSync(path.join(d, '.restore-0123456789abcdef'));
    const plan = planVolume({ dataDir: d, env: { TABULA_FLY_VOLUME_ID: 'vol_2' }, workspaceId: 'ws_a', now: T0 });
    expect(() => applyVolume({ dataDir: d, plan })).toThrow(/restore that is not finished/);
  });

  it('throws the refusal of an error plan', () => {
    const d = tmpDir();
    expect(() => applyVolume({ dataDir: d, plan: { action: 'error', message: 'no' } as any })).toThrow('no');
  });

  it('adopts in open mode without a directory', () => {
    const d = tmpDir();
    writeMarker(d, marker({ workspaceId: null }));
    const plan = planVolume({ dataDir: d, env: { TABULA_FLY_VOLUME_ID: 'vol_9' }, workspaceId: null, now: T0 });
    expect(applyVolume({ dataDir: d, plan })).toBe(true);
    expect(readMarker(d)).toMatchObject({ workspaceId: null, flyVolumeId: 'vol_9', adoptedAt: T0 });
  });
});
