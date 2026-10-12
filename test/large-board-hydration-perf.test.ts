import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';

const addObject = (objects: Y.Map<Y.Map<unknown>>, id: string, fields: Record<string, unknown>) => {
  const object = new Y.Map<unknown>();
  object.set('id', id);
  for (const [key, value] of Object.entries(fields)) object.set(key, value);
  objects.set(id, object);
};

describe('large-board initial hydration work', () => {
  it('hydrates and indexes the 2,000-object scenario in one object pass', () => {
    const doc = new Y.Doc();
    const objects = doc.getMap<Y.Map<unknown>>('objects');
    doc.transact(() => {
      for (let i = 0; i < 1_990; i++) {
        const parent = i < 20 ? 'group' : undefined;
        addObject(objects, `object-${i}`, {
          type: i === 0 ? 'group' : 'sticky', x: i, y: 0, w: 100, h: 80,
          rotation: 0, z: `z${i}`, ...(parent ? { parent } : {}),
        });
      }
      for (let i = 0; i < 10; i++) {
        addObject(objects, `connector-${i}`, {
          type: 'connector', z: `c${i}`, route: 'straight', startHead: 'none', endHead: 'arrow',
          from: { kind: 'bound', id: `object-${i}`, anchor: 'auto' },
          to: { kind: 'free', x: i, y: i },
        });
      }
    });

    let materializations = 0;
    objects.forEach((object) => {
      const toJSON = object.toJSON.bind(object);
      object.toJSON = () => { materializations++; return toJSON(); };
    });
    const store = new Store(doc);

    // The previous implementation made 6,000 object visits: one to materialize, then
    // one each to build the bound and child indexes. Hydration now performs 2,000.
    expect(materializations).toBe(2_000);
    expect(store.cache.size).toBe(2_000);
    expect(store.childrenOf('group').map((object) => object.id)).toHaveLength(20);
    expect(store.connectorsOf('object-1').map((connector) => connector.id)).toEqual(['connector-1']);
  });
});
