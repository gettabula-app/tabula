import type { BoardRole } from './api';
import { CARD_HEIGHT_HEAL_ORIGIN, needsCardHeightHeal } from './card-height-heal';
import { markdownBoxHeight } from './markup';
import { LOCAL, type Store } from './store';
import type { BaseObj, Id } from './types';

const INITIAL = Symbol('initial-markdown-heights');
const MAX_PER_FRAME = 40;

interface MarkdownHeightHealOptions {
  store: Store;
  role: () => BoardRole | null;
  busy: () => boolean;
  hidden: (o: BaseObj) => boolean;
}

/**
 * Keeps a Markdown block's stored height equal to its rendered content (docs/markdown-blocks.md): after a remote edit, after an agent (MCP) wrote a
 * block with an estimated height, and when the board opens. Same rules as the card heights (src/card-height-heal.ts): an untracked origin, so it syncs
 * without an undo step; another editor's height-only write is adopted, never re-measured, so two clients with different font metrics cannot ping-pong;
 * only owners and editors write. A person's own resize is not touched: it is a local origin.
 */
export function watchMarkdownHeights({ store, role, busy, hidden }: MarkdownHeightHealOptions): () => void {
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
      if (store.get(id)?.type !== 'markdown') continue;
      const changed = fields?.get(id);
      if (changed?.size === 1 && changed.has('h')) {
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
  for (const o of store.cache.values()) if (o.type === 'markdown') pending.set(o.id, INITIAL);
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
    const updates: { id: Id; height: number }[] = [];
    let checked = 0;
    for (const [id, origin] of pending) {
      pending.delete(id);
      if (checked++ >= MAX_PER_FRAME) {
        pending.set(id, origin);
        break;
      }
      const o = store.get(id) as BaseObj | undefined;
      if (o?.type !== 'markdown' || hidden(o)) continue;
      const height = markdownBoxHeight(o);
      if (needsCardHeightHeal({ storedHeight: o.h, measuredHeight: height, role: role(), origin, locked: o.locked === true, hidden: false })) updates.push({ id, height });
    }
    if (updates.length) {
      store.transactAs(() => {
        for (const { id, height } of updates) store.objects.get(id)?.set('h', height);
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
