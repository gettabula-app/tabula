import * as Y from 'yjs';

const revisions = new Map();
const lastTextUnlinkAt = new Map();
const trailingUnlink = new Map();
const TEXT_UNLINK_INTERVAL_MS = 30_000;
let textTimestampCleanup = null;

function retainTextTimestamp(boardId, at) {
  lastTextUnlinkAt.set(boardId, at);
  if (textTimestampCleanup) return;
  textTimestampCleanup = setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, timestamp] of lastTextUnlinkAt) {
      if (timestamp < cutoff) lastTextUnlinkAt.delete(id);
    }
    if (lastTextUnlinkAt.size === 0) {
      clearInterval(textTimestampCleanup);
      textTimestampCleanup = null;
    }
  }, 10 * 60 * 1000);
  textTimestampCleanup.unref?.();
}

export function bump(boardId) {
  const next = (revisions.get(boardId) ?? 0) + 1;
  revisions.set(boardId, next);
  return next;
}

export function get(boardId) {
  return revisions.get(boardId) ?? 0;
}

/** Observe only changes that can hide or alter content in the everyone-visible preview. */
export function observePreviewChanges(doc, boardId, { unlink, now = Date.now, log = () => {} }) {
  const objects = doc.getMap('objects');
  const observer = (events) => {
    try {
      let changed = false;
      let urgent = false;
      let textChanged = false;
      for (const event of events) {
        const eventPath = Array.isArray(event.path) ? event.path : [];
        if (eventPath.length === 0) {
          for (const [, change] of event.changes?.keys ?? []) {
            if (change?.action === 'delete' || change?.action === 'update') {
              changed = true;
              urgent = true;
            }
          }
          continue;
        }

        const objectId = eventPath[0];
        if (typeof objectId !== 'string') continue;
        const keys = event.changes?.keys;
        if (!keys) continue;
        const current = objects.get(objectId);
        const field = (key) => current instanceof Y.Map ? current.get(key) : undefined;
        for (const key of keys.keys()) {
          const change = keys.get(key);
          if (key === 'privateStep' && change?.action !== 'delete' && Boolean(field('privateStep'))) {
            changed = true;
            urgent = true;
          } else if (key === 'hidden' && change?.action !== 'delete' && field('hidden') === true) {
            changed = true;
            urgent = true;
          } else if (
            ((key === 'text' || key === 'name') && ['sticky', 'text', 'shape', 'frame'].includes(field('type')))
            || (key === 'label' && field('type') === 'connector')
          ) {
            changed = true;
            textChanged = true;
          }
        }
      }
      if (!changed) return;
      bump(boardId);
      let shouldUnlink = urgent;
      if (!urgent && textChanged) {
        const currentTime = now();
        const previous = lastTextUnlinkAt.get(boardId);
        if (previous === undefined || currentTime - previous >= TEXT_UNLINK_INTERVAL_MS) {
          retainTextTimestamp(boardId, currentTime);
          shouldUnlink = true;
        } else if (!trailingUnlink.has(boardId)) {
          // a change inside the throttle window still removes the picture, once the window is over
          const timer = setTimeout(() => {
            trailingUnlink.delete(boardId);
            try { unlink(boardId); } catch { /* sync is never affected */ }
          }, Math.max(1, TEXT_UNLINK_INTERVAL_MS - (currentTime - previous)));
          timer.unref?.();
          trailingUnlink.set(boardId, timer);
        }
      }
      if (shouldUnlink) {
        clearTimeout(trailingUnlink.get(boardId));
        trailingUnlink.delete(boardId);
        unlink(boardId);
      }
    } catch {
      try { log('warn', 'previews: document observer failed'); } catch { /* logging cannot affect sync */ }
    }
  };
  objects.observeDeep(observer);
  return () => objects.unobserveDeep(observer);
}
