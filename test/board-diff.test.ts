import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { diffBoardUpdates } from '../server/board-diff.mjs';

function update(objects: Record<string, Record<string, unknown>>, reveal = false) {
  const doc = new Y.Doc();
  doc.getMap('flow').set('reveal', reveal);
  const map = doc.getMap('objects');
  for (const [id, fields] of Object.entries(objects)) map.set(id, new Y.Map(Object.entries(fields)));
  const encoded = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return encoded;
}

describe('diffBoardUpdates', () => {
  it('reports object ids, types and changed field names without values', () => {
    const before = update({
      changed: { type: 'sticky', text: 'old private text', x: 1, y: 2, w: 100, h: 100 },
      removed: { type: 'shape', kind: 'rect', x: 3, y: 4, w: 50, h: 60 },
    });
    const after = update({
      changed: { type: 'sticky', text: 'new private text', x: 1, y: 2, w: 100, h: 100 },
      added: { type: 'text', text: 'also private text', x: 5, y: 6, w: 70, h: 30 },
    });

    const diff = diffBoardUpdates(before, after);
    expect(diff).toEqual({
      added: [{ id: 'added', type: 'text' }],
      removed: [{ id: 'removed', type: 'shape' }],
      changed: [{ id: 'changed', type: 'sticky', fields: ['text'] }],
    });
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain('old private text');
    expect(serialized).not.toContain('new private text');
    expect(serialized).not.toContain('also private text');
  });

  it('omits a private note and connectors to it if either compared state withholds it', () => {
    const before = update({
      secret: { type: 'sticky', text: 'withheld words', privateStep: 'step-1', x: 0, y: 0, w: 100, h: 100 },
      visible: { type: 'sticky', text: 'visible', x: 200, y: 0, w: 100, h: 100 },
      link: { type: 'connector', from: { kind: 'bound', id: 'secret' }, to: { kind: 'bound', id: 'visible' } },
    });
    const after = update({
      secret: { type: 'sticky', text: 'withheld words', privateStep: 'step-1', x: 0, y: 0, w: 100, h: 100 },
      visible: { type: 'sticky', text: 'visible', x: 200, y: 0, w: 100, h: 100 },
      link: { type: 'connector', from: { kind: 'bound', id: 'secret' }, to: { kind: 'bound', id: 'visible' } },
    }, true);

    const diff = diffBoardUpdates(before, after);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
    expect(JSON.stringify(diff)).not.toContain('secret');
    expect(JSON.stringify(diff)).not.toContain('withheld words');
  });
});
