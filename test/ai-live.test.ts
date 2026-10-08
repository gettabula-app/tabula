import { describe, expect, it } from 'vitest';
import { MAX_RUNS_PER_BOARD, READY_TTL_MS, SETTLED_TTL_MS, STALE_RUNNING_MS, createLiveRuns } from '../server/ai/live.mjs';
import * as server from '../server/ai/policy.mjs';
import * as app from '../src/ai-policy';

// docs/ai.md, "Live runs": the in-memory runs of a board, what each person is sent about them, and the rules of
// policy.mjs, which src/ai-policy.ts repeats for the app's buttons.

function world() {
  const clock = { t: 1_000_000 };
  let n = 0;
  const live = createLiveRuns({ now: () => clock.t, newId: () => `run${++n}` });
  const changes: { boardId: string; status: string; id: string }[] = [];
  live.onChange(({ boardId, run }: any) => changes.push({ boardId, status: run.status, id: run.id }));
  return { clock, live, changes };
}

const ana = { id: 'u-ana', name: 'Ana' };
const editor = { role: 'editor', userId: 'u-ben' };
const proposal = { kind: 'create', objects: [{ text: 'A risk' }] };

describe('a run from start to settled', () => {
  it('goes running, ready, accepted, and tells the listener at each step', () => {
    const { live, changes } = world();
    const id = live.start('b1', { by: ana, feature: 'generate', prompt: 'risks of the move' });
    live.ready(id, { proposal, cut: true });
    const done = live.resolve(id, 'accept', { id: 'u-ben', name: 'Ben' });
    expect(done).toEqual({ ok: true, run: expect.objectContaining({ id, status: 'accepted' }), proposal, cut: true });
    expect(changes.map((c) => c.status)).toEqual(['running', 'ready', 'accepted']);
    expect(changes.every((c) => c.boardId === 'b1')).toBe(true);
    expect(live.openRuns('b1')).toEqual([]);
  });

  it('settles first come: a second accept or discard is told it came too late', () => {
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'generate' });
    live.ready(id, { proposal });
    expect(live.resolve(id, 'discard', ana).ok).toBe(true);
    expect(live.resolve(id, 'accept', ana)).toEqual({ ok: false, reason: 'settled' });
    expect(live.resolve(id, 'discard', ana)).toEqual({ ok: false, reason: 'settled' });
  });

  it('cannot settle a run that is still going, or one it never had', () => {
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'generate' });
    expect(live.resolve(id, 'accept', ana)).toEqual({ ok: false, reason: 'not_ready' });
    expect(live.resolve('nope', 'accept', ana)).toEqual({ ok: false, reason: 'gone' });
  });

  it('a failed run carries its code and no proposal, and is not in the snapshot', () => {
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'generate', prompt: 'p' });
    live.fail(id, 'ai_timeout');
    live.ready(id, { proposal });
    const run = live.get(id);
    expect(run).toMatchObject({ status: 'failed', error: 'ai_timeout', proposal: null, prompt: null });
    expect(live.snapshotFor('b1', editor)).toEqual({ kind: 'snapshot', runs: [] });
  });

  it('forgets the proposal and the prompt once a run is settled', () => {
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'generate', prompt: 'secret plan' });
    live.ready(id, { proposal });
    live.resolve(id, 'accept', ana);
    expect(JSON.stringify(live.get(id))).not.toContain('secret plan');
    expect(live.get(id).proposal).toBeNull();
  });
});

describe('time', () => {
  it('expires a ready run nobody settles, then forgets it', () => {
    const { live, clock, changes } = world();
    const id = live.start('b1', { by: ana, feature: 'generate' });
    live.ready(id, { proposal });
    clock.t += READY_TTL_MS - 1;
    live.sweep();
    expect(live.get(id).status).toBe('ready');
    clock.t += 1;
    live.sweep();
    expect(changes.at(-1)).toMatchObject({ id, status: 'expired' });
    expect(live.resolve(id, 'accept', ana)).toEqual({ ok: false, reason: 'settled' });
    clock.t += SETTLED_TTL_MS;
    expect(live.get(id)).toBeNull();
  });

  it('marks a run that never ended as failed', () => {
    const { live, clock } = world();
    const id = live.start('b1', { by: ana, feature: 'generate' });
    clock.t += STALE_RUNNING_MS;
    expect(live.get(id)).toMatchObject({ status: 'failed', error: 'ai_timeout' });
  });
});

describe('boards', () => {
  it('keeps boards apart, and drops a board without telling anyone', () => {
    const { live, changes } = world();
    const a = live.start('b1', { by: ana, feature: 'generate' });
    const b = live.start('b2', { by: ana, feature: 'generate' });
    expect(live.openRuns('b1').map((r: any) => r.id)).toEqual([a]);
    const before = changes.length;
    live.dropBoard('b1');
    expect(changes.length).toBe(before);
    expect(live.get(a)).toBeNull();
    expect(live.get(b)).not.toBeNull();
    live.ready(a, { proposal });
    expect(live.get(a)).toBeNull();
  });

  it(`holds at most ${MAX_RUNS_PER_BOARD} open runs on a board: the oldest ready one makes room`, () => {
    const { live, clock } = world();
    const ids: string[] = [];
    for (let i = 0; i < MAX_RUNS_PER_BOARD; i++) {
      ids.push(live.start('b1', { by: ana, feature: 'generate' }));
      clock.t += 1;
      live.ready(ids[i], { proposal });
    }
    live.start('b1', { by: ana, feature: 'generate' });
    expect(live.get(ids[0]).status).toBe('expired');
    expect(live.openRuns('b1')).toHaveLength(MAX_RUNS_PER_BOARD);
  });
});

