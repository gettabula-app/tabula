import type { BoardRole } from './api';
import { cardContentHeight } from './markup';
import { LOCAL, type Store } from './store';
import type { BaseObj, Id } from './types';
import { LOOSE_CARD_W } from './containers';

export const CARD_HEIGHT_HEAL_ORIGIN = 'heal';
const INITIAL_CARDS = Symbol('initial-card-heights');
const MAX_CARDS_PER_FRAME = 40;

export interface CardHeightHealInput {
  storedHeight: unknown;
  measuredHeight: number;
  role: BoardRole | null;
  origin: unknown;
  locked: boolean;
  hidden: boolean;
}

/**
 * Whether an editor should replace a card's stored height with the browser-measured height. Locked cards are eligible:
 * this decision only writes derived geometry, never their content. A difference under half a pixel is rounding noise.
 */
export function needsCardHeightHeal(input: CardHeightHealInput): boolean {
  const { storedHeight, measuredHeight, role, origin, hidden } = input;
  if (hidden || !Number.isFinite(measuredHeight) || (role !== null && role !== 'owner' && role !== 'editor')) return false;
  if (origin === LOCAL || origin === CARD_HEIGHT_HEAL_ORIGIN) return false;
  return typeof storedHeight !== 'number' || !Number.isFinite(storedHeight) || Math.abs(storedHeight - measuredHeight) > 0.5;
}

interface CardHeightHealOptions {
  store: Store;
  role: () => BoardRole | null;
  busy: () => boolean;
  hidden: (card: BaseObj) => boolean;
}

/**
 * Repairs stored card heights after a remote edit or on load. The write has its own untracked origin, so it syncs without
 * adding an undo step. Height-only updates from another editor are not reconsidered; content and layout changes are.
 */
export function watchCardHeights({ store, role, busy, hidden }: CardHeightHealOptions): () => void {
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
      const card = store.get(id);
      if (card?.type !== 'card') continue;
      const changed = fields?.get(id);
      // Another editor's height-only heal is already a derived write; adopt it and discard any still-pending initial
      // measurement so unlike font metrics cannot make clients ping-pong. A real content or layout change is measured.
      if (changed?.size === 1 && changed.has('h')) {
        pending.delete(id);
        continue;
      }
      // Preserve a pending load or remote check if a local lock or other update arrives before its frame.
      if (origin === LOCAL && pending.has(id) && pending.get(id) !== LOCAL) continue;
      pending.set(id, origin);
    }
    schedule();
  };
  const offChange = store.onChange((changed, origin, fields) => enqueue(changed, origin, fields));
  const offReadOnly = store.onReadOnly((readOnly) => { if (!readOnly) schedule(); });

  for (const card of store.cache.values()) if (card.type === 'card') pending.set(card.id, INITIAL_CARDS);
  schedule();

  function run() {
    frame = null;
    if (stopped || pending.size === 0) return;
    if (store.readOnly) return;
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
      if (checked++ >= MAX_CARDS_PER_FRAME) {
        pending.set(id, origin);
        break;
      }
      const card = store.get(id);
      if (card?.type !== 'card' || hidden(card as BaseObj)) continue;
      const width = store.isLaidOut(card) ? store.geometry(card).w : (card as BaseObj).w || LOOSE_CARD_W;
      const height = cardContentHeight(card as BaseObj, width);
      if (needsCardHeightHeal({
        storedHeight: (card as BaseObj).h, measuredHeight: height, role: role(), origin,
        locked: card.locked === true, hidden: false,
      })) updates.push({ id, height });
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
