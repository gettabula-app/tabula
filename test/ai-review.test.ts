import { describe, expect, it } from 'vitest';
import { addLabel, fingerprintOf, isStale, refreshStale, reviewCounts, reviewed, startReview, TEXT_MAX, TITLE_MAX } from '../src/ai-review';
import { cleanProposedBy, PROPOSED_NAME_MAX, safeObj } from '../src/safe-obj';
import type { AiProposal } from '../src/ai-apply';
import type { BaseObj } from '../src/types';

// TAB-160: reviewing an AI proposal item by item. A review is the reviewer's own; reviewed() is what is drawn on their
// screen and what is added. And proposedBy, the doc field that says which run an object came from, read as hostile data.

const create: AiProposal = { kind: 'create', objects: [{ text: 'Ship smaller', color: 'Pink' }, { text: 'Fix flaky tests' }, { text: 'Own the backlog', color: 'Teal' }], frame: { title: 'Summary' } };
const group: AiProposal = { kind: 'group', groups: [{ title: 'Went well', ids: ['a', 'b'] }, { title: 'To fix', ids: ['c'] }] };

describe('a create proposal', () => {
  it('starts with everything kept, and unchanged it is the proposal itself', () => {
    const r = startReview(create);
    expect(reviewed(create, r)).toEqual(create);
    expect(reviewCounts(r)).toEqual({ kept: 3, total: 3, stale: 0 });
    expect(addLabel(create, r)).toBe('Add all (3)');
  });

  it('leaves out unticked and emptied stickies, keeps edits and colours, and drops the frame when asked', () => {
    const r = startReview(create);
    if (r.kind !== 'create') throw new Error('kind');
    r.items[0].keep = false;
    r.items[1].text = '  Fix the flaky tests first  ';
    r.items[1].color = 'blue';
    r.items[2].text = '   ';
    expect(reviewed(create, r)).toEqual({ kind: 'create', objects: [{ text: 'Fix the flaky tests first', color: 'Blue' }], frame: { title: 'Summary' } });
    r.frame!.keep = false;
    expect(reviewed(create, r)).toEqual({ kind: 'create', objects: [{ text: 'Fix the flaky tests first', color: 'Blue' }] });
    expect(addLabel(create, r)).toBe('Add selected (1)');
  });

  it('is nothing when nothing is left, and caps text, titles and colours as the server would', () => {
    const r = startReview(create);
    if (r.kind !== 'create') throw new Error('kind');
    r.items.forEach((i) => (i.keep = false));
    expect(reviewed(create, r)).toBeNull();
    r.items[0].keep = true;
    r.items[0].text = 'x'.repeat(TEXT_MAX + 50);
    r.items[0].color = 'magenta';
    r.frame!.title = `  a\nb ${'t'.repeat(TITLE_MAX)}`;
    const out = reviewed(create, r)!;
    if (out.kind !== 'create') throw new Error('kind');
    expect([...out.objects[0].text]).toHaveLength(TEXT_MAX);
    expect(out.objects[0]).not.toHaveProperty('color');
    expect(out.frame!.title.startsWith('a b ')).toBe(true);
    expect([...out.frame!.title]).toHaveLength(TITLE_MAX);
  });
});

