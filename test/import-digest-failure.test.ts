import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

// If hashing breaks, an import must fail before it has written anything: all digests are worked out first (a dry run in a scratch store).
vi.mock('../src/sha256', () => ({ sha256Hex: () => { throw new Error('hashing is broken'); }, sha256: () => { throw new Error('hashing is broken'); } }));

describe('a hashing failure cannot leave a partial import', () => {
  it('rejects before the board has been touched', async () => {
    const { importBoard } = await import('../src/exporters');
    const { Store } = await import('../src/store');
    const { Comments } = await import('../src/comments');
    const doc = new Y.Doc();
    const target = { doc, store: new Store(doc), comments: new Comments(new Y.Doc()) };
    const objects = Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}`, type: 'sticky', x: 1, y: 2, w: 10, h: 10, rotation: 0, z: `z${i}`, text: 'x'.repeat(200) }));
    const imported = { json: { format: 'driftboard', schemaVersion: 1, exportedAt: '', meta: { name: 'Theirs' }, objects, flow: {} } } as never;
    await expect(importBoard(target, imported, 'me', { confirm: async () => true })).rejects.toThrow('hashing is broken');
    expect(target.store.objects.size).toBe(0);
    expect(target.store.meta.size).toBe(0);
    expect(target.store.undo.undoStack.length).toBe(0);
    expect(doc.store.clients.size).toBe(0);
  });
});
