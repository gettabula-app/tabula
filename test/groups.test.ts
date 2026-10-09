import { describe, expect, it } from 'vitest';
import {
  GROUP_MAX_DEPTH, GROUP_MAX_MEMBERS, GROUP_MAX_PER_BOARD, GROUP_NAME_MAX,
  ancestorsOf, descendantsOf, effectiveLocked, frameOf, groupDepth, groupFitsLimits, groupPlan, isGroup, liftToScope, membersBounds,
  outermostGroup, pick, topLevelAncestors, ungroupPlan,
} from '../src/groups';
import { referenceRects } from '../src/guides';
import type { BaseObj, ConnectorObj, Group, Obj } from '../src/types';

const group = (id: string, parent?: string, extra: Partial<Group> = {}): Group => ({
  id, type: 'group', x: 900, y: 800, w: 0, h: 0, rotation: 0, z: id, parent, ...extra,
});

const box = (id: string, parent?: string, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'sticky', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: id, parent, ...extra,
});

const connector = (id: string, parent?: string): ConnectorObj => ({
  id, type: 'connector', z: id, parent, from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 1, y: 1 },
  route: 'straight', startHead: 'none', endHead: 'arrow',
});

function access(objects: Obj[]) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  return {
    get: (id: string) => byId.get(id),
    children: (id: string) => objects.filter((o) => o.parent === id),
  };
}

describe('group parent walks', () => {
  it('walks through nested groups to the frame and identifies the outermost group', () => {
    const objects: Obj[] = [
      { ...box('frame'), type: 'frame' }, group('outer', 'frame'), group('inner', 'outer'), box('note', 'inner'),
    ];
    const { get, children } = access(objects);
    expect(ancestorsOf(get('note')!, get).map((o) => o.id)).toEqual(['inner', 'outer', 'frame']);
    expect(outermostGroup(get('note')!, get)?.id).toBe('outer');
    expect(frameOf(get('note')!, get)?.id).toBe('frame');
    expect(descendantsOf('outer', get, children).map((o) => o.id)).toEqual(['inner', 'note']);
    expect(isGroup(get('inner'))).toBe(true);
  });

  it('treats missing parents as top-level and stops at repeated ids in a cycle', () => {
    const objects: Obj[] = [group('a', 'b'), group('b', 'a'), box('leaf', 'a'), box('orphan', 'missing')];
    const { get, children } = access(objects);
    expect(ancestorsOf(get('orphan')!, get)).toEqual([]);
    expect(outermostGroup(get('orphan')!, get)).toBeUndefined();
    expect(frameOf(get('orphan')!, get)).toBeUndefined();
    expect(ancestorsOf(get('leaf')!, get).map((o) => o.id)).toEqual(['a', 'b']);
    // The repeated group id is the cycle's top-level object.
    expect(outermostGroup(get('leaf')!, get)?.id).toBe('a');
    expect(descendantsOf('a', get, children).map((o) => o.id)).toEqual(['b', 'leaf']);
  });

  it('counts nesting and enforces the agreed limits', () => {
    const objects: Obj[] = [];
    for (let i = 0; i < GROUP_MAX_DEPTH; i++) objects.push(group(`g${i}`, i ? `g${i - 1}` : undefined));
    const { get } = access(objects);
    expect(groupDepth(get(`g${GROUP_MAX_DEPTH - 1}`)!, get)).toBe(GROUP_MAX_DEPTH);
    expect(groupFitsLimits({ depth: GROUP_MAX_DEPTH, members: GROUP_MAX_MEMBERS, groups: GROUP_MAX_PER_BOARD, name: 'x'.repeat(GROUP_NAME_MAX) })).toBe(true);
    expect(groupFitsLimits({ depth: GROUP_MAX_DEPTH + 1, members: 0, groups: 0 })).toBe(false);
    expect(groupFitsLimits({ depth: 1, members: GROUP_MAX_MEMBERS + 1, groups: 0 })).toBe(false);
    expect(groupFitsLimits({ depth: 1, members: 0, groups: GROUP_MAX_PER_BOARD + 1 })).toBe(false);
    expect(groupFitsLimits({ depth: 1, members: 0, groups: 0, name: 'x'.repeat(GROUP_NAME_MAX + 1) })).toBe(false);
  });

  it('inherits lock only from group ancestors, while keeping a member lock', () => {
    const objects: Obj[] = [
      { ...box('frame'), type: 'frame', locked: true }, group('outer'), group('inner', 'outer', { locked: true }),
      box('note', 'inner'), box('own', 'outer', { locked: true }),
    ];
    const { get } = access(objects);
    expect(effectiveLocked(get('note')!, get)).toBe(true);
    expect(effectiveLocked(get('own')!, get)).toBe(true);
    expect(effectiveLocked(get('frame')!, get)).toBe(true);
    expect(effectiveLocked({ ...box('frame-child'), parent: 'frame' }, get)).toBe(false);
  });
});

