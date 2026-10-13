import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { isLine } from '../src/line-geometry';
import { safeObj } from '../src/safe-obj';
import { remapObjects } from '../src/custom-templates';
import type { ConnectorObj } from '../src/types';

const line = (id: string, extra: Partial<ConnectorObj> = {}): ConnectorObj => ({
  id, type: 'connector', z: id, from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 120, y: 40 },
  route: 'straight', startHead: 'none', endHead: 'none', line: true, strokeWidth: 2, dash: 'solid', ...extra,
});

describe('a line in the store', () => {
  it('keeps its line flag and free ends when created', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.create(line('l1')));
    const got = s.get('l1') as ConnectorObj;
    expect(got.line).toBe(true);
    expect(isLine(got)).toBe(true);
  });

  it('is written as a plain connector when created with a bound end', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.create(line('l1', { to: { kind: 'bound', id: 'box', anchor: 'auto' } })));
    expect((s.get('l1') as ConnectorObj).line).toBeUndefined();
  });

  it('is written as a plain connector when created with a non-straight route, or a non-boolean flag', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => {
      s.create(line('elbow', { route: 'elbow' }));
      s.create(line('curved', { route: 'curved' }));
      s.create(line('string', { line: 'yes' as unknown as boolean }));
    });
    for (const id of ['elbow', 'curved', 'string']) expect((s.get(id) as ConnectorObj).line).toBeUndefined();
  });

  it('keeps being a line while an end is dragged to a new free point', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.create(line('l1')));
    s.transact(() => s.update('l1', { to: { kind: 'free', x: 300, y: -20 } }));
    const got = s.get('l1') as ConnectorObj;
    expect(got.line).toBe(true);
    expect(got.to).toEqual({ kind: 'free', x: 300, y: -20 });
  });

  it('loses its line flag when an end is bound, and the connector is then an ordinary connector', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.create(line('l1')));
    s.transact(() => s.update('l1', { from: { kind: 'bound', id: 'box', anchor: 'auto' } }));
    const got = s.get('l1') as ConnectorObj;
    expect(got.line).toBeUndefined();
    expect(isLine(got)).toBe(false);
  });

  it('loses its line flag when its route changes away from straight, and keeps it when the route stays straight', () => {
    const s = new Store(new Y.Doc());
    s.transact(() => s.create(line('l1')));
    s.transact(() => s.update('l1', { route: 'straight' }));
    expect((s.get('l1') as ConnectorObj).line).toBe(true);
    s.transact(() => s.update('l1', { route: 'elbow' }));
    expect((s.get('l1') as ConnectorObj).line).toBeUndefined();
  });

  it('is cleaned on the way out to the canvas too: a bound line with a stale flag draws as a connector', () => {
    const stale = { ...line('l1', { route: 'elbow' }) } as ConnectorObj;
    const cleaned = safeObj(stale);
    expect(cleaned.line).toBeUndefined();
    expect(safeObj(line('l2')).line).toBe(true);
  });

  it('a plain connector never gets the flag by itself', () => {
    const s = new Store(new Y.Doc());
    const c: ConnectorObj = { ...line('c1'), line: undefined };
    delete c.line;
    s.transact(() => s.create(c));
    expect((s.get('c1') as ConnectorObj).line).toBeUndefined();
    expect(isLine(s.get('c1'))).toBe(false);
  });
});

describe('a line copied, duplicated or pasted', () => {
  it('keeps its flag and its free ends, moved by the offset, under a new id', () => {
    const original = line('l1');
    const [copy] = remapObjects([original], new Map([['l1', 'l2']]), { x: 24, y: 24 }, () => null) as ConnectorObj[];
    expect(copy.id).toBe('l2');
    expect(copy.line).toBe(true);
    expect(copy.from).toEqual({ kind: 'free', x: 24, y: 24 });
    expect(copy.to).toEqual({ kind: 'free', x: 144, y: 64 });
    expect(isLine(copy)).toBe(true);
    // the original is untouched
    expect(original.from).toEqual({ kind: 'free', x: 0, y: 0 });
  });
});
