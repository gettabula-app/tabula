import * as Y from 'yjs';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateNKeysBetween } from 'fractional-indexing';
import {
  ENFORCE_TEXT_CAPS, EXTRA_TYPES, FIELDS, LIMITS, OBJ_TYPES, UNFURL_ERRORS, SHAPE_KINDS as V_SHAPE_KINDS, HEADS as V_HEADS, ROUTES as V_ROUTES, DASHES as V_DASHES, SIDES as V_SIDES,
  RELATIONS as V_RELATIONS, TOLERATED_UNKNOWN, countCodes, scanStructure, shouldReject, syncValidateMode, validateBoardObject,
  validateChangedKeys, validateCommentThread,
} from '../server/sync-validate.mjs';
import {
  OBJ_TYPES as OPS_TYPES, SHAPE_KINDS as OPS_SHAPE_KINDS, HEADS as OPS_HEADS, ROUTES as OPS_ROUTES, DASHES as OPS_DASHES, SIDES as OPS_SIDES,
} from '../server/board-ops.mjs';
import { TEMPLATE_RELATIONS } from '../server/templates.mjs';
import { SHAPE_KINDS as APP_SHAPE_KINDS, HEADS as APP_HEADS } from '../src/shapes';
import { OBJ_ENUMS } from '../src/safe-obj';
import { RELATIONS as APP_RELATIONS } from '../src/uml';
import { allFixtures, clientObjects, type Change } from './sync-validate-fixtures';

type Ctx = { writer?: { id: string; name?: string; color?: string; role?: string } | null; [key: string]: unknown };
type Violation = { code: string; path: string };
const codes = (r: { ok: boolean; violations?: Violation[] }) => (r.ok ? [] : r.violations!.map((v) => v.code));
const paths = (r: { ok: boolean; violations?: Violation[] }) => (r.ok ? [] : r.violations!.map((v) => `${v.code}:${v.path}`));

const ctx: Ctx = {
  writer: { id: 'u1', name: 'Lea Brandt', color: '#3366FF' },
  isBoardMember: (id: string) => ['u1', 'u2'].includes(id),
  canEditObject: () => true,
};
const sticky = (extra: Record<string, unknown> = {}) => ({
  id: 's1', type: 'sticky', x: 10, y: 20, w: 192, h: 192, rotation: 0, z: 'a0', text: 'hi', fill: '#FFE16B', createdBy: 'u1', updatedAt: 1_700_000_000_000, ...extra,
});
const card = (extra: Record<string, unknown> = {}) => ({
  id: 'c1', type: 'card', parent: 'l1', rank: 'a0@l1', text: 'Title', x: 0, y: 0, w: 200, h: 80, rotation: 0, z: 'a0', createdBy: 'u1', ...extra,
});
const check = (value: unknown, c: Ctx = ctx, opts = {}) => validateBoardObject((value as { id: string }).id, value, c, opts);

describe('mode (TABULA_SYNC_VALIDATE)', () => {
  it('defaults to off and reads the three modes', () => {
    expect(syncValidateMode({})).toBe('report');
    expect(syncValidateMode({ TABULA_SYNC_VALIDATE: '' })).toBe('report');
    expect(syncValidateMode({ TABULA_SYNC_VALIDATE: '  ' })).toBe('report');
    for (const mode of ['off', 'report', 'enforce']) expect(syncValidateMode({ TABULA_SYNC_VALIDATE: mode })).toBe(mode);
    expect(syncValidateMode({ TABULA_SYNC_VALIDATE: ' Enforce ' })).toBe('enforce');
  });

  it('throws a clear message for anything else, so a typo cannot turn the check off', () => {
    expect(() => syncValidateMode({ TABULA_SYNC_VALIDATE: 'on' })).toThrow(/TABULA_SYNC_VALIDATE must be one of off, report, enforce/);
    expect(() => syncValidateMode({ TABULA_SYNC_VALIDATE: 'true' })).toThrow(/got "true"/);
  });

  it('rejects only in enforce mode', () => {
    const bad = { ok: false, violations: [{ code: 'x', path: '' }] };
    expect(shouldReject('enforce', bad)).toBe(true);
    expect(shouldReject('report', bad)).toBe(false);
    expect(shouldReject('off', bad)).toBe(false);
    expect(shouldReject('enforce', { ok: true })).toBe(false);
  });
});

