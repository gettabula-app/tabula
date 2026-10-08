import * as Y from 'yjs';
import type { BaseObj, Obj, Point } from './types';
import { isBox } from './types';
import { center, rotate } from './geometry';
import { newId } from './store';

export interface Author { id: string; name: string; color: string }
export interface Anchor { x: number; y: number; obj?: string; fx?: number; fy?: number }
/** Who is deleting: their author id, and whether they moderate the board (the board owner). */
export interface Actor { id: string; moderator: boolean }

/** `imported` and `importedBy` mark comments from a file (kept as they were written); `legacy` marks comments from before accounts. */
export interface Reply {
  id: string; authorId: string; authorName: string; authorColor: string; text: string; createdAt: number; editedAt?: number;
  imported?: boolean; importedBy?: string; legacy?: boolean;
}
export interface Thread {
  id: string; createdAt: number; authorId: string; authorName: string; authorColor: string; text: string; editedAt?: number;
  anchor: Anchor; resolved: boolean; resolvedBy?: string; resolvedAt?: number; replies: Reply[];
  imported?: boolean; importedBy?: string; legacy?: boolean;
}

/** Transaction origin for comment writes. Never LOCAL, so the board's undo history cannot reach comments. */
export const COMMENTS_ORIGIN = 'comments';

const MAX_TEXT = 4000;
const MAX_NAME = 80;

const cleanText = (text: unknown): string | null => {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return t.length >= 1 && t.length <= MAX_TEXT ? t : null;
};

const cleanName = (name: unknown): string => (typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '');

const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);

/** Absolute and fractional coordinates must be real numbers; the fractions are optional. */
function validAnchor(a: Anchor): boolean {
  if (!finite(a.x) || !finite(a.y)) return false;
  if (a.fx !== undefined && !finite(a.fx)) return false;
  return a.fy === undefined || finite(a.fy);
}

function cleanAnchor(a: Anchor): Anchor {
  const out: Anchor = { x: a.x, y: a.y };
  if (a.obj !== undefined) out.obj = a.obj;
  if (a.fx !== undefined) out.fx = a.fx;
  if (a.fy !== undefined) out.fy = a.fy;
  return out;
}

/**
 * Whether `actor` may delete a comment; the relay applies the same rule (docs/comment-authz.md). A moderator deletes
 * anything. Imported comments belong to whoever imported them, and a legacy comment to nobody but a moderator.
 */
export function mayDelete(c: { authorId?: string; imported?: boolean; importedBy?: string; legacy?: boolean }, actor: Actor): boolean {
  if (actor.moderator) return true;
  if (c.imported === true) return c.importedBy === actor.id;
  return c.authorId === actor.id && c.legacy !== true;
}

const byTime = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A thread entry; undefined fields are left out so the document never stores them. */
function threadMap(fields: Omit<Thread, 'replies'>, replies: Reply[]): Y.Map<unknown> {
  const m = new Y.Map<unknown>(Object.entries(fields).filter(([, v]) => v !== undefined));
  m.set('replies', new Y.Map<Reply>(replies.map((r): [string, Reply] => [r.id, r])));
  return m;
}

function readThread(m: Y.Map<unknown>): Thread {
  const raw = m.toJSON() as Omit<Thread, 'replies'> & { replies?: Record<string, Reply> };
  return {
    ...raw,
    anchor: { ...raw.anchor },
    replies: Object.values(raw.replies ?? {}).map((r) => ({ ...r })).sort(byTime),
  };
}

/**
 * Threads and replies for one board. Lives in its own Y.Doc (the comments document), so a
 * commenter can write here while only reading the board document.
 */
export class Comments {
  readonly threads: Y.Map<Y.Map<unknown>>;
  private readOnlyListeners = new Set<(v: boolean) => void>();
  private changeListeners = new Set<() => void>();
  private _readOnly = false;
  private changePending = false;

  constructor(readonly doc: Y.Doc) {
    this.threads = doc.getMap('threads');
    this.threads.observeDeep(() => this.scheduleChange());
  }

  readOnly(): boolean {
    return this._readOnly;
  }

  setReadOnly(v: boolean): void {
    if (v === this._readOnly) return;
    this._readOnly = v;
    this.readOnlyListeners.forEach((l) => l(v));
  }

  onReadOnly(fn: (v: boolean) => void): () => void {
    this.readOnlyListeners.add(fn);
    return () => {
      this.readOnlyListeners.delete(fn);
    };
  }

