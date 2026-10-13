import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { generateNKeysBetween } from 'fractional-indexing';
import { chunkEntries, chunkObjects, cleanPlain, estimate, familyKeys, firstTableProblem, IMPORT_CHUNK, planChunks, sanitizeImportedObjects, sanitizeImportedState, tableProblem } from '../src/import-sanitize';
import type { Obj } from '../src/types';

const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'card', x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 'a', createdBy: 'src', ...extra }) as unknown as Obj;
const sticky = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 'a', ...extra }) as unknown as Obj;

describe('cleanPlain', () => {
  it('drops __proto__, constructor and prototype at any depth, including own keys made by JSON.parse', () => {
    const parsed = JSON.parse('{"a":1,"__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"keep":2,"deep":[{"prototype":1,"ok":3}]}}');
    expect(Object.keys(parsed)).toContain('__proto__');
    const out = cleanPlain(parsed) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['a', 'nested']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.nested).toEqual({ keep: 2, deep: [{ ok: 3 }] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps arrays their length, makes non-data undefined and cuts what is absurdly deep', () => {
    expect(cleanPlain([1, { a: 2 }, 'x'])).toEqual([1, { a: 2 }, 'x']);
    expect(cleanPlain({ f: () => 1, ok: 1 })).toEqual({ ok: 1 });
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { n: deep };
    expect(JSON.stringify(cleanPlain(deep)).length).toBeLessThan(400);
  });
});

describe('sanitizeImportedObjects', () => {
  it('makes the importer the author and clears owners who are not on the target board', () => {
    const [a, b, c, d] = sanitizeImportedObjects([
      card('a', { ownerId: 'stranger', ownerName: 'Sam', ownerKind: 'person' }),
      card('b', { ownerId: 'me', ownerName: 'Me', ownerKind: 'person' }),
      card('c', { ownerId: 'tok-1', ownerName: 'Claude', ownerKind: 'agent' }),
      card('d', { ownerId: 'colleague', ownerName: 'Col' }),
    ], 'me', (id) => id === 'colleague') as unknown as Record<string, unknown>[];
    expect(a).toMatchObject({ createdBy: 'me', ownerName: 'Sam', ownerKind: 'person' });
    expect(a.ownerId).toBeUndefined();
    expect(b).toMatchObject({ ownerId: 'me', ownerKind: 'person' });
    expect(c.ownerId).toBeUndefined();
    expect(c.ownerKind).toBeUndefined();
    expect(c.ownerName).toBe('Claude');
    expect(d.ownerId).toBe('colleague');
  });

  it('clears the stale owner id of any object type, e.g. a pasted sticky whose owner has left the board', () => {
    const [s] = sanitizeImportedObjects([sticky('s', { ownerId: 'departed', ownerName: 'Dee' })], 'me', () => false) as unknown as Record<string, unknown>[];
    expect(s.ownerId).toBeUndefined();
    expect(s.ownerName).toBe('Dee');
  });

  it('leaves the input alone and drops the tracker link of a card, a kanban and a tracker frame', () => {
    const src = card('t', { extProvider: 'tabula', extKey: 'ABC-1', tracker: { ticketId: 'x' }, ownerId: 'stranger' });
    const frame = { id: 'f', type: 'tracker', x: 0, y: 0, w: 480, h: 360, rotation: 0, z: 'a', trackerId: 'ws-1', viewId: 'v1', focusKey: 'ABC-1', view: 'inbox' } as unknown as Obj;
    const kanban = { id: 'k', type: 'container', layout: 'kanban', ext: { provider: 'tabula', tracker: 'ws-1', map: {} } } as unknown as Obj;
    const [out, f, k] = sanitizeImportedObjects([src, frame, kanban], 'me') as unknown as Record<string, unknown>[];
    expect((src as unknown as Record<string, unknown>).ownerId).toBe('stranger');
    expect(out.tracker).toBeUndefined();
    expect(out.extKey).toBeUndefined();
    expect(f.trackerId).toBeUndefined();
    expect(f.viewId).toBeUndefined();
    expect(f.focusKey).toBeUndefined();
    expect(f.view).toBe('inbox');
    expect(k.ext).toBeUndefined();
  });

  it('removes forbidden keys from every object, nested and in arrays, from a JSON file and from a clipboard', () => {
    const fromJson = JSON.parse('{"id":"x","type":"uml-class","x":1,"y":1,"w":1,"h":1,"rotation":0,"z":"a","__proto__":{"a":1},"attributes":[{"name":"n","constructor":{"b":1}}],"deep":{"prototype":{"c":1},"ok":true}}') as Obj;
    const [o] = sanitizeImportedObjects([fromJson], 'me') as unknown as Record<string, unknown>[];
    expect(JSON.stringify(o)).not.toMatch(/__proto__|constructor|prototype/);
    expect((o.attributes as { name: string }[])[0].name).toBe('n');
    expect((o.deep as Record<string, unknown>).ok).toBe(true);
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
  });

  it('drops proposedBy from a file and keeps its clean shape in a paste', () => {
    const src = sticky('p', { proposedBy: { feature: 'cluster', by: { id: 'src', name: 'Sam' }, extra: 'x' } });
    const [file] = sanitizeImportedObjects([src], 'me') as unknown as Record<string, unknown>[];
    expect(file.proposedBy).toBeUndefined();
    const [paste] = sanitizeImportedObjects([src], 'me', undefined, { proposedBy: 'keep' }) as unknown as Record<string, unknown>[];
    expect(paste.proposedBy).toEqual({ feature: 'cluster', by: { id: 'src', name: 'Sam' } });
    const [bad] = sanitizeImportedObjects([sticky('q', { proposedBy: { feature: 'evil' } })], 'me', undefined, { proposedBy: 'keep' }) as unknown as Record<string, unknown>[];
    expect(bad.proposedBy).toBeUndefined();
  });
});

describe('sanitizeImportedState', () => {
  it('keeps only the importer\'s own votes and poll answers and drops a foreign focus request', () => {
    const state = sanitizeImportedState({
      objects: [],
      flow: { active: 1, focus: { x: 1, y: 2, zoom: 1, ts: 1, by: 'src' } },
      votes: { 's:me:1': { itemId: 'i', userId: 'me', stepId: 's' }, 's:src:2': { itemId: 'i', userId: 'src', stepId: 's' } },
      polls: [{ id: 'p', question: 'q', options: [], multiple: false, anonymous: false, revealed: false, createdAt: 1, createdBy: 'src' }],
      pollAnswers: [{ pollId: 'p', userId: 'me', optionIds: [], updatedAt: 1 }, { pollId: 'p', userId: 'src', optionIds: [], updatedAt: 1 }],
    }, 'me');
    expect(Object.keys(state.votes!)).toEqual(['s:me:1']);
    expect(state.pollAnswers).toHaveLength(1);
    expect(state.polls![0].createdBy).toBe('me');
    expect(state.flow).toEqual({ active: 1 });
  });

  it('cleans forbidden keys out of the settings, session and labels too', () => {
    const state = sanitizeImportedState({
      objects: [],
      meta: JSON.parse('{"name":"n","__proto__":{"x":1}}'),
      flow: JSON.parse('{"steps":[{"id":"s","constructor":{"y":1}}]}'),
      labels: JSON.parse('{"l":{"id":"l","name":"x","prototype":1}}'),
    }, 'me');
    expect(JSON.stringify(state)).not.toMatch(/__proto__|constructor|prototype/);
  });
});

describe('chunks within the message budget', () => {
  const limits = { bytes: 400, values: 1000 };

  it('estimates bytes and values', () => {
    expect(estimate('abc')).toEqual({ bytes: 5, values: 1 });
    expect(estimate({ a: 1, b: ['x'] })).toMatchObject({ values: 4 });
  });

  it('keeps a parent with its descendants, a connector with both ends, and splits by estimated bytes', () => {
    const objs = [
      { id: 'g1', type: 'group' }, { id: 'a', parent: 'g1' }, { id: 'b', parent: 'g1' },
      { id: 'g2', type: 'group' }, { id: 'c', parent: 'g2' },
      { id: 'x' }, { id: 'y' },
      { id: 'link', type: 'connector', from: { kind: 'bound', id: 'x' }, to: { kind: 'bound', id: 'y' } },
    ];
    const keys = familyKeys(objs);
    expect(keys.get('link')).toBe(keys.get('x'));
    expect(keys.get('x')).toBe(keys.get('y'));
    expect(keys.get('a')).toBe(keys.get('g1'));
    expect(keys.get('a')).not.toBe(keys.get('c'));
    const chunks = chunkObjects(objs, { bytes: 100, values: 1000 });
    for (const family of [['g1', 'a', 'b'], ['g2', 'c'], ['x', 'y', 'link']]) {
      expect(chunks.filter((c) => c.items.some((o) => family.includes(o.id))).length === 1 || family.every((id) => chunks.find((c) => c.items.some((o) => o.id === id)) === chunks.find((c) => c.items.some((o) => o.id === family[0])))).toBe(true);
    }
    expect(chunks.flatMap((c) => c.items).map((o) => o.id).sort()).toEqual(objs.map((o) => o.id).sort());
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits by value count as well as bytes, and gives an oversized family a chunk of its own', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, v: [1, 2, 3, 4, 5] }));
    const byValues = planChunks(items, estimate, (o) => o.id, { bytes: 1e9, values: 17 });
    expect(Math.max(...byValues.map((c) => c.values))).toBeLessThanOrEqual(17);
    expect(byValues.length).toBe(5);
    const big = planChunks([{ id: 'big', v: 'x'.repeat(10_000) }, { id: 'small', v: 'y' }], estimate, (o) => o.id, limits);
    expect(big.map((c) => c.items.map((o) => o.id))).toEqual([['big'], ['small']]);
    expect(chunkEntries([['a', 1], ['b', 2]], limits)).toHaveLength(1);
  });

  it('never splits a cycle of parents or loses an object whose parent is missing', () => {
    expect(chunkObjects([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }, { id: 'z', parent: 'gone' }]).flatMap((c) => c.items)).toHaveLength(3);
  });
});

