import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Flow } from '../src/flow';
import type { BaseObj } from '../src/types';
import { gatherObjects, isWithheld, leaveOutWithheld, selectableIds, updateWithoutWithheld } from '../src/private-select';

function person(doc: Y.Doc, userId: string) {
  const store = new Store(doc);
  const app = {
    store,
    user: { id: userId, name: userId, color: '#000' },
    r: { invalidateAll() {}, setOverlay() {}, flyTo() {}, flyToCenter() {}, viewport: () => ({ x: 0, y: 0, w: 100, h: 100 }) },
    zoom: 1,
    emit() {},
    participants: () => [],
  };
  return { store, flow: new Flow(app as never) };
}
const note = (id: string, extra: Record<string, unknown> = {}): BaseObj =>
  ({ id, type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', text: id, ...extra }) as BaseObj;
const line = (id: string, from: string, to: string): BaseObj =>
  ({ id, type: 'connector', x: 0, y: 0, rotation: 0, z: 'a1', from: { kind: 'bound', id: from }, to: { kind: 'bound', id: to } }) as unknown as BaseObj;

/** Ana wrote a private note and a public one; Ben looks at the same board during the private step. */
function setup() {
  const doc = new Y.Doc();
  const ana = person(doc, 'ana');
  const ben = person(doc, 'ben');
  ana.store.transact(() => {
    ana.store.create({ id: 'f', type: 'frame', x: 0, y: 0, w: 800, h: 600, rotation: 0, z: 'a0', name: 'F' } as BaseObj);
    ana.store.create(note('secret', { privateStep: 's', createdBy: 'ana', parent: 'f' }));
    ana.store.create(note('open', { parent: 'f' }));
    ana.store.create(note('bens', { privateStep: 's', createdBy: 'ben' }));
    ana.store.create(line('c1', 'secret', 'open'));
    ana.store.create(line('c2', 'open', 'bens'));
  });
  return { doc, ana, ben };
}
const all = ['f', 'secret', 'open', 'bens', 'c1', 'c2'];

describe('private writing: the selection source (TAB-207)', () => {
  it('never selects a note hidden for this person, but still their own', () => {
    const { ana, ben } = setup();
    expect(isWithheld(ana.store.get('secret')!, ana.flow)).toBe(false);
    expect(isWithheld(ben.store.get('secret')!, ben.flow)).toBe(true);
    expect(selectableIds(ben.store, ben.flow, all)).toEqual(['f', 'open', 'bens', 'c2']);
    expect(selectableIds(ana.store, ana.flow, all)).toEqual(['f', 'secret', 'open', 'c1']);
  });

  it('gathers (copy, duplicate, templates, align, AI) without hidden notes or lines bound to them', () => {
    const { ben } = setup();
    const got = gatherObjects(ben.store, ben.flow, all).map((o) => o.id);
    expect(got).not.toContain('secret');
    expect(got).not.toContain('c1');
    expect(got).toContain('open');
    expect(got).toContain('bens');
    // a selected frame does not carry the hidden note inside it
    expect(gatherObjects(ben.store, ben.flow, ['f']).map((o) => o.id)).toEqual(['f', 'open']);
  });

  it('leaves hidden notes and their lines out of exports', () => {
    const { ben } = setup();
    const kept = leaveOutWithheld([...ben.store.cache.values()], ben.flow).map((o) => o.id).sort();
    expect(kept).toEqual(['bens', 'c2', 'f', 'open']);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, updateWithoutWithheld(ben.store.doc, ['secret']));
    expect(new Store(doc).get('secret')).toBeUndefined();
    expect(new Store(doc).get('open')).toBeDefined();
  });

  it('shows the note to everyone after the reveal', () => {
    const { ana, ben } = setup();
    ben.flow.reveal();
    expect(selectableIds(ben.store, ben.flow, all)).toContain('secret');
    expect(gatherObjects(ben.store, ben.flow, ['secret']).map((o) => o.id)).toEqual(['secret']);
    expect(ana.store.get('secret')).toBeDefined();
  });
});
