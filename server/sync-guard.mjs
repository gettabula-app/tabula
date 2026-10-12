// The relay side of the sync validator (server/sync-validate.mjs): wraps the application of one client sync message,
// finds the keys that message changed, validates them and, in enforce mode, reverts the whole message.
//
// Modes (TABULA_SYNC_VALIDATE, read once at startup by syncValidateMode):
//   off      nothing runs.
//   report   NEVER rejects, never changes data, never throws into the sync path. It counts violations by code and kind
//            in memory and logs one summary line a minute (counts and codes only: no board ids, user ids or content).
//   enforce  a message with a violation (other than a report-only one, see ENFORCE_TEXT_CAPS) is reverted with a Y.UndoManager
//            over the room's maps, and the revert goes out in the same held broadcast, so every client converges on the
//            state from before the message. 20 violations from one socket within 60 s close it.
//
// Order: the comments guard (comment-authz.mjs) and the tracker guard run first, inside `inner`, and repair what they
// can. The validator reads the state they left: that is what would be stored. A comment field the comments guard repaired
// is counted as `repaired`, not as a violation.
//
// Work is bounded per message: only the keys the message changed are examined, at most `maxKeys` of them, and the
// examination spends a budget of `maxBytes` serialized bytes and `maxNodes` values (a text edit reads only the changed
// field; each value is read once). What the cap or the budget leaves out is counted as `skipped`. In enforce mode a message
// with skipped keys is reverted (violation `too_many_keys`): what was not looked at cannot be let through. A client that
// writes a very large board splits it into several messages (src/exporters.ts applyImported).
import * as Y from 'yjs';
import { AUTHZ_ORIGIN } from './comment-authz.mjs';
import { validateChangedKeys } from './sync-validate.mjs';

/** Which maps of a room hold what, and the validator kind of each. */
const SCOPES = {
  board: [['objects', 'object'], ['meta', 'meta'], ['flow', 'flow'], ['votes', 'vote'], ['polls', 'poll'], ['pollAnswers', 'pollAnswer'], ['pollState', 'pollState'], ['labels', 'label']],
  comments: [['threads', 'thread']],
};
const NESTED = new Set(['objects', 'threads']);


/**
 * `toJSON` with a budget: copies a Yjs type or a plain value while spending `budget` ({ bytes, nodes }, `exhausted` set when
 * it runs out) and stops at once when it does, so a hostile value is never materialised in full. A forbidden key is copied the
 * way Y.Map.toJSON copies it (`out[key] = value`), so the validator sees the same thing it would have seen.
 * Returns undefined when the budget ran out.
 */
