import * as Y from 'yjs';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { FEATURES, featureKey, isContainerType, layoutContainer, orphanHome, unknownFeatures, type ContainerLayout } from '../shared/containers';
import type { BoardMeta, ConnectorObj, Id, Label, Obj, Poll, PollAnswer, Rect, Step, Timer, Vote } from './types';
import { SCHEMA_VERSION, isConnector } from './types';

/** Transaction origin for edits made on this device; only these are undoable. */
export const LOCAL = 'local';

export type ChangeListener = (changed: Set<Id>) => void;

export const DEFAULT_META: BoardMeta = {
  name: 'Untitled board',
  schemaVersion: SCHEMA_VERSION,
  gridType: 'dots',
  gridSize: 24,
  snap: true,
  headingFont: 'cabinet-grotesk',
  bodyFont: 'satoshi',
  stickyColors: [],
};

export interface FlowState {
  steps: Step[];
  active: number;          // -1 when no session is running
  timer: Timer | null;
  reveal: boolean;
  focus: { x: number; y: number; zoom: number; ts: number; by: string } | null;
  stepStartedAt: number;
  /** Vote step whose dots stay on the board after the session ends. */
  results: Id | null;
}

/** Ids whose rectangle differs between two layouts of one container. With no earlier layout to compare, all of them. */
function movedBetween(before: ContainerLayout | null | undefined, after: ContainerLayout | null): Id[] {
  const out: Id[] = [];
  for (const [id, r] of after?.rects ?? []) {
    const was = before?.rects.get(id);
    if (!was || was.x !== r.x || was.y !== r.y || was.w !== r.w || was.h !== r.h) out.push(id);
  }
  for (const id of before?.rects.keys() ?? []) if (!after?.rects.has(id)) out.push(id);
  return out;
}

const cmpZ = (a: Obj, b: Obj) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1);

/**
 * Wraps one board's Y.Doc. Keeps a plain-object cache of every board object so
 * rendering and hit-testing never touch Yjs types directly.
 */
export class Store {
  readonly doc: Y.Doc;
  readonly objects: Y.Map<Y.Map<unknown>>;
  readonly meta: Y.Map<unknown>;
  readonly flow: Y.Map<unknown>;
  readonly votes: Y.Map<Vote>;
  readonly polls: Y.Map<Poll>;
  readonly pollAnswers: Y.Map<PollAnswer>;
  /** A poll's changing fields, one key each (`${pollId}:revealed`), so concurrent changes merge. See polls.ts. */
  readonly pollState: Y.Map<unknown>;
  /** Board-wide labels for cards (docs/kanban.md), whole value per label. */
  readonly labels: Y.Map<Label>;
  readonly cache = new Map<Id, Obj>();
  readonly undo: Y.UndoManager;

  private listeners = new Set<ChangeListener>();
  private readOnlyListeners = new Set<(v: boolean) => void>();
  private _readOnly = false;
  private orderDirty = true;
  private orderCache: Obj[] = [];
  private shownCache: Obj[] | null = null;
  private boundIndex = new Map<Id, Set<Id>>(); // shape id -> connector ids
  private childIndex = new Map<Id, Set<Id>>(); // parent id -> child ids
  private containerIds = new Set<Id>();
  // Derived geometry (docs/kanban.md): one layout per container, dropped when something inside it changes.
  private layouts = new Map<Id, ContainerLayout | null>();
  private placedCache = new WeakMap<Obj, { rect: Rect; obj: Obj }>();
  // Cards whose lane is gone have no container of their own, so they go to one home for everybody (see orphanHome).
  private orphanIds: Id[] = [];
  private orphanHome: Id | null = null;
  private orphanSig = '';

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.objects = doc.getMap('objects');
    this.meta = doc.getMap('meta');
    this.flow = doc.getMap('flow');
    this.votes = doc.getMap('votes');
    this.polls = doc.getMap('polls');
    this.pollAnswers = doc.getMap('pollAnswers');
    this.pollState = doc.getMap('pollState');
    this.labels = doc.getMap('labels');

