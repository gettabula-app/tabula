import type { BoardRole } from './api';
import { CARD_HEIGHT_HEAL_ORIGIN, needsCardHeightHeal } from './card-height-heal';
import { tableBoxSize } from './markup';
import { LOCAL, type Store } from './store';
import type { BaseObj, Id } from './types';

const INITIAL = Symbol('initial-table-sizes');
const MAX_PER_FRAME = 40;

interface TableSizeHealOptions {
  store: Store;
  role: () => BoardRole | null;
  busy: () => boolean;
  hidden: (o: BaseObj) => boolean;
}

/**
 * Keeps a table's stored width and height equal to what its columns and rows take (docs/tables.md): after a remote edit, after an agent (MCP) wrote a
 * table with an estimated size, and when the board opens. Same rules as the Markdown block heights (src/markdown-heal.ts, src/card-height-heal.ts): an
 * untracked origin, so it syncs without an undo step; another editor's size-only write is adopted, never re-measured, so two clients with different font
 * metrics cannot ping-pong; only owners and editors write.
 */
export function watchTableSizes({ store, role, busy, hidden }: TableSizeHealOptions): () => void {
  const pending = new Map<Id, unknown>();
  let frame: number | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped || frame !== null || pending.size === 0) return;
    frame = requestAnimationFrame(run);
  };
  const enqueue = (ids: Iterable<Id>, origin: unknown, fields?: ReadonlyMap<Id, ReadonlySet<string>>) => {
    if (origin === CARD_HEIGHT_HEAL_ORIGIN) return;
    for (const id of ids) {
      if (store.get(id)?.type !== 'table') continue;
      const changed = fields?.get(id);
      if (changed && changed.size > 0 && [...changed].every((f) => f === 'w' || f === 'h' || f === 'updatedAt')) {
        pending.delete(id);
        continue;
      }
      if (origin === LOCAL && pending.has(id) && pending.get(id) !== LOCAL) continue;
      pending.set(id, origin);
    }
    schedule();
  };
  const offChange = store.onChange((changed, origin, fields) => enqueue(changed, origin, fields));
  const offReadOnly = store.onReadOnly((readOnly) => { if (!readOnly) schedule(); });
  for (const o of store.cache.values()) if (o.type === 'table') pending.set(o.id, INITIAL);
  schedule();

  function run() {
    frame = null;
    if (stopped || pending.size === 0 || store.readOnly) return;
    if (role() !== null && role() !== 'owner' && role() !== 'editor') {
      pending.clear();
      return;
    }
    if (busy()) {
      schedule();
      return;
    }
    const updates: { id: Id; w: number; h: number }[] = [];
    let checked = 0;
    for (const [id, origin] of pending) {
      pending.delete(id);
      if (checked++ >= MAX_PER_FRAME) {
        pending.set(id, origin);
        break;
      }
      const o = store.get(id) as BaseObj | undefined;
      if (o?.type !== 'table' || hidden(o)) continue;
      const size = tableBoxSize(o);
      const common = { role: role(), origin, locked: o.locked === true, hidden: false };
      // the same rule serves both axes: it compares a stored number with a measured one
      const heal = needsCardHeightHeal({ storedHeight: o.h, measuredHeight: size.h, ...common }) || needsCardHeightHeal({ storedHeight: o.w, measuredHeight: size.w, ...common });
      if (heal) updates.push({ id, ...size });
    }
    if (updates.length) {
      store.transactAs(() => {
        for (const { id, w, h } of updates) {
          const m = store.objects.get(id);
          m?.set('w', w);
          m?.set('h', h);
        }
      }, CARD_HEIGHT_HEAL_ORIGIN);
    }
    schedule();
  }

  return () => {
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    offChange();
    offReadOnly();
  };
}
