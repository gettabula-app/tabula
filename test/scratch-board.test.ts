import { afterEach, describe, expect, it, vi } from 'vitest';
import { scratchBoard } from '../src/sync';
import { instantiate, type TemplateContent } from '../src/custom-templates';
import { loadTemplate } from '../src/ui/template-edit';
import { LOCAL } from '../src/store';
import type { BaseObj } from '../src/types';

const user = { id: 'u1', name: 'Test', color: '#2F6FED' };

afterEach(() => vi.unstubAllGlobals());

describe('scratchBoard', () => {
  it('is local and in memory: no provider, no persistence, no board index', () => {
    const storage = { getItem: vi.fn<() => null>(() => null), setItem: vi.fn<() => void>(), removeItem: vi.fn<() => void>() };
    const idb = { open: vi.fn<() => void>() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('indexedDB', idb);
    const conn = scratchBoard('template-abc', user);
    conn.store.create({ id: 'a', type: 'sticky', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a' } as BaseObj);
    conn.store.setMeta({ name: 'Edited' });
    expect(conn.provider).toBeNull();
    expect(conn.status).toBe('local');
    expect(conn.denied).toBeNull();
    expect(conn.awareness.getLocalState()?.user).toEqual(user);
    expect(conn.store.get('a')).toBeDefined();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(idb.open).not.toHaveBeenCalled();
    conn.destroy();
  });

  it('keeps comments read-only and gives every scratch board its own document', () => {
    const a = scratchBoard('template-1', user);
    const b = scratchBoard('template-1', user);
    expect(a.comments.readOnly()).toBe(true);
    a.store.setMeta({ name: 'Only in a' });
    expect(b.store.getMeta().name).not.toBe('Only in a');
    a.destroy();
    b.destroy();
  });
});

describe('loadTemplate', () => {
  const content: TemplateContent = {
    objects: [
      { id: 'o1', type: 'frame', x: 0, y: 0, w: 400, h: 300, rotation: 0, z: '1', name: 'Frame' } as BaseObj,
      { id: 'o2', type: 'sticky', x: 20, y: 20, w: 100, h: 80, rotation: 0, z: '2', parent: 'o1', text: 'hi' } as BaseObj,
    ],
    steps: [{ id: 's1', title: 'Write', instructions: '', mode: 'write', frameId: 'o1' }],
    bounds: { x: 0, y: 0, w: 400, h: 300 },
    fonts: { heading: 'general-sans', body: 'switzer' },
  };
  const tpl = { id: 't1', version: 1 as const, name: 'Mine', category: 'Custom', description: '', content, createdBy: 'u1', createdAt: 1, updatedAt: 1 };

  it('puts the objects at the origin with fresh ids, the name, the fonts and the steps', () => {
    const conn = scratchBoard('template-t1', user);
    loadTemplate(conn.store, tpl, user.id);
    const objs = conn.store.ordered();
    expect(objs).toHaveLength(2);
    expect(objs.map((o) => o.id)).not.toContain('o1');
    const frame = objs.find((o) => o.type === 'frame') as BaseObj;
    expect([frame.x, frame.y]).toEqual([0, 0]);
    const child = objs.find((o) => o.type === 'sticky') as BaseObj;
    expect(child.parent).toBe(frame.id);
    expect(child.createdBy).toBe('u1');
    expect(conn.store.getMeta()).toMatchObject({ name: 'Mine', headingFont: 'general-sans', bodyFont: 'switzer' });
    const steps = conn.store.getFlow().steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].frameId).toBe(frame.id);
    conn.destroy();
  });

  it('is not undoable, so Ctrl+Z cannot empty the board, while later edits are', () => {
    const conn = scratchBoard('template-t1', user);
    loadTemplate(conn.store, tpl, user.id);
    conn.store.undo.undo();
    expect(conn.store.ordered()).toHaveLength(2);
    const [first] = conn.store.ordered();
    conn.store.transactAs(() => conn.store.update(first.id, { x: 50 }), LOCAL);
    conn.store.undo.undo();
    expect((conn.store.get(first.id) as BaseObj).x).toBe(0);
    conn.destroy();
  });

  it('matches what instantiate gives for the same content', () => {
    const conn = scratchBoard('template-t1', user);
    loadTemplate(conn.store, tpl, user.id);
    const expected = instantiate(content, { x: 0, y: 0 }, user.id).objects;
    expect(conn.store.ordered().map((o) => [o.type, (o as BaseObj).x, (o as BaseObj).y])).toEqual(
      expected.map((o) => [o.type, (o as BaseObj).x, (o as BaseObj).y]),
    );
    conn.destroy();
  });
});