export function plainBounded(root, budget, maxDepth = 8) {
  if (budget.exhausted) return undefined;
  /** The children of a container as an iterator of [key, value], lazily: nothing is read ahead of the budget. */
  function* plainObjectEntries(v) {
    for (const k in v) if (Object.hasOwn(v, k)) yield [k, v[k]];
  }
  function* arrayEntries(v) {
    for (let i = 0; i < v.length; i++) yield [i, v[i]];
  }
  const entriesOf = (v) => {
    if (v instanceof Y.Map) return v.entries();
    if (v instanceof Y.Array) return arrayEntriesOfYArray(v);
    return Array.isArray(v) ? arrayEntries(v) : plainObjectEntries(v);
  };
  function* arrayEntriesOfYArray(v) {
    let i = 0;
    for (const x of v) yield [i++, x];
  }
  /** A fresh empty container for the object `v` (`dst`), a string for a Y.Text (`leaf`), or `stop` when the budget is gone. */
  const open = (v) => {
    if (--budget.nodes < 0 || budget.bytes < 0) { budget.exhausted = true; return { stop: true }; }
    if (v instanceof Y.Text) {
      // the length first: toString() would build the whole string
      if (v.length + 2 > budget.bytes) { budget.exhausted = true; return { stop: true }; }
      const text = v.toString();
      budget.bytes -= text.length + 2;
      return { leaf: text };
    }
    if (v instanceof Y.AbstractType && !(v instanceof Y.Map) && !(v instanceof Y.Array)) { budget.exhausted = true; return { stop: true }; }
    const array = v instanceof Y.Array || Array.isArray(v);
    // an array longer than what is left to spend is refused by its length before one item is read
    if (array && v.length > budget.nodes) { budget.exhausted = true; return { stop: true }; }
    // lib0 decodes a nested object with an own `__proto__` key by assigning it, which CHANGES the prototype instead of adding a key:
    // the copy below sees own properties only, so the forbidden key would never reach the validator. Flag it here.
    if (!array && !(v instanceof Y.AbstractType)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) budget.badPrototype = true;
    }
    return { dst: array ? [] : {}, src: v };
  };

  if (root === null || typeof root !== 'object') {
    if (--budget.nodes < 0 || budget.bytes < 0) { budget.exhausted = true; return undefined; }
    budget.bytes -= typeof root === 'string' ? root.length + 2 : 8;
    return root;
  }
  const first = open(root);
  if (first.stop) return undefined;
  if (first.dst === undefined) return first.leaf;
  // an explicit stack instead of recursion: nesting of any depth cannot overflow the call stack
  const stack = [{ it: entriesOf(first.src), dst: first.dst, array: Array.isArray(first.dst) }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const next = top.it.next();
    if (next.done) { stack.pop(); continue; }
    const k = next.value[0];
    const x = next.value[1];
    if (!top.array) {
      budget.bytes -= String(k).length + 3;
      if (budget.bytes < 0) { budget.exhausted = true; return undefined; }
    }
    if (x === null || typeof x !== 'object') {
      // a primitive: spent in place, no wrapper allocated
      if (--budget.nodes < 0 || budget.bytes < 0) { budget.exhausted = true; return undefined; }
      budget.bytes -= typeof x === 'string' ? x.length + 2 : 8;
      top.dst[k] = x;
      continue;
    }
    const child = open(x);
    if (child.stop) return undefined;
    if (child.dst === undefined) {
      top.dst[k] = child.leaf;
      continue;
    }
    // deeper than any valid value: marked and abandoned before descending (the validator reports it as too_deep)
    if (stack.length >= maxDepth) { budget.tooDeep = true; budget.exhausted = true; return undefined; }
    top.dst[k] = child.dst;
    stack.push({ it: entriesOf(child.src), dst: child.dst, array: Array.isArray(child.dst) });
  }
  return first.dst;
}

/** The longest key (an object id, a thread id, a poll answer key) that is looked at; longer ones are a `key_too_long` violation. */
export const MAX_KEY = 256;

/** @type {{ maxKeys: number, maxBytes: number, maxNodes: number, maxEvents: number, maxChanges: number }} */
export const DEFAULT_BUDGET = { maxKeys: 5000, maxBytes: 2 * 1024 * 1024, maxNodes: 50_000, maxEvents: 20_000, maxChanges: 100_000 };

/** What a thrown value says about itself without its message (a message can carry content): its name and code. */
const errorCode = (err) => `${typeof err?.name === 'string' ? err.name.slice(0, 40) : 'Error'}${typeof err?.code === 'string' ? `:${err.code.slice(0, 40)}` : ''}`;