describe('what each person is sent', () => {
  it('shows a ready run to everyone who can open the board, viewers too, with the proposal', () => {
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'generate', prompt: 'risks' });
    live.ready(id, { proposal });
    for (const role of ['owner', 'editor', 'commenter', 'viewer']) {
      expect(live.snapshotFor('b1', { role, userId: 'u-x' })).toEqual({
        kind: 'snapshot',
        runs: [{ id, feature: 'generate', status: 'ready', by: ana, startedAt: 1_000_000, readyAt: 1_000_000, proposal, cut: false }],
      });
    }
  });

  it('sends nothing to a socket without a role', () => {
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'generate' });
    expect(live.snapshotFor('b1', { role: null, userId: 'u-x' })).toBeNull();
    expect(live.patchFor(live.get(id), { role: null, userId: 'u-x' })).toBeNull();
    expect(live.patchFor(live.get(id), { role: 'stranger', userId: 'u-x' })).toBeNull();
  });

  it(`never sends the prompt while PROMPT_VISIBILITY is '${server.PROMPT_VISIBILITY}', not even to the runner`, () => {
    expect(server.PROMPT_VISIBILITY).toBe('runner');
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'generate', prompt: 'CANARY-prompt' });
    const sent: unknown[] = [live.patchFor(live.get(id), editor), live.patchFor(live.get(id), { role: 'owner', userId: ana.id })];
    live.ready(id, { proposal });
    sent.push(live.snapshotFor('b1', editor), live.snapshotFor('b1', { role: 'owner', userId: ana.id }));
    expect(JSON.stringify(sent)).not.toContain('CANARY');
  });

  it('a settled patch names the run, its status and who settled it, and nothing else', () => {
    const { live } = world();
    const id = live.start('b1', { by: ana, feature: 'summarise' });
    live.ready(id, { proposal });
    live.resolve(id, 'accept', { id: 'u-ben', name: 'Ben' });
    expect(live.patchFor(live.get(id), editor)).toEqual({
      kind: 'patch',
      run: { id, feature: 'summarise', status: 'accepted', by: ana, resolvedBy: { id: 'u-ben', name: 'Ben' } },
    });
  });

  it('an open-mode runner has neither id nor name', () => {
    const { live } = world();
    const id = live.start('b1', { by: { id: null, name: null }, feature: 'generate' });
    expect(live.patchFor(live.get(id), { role: 'owner', userId: null })!.run.by).toEqual({ id: null, name: null });
  });
});

describe('policy', () => {
  const ready = (byId: string | null, readyAt: number) => ({ status: 'ready', by: { id: byId }, readyAt });

  it('lets any editor settle a ready run, and nobody settle one that is not ready', () => {
    expect(server.RESOLVE_POLICY).toBe('editors');
    expect(server.canResolve({ role: 'editor', userId: 'u-ben', canEdit: true }, ready('u-ana', 0), 0)).toBe(true);
    expect(server.canResolve({ role: 'owner', userId: null, canEdit: true }, ready(null, 0), 0)).toBe(true);
    expect(server.canResolve({ role: 'editor', userId: 'u-ana', canEdit: true }, { ...ready('u-ana', 0), status: 'running' }, 0)).toBe(false);
  });

  it('never lets a commenter, a viewer or a read-only workspace settle', () => {
    expect(server.canResolve({ role: 'commenter', userId: 'u', canEdit: true }, ready('u', 0), 0)).toBe(false);
    expect(server.canResolve({ role: 'viewer', userId: 'u', canEdit: true }, ready('u', 0), 0)).toBe(false);
    expect(server.canResolve({ role: 'editor', userId: 'u', canEdit: false }, ready('u', 0), 0)).toBe(false);
  });

  it("'runner-first' gives the runner the run, then everyone after RUNNER_FIRST_MS", () => {
    const ben = { role: 'editor', userId: 'u-ben', canEdit: true };
    const anaV = { role: 'editor', userId: 'u-ana', canEdit: true };
    const run = ready('u-ana', 1000);
    expect(server.canResolve(anaV, run, 1000, 'runner-first')).toBe(true);
    expect(server.canResolve(ben, run, 1000 + server.RUNNER_FIRST_MS - 1, 'runner-first')).toBe(false);
    expect(server.canResolve(ben, run, 1000 + server.RUNNER_FIRST_MS, 'runner-first')).toBe(true);
  });

  it('is the same in the app as on the server', () => {
    expect(app.PROMPT_VISIBILITY).toBe(server.PROMPT_VISIBILITY);
    expect(app.RESOLVE_POLICY).toBe(server.RESOLVE_POLICY);
    expect(app.RUNNER_FIRST_MS).toBe(server.RUNNER_FIRST_MS);
    const roles = ['owner', 'editor', 'commenter', 'viewer', 'stranger', null];
    for (const role of roles) expect(app.canSeeRun(role)).toBe(server.canSeeRun(role));
    for (const visibility of ['everyone', 'runner', 'none'] as const) expect(app.showsPrompt(visibility)).toBe(server.showsPrompt(visibility));
    for (const role of roles)
      for (const canEdit of [true, false])
        for (const userId of ['u-ana', 'u-ben', null])
          for (const status of ['running', 'ready', 'accepted'])
            for (const now of [0, server.RUNNER_FIRST_MS - 1, server.RUNNER_FIRST_MS])
              for (const policy of ['editors', 'runner-first'] as const) {
                const viewer = { role, userId, canEdit };
                const run = { status, by: { id: 'u-ana' }, readyAt: 0 };
                expect(app.canResolve(viewer, run, now, policy)).toBe(server.canResolve(viewer, run, now, policy));
              }
  });
});
