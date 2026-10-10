// What a person may select, copy and export while private writing hides other people's notes from them (TAB-207, TAB-139).
// A note hidden by a private-writing step is drawn face down and its words are never shown to anyone but its author until the
// reveal. Every way a selection becomes something (a delete, a copy, a duplicate, a template, an export, the AI's context)
// starts from what is selectable, so the one rule lives here: **a hidden note is never selected, gathered or exported.** It is
// a display and consent rule, not a security boundary (the board's document still holds the note), like the summary of TAB-139.

import * as Y from 'yjs';
import { isConnector, type BaseObj, type Id, type Obj } from './types';
import type { Store } from './store';
import { copyPlan } from './groups';

/** The part of Flow that decides whether private writing hides a note from this person. */
export interface Hiding {
  isHidden(o: BaseObj): boolean;
}

/** True when private writing hides this object from this person (only stickies of a private step can be). */
export const isWithheld = (o: Obj | undefined, hiding: Hiding): boolean => !!o && hiding.isHidden(o as BaseObj);

/** A connector with an end on a note private writing hides: it would name that note. */
const namesWithheld = (store: Store, hiding: Hiding, o: Obj): boolean =>
  isConnector(o) && [o.from, o.to].some((e) => e.kind === 'bound' && isWithheld(store.get(e.id), hiding));

/**
 * The ids a person may have selected: each exists, is not hidden with the Layers panel's eye, and is not a note that
 * private writing hides from them. Order is kept, repeats go.
 */
export function selectableIds(store: Store, hiding: Hiding, ids: Iterable<Id>): Id[] {
  const out: Id[] = [];
  const seen = new Set<Id>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const o = store.get(id);
    if (o && store.isShown(o) && !isWithheld(o, hiding) && !namesWithheld(store, hiding, o)) out.push(id);
  }
  return out;
}

/**
 * Selected objects plus what travels with them, as a portable list for copy, duplicate, a template or a file: the children of
 * a selected frame, and the connectors with both ends in the set. A note that private writing hides is left out wherever it is
 * (selected, inside a frame), so a copy never holds words the person may not see and a duplicate never makes someone else's
 * hidden note into one of theirs.
 */
export function gatherObjects(store: Store, hiding: Hiding, ids: readonly Id[]): Obj[] {
  const open = (o: Obj | undefined): o is Obj => !!o && !isWithheld(o, hiding) && !namesWithheld(store, hiding, o);
  const set = new Set<Id>(ids.filter((id) => open(store.get(id))));
  const stack = [...set];
  while (stack.length) {
    const id = stack.pop()!;
    // Frames and groups carry their subtrees; a kanban carries its lanes and their cards (docs/kanban.md).
    const type = store.get(id)?.type;
    if (type !== 'frame' && type !== 'group' && type !== 'container' && type !== 'lane') continue;
    for (const c of store.childrenOf(id)) {
      if (set.has(c.id) || !open(c)) continue;
      set.add(c.id);
      stack.push(c.id);
    }
  }
  for (const o of store.cache.values()) {
    if (!isConnector(o) || set.has(o.id)) continue;
    const fromIn = o.from.kind === 'bound' && set.has(o.from.id);
    const toIn = o.to.kind === 'bound' && set.has(o.to.id);
    if (fromIn && toIn) set.add(o.id);
  }
  return store.ordered().filter((o) => set.has(o.id)).map((o) => structuredClone(o));
}

/** The clipboard view of a gathered selection: expand groups and omit connectors with a bound end outside the copy. */
export function gatherCopyObjects(store: Store, hiding: Hiding, ids: readonly Id[]): Obj[] {
  const objects = gatherObjects(store, hiding, ids);
  const copyIds = new Set(copyPlan(objects.map((o) => o.id), (id) => store.get(id), (id) => store.childrenOf(id), objects));
  return objects.filter((o) => copyIds.has(o.id));
}

/** `objs` without the notes private writing hides, and without connectors bound to one (they would name it). */
export function leaveOutWithheld<T extends Obj>(objs: readonly T[], hiding: Hiding): T[] {
  const gone = new Set(objs.filter((o) => isWithheld(o, hiding)).map((o) => o.id));
  return objs.filter((o) => {
    if (gone.has(o.id)) return false;
    return !(isConnector(o) && ((o.from.kind === 'bound' && gone.has(o.from.id)) || (o.to.kind === 'bound' && gone.has(o.to.id))));
  });
}

/**
 * The board's document as a file should have it: the same state without the notes that are hidden from this person, so a
 * `.drift` they hand on does not carry other people's unrevealed words. Returns the state of `doc` itself when nothing is hidden.
 */
export function updateWithoutWithheld(doc: Y.Doc, withheld: readonly Id[]): Uint8Array {
  if (withheld.length === 0) return Y.encodeStateAsUpdate(doc);
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const objects = copy.getMap('objects');
    copy.transact(() => {
      for (const id of withheld) objects.delete(id);
    });
    return Y.encodeStateAsUpdate(copy);
  } finally {
    copy.destroy();
  }
}