describe('the module is pure and its tables match the app', () => {
  it('imports no Yjs, no node: module and no clock or randomness', () => {
    const source = fs.readFileSync(new URL('../server/sync-validate.mjs', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../shared/colors.mjs', '../shared/containers.mjs', '../shared/svg-safety.mjs', '../shared/tables.mjs', '../shared/text-limits.mjs']);
    expect(source).not.toMatch(/Date\.now|Math\.random|process\.(?!env)|require\(/);
  });

  it('keeps the copied enumerations equal to board-ops.mjs, the app and the templates', () => {
    expect([...OBJ_TYPES]).toEqual(OPS_TYPES);
    expect([...V_SHAPE_KINDS]).toEqual(OPS_SHAPE_KINDS);
    expect([...V_HEADS]).toEqual(OPS_HEADS);
    expect([...V_ROUTES]).toEqual(OPS_ROUTES);
    expect([...V_DASHES]).toEqual(OPS_DASHES);
    expect([...V_SIDES]).toEqual(OPS_SIDES);
    expect([...V_SHAPE_KINDS].sort()).toEqual(APP_SHAPE_KINDS.map((k) => k.kind).sort());
    expect([...V_HEADS].sort()).toEqual(APP_HEADS.map((h) => h.head).sort());
    expect([...V_RELATIONS].sort()).toEqual(Object.keys(APP_RELATIONS).sort());
    expect([...V_RELATIONS].sort()).toEqual([...TEMPLATE_RELATIONS].sort());
    const sameAsClient = { kind: V_SHAPE_KINDS, route: V_ROUTES, startHead: V_HEADS, endHead: V_HEADS, dash: V_DASHES, relation: V_RELATIONS };
    for (const [field, expected] of Object.entries(sameAsClient)) expect({ field, values: [...OBJ_ENUMS[field]].sort() }).toEqual({ field, values: [...expected].sort() });
  });

  it('has a field table for every object type', () => {
    expect(Object.keys(FIELDS).sort()).toEqual([...OBJ_TYPES, ...EXTRA_TYPES].sort());
  });
});

describe('what the client writes passes', () => {
  const objects = clientObjects();

  it('has built one object of every type, every shape kind, relation and UML element', () => {
    const types = new Set([...objects.store.objects.values()].map((m) => m.get('type')));
    expect([...types].sort()).toEqual([...OBJ_TYPES, ...EXTRA_TYPES].sort());
    for (const kind of V_SHAPE_KINDS) expect(objects.byLabel.has(`shape:${kind}`)).toBe(true);
    for (const relation of V_RELATIONS) expect(objects.byLabel.has(`connector:${relation}`)).toBe(true);
  });

  it('accepts every fixture: the client, the demo board and every built-in template', () => {
    const known = new Set(['demo:seed', 'scenario:undo-restore (default policy)']);
    for (const fixture of allFixtures().filter((f) => !known.has(f.name))) {
      const result = validateChangedKeys(fixture.changes, { ...ctx, writer: fixture.writer, isBoardMember: () => true, ...fixture.ctx });
      expect({ fixture: fixture.name, found: paths(result as never).slice(0, 5) }).toEqual({ fixture: fixture.name, found: [] });
    }
  });

  it('flags the object an undo brings back with somebody else\'s createdBy, unless the member policy is on', () => {
    const [plain, member] = allFixtures().filter((f) => f.name.startsWith('scenario:undo-restore'));
    expect(paths(validateChangedKeys(plain.changes, ctx) as never)).toEqual(['forged_author:createdBy']);
    expect(validateChangedKeys(member.changes, { ...ctx, ...member.ctx })).toEqual({ ok: true });
  });

  it('checks authorship of the demo comments against the writer', () => {
    const demo = allFixtures().find((f) => f.name === 'demo:seed')!;
    const threads = demo.changes.filter((c) => c.kind === 'thread');
    expect(threads.length).toBeGreaterThan(0);
    const result = validateChangedKeys(threads, { ...ctx, writer: demo.writer });
    expect(new Set(codes(result as never))).toEqual(new Set(['forged_author']));
  });

  it('accepts a card owned by another board member', () => {
    const owned = objects.byLabel.get('card')!;
    expect(owned).toMatchObject({ ownerId: 'u2' });
    expect(check({ ...owned }, ctx, { isNew: true })).toEqual({ ok: true });
  });

  it('accepts a card with a free-text owner and a sticky turned into a card in place', () => {
    expect(check({ ...objects.byLabel.get('card:free-owner')! }, ctx, { isNew: true })).toEqual({ ok: true });
    const converted = { ...objects.byLabel.get('card:converted')! };
    expect(converted.type).toBe('card');
    expect(check(converted, ctx, { fields: ['type', 'text', 'desc', 'fill', 'parent', 'rank'] })).toEqual({ ok: true });
  });
});

describe('report-only text caps and link cards', () => {
  it('marks a text-length cap reportOnly while ENFORCE_TEXT_CAPS is off, and keeps structural limits hard', () => {
    expect(ENFORCE_TEXT_CAPS).toBe(false);
    const long = validateChangedKeys([{ kind: 'object', key: 's1', value: sticky({ text: 'x'.repeat(LIMITS.text + 1) }) }], ctx);
    expect(long).toMatchObject({ ok: false, violations: [{ code: 'too_long', reportOnly: true }] });
    expect(shouldReject('enforce', long)).toBe(false);
    const bad = validateChangedKeys([{ kind: 'object', key: 's1', value: sticky({ x: 'a', text: 'x'.repeat(LIMITS.text + 1) }) }], ctx);
    expect(shouldReject('enforce', bad)).toBe(true);
    expect(shouldReject('enforce', validateChangedKeys([{ kind: 'object', key: 's1', value: sticky({ text: 'x'.repeat(2_000_000) }) }], ctx))).toBe(true);
  });

  it('accepts a link card as docs/link-cards.md describes it and rejects a bad one', () => {
    const link = (extra = {}) => ({
      id: 'k1', type: 'link', x: 0, y: 0, w: 320, h: 112, rotation: 0, z: 'a0', createdBy: 'u1', url: 'https://example.com/a?b=c#d', unfurl: 'ok',
      title: 'T', description: 'D', siteName: 'example.com', image: 'f'.repeat(64), imageW: 1200, imageH: 630, icon: 'e'.repeat(64),
      finalUrl: 'https://www.example.com/a', fetchedAt: 1_700_000_000_000, edited: ['title'], ...extra,
    });
    expect(check(link(), ctx, { isNew: true })).toEqual({ ok: true });
    for (const error of UNFURL_ERRORS) expect(check(link({ unfurl: 'failed', unfurlError: error }))).toEqual({ ok: true });
    expect(check(link({ unfurl: 'pending', title: undefined, image: undefined }))).toEqual({ ok: true });
    expect(paths(check(link({ unfurlError: 'oops' })))).toEqual(['bad_value:unfurlError']);
    expect(paths(check(link({ url: 'javascript:alert(1)' })))).toEqual(['bad_value:url']);
    expect(paths(check(link({ image: '../etc/passwd' })))).toEqual(['bad_value:image']);
    expect(paths(check(link({ unfurl: 'done' })))).toEqual(['bad_value:unfurl']);
    expect(paths(check(link({ edited: ['title', 'url'] })))).toEqual(['bad_value:edited']);
    expect(paths(check(link({ hack: 1 })))).toEqual(['unknown_field:hack']);
    expect(codes(check({ id: 'k2', type: 'link2' }))).toEqual(['unknown_type']);
  });
});

describe('tables', () => {
  const table = (extra: Record<string, unknown> = {}) => ({
    id: 'tb1', type: 'table', x: 0, y: 0, w: 320, h: 80, rotation: 0, z: 'a0', createdBy: 'u1', headerRow: true,
    'r:r1': 'a0', 'r:r2': 'a1', 'k:c1': 'a0', 'k:c2': 'a1', 'w:c1': 200, 'c:r1:c1': 'Name', 'c:r2:c2': '**bold**', ...extra,
  });
  it('accepts the keys of a table (rows, columns, a width, cells) and the header flags', () => {
    expect(check(table(), ctx, { isNew: true })).toEqual({ ok: true });
    expect(check(table({ headerCol: false, 'c:r1:c2': '' }))).toEqual({ ok: true });
  });
  it('rejects a cell that is too long or not text, a width out of range, an empty rank, and keys that are not table parts', () => {
    expect(paths(check(table({ 'c:r1:c2': 'x'.repeat(1001) })))).toEqual(['too_long:c:r1:c2']);
    expect(paths(check(table({ 'c:r1:c2': 5 })))).toEqual(['bad_type:c:r1:c2']);
    expect(paths(check(table({ 'w:c1': 5 })))).toEqual(['out_of_range:w:c1']);
    expect(paths(check(table({ 'r:r3': '' })))).toEqual(['bad_value:r:r3']);
    expect(paths(check(table({ 'c:R1:c2': 'x' })))).toEqual(['unknown_field:c:R1:c2']);
    expect(paths(check(table({ 'q:r1': 'x' })))).toEqual(['unknown_field:q:r1']);
    expect(paths(check(table({ headerRow: 'yes' })))).toEqual(['bad_type:headerRow']);
  });
  it('accepts a column alignment and a cell fill, and rejects a value the board cannot use', () => {
    expect(check(table({ 'a:c1': 'right', 'f:r1:c1': '#FFE16B' }))).toEqual({ ok: true });
    expect(paths(check(table({ 'a:c1': 'justify' })))).toEqual(['bad_value:a:c1']);
    expect(paths(check(table({ 'f:r1:c1': 'url(javascript:alert(1))' })))).toEqual(['bad_value:f:r1:c1']);
    expect(paths(check(table({ 'f:r1:c1': 5 })))).toEqual(['bad_type:f:r1:c1']);
  });
  it('rejects a rank fractional indexing cannot use, and a table whose cells hold more than 150,000 characters', () => {
    expect(paths(check(table({ 'r:r3': 'a' })))).toEqual(['bad_value:r:r3']);
    expect(paths(check(table({ 'k:c3': '!!' })))).toEqual(['bad_value:k:c3']);
    expect(check(table({ 'r:r3': 'a2', 'k:c3': 'Zz' }))).toEqual({ ok: true });
    // (cells count when their row and column exist; a cell outside the grid is dropped by the client and does not count)
    const heavy = (n: number) => ({
      ...Object.fromEntries(generateNKeysBetween('a1', null, n).map((rank, i) => [`k:x${i}`, rank])),
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`c:r1:x${i}`, 'q'.repeat(1000)])),
    });
    expect(codes(check(table(heavy(151))))).toContain('table_too_big');
    expect(codes(check(table(heavy(149))))).not.toContain('table_too_big');
    expect(codes(check(table(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`c:r1:ghost${i}`, 'q'.repeat(1000)])))))).not.toContain('table_too_big');
  });
  it('accepts only base62 characters in a rank, and reports (never refuses) two equal ranks', () => {
    for (const bad of ['a\0', 'a b', 'a:b', 'a\u202e', 'a\uffff']) expect(paths(check(table({ 'r:r3': bad })))).toEqual(['bad_value:r:r3']);
    const twins = check(table({ 'r:r3': 'a0' }));
    expect(codes(twins)).toEqual(['duplicate_rank']);
    expect(twins).toMatchObject({ ok: false, violations: [{ code: 'duplicate_rank', reportOnly: true }] });
    expect(shouldReject('enforce', twins)).toBe(false);
  });
  it('limits a table to 100 rows and 30 columns however the writes arrive, and only another type is refused its keys', () => {
    const many = (kind: string, n: number) => Object.fromEntries(generateNKeysBetween(null, null, n).map((rank, i) => [`${kind}:i${i}`, rank]));
    expect(codes(check(table({ ...many('r', 101) })))).toContain('too_many_rows');
    expect(codes(check(table({ ...many('k', 31) })))).toContain('too_many_columns');
    expect(codes(check(table({ ...many('r', 98), ...many('k', 28) })))).not.toContain('too_many_rows');
    expect(codes(check(table({ ...many('r', 98), ...many('k', 28) })))).not.toContain('too_many_columns');
    expect(paths(check({ id: 'x1', type: 'sticky', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a0', createdBy: 'u1', 'c:r1:c1': 'x' }))).toEqual(['unknown_field:c:r1:c1']);
  });
});

describe('a Markdown block', () => {
  const md = (text: string) => ({ id: 'md1', type: 'markdown', x: 0, y: 0, w: 300, h: 200, rotation: 0, z: 'a0', createdBy: 'u1', text });
  it('has a text cap of 8,000 characters (a note allows 20,000): over it is a too_long violation, report-only while the text caps are', () => {
    expect(LIMITS.markdown).toBe(8000);
    expect(check(md('x'.repeat(8000)))).toEqual({ ok: true });
    expect(paths(check(md('x'.repeat(8001))))).toEqual(['too_long:text']);
    expect(check(md('x'.repeat(8001)))).toMatchObject({ violations: [{ code: 'too_long', reportOnly: true }] });
  });
});

describe('rejections', () => {
  it('rejects an unknown or missing type and a mismatched id', () => {
    expect(codes(check(sticky({ type: 'rocket' })))).toEqual(['unknown_type']);
    expect(codes(check(sticky({ type: undefined })))).toEqual(['bad_type']);
    expect(codes(check(sticky({ type: 7 })))).toEqual(['bad_type']);
    expect(codes(validateBoardObject('s1', sticky({ id: 'other' }), ctx))).toEqual(['id_mismatch']);
    expect(codes(validateBoardObject('bad id!', sticky(), ctx))).toEqual(['bad_value']);
    expect(codes(validateBoardObject('s1', 'text', ctx))).toEqual(['bad_type']);
    expect(codes(validateBoardObject('s1', [1], ctx))).toEqual(['bad_type']);
  });

  it('rejects wrongly typed fields', () => {
    for (const bad of [{ x: '10' }, { w: null }, { text: 5 }, { locked: 'yes' }, { z: 3 }, { parent: ['a'] }, { fontSize: '16' }]) {
      expect({ fields: Object.keys(bad), ok: check(sticky(bad)).ok }).toEqual({ fields: Object.keys(bad), ok: false });
    }
    expect(paths(check(sticky({ x: '10' })))).toEqual(['bad_type:x']);
  });

  it('rejects strings over their caps, and counts card titles in code points', () => {
    expect(paths(check(sticky({ text: 'x'.repeat(LIMITS.text + 1) })))).toEqual(['too_long:text']);
    expect(check(sticky({ text: 'x'.repeat(LIMITS.text) }))).toEqual({ ok: true });
    expect(paths(check(card({ text: 'y'.repeat(LIMITS.cardTitle + 1) })))).toEqual(['too_long:text']);
    // 200 astral characters are 400 UTF-16 units but 200 code points: the title is within its cap
    expect(check(card({ text: '😀'.repeat(LIMITS.cardTitle) }))).toEqual({ ok: true });
    expect(paths(check(card({ desc: 'd'.repeat(LIMITS.desc + 1) })))).toEqual(['too_long:desc']);
    // names come from textareas: a frame, lane or container name may hold a line break
    expect(check({ id: 'f', type: 'frame', name: 'a\nb' })).toEqual({ ok: true });
    expect(paths(check(card({ ownerName: 'a\nb' })))).toEqual(['bad_chars:ownerName']);
    expect(paths(check(sticky({ font: 'x'.repeat(65) })))).toEqual(['too_long:font']);
    expect(paths(check(sticky({ font: 'Bad Font;x' })))).toEqual(['bad_value:font']);
  });

  it('rejects a huge string anywhere and a huge object', () => {
    expect(codes(check(sticky({ text: 'x'.repeat(2_000_000) })))).toContain('too_big');
    const big = Array.from({ length: 5000 }, (_, i) => ({ visibility: '+', name: `member${i}`.padEnd(100, 'x'), type: 't' }));
    expect(codes(check({ id: 'u', type: 'uml-class', attributes: big }))).toContain('too_big');
    expect(codes(check({ id: 'p', type: 'path', points: Array.from({ length: 80_000 }, (_, i) => i * 1.2345678) }))).toContain('too_big');
  });

  it('rejects NaN, Infinity and out-of-range numbers', () => {
    expect(paths(check(sticky({ x: Number.NaN })))).toEqual(['not_finite:x']);
    expect(paths(check(sticky({ w: Infinity })))).toEqual(['not_finite:w']);
    expect(paths(check(sticky({ opacity: 5 })))).toEqual(['out_of_range:opacity']);
    expect(paths(check(sticky({ w: -1 })))).toEqual(['out_of_range:w']);
    expect(paths(check(sticky({ rotation: 1e12 })))).toEqual(['out_of_range:rotation']);
    expect(codes(check({ id: 'p', type: 'path', points: [0, 0, Number.NaN, 4] }))).toContain('not_finite');
    expect(codes(check({ id: 'p', type: 'path', points: [0, 0, 1] }))).toEqual(['bad_value']);
    expect(scanStructure({ a: [1, { b: -Infinity }] })).toEqual([{ code: 'not_finite', path: 'a[1].b' }]);
  });

  it('rejects nesting deeper than the limit', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(codes(check(sticky({ extra: deep })))).toContain('too_deep');
    expect(codes(check({ id: 'c', type: 'uml-class', attributes: [[[[[[[[1]]]]]]]] }))).toContain('too_deep');
    // a thousand levels must not blow the stack either
    let abyss: unknown = 1;
    for (let i = 0; i < 20_000; i++) abyss = [abyss];
    expect(codes(check(sticky({ extra: abyss })))).toContain('too_deep');
  });

  it('rejects the prototype key names at every depth, whether JSON.parse made them or a Y.Map did', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const top = JSON.parse(`{"id":"s1","type":"sticky","${name}":{"polluted":true}}`);
      expect(codes(check(top))).toContain('proto_key');
      const nested = JSON.parse(`{"id":"s1","type":"shape","kind":"rect","from":{"deep":{"${name}":1}}}`);
      expect(codes(check(nested))).toContain('proto_key');
      expect(validateChangedKeys([{ kind: 'meta', key: name, value: true }]).ok).toBe(false);
    }
    // Y.Map.toJSON() assigns obj[key] = value on a plain object: `__proto__` sets the prototype instead of an own key
    const doc = new Y.Doc();
    const map = doc.getMap('objects');
    const entry = new Y.Map<unknown>();
    map.set('s1', entry);
    entry.set('type', 'sticky');
    entry.set('__proto__', { polluted: true });
    entry.set('x', 1);
    const json = entry.toJSON() as Record<string, unknown>;
    expect(Object.keys(json)).not.toContain('__proto__');
    expect(Object.getPrototypeOf(json)).not.toBe(Object.prototype);
    json.id = 's1';
    expect(codes(check(json))).toContain('proto_key');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects unknown fields on a known type but tolerates the listed ones within their caps', () => {
    expect(paths(check(sticky({ evil: 'x' })))).toEqual(['unknown_field:evil']);
    expect(paths(check({ id: 'f', type: 'frame', backText: 'x' }))).toEqual(['unknown_field:backText']);
    expect(check(sticky({ twoSided: true, face: 'back', backText: 'Back side', faceAt: 1 }))).toEqual({ ok: true });
    expect(paths(check(sticky({ twoSided: 'yes' })))).toEqual(['bad_type:twoSided']);
    expect(paths(check(sticky({ stackName: 'x'.repeat(100) })))).toEqual(['too_long:stackName']);
    expect(check(sticky({ 'tag:abc': 1 }))).toEqual({ ok: true });
    expect(paths(check(sticky({ 'tag:abc': 'x'.repeat(5000) })))).toEqual(['too_big:tag:abc']);
    expect(paths(check(sticky({ labels: ['a', 'b'] })))).toEqual([]);
    expect(Object.keys(TOLERATED_UNKNOWN)).toEqual(expect.arrayContaining(['*', 'sticky', 'shape', 'prefixes']));
  });

  it('rejects colours, urls, dates and enumerations the board cannot draw', () => {
    expect(paths(check(sticky({ fill: 'red;filter:url(//evil/x)' })))).toEqual(['bad_value:fill']);
    expect(check(card({ fill: 'blue' }))).toEqual({ ok: true });
    expect(paths(check(sticky({ fill: 'blue' })))).toEqual(['bad_value:fill']);
    expect(paths(check(card({ link: 'javascript:alert(1)' })))).toEqual(['bad_value:link']);
    expect(paths(check(card({ due: '2026-13-45' })))).toEqual(['bad_value:due']);
    expect(paths(check({ id: 'sh', type: 'shape', kind: 'blob' }))).toEqual(['bad_value:kind']);
    expect(paths(check({ id: 'l1', type: 'lane', stage: 'later' }))).toEqual(['bad_value:stage']);
    expect(paths(check({ id: 'l1', type: 'lane', wip: 0 }))).toEqual(['out_of_range:wip']);
    expect(paths(check({ id: 'i1', type: 'image', asset: 'a/b' }))).toEqual(['bad_value:asset']);
    expect(check({ id: 'i1', type: 'image', asset: 'pending:Abc_123' })).toEqual({ ok: true });
    expect(paths(check(card({ labels: Array.from({ length: 11 }, (_, i) => `l${i}`) })))).toEqual(['too_many:labels']);
  });

  it('checks connector ends and uml members', () => {
    const connector = (extra: Record<string, unknown>) => ({ id: 'k1', type: 'connector', z: 'a', from: { kind: 'free', x: 1, y: 2 }, to: { kind: 'bound', id: 's1', anchor: 'auto' }, route: 'elbow', startHead: 'none', endHead: 'arrow', ...extra });
    expect(check(connector({}))).toEqual({ ok: true });
    expect(codes(check(connector({ from: { kind: 'weird' } })))).toEqual(['bad_value']);
    expect(codes(check(connector({ to: { kind: 'bound', id: 's1', anchor: 'middle' } })))).toEqual(['bad_value']);
    expect(codes(check(connector({ to: { kind: 'bound', id: 's1', extra: 1 } })))).toEqual(['unknown_field']);
    expect(codes(check(connector({ from: { kind: 'free', x: Number.NaN, y: 0 } })))).toContain('not_finite');
    expect(codes(check({ id: 'u', type: 'uml-class', attributes: [{ visibility: '*', name: 'a', type: 'b' }] }))).toEqual(['bad_value']);
  });

  it('keeps content out of violations', () => {
    const secret = 'TOP-SECRET-CONTENT';
    const result = check(sticky({ [`bad ${secret} key`]: secret, text: 7, fill: secret, kind: secret }));
    const json = JSON.stringify(result);
    expect(json).not.toContain(secret);
    expect(paths(result)).toContain('unknown_field:?');
    expect(Object.keys((result as { violations: object[] }).violations[0]).sort()).toEqual(['code', 'path']);
    // the map key and kind are sender text too: they are echoed only when id-shaped
    const keyed = JSON.stringify(validateChangedKeys([
      { kind: 'meta', key: `TOP SECRET ${secret}`, value: 1 },
      { kind: `evil ${secret}`, key: 'k', value: {} },
      { kind: 'object', key: `bad ${secret}`, value: sticky() },
    ], ctx));
    expect(keyed).not.toContain(secret);
    expect(keyed).toContain('"key":"?"');
    expect(JSON.stringify(validateChangedKeys([{ kind: 'meta', key: 'secret', value: 1 }]))).toContain('"key":"secret"');
  });
});

