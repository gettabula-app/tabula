import { describe, expect, it } from 'vitest';
import { FIELDS, validateBoardObject } from '../server/sync-validate.mjs';

// A line (docs/lines.md) is a connector with line: true; both ends free and route straight if present.

const ctx = {
  writer: { id: 'u1', name: 'Lea Brandt', color: '#3366FF' },
  isBoardMember: (id: string) => ['u1', 'u2'].includes(id),
  canEditObject: () => true,
};
const free = (x: number, y: number) => ({ kind: 'free', x, y });
const bound = (id: string) => ({ kind: 'bound', id, anchor: 'auto' });
const line = (extra: Record<string, unknown> = {}) => ({
  id: 'l1', type: 'connector', z: 'a0', line: true, from: free(0, 0), to: free(100, 40), route: 'straight',
  createdBy: 'u1', updatedAt: 1_700_000_000_000, ...extra,
});
const codes = (r: { ok: boolean; violations?: { code: string; path: string }[] }) => (r.ok ? [] : r.violations!.map((v) => `${v.code}:${v.path}`));
const check = (value: unknown, c: Record<string, unknown> = ctx, opts: Record<string, unknown> = {}) =>
  validateBoardObject((value as { id: string }).id, value, c, opts);

describe('lines in the sync validator', () => {
  it('has a line flag on connectors and nowhere else', () => {
    expect(FIELDS.connector).toHaveProperty('line');
    expect(FIELDS.sticky).not.toHaveProperty('line');
  });

  it('accepts a line with two free ends and a straight route, and one without a route', () => {
    expect(check(line())).toEqual({ ok: true });
    expect(check(line({ route: undefined }))).toEqual({ ok: true });
  });

  it('refuses a line with a bound end, at the line path', () => {
    expect(codes(check(line({ to: bound('s1') })))).toEqual(['bad_value:line']);
    expect(codes(check(line({ from: bound('s1') })))).toEqual(['bad_value:line']);
  });

  it('refuses a line with a curved or elbow route', () => {
    expect(codes(check(line({ route: 'curved' })))).toEqual(['bad_value:line']);
    expect(codes(check(line({ route: 'elbow' })))).toEqual(['bad_value:line']);
  });

  it('refuses a line flag that is not a boolean', () => {
    expect(codes(check(line({ line: 'yes' })))).toEqual(['bad_type:line']);
  });

  it('keeps the rules for ordinary connectors: no line flag, bound ends and any route stay valid', () => {
    expect(check({ ...line(), line: undefined, to: bound('s1'), route: 'curved' })).toEqual({ ok: true });
    expect(check({ ...line(), line: false, to: bound('s1') })).toEqual({ ok: true });
  });

  it('checks a partial change against the stored object: a bound end on a stored line is refused', () => {
    const prev = line();
    const change: Record<string, unknown> = line({ to: bound('s1') });
    delete change.line;
    const r = check(change, ctx, { fields: ['to'], prev: { ...prev, line: true } });
    expect(codes(r)).toEqual(['bad_value:line']);
  });

  it('a partial change that keeps both ends free passes', () => {
    const prev = line();
    const r = check({ ...line({ to: free(5, 5) }) }, ctx, { prev });
    expect(r).toEqual({ ok: true });
  });
});
