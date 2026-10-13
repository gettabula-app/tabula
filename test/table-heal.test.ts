import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { watchTableSizes } from '../src/table-heal';
import { newTableFields, tableModel } from '../shared/tables';
import { escapeXml } from '../src/text';

let n = 0;
const ids = () => `i${n++}`;

describe('table heal drops cells outside the grid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes c: and f: keys of a row or column the table does not have, and keeps the live ones', () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const store = new Store(new Y.Doc());
    const fields = newTableFields(2, 2, ids);
    const { rows, cols } = tableModel(fields);
    store.create({ id: 't1', type: 'table', x: 0, y: 0, w: 480, h: 120, rotation: 0, z: 'a0', ...fields, [`c:${rows[0]}:${cols[0]}`]: 'live' } as never);
    store.update('t1', { 'c:ghost:ghost': 'x'.repeat(900), [`c:${rows[0]}:gone`]: 'y', [`f:gone:${cols[0]}`]: '#ff0000' } as never);
    const stop = watchTableSizes({ store, role: () => 'owner', busy: () => false, hidden: () => false });
    while (frames.length) frames.shift()!();
    const o = store.get('t1') as unknown as Record<string, unknown>;
    expect(o['c:ghost:ghost']).toBeUndefined();
    expect(o[`c:${rows[0]}:gone`]).toBeUndefined();
    expect(o[`f:gone:${cols[0]}`]).toBeUndefined();
    expect(o[`c:${rows[0]}:${cols[0]}`]).toBe('live');
    stop();
  });
});

describe('escapeXml', () => {
  it('strips characters XML 1.0 cannot hold and lone surrogates, keeps real text and pairs', () => {
    expect(escapeXml('a\u0000b\u0008c\u000Bd\u001Fe￾f￿g')).toBe('abcdefg');
    expect(escapeXml('x\uD800y\uDC00z')).toBe('xyz');
    expect(escapeXml('tab\tnl\ncr\r😀 <&>"')).toBe('tab\tnl\ncr\r😀 &lt;&amp;&gt;&quot;');
  });
});
