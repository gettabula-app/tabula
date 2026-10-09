import * as Y from 'yjs';
import { isFeatureKey } from '../shared/containers';
import { Store } from './store';
import type { BaseObj, Id, Label, Obj } from './types';
import { SCHEMA_VERSION } from './types';
import type { BoardRole, Version } from './api';

// Version history (docs/history.md): the pure parts. Opening a snapshot, planning and applying a restore,
// and the small rules the panel shares. Nothing here touches the DOM or the network.

// ---------------------------------------------------------------- snapshots

export interface Snapshot {
  doc: Y.Doc;
  /** Read-only store over the snapshot, for the preview and for comparing with the live board. */
  store: Store;
  schemaVersion: number;
}

/** A throwaway document built from a version's state. It has no provider and no persistence, so the live board never sees it. */
export function openSnapshot(bytes: Uint8Array): Snapshot {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const store = new Store(doc);
  store.setReadOnly(true);
  return { doc, store, schemaVersion: store.getMeta().schemaVersion };
}

/** Versions are immutable, so the last few downloaded states are kept for flipping between them. */
export function createStateCache(max = 5) {
  const states = new Map<string, Uint8Array>();
  return {
    get(id: string): Uint8Array | undefined {
      const hit = states.get(id);
      if (hit) {
        states.delete(id);
        states.set(id, hit);
      }
      return hit;
    },
    set(id: string, bytes: Uint8Array) {
      states.delete(id);
      states.set(id, bytes);
      if (states.size > max) states.delete(states.keys().next().value as string);
    },
  };
}

// ---------------------------------------------------------------- private writing

/**
 * Whether private writing hides this object from this person right now. It restates Flow.isHidden (which needs a
 * BoardApp) and reads the live board's `reveal`, so history never shows more than the board does.
 */
export function isHiddenNow(o: Obj, userId: string, liveReveal: boolean): boolean {
  return o.type === 'sticky' && !!(o as BaseObj).privateStep && o.createdBy !== userId && !liveReveal;
}

// ---------------------------------------------------------------- restore

export interface ObjectChange {
  id: Id;
  set: Record<string, unknown>;
  unset: string[];
}

export interface RestoreSummary {
  added: number;
  removed: number;
  changed: number;
  /** Board settings (grid, fonts, sticky colours, labels) differ. */
  meta: boolean;
}

export interface RestorePlan {
  add: Obj[];
  remove: Id[];
  change: ObjectChange[];
  meta: { set: Record<string, unknown>; unset: string[] };
  /** The board's label set, so a restored card gets back the labels it points at. */
  labels: { set: Record<Id, Label>; remove: Id[] };
  summary: RestoreSummary;
  /** The snapshot already matches the live board. */
  empty: boolean;
}

/**
 * The board title is the board's identity in the home list and the directory; the schema version is the format's. What
 * the board needs (`feature:` keys) is kept too: it is only ever added, and applyRestore recomputes it from the objects.
 */
const KEPT_META = new Set(['name', 'schemaVersion']);
const kept = (key: string) => KEPT_META.has(key) || isFeatureKey(key);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(v: T): T => structuredClone(v);

/** An object whose only difference is `updatedAt` is not changed; a changed one takes every snapshot field, `updatedAt` too. */
function diffObject(cur: Obj, want: Obj): { set: Record<string, unknown>; unset: string[] } | null {
  const a = cur as unknown as Record<string, unknown>;
  const b = want as unknown as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  let real = false;
  for (const k of Object.keys(b)) {
    if (same(a[k], b[k])) continue;
    set[k] = clone(b[k]);
    if (k !== 'updatedAt') real = true;
  }
  for (const k of Object.keys(a)) {
    if (k in b) continue;
    unset.push(k);
    if (k !== 'updatedAt') real = true;
  }
  return real ? { set, unset } : null;
}

/**
 * What it takes to make the live board's objects and settings equal the snapshot's. Hidden objects (private
 * writing) are left alone in both directions. `flow`, `votes`, the comments and the board title are not part of it.
 */
export function planRestore(live: Store, snap: Store, opts: { isHidden: (o: Obj) => boolean }): RestorePlan {
  const add: Obj[] = [];
  const remove: Id[] = [];
  const change: ObjectChange[] = [];
  for (const [id, cur] of live.cache) {
    if (opts.isHidden(cur)) continue;
    const want = snap.cache.get(id);
    if (!want) {
      remove.push(id);
      continue;
    }
    if (opts.isHidden(want)) continue;
    const d = diffObject(cur, want);
    if (d) change.push({ id, ...d });
  }
  for (const [id, want] of snap.cache) {
    if (!live.cache.has(id) && !opts.isHidden(want)) add.push(clone(want));
  }

  const meta = { set: {} as Record<string, unknown>, unset: [] as string[] };
  const liveMeta = live.meta.toJSON() as Record<string, unknown>;
  const snapMeta = snap.meta.toJSON() as Record<string, unknown>;
  for (const [k, v] of Object.entries(snapMeta)) if (!kept(k) && !same(liveMeta[k], v)) meta.set[k] = clone(v);
  for (const k of Object.keys(liveMeta)) if (!kept(k) && !(k in snapMeta)) meta.unset.push(k);

  const labels = { set: {} as Record<Id, Label>, remove: [] as Id[] };
  snap.labels.forEach((v, k) => {
    if (!same(live.labels.get(k), v)) labels.set[k] = clone(v);
  });
  live.labels.forEach((_, k) => {
    if (!snap.labels.has(k)) labels.remove.push(k);
  });

  const summary: RestoreSummary = {
    added: add.length,
    removed: remove.length,
    changed: change.length,
    meta: Object.keys(meta.set).length > 0 || meta.unset.length > 0 || Object.keys(labels.set).length > 0 || labels.remove.length > 0,
  };
  return { add, remove, change, meta, labels, summary, empty: !summary.added && !summary.removed && !summary.changed && !summary.meta };
}

