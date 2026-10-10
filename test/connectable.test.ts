import { describe, expect, it } from 'vitest';
import { isConnectable } from '../src/connectable';
import type { Obj } from '../src/types';

const box = (type: string) => ({ id: 'o', type, x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a0' }) as unknown as Obj;

describe('what a connector can attach to', () => {
  it('takes stickies, shapes, text and kanban cards', () => {
    for (const type of ['sticky', 'shape', 'text', 'card', 'image', 'icon']) expect(`${type} ${isConnectable(box(type))}`).toBe(`${type} true`);
  });

  it('refuses lanes and the kanban container (they show no anchor dots and take no connector)', () => {
    expect(isConnectable(box('lane'))).toBe(false);
    expect(isConnectable(box('container'))).toBe(false);
  });

  it('still refuses frames, drawings, connectors, groups and nothing', () => {
    for (const type of ['frame', 'path', 'connector', 'group']) expect(`${type} ${isConnectable(box(type))}`).toBe(`${type} false`);
    expect(isConnectable(undefined)).toBe(false);
  });
});
