import { describe, expect, it } from 'vitest';
import { LiveRuns, avoidFor, cleanName, parseRun, presenceLine, previewLabel, previewLayouts, type LiveRun } from '../src/ai-runs';
import type { Existing } from '../src/ai-apply';

// docs/ai.md, "Live runs": the app's copy of a board's AI runs, built from the relay's type-6 messages. Everything is
// checked on the way in, and previews are laid out in one order every app shares.

const ana = { id: 'u-ana', name: 'Ana', color: '#d64545' };
const create = { kind: 'create', objects: [{ text: 'one' }, { text: 'two' }] };
const ready = (id: string, startedAt: number, proposal: unknown = create) => ({ id, feature: 'generate', status: 'ready', by: ana, startedAt, readyAt: startedAt + 5, proposal, cut: false, target: null });

describe('parseRun', () => {
  it('reads an open run and normalises the person', () => {
    expect(parseRun({ ...ready('r1', 10), target: { ids: ['s1', 's2'] } })).toEqual({
      id: 'r1', feature: 'generate', status: 'ready', by: { id: 'u-ana', name: 'Ana', color: '#D64545' }, private: false,
      startedAt: 10, readyAt: 15, target: { ids: ['s1', 's2'] }, proposal: create, cut: false,
    });
  });

  it('reads a settled run', () => {
    expect(parseRun({ id: 'r1', feature: 'cluster', status: 'accepted', by: ana, resolvedBy: { id: 'u-ben', name: 'Ben' } })).toEqual({
      id: 'r1', feature: 'cluster', status: 'accepted', by: { id: 'u-ana', name: 'Ana', color: '#D64545' }, resolvedBy: { id: 'u-ben', name: 'Ben' }, error: null,
    });
  });

  it('refuses what it cannot draw safely', () => {
    for (const bad of [null, 'x', { id: 'r 1', feature: 'generate', status: 'running' }, { id: 'r1', feature: 'translate', status: 'running' }, { id: 'r1', feature: 'generate', status: 'odd' }, ready('r1', 1, { kind: 'create', objects: [] }), ready('r1', 1, null)]) {
      expect(parseRun(bad)).toBeNull();
    }
  });

  it('cleans names and colours, and drops bad target ids', () => {
    const run = parseRun({ id: 'r1', feature: 'generate', status: 'running', by: { id: 7, name: `  <b>Eve</b>‮\n${'x'.repeat(80)}`, color: 'red' }, target: { ids: ['ok', 'not ok', 3] } }) as LiveRun;
    expect(run.by.id).toBeNull();
    expect(run.by.color).toBeNull();
    expect(run.by.name!.startsWith('<b>Eve</b> x')).toBe(true);
    expect([...run.by.name!].length).toBeLessThanOrEqual(40);
    expect(run.target).toEqual({ ids: ['ok'] });
    expect(cleanName('   ')).toBeNull();
  });
});

describe('LiveRuns', () => {
  it('takes a snapshot, then patches, and reports what settled', () => {
    const runs = new LiveRuns();
    let changes = 0;
    runs.onChange(() => changes++);
    runs.apply({ kind: 'snapshot', runs: [ready('r2', 20), ready('r1', 10), { junk: true }] });
    expect(runs.list().map((r) => r.id)).toEqual(['r1', 'r2']);
    runs.apply({ kind: 'patch', run: { id: 'r3', feature: 'summarise', status: 'running', by: ana, startedAt: 30 } });
    expect(runs.list().map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    const settled = runs.apply({ kind: 'patch', run: { id: 'r1', feature: 'generate', status: 'discarded', by: ana, resolvedBy: { id: 'u-ben', name: 'Ben' } } });
    expect(settled.map((s) => [s.id, s.status])).toEqual([['r1', 'discarded']]);
    expect(runs.get('r1')).toBeUndefined();
    expect(changes).toBe(3);
  });

  it('reports a settle only for a run it had, except a failure, which the runner may not have seen start', () => {
    const runs = new LiveRuns();
    expect(runs.apply({ kind: 'patch', run: { id: 'zz', feature: 'generate', status: 'accepted', by: ana } })).toEqual([]);
    expect(runs.apply({ kind: 'patch', run: { id: 'zz', feature: 'generate', status: 'failed', by: ana, error: 'ai_timeout' } })).toHaveLength(1);
  });

  it('a new snapshot replaces everything, and drop forgets one run at once', () => {
    const runs = new LiveRuns();
    runs.apply({ kind: 'snapshot', runs: [ready('r1', 10), ready('r2', 20)] });
    runs.drop('r1');
    expect(runs.list().map((r) => r.id)).toEqual(['r2']);
    runs.apply({ kind: 'snapshot', runs: [] });
    expect(runs.list()).toEqual([]);
  });
});

describe('previewLayouts', () => {
  const board = (objects: Record<string, Existing> = {}) => ({ content: { x: 0, y: 0, w: 100, h: 100 }, get: (id: string) => objects[id] });
  const parse = (v: unknown) => parseRun(v) as LiveRun;

  it('lays previews out oldest first, each right of the ones before it', () => {
    const runs = [parse(ready('late', 20)), parse(ready('early', 10)), parse({ id: 'going', feature: 'generate', status: 'running', by: ana, startedAt: 5 })];
    const layouts = previewLayouts(runs, board());
    expect([...layouts.keys()]).toEqual(['early', 'late']);
    const early = layouts.get('early')!.area;
    const late = layouts.get('late')!.area;
    expect(early.x).toBe(180);
    expect(late.x).toBe(early.x + early.w + 80);
    expect(avoidFor('late', runs, layouts)).toEqual([early]);
    expect(avoidFor('early', runs, layouts)).toEqual([]);
  });

  it('leaves out a group that no longer fits the board, and a group claims no new space', () => {
    const group = { kind: 'group', groups: [{ title: 'A', ids: ['s1'] }] };
    const runs = [parse(ready('g', 1, group)), parse(ready('gone', 2, { kind: 'group', groups: [{ title: 'B', ids: ['nope'] }] })), parse(ready('c', 3))];
    const layouts = previewLayouts(runs, board({ s1: { type: 'sticky', x: 0, y: 0, w: 192, h: 192 } }));
    expect([...layouts.keys()]).toEqual(['g', 'c']);
    expect(layouts.get('c')!.area.x).toBe(180);
  });
});

describe('words', () => {
  it('names the person and the action, never the prompt', () => {
    expect(presenceLine({ by: { id: null, name: 'Ana', color: null }, feature: 'summarise' })).toBe('Ana is asking AI: Summarise…');
    expect(presenceLine({ by: { id: null, name: null, color: null }, feature: 'generate' })).toBe('Someone is asking AI: Generate ideas…');
    expect(previewLabel({ by: { id: null, name: 'Ana', color: null } }, false)).toBe("Ana's AI preview");
    expect(previewLabel({ by: { id: null, name: 'Ana', color: null } }, true)).toBe('Your AI preview');
  });
});