    this.objects.forEach((m, id) => this.cache.set(id, m.toJSON() as Obj));
    this.rebuildBoundIndex();
    this.rebuildChildIndex();
    this.refreshOrphans();

    this.objects.observeDeep((events) => {
      const changed = new Set<Id>();
      for (const e of events) {
        if (e.target === this.objects) {
          for (const k of e.changes.keys.keys()) changed.add(k);
        } else if (e.path.length > 0) {
          changed.add(String(e.path[0]));
        }
      }
      const edits: [Obj | undefined, Obj | undefined][] = [];
      for (const id of changed) {
        const prev = this.cache.get(id);
        if (isConnector(prev)) this.unindexConnector(prev);
        this.unindexChild(prev);
        if (prev?.type === 'container') this.containerIds.delete(id);
        const m = this.objects.get(id);
        let next: Obj | undefined;
        if (m) {
          next = m.toJSON() as Obj;
          this.cache.set(id, next);
          if (isConnector(next)) this.indexConnector(next);
          this.indexChild(next);
          if (next.type === 'container') this.containerIds.add(id);
        } else {
          this.cache.delete(id);
        }
        edits.push([prev, next]);
      }
      // What moved or resized because of its container is reported as changed too, so drawing and bounds follow.
      for (const [cid, before] of this.dropLayouts(edits)) {
        const after = this.containerLayout(cid);
        // no layout to compare with (a container removed before it was ever laid out): everything inside is reported
        const moved = before === undefined && !after ? this.membersOf(cid) : movedBetween(before, after);
        for (const id of moved) changed.add(id);
      }
      this.orderDirty = true;
      this.shownCache = null;
      this.listeners.forEach((l) => l(changed));
    });

