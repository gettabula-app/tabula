import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Flow } from '../src/flow';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';

describe('grouped frame contents in the Markdown summary', () => {
  it('places nested group members under their ancestor frame once', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'frame', type: 'frame', x: 0, y: 0, w: 500, h: 400, rotation: 0, z: 'a0', name: 'Sprint' } as BaseObj);
      store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1', parent: 'frame' });
      store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'outer' });
      store.create({ id: 'member', type: 'sticky', x: 40, y: 60, w: 100, h: 100, rotation: 0, z: 'a1', parent: 'inner', text: 'Nested note' });
    });
    const app = {
      store,
      user: { id: 'me', name: 'Me', color: '#000' },
      r: { invalidateAll() {}, setOverlay() {} },
      emit() {},
      participants: () => [],
    };
    const markdown = new Flow(app as never).summaryMarkdown();

    expect(markdown).toContain('## Sprint\n\n- Nested note');
    expect(markdown.match(/Nested note/g)).toHaveLength(1);
  });
});