  /** Fires after local and remote changes; several changes in one tick give one call. */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  list(): Thread[] {
    const out: Thread[] = [];
    this.threads.forEach((m) => out.push(readThread(m)));
    return out.sort(byTime);
  }

  get(id: string): Thread | undefined {
    const m = this.threads.get(id);
    return m ? readThread(m) : undefined;
  }

  counts(): { open: number; resolved: number } {
    let open = 0, resolved = 0;
    this.threads.forEach((m) => {
      if (m.get('resolved') === true) resolved++;
      else open++;
    });
    return { open, resolved };
  }

  addThread(author: Author, anchor: Anchor, text: string): string | null {
    const body = cleanText(text);
    if (this._readOnly || !body || !validAnchor(anchor)) return null;
    const id = newId();
    this.transact(() => {
      this.threads.set(id, threadMap({
        id, createdAt: Date.now(), authorId: author.id, authorName: cleanName(author.name), authorColor: author.color,
        text: body, anchor: cleanAnchor(anchor), resolved: false,
      }, []));
    });
    return id;
  }

  reply(threadId: string, author: Author, text: string): string | null {
    const body = cleanText(text);
    const replies = this.repliesOf(threadId);
    if (this._readOnly || !body || !replies) return null;
    const id = newId();
    this.transact(() => {
      replies.set(id, {
        id, authorId: author.id, authorName: cleanName(author.name), authorColor: author.color, text: body, createdAt: Date.now(),
      });
    });
    return id;
  }

  editThread(threadId: string, text: string): boolean {
    const body = cleanText(text);
    const t = this.threads.get(threadId);
    if (this._readOnly || !body || !t) return false;
    this.transact(() => {
      t.set('text', body);
      t.set('editedAt', Date.now());
    });
    return true;
  }

  editReply(threadId: string, replyId: string, text: string): boolean {
    const body = cleanText(text);
    const replies = this.repliesOf(threadId);
    const r = replies?.get(replyId);
    if (this._readOnly || !body || !replies || !r) return false;
    this.transact(() => {
      replies.set(replyId, { ...r, text: body, editedAt: Date.now() });
    });
    return true;
  }

  setResolved(threadId: string, resolved: boolean, by: Author): boolean {
    const t = this.threads.get(threadId);
    if (this._readOnly || !t) return false;
    this.transact(() => {
      t.set('resolved', resolved);
      if (resolved) {
        t.set('resolvedBy', by.id);
        t.set('resolvedAt', Date.now());
      } else {
        t.delete('resolvedBy');
        t.delete('resolvedAt');
      }
    });
    return true;
  }

  /**
   * Deletes a thread. Only its author or a moderator (the board owner) may; an author cannot take other people's
   * replies down with their own comment, so for them the thread must have no replies by anyone else.
   */
  removeThread(threadId: string, actor: Actor): boolean {
    const t = this.threads.get(threadId);
    if (this._readOnly || !t) return false;
    if (!mayDelete(t.toJSON(), actor)) return false;
    if (!actor.moderator && t.get('authorId') === actor.id) {
      const others = [...(this.repliesOf(threadId)?.values() ?? [])].some((r) => r.authorId !== actor.id);
      if (others) return false;
    }
    this.transact(() => this.threads.delete(threadId));
    return true;
  }

  /** Deletes a reply. Only its author, whoever imported it, or a moderator (the board owner) may. */
  removeReply(threadId: string, replyId: string, actor: Actor): boolean {
    const replies = this.repliesOf(threadId);
    const r = replies?.get(replyId);
    if (this._readOnly || !replies || !r) return false;
    if (!mayDelete(r, actor)) return false;
    this.transact(() => replies.delete(replyId));
    return true;
  }