    this.undo = new Y.UndoManager([this.objects, this.meta, this.labels], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 350,
    });
  }

  onChange(l: ChangeListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get readOnly(): boolean {
    return this._readOnly;
  }

  setReadOnly(v: boolean) {
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

  /** Every local write goes through transact or transactAs, so a read-only store cannot write. */
  transact(fn: () => void) {
    this.transactAs(fn, LOCAL);
  }

  transactAs(fn: () => void, origin: string) {
    if (this._readOnly) return;
    this.doc.transact(fn, origin);
  }

  get(id: Id | undefined): Obj | undefined {
    return id ? this.cache.get(id) : undefined;
  }

  /**
   * All objects in paint order: frames first, then by z. A container is painted as a unit at its own z (the container,
   * its lanes, then each lane's cards), so what is laid out inside it has no z of its own.
   */
  ordered(): Obj[] {
    if (this.orderDirty) {
      const all = [...this.cache.values()];
      const frames = all.filter((o) => o.type === 'frame').sort(cmpZ);
      const rest = all.filter((o) => o.type !== 'frame' && !this.isLaidOut(o)).sort(cmpZ);
      const out = [...frames];
      for (const o of rest) {
        out.push(o);
        if (o.type !== 'container') continue;
        for (const id of this.containerLayout(o.id)?.order ?? []) {
          const child = this.cache.get(id);
          if (child) out.push(child);
        }
      }
      this.orderCache = out;
      this.orderDirty = false;
    }
    return this.orderCache;
  }

  /**
   * Whether an object is drawn (TAB-198): not hidden, not inside a hidden frame or container, and for a connector, neither
   * bound end hidden, so no line is left pointing at nothing. Hidden is for everyone and is not private.
   */
  isShown(o: Obj): boolean {
    if (o.hidden === true) return false;
    const seen = new Set<Id>([o.id]);
    for (let p = o.parent ? this.cache.get(o.parent) : undefined; p && !seen.has(p.id); p = p.parent ? this.cache.get(p.parent) : undefined) {
      if (p.hidden === true) return false;
      seen.add(p.id);
    }
    if (isConnector(o)) {
      for (const end of [o.from, o.to]) {
        if (end.kind !== 'bound') continue;
        const at = this.cache.get(end.id);
        if (at && at.type !== 'connector' && !this.isShown(at)) return false;
      }
    }
    return true;
  }

  /** `ordered()` without what is hidden: what the canvas draws, hits, selects, snaps to and exports. */
  shown(): Obj[] {
    this.shownCache ??= this.ordered().filter((o) => this.isShown(o));
    return this.shownCache;
  }

  topZ(): string {
    const ord = this.ordered();
    let max: string | null = null;
    for (const o of ord) if (max === null || o.z > max) max = o.z;
    return generateKeyBetween(max, null);
  }

  /** `n` ascending keys above everything on the board. */
  topZs(n: number): string[] {
    let max: string | null = null;
    for (const o of this.cache.values()) if (max === null || o.z > max) max = o.z;
    return generateNKeysBetween(max, null, n);
  }

  bottomZ(): string {
    let min: string | null = null;
    for (const o of this.cache.values()) if (min === null || o.z < min) min = o.z;
    return generateKeyBetween(null, min);
  }

  /** `n` ascending keys below everything on the board. */
  bottomZs(n: number): string[] {
    let min: string | null = null;
    for (const o of this.cache.values()) if (min === null || o.z < min) min = o.z;
    return generateNKeysBetween(null, min, n);
  }

  /** Writes new stacking keys in one step (one undo step). Returns whether anything was written. */
  restack(patches: { id: Id; z: string }[] | null): boolean {
    if (!patches?.length || this._readOnly) return false;
    this.transact(() => patches.forEach((p) => this.update(p.id, { z: p.z })));
    return true;
  }

  /** Put the given objects above everything else, keeping their order among themselves. */
  bringToFront(ids: Iterable<Id>) {
    const set = new Set(ids);
    const sel = this.ordered().filter((o) => set.has(o.id) && !this.isLaidOut(o));
    if (!sel.length) return;
    const zs = this.topZs(sel.length);
    this.transact(() => sel.forEach((o, i) => this.update(o.id, { z: zs[i] })));
  }

  /** Put the given objects below everything else, keeping their order among themselves. */
  sendToBack(ids: Iterable<Id>) {
    const set = new Set(ids);
    const sel = this.ordered().filter((o) => set.has(o.id) && !this.isLaidOut(o));
    if (!sel.length) return;
    const zs = this.bottomZs(sel.length);
    this.transact(() => sel.forEach((o, i) => this.update(o.id, { z: zs[i] })));
  }

  create(o: Obj) {
    const entries = Object.entries(o).filter(([, v]) => v !== undefined);
    this.objects.set(o.id, new Y.Map(entries));
    if (isContainerType(o.type)) this.needFeature(FEATURES.containers);
  }

  update(id: Id, patch: Partial<Obj> | Record<string, unknown>) {
    const m = this.objects.get(id);
    if (!m) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        if (m.has(k)) m.delete(k);
        continue;
      }
      const cur = m.get(k);
      if (typeof v === 'object' ? JSON.stringify(cur) !== JSON.stringify(v) : cur !== v) m.set(k, v);
    }
    if (m.size) m.set('updatedAt', Date.now());
    const type = (patch as Record<string, unknown>).type;
    if (typeof type === 'string' && isContainerType(type)) this.needFeature(FEATURES.containers);
  }

  remove(ids: Iterable<Id>) {
    for (const id of ids) this.objects.delete(id);
  }

  /** Connectors whose ends are bound to the given object. */
  connectorsOf(id: Id): ConnectorObj[] {
    const set = this.boundIndex.get(id);
    if (!set) return [];
    const out: ConnectorObj[] = [];
    for (const cid of set) {
      const c = this.cache.get(cid);
      if (isConnector(c)) out.push(c);
    }
    return out;
  }

  childrenOf(parentId: Id): Obj[] {
    const out: Obj[] = [];
    for (const id of this.childIndex.get(parentId) ?? []) {
      const o = this.cache.get(id);
      if (o) out.push(o);
    }
    return out;
  }

  /** The layout of a container and everything in it; null when it is not a container or its layout is unknown. */
  containerLayout(id: Id): ContainerLayout | null {
    const c = this.cache.get(id);
    if (c?.type !== 'container') return null;
    let layout = this.layouts.get(id);
    if (layout === undefined) {
      // a hidden lane or card (TAB-198) leaves the layout, so the board closes up around it
      const lanes = this.childrenOf(id).filter((o) => o.type === 'lane' && o.hidden !== true);
      const cards = lanes.flatMap((l) => this.childrenOf(l.id).filter((o) => o.type === 'card' && o.hidden !== true));
      if (this.orphanHome === id) for (const oid of this.orphanIds) if (this.cache.get(oid)!.hidden !== true) cards.push(this.cache.get(oid)!);
      layout = layoutContainer(c, lanes, cards);
      this.layouts.set(id, layout);
    }
    return layout;
  }

  /** The layout that places this object, if one does. */
  private layoutOf(o: Obj): ContainerLayout | null {
    if (o.type === 'container') return this.containerLayout(o.id);
    if (o.type === 'lane') return o.parent ? this.containerLayout(o.parent) : null;
    if (o.type !== 'card' || o.parent === undefined) return null;
    const parent = this.cache.get(o.parent);
    if (parent) return parent.type === 'lane' && parent.parent ? this.containerLayout(parent.parent) : null;
    return this.orphanHome ? this.containerLayout(this.orphanHome) : null;
  }

  /** Whether the object's rectangle comes from a container's layout, so its stored x, y, w and h are not read. */
  isLaidOut(o: Obj): boolean {
    return (o.type === 'lane' || o.type === 'card') && !!this.layoutOf(o)?.rects.has(o.id);
  }

  /** Where the object is: derived for a container's size and for what is laid out in it, stored for everything else. */
  geometry(o: Obj): Rect {
    const r = isContainerType(o.type) ? this.layoutOf(o)?.rects.get(o.id) : undefined;
    return r ?? { x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 };
  }

  /** The object as it is drawn: itself, or for a container and what it lays out a copy with the derived rectangle. */
  placed<T extends Obj>(o: T): T {
    if (!isContainerType(o.type)) return o;
    const rect = this.layoutOf(o)?.rects.get(o.id);
    if (!rect) return o;
    const hit = this.placedCache.get(o);
    if (hit?.rect === rect) return hit.obj as T;
    const obj = { ...o, ...rect, rotation: 0 };
    const entry = { rect, obj };
    this.placedCache.set(o, entry);
    this.placedCache.set(obj, entry);
    return obj;
  }

  getPlaced(id: Id | undefined): Obj | undefined {
    const o = this.get(id);
    return o && this.placed(o);
  }

  /** Board features this client does not know: when there are any, the board must not be edited from here. */
  unsupportedFeatures(): string[] {
    return unknownFeatures(this.meta.toJSON());
  }

  private needFeature(name: string) {
    const key = featureKey(name);
    if (this.meta.get(key) !== true) this.meta.set(key, true);
  }

  /**
   * Lists `containers` as needed if the board holds a container, lane or card. For writers that change objects without
   * `create` and `update`, such as a restore; the flag is only ever added, never taken away.
   */
  syncFeatures() {
    for (const m of this.objects.values()) {
      if (isContainerType(String(m.get('type')))) return this.needFeature(FEATURES.containers);
    }
  }

  getMeta(): BoardMeta {
    const raw = this.meta.toJSON() as Partial<BoardMeta>;
    return { ...DEFAULT_META, ...raw };
  }

  setMeta(patch: Partial<BoardMeta>) {
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) this.meta.set(k, v);
    });
  }

  getFlow(): FlowState {
    const f = this.flow.toJSON() as Partial<FlowState>;
    return {
      steps: f.steps ?? [],
      active: f.active ?? -1,
      timer: f.timer ?? null,
      reveal: f.reveal ?? false,
      focus: f.focus ?? null,
      stepStartedAt: f.stepStartedAt ?? 0,
      results: f.results ?? null,
    };
  }

  setFlow(patch: Partial<FlowState>) {
    // Flow changes are session control, not content: they are not undoable.
    this.transactAs(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) this.flow.delete(k);
        else this.flow.set(k, v);
      }
    }, 'flow');
  }

  private rebuildBoundIndex() {
    this.boundIndex.clear();
    for (const o of this.cache.values()) if (isConnector(o)) this.indexConnector(o);
  }

  private rebuildChildIndex() {
    this.childIndex.clear();
    this.containerIds.clear();
    for (const o of this.cache.values()) {
      this.indexChild(o);
      if (o.type === 'container') this.containerIds.add(o.id);
    }
  }

  private indexChild(o: Obj) {
    if (typeof o.parent !== 'string') return;
    let s = this.childIndex.get(o.parent);
    if (!s) this.childIndex.set(o.parent, (s = new Set()));
    s.add(o.id);
  }

  private unindexChild(o: Obj | undefined) {
    if (typeof o?.parent !== 'string') return;
    const s = this.childIndex.get(o.parent);
    if (!s) return;
    s.delete(o.id);
    if (!s.size) this.childIndex.delete(o.parent);
  }

  /** The lanes of a container and their cards, by parent, whether or not the container still exists. */
  private membersOf(id: Id): Id[] {
    const out: Id[] = [];
    for (const lane of this.childrenOf(id)) {
      out.push(lane.id);
      for (const card of this.childrenOf(lane.id)) out.push(card.id);
    }
    return out;
  }

  /** Forgets the layout of every container something inside changed in, and returns those containers with the layout they had. */
  private dropLayouts(edits: [Obj | undefined, Obj | undefined][]): Map<Id, ContainerLayout | null | undefined> {
    const affected = new Map<Id, ContainerLayout | null | undefined>();
    let all = false;
    // `container`: the edit itself was a container, new, changed or deleted, whatever the cache holds for it now
    const drop = (id: Id | undefined, container = false) => {
      if (id === undefined) return;
      if (!affected.has(id) && (container || this.cache.get(id)?.type === 'container')) affected.set(id, this.layouts.get(id));
      this.layouts.delete(id);
    };
    let structure = false;
    for (const edit of edits) {
      for (const o of edit) {
        if (!o || !isContainerType(o.type)) continue;
        structure = true;
        if (o.type === 'container') drop(o.id, true);
        else if (o.type === 'lane') drop(o.parent);
        else {
          const lane = o.parent === undefined ? undefined : this.cache.get(o.parent);
          if (lane?.type === 'lane') drop(lane.parent);
          else if (o.parent !== undefined && !lane) all = true;
        }
      }
    }
    if (structure && this.refreshOrphans()) all = true;
    if (!all) return affected;
    for (const id of this.containerIds) if (!affected.has(id)) affected.set(id, this.layouts.get(id));
    this.layouts.clear();
    return affected;
  }

  /** Recomputes which cards have lost their lane; true when that changed what any container shows. */
  private refreshOrphans(): boolean {
    const ids: Id[] = [];
    for (const [parent, kids] of this.childIndex) {
      if (this.cache.has(parent)) continue;
      for (const id of kids) if (this.cache.get(id)?.type === 'card') ids.push(id);
    }
    ids.sort();
    const home = orphanHome([...this.containerIds].map((id) => this.cache.get(id)!));
    const sig = `${home ?? ''}|${ids.join(',')}`;
    if (sig === this.orphanSig) return false;
    this.orphanSig = sig;
    this.orphanIds = ids;
    this.orphanHome = home;
    return true;
  }

  private indexConnector(c: ConnectorObj) {
    for (const end of [c.from, c.to]) {
      if (end?.kind === 'bound') {
        let s = this.boundIndex.get(end.id);
        if (!s) this.boundIndex.set(end.id, (s = new Set()));
        s.add(c.id);
      }
    }
  }

  private unindexConnector(c: ConnectorObj) {
    for (const end of [c.from, c.to]) {
      if (end?.kind === 'bound') this.boundIndex.get(end.id)?.delete(c.id);
    }
  }
}

export function newId(): Id {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_'[b & 63]).join('');
}