describe('a group proposal', () => {
  it('drops unticked groups and members, and groups left empty or without a title', () => {
    const r = startReview(group);
    if (r.kind !== 'group') throw new Error('kind');
    expect(addLabel(group, r)).toBe('Move all (3)');
    r.groups[0].members[1].keep = false;
    r.groups[0].title = 'Kept going well';
    r.groups[1].title = '   ';
    expect(reviewed(group, r)).toEqual({ kind: 'group', groups: [{ title: 'Kept going well', ids: ['a'] }] });
    expect(reviewCounts(r)).toEqual({ kept: 1, total: 3, stale: 0 });
    expect(addLabel(group, r)).toBe('Move selected (1)');
    r.groups[0].keep = false;
    expect(reviewed(group, r)).toBeNull();
  });

  it('unticks members that changed since the proposal arrived, and never moves them', () => {
    const r = startReview(group, (id) => id === 'b');
    if (r.kind !== 'group') throw new Error('kind');
    expect(r.groups[0].members).toEqual([{ id: 'a', keep: true, stale: false }, { id: 'b', keep: false, stale: true }]);
    r.groups[0].members[1].keep = true; // ticking a stale one does not add it
    expect(reviewed(group, r)).toEqual({ kind: 'group', groups: [{ title: 'Went well', ids: ['a'] }, { title: 'To fix', ids: ['c'] }] });
    const later = refreshStale(r, (id) => id === 'b' || id === 'c');
    if (later.kind !== 'group') throw new Error('kind');
    expect(later.groups[1].members[0]).toEqual({ id: 'c', keep: false, stale: true });
    expect(reviewed(group, later)).toEqual({ kind: 'group', groups: [{ title: 'Went well', ids: ['a'] }] });
    expect(refreshStale(later, (id) => id === 'b' || id === 'c')).toBe(later);
  });

  it('calls a member stale when it moved, was resized, edited, put in another frame or is gone', () => {
    const then = fingerprintOf({ x: 1, y: 2, w: 3, h: 4, text: 'a', parent: 'f' });
    expect(isStale(then, fingerprintOf({ x: 1, y: 2, w: 3, h: 4, text: 'a', parent: 'f' }))).toBe(false);
    for (const now of [{ x: 9 }, { y: 9 }, { w: 9 }, { h: 9 }, { text: 'b' }, { parent: 'g' }]) {
      expect(isStale(then, fingerprintOf({ x: 1, y: 2, w: 3, h: 4, text: 'a', parent: 'f', ...now }))).toBe(true);
    }
    expect(isStale(then, null)).toBe(true);
    expect(isStale(undefined, fingerprintOf({ x: 0 }))).toBe(false);
  });
});

describe('proposedBy is read as hostile data', () => {
  it('keeps the one allowed shape', () => {
    expect(cleanProposedBy({ feature: 'summarise', by: { id: 'u_ana-1', name: 'Ana' } })).toEqual({ feature: 'summarise', by: { id: 'u_ana-1', name: 'Ana' } });
    expect(cleanProposedBy({ feature: 'generate', by: {} })).toEqual({ feature: 'generate', by: { id: null, name: null } });
  });

  it.each([
    ['not an object', 'summarise'],
    ['an array', ['summarise']],
    ['null', null],
    ['an unknown feature', { feature: 'translate', by: { name: 'Ana' } }],
    ['a feature that is not text', { feature: 1, by: { name: 'Ana' } }],
  ])('drops %s', (_name, value) => {
    expect(cleanProposedBy(value)).toBeUndefined();
  });

  it('cleans and caps the name, refuses an odd id, and drops everything else', () => {
    const out = cleanProposedBy({
      feature: 'cluster',
      by: { id: 'x" onload="alert(1)', name: `  <img src=x onerror=alert(1)>‮\u0000\n${'n'.repeat(80)}`, email: 'a@b.c' },
      extra: { script: true },
    })!;
    expect(out).toEqual({ feature: 'cluster', by: { id: null, name: expect.any(String) } });
    expect([...out.by.name!].length).toBeLessThanOrEqual(PROPOSED_NAME_MAX);
    expect(out.by.name!.startsWith('<img src=x onerror=alert(1)> n')).toBe(true); // text, never markup: the panel sets textContent
    expect([...out.by.name!].some((c) => c.codePointAt(0)! < 0x20 || c === '\u202e')).toBe(false);
    expect(cleanProposedBy({ feature: 'cluster', by: { name: 42, id: 7 } })).toEqual({ feature: 'cluster', by: { id: null, name: null } });
  });

  it('goes through safeObj: a bad value is dropped from what is drawn, a good one is cleaned', () => {
    const base: BaseObj = { id: 's', type: 'sticky', x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 'a0' };
    expect(safeObj({ ...base, proposedBy: { feature: 'evil' } } as unknown as BaseObj)).not.toHaveProperty('proposedBy');
    expect(safeObj({ ...base, proposedBy: { feature: 'generate', by: { name: 'Ana‮', id: 'u1', role: 'admin' } } } as unknown as BaseObj).proposedBy).toEqual({ feature: 'generate', by: { id: 'u1', name: 'Ana' } });
  });
});