  /**
   * Adds threads from a JSON export. Threads whose id already exists are skipped; invalid ones too. The authors stay as
   * they were written, and the threads and replies are marked imported by `importedBy` (docs/comment-authz.md).
   */
  importThreads(threads: Thread[], importedBy: string): number {
    if (this._readOnly) return 0;
    let added = 0;
    this.transact(() => {
      for (const t of threads) {
        const text = cleanText(t.text);
        if (typeof t.id !== 'string' || !t.id || this.threads.has(t.id) || !text) continue;
        if (!finite(t.createdAt) || !t.anchor || !validAnchor(t.anchor)) continue;
        const replies: Reply[] = [];
        for (const r of t.replies ?? []) {
          const rt = cleanText(r.text);
          if (typeof r.id === 'string' && r.id && rt) replies.push({ ...r, authorName: cleanName(r.authorName), text: rt, imported: true, importedBy });
        }
        this.threads.set(t.id, threadMap({
          id: t.id, createdAt: t.createdAt, authorId: t.authorId, authorName: cleanName(t.authorName), authorColor: t.authorColor,
          text, editedAt: t.editedAt, anchor: cleanAnchor(t.anchor), resolved: t.resolved === true,
          resolvedBy: t.resolvedBy, resolvedAt: t.resolvedAt, imported: true, importedBy,
        }, replies));
        added++;
      }
    });
    return added;
  }

  /**
   * Applies the comments document of a .drift file in one change, marking the threads it adds (and their replies)
   * imported, so they reach the relay already marked. Threads that already exist here are left alone.
   */
  importUpdate(update: Uint8Array, importedBy: string): void {
    if (this._readOnly) return;
    this.transact(() => {
      const known = new Set(this.threads.keys());
      Y.applyUpdate(this.doc, update);
      this.threads.forEach((m, id) => {
        if (known.has(id) || !(m instanceof Y.Map)) return;
        m.set('imported', true);
        m.set('importedBy', importedBy);
        const replies = m.get('replies');
        if (!(replies instanceof Y.Map)) return;
        replies.forEach((r, rid) => replies.set(rid, { ...(r as Reply), imported: true, importedBy }));
      });
    });
  }

  private repliesOf(threadId: string): Y.Map<Reply> | undefined {
    const r = this.threads.get(threadId)?.get('replies');
    return r instanceof Y.Map ? (r as Y.Map<Reply>) : undefined;
  }

  private transact(fn: () => void) {
    this.doc.transact(fn, COMMENTS_ORIGIN);
  }

  private scheduleChange() {
    if (this.changePending) return;
    this.changePending = true;
    queueMicrotask(() => {
      this.changePending = false;
      this.changeListeners.forEach((l) => l());
    });
  }
}

// ---------------------------------------------------------------- notices

const NOTICE_TEXT: Record<string, string> = {
  edit: 'Only the author can edit a comment, so that edit was undone.',
  delete: 'Only the author or a moderator (a board owner or admin) can delete a comment, so that delete was undone.',
  resolve: 'Only the author or a board editor can resolve a comment, so that change was undone.',
  author: 'Comments are posted under your own account name, so that was corrected.',
  other: 'That change to the comments is not allowed, so it was undone.',
};

/** What the relay's notice says, for the kinds it undid (docs/comment-authz.md). */
export function commentNoticeText(undone: readonly string[]): string {
  const lines = [...new Set(undone)].map((k) => NOTICE_TEXT[k]).filter((s): s is string => s !== undefined);
  return lines.join(' ') || 'A change to the comments was undone.';
}

// ---------------------------------------------------------------- anchors

/**
 * The anchor for a pin at `point`. On an object, the point is stored as a fraction of the
 * object's unrotated width and height, so the pin follows the object through moves, resizes and rotations.
 */
export function anchorFor(point: Point, obj: BaseObj | undefined): Anchor {
  if (!obj) return { x: point.x, y: point.y };
  const q = rotate(point, center(obj), -(obj.rotation || 0));
  return {
    x: point.x,
    y: point.y,
    obj: obj.id,
    fx: obj.w ? (q.x - obj.x) / obj.w : 0.5,
    fy: obj.h ? (q.y - obj.y) / obj.h : 0.5,
  };
}

/** Where the pin is now: on its object as it is now, or at the stored absolute position when the object is gone. */
export function anchorPosition(a: Anchor, get: (id: string) => Obj | undefined): Point {
  const o = a.obj === undefined ? undefined : get(a.obj);
  if (!isBox(o) || a.fx === undefined || a.fy === undefined) return { x: a.x, y: a.y };
  return rotate({ x: o.x + a.fx * o.w, y: o.y + a.fy * o.h }, center(o), o.rotation || 0);
}

/** False when the thread's object is hidden by private writing, so its thread cannot be opened. */
export function threadVisible(t: Thread, get: (id: string) => Obj | undefined, isHidden: (o: BaseObj) => boolean): boolean {
  const o = t.anchor.obj === undefined ? undefined : get(t.anchor.obj);
  return !(isBox(o) && isHidden(o));
}
