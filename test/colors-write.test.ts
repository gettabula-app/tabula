import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { isSafeColor } from '../shared/colors';
import { OpsError, applyPlan, planCreate, planUpdate } from '../server/board-ops.mjs';
import { validateTemplateContent } from '../server/templates.mjs';
import { validateContent } from '../src/custom-templates';
import { applyImported, readBoardFile, type BoardJson } from '../src/exporters';
import { objectMarkup } from '../src/markup';
import { customStickyColors } from '../src/palette';
import { COLOR_FIELDS, Store } from '../src/store';
import { Comments } from '../src/comments';
import type { BaseObj, Obj } from '../src/types';
import { HOSTILE_STRINGS, HOSTILE_VALUES, markupProblems } from './hostile-colors';

// TAB-203, the write side: every path that stores a colour checks it against shared/colors.mjs. Tools and templates
// refuse a bad colour with their usual error; the board's own store and the file import leave it out (the type default
// applies) or keep what was there, so a bad value never reaches Yjs from this device.

const cases = HOSTILE_VALUES.map((v) => [v] as [unknown]);
const who = { createdBy: 'user-1', now: 1000 };

function opsError(fn: () => unknown): OpsError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OpsError) return e;
    throw e;
  }
  throw new Error('expected an OpsError');
}

const colourValues = (d: Y.Doc): unknown[] => {
  const out: unknown[] = [];
  d.getMap<Y.Map<unknown>>('objects').forEach((m) => {
    for (const k of COLOR_FIELDS) if (m.has(k)) out.push(m.get(k));
  });
  return out;
};

describe('board-ops (MCP and the AI apply path)', () => {
  it.each(cases)('create refuses %j in every colour field', (bad) => {
    const items = [
      { type: 'sticky', text: 'a', x: 0, y: 0, color: bad },
      { type: 'shape', x: 0, y: 0, fill: bad },
      { type: 'shape', x: 0, y: 0, stroke: bad },
      { type: 'frame', name: 'f', x: 0, y: 0, fill: bad },
      { type: 'connector', from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, stroke: bad },
    ];
    for (const item of items) {
      const d = new Y.Doc();
      const err = opsError(() => planCreate(d, [item], who));
      expect(err.message).toMatch(/colou?r/i);
      expect(d.getMap('objects').size).toBe(0);
    }
  });

  it.each(cases)('update refuses %j and leaves the board as it was', (bad) => {
    if (bad === null) return; // null clears an optional field in an update (CLEARABLE), by design
    const d = new Y.Doc();
    const plan = planCreate(d, [
      { type: 'sticky', ref: 's', text: 'a', x: 0, y: 0 },
      { type: 'shape', ref: 'h', x: 300, y: 0 },
      { type: 'text', ref: 't', text: 'x', x: 600, y: 0 },
    ], who);
    d.transact(() => applyPlan(d, plan));
    const { s, h, t } = (plan.result as { refs: Record<string, string> }).refs;
    const before = JSON.stringify(d.getMap('objects').toJSON());
    for (const [id, field] of [[s, 'color'], [h, 'fill'], [h, 'stroke'], [t, 'textColor']] as const) {
      opsError(() => planUpdate(d, [{ id, [field]: bad }]));
    }
    expect(JSON.stringify(d.getMap('objects').toJSON())).toBe(before);
  });

  it('stores what it accepts in canonical form, through the shared grammar', () => {
    const d = new Y.Doc();
    const plan = planCreate(d, [{ type: 'shape', x: 0, y: 0, fill: '#abcdef', stroke: 'none' }], who);
    d.transact(() => applyPlan(d, plan));
    expect(colourValues(d)).toEqual(expect.arrayContaining(['#ABCDEF', 'none']));
    for (const v of colourValues(d)) expect(isSafeColor(v)).toBe(true);
  });
});

describe('templates', () => {
  const sticky = (extra: Record<string, unknown>) => ({ id: 's1', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: '1', text: 'a', ...extra });
  const content = (objects: unknown[]) => ({ objects, steps: [], bounds: { x: 0, y: 0, w: 400, h: 300 } });

  it.each(cases)('the server refuses %j in fill, stroke and textColor', (bad) => {
    for (const key of ['fill', 'stroke', 'textColor']) {
      expect(() => validateTemplateContent(content([sticky({ [key]: bad })]))).toThrow(/not a colour the board can draw/);
    }
  });

  it('a kanban container fill may be a palette key, on the server and in a template file', () => {
    const c = { id: 'k1', type: 'container', x: 0, y: 0, w: 600, h: 400, rotation: 0, z: '1', layout: 'kanban', fill: 'Yellow' };
    expect(JSON.stringify(validateTemplateContent(content([c])))).toContain('"fill":"yellow"');
    expect(() => validateContent(content([c]))).not.toThrow();
    for (const bad of ['purple', 'url(//evil.example)']) {
      expect(() => validateTemplateContent(content([{ ...c, fill: bad }]))).toThrow(/not a colour the board can draw/);
      expect(() => validateContent(content([{ ...c, fill: bad }]))).toThrow(/not a colour the board can draw/);
    }
  });

  it('the server stores a colour it accepts in canonical form', () => {
    const out = validateTemplateContent(content([sticky({ fill: '#ffe16b', textColor: 'var(--canvas-ink, #18212b)' })]));
    expect(JSON.stringify(out)).toContain('"#FFE16B"');
    expect(JSON.stringify(out)).toContain('"var(--canvas-ink, #18212B)"');
  });

  it.each(cases)('a template file (client) is refused with %j in a colour field', (bad) => {
    if (bad === null) return; // null is "not set" in a template file, as for every other optional field
    for (const key of ['fill', 'stroke', 'textColor']) {
      expect(() => validateContent(content([sticky({ [key]: bad })]))).toThrow(/not a colour the board can draw/);
    }
  });
});

