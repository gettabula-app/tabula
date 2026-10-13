// The board activity log (TAB-158, docs/agent-presence.md): one entry per MCP tool call that changed a board, read by the Activity panel, with what is needed
// to take that call back. The log holds object ids, counts and a one-line summary; never text a person wrote. The data to revert a call (the states of the
// objects before and after) stays on the server and is never sent to a client. The log is bounded: 200 entries or 7 days a board, 256 KiB of revert data
// an entry (a bigger call is logged and cannot be reverted), 4 MiB a board file, and the revert data itself is kept 48 hours (the summary line 7 days).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { validateBoardObject } from './sync-validate.mjs';

export const MAX_ENTRIES = 200;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REVERT_BYTES = 256 * 1024;
/** The revert data is a short-term undo: older entries keep their line but not the data. */
export const INVERSE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** A board with more objects than this is logged without revert data: the capture would cost too much on the shared event loop. */
export const CAPTURE_MAX_OBJECTS = 1500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_BOARDS = 32;
const SAVE_DELAY_MS = 300;
const MAX_IDS = 50;
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Fields that change on every write and say nothing about what was done. */
const NOISE = new Set(['updatedAt']);
/**
 * Fields only the tracker guard may set (docs/tracker, TAB-203): a revert never writes one, in either direction, and leaves an object that has one or is a
 * tracker frame to the tracker's own rules.
 */
const TRACKER_KEYS = new Set(['ext', 'extProvider', 'extKey', 'extUrl', 'trackerId', 'tracker', 'trackerUnmappedState', 'viewId', 'focusKey']);
const trackerOwned = (o) => !!o && (o.type === 'tracker' || Object.keys(o).some((k) => TRACKER_KEYS.has(k)));
const touchesTracker = (...fieldMaps) => fieldMaps.some((m) => Object.keys(m ?? {}).some((k) => TRACKER_KEYS.has(k)));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The plain value of every object of a board document, by id. */
export function snapshotObjects(doc) {
  const out = new Map();
  doc.getMap('objects').forEach((value, id) => {
    if (value instanceof Y.Map) out.set(id, value.toJSON());
  });
  return out;
}

/** What changed between two snapshots: `{ id: { before: object | null, after: object | null } }`, only for objects that really differ. */
export function diffObjects(before, after) {
  const out = {};
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) out[id] = { before: b, after: null };
    else if (!sameIgnoringNoise(b, a)) out[id] = { before: b, after: a };
  }
  for (const [id, a] of after) if (!before.has(id)) out[id] = { before: null, after: a };
  return out;
}

function sameIgnoringNoise(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!NOISE.has(k) && !same(a[k], b[k])) return false;
  return true;
}

/** Several diffs of one tool call, in order, as one: the first before and the last after of each object; an object made and removed in the call is not in it. */
export function composeDiffs(diffs) {
  // a board too large to capture (see CAPTURE_MAX_OBJECTS): only the ids that were touched are known
  if (diffs.some((d) => d.tooLarge === true)) return { tooLarge: true, touched: [...new Set(diffs.flatMap((d) => d.touched ?? Object.keys(d)))] };
  const out = {};
  for (const diff of diffs) {
    for (const [id, step] of Object.entries(diff)) {
      if (!Object.hasOwn(out, id)) out[id] = { before: step.before, after: step.after };
      else out[id].after = step.after;
    }
  }
  for (const id of Object.keys(out)) {
    const { before, after } = out[id];
    if ((before === null && after === null) || (before && after && sameIgnoringNoise(before, after))) delete out[id];
  }
  return out;
}

/** The ids of the board objects a document transaction touches, until `off()`: what is known of a write on a board too large to snapshot. */
export function watchTouched(doc, into) {
  const objects = doc.getMap('objects');
  const handler = (transaction) => {
    for (const [type, keys] of transaction.changed) {
      if (type === objects) {
        for (const k of keys) if (typeof k === 'string') into.add(k);
      } else if (type._item?.parent === objects && typeof type._item.parentSub === 'string') into.add(type._item.parentSub);
    }
  };
  doc.on('afterTransaction', handler);
  return () => doc.off('afterTransaction', handler);
}

