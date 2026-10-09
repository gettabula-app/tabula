import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RestoreError, SimulatedCrash, createRestore, recoverOnStart } from '../server/restore.mjs';
import { HOUR, MIN, harness, type Harness } from './backup-harness';
import { audits, backedUp, backupNow, becomeB, CONFIRM, filesOf, ownerOf, raw, rig, roomy, seedA } from './restore-harness';

// docs/backups.md, Restoring, "If the server stops in the middle". A crash is injected at every boundary of the swap
// (the engine calls a hook before and after each rename and each journal write) and again at every boundary of the
// recovery. The data directory must then be wholly the old data or wholly the new data, never a mixture.

const fixture = async (crashAt?: (point: string) => void) => {
  const h = await harness({ accounts: true });
  seedA(h);
  const r = rig(h, crashAt ? { crashAt } : {});
  const a = await backupNow(r.backup);
  const stateA = await backedUp(h, r.backup, a.manifest as string);
  h.clock.now += HOUR;
  becomeB(h);
  const stateB = filesOf(h.dir);
  h.clock.now += MIN;
  return { h, ...r, manifest: a.manifest as string, stateA, stateB, actor: ownerOf(h) };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

const restoreIt = (f: Fixture) => f.restore.restoreWorkspace({ manifest: f.manifest, confirm: CONFIRM, actor: f.actor });

/** The one boundary index to crash at, and the log of every boundary passed. */
function crashPlan(at: number | null) {
  const passed: string[] = [];
  return {
    passed,
    hook: (point: string) => {
      passed.push(point);
      if (at !== null && passed.length - 1 === at) throw new SimulatedCrash(point);
    },
  };
}

/** Which state the directory is in. Fails the test when it is neither, or when parts of both are present. */
async function whichState(dir: string, f: Fixture): Promise<'old' | 'new'> {
  const fixtureSetting = (await raw<{ value: string }>(dir, "SELECT value FROM settings WHERE key = 'fixture'"))[0]?.value;
  expect(['A', 'B']).toContain(fixtureSetting);
  const state = fixtureSetting === 'B' ? 'old' : 'new';
  const expected = state === 'old' ? f.stateB : f.stateA;
  const files = filesOf(dir);
  const same = files.size === expected.size && [...expected].every(([file, bytes]) => files.get(file)?.equals(bytes));
  expect(same, `a ${state} database with files that are not all ${state}`).toBe(true);
  return state;
}

const listing = (dir: string) => fs.readdirSync(dir).sort();

/** The mail outbox, notes and other files that are not data stay exactly where they are in every state. */
const untouched = (dir: string) => {
  expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('not data of ours');
  expect(fs.existsSync(path.join(dir, 'outbox.jsonl'))).toBe(true);
};

const noStrays = (dir: string) => {
  expect(listing(dir).filter((n) => n.startsWith('.restore-') || n.includes('.tmp-'))).toEqual([]);
};

describe('a crash at every boundary of the swap', () => {
  let points: string[] = [];
  let lastNewMove = 0;

  it('has boundaries before the journal, after it, after each rename batch and at the end', async () => {
    const plan = crashPlan(null);
    const f = await fixture(plan.hook);
    try {
      await restoreIt(f);
      await f.exited;
    } finally {
      await f.h.close();
    }
    points = plan.passed;
    lastNewMove = points.map((p) => p.startsWith('moved-new-')).lastIndexOf(true);
    expect(points[0]).toBe('before-journal');
    expect(points.filter((p) => p.startsWith('moved-old-')).length).toBeGreaterThanOrEqual(6);
    expect(points.filter((p) => p.startsWith('moved-new-')).length).toBeGreaterThanOrEqual(5);
    for (const needed of ['journal-tmp-written', 'journal-swapping', 'old-dir-made', 'journal-moved-old', 'journal-moved-new', 'staging-removed', 'journal-done']) {
      expect(points, `${needed}`).toContain(needed);
    }
    expect(points.length).toBeGreaterThan(20);
  });

  it('leaves the data wholly old or wholly new, whichever boundary the server stops at', async () => {
    expect(points.length).toBeGreaterThan(0);
    const outcomes: string[] = [];
    for (let i = 0; i < points.length; i++) {
      const plan = crashPlan(i);
      const f = await fixture(plan.hook);
      try {
        await expect(restoreIt(f)).rejects.toBeInstanceOf(SimulatedCrash);
        // a crashed process never leaves by itself
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(f.exits, `point ${i} ${points[i]}`).toEqual([]);

        // the next start
        const result = recoverOnStart({ dataDir: f.h.dir });
        const state = await whichState(f.h.dir, f);
        outcomes.push(`${points[i]}:${state}`);
        // at or after the last rename into place the new data is committed; before it, nothing is
        expect(state, `crash at ${i} ${points[i]}`).toBe(i >= lastNewMove ? 'new' : 'old');
        untouched(f.h.dir);
        noStrays(f.h.dir);
        const journal = fs.existsSync(path.join(f.h.dir, 'restore.json')) ? JSON.parse(fs.readFileSync(path.join(f.h.dir, 'restore.json'), 'utf8')) : null;
        // new: the restore is completed and the journal gone; before the journal: nothing to undo; otherwise undone
        const beforeJournal = i < points.indexOf('journal-swapping');
        const outcome = state === 'new' ? 'completed' : beforeJournal ? 'none' : 'rolled-back';
        expect(result.action, `${points[i]}`).toBe(outcome);
        expect(journal?.phase ?? null).toBe(outcome === 'rolled-back' ? 'rolled-back' : null);
        expect(journal?.error ?? null).toBe(outcome === 'rolled-back' ? 'interrupted' : null);
        expect(listing(f.h.dir).filter((n) => n.startsWith('.pre-restore-'))).toHaveLength(state === 'new' ? 1 : 0);
        // starting again changes nothing
        expect(recoverOnStart({ dataDir: f.h.dir }).action).toBe(result.action === 'completed' ? 'none' : result.action);
        expect(await whichState(f.h.dir, f)).toBe(state);
      } finally {
        await f.h.close();
      }
    }
    expect(outcomes.filter((o) => o.endsWith(':old')).length).toBeGreaterThan(10);
    expect(outcomes.filter((o) => o.endsWith(':new')).length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('records an undone restore in the database and the audit log once the server is up again', async () => {
    const plan = crashPlan(null);
    const f = await fixture((point) => {
      plan.hook(point);
      if (point === 'moved-new-1') throw new SimulatedCrash(point);
    });
    try {
      await expect(restoreIt(f)).rejects.toBeInstanceOf(SimulatedCrash);
      expect(recoverOnStart({ dataDir: f.h.dir }).action).toBe('rolled-back');
      expect(await whichState(f.h.dir, f)).toBe('old');

      const { openDirectory } = await import('../server/directory.mjs');
      const directory = openDirectory(path.join(f.h.dir, 'directory.sqlite'));
      try {
        const again = createRestore({ backup: f.backup, directory, config: f.h.config(), dataDir: f.h.dir, now: () => f.h.clock.now, statfs: roomy, log: () => {} })!;
        again.start();
        again.stop();
        expect(again.status().last).toMatchObject({ kind: 'workspace', result: 'failed', manifest: f.manifest, error: 'interrupted' });
        expect(audits(directory, 20).find((r) => r.action === 'restore.failed')).toMatchObject({ actorId: null, detail: { kind: 'workspace', manifest: f.manifest, error: 'interrupted' } });
        expect(fs.existsSync(path.join(f.h.dir, 'restore.json'))).toBe(false);
        // and it is not recorded twice
        const third = createRestore({ backup: f.backup, directory, config: f.h.config(), dataDir: f.h.dir, now: () => f.h.clock.now, statfs: roomy, log: () => {} })!;
        third.start();
        third.stop();
        expect(audits(directory, 50).filter((r) => r.action === 'restore.failed')).toHaveLength(1);
      } finally {
        directory.close();
      }
    } finally {
      await f.h.close();
    }
  });
});

describe('a crash inside the recovery itself', () => {
  it('is recovered by the next start, from every state the first crash can leave', async () => {
    // the interesting first crashes: partway through moving the old files out, partway through moving the new ones in,
    // and just after all of them are in place
    const firstPoints = ['moved-old-2', 'journal-moved-old', 'moved-new-0', 'moved-new-3', 'journal-moved-new'];
    let recoveryPoints = 0;
    for (const first of firstPoints) {
      let seen = -1;
      const probe = await fixture((point) => {
        if (point === first) throw new SimulatedCrash(point);
      });
      try {
        await expect(restoreIt(probe)).rejects.toBeInstanceOf(SimulatedCrash);
        // how many boundaries a clean recovery passes
        const measure = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-recovery-'));
        fs.cpSync(probe.h.dir, measure, { recursive: true });
        const counted = crashPlan(null);
        recoverOnStart({ dataDir: measure, step: counted.hook });
        fs.rmSync(measure, { recursive: true, force: true });
        seen = counted.passed.length;
        expect(seen, `${first}`).toBeGreaterThan(0);
        recoveryPoints += seen;

        for (let j = 0; j < seen; j++) {
          const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-recovery-'));
          try {
            fs.cpSync(probe.h.dir, copy, { recursive: true });
            const plan = crashPlan(j);
            expect(() => recoverOnStart({ dataDir: copy, step: plan.hook }), `${first} then ${j}`).toThrow(SimulatedCrash);
            // the server is started again, and again if that crashes too
            recoverOnStart({ dataDir: copy });
            const state = await whichState(copy, probe);
            expect(state, `${first} then a crash at recovery step ${j}`).toBe(first === 'journal-moved-new' ? 'new' : 'old');
            untouched(copy);
            noStrays(copy);
          } finally {
            fs.rmSync(copy, { recursive: true, force: true });
          }
        }
      } finally {
        await probe.h.close();
      }
    }
    expect(recoveryPoints).toBeGreaterThan(20);
  }, 120_000);
});

describe('recovery that cannot be trusted', () => {
  const journal = (h: Harness, patch: Record<string, unknown> = {}) => {
    const base = {
      version: 1, id: '0123456789abcdef', phase: 'moved-old', manifest: '20261008T193000Z.json.enc', stagingDir: '.restore-0123456789abcdef',
      oldDir: '.pre-restore-1790000000000', files: ['directory.sqlite'], oldFiles: ['directory.sqlite'], startedAt: 1,
    };
    fs.writeFileSync(path.join(h.dir, 'restore.json'), JSON.stringify({ ...base, ...patch }));
  };

  it('refuses to start on a journal it cannot read, and changes nothing', async () => {
    const h = await harness({ accounts: true });
    try {
      const before = listing(h.dir);
      fs.writeFileSync(path.join(h.dir, 'restore.json'), '{not json');
      expect(() => recoverOnStart({ dataDir: h.dir })).toThrow(RestoreError);
      for (const patch of [
        { version: 2 }, { phase: 'sideways' }, { stagingDir: '../escape' }, { oldDir: '.pre-restore-abc' }, { files: ['../../etc/passwd'] },
        { oldFiles: ['notes.txt'] }, { files: 'directory.sqlite' }, { manifest: 'x' }, { id: 'short' },
      ]) {
        journal(h, patch);
        expect(() => recoverOnStart({ dataDir: h.dir }), `${JSON.stringify(patch)}`).toThrow(RestoreError);
      }
      fs.rmSync(path.join(h.dir, 'restore.json'));
      expect(listing(h.dir)).toEqual(before);
    } finally {
      await h.close();
    }
  });

  it('refuses to overwrite a file that is in the way of the rollback', async () => {
    const h = await harness({ accounts: true });
    try {
      fs.mkdirSync(path.join(h.dir, '.pre-restore-1790000000000'));
      fs.writeFileSync(path.join(h.dir, '.pre-restore-1790000000000', 'b1.yjs'), 'old data');
      journal(h, { phase: 'swapping', files: ['b1.yjs'], oldFiles: ['b1.yjs'] });
      const live = fs.readFileSync(path.join(h.dir, 'b1.yjs'));
      expect(() => recoverOnStart({ dataDir: h.dir })).toThrow(/in the way/);
      expect(fs.readFileSync(path.join(h.dir, 'b1.yjs')).equals(live)).toBe(true);
      expect(fs.readFileSync(path.join(h.dir, '.pre-restore-1790000000000', 'b1.yjs'), 'utf8')).toBe('old data');
    } finally {
      await h.close();
    }
  });

  it('removes the staging directories of a crashed download, by name only, and nothing else', async () => {
    const h = await harness({ accounts: true });
    try {
      fs.mkdirSync(path.join(h.dir, '.restore-0123456789abcdef'));
      fs.writeFileSync(path.join(h.dir, '.restore-0123456789abcdef', 'directory.sqlite'), 'half');
      fs.mkdirSync(path.join(h.dir, '.restore-notours'));
      fs.writeFileSync(path.join(h.dir, 'restore.json.tmp-0123456789abcdef'), '{');
      fs.mkdirSync(path.join(h.dir, '.pre-restore-1790000000000'));
      expect(recoverOnStart({ dataDir: h.dir }).action).toBe('none');
      expect(listing(h.dir).filter((n) => n.startsWith('.restore-') || n.startsWith('restore.json') || n.startsWith('.pre-'))).toEqual(['.pre-restore-1790000000000', '.restore-notours']);
    } finally {
      await h.close();
    }
  });
});
