import * as Y from 'yjs';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { BoardMeta, ConnectorObj, Id, Obj, Poll, PollAnswer, Step, Timer, Vote } from './types';
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
  readonly cache = new Map<Id, Obj>();
  readonly undo: Y.UndoManager;

  private listeners = new Set<ChangeListener>();
  private readOnlyListeners = new Set<(v: boolean) => void>();
  private _readOnly = false;
  private orderDirty = true;
  private orderCache: Obj[] = [];
  private boundIndex = new Map<Id, Set<Id>>(); // shape id -> connector ids

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.objects = doc.getMap('objects');
    this.meta = doc.getMap('meta');
    this.flow = doc.getMap('flow');
    this.votes = doc.getMap('votes');
    this.polls = doc.getMap('polls');
    this.pollAnswers = doc.getMap('pollAnswers');

    this.objects.forEach((m, id) => this.cache.set(id, m.toJSON() as Obj));
    this.rebuildBoundIndex();

    this.objects.observeDeep((events) => {
      const changed = new Set<Id>();
      for (const e of events) {
        if (e.target === this.objects) {
          for (const k of e.changes.keys.keys()) changed.add(k);
        } else if (e.path.length > 0) {
          changed.add(String(e.path[0]));
        }
      }
      for (const id of changed) {
        const prev = this.cache.get(id);
        if (isConnector(prev)) this.unindexConnector(prev);
        const m = this.objects.get(id);
        if (m) {
          const o = m.toJSON() as Obj;
          this.cache.set(id, o);
          if (isConnector(o)) this.indexConnector(o);
        } else {
          this.cache.delete(id);
        }
      }
      this.orderDirty = true;
      this.listeners.forEach((l) => l(changed));
    });

    this.undo = new Y.UndoManager([this.objects, this.meta], {
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

  /** All objects in paint order (frames first, then by z). */
  ordered(): Obj[] {
    if (this.orderDirty) {
      const all = [...this.cache.values()];
      const frames = all.filter((o) => o.type === 'frame').sort(cmpZ);
      const rest = all.filter((o) => o.type !== 'frame').sort(cmpZ);
      this.orderCache = [...frames, ...rest];
      this.orderDirty = false;
    }
    return this.orderCache;
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

  create(o: Obj) {
    const entries = Object.entries(o).filter(([, v]) => v !== undefined);
    this.objects.set(o.id, new Y.Map(entries));
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

  childrenOf(frameId: Id): Obj[] {
    const out: Obj[] = [];
    for (const o of this.cache.values()) if (o.parent === frameId) out.push(o);
    return out;
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