/** Where on the board a call worked: the middle of the box around the objects it made, changed or removed; null when that is not known (a board too large to capture). */
export function diffCenter(diff) {
  if (!diff || diff.tooLarge) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { before, after } of Object.values(diff)) {
    const o = after ?? before;
    if (![o?.x, o?.y, o?.w, o?.h].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h);
  }
  return x1 >= x0 ? { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) } : null;
}

const NOUN = {
  sticky: ['sticky note', 'sticky notes'], shape: ['shape', 'shapes'], text: ['text', 'texts'], markdown: ['Markdown block', 'Markdown blocks'],
  table: ['table', 'tables'], frame: ['frame', 'frames'], connector: ['connector', 'connectors'], link: ['link card', 'link cards'],
  card: ['kanban card', 'kanban cards'], lane: ['lane', 'lanes'], container: ['kanban', 'kanbans'], group: ['group', 'groups'], image: ['image', 'images'],
  icon: ['icon', 'icons'], path: ['drawing', 'drawings'],
};
const noun = (type, n) => (NOUN[type] ?? ['object', 'objects'])[n === 1 ? 0 : 1];

function countsBy(types) {
  const by = new Map();
  for (const t of types) by.set(t, (by.get(t) ?? 0) + 1);
  return [...by].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t, n]) => `${n} ${noun(t, n)}`).join(', ') + (by.size > 3 ? ' and more' : '');
}

/** One line for the log: what was done, by kind and count, with no content: "created 6 sticky notes; changed 2 frames". */
export function summarise(diff) {
  const made = [], changed = [], gone = [];
  for (const { before, after } of Object.values(diff)) {
    if (!before) made.push(after.type);
    else if (!after) gone.push(before.type);
    else changed.push(after.type);
  }
  const parts = [];
  if (made.length) parts.push(`created ${countsBy(made)}`);
  if (changed.length) parts.push(`changed ${countsBy(changed)}`);
  if (gone.length) parts.push(`removed ${countsBy(gone)}`);
  return parts.join('; ') || 'made no change';
}

const clean = (v, max) => [...String(v ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim()].slice(0, max).join('');

/**
 * Who an agent is, as two fields that are never joined into one string a person could forge: the token's name (written by the member who made the token, so
 * shown as quoted, secondary text) and the member's own first name (from the directory). A client shows "Claude for Ada" with the token styled apart.
 */
export function agentParts({ tokenName, userName }) {
  const token = clean(tokenName, 40) || 'Agent';
  const first = clean(userName, 80).split(' ')[0] ?? '';
  return { token, member: first ? [...first].slice(0, 40).join('') : null };
}

/** The same two fields as one line, for a place that cannot style them (a screen reader line, the audit text). */
export const agentLabel = (who) => {
  const { token, member } = agentParts(who);
  return member ? `${token} for ${member}` : token;
};

/** The data to take a call back: objects it made (their state after), objects it removed (before), and the fields it changed (before and after). */
function inverseOf(diff) {
  const created = {}, removed = {}, changed = {};
  for (const [id, { before, after }] of Object.entries(diff)) {
    if (!before) created[id] = after;
    else if (!after) removed[id] = before;
    else {
      const b = {}, a = {};
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (NOISE.has(k) || same(before[k], after[k])) continue;
        if (Object.hasOwn(before, k)) b[k] = before[k];
        if (Object.hasOwn(after, k)) a[k] = after[k];
      }
      changed[id] = { b, a };
    }
  }
  return { created, removed, changed };
}

/** What the validator needs to judge an object the log restores: its values come from the document itself, so who made them is not in question, only their shape. */
const RESTORE_CTX = Object.freeze({ isBoardMember: () => true, isAgentOwner: () => true, canEditObject: () => true });

/**
 * Takes a call back inside a document transaction (the caller wraps it): what the call made is removed if nobody has touched it since, what it removed is put back if
 * its id is free, and each field it changed goes back if it still holds what the call wrote. Anything a person changed since is left as it is and counted.
 * Every object that would be written is checked with the validator the relay applies to live writes. Nothing the tracker guards is written, whichever way
 * the change went (an object the call unlinked is not linked again), and an object something else still points at (a connector, a child) is not removed.
 * @returns {{ applied: number, skipped: { id: string, reason: string }[] }}
 */