/**
 * One undo step, one transaction with the board's own origin: it syncs like any edit and a read-only store runs
 * nothing. Raw Y.Map writes, not Store.update, which would stamp `updatedAt` and make the result differ from the snapshot.
 */
export function applyRestore(live: Store, plan: RestorePlan): void {
  if (plan.empty) return;
  live.undo.stopCapturing();
  live.transact(() => {
    for (const id of plan.remove) live.objects.delete(id);
    for (const o of plan.add) live.create(o);
    for (const c of plan.change) {
      const m = live.objects.get(c.id);
      if (!m) continue;
      for (const k of c.unset) m.delete(k);
      for (const [k, v] of Object.entries(c.set)) m.set(k, v);
    }
    for (const k of plan.meta.unset) live.meta.delete(k);
    for (const [k, v] of Object.entries(plan.meta.set)) live.meta.set(k, v);
    for (const k of plan.labels.remove) live.labels.delete(k);
    for (const [k, v] of Object.entries(plan.labels.set)) live.labels.set(k, v);
    // objects were written below `create` (a changed type, an added object whose snapshot predates the flag)
    live.syncFeatures();
  });
  live.undo.stopCapturing();
}

export type RestoreBlockReason = 'workspace-read-only' | 'read-only' | 'session' | 'newer-schema';

const BLOCK_TEXT: Record<RestoreBlockReason, string> = {
  'workspace-read-only': 'This workspace is read-only, so a version cannot be restored.',
  'read-only': 'You can only view this board, so a version cannot be restored.',
  session: 'Finish the running session before restoring a version.',
  'newer-schema': 'This version was saved by a newer version of the app. Update the app to restore it.',
};

/** Why Restore is disabled, if it is. */
export function restoreBlock(s: { readOnly: boolean; workspaceReadOnly: boolean; sessionActive: boolean; snapshotSchema: number }): { reason: RestoreBlockReason; message: string } | null {
  const reason: RestoreBlockReason | null = s.workspaceReadOnly ? 'workspace-read-only'
    : s.readOnly ? 'read-only'
    : s.sessionActive ? 'session'
    : s.snapshotSchema > SCHEMA_VERSION ? 'newer-schema'
    : null;
  return reason ? { reason, message: BLOCK_TEXT[reason] } : null;
}

export function summaryText(s: RestoreSummary): string {
  const parts: string[] = [];
  if (s.added) parts.push(`adds ${s.added}`);
  if (s.changed) parts.push(`changes ${s.changed}`);
  if (s.removed) parts.push(`removes ${s.removed}`);
  const items = s.added + s.changed + s.removed;
  if (!items) return s.meta ? 'Restoring changes the board settings' : 'Restoring changes nothing';
  return `Restoring ${parts.join(', ')} ${items === 1 ? 'item' : 'items'}${s.meta ? ' and the board settings' : ''}`;
}

// ---------------------------------------------------------------- who may do what

export interface Who {
  /** Null in open mode, where there are no roles and everyone is an owner. */
  role: BoardRole | null;
  userId: string | null;
}

/** Owners and editors see history; so does open mode (no role). Commenters and viewers do not. */
export function canSeeHistory(role: BoardRole | null): boolean {
  return role === null || role === 'owner' || role === 'editor';
}

const isOwner = (w: Who) => w.role === null || w.role === 'owner';

/** Naming an unnamed version: any editor. Renaming a named one: its creator or the owner. */
export function canRename(v: Version, w: Who): boolean {
  if (!canSeeHistory(w.role)) return false;
  return v.kind !== 'named' || isOwner(w) || (w.userId !== null && v.by === w.userId);
}

/** The owner deletes any version; an editor only a named version they created. */
export function canDelete(v: Version, w: Who): boolean {
  if (!canSeeHistory(w.role)) return false;
  return isOwner(w) || (v.kind === 'named' && w.userId !== null && v.by === w.userId);
}

/** History lives on the relay that serves the app: not with sync off, and not with a relay on another address. */
export function historyOffline(relaySetting: string, relay: string | null): boolean {
  return relaySetting !== 'auto' || relay === null;
}

// ---------------------------------------------------------------- the list

export type VersionFilter = 'all' | 'named';

export function filterVersions(versions: Version[], filter: VersionFilter): Version[] {
  return filter === 'named' ? versions.filter((v) => v.kind === 'named') : versions;
}

export function versionTitle(v: Version): string {
  if (v.label) return v.label;
  if (v.kind === 'pre-restore') return 'Before restore';
  if (v.kind === 'restore') return 'Restored a version';
  return 'Automatic version';
}

/** How many objects each version has more (or fewer) than the next older one; null for the oldest. Input is newest first. */
export function objectDeltas(versions: Version[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  versions.forEach((v, i) => out.set(v.id, i + 1 < versions.length ? v.objects - versions[i + 1].objects : null));
  return out;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function dayLabel(t: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

/** Versions (newest first) in runs under one day heading. */
export function groupByDay(versions: Version[], now: number): { label: string; items: Version[] }[] {
  const groups: { label: string; items: Version[] }[] = [];
  for (const v of versions) {
    const label = dayLabel(v.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(v);
    else groups.push({ label, items: [v] });
  }
  return groups;
}

export const fmtClock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export const fmtStamp = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