describe('derived member bounds', () => {
  it('uses derived group geometry when building guide references', () => {
    const o = group('guide', undefined, { x: 999, y: 999 });
    const derived = { x: 25, y: 35, w: 100, h: 60 };
    expect(referenceRects([o], new Set(), () => false, () => derived)).toEqual([derived]);
  });

  it('unions visible leaves through nested groups and ignores hidden members, connectors and frames', () => {
    const objects: Obj[] = [
      group('root'), group('nested', 'root'),
      box('a', 'root', { x: 10, y: 20, w: 15, h: 25 }),
      box('b', 'nested', { x: 40, y: 60, w: 30, h: 35 }),
      box('secret', 'nested', { x: 500, y: 500, w: 80, h: 80 }),
      connector('line', 'root'), { ...box('frame-child', 'root'), type: 'frame' },
    ];
    const { get, children } = access(objects);
    expect(membersBounds(get('root') as Group, get, children, (o) => o.id !== 'secret'))
      .toEqual({ x: 10, y: 20, w: 60, h: 75 });
  });

  it('returns null for an empty group, including one with only connectors', () => {
    const objects: Obj[] = [group('empty'), connector('line', 'empty')];
    const { get, children } = access(objects);
    expect(membersBounds(get('empty') as Group, get, children)).toBeNull();
  });
});

describe('group selection plans', () => {
  it('picks through nested groups and lifts selections to one scope', () => {
    const objects: Obj[] = [group('outer'), group('inner', 'outer'), box('leaf', 'inner'), box('sibling', 'outer'), box('other')];
    const { get } = access(objects);
    expect(pick('leaf', null, get)?.id).toBe('outer');
    expect(pick('leaf', 'outer', get)?.id).toBe('inner');
    expect(pick('leaf', 'inner', get)?.id).toBe('leaf');
    expect(liftToScope(['leaf', 'inner', 'sibling'], 'outer', get).sort()).toEqual(['inner', 'sibling']);
    expect(topLevelAncestors(['leaf', 'inner', 'other'], get).sort()).toEqual(['other', 'outer']);
  });

  it('leaves frames and kanban lane children out, puts the group at the top member z and finds its frame', () => {
    const objects: Obj[] = [
      { ...box('frame'), type: 'frame', x: 0, y: 0, w: 200, h: 120, z: 'a0' },
      box('a', undefined, { x: 20, y: 20, w: 20, h: 20, z: 'a3', locked: true }),
      box('b', undefined, { x: 80, y: 20, w: 20, h: 20, z: 'a9' }),
      { ...box('lane'), type: 'lane' }, box('card', 'lane'),
      { ...connector('inside'), z: 'z9', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'b', anchor: 'auto' } },
      { ...connector('outside'), from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'outside-box', anchor: 'auto' } },
      box('outside-box'),
    ];
    const { get, children } = access(objects);
    const result = groupPlan(['a', 'b', 'frame', 'card', 'inside', 'outside'], get, children, {
      all: () => objects, bounds: (o) => ({ x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 }),
      frameAt: (p) => p.x > 0 && p.x < 200 ? get('frame') as BaseObj : undefined, newId: () => 'new-group',
    });
    expect(result).toMatchObject({
      ok: true, group: { id: 'new-group', z: 'z9', parent: 'frame' }, members: ['a', 'b'],
      skipped: { frames: 1, other: 2 }, connectors: ['inside'],
    });
  });

  it('counts free connector ends only when they lie on selected items and refuses fewer than two items', () => {
    const objects: Obj[] = [
      box('a', undefined, { x: 0, y: 0, w: 20, h: 20, z: 'a1' }),
      box('b', undefined, { x: 80, y: 0, w: 20, h: 20, z: 'a2' }),
      { ...connector('free-inside'), from: { kind: 'free', x: 10, y: 10 }, to: { kind: 'free', x: 90, y: 10 } },
      { ...connector('free-outside'), from: { kind: 'free', x: 10, y: 10 }, to: { kind: 'free', x: 300, y: 300 } },
      { ...box('frame'), type: 'frame' },
    ];
    const { get, children } = access(objects);
    const helpers = { all: () => objects, bounds: (o: Obj) => ({ x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 }), frameAt: () => undefined, newId: () => 'g' };
    expect(groupPlan(['a', 'b'], get, children, helpers)).toMatchObject({ ok: true, connectors: ['free-inside'] });
    expect(groupPlan(['frame', 'a'], get, children, helpers)).toMatchObject({ ok: false, reason: expect.stringContaining('two') });
  });

  it('enforces depth, direct-member and board group limits', () => {
    const depthItems: Obj[] = [];
    for (let i = 0; i < GROUP_MAX_DEPTH; i++) depthItems.push(group(`g${i}`, i ? `g${i - 1}` : undefined));
    depthItems.push(box('one', 'g7'), box('two', 'g7'));
    const depthAccess = access(depthItems);
    expect(groupPlan(['one', 'two'], depthAccess.get, depthAccess.children, {
      scope: 'g7', all: () => depthItems, bounds: (o) => ({ x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 }), frameAt: () => undefined, newId: () => 'x',
    })).toMatchObject({ ok: false, reason: expect.stringContaining('8 levels') });

    const allowedDepth: Obj[] = [];
    for (let i = 0; i < GROUP_MAX_DEPTH - 1; i++) allowedDepth.push(group(`a${i}`, i ? `a${i - 1}` : undefined));
    allowedDepth.push(box('allowed-one', 'a6'), box('allowed-two', 'a6'));
    const allowedAccess = access(allowedDepth);
    expect(groupPlan(['allowed-one', 'allowed-two'], allowedAccess.get, allowedAccess.children, {
      scope: 'a6', all: () => allowedDepth, bounds: (o) => ({ x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 }), frameAt: () => undefined, newId: () => 'at-limit',
    })).toMatchObject({ ok: true, group: { id: 'at-limit' } });

    const members = Array.from({ length: GROUP_MAX_MEMBERS + 1 }, (_, i) => box(`m${i}`));
    const memberAccess = access(members);
    expect(groupPlan(members.map((o) => o.id), memberAccess.get, memberAccess.children, {
      all: () => members, bounds: (o) => ({ x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 }), frameAt: () => undefined, newId: () => 'x',
    })).toMatchObject({ ok: false, reason: expect.stringContaining('500 items') });

    const manyGroups = [...Array.from({ length: GROUP_MAX_PER_BOARD }, (_, i) => group(`g${i}`)), box('a'), box('b')];
    const boardAccess = access(manyGroups);
    expect(groupPlan(['a', 'b'], boardAccess.get, boardAccess.children, {
      all: () => manyGroups, bounds: (o) => ({ x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 }), frameAt: () => undefined, newId: () => 'x',
    })).toMatchObject({ ok: false, reason: expect.stringContaining('500 groups') });
  });
});

