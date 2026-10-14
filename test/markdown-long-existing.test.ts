import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { shouldReject, validateBoardObject } from '../server/sync-validate.mjs';
import { toJson } from '../src/exporters';
import { objectMarkup } from '../src/markup';
import { safeObj } from '../src/safe-obj';
import { Store } from '../src/store';
import type { BoardApp } from '../src/app';
import type { Obj } from '../src/types';

// v5.4 lowered the Markdown block cap from 20,000 to 8,000 characters. Blocks saved earlier with 8,000 to 20,000 characters must keep every
// character on load, sync, export and drawing: only NEW typing is capped, and the validator's text cap is report-only.
const LONG = `${'word '.repeat(2800)}THE-VERY-END`; // about 14,000 characters
const block = (over: Record<string, unknown> = {}) => ({ id: 'md1', type: 'markdown', x: 0, y: 0, w: 360, h: 200, rotation: 0, z: 'a0', createdBy: 'u1', text: LONG, ...over });
const ctx = { writer: { id: 'u1', name: 'Lea', color: '#3366FF' }, isBoardMember: () => true, canEditObject: () => true };

describe('an existing Markdown block between 8,000 and 20,000 characters', () => {
  it('is long enough to matter', () => {
    expect(LONG.length).toBeGreaterThan(8000);
    expect(LONG.length).toBeLessThan(20_000);
  });

  it('syncs: editing another field of it is accepted, and the text itself is only a report-only violation, never a refusal', () => {
    expect(validateBoardObject('md1', block({ x: 40 }), ctx, { fields: ['x'] })).toEqual({ ok: true });
    const edited = validateBoardObject('md1', block(), ctx, { fields: ['text'] });
    expect(edited).toMatchObject({ ok: false, violations: [{ code: 'too_long', path: 'text', reportOnly: true }] });
    expect(shouldReject('report', edited)).toBe(false);
    expect(shouldReject('enforce', edited)).toBe(false); // text caps stay report-only (ENFORCE_TEXT_CAPS)
  });

  it('loads: the read path keeps every character', () => {
    expect((safeObj(block() as unknown as Obj) as unknown as { text: string }).text).toBe(LONG);
  });

  it('exports: the JSON export carries the whole text', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => { store.create(block() as unknown as Obj); });
    const app = {
      store,
      conn: { comments: { list: () => [] } },
      flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [], answers: [] }) } },
      images: { blobOf: async () => null },
      r: { contentBounds: () => ({ x: 0, y: 0, w: 400, h: 400 }), ctx: { get: (id: string) => store.getPlaced(id) } },
    } as unknown as BoardApp;
    const json = toJson(app, undefined, []);
    expect((json.objects.find((o) => o.id === 'md1') as unknown as { text: string }).text).toBe(LONG);
  });

  it('draws: the layout does not stop at 8,000 characters', () => {
    const svg = objectMarkup(block() as unknown as Obj, { get: () => undefined } as never);
    expect(svg).toContain('THE-VERY-END');
  });
});
