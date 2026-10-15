import { describe, expect, it } from 'vitest';
import { previewSourceOf } from '../server/board-ops.mjs';

const note = (id: string, extra: object = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: id, createdBy: 'u1', ...extra });

describe('previewSourceOf: the everyone\'s view of a board', () => {
  it('drops unrevealed private notes whoever wrote them, and connectors bound to them', () => {
    const objects = [
      note('a'),
      note('p', { privateStep: 'x', createdBy: 'uploader' }),
      { id: 'c1', type: 'connector', from: { kind: 'bound', id: 'a' }, to: { kind: 'bound', id: 'p' } },
      { id: 'c2', type: 'connector', from: { kind: 'bound', id: 'a' }, to: { kind: 'point', x: 1, y: 1 } },
    ];
    expect(previewSourceOf(objects, false).map((o) => o.id)).toEqual(['a', 'c2']);
    expect(previewSourceOf(objects, true).map((o) => o.id)).toEqual(['a', 'p', 'c1', 'c2']);
  });

  it('drops hidden objects, the children of a hidden frame, and private cards', () => {
    const objects = [
      note('shown'),
      note('hid', { hidden: true }),
      { id: 'f', type: 'frame', x: 0, y: 0, w: 300, h: 300, hidden: true },
      note('inside', { parent: 'f' }),
      { id: 'k', type: 'card', x: 0, y: 0, w: 100, h: 50, privateStep: 'y' },
    ];
    expect(previewSourceOf(objects, false).map((o) => o.id)).toEqual(['shown']);
  });

  it('removes who made or locked things, keeps the rest, and ignores junk', () => {
    const out = previewSourceOf([note('a', { deviceId: 'd', lockedBy: 'u2' }), null, { type: 'sticky' }] as never, false);
    expect(out).toEqual([{ id: 'a', type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: 'a' }]);
    expect(previewSourceOf(undefined as never, false)).toEqual([]);
  });

  it('is the same list for every caller: no input but the board', () => {
    const objects = [note('a'), note('p', { privateStep: 'x' })];
    expect(previewSourceOf(objects, false)).toEqual(previewSourceOf(structuredClone(objects), false));
  });
});
