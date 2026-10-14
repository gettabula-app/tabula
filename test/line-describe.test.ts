import { describe, expect, it } from 'vitest';
import { describeObject } from '../src/canvas-describe';
import { layerLabel } from '../src/layers';
import type { Obj } from '../src/types';

const ctx = { get: () => undefined, childCount: () => 0 };
const line = (extra: Record<string, unknown> = {}) => ({
  id: 'l', type: 'connector', z: 'a', x: 0, y: 0, w: 0, h: 0, rotation: 0, route: 'straight', startHead: 'none', endHead: 'none',
  from: { kind: 'free', x: 10.4, y: 20 }, to: { kind: 'free', x: 130.6, y: -5 }, line: true, ...extra,
}) as unknown as Obj;

describe('a line in the outline and the layers list', () => {
  it('is described as a Line with its ends by position, not as a connector', () => {
    expect(describeObject(line(), ctx).name).toBe('Line from 10,20 to 131,-5');
  });

  it('is named Line in the layers list when it has no name of its own', () => {
    expect(layerLabel(line())).toBe('Line');
    expect(layerLabel(line({ name: 'Arrow of doom' }))).toBe('Arrow of doom');
  });

  it('keeps the connector description once it is bound or not straight', () => {
    const bound = line({ to: { kind: 'bound', id: 'b', anchor: 'auto' }, line: undefined });
    expect(describeObject(bound, { get: () => undefined, childCount: () => 0 }).name).toMatch(/^Connector from /);
    expect(layerLabel(bound)).toBe('Connector');
  });
});
