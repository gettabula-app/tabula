// Compact, text-free diffs of two Yjs board states for MCP version history.
import * as Y from 'yjs';
import { readAll } from './board-ops.mjs';

function snapshot(update) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const state = readAll(doc);
    return { doc, ...state };
  } catch (err) {
    doc.destroy();
    throw err;
  }
}

const objectMap = (state, withheld) => new Map(
  [...state.boxes, ...state.connectors]
    .filter((object) => !withheld.has(object.id)
      && !(object.type === 'connector' && [object.from, object.to].some((end) => end?.kind === 'bound' && withheld.has(end.id))))
    .map((object) => [object.id, object]),
);

const fieldChanged = (before, after, key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]);

/**
 * Compare two encoded Yjs states. Output contains ids, types and changed field names only.
 * The temporary documents are always destroyed, including when a state cannot be decoded.
 */
export function diffBoardUpdates(beforeUpdate, afterUpdate) {
  const before = snapshot(beforeUpdate);
  let after;
  try {
    after = snapshot(afterUpdate);
    const withheld = new Set([...before.withheld, ...after.withheld]);
    const oldObjects = objectMap(before, withheld);
    const newObjects = objectMap(after, withheld);
    const added = [];
    const removed = [];
    const changed = [];

    for (const [id, object] of newObjects) {
      const prior = oldObjects.get(id);
      if (!prior) {
        added.push({ id, type: object.type });
        continue;
      }
      const fields = [...new Set([...Object.keys(prior), ...Object.keys(object)])]
        .filter((key) => key !== 'id' && fieldChanged(prior, object, key))
        .sort();
      if (fields.length) changed.push({ id, type: object.type, fields });
    }
    for (const [id, object] of oldObjects) {
      if (!newObjects.has(id)) removed.push({ id, type: object.type });
    }

    const byId = (a, b) => a.id.localeCompare(b.id);
    added.sort(byId);
    removed.sort(byId);
    changed.sort(byId);
    return { added, removed, changed };
  } finally {
    before.doc.destroy();
    after?.doc.destroy();
  }
}
