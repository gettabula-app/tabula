// Comment authorship, enforced on the relay (docs/comment-authz.md). The relay applies each update from a comments
// socket, compares the threads it touched with a JSON mirror, and undoes with a second update anything the sender was
// not allowed to do. A correcting update is an ordinary CRDT change, so every client, the sender included, ends up
// with the corrected state; nothing has to be refused or reset. Accounts mode only: open mode has no identities.
import * as Y from 'yjs';

/** Origin of the relay's own writes to a comments document (corrections, legacy marks). */
export const AUTHZ_ORIGIN = 'authz';

const SET_ONCE = ['id', 'createdAt', 'authorId', 'authorName', 'authorColor', 'anchor', 'imported', 'importedBy', 'legacy'];
const AUTHOR = ['authorId', 'authorName', 'authorColor', 'imported', 'importedBy', 'legacy'];
const OTHER_SET_ONCE = SET_ONCE.filter((k) => !AUTHOR.includes(k));
const TEXT = ['text', 'editedAt'];
const RESOLVE = ['resolved', 'resolvedBy', 'resolvedAt'];
const THREAD_KEYS = new Set([...SET_ONCE, ...TEXT, ...RESOLVE, 'replies']);
const REPLY_KEYS = new Set(['id', 'createdAt', 'authorId', 'authorName', 'authorColor', 'text', 'editedAt', 'imported', 'importedBy', 'legacy']);
const MAX_NAME = 80;

// A device id from before accounts (crypto.randomUUID() in src/sync.ts). Account ids are 22-character base64url.
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jsonOf = (m) => (m instanceof Y.Map ? m.toJSON() : undefined);
const clampName = (v) => (typeof v === 'string' ? v.slice(0, MAX_NAME) : '');

/**
 * What one person may do to one comment (thread or reply). `actor` is { id, name, role } for the socket's user, with
 * the board role from the directory. Moderators (board role owner: the board owner, team admins and workspace admins)
 * delete anything but edit only their own words. Whoever may edit the board (owner or editor) may resolve.
 */
export function commentRules(actor) {
  const moderator = actor.role === 'owner';
  const own = (c) => c.authorId === actor.id && !c.imported && !c.legacy;
  return {
    moderator,
    canEdit: (c) => own(c),
    canDelete: (c) => moderator || own(c) || (c.imported === true && c.importedBy === actor.id),
    canResolve: (c) => c.authorId === actor.id || moderator || actor.role === 'editor',
  };
}

/** The account name stamped on everything a person writes, so nobody can comment under another name. */
const stampName = (actor) => (typeof actor.name === 'string' && actor.name.trim() ? actor.name.trim() : 'Member').slice(0, MAX_NAME);

/**
 * Guards one comments document. `run(actor, fn)` applies a client's sync message (`fn`) and then corrects it; it
 * returns the kinds of change that were undone ('edit', 'delete', 'resolve', 'author', 'other'), for the notice the
 * sender gets. `isAccount(id)` says whether an author id is a current account, for the legacy marks.
 */