describe('authorship and owners', () => {
  it('rejects a forged createdBy on creation and accepts the writer', () => {
    expect(check(sticky(), ctx, { isNew: true })).toEqual({ ok: true });
    expect(paths(check(sticky({ createdBy: 'u2' }), ctx, { isNew: true }))).toEqual(['forged_author:createdBy']);
  });

  it('lets a member createdBy through only under the undo-restore policy', () => {
    const restoring = { ...ctx, createdByPolicy: 'member' } as Ctx;
    expect(check(sticky({ createdBy: 'u2' }), restoring, { isNew: true })).toEqual({ ok: true });
    expect(paths(check(sticky({ createdBy: 'stranger' }), restoring, { isNew: true }))).toEqual(['forged_author:createdBy']);
  });

  it('does not re-check createdBy when somebody moves another person\'s sticky', () => {
    const theirs = sticky({ createdBy: 'u2', x: 99 });
    expect(check(theirs, ctx, { fields: ['x'] })).toEqual({ ok: true });
    expect(check(theirs, ctx, { prev: { ...theirs, x: 1 } })).toEqual({ ok: true });
    expect(paths(check(theirs, ctx, { fields: ['createdBy'] }))).toEqual(['forged_author:createdBy']);
  });

  it('skips authorship in open mode, where nobody has an identity', () => {
    expect(check(sticky({ createdBy: 'anyone' }), { ...ctx, writer: null }, { isNew: true })).toEqual({ ok: true });
  });

  it('rejects an ownerId that is not a current member, and only when it changed', () => {
    expect(paths(check(card({ ownerId: 'mallory', ownerName: 'Mallory', ownerKind: 'person' }), ctx, { isNew: true }))).toEqual(['forged_owner:ownerId']);
    expect(check(card({ ownerId: 'u2', ownerName: 'Marta', ownerKind: 'person' }), ctx, { isNew: true })).toEqual({ ok: true });
    // a card owned by somebody who has since left the board can still be moved
    const gone = card({ ownerId: 'left-the-board', ownerName: 'Old', ownerKind: 'person', rank: 'b0@l1' });
    expect(check(gone, ctx, { fields: ['rank'] })).toEqual({ ok: true });
    expect(check(gone, ctx, { prev: { ...gone, rank: 'a0@l1' } })).toEqual({ ok: true });
    expect(paths(check(card({ ownerId: 123 })))).toEqual(['bad_type:ownerId']);
  });

  it('does not stamp ownerId: another member may own the card', () => {
    const value = card({ ownerId: 'u2', ownerName: 'Marta', ownerKind: 'person' });
    expect(check(value, ctx, { isNew: true })).toEqual({ ok: true });
    expect((value as { ownerId?: string }).ownerId).toBe('u2');
  });

  it('requires canEditObject to change an owner on an existing card', () => {
    const readOnly = { ...ctx, canEditObject: () => false } as Ctx;
    const prev = card({ ownerId: 'u1', ownerName: 'Lea', ownerKind: 'person' });
    const next = card({ ownerId: 'u2', ownerName: 'Marta', ownerKind: 'person' });
    expect(paths(check(next, readOnly, { prev }))).toEqual(['owner_change_denied:ownerId']);
    expect(paths(check(next, readOnly, { fields: ['ownerId', 'ownerName'] }))).toEqual(['owner_change_denied:ownerId']);
    expect(check(next, ctx, { prev })).toEqual({ ok: true });
    // clearing the owner is a change too
    expect(paths(check(card(), readOnly, { fields: ['ownerId', 'ownerName', 'ownerKind'] }))).toEqual(['owner_change_denied:ownerId']);
    // an unrelated edit of the same card is not
    expect(check({ ...next, text: 'New title' }, readOnly, { prev: next })).toEqual({ ok: true });
    // creation needs no canEditObject
    expect(check(next, readOnly, { isNew: true })).toEqual({ ok: true });
  });

  it('fails closed when the context cannot answer', () => {
    expect(paths(check(card({ ownerId: 'u2' }), { writer: ctx.writer }, { isNew: true }))).toEqual(['forged_owner:ownerId']);
    expect(paths(check(card({ ownerId: 'u2' }), { writer: ctx.writer, isBoardMember: () => true }, { fields: ['ownerId'] }))).toEqual(['owner_change_denied:ownerId']);
  });

  it('refuses an agent owner a client cannot create, and keeps an existing one', () => {
    const agent = card({ ownerId: 'tok-1', ownerName: 'Claude', ownerKind: 'agent' });
    expect(paths(check(agent, ctx, { isNew: true }))).toEqual(['forged_owner:ownerId']);
    expect(check(agent, ctx, { isNew: true }) && check(agent, { ...ctx, isAgentOwner: (id: string) => id === 'tok-1' } as Ctx, { isNew: true })).toEqual({ ok: true });
    // moving an agent's card changes no owner field
    expect(check(agent, ctx, { fields: ['rank', 'parent'] })).toEqual({ ok: true });
    // clearing it (the owner fields are deleted) is allowed with permission
    expect(check(card(), ctx, { prev: agent })).toEqual({ ok: true });
    // keeping the same agent while another field changes
    expect(check({ ...agent, text: 'x' }, ctx, { prev: agent })).toEqual({ ok: true });
  });
});