export function applyInverse(doc, inverse, { now }) {
  const map = doc.getMap('objects');
  const skipped = [];
  let applied = 0;
  const skip = (id, reason) => skipped.push({ id, reason });
  const valid = (id, value, isNew) => validateBoardObject(id, value, RESTORE_CTX, { isNew }).ok === true;

  // who still points at what: a connector end, a child's parent
  const pointedAt = new Map();
  map.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const o = value.toJSON();
    const refs = [o.parent, o.from?.kind === 'bound' ? o.from.id : null, o.to?.kind === 'bound' ? o.to.id : null].filter((r) => typeof r === 'string');
    for (const ref of refs) {
      if (!pointedAt.has(ref)) pointedAt.set(ref, new Set());
      pointedAt.get(ref).add(id);
    }
  });
  const stillUsed = (id) => [...(pointedAt.get(id) ?? [])].some((by) => !Object.hasOwn(inverse.created, by));

  for (const [id, after] of Object.entries(inverse.created)) {
    const cur = map.get(id);
    if (!(cur instanceof Y.Map)) { skip(id, 'gone'); continue; }
    if (trackerOwned(cur.toJSON()) || trackerOwned(after)) { skip(id, 'linked'); continue; }
    if (!sameIgnoringNoise(cur.toJSON(), after)) { skip(id, 'changed'); continue; }
    if (stillUsed(id)) { skip(id, 'in use'); continue; }
    map.delete(id);
    applied++;
  }
  for (const [id, before] of Object.entries(inverse.removed)) {
    if (map.has(id)) { skip(id, 'exists'); continue; }
    if (trackerOwned(before)) { skip(id, 'linked'); continue; }
    if (!valid(id, before, true)) { skip(id, 'invalid'); continue; }
    map.set(id, new Y.Map(Object.entries(before).filter(([, v]) => v !== undefined)));
    applied++;
  }
  for (const [id, { b, a }] of Object.entries(inverse.changed)) {
    const cur = map.get(id);
    if (!(cur instanceof Y.Map)) { skip(id, 'gone'); continue; }
    const now_ = cur.toJSON();
    if (trackerOwned(now_) || touchesTracker(b, a)) { skip(id, 'linked'); continue; }
    const next = { ...now_ };
    let touched = 0, clash = 0;
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    const mayRestore = (k) => same(Object.hasOwn(now_, k) ? now_[k] : undefined, Object.hasOwn(a, k) ? a[k] : undefined);
    for (const k of keys) {
      if (!mayRestore(k)) { clash++; continue; }
      if (Object.hasOwn(b, k)) next[k] = b[k]; else delete next[k];
      touched++;
    }
    if (!touched) { skip(id, clash ? 'changed' : 'gone'); continue; }
    if (!valid(id, next, false)) { skip(id, 'invalid'); continue; }
    for (const k of keys) {
      if (!mayRestore(k)) continue;
      if (Object.hasOwn(b, k)) cur.set(k, b[k]); else cur.delete(k);
    }
    cur.set('updatedAt', now());
    applied++;
    if (clash) skip(id, 'partly changed');
  }
  return { applied, skipped };
}

/** The entry as clients see it: no revert data, no member id, who as two separate fields. */
export const publicEntry = (e, nameOf = () => null) => ({
  id: e.id, at: e.at, agent: e.agent, tool: e.tool, summary: e.summary, counts: e.counts, ids: e.ids, revertible: e.revertible,
  ...(e.reason ? { reason: e.reason } : {}),
  // who reverted it is stored as an id and named when listed, so removing that person leaves no name behind
  ...(e.reverted ? { reverted: { at: e.reverted.at, by: e.reverted.userId ? nameOf(e.reverted.userId) : null } } : {}),
});

