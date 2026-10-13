// The board activity log (TAB-158, docs/agent-presence.md): one entry per MCP tool call that changed a board, read by the Activity panel, with what is needed
// to take that call back. The log holds object ids, counts and a one-line summary; never text a person wrote. The data to revert a call (the states of the
// objects before and after) stays on the server and is never sent to a client. The log is bounded: 200 entries or 7 days a board, 256 KiB of revert data
// an entry (a bigger call is logged and cannot be reverted), 4 MiB a board file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { validateBoardObject } from './sync-validate.mjs';

export const MAX_ENTRIES = 200;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REVERT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IDS = 50;
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Fields that change on every write and say nothing about what was done. */
const NOISE = new Set(['updatedAt']);
/** Objects the tracker projects or guards: a revert leaves them to the tracker's own rules. */
const trackerOwned = (o) => o && (o.extProvider !== undefined || o.trackerId !== undefined || o.tracker !== undefined || o.ext !== undefined);

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

/** The name a person sees for an agent: "Claude for Ada" (the token's name and the member's first name). */
export function agentLabel({ tokenName, userName }) {
  const token = String(tokenName ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim() || 'Agent';
  const first = String(userName ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().split(/\s+/u)[0] ?? '';
  return [...(first ? `${token} for ${first}` : token)].slice(0, 80).join('');
}

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

/**
 * Takes a call back inside a document transaction (the caller wraps it): what the call made is removed if nobody has touched it since, what it removed is put back if
 * its id is free, and each field it changed goes back if it still holds what the call wrote. Anything a person changed since is left as it is and counted.
 * Every object that would be written is checked with the validator the relay applies to live writes.
 * @returns {{ applied: number, skipped: { id: string, reason: string }[] }}
 */
export function applyInverse(doc, inverse, { now }) {
  const map = doc.getMap('objects');
  const skipped = [];
  let applied = 0;
  const skip = (id, reason) => skipped.push({ id, reason });
  const valid = (id, value, isNew) => validateBoardObject(id, value, {}, { isNew }).ok === true;
  for (const [id, after] of Object.entries(inverse.created)) {
    const cur = map.get(id);
    if (!(cur instanceof Y.Map)) { skip(id, 'gone'); continue; }
    if (trackerOwned(cur.toJSON())) { skip(id, 'linked'); continue; }
    if (!sameIgnoringNoise(cur.toJSON(), after)) { skip(id, 'changed'); continue; }
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
    if (trackerOwned(now_)) { skip(id, 'linked'); continue; }
    const next = { ...now_ };
    let touched = 0, clash = 0;
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const held = Object.hasOwn(now_, k) ? now_[k] : undefined;
      const wrote = Object.hasOwn(a, k) ? a[k] : undefined;
      if (!same(held, wrote)) { clash++; continue; }
      if (Object.hasOwn(b, k)) next[k] = b[k]; else delete next[k];
      touched++;
    }
    if (!touched) { skip(id, clash ? 'changed' : 'gone'); continue; }
    if (!valid(id, next, false)) { skip(id, 'invalid'); continue; }
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const held = Object.hasOwn(now_, k) ? now_[k] : undefined;
      const wrote = Object.hasOwn(a, k) ? a[k] : undefined;
      if (!same(held, wrote)) continue;
      if (Object.hasOwn(b, k)) cur.set(k, b[k]); else cur.delete(k);
    }
    cur.set('updatedAt', now());
    applied++;
    if (clash) skip(id, 'partly changed');
  }
  return { applied, skipped };
}

/** The entry as clients see it: no revert data. */
export const publicEntry = (e) => ({
  id: e.id, at: e.at, agent: e.agent, tool: e.tool, summary: e.summary, counts: e.counts, ids: e.ids, revertible: e.revertible,
  ...(e.reverted ? { reverted: e.reverted } : {}),
});