describe('only the changed keys', () => {
  it('ignores a malformed field that was not touched', () => {
    const legacy = sticky({ opacity: 70, odd: { nested: true } });
    expect(check(legacy, ctx).ok).toBe(false);
    expect(check(legacy, ctx, { fields: ['x'] })).toEqual({ ok: true });
    expect(check(legacy, ctx, { prev: { ...legacy, x: 1 } })).toEqual({ ok: true });
    expect(paths(check(legacy, ctx, { fields: ['opacity'] }))).toEqual(['out_of_range:opacity']);
  });

  it('checks every field of a new object whatever `fields` says', () => {
    expect(check(sticky({ opacity: 70 }), ctx, { isNew: true, fields: ['x'] }).ok).toBe(false);
  });

  it('never mutates its input', () => {
    const value = sticky({ opacity: 70 });
    const before = JSON.stringify(value);
    check(value, ctx);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('does not look at deletions', () => {
    expect(validateChangedKeys([{ kind: 'object', key: 's1', value: null }, { kind: 'thread', key: 't1', value: null }, { kind: 'vote', key: 'v', value: null }])).toEqual({ ok: true });
  });

  it('collects violations from every change with the kind and key, no content', () => {
    const result = validateChangedKeys([
      { kind: 'object', key: 's1', value: sticky({ x: 'a' }) },
      { kind: 'object', key: 's2', value: sticky({ id: 's2' }) },
      { kind: 'meta', key: 'weird', value: 1 },
      { kind: 'nope', key: 'k', value: {} },
    ], ctx);
    expect(result).toEqual({
      ok: false,
      violations: [
        { code: 'bad_type', path: 'x', kind: 'object', key: 's1' },
        { code: 'unknown_field', path: 'weird', kind: 'meta', key: 'weird' },
        { code: 'unknown_kind', path: '', kind: 'nope', key: 'k' },
      ],
    });
    expect(countCodes((result as { violations: Violation[] }).violations)).toEqual({ bad_type: 1, unknown_field: 1, unknown_kind: 1 });
  });
});

describe('comments', () => {
  const author = ctx.writer as { id: string; name: string; color: string };
  const thread = (extra: Record<string, unknown> = {}) => ({
    id: 't1', createdAt: 1_700_000_000_000, authorId: author.id, authorName: author.name, authorColor: author.color, text: 'Hello',
    anchor: { x: 1, y: 2, obj: 's1', fx: 0.5, fy: 0.5 }, resolved: false, replies: {}, ...extra,
  });
  const reply = (extra: Record<string, unknown> = {}) => ({
    id: 'r1', authorId: author.id, authorName: author.name, authorColor: author.color, text: 'Thanks', createdAt: 1_700_000_000_001, ...extra,
  });
  const run = (value: unknown, opts = { isNew: true } as Record<string, unknown>, c: Ctx = ctx) => validateCommentThread('t1', value, c, opts);

  it('accepts what src/comments.ts writes', () => {
    expect(run(thread({ replies: { r1: reply() } }))).toEqual({ ok: true });
    expect(run(thread({ editedAt: 1_700_000_000_500, resolved: true, resolvedBy: 'u1', resolvedAt: 1_700_000_000_900 }), {})).toEqual({ ok: true });
  });

  it('rejects wrong types, long text, empty text and unknown fields', () => {
    expect(paths(run(thread({ text: 5 })))).toEqual(['bad_type:text']);
    expect(paths(run(thread({ text: 'x'.repeat(LIMITS.commentText + 1) })))).toEqual(['too_long:text']);
    expect(paths(run(thread({ text: '' })))).toEqual(['too_short:text']);
    expect(paths(run(thread({ createdAt: Number.NaN })))).toEqual(['not_finite:createdAt']);
    expect(paths(run(thread({ extra: 1 })))).toEqual(['unknown_field:extra']);
    expect(paths(run(thread({ anchor: { x: 'a', y: 2 } })))).toEqual(['bad_type:anchor']);
    expect(paths(run(thread({ anchor: { x: 1, y: 2, evil: 1 } })))).toEqual(['unknown_field:anchor']);
    expect(paths(run(thread({ anchor: { y: 2 } })))).toEqual(['missing_field:anchor']);
    expect(paths(run(thread({ replies: [] })))).toEqual(['bad_type:replies']);
  });

  it('checks the thread and reply id patterns', () => {
    expect(codes(validateCommentThread('bad id', thread(), ctx, { isNew: true }))).toEqual(['bad_value']);
    expect(codes(validateCommentThread('t2', thread(), ctx, { isNew: true }))).toEqual(['id_mismatch']);
    expect(codes(run(thread({ replies: { 'bad id': reply({ id: 'bad id' }) } })))).toContain('bad_value');
    expect(paths(run(thread({ replies: { r1: reply({ id: 'r2' }) } })))).toContain('id_mismatch:replies.r1.id');
  });

  it('stamps authorship: id, name and colour must be the writer\'s', () => {
    expect(paths(run(thread({ authorId: 'u2' })))).toEqual(['forged_author:authorId']);
    // the colour is picked by the client: only its shape is checked
    expect(run(thread({ authorColor: '#000000' }))).toEqual({ ok: true });
    expect(paths(run(thread({ authorName: 'Somebody Else' })))).toEqual(['forged_author:authorName']);
    expect(paths(run(thread({ replies: { r1: reply({ authorId: 'u2' }) } })))).toEqual(['forged_author:replies.r1.authorId']);
    expect(paths(run(thread({ authorColor: 'red;x' })))).toContain('bad_value:authorColor');
  });

  it('checks the colour for shape only, and authorship never in open mode', () => {
    expect(paths(run(thread({ authorColor: 'var(--x, #123456)' })))).toEqual(['too_long:authorColor']);
    expect(paths(run(thread({ authorColor: 'blue' })))).toEqual(['bad_value:authorColor']);
    expect(run(thread({ authorId: 'anyone', authorColor: '#000000' }), { isNew: true }, { writer: null })).toEqual({ ok: true });
  });

  it('does not re-check the author of an existing reply when its text is edited', () => {
    const before = thread({ replies: { r1: reply({ authorColor: '#123456' }) } });
    const after = thread({ replies: { r1: reply({ authorColor: '#123456', text: 'Edited', editedAt: 1_700_000_005_000 }) } });
    expect(run(after, { prev: before, replyIds: ['r1'], fields: ['replies'] } as never)).toEqual({ ok: true });
    // but a changed author field on an existing reply is checked
    const forged = thread({ replies: { r1: reply({ authorColor: '#123456', authorId: 'u2' }) } });
    expect(paths(run(forged, { prev: before, replyIds: ['r1'], fields: ['replies'] } as never))).toEqual(['forged_author:replies.r1.authorId']);
  });

  it('looks only at the replies that changed', () => {
    const replies = { r1: reply({ text: 'x'.repeat(LIMITS.commentText + 1) }), r2: reply({ id: 'r2' }) };
    expect(run(thread({ replies }), { replyIds: ['r2'], fields: ['replies'] } as never)).toEqual({ ok: true });
    expect(paths(run(thread({ replies }), { replyIds: ['r1'], fields: ['replies'] } as never))).toEqual(['too_long:replies.r1.text']);
  });

  it('caps replies per thread and threads per room', () => {
    const replies = Object.fromEntries(Array.from({ length: LIMITS.repliesPerThread + 1 }, (_, i) => [`r${i}`, reply({ id: `r${i}` })]));
    expect(codes(run(thread({ replies })))).toContain('reply_cap');
    const fewer = Object.fromEntries(Array.from({ length: LIMITS.repliesPerThread }, (_, i) => [`r${i}`, reply({ id: `r${i}` })]));
    expect(run(thread({ replies: fewer }))).toEqual({ ok: true });
    expect(codes(run(thread(), { isNew: true }, { ...ctx, counts: { thread: LIMITS.threadsPerRoom } } as Ctx))).toEqual(['thread_cap']);
    expect(run(thread(), { isNew: true }, { ...ctx, counts: { thread: LIMITS.threadsPerRoom - 1 } } as Ctx)).toEqual({ ok: true });
    // an edit of an existing thread in a full room is fine
    expect(run(thread(), { fields: ['text'] } as never, { ...ctx, counts: { thread: LIMITS.threadsPerRoom } } as Ctx)).toEqual({ ok: true });
  });

  it('lets only a board owner import comments, and never lets a client set `legacy`', () => {
    const imported = thread({ imported: true, importedBy: 'u1', authorId: 'someone-else', authorColor: '#000000', authorName: 'Someone' });
    expect(paths(run(imported))).toEqual(['forged_author:imported']);
    expect(run(imported, { isNew: true }, { ...ctx, writer: { ...author, role: 'owner' } } as Ctx)).toEqual({ ok: true });
    expect(paths(run(thread({ imported: true, importedBy: 'u9' }), { isNew: true }, { ...ctx, writer: { ...author, role: 'owner' } } as Ctx))).toEqual(['forged_author:importedBy']);
    expect(paths(run(thread({ legacy: true })))).toEqual(['forged_legacy:legacy']);
  });

  it('rejects a prototype key in a reply map', () => {
    const replies = JSON.parse('{"__proto__":{"x":1}}');
    expect(codes(run(thread({ replies })))).toContain('proto_key');
  });
});

describe('the other board maps', () => {
  const one = (change: Change, c: Ctx = ctx) => validateChangedKeys([change], c);
  const pollId = 'p1';

  it('checks meta: known keys and feature flags only', () => {
    expect(one({ kind: 'meta', key: 'name', value: 'My board' }).ok).toBe(true);
    expect(one({ kind: 'meta', key: 'feature:containers', value: true }).ok).toBe(true);
    expect(one({ kind: 'meta', key: 'feature:containers', value: 'yes' }).ok).toBe(false);
    expect(one({ kind: 'meta', key: 'gridType', value: 'hex' }).ok).toBe(false);
    expect(one({ kind: 'meta', key: 'gridSize', value: Number.NaN }).ok).toBe(false);
    expect(one({ kind: 'meta', key: 'secret', value: 'x' }).ok).toBe(false);
    expect(one({ kind: 'meta', key: 'name', value: 'x'.repeat(LIMITS.name + 1) }).ok).toBe(false);
    expect(one({ kind: 'meta', key: 'stickyColors', value: ['#112233', 'red'] }).ok).toBe(false);
  });

  it('checks the flow map', () => {
    expect(one({ kind: 'flow', key: 'active', value: -1 }).ok).toBe(true);
    expect(one({ kind: 'flow', key: 'timer', value: { startedAt: 1, durationMs: 1000 } }).ok).toBe(true);
    expect(one({ kind: 'flow', key: 'timer', value: { startedAt: 1, durationMs: 1000, evil: 1 } }).ok).toBe(false);
    expect(one({ kind: 'flow', key: 'steps', value: [{ id: 's', title: 't', instructions: '', mode: 'rocket' }] }).ok).toBe(false);
    expect(one({ kind: 'flow', key: 'steps', value: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, title: 't', instructions: '', mode: 'write' })) }).ok).toBe(false);
    expect(one({ kind: 'flow', key: 'evil', value: 1 }).ok).toBe(false);
  });

  it('keeps people to their own votes and poll answers', () => {
    const vote = { itemId: 's1', userId: 'u1', stepId: 'st1' };
    expect(one({ kind: 'vote', key: 'st1:u1:abc', value: vote }).ok).toBe(true);
    expect(paths(one({ kind: 'vote', key: 'st1:u1:abc', value: { ...vote, userId: 'u2' } }) as never)).toContain('forged_author:userId');
    expect(paths(one({ kind: 'vote', key: 'st1:u2:abc', value: vote }) as never)).toContain('id_mismatch:key');
    const answer = { pollId, userId: 'u1', optionIds: ['o1'], updatedAt: 1, name: 'Lea', color: '#3366FF' };
    expect(one({ kind: 'pollAnswer', key: 'p1:u1', value: answer }).ok).toBe(true);
    expect(paths(one({ kind: 'pollAnswer', key: 'p1:u2', value: { ...answer, userId: 'u2' } }) as never)).toContain('forged_author:userId');
    expect(one({ kind: 'pollAnswer', key: 'p1:u1', value: { ...answer, optionIds: Array.from({ length: 11 }, (_, i) => `o${i}`) } }).ok).toBe(false);
  });

  it('checks polls, poll state and labels', () => {
    const poll = { id: pollId, question: 'Which?', options: [{ id: 'o1', text: 'A' }, { id: 'o2', text: 'B' }], multiple: false, anonymous: false, revealed: false, createdAt: 1, createdBy: 'u1' };
    expect(one({ kind: 'poll', key: pollId, value: poll, isNew: true }).ok).toBe(true);
    expect(one({ kind: 'poll', key: pollId, value: { ...poll, createdBy: 'u2' }, isNew: true }).ok).toBe(false);
    expect(one({ kind: 'poll', key: pollId, value: { ...poll, options: Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, text: 'x' })) } }).ok).toBe(false);
    expect(one({ kind: 'poll', key: 'other', value: poll }).ok).toBe(false);
    expect(one({ kind: 'pollState', key: 'p1:revealed', value: true }).ok).toBe(true);
    expect(one({ kind: 'pollState', key: 'p1:openedAt', value: Number.NaN }).ok).toBe(false);
    expect(one({ kind: 'pollState', key: 'p1:whatever', value: true }).ok).toBe(false);
    expect(one({ kind: 'label', key: 'b1', value: { id: 'b1', name: 'Bug', color: 'pink', order: 0 } }).ok).toBe(true);
    expect(one({ kind: 'label', key: 'b1', value: { id: 'b1', name: 'x'.repeat(41), color: 'pink', order: 0 } }).ok).toBe(false);
    expect(one({ kind: 'label', key: 'b1', value: { id: 'b1', name: 'Bug', color: 'url(//evil)', order: 0 } }).ok).toBe(false);
  });
});
