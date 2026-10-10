import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { exportSvg } from '../src/exporters';
import { hitBox } from '../src/geometry';
import { objectMarkup } from '../src/markup';
import { safeObj } from '../src/safe-obj';
import { Store } from '../src/store';
import type { BaseObj, Obj } from '../src/types';
import type { BoardApp } from '../src/app';

const transform = 'translate(40 30) scale(-1 1) translate(-40 -30)';
const base = (type: BaseObj['type'], extra: Partial<BaseObj> = {}): BaseObj => ({
  id: type, type, x: 10, y: 20, w: 80, h: 60, rotation: 0.2, z: 'a0', flipX: true, ...extra,
});
const ctx = {
  get: () => undefined,
  imageState: () => ({ kind: 'ok' as const, url: 'data:image/png;base64,AA==' }),
};

describe('flipped SVG rendering', () => {
  it('mirrors shape geometry while leaving its label outside the mirror group', () => {
    const svg = objectMarkup(base('shape', { kind: 'callout-rect', text: 'Readable label' }), ctx);
    const mirrorAt = svg.indexOf(transform);
    const closeAt = svg.indexOf('</g>', mirrorAt);
    const textAt = svg.indexOf('<text');
    expect(svg).toContain(`transform="${transform}"`);
    expect(svg.indexOf('<path')).toBeGreaterThan(mirrorAt);
    expect(closeAt).toBeGreaterThan(mirrorAt);
    expect(textAt).toBeGreaterThan(closeAt);
    expect(svg).toContain('Readable');
    expect(svg).toContain('label</tspan>');
  });

  it('mirrors UML geometry and leaves its text outside the mirror group', () => {
    const svg = objectMarkup(base('uml-package', { text: 'Readable package' }), ctx);
    const mirrorAt = svg.indexOf(transform);
    const closeAt = svg.indexOf('</g>', mirrorAt);
    const textAt = svg.indexOf('<text');
    expect(svg.indexOf('<path')).toBeGreaterThan(mirrorAt);
    expect(textAt).toBeGreaterThan(closeAt);
    expect(svg).toContain('Readable package');
  });

  it.each([
    ['icon', '<svg'],
    ['image', '<image'],
    ['path', '<path'],
  ] as const)('mirrors %s markup', (type, geometryTag) => {
    const extra: Partial<BaseObj> = type === 'icon'
      ? { body: '<path d="M0 0H24V24Z"/>', viewBox: [0, 0, 24, 24] as [number, number, number, number] }
      : type === 'path' ? { points: [5, 5, 20, 40, 60, 15] } : {};
    const svg = objectMarkup({ ...base(type, extra), id: type } as unknown as Obj, ctx);
    const mirrorAt = svg.indexOf(transform);
    expect(mirrorAt).toBeGreaterThan(-1);
    expect(svg.indexOf(geometryTag, mirrorAt)).toBeGreaterThan(mirrorAt);
  });

  it('keeps mirrored markup in the SVG export path', () => {
    const store = new Store(new Y.Doc());
    store.create(base('shape', { kind: 'arrow-right', text: 'E' }));
    const app = {
      store,
      r: {
        contentBounds: () => ({ x: 10, y: 20, w: 80, h: 60 }),
        ctx: { get: (id: string) => store.getPlaced(id) },
      },
    } as unknown as BoardApp;
    const { svg } = exportSvg(app, ['shape'], { fontCss: '' });
    expect(svg).toContain(`transform="${transform}"`);
    expect(svg).toContain('>E</tspan>');
  });

  it('keeps shape hit tests bounding-box based and maps path hits through the visible mirror', () => {
    const arrow = base('shape', { kind: 'arrow-right', flipX: true, rotation: 0 });
    expect(hitBox(arrow, { x: 30, y: 30 }, 0)).toBe(true);
    expect(hitBox({ ...arrow, flipX: undefined }, { x: 30, y: 30 }, 0)).toBe(true);

    const path = base('path', { points: [10, 5, 70, 55], flipX: true, rotation: 0 });
    expect(hitBox(path, { x: 20, y: 75 }, 0)).toBe(true);
    expect(hitBox(path, { x: 80, y: 75 }, 0)).toBe(false);
  });

  it('keeps polygon and UML hit tests bounding-box based while ellipses stay precise', () => {
    const corner = { x: 11, y: 21 };
    const diamond = base('shape', { kind: 'diamond', flipX: true, rotation: 0 });
    const initial = base('uml-initial', { flipX: true, rotation: 0 });
    const usecase = base('uml-usecase', { flipY: true, rotation: 0 });
    const ellipse = base('shape', { kind: 'ellipse', flipX: true, rotation: 0 });

    expect(hitBox(diamond, corner, 0)).toBe(true);
    expect(hitBox({ ...diamond, flipX: undefined }, corner, 0)).toBe(true);
    expect(hitBox(initial, corner, 0)).toBe(true);
    expect(hitBox({ ...initial, flipX: undefined }, corner, 0)).toBe(true);
    expect(hitBox(usecase, corner, 0)).toBe(true);
    expect(hitBox({ ...usecase, flipY: undefined }, corner, 0)).toBe(true);
    expect(hitBox(ellipse, corner, 0)).toBe(false);
    expect(hitBox({ ...ellipse, flipX: undefined }, corner, 0)).toBe(false);
  });

  it('drops nonboolean flip flags before rendering', () => {
    const unsafe = { ...base('shape'), flipX: 'yes' } as unknown as Obj;
    expect(safeObj(unsafe)).not.toHaveProperty('flipX');
  });
});