describe('ungroup plans', () => {
  it('places ordered members at the group z between its siblings, keeping the parent and nested groups', () => {
    const objects: Obj[] = [
      box('below', 'frame', { z: 'a0' }),
      group('g', 'frame', { z: 'a5' }),
      box('b', 'g', { z: 'z2' }), group('nested', 'g', { z: 'z3' }), box('a', 'g', { z: 'z1' }),
      box('above', 'frame', { z: 'a9' }),
    ];
    const { get, children } = access(objects);
    const plan = ungroupPlan(['g'], get, children, { all: () => objects });
    const members = plan.groups[0].members;
    expect(members.map((m) => m.id)).toEqual(['a', 'b', 'nested']);
    expect(members.every((m) => m.parent === 'frame' && m.z > 'a5' && m.z < 'a9')).toBe(true);
    expect(members.map((m) => m.z)).toEqual(members.map((m) => m.z).sort());
    expect(get('nested')?.type).toBe('group');
  });

  it('plans empty and one-member groups and removes only the level requested', () => {
    const objects: Obj[] = [group('empty', undefined, { z: 'a0' }), group('one', undefined, { z: 'a3' }), box('member', 'one'), group('outer', undefined, { z: 'a6' }), group('inner', 'outer'), box('leaf', 'inner')];
    const { get, children } = access(objects);
    const plan = ungroupPlan(['empty', 'one', 'outer'], get, children, { all: () => objects });
    expect(plan.groups.map((g) => g.id)).toEqual(['empty', 'one', 'outer']);
    expect(plan.groups[0].members).toEqual([]);
    expect(plan.groups[1].members).toHaveLength(1);
    expect(plan.groups[2].members.map((m) => m.id)).toEqual(['inner']);
    expect(get('inner')?.parent).toBe('outer');
  });
});
