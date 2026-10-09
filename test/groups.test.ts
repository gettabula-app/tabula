import { describe, expect, it } from 'vitest';
import {
  GROUP_MAX_DEPTH, GROUP_MAX_MEMBERS, GROUP_MAX_PER_BOARD, GROUP_NAME_MAX,
  ancestorsOf, descendantsOf, effectiveLocked, frameOf, groupDepth, groupFitsLimits, isGroup, membersBounds, outermostGroup,
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
