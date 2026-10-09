import { describe, expect, it } from 'vitest';
import { cleanName, hiddenCount, layerLabel, layerTree, moveAmongSiblings, moveNextTo, type LayerBoard } from '../src/layers';
import type { Obj } from '../src/types';

// TAB-198: the layers panel lists items top first, nests children under frames and containers, and a drag or a key writes
// one z key that puts the item directly above or below another.

const o = (id: string, z: string, extra: Record<string, unknown> = {}): Obj =>
  ({ id, type: 'shape', x: 0, y: 0, w: 10, h: 10, rotation: 0, z, ...extra }) as unknown as Obj;

const board = (over: Partial<LayerBoard> = {}): LayerBoard => ({ visible: () => true, isLaidOut: () => false, layoutOrder: () => [], ...over });
const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id);
const zOf = (objs: Obj[], patches: { id: string; z: string }[] | null) => {
  const map = new Map(objs.map((x) => [x.id, x.z]));
  for (const p of patches ?? []) map.set(p.id, p.z);
  // frames paint below the rest whatever their key, so the order is compared within each class, frames first
  const frame = new Set(objs.filter((x) => x.type === 'frame').map((x) => x.id));
  const sorted = [...map.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id);
  return [...sorted.filter((id) => frame.has(id)), ...sorted.filter((id) => !frame.has(id))];
};

describe('layerLabel', () => {
  it('uses the name, then the text, then the type', () => {
    expect(layerLabel(o('a', 'a0', { name: '  Hero  image ' }))).toBe('Hero image');
    expect(layerLabel(o('a', 'a0', { type: 'sticky', text: 'Line one\nline two' }))).toBe('Line one line two');
    expect(layerLabel(o('a', 'a0', { type: 'sticky', text: 'x'.repeat(100) }))).toHaveLength(48);
    expect(layerLabel(o('a', 'a0', { type: 'frame' }))).toBe('Frame');
    expect(layerLabel(o('a', 'a0', { type: 'mystery' }))).toBe('Object');
  });

  it('cleans a name to one line of 80 characters, empty for none', () => {
    expect(cleanName('  a\n b ')).toBe('a b');
    expect(cleanName('   ')).toBeUndefined();
    expect([...cleanName('y'.repeat(200))!]).toHaveLength(80);
  });
});

describe('layerTree', () => {
  it('lists the top first, frames last, and children under their frame', () => {
    const objs = [o('low', 'a1'), o('high', 'a5'), o('f1', 'a0', { type: 'frame' }), o('f2', 'a9', { type: 'frame' }), o('in1', 'a2', { parent: 'f1' }), o('in2', 'a7', { parent: 'f1' })];
    const nodes = layerTree(objs, board());
    expect(ids(nodes)).toEqual(['high', 'low', 'f2', 'f1', 'in2', 'in1']);
    expect(nodes.find((n) => n.id === 'in2')).toMatchObject({ depth: 1, parent: 'f1', movable: true });
    expect(nodes.find((n) => n.id === 'f1')).toMatchObject({ expandable: true, expanded: true, childCount: 2 });
  });

  it('hides a collapsed container\'s children, and keeps per-node flags', () => {
    const objs = [o('f', 'a0', { type: 'frame' }), o('c', 'a1', { parent: 'f', locked: true, hidden: true })];
    expect(ids(layerTree(objs, board(), new Set(['f'])))).toEqual(['f']);
    expect(layerTree(objs, board())[1]).toMatchObject({ locked: true, hidden: true });
  });

  it('leaves out what the person may not see, and lists an orphan at the top level', () => {
    const objs = [o('mine', 'a1'), o('theirs', 'a2', { privateStep: 's' }), o('lost', 'a3', { parent: 'gone' })];
    const nodes = layerTree(objs, board({ visible: (x) => !(x as { privateStep?: string }).privateStep }));
    expect(ids(nodes)).toEqual(['lost', 'mine']);
    expect(nodes[0].parent).toBeNull();
  });

  it('lists a container\'s laid-out cards in its layout order, not movable', () => {
    const objs = [o('k', 'a0', { type: 'container' }), o('c1', 'a9', { type: 'card', parent: 'k' }), o('c2', 'a1', { type: 'card', parent: 'k' })];
    const nodes = layerTree(objs, board({ isLaidOut: (x) => x.type === 'card', layoutOrder: () => ['c2', 'c1'] }));
    expect(ids(nodes)).toEqual(['k', 'c2', 'c1']);
    expect(nodes[1].movable).toBe(false);
  });

  it('counts the hidden objects the person can see', () => {
    const objs = [o('a', 'a1', { hidden: true }), o('b', 'a2'), o('p', 'a3', { hidden: true, privateStep: 's' })];
    expect(hiddenCount(objs, { visible: (x) => !(x as { privateStep?: string }).privateStep })).toBe(1);
  });
});

describe('moveNextTo', () => {
  const objs = [o('a', 'a1'), o('b', 'a2'), o('c', 'a3'), o('d', 'a4'), o('f', 'a0', { type: 'frame' })];
  const laid = () => false;

  it('puts an item directly above or below another, with one key', () => {
    const up = moveNextTo(objs, 'a', 'c', 'above', laid);
    expect(up).toHaveLength(1);
    expect(zOf(objs, up)).toEqual(['f', 'b', 'c', 'a', 'd']);
    expect(zOf(objs, moveNextTo(objs, 'd', 'a', 'below', laid))).toEqual(['f', 'd', 'a', 'b', 'c']);
    expect(zOf(objs, moveNextTo(objs, 'a', 'd', 'above', laid))).toEqual(['f', 'b', 'c', 'd', 'a']);
  });

  it('does nothing when already there, across classes, or for a laid-out item', () => {
    expect(moveNextTo(objs, 'b', 'a', 'above', laid)).toBeNull();
    expect(moveNextTo(objs, 'a', 'f', 'above', laid)).toBeNull();
    expect(moveNextTo(objs, 'a', 'a', 'above', laid)).toBeNull();
    expect(moveNextTo(objs, 'a', 'c', 'above', (x) => x.id === 'a')).toBeNull();
  });

  it('rewrites the class evenly when keys are equal (an old board)', () => {
    const flat = [o('a', 'a1'), o('b', 'a1'), o('c', 'a1')];
    const patches = moveNextTo(flat, 'a', 'c', 'above', laid);
    expect(zOf(flat, patches)).toEqual(['b', 'c', 'a']);
  });
});

describe('moveAmongSiblings', () => {
  it('moves one row up or down among siblings, and stops at the ends', () => {
    const objs = [o('f', 'a0', { type: 'frame' }), o('x', 'a1', { parent: 'f' }), o('y', 'a2', { parent: 'f' }), o('top', 'a3')];
    const nodes = layerTree(objs, board());
    expect(ids(nodes)).toEqual(['top', 'f', 'y', 'x']);
    expect(zOf(objs, moveAmongSiblings(nodes, objs, 'x', -1, () => false))).toEqual(['f', 'y', 'x', 'top']);
    expect(moveAmongSiblings(nodes, objs, 'y', -1, () => false)).toBeNull();
    expect(moveAmongSiblings(nodes, objs, 'top', 1, () => false)).toBeNull();
  });
});