export function createActivity({ dataDir, log = () => {}, now = Date.now }) {
  const dir = path.join(dataDir, 'activity');
  let tmpSeq = 0;
  /** A name of its own for every write, so a flush that overlaps a write still in flight never renames the other's file. */
  const tmpOf = (boardId) => `${file(boardId)}.${process.pid}.${++tmpSeq}.tmp`;
  /** Board logs held in memory, least recently used first; the files are the record. */
  const boards = new Map();
  const dirty = new Set();
  let timer = null;
  const file = (boardId) => path.join(dir, `${boardId}.json`);

  function readFile(boardId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(boardId), 'utf8'));
      if (parsed?.v === 1 && Array.isArray(parsed.entries)) return parsed.entries;
    } catch (err) {
      if (err?.code !== 'ENOENT') log('activity: could not read a board log', err?.message);
    }
    return [];
  }

  function encode(boardId) {
    let entries = boards.get(boardId) ?? [];
    let text = JSON.stringify({ v: 1, entries });
    while (text.length > MAX_FILE_BYTES && entries.length > 1) {
      entries = entries.slice(1);
      boards.set(boardId, entries);
      text = JSON.stringify({ v: 1, entries });
    }
    return text;
  }

  const writeNow = (boardId) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = tmpOf(boardId);
      fs.writeFileSync(tmp, encode(boardId), { mode: 0o600 });
      fs.renameSync(tmp, file(boardId));
    } catch (err) {
      log('activity: could not save a board log', err?.message);
    }
  };

  /** Writes the logs that changed, now: on a shutdown, when a log leaves memory, and in tests. */
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const boardId of dirty) writeNow(boardId);
    dirty.clear();
  }

  // A record is written a moment later, atomically and off the call that made it, and several records of one burst are one write.
  function scheduleSave(boardId) {
    dirty.add(boardId);
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      const batch = [...dirty];
      dirty.clear();
      for (const id of batch) {
        try {
          await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
          const tmp = tmpOf(id);
          await fs.promises.writeFile(tmp, encode(id), { mode: 0o600 });
          await fs.promises.rename(tmp, file(id));
        } catch (err) {
          log('activity: could not save a board log', err?.message);
        }
      }
    }, SAVE_DELAY_MS);
    timer.unref?.();
  }

  function load(boardId) {
    let entries = boards.get(boardId);
    if (entries) {
      boards.delete(boardId);
      boards.set(boardId, entries); // most recently used
      return entries;
    }
    entries = readFile(boardId);
    boards.set(boardId, entries);
    while (boards.size > MAX_CACHED_BOARDS) {
      const [oldest] = boards.keys();
      if (dirty.has(oldest)) { writeNow(oldest); dirty.delete(oldest); }
      boards.delete(oldest);
    }
    return entries;
  }

  /** Drops what has aged out: entries after 7 days, the revert data after 48 hours. */
  function prune(boardId) {
    const t = now();
    const entries = load(boardId).filter((e) => e.at >= t - MAX_AGE_MS).slice(-MAX_ENTRIES);
    for (const e of entries) {
      if (e.inverse && e.at < t - INVERSE_MAX_AGE_MS) {
        delete e.inverse;
        e.revertible = false;
        e.reason = 'expired';
      }
    }
    boards.set(boardId, entries);
    return entries;
  }

  return {
    flush,

    /**
     * Adds the entry for one tool call: `diff` as composed by composeDiffs, or `{ tooLarge: true, touched }` for a board too large to capture. Nothing is stored for
     * a call that changed nothing. `private` ids (a note kept private until the board is revealed) are counted but not listed.
     */
    record(boardId, { userId, tokenName, userName, tool, diff, privateIds = [] }) {
      if (!BOARD_ID.test(boardId) || !diff) return null;
      const big = diff.tooLarge === true;
      const hidden = new Set(privateIds);
      const listed = (ids) => ids.filter((id) => !hidden.has(id)).slice(0, MAX_IDS);
      let entry;
      if (big) {
        if (!diff.touched?.length) return null;
        entry = {
          counts: { created: 0, changed: diff.touched.length, removed: 0 }, summary: `changed ${diff.touched.length} ${diff.touched.length === 1 ? 'object' : 'objects'}`,
          ids: [], revertible: false, reason: 'too_large', // the ids are not listed: which of them are private notes is not known here
        };
      } else {
        if (!Object.keys(diff).length) return null;
        const counts = { created: 0, changed: 0, removed: 0 };
        for (const { before, after } of Object.values(diff)) {
          if (!before) counts.created++;
          else if (!after) counts.removed++;
          else counts.changed++;
        }
        const inverse = inverseOf(diff);
        const fits = JSON.stringify(inverse).length <= MAX_REVERT_BYTES;
        entry = { counts, summary: summarise(diff), ids: listed(Object.keys(diff)), revertible: fits, ...(fits ? { inverse } : { reason: 'too_large' }) };
      }
      Object.assign(entry, {
        id: crypto.randomBytes(9).toString('base64url'), at: now(), userId: typeof userId === 'string' ? userId : null,
        agent: agentParts({ tokenName, userName }), tool: String(tool).slice(0, 64),
      });
      prune(boardId);
      load(boardId).push(entry);
      scheduleSave(boardId);
      return publicEntry(entry);
    },

    /** Newest first, as clients see them. */
    list(boardId, limit = 100, nameOf = () => null) {
      if (!BOARD_ID.test(boardId)) return [];
      return prune(boardId).slice(-limit).reverse().map((e) => publicEntry(e, nameOf));
    },

    find(boardId, entryId) {
      if (!BOARD_ID.test(boardId)) return null;
      return prune(boardId).find((e) => e.id === entryId) ?? null;
    },

    markReverted(boardId, entryId, userId) {
      const entry = this.find(boardId, entryId);
      if (!entry) return;
      entry.reverted = { at: now(), userId: typeof userId === 'string' ? userId : null };
      delete entry.inverse; // taken back once: the data is not kept
      entry.revertible = false;
      scheduleSave(boardId);
    },

    /** A person was removed from the workspace: every entry made with their tokens goes, with its revert data, from every board. */
    removeUser(userId) {
      if (typeof userId !== 'string' || userId === '') return 0;
      let removed = 0;
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
      } catch { /* no log yet */ }
      for (const boardId of new Set([...names, ...boards.keys()])) {
        if (!BOARD_ID.test(boardId)) continue;
        const entries = load(boardId);
        const keep = entries.filter((e) => e.userId !== userId);
        let touched = keep.length !== entries.length;
        for (const e of keep) if (e.reverted?.userId === userId) { e.reverted.userId = null; touched = true; }
        if (!touched) continue;
        removed += entries.length - keep.length;
        boards.set(boardId, keep);
        scheduleSave(boardId);
      }
      return removed;
    },

    /** Deletes the log of every board `isLive` says is gone or deleted (its revert data would outlive the board otherwise). */
    sweep(isLive) {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
      } catch {
        return 0;
      }
      let removed = 0;
      for (const boardId of names) {
        if (!BOARD_ID.test(boardId) || isLive(boardId)) continue;
        boards.delete(boardId);
        dirty.delete(boardId);
        try { fs.rmSync(file(boardId), { force: true }); removed++; } catch { /* already gone */ }
      }
      return removed;
    },

    /** The accounts API routes: reading the log (anyone who can see the board) and reverting a call (editors and owners). */
    routes({ compile, boardFor, audit, errors, write, nameOf = () => null }) {
      const { HttpError, forbidden } = errors;
      const must = (user, boardId, edit) => {
        const { role } = boardFor(user, boardId); // throws for a person with no access to the board
        if (edit && role !== 'owner' && role !== 'editor') throw forbidden('Only editors can revert an agent change');
        return role;
      };
      return [
        compile('GET', 'boards/:id/activity', {}, ({ user, params }) => {
          must(user, params.id, false);
          return [200, { entries: this.list(params.id, 100, nameOf) }];
        }),
        compile('POST', 'boards/:id/activity/:eid/revert', {}, ({ user, params }) => {
          // authorised now, as for any editor's write: never by who the entry says made it
          must(user, params.id, true);
          const entry = this.find(params.id, params.eid);
          if (!entry) throw new HttpError(404, 'not_found', 'No such activity entry');
          if (entry.reverted) throw new HttpError(409, 'already_reverted', 'This change was already reverted');
          if (!entry.revertible || !entry.inverse) throw new HttpError(409, 'not_revertible', entry.reason === 'expired' ? 'This change is too old to revert' : 'This change is too large to revert here');
          const result = write(params.id, `activity-revert:${entry.id}`, (doc) => applyInverse(doc, entry.inverse, { now }));
          // when nothing could be applied the entry stays: the person can sort out what is in the way and try again
          if (result.applied > 0) this.markReverted(params.id, entry.id, user.id);
          audit(user, 'board.activity.revert', { boardId: params.id, entryId: entry.id, tool: entry.tool, applied: result.applied, skipped: result.skipped.length });
          return [200, { applied: result.applied, skipped: result.skipped.slice(0, MAX_IDS) }];
        }),
      ];
    },
  };
}