export function createCommentGuard(doc, { isAccount = () => true } = {}) {
  const threads = doc.getMap('threads');
  /** threadId -> JSON of the thread as last allowed. */
  const mirror = new Map();
  let touched = null;

  threads.observeDeep((events) => {
    const ids = new Set();
    for (const e of events) {
      if (e.target === threads) e.keysChanged.forEach((k) => ids.add(k));
      else if (e.path.length) ids.add(String(e.path[0]));
    }
    if (touched) ids.forEach((id) => touched.add(id));
    else ids.forEach(refresh); // the relay's own writes (MCP, corrections) are allowed as they are
  });

  function refresh(id) {
    const json = jsonOf(threads.get(id));
    if (json) mirror.set(id, json);
    else mirror.delete(id);
  }

  // Comments from before accounts were turned on carry a device id: mark them legacy (only moderators delete them,
  // nobody edits them). Removed members keep their account-style id and are not marked.
  const isLegacy = (c) => !c.imported && !c.legacy && typeof c.authorId === 'string' && DEVICE_ID.test(c.authorId) && !isAccount(c.authorId);
  doc.transact(() => {
    threads.forEach((m) => {
      if (!(m instanceof Y.Map)) return;
      const t = m.toJSON();
      if (isLegacy(t)) m.set('legacy', true);
      const replies = m.get('replies');
      if (replies instanceof Y.Map) {
        replies.forEach((r, rid) => {
          if (r && typeof r === 'object' && isLegacy(r)) replies.set(rid, { ...r, legacy: true });
        });
      }
    });
  }, AUTHZ_ORIGIN);
  threads.forEach((_, id) => refresh(id));

  /** A thread as a fresh Y.Map, from its JSON. */
  function rebuild(json) {
    const m = new Y.Map();
    for (const [k, v] of Object.entries(json)) if (k !== 'replies') m.set(k, v);
    m.set('replies', new Y.Map(Object.entries(json.replies ?? {})));
    return m;
  }

  /**
   * Checks one new comment (a thread or a reply); returns the fields to rewrite. A board owner's import keeps its
   * authors and is marked imported. Files open as a new board the importer owns, so nobody else may import.
   */
  function checkNew(c, actor) {
    const fix = {};
    if (c.imported === true && actor.role === 'owner') {
      if (c.importedBy !== actor.id) fix.importedBy = actor.id;
      if (typeof c.authorId !== 'string') fix.authorId = '';
      if (c.authorName !== clampName(c.authorName)) fix.authorName = clampName(c.authorName);
    } else {
      if (c.authorId !== actor.id) fix.authorId = actor.id;
      if (c.authorName !== stampName(actor)) fix.authorName = stampName(actor);
      if (c.imported !== undefined) fix.imported = undefined;
      if (c.importedBy !== undefined) fix.importedBy = undefined;
    }
    if (c.legacy !== undefined) fix.legacy = undefined;
    return fix;
  }

  /** Applies the fields from checkNew to a map or a plain value, and says whether anything was rewritten. */
  function applyFix(fix, set, del) {
    for (const [k, v] of Object.entries(fix)) {
      if (v === undefined) del(k);
      else set(k, v);
    }
    return Object.keys(fix).length > 0;
  }

  function checkReplies(before, after, actor, rules, repliesMap, undone) {
    const b = before ?? {};
    const a = after ?? {};
    for (const rid of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const was = b[rid];
      const now = a[rid];
      if (was && !now) {
        if (!rules.canDelete(was)) {
          repliesMap.set(rid, was);
          undone.add('delete');
        }
      } else if (!was && now) {
        if (typeof now !== 'object' || Object.keys(now).some((k) => !REPLY_KEYS.has(k))) {
          repliesMap.delete(rid);
          undone.add('other');
          continue;
        }
        const fix = checkNew(now, actor);
        if (Object.keys(fix).length) {
          const next = { ...now };
          for (const [k, v] of Object.entries(fix)) {
            if (v === undefined) delete next[k];
            else next[k] = v;
          }
          repliesMap.set(rid, next);
          undone.add('author');
        }
      } else if (was && now && !same(was, now)) {
        const onlyText = Object.keys({ ...was, ...now }).every((k) => TEXT.includes(k) || same(was[k], now[k]));
        if (!onlyText) {
          repliesMap.set(rid, was);
          undone.add('other');
        } else if (!rules.canEdit(was)) {
          repliesMap.set(rid, was);
          undone.add('edit');
        }
      }
    }
  }

  /** A thread that did not exist before: its author fields are stamped and its replies checked one by one. */
  function checkNewThread(entry, after, actor, rules, undone) {
    for (const k of Object.keys(after)) {
      if (!THREAD_KEYS.has(k)) {
        entry.delete(k);
        undone.add('other');
      }
    }
    const keepsAuthors = after.imported === true && actor.role === 'owner';
    if (applyFix(checkNew(after, actor), (k, v) => entry.set(k, v), (k) => entry.delete(k))) undone.add('author');
    if (!keepsAuthors && after.resolved === true && after.resolvedBy !== actor.id) {
      entry.set('resolvedBy', actor.id);
      undone.add('author');
    }
    const replies = entry.get('replies');
    if (replies instanceof Y.Map) checkReplies({}, after.replies, actor, rules, replies, undone);
    else {
      if (replies !== undefined) undone.add('other');
      entry.set('replies', new Y.Map());
    }
  }

  function checkThread(id, actor, rules, undone) {
    const before = mirror.get(id);
    const entry = threads.get(id);
    if (entry !== undefined && !(entry instanceof Y.Map)) {
      // not a thread at all: put back what was there, if anything
      if (before) threads.set(id, rebuild(before));
      else threads.delete(id);
      undone.add('other');
      return;
    }
    const after = jsonOf(entry);
    if (!before && !after) return;

    if (!before) {
      checkNewThread(entry, after, actor, rules, undone);
      return;
    }

    if (!after) {
      // a deleted thread: an author takes it down only while nobody else has replied
      const othersReplied = Object.values(before.replies ?? {}).some((r) => r.authorId !== actor.id);
      const allowed = rules.moderator || (rules.canDelete(before) && !(before.authorId === actor.id && othersReplied));
      if (!allowed) {
        threads.set(id, rebuild(before));
        undone.add('delete');
      }
      return;
    }

    // an edited thread
    for (const k of Object.keys(after)) {
      if (!THREAD_KEYS.has(k)) {
        entry.delete(k);
        undone.add('other');
      }
    }
    const changed = (keys) => keys.some((k) => !same(before[k], after[k]));
    const restore = (keys) => {
      for (const k of keys) {
        if (before[k] === undefined) entry.delete(k);
        else entry.set(k, before[k]);
      }
    };
    if (changed(AUTHOR)) {
      restore(AUTHOR);
      undone.add('author');
    }
    if (changed(OTHER_SET_ONCE)) {
      restore(OTHER_SET_ONCE);
      undone.add('other');
    }
    if (changed(TEXT) && !rules.canEdit(before)) {
      restore(TEXT);
      undone.add('edit');
    }
    if (changed(RESOLVE)) {
      if (!rules.canResolve(before)) {
        restore(RESOLVE);
        undone.add('resolve');
      } else if (after.resolved === true && after.resolvedBy !== actor.id) {
        entry.set('resolvedBy', actor.id);
        undone.add('author');
      }
    }
    const replies = entry.get('replies');
    if (!(replies instanceof Y.Map)) {
      // the replies map itself was replaced or removed: put the allowed one back
      entry.set('replies', new Y.Map(Object.entries(before.replies ?? {})));
      undone.add('delete');
    } else {
      checkReplies(before.replies, after.replies, actor, rules, replies, undone);
    }
  }

  /**
   * Clears anything outside `threads`: the comments document has no other top-level content. A top-level type that
   * only arrived in an update is still untyped here, so it is read as a map (keyed content) or an array (a sequence).
   */
  function clearOthers(undone) {
    for (const [name, type] of [...doc.share]) {
      if (name === 'threads') continue;
      let typed = type;
      if (!(type instanceof Y.Map || type instanceof Y.Array || type instanceof Y.Text || type instanceof Y.XmlFragment)) {
        try {
          typed = type._map.size ? doc.getMap(name) : doc.getArray(name);
        } catch {
          continue;
        }
      }
      if (typed instanceof Y.Map && typed.size) {
        [...typed.keys()].forEach((k) => typed.delete(k));
        undone.add('other');
      }
      if ((typed instanceof Y.Array || typed instanceof Y.Text || typed instanceof Y.XmlFragment) && typed.length) {
        typed.delete(0, typed.length);
        undone.add('other');
      }
    }
  }

  return {
    /** Applies `fn` (a client's sync message) as `actor` and corrects it. Returns the kinds of change undone. */
    run(actor, fn) {
      touched = new Set();
      let error = null;
      try {
        fn();
      } catch (err) {
        error = err; // a bad message may still have applied part of an update: correct that part, then report it
      }
      const ids = touched;
      touched = null;
      const undone = new Set();
      const rules = commentRules(actor);
      doc.transact(() => {
        for (const id of ids) checkThread(id, actor, rules, undone);
        clearOthers(undone);
      }, AUTHZ_ORIGIN);
      ids.forEach(refresh);
      if (error) throw error;
      return [...undone];
    },
    /** For tests: the mirror's view of a thread. */
    mirrored: (id) => mirror.get(id),
  };
}