describe('the board store (property panel, paste, templates, AI apply, import)', () => {
  const sticky = (extra: Record<string, unknown> = {}): BaseObj => ({ id: 's1', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: 'a0', ...extra } as BaseObj);

  it.each(cases)('create leaves out %j, so the type default applies', (bad) => {
    const store = new Store(new Y.Doc());
    store.create(sticky({ fill: bad, stroke: bad, textColor: bad } as Partial<BaseObj>));
    const m = store.objects.get('s1')!;
    for (const k of COLOR_FIELDS) expect(m.has(k)).toBe(false);
    expect(m.get('w')).toBe(160);
  });

  it.each(cases)('update ignores %j and keeps the colour the object has', (bad) => {
    const store = new Store(new Y.Doc());
    store.create(sticky({ fill: '#A3D2FF' }));
    store.update('s1', { fill: bad, text: 'still written' } as Record<string, unknown>);
    const m = store.objects.get('s1')!;
    expect(m.get('fill')).toBe('#A3D2FF');
    expect(m.get('text')).toBe('still written');
  });

  it('stores good colours canonically, and undefined still clears', () => {
    const store = new Store(new Y.Doc());
    store.create(sticky({ fill: '#a3d2ff', stroke: 'NONE' }));
    expect(store.objects.get('s1')!.get('fill')).toBe('#A3D2FF');
    expect(store.objects.get('s1')!.get('stroke')).toBe('none');
    store.update('s1', { fill: undefined });
    expect(store.objects.get('s1')!.has('fill')).toBe(false);
  });

  it('leaves a kanban lane or card fill to the kanban, which may hold a palette key', () => {
    const store = new Store(new Y.Doc());
    store.create({ id: 'l1', type: 'lane', x: 0, y: 0, w: 200, h: 400, rotation: 0, z: 'a0', fill: 'yellow' } as BaseObj);
    store.update('l1', { fill: 'Blue' });
    expect(store.objects.get('l1')!.get('fill')).toBe('Blue');
  });

  it('keeps only plain hex custom sticky colours on the board', () => {
    const store = new Store(new Y.Doc());
    store.setMeta({ stickyColors: ['#abcdef', ...HOSTILE_STRINGS, 'none', 'var(--x, #FFFFFF)', '#ABCDEF', 7 as unknown as string] });
    expect(store.getMeta().stickyColors).toEqual(['#ABCDEF']);
    expect(customStickyColors(['url(//evil)', '#123456'])).toEqual(['#123456']);
    expect(customStickyColors('#123456')).toEqual([]);
  });
});

describe('importing a board file (.json; a .drift without doc.yjs takes the same path)', () => {
  const poisoned = (bad: unknown): BoardJson => ({
    format: 'driftboard', schemaVersion: 1, exportedAt: '', flow: { steps: [], active: -1, timer: null, reveal: false, focus: null, stepStartedAt: 0, results: null },
    meta: { name: 'x', stickyColors: [bad, '#123456'] } as unknown as BoardJson['meta'],
    objects: [
      { id: 'a', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: 'a0', text: 'hi', fill: bad, textColor: bad },
      { id: 'b', type: 'shape', kind: 'rect', x: 200, y: 0, w: 100, h: 80, rotation: 0, z: 'a1', fill: bad, stroke: bad, textColor: bad },
      { id: 'c', type: 'connector', z: 'a2', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'b', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow', stroke: bad },
      { id: 'd', type: 'icon', x: 0, y: 300, w: 48, h: 48, rotation: 0, z: 'a3', body: '<path d="M0 0h24v24H0z"/>', textColor: bad },
    ] as unknown as Obj[],
  });

  it.each(cases)('normalises %j on the way in, and draws clean markup', async (bad) => {
    const file = new File([JSON.stringify(poisoned(bad))], 'evil.json');
    const imported = await readBoardFile(file);
    const doc = new Y.Doc();
    const store = new Store(doc);
    applyImported({ doc, store, comments: new Comments(new Y.Doc()) }, imported, 'me');
    for (const v of colourValues(doc)) expect(isSafeColor(v)).toBe(true);
    expect(store.getMeta().stickyColors).toEqual(['#123456']);
    const ctx = { get: (id: string) => store.getPlaced(id) };
    for (const o of store.ordered()) expect(markupProblems(objectMarkup(store.placed(o), ctx))).toEqual([]);
  });
});
