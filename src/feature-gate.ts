import type { Store } from './store';

// Version skew (docs/kanban.md): a board can list features this client does not know. The list changes when a remote
// update, an import or a restore writes the board's meta, so the gate watches it instead of reading it once.

const unknownOf = (store: Store) => store.unsupportedFeatures().join('|');

/** Calls `onChange` whenever the features this client does not know change, and returns a function that stops it. */
export function watchFeatureGate(store: Store, onChange: () => void): () => void {
  let last = unknownOf(store);
  const observer = () => {
    const now = unknownOf(store);
    if (now === last) return;
    last = now;
    onChange();
  };
  store.meta.observe(observer);
  return () => store.meta.unobserve(observer);
}