export function createSyncGuard({ mode = 'report', log: rawLog = () => {}, now = Date.now, maxKeys = DEFAULT_BUDGET.maxKeys, maxBytes = DEFAULT_BUDGET.maxBytes, maxNodes = DEFAULT_BUDGET.maxNodes, maxEvents = DEFAULT_BUDGET.maxEvents, maxChanges = DEFAULT_BUDGET.maxChanges, strikeLimit = 20, strikeWindowMs = 60_000, summaryMs = 60_000, validate = validateChangedKeys } = {}) {
  // logging is best effort: a logger that throws must not skip the fallback or break sync
  const log = (...args) => { try { rawLog(...args); } catch { /* ignore */ } };
  const totals = { updates: 0, keys: 0, skipped: 0, skippedBudget: 0, tooManyKeys: 0, checkErrors: 0, repaired: 0, rejected: 0, closed: 0, reportOnly: 0, violations: 0, byCode: {}, byKind: {} };
  let windowCounts = { keys: 0, violations: 0, skipped: 0, repaired: 0, rejected: 0, byCode: {}, byKind: {} };
  let lastSummary = now();

  const bump = (table, key, n = 1) => { table[key] = (table[key] ?? 0) + n; };

  /** A check that failed to run. Counted, never logged per message (the summary carries the last error code). */
  function noteCheckError(err) {
    totals.checkErrors++;
    windowCounts.checkErrors = (windowCounts.checkErrors ?? 0) + 1;
    windowCounts.lastError = errorCode(err);
  }

  /** Counts `n` strikes against the socket; closes it at the limit within the window. */
  function strike(ws, n) {
    const stamps = (ws.syncValidateStrikes ??= []);
    const t = now();
    for (let i = 0; i < n; i++) stamps.push(t);
    while (stamps.length && t - stamps[0] > strikeWindowMs) stamps.shift();
    if (stamps.length >= strikeLimit) {
      totals.closed++;
      try { ws.close(1008, 'sync_invalid'); } catch { /* the socket is gone */ }
    }
  }

  function summarize() {
    const t = now();
    if (t - lastSummary < summaryMs) return;
    const w = windowCounts;
    lastSummary = t;
    windowCounts = { keys: 0, violations: 0, skipped: 0, repaired: 0, rejected: 0, byCode: {}, byKind: {} };
    if (!w.violations && !w.skipped && !w.repaired && !w.checkErrors) return;
    log(`sync-validate (${mode}): ${w.keys} keys checked, ${w.violations} violations ${JSON.stringify(w.byCode)} by kind ${JSON.stringify(w.byKind)}, ${w.repaired} repaired by the comments guard, ${w.skipped} skipped, ${w.rejected} updates reverted${w.checkErrors ? `, ${w.checkErrors} checks failed to run (last: ${w.lastError})` : ''}`);
  }

  /** Collects the keys one message touches, from the deep observers of the room's maps. */
  function collector(room, scope) {
    const touched = new Map();
    let overflow = 0;
    const attached = [];
    const stop = () => {
      while (attached.length) {
        try { attached.pop()(); } catch { /* already detached */ }
      }
    };
    const failed = { error: null };
    const walked = { events: 0, changes: 0 };
    const comments = room.kind === 'comments';
    // a key is sender text: one longer than any id is a violation of its own and is never stored or joined into another string
    const bad = { count: 0, kinds: new Set() };
    const tooLong = (key, kind) => {
      if (typeof key === 'string' && key.length <= MAX_KEY) return false;
      bad.count++;
      bad.kinds.add(kind);
      return true;
    };
    const preBudget = { bytes: maxBytes, nodes: maxNodes, exhausted: false };
    const touch = (kind, key) => {
      const id = `${kind}\u0000${key}`;
      let t = touched.get(id);
      if (!t) {
        if (touched.size >= maxKeys) { overflow++; return null; }
        t = { kind, key, isNew: false, fields: new Set(), old: new Map(), replyIds: new Set(), replyOld: new Map(), pre: undefined, preSeen: false };
        touched.set(id, t);
      }
      return t;
    };
    try {
      for (const [name, kind] of scope) {
        const map = room.doc.getMap(name);
        const handler = (events, transaction) => {
         // an observer runs inside Yjs's own transaction: nothing it does may throw into the sync path
         try {
          const repair = transaction.origin === AUTHZ_ORIGIN;
          for (let e = 0; e < events.length; e++) {
            const ev = events[e];
            // past the cap the walk stops: the events not walked are counted as one number and nothing more is read
            // many descendant events under ONE key keep the key count small, so the walk has budgets of its own: events and changes
            if (touched.size >= maxKeys || walked.events >= maxEvents || walked.changes >= maxChanges) { overflow += events.length - e; break; }
            walked.events++;
            walked.changes += ev.keysChanged?.size || 1;
            const path = ev.path;
            if (path.length === 0) {
              const left = maxKeys - touched.size;
              if (ev.keysChanged.size > left) {
                // too many to classify (reading `changes` costs as much as the message): record what fits, without actions
                let n = 0;
                for (const key of ev.keysChanged) {
                  if (n++ >= left) { overflow += ev.keysChanged.size - left; break; }
                  if (!tooLong(key, kind)) touch(kind, key);
                }
                continue;
              }
              for (const [key, change] of ev.changes.keys) {
                if (change.action === 'delete') continue;
                if (tooLong(key, kind)) continue;
                const first = !touched.has(`${kind}\u0000${key}`);
                const t = touch(kind, key);
                if (!t) continue;
                if (first && change.action === 'add') t.isNew = true;
                if (comments && !repair && !t.preSeen && NESTED.has(name)) { t.pre = plainBounded(map.get(key), preBudget); t.preSeen = true; }
              }
              continue;
            }
            if (!NESTED.has(name)) continue;
            if (tooLong(path[0], kind)) continue;
            const t = touch(kind, String(path[0]));
            if (!t) continue;
            if (comments && !repair && !t.preSeen) { t.pre = plainBounded(map.get(String(path[0])), preBudget); t.preSeen = true; }
            if (path.length === 1) {
              if (ev.keysChanged.size > 256) { t.full = true; continue; }
              for (const [field, change] of ev.changes.keys) {
                if (tooLong(field, kind)) continue;
                t.fields.add(String(field));
                if (!t.old.has(field)) t.old.set(field, { action: change.action, value: change.oldValue });
              }
            } else if (path.length === 2 && path[1] === 'replies') {
              t.fields.add('replies');
              if (ev.keysChanged.size > 256) { t.full = true; continue; }
              for (const [rid, change] of ev.changes.keys) {
                if (tooLong(rid, kind)) continue;
                t.replyIds.add(String(rid));
                if (!t.replyOld.has(rid)) t.replyOld.set(rid, { action: change.action, value: change.oldValue });
              }
            } else t.fields.add(String(path[1]));
          }
         } catch (err) {
          failed.error = err;
         }
        };
        map.observeDeep(handler);
        attached.push(() => map.unobserveDeep(handler));
      }
    } catch (err) {
      stop(); // detach what was attached before the failure, then let the caller fall back to a plain apply
      throw err;
    }
    return { touched, overflow: () => overflow, stop, bad, failed };
  }

  /** Owner and author fields of an object are read with the changed ones, so the authorship rules see them. */
  const IDENTITY = ['createdBy', 'ownerId', 'ownerName', 'ownerKind'];

  /**
   * The change record for one touched key, read from the state the message left. A field edit of an existing object reads
   * only the changed fields (and the identity fields); anything else reads the value once.
   */
  function changeFrom(room, kindToMap, t, conv) {
    const map = room.doc.getMap(kindToMap.get(t.kind));
    const raw = map.get(t.key);
    if (raw === undefined) return null; // deleted by the end: nothing to check
    const nested = NESTED.has(kindToMap.get(t.kind));
    if (!nested || t.isNew || t.full || !(raw instanceof Y.Map)) {
      const change = { kind: t.kind, key: t.key, value: plainBounded(raw, conv) };
      if (t.isNew) change.isNew = true;
      return change;
    }
    const change = { kind: t.kind, key: t.key };
    let value;
    if (kindToMap.get(t.kind) === 'objects' && t.fields.size) {
      value = { type: raw.get('type') };
      for (const k of IDENTITY) if (raw.has(k)) value[k] = raw.get(k);
      for (const f of t.fields) if (raw.has(f)) value[f] = plainBounded(raw.get(f), conv);
    } else {
      value = plainBounded(raw, conv);
    }
    if (conv.exhausted) return null;
    change.value = value;
    if (t.fields.size) {
      change.fields = [...t.fields];
      const prev = { ...value };
      for (const [field, o] of t.old) { if (o.action === 'add') delete prev[field]; else prev[field] = o.value; }
      if (t.replyOld.size && prev.replies && typeof prev.replies === 'object') {
        prev.replies = { ...prev.replies };
        for (const [rid, o] of t.replyOld) { if (o.action === 'add') delete prev.replies[rid]; else prev.replies[rid] = o.value; }
      }
      change.prev = prev;
      if (t.replyIds.size) change.replyIds = [...t.replyIds];
    }
    return change;
  }

  function record(violations, outcome) {
    for (const x of violations) {
      bump(totals.byCode, x.code); bump(totals.byKind, x.kind);
      bump(windowCounts.byCode, x.code); bump(windowCounts.byKind, x.kind);
      if (x.reportOnly) totals.reportOnly++;
    }
    totals.violations += violations.length; windowCounts.violations += violations.length;
    totals.keys += outcome.keys; windowCounts.keys += outcome.keys;
    totals.skipped += outcome.skipped; windowCounts.skipped += outcome.skipped;
    totals.skippedBudget += outcome.skippedBudget;
    totals.repaired += outcome.repaired; windowCounts.repaired += outcome.repaired;
  }

  /**
   * Applies one client sync message through `inner` (which includes the other guards) and validates what it changed.
   * `ctx` is the validator context for the socket. Rethrows what `inner` throws, after validating the part that applied.
   */
  function run(room, ws, ctx, inner) {
    if (mode === 'off') return inner();
    const scope = SCOPES[room.kind];
    if (!scope) return inner();
    let collect = null;
    let um = null;
    let held = null;
    let previousHeld = null;
    let counts = {};
    try {
      counts = room.kind === 'comments' ? { thread: room.doc.getMap('threads').size } : {};
      collect = collector(room, scope);
      if (mode === 'enforce') {
        um = room.syncUndo ??= new Y.UndoManager(scope.map(([name]) => room.doc.getMap(name)), { captureTimeout: 0, trackedOrigins: new Set() });
        um.trackedOrigins.add(ws);
        um.trackedOrigins.add(AUTHZ_ORIGIN);
        um.clear();
        previousHeld = room.held;
        held = [];
        room.held = held;
      }
    } catch (err) {
      noteCheckError(err);
      try { summarize(); } catch { /* logging must not break sync */ }
      try { collect?.stop(); } catch { /* nothing left to detach */ }
      collect = null;
      if (um) {
        um.trackedOrigins.delete(ws);
        um.trackedOrigins.delete(AUTHZ_ORIGIN);
      }
      if (held) room.held = previousHeld;
      // report mode fails open. Enforce mode cannot check this message, so it does not let it in: it is not applied, and
      // the sender's retries count as strikes like any other rejection
      if (mode === 'enforce') {
        totals.rejected++; windowCounts.rejected++;
        strike(ws, 1);
        return undefined;
      }
      return inner();
    }

    const revert = () => {
      let guardrail = 0;
      while (um.undoStack.length && guardrail++ < 50) um.undo();
      totals.rejected++; windowCounts.rejected++;
    };
    let error = null;
    let result;
    try {
      result = inner();
    } catch (err) {
      error = err;
    }

    try {
      collect.stop();
      const kindToMap = new Map(scope.map(([name, kind]) => [kind, name]));
      const budget = { bytes: maxBytes, nodes: maxNodes, exhausted: false };
      const conv = { bytes: maxBytes, nodes: maxNodes, exhausted: false };
      const full = { ...ctx, counts, budget };
      if (collect.failed.error) throw collect.failed.error;
      const keys = collect.touched.size;
      let skipped = collect.overflow();
      let skippedBudget = 0;
      const violations = [];
      const changes = [];
      for (const t of collect.touched.values()) {
        if (budget.exhausted || conv.exhausted) { skipped++; skippedBudget++; continue; }
        const change = changeFrom(room, kindToMap, t, conv);
        if (conv.badPrototype) {
          violations.push({ code: 'forbidden_key', path: '', kind: t.kind, key: t.key.length <= MAX_KEY ? t.key : '?' });
          conv.badPrototype = false;
        }
        if (conv.tooDeep) {
          // nested deeper than any valid value: a violation of its own, and the rest of the message is still looked at
          violations.push({ code: 'too_deep', path: '', kind: t.kind, key: t.key.length <= MAX_KEY ? t.key : '?' });
          conv.tooDeep = false;
          conv.exhausted = false;
          continue;
        }
        if (conv.exhausted) { skipped++; skippedBudget++; continue; }
        if (!change) continue;
        const r = validate([change], full);
        if (r.skipped) { skipped += r.skipped; skippedBudget += r.skipped; }
        if (!r.ok) violations.push(...r.violations);
        changes.push(change);
      }
      totals.updates++;
      let repaired = 0;
      if (room.kind === 'comments' && violations.length < 200) {
        const earlier = changes.map((c) => ({ ...c, value: collect.touched.get(`${c.kind}\u0000${c.key}`)?.pre ?? c.value }));
        const before = validate(earlier, { ...ctx, counts });
        if (!before.ok) {
          const kept = new Set(violations.map((x) => `${x.kind}\u0000${x.key}\u0000${x.code}\u0000${x.path}`));
          repaired = before.violations.filter((x) => !kept.has(`${x.kind}\u0000${x.key}\u0000${x.code}\u0000${x.path}`)).length;
        }
      }
      if (collect.bad.count) {
        for (const kind of collect.bad.kinds) violations.push({ code: 'key_too_long', path: '', kind, key: '?' });
      }
      if (skipped && mode === 'enforce') {
        // what was not looked at cannot be let through
        violations.push({ code: 'too_many_keys', path: '', kind: 'message', key: '?' });
        totals.tooManyKeys++;
      }
      record(violations, { keys, skipped, skippedBudget, repaired });
      if (mode === 'enforce' && violations.some((x) => !x.reportOnly)) {
        revert();
        strike(ws, violations.filter((x) => !x.reportOnly).length);
      }
    } catch (err) {
      noteCheckError(err);
      // report mode fails open; enforce mode rejects what it could not check, the same way as a violation
      if (mode === 'enforce' && um) {
        try {
          revert();
          totals.byCode.check_error = (totals.byCode.check_error ?? 0) + 1;
          windowCounts.byCode.check_error = (windowCounts.byCode.check_error ?? 0) + 1;
          strike(ws, 1);
        } catch (again) {
          noteCheckError(again);
        }
      }
    } finally {
      if (um) {
        um.trackedOrigins.delete(ws);
        um.trackedOrigins.delete(AUTHZ_ORIGIN);
        um.clear();
      }
      if (held) {
        room.held = previousHeld;
        if (previousHeld) previousHeld.push(...held);
        else if (held.length) room.broadcastUpdate(held.length === 1 ? held[0] : Y.mergeUpdates(held));
      }
      try { summarize(); } catch { /* logging must not break sync */ }
    }
    if (error) throw error;
    return result;
  }

  return {
    mode,
    enabled: mode !== 'off',
    run,
    /** Counters since startup: totals only, no content. */
    stats: () => ({ mode, ...totals, byCode: { ...totals.byCode }, byKind: { ...totals.byKind } }),
  };
}
