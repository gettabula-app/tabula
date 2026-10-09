import { describe, expect, it } from 'vitest';
import { objectMarkup, styleOf, DEFAULTS } from '../src/markup';
import { headMarkup } from '../src/shapes';
import type { BaseObj, ConnectorObj, Head, Obj, ObjType } from '../src/types';
import { CANVAS_INK } from '../src/palette';
import { HOSTILE_VALUES, markupProblems } from './hostile-colors';

// TAB-203: a stored colour reached `fill="…"`, `stroke="…"` and `style="color:…"` as it was. Whatever is stored, the
// markup for every object type that draws a colour carries only colours of the grammar in shared/colors.mjs.

const BOX_TYPES: ObjType[] = [
  'shape', 'sticky', 'text', 'frame', 'icon', 'path',
  'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-initial',
  'uml-final', 'uml-component',
];
const HEADS: Head[] = ['arrow', 'open', 'triangle', 'diamond', 'diamond-open', 'circle', 'bar', 'crow-many', 'crow-one'];

const poisoned = (type: ObjType, bad: unknown): BaseObj => ({
  id: 'o1', type, x: 10, y: 20, w: 160, h: 120, rotation: 0, z: 'a0', text: 'Label', name: 'Frame', kind: 'rect',
  fill: bad, stroke: bad, textColor: bad, strokeWidth: 2,
  points: [0, 0, 40, 40, 80, 10],
  body: '<path d="M0 0h24v24H0z" fill="currentColor"/>', viewBox: [0, 0, 24, 24],
  attributes: [{ visibility: '+', name: 'a', type: 'int' }], operations: [{ visibility: '+', name: 'f()', type: '' }],
} as unknown as BaseObj);

const ctx = (objs: Obj[] = []) => ({ get: (id: string) => objs.find((o) => o.id === id) });

describe('objectMarkup with hostile stored colours', () => {
  for (const type of BOX_TYPES) {
    it.each(HOSTILE_VALUES.map((v) => [v]))(`${type}: %j`, (bad) => {
      const out = objectMarkup(poisoned(type, bad), ctx());
      expect(out).not.toBe('');
      expect(markupProblems(out)).toEqual([]);
    });
  }

  it.each(HOSTILE_VALUES.map((v) => [v]))('hidden sticky: %j', (bad) => {
    const out = objectMarkup(poisoned('sticky', bad), { ...ctx(), isHidden: () => true });
    expect(markupProblems(out)).toEqual([]);
  });

  it.each(HOSTILE_VALUES.map((v) => [v]))('shape kinds with decorations: %j', (bad) => {
    for (const kind of ['cylinder', 'document', 'predefined', 'callout-rect'] as const) {
      expect(markupProblems(objectMarkup({ ...poisoned('shape', bad), kind }, ctx()))).toEqual([]);
    }
  });

  it.each(HOSTILE_VALUES.map((v) => [v]))('connector with every head and a label: %j', (bad) => {
    for (const head of HEADS) {
      const c = {
        id: 'c1', type: 'connector', z: 'a1', route: 'straight', startHead: head, endHead: head, label: 'go',
        from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 200, y: 50 }, stroke: bad, strokeWidth: 2,
      } as unknown as ConnectorObj;
      const out = objectMarkup(c, ctx());
      expect(out).toContain('<path');
      expect(markupProblems(out)).toEqual([]);
    }
  });

  it('the icon style attribute holds exactly one colour declaration', () => {
    const out = objectMarkup(poisoned('icon', 'red;filter:url(//evil.example/x)'), ctx());
    expect(out).toContain(`style="color:${CANVAS_INK}"`);
    const good = objectMarkup({ ...poisoned('icon', '#2f6fed') }, ctx());
    expect(good).toContain('style="color:#2F6FED"');
  });

  it('hostile numbers in attributes fall back to the defaults', () => {
    const o = { ...poisoned('shape', '#FFF'), strokeWidth: '2" onload="alert(1)', opacity: '0" onload="alert(1)', fontSize: '1" x="', fontWeight: {} } as unknown as BaseObj;
    expect(markupProblems(objectMarkup(o, ctx()))).toEqual([]);
    const s = styleOf(o);
    expect(s.strokeWidth).toBe(DEFAULTS.shape.strokeWidth);
    expect(s.fontSize).toBe(DEFAULTS.shape.fontSize);
  });

  it('good colours still draw as stored (canonical form)', () => {
    const o = { ...poisoned('shape', '#abc'), stroke: 'none', textColor: 'var(--canvas-ink, #18212b)' } as BaseObj;
    const s = styleOf(o);
    expect(s).toMatchObject({ fill: '#AABBCC', stroke: 'none', textColor: 'var(--canvas-ink, #18212B)' });
    expect(objectMarkup(o, ctx())).toContain('fill="#AABBCC"');
  });

  it('a poisoned colour falls back to the type default', () => {
    for (const type of ['shape', 'sticky', 'text', 'frame', 'path', 'icon'] as const) {
      const s = styleOf(poisoned(type, 'red;filter:url(//evil.example/x)'));
      const d = DEFAULTS[type];
      expect(s.fill).toBe(d.fill);
      expect(s.stroke).toBe(d.stroke);
    }
  });

  it('headMarkup checks the colour it is given', () => {
    for (const head of HEADS) {
      const { svg } = headMarkup(head, { x: 0, y: 0 }, { x: 1, y: 0 }, '#FFF" onload="alert(1)', 2);
      expect(markupProblems(svg)).toEqual([]);
    }
  });
});