export function createActivity({ dataDir, log = () => {}, now = Date.now }) {
  const dir = path.join(dataDir, 'activity');
  const boards = new Map();
  const file = (boardId) => path.join(dir, `${boardId}.json`);

  function load(boardId) {
    let entries = boards.get(boardId);
    if (entries) return entries;
    entries = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file(boardId), 'utf8'));
      if (parsed?.v === 1 && Array.isArray(parsed.entries)) entries = parsed.entries;
    } catch (err) {
      if (err?.code !== 'ENOENT') log('activity: could not read a board log', err?.message);
    }
    boards.set(boardId, entries);
    return entries;
  }

  function save(boardId) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      let entries = boards.get(boardId) ?? [];
      let text = JSON.stringify({ v: 1, entries });
      while (text.length > MAX_FILE_BYTES && entries.length > 1) {
        entries = entries.slice(1);
        boards.set(boardId, entries);
        text = JSON.stringify({ v: 1, entries });
      }
      const tmp = `${file(boardId)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file(boardId));
    } catch (err) {
      log('activity: could not save a board log', err?.message);
    }
  }

  function prune(boardId) {
    const cutoff = now() - MAX_AGE_MS;
    const entries = load(boardId).filter((e) => e.at >= cutoff).slice(-MAX_ENTRIES);
    boards.set(boardId, entries);
    return entries;
  }

  return {
    /** Adds the entry for one tool call: `diff` as composed by composeDiffs. Nothing is stored for a call that changed nothing. */
    record(boardId, { userId, tokenName, userName, tool, diff }) {
      if (!BOARD_ID.test(boardId) || !diff || !Object.keys(diff).length) return null;
      const counts = { created: 0, changed: 0, removed: 0 };
      for (const { before, after } of Object.values(diff)) {
        if (!before) counts.created++;
        else if (!after) counts.removed++;
        else counts.changed++;
      }
      const inverse = inverseOf(diff);
      const bytes = JSON.stringify(inverse).length;
      const entry = {
        id: crypto.randomBytes(9).toString('base64url'), at: now(), userId: typeof userId === 'string' ? userId : null,
        agent: agentLabel({ tokenName, userName }), tool: String(tool).slice(0, 64), summary: summarise(diff), counts,
        ids: Object.keys(diff).slice(0, MAX_IDS), revertible: bytes <= MAX_REVERT_BYTES, ...(bytes <= MAX_REVERT_BYTES ? { inverse } : {}),
      };
      prune(boardId);
      load(boardId).push(entry);
      save(boardId);
      return publicEntry(entry);
    },

    /** Newest first, as clients see them. */
    list(boardId, limit = 100) {
      if (!BOARD_ID.test(boardId)) return [];
      return prune(boardId).slice(-limit).reverse().map(publicEntry);
    },

    find(boardId, entryId) {
      if (!BOARD_ID.test(boardId)) return null;
      return prune(boardId).find((e) => e.id === entryId) ?? null;
    },

    markReverted(boardId, entryId, by) {
      const entry = this.find(boardId, entryId);
      if (!entry) return;
      entry.reverted = { at: now(), by: String(by).slice(0, 80) };
      delete entry.inverse; // taken back once: the data is not kept
      entry.revertible = false;
      save(boardId);
    },

    /** The accounts API routes: reading the log (anyone who can see the board) and reverting a call (editors and owners). */
    routes({ compile, boardFor, audit, errors, write }) {
      const { HttpError, forbidden } = errors;
      const must = (user, boardId, edit) => {
        const { role } = boardFor(user, boardId); // throws for a person with no access to the board
        if (edit && role !== 'owner' && role !== 'editor') throw forbidden('Only editors can revert an agent change');
        return role;
      };
      return [
        compile('GET', 'boards/:id/activity', {}, ({ user, params }) => {
          must(user, params.id, false);
          return [200, { entries: this.list(params.id) }];
        }),
        compile('POST', 'boards/:id/activity/:eid/revert', {}, ({ user, params }) => {
          // authorised now, as for any editor's write: never by who the entry says made it
          must(user, params.id, true);
          const entry = this.find(params.id, params.eid);
          if (!entry) throw new HttpError(404, 'not_found', 'No such activity entry');
          if (entry.reverted) throw new HttpError(409, 'already_reverted', 'This change was already reverted');
          if (!entry.revertible || !entry.inverse) throw new HttpError(409, 'not_revertible', 'This change is too large to revert here');
          const result = write(params.id, `activity-revert:${entry.id}`, (doc) => applyInverse(doc, entry.inverse, { now }));
          this.markReverted(params.id, entry.id, user.name ?? user.id);
          audit(user, 'board.activity.revert', { boardId: params.id, entryId: entry.id, tool: entry.tool, applied: result.applied, skipped: result.skipped.length });
          return [200, { applied: result.applied, skipped: result.skipped.slice(0, MAX_IDS) }];
        }),
      ];
    },
  };
}
