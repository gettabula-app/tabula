// DEV STAND-IN, not shipped. The production "everyone's view" of a board (what a stored picture of it may show to people who are not
// in the room) is owned by the tech lead. This module only has the same shape: board objects in, the objects everyone may see out.
// Used by the dev previews on the Boards cards (src/preview-render.ts, src/ui/dev-board-preview-sync.ts).
//
// What is NOT an object, so nothing here has to drop it: comments (the `~comments` room), cursors and presence (awareness), votes,
// polls and poll answers (their own maps), and the chat. Only the board's objects are passed in.
// There is no "personal" flag on an object in src/types.ts. `locked` and `proposedBy` say nothing about who may see an object.
import { isConnector, type BaseObj, type Obj } from './types';

/** The flow state the rule reads: a reveal ends the private writing of a step, and every private note then shows (src/flow.ts isHidden). */
export interface PreviewFlow {
  reveal: boolean;
}

/**
 * The objects everyone may see, in their order. Pure: the input is not changed.
 * Left out: an object with `hidden` set (hidden for everyone, src/types.ts), anything inside a hidden frame, container or group
 * (the parent chain), a private note (`privateStep`, a note written in a private step) until the flow is revealed, and a connector
 * with a bound end that was left out (a line must not point at nothing, as src/store.ts isShown does).
 */
export function previewSourceObjects(objects: readonly Obj[], flow: PreviewFlow = { reveal: false }): Obj[] {
  const byId = new Map(objects.map((o) => [o.id, o]));

  // An object on its own: not hidden and not a private note still hidden from everyone.
  const ownVisible = (o: Obj): boolean => {
    if (o.hidden === true) return false;
    if (!flow.reveal && (o as BaseObj).privateStep) return false;
    return true;
  };

  // Its parent chain as well. A malformed cycle ends where it repeats, as the store's own walk does.
  const chainVisible = (o: Obj): boolean => {
    const seen = new Set<string>([o.id]);
    for (let p = o.parent ? byId.get(o.parent) : undefined; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
      if (!ownVisible(p)) return false;
      seen.add(p.id);
    }
    return true;
  };

  const kept = new Set<string>();
  for (const o of objects) if (ownVisible(o) && chainVisible(o)) kept.add(o.id);

  // A connector is drawn only while its bound ends are drawn (a bound end that is not an object of this board is not checked, as in isShown).
  for (const o of objects) {
    if (!isConnector(o) || !kept.has(o.id)) continue;
    for (const end of [o.from, o.to]) {
      if (end.kind !== 'bound') continue;
      const at = byId.get(end.id);
      if (at && !isConnector(at) && !kept.has(at.id)) {
        kept.delete(o.id);
        break;
      }
    }
  }

  return objects.filter((o) => kept.has(o.id));
}
