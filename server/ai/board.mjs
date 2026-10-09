// What a run sends to the provider: a scoped, capped and fenced read of the board (docs/ai.md, "Running a feature").
// It reads through the same function as the MCP tools (readAll in board-ops.mjs), so private notes that are still
// withheld are not here, and it uses the same summaries, which carry no author and no comment. This module touches no room:
// the caller hands over a document inside roomAccess.read.

import { boardTitle, cleanForModel, fence, hiddenOf, readAll, summarise } from '../board-ops.mjs';

export const READ_LIMITS = Object.freeze({
  /** Boxes and connectors sent in one run. */
  objects: 400,
  /** Characters of text (text, names and labels) sent in one run. */
  chars: 60_000,
  /** Characters of one object's text; more is cut and counts as cut. */
  objectText: 1000,
});

const isRect = (o) => [o.x, o.y, o.w, o.h].every(Number.isFinite);
const centreOf = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

function boundsCentre(boxes) {
  const rects = boxes.filter(isRect);
  if (!rects.length) return { x: 0, y: 0 };
  const x0 = Math.min(...rects.map((o) => o.x));
  const y0 = Math.min(...rects.map((o) => o.y));
  const x1 = Math.max(...rects.map((o) => o.x + o.w));
  const y1 = Math.max(...rects.map((o) => o.y + o.h));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

const textLength = (s) => [s.text, s.name, s.label].reduce((n, t) => n + (typeof t === 'string' ? t.length : 0), 0);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The part of the board a run works on, nearest the selection, the frame or the middle of the board first, trimmed to
 * the caps. `selection` is a list of object ids (ids that are missing or withheld are left out), `frameId` the direct
 * children of that frame; give at most one. `onlyStickies` keeps nothing but stickies (the cluster feature).
 * @param {any} doc
 * @param {{ selection?: string[] | null, frameId?: string | null, onlyStickies?: boolean, maxObjects?: number, maxChars?: number }} [options]
 * @returns {{ frameMissing: true } | { scope: 'selection' | 'frame' | 'board', frame: { id: string, name: string } | null, items: any[], stickyIds: string[], inScope: number, sent: number, chars: number, cut: boolean }}
 */
export function readForAi(doc, { selection = null, frameId = null, onlyStickies = false, maxObjects = READ_LIMITS.objects, maxChars = READ_LIMITS.chars } = {}) {
  const all = readAll(doc);
  // what the board hides from everyone (TAB-198) is not sent, as it is not drawn
  const hidden = hiddenOf(all);
  const boxes = all.boxes.filter((o) => !hidden.has(o.id));
  const connectors = all.connectors.filter((c) => !hidden.has(c.id));
  let scope = 'board';
  let frame = null;
  let candidates = boxes;
  let centre;

  if (selection) {
    scope = 'selection';
    const wanted = new Set(selection);
    candidates = boxes.filter((o) => wanted.has(o.id));
  } else if (frameId) {
    const found = boxes.find((o) => o.id === frameId);
    if (!found || found.type !== 'frame') return { frameMissing: true };
    scope = 'frame';
    frame = { id: found.id, name: cleanForModel(found.name, 200).text };
    candidates = boxes.filter((o) => o.parent === frameId);
    centre = isRect(found) ? centreOf(found) : undefined;
  }
  if (onlyStickies) candidates = candidates.filter((o) => o.type === 'sticky');
  centre ??= boundsCentre(scope === 'board' ? boxes : candidates);

  const distance = (o) => (isRect(o) ? Math.hypot(centreOf(o).x - centre.x, centreOf(o).y - centre.y) : Infinity);
  const ranked = candidates.map((o) => ({ o, d: distance(o) })).sort((a, b) => (a.d === b.d ? byId(a.o, b.o) : a.d < b.d ? -1 : 1));

  const items = [];
  const sent = new Set();
  let chars = 0;
  let cut = false;
  const room = (summary) => {
    if (items.length >= maxObjects || chars + textLength(summary) > maxChars) return false;
    chars += textLength(summary);
    items.push(summary);
    return true;
  };

  for (const { o } of ranked) {
    const summary = summarise(o, READ_LIMITS.objectText);
    if (!room(summary)) {
      cut = true;
      break;
    }
    if (summary.textTruncated) cut = true;
    sent.add(o.id);
  }

  if (!onlyStickies) {
    // a connector goes along when everything it is attached to went along
    for (const c of connectors.slice().sort(byId)) {
      const ends = [c.from, c.to].filter((e) => e?.kind === 'bound');
      if (!ends.every((e) => sent.has(e.id)) || (ends.length === 0 && scope !== 'board')) continue;
      const summary = summarise(c, READ_LIMITS.objectText);
      if (!room(summary)) {
        cut = true;
        break;
      }
      if (summary.labelTruncated) cut = true;
    }
  }

  return {
    scope,
    frame,
    items,
    stickyIds: ranked.filter(({ o }) => sent.has(o.id) && o.type === 'sticky').map(({ o }) => o.id),
    inScope: candidates.length,
    sent: sent.size,
    chars,
    cut,
  };
}

/**
 * The read as one fenced block (a fixed note, nonce markers, escaped JSON), exactly as the MCP tools fence board text.
 * @param {any} read @param {any} doc @param {string | null} [title] the directory's title; the document's own name when absent
 */
export function fenceRead(read, doc, title = null) {
  return fence({
    board: { title: cleanForModel(title ?? boardTitle(doc), 200).text },
    scope: read.scope,
    ...(read.frame ? { frame: read.frame } : {}),
    cut: read.cut,
    objects: read.items,
  });
}
