import { describe, expect, it } from 'vitest';
import { previewSourceOf } from '../server/board-ops.mjs';

const note = (id: string, extra: object = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: id, createdBy: 'u1', ...extra });
const ids = (list: unknown[]) => list.map((o) => (o as { id: string }).id);

describe('previewSourceOf: the everyone\'s view of a board', () => {
  it('drops unrevealed private notes whoever wrote them, and connectors bound to them; revealed shows them', () => {
    const objects = [
      note('a'),
      note('p', { privateStep: 'x', createdBy: 'uploader' }),
      { id: 'c1', type: 'connector', from: { kind: 'bound', id: 'a' }, to: { kind: 'bound', id: 'p' } },
      { id: 'c2', type: 'connector', from: { kind: 'bound', id: 'a' }, to: { kind: 'point', x: 1, y: 1 } },
    ];
    expect(ids(previewSourceOf(objects, false))).toEqual(['a', 'c2']);
    expect(ids(previewSourceOf(objects, true))).toEqual(['a', 'p', 'c1', 'c2']);
  });

  it('drops a private note inside a frame and the connector bound to it', () => {
    const objects = [
      { id: 'f', type: 'frame', x: 0, y: 0, w: 400, h: 400, name: 'Plan' },
      note('inner', { parent: 'f', privateStep: 'x' }),
      note('open', { parent: 'f' }),
      { id: 'c', type: 'connector', from: { kind: 'bound', id: 'inner' }, to: { kind: 'bound', id: 'open' } },
    ];
    expect(ids(previewSourceOf(objects, false))).toEqual(['f', 'open']);
  });

  it('drops hidden objects, the children of a hidden frame, private cards, and connectors bound to a private card', () => {
    const objects = [
      note('shown'),
      note('hid', { hidden: true }),
      { id: 'f', type: 'frame', x: 0, y: 0, w: 300, h: 300, hidden: true },
      note('inside', { parent: 'f' }),
      { id: 'k', type: 'card', x: 0, y: 0, w: 100, h: 50, privateStep: 'y' },
      { id: 'ck', type: 'connector', from: { kind: 'bound', id: 'shown' }, to: { kind: 'bound', id: 'k' } },
      { id: 'ch', type: 'connector', from: { kind: 'bound', id: 'shown' }, to: { kind: 'bound', id: 'hid' } },
    ];
    expect(ids(previewSourceOf(objects, false))).toEqual(['shown']);
  });

  it('copies drawing fields only: no author, ticket, owner or vote data, even from a field added later', () => {
    const card = { id: 'k', type: 'card', x: 1, y: 2, w: 3, h: 4, z: 'a', text: 'TAB-1 secret ticket', ownerName: 'Anna', ownerId: 'u9', tracker: { title: 'secret' }, ext: { x: 1 }, checklist: [{ id: 'i', text: 's', done: false }], futureField: 'x' };
    const sticky = note('a', { deviceId: 'd', lockedBy: 'u2', fill: '#fff', proposedBy: { by: { name: 'Bot' } }, votes: ['u1'] });
    const [c, s] = previewSourceOf([card, sticky], false) as Record<string, unknown>[];
    expect(c).toEqual({ id: 'k', type: 'card', x: 1, y: 2, w: 3, h: 4, z: 'a' });
    expect(s).toEqual({ id: 'a', type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: 'a', fill: '#fff' });
  });

  it('sends an image as its asset reference only', () => {
    const [img] = previewSourceOf([{ id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, asset: 'ast_1', mime: 'image/png', alt: 'who', url: 'https://x' }], false) as Record<string, unknown>[];
    expect(img).toEqual({ id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, asset: 'ast_1', mime: 'image/png' });
  });

  it('ignores junk and is the same list for every caller', () => {
    expect(previewSourceOf([null, { type: 'sticky' }] as never, false)).toEqual([]);
    expect(previewSourceOf(undefined as never, false)).toEqual([]);
    const objects = [note('a'), note('p', { privateStep: 'x' })];
    expect(previewSourceOf(objects, false)).toEqual(previewSourceOf(structuredClone(objects), false));
  });
});