describe('the Y.Map prototype case', () => {
  it('a __proto__ key written through Yjs is cut by cleanPlain before it can reach a store', () => {
    const doc = new Y.Doc();
    const m = doc.getMap('objects');
    m.set('o', new Y.Map());
    (m.get('o') as Y.Map<unknown>).set('__proto__', { evil: 1 });
    (m.get('o') as Y.Map<unknown>).set('type', 'sticky');
    const json = (m.get('o') as Y.Map<unknown>).toJSON();
    expect(Object.getPrototypeOf(json)).not.toBe(Object.prototype);
    const clean = cleanPlain({ ...json });
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
  });
});

// tables (docs/tables.md): one object, a key per row, column, width, alignment, fill and cell; and Markdown blocks (docs/markdown-blocks.md)
describe('tables and Markdown blocks', () => {
  const ranks = (n: number) => generateNKeysBetween(null, null, n);
  /** A table with `rows` x `cols` cells of `text`, ids r<i> and c<j>. */
  function table(id: string, rows: number, cols: number, text = 'cell', extra: Record<string, unknown> = {}): Obj {
    const rr = ranks(rows), cc = ranks(cols);
    const o: Record<string, unknown> = { id, type: 'table', x: 0, y: 0, w: 400, h: 200, rotation: 0, z: 'a', createdBy: 'src', headerRow: true, ...extra };
    for (let r = 0; r < rows; r++) o[`r:r${r}`] = rr[r];
    for (let c = 0; c < cols; c++) o[`k:c${c}`] = cc[c];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) o[`c:r${r}:c${c}`] = text;
    return o as unknown as Obj;
  }
  const md = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'markdown', x: 0, y: 0, w: 300, h: 100, rotation: 0, z: 'a', text: '# Hi\n\n- [ ] one', createdBy: 'src', ...extra }) as unknown as Obj;
  const rec = (o: Obj) => o as unknown as Record<string, unknown>;

  it('maps the identity fields of a table and of a Markdown block like those of any object', () => {
    const [t, m] = sanitizeImportedObjects([
      table('t', 2, 2, 'x', { ownerId: 'stranger', ownerName: 'Sam', ownerKind: 'agent', proposedBy: { feature: 'generate', by: { id: 'stranger', name: 'Sam' } }, trackerId: 'w1', extKey: 'TAB-1' }),
      md('m', { ownerId: 'stranger', ownerName: 'Sam', proposedBy: { feature: 'summarise', by: { id: 'stranger', name: 'Sam' } }, tracker: { x: 1 } }),
    ], 'me').map(rec);
    for (const o of [t, m]) {
      expect(o.createdBy).toBe('me');
      for (const f of ['ownerId', 'ownerName', 'ownerKind', 'proposedBy', 'trackerId', 'extKey', 'tracker']) expect(o[f]).toBeUndefined();
    }
    expect(m.text).toBe('# Hi\n\n- [ ] one');
    // a paste keeps the one clean shape of proposedBy
    const [kept] = sanitizeImportedObjects([md('m', { proposedBy: { feature: 'summarise', by: { id: 'x', name: 'Ana' }, evil: 1 } })], 'me', undefined, { proposedBy: 'keep' }).map(rec);
    expect(kept.proposedBy).toEqual({ feature: 'summarise', by: { id: 'x', name: 'Ana' } });
  });

  it('keeps every well-formed part of a table as it is', () => {
    const src = table('t', 3, 3, 'text', { 'w:c0': 200, 'a:c1': 'right', 'f:r0:c0': '#FFE16B' });
    const [out] = sanitizeImportedObjects([src], 'me');
    const { createdBy: _a, ...a } = rec(out);
    const { createdBy: _b, ...b } = rec(src);
    expect(a).toEqual(b);
  });

  it('drops forbidden keys at any depth and malformed part keys, including the ones that carry a forbidden word', () => {
    const src = JSON.parse(JSON.stringify(table('t', 1, 1)));
    Object.assign(src, JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"c:__proto__:c0":"a","c:r0:constructor":"b","c:r0:prototype":"c","f:r0:c0":"red\\"><script>","w:c0":"wide","a:c0":"diagonal","r:r9":"not a rank","c:r0:c0":"ok","c:gone:c0":"orphan","k:thisidiswaytoolong":"a0"}'));
    const [out] = sanitizeImportedObjects([src], 'me').map(rec);
    expect(Object.keys(out).filter((k) => /^[rkwacf]:/.test(k)).sort()).toEqual(['c:r0:c0', 'k:c0', 'r:r0']);
    expect(Object.keys(out)).not.toContain('__proto__');
    expect(Object.keys(out)).not.toContain('constructor');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out['c:r0:c0']).toBe('ok');
  });

  it('keeps a width within bounds and a cell within its length', () => {
    const [out] = sanitizeImportedObjects([table('t', 1, 1, 'x'.repeat(5000), { 'w:c0': 99999 })], 'me').map(rec);
    expect(out['w:c0']).toBe(800);
    expect([...(out['c:r0:c0'] as string)]).toHaveLength(1000);
  });

  it('counts every part of a table, and the bytes of the text in UTF-8, in its estimate', () => {
    const e = estimate(table('t', 100, 30, 'x'));
    expect(e.values).toBeGreaterThan(3000 + 130); // a value per cell, row and column, not one per object
    expect(estimate({ a: 'é' }).bytes).toBe(estimate({ a: 'e' }).bytes + 1);
    expect(estimate({ a: '日' }).bytes).toBe(estimate({ a: 'e' }).bytes + 2);
    expect(estimate({ a: '😀' }).bytes).toBe(estimate({ a: 'e' }).bytes + 3);
  });

  it('chunks 3,000-cell tables by their parts: a message holds as many as its value budget allows, in order, and none is split', () => {
    const tables = Array.from({ length: 9 }, (_, i) => table(`t${i}`, 100, 30));
    const per = estimate(tables[0]).values;
    expect(per).toBeGreaterThan(3100);
    const chunks = chunkObjects(tables);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.items.map((o) => o.id))).toEqual(tables.map((o) => o.id));
    for (const c of chunks) expect(c.values).toBeLessThanOrEqual(25_000);
    expect(Math.floor(25_000 / per)).toBe(chunks[0].items.length);
    // by bytes alone: cells of 1,000 characters
    const heavy = Array.from({ length: 10 }, (_, i) => table(`h${i}`, 20, 7, 'y'.repeat(1000)));
    const byBytes = chunkObjects(heavy);
    expect(byBytes.length).toBeGreaterThan(1);
    for (const c of byBytes) expect(c.bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('a table the editor allows is always one message and one object within the relay\'s caps', () => {
    // the largest table: 100 rows, 30 columns, 3,000 cells at the 150,000-character limit, a fill on every cell, widths, alignments
    const t = rec(table('t', 100, 30, 'z'.repeat(50)));
    for (let c = 0; c < 30; c++) { t[`w:c${c}`] = 100; t[`a:c${c}`] = 'center'; }
    for (let r = 0; r < 100; r++) for (let c = 0; c < 30; c++) t[`f:r${r}:c${c}`] = '#FFE16B';
    const e = estimate(t);
    expect(tableProblem(t as never)).toBeNull();
    expect(e.values).toBeLessThan(IMPORT_CHUNK.values);
    expect(e.bytes).toBeLessThan(IMPORT_CHUNK.bytes);
    expect(chunkObjects([t as unknown as Obj])).toHaveLength(1);
  });

  it('refuses a table past the limits of the editor, with a sentence that says which', () => {
    expect(tableProblem(rec(table('t', 101, 2)))).toMatch(/101 rows \(up to 100\)/);
    expect(tableProblem(rec(table('t', 2, 31)))).toMatch(/31 columns \(up to 30\)/);
    expect(tableProblem(rec(table('t', 20, 10, 'q'.repeat(800))))).toMatch(/150,000 characters/);
    expect(tableProblem(rec(table('t', 10, 10)))).toBeNull();
    expect(tableProblem(rec(md('m')))).toBeNull();
    expect(firstTableProblem([md('m'), table('t', 101, 1)])).toMatch(/rows/);
  });
});
