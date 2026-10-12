import { packAssets, unpackAssets, type PackedAsset } from './drift-assets';
import { sha256Hex, type ImportedAsset } from './images';
import type { ImageState } from './image-loader';
import { strToU8, strFromU8, zipSync, Unzip, UnzipInflate, UnzipPassThrough, type Zippable } from 'fflate';
import * as Y from 'yjs';
import type { BoardApp } from './app';
import type { BaseObj, BoardMeta, Id, Obj, Poll, PollAnswer, Vote } from './types';
import { SCHEMA_VERSION, isBox, isConnector } from './types';
import { Store, type FlowState } from './store';
import { COMMENTS_ORIGIN, Comments, threadVisible, type Thread } from './comments';
import { isWithheld, leaveOutWithheld, updateWithoutWithheld } from './private-select';
import { answerKey } from './polls';
import { cleanProposedBy } from './safe-obj';
import { SVG_DEFS, objectMarkup } from './markup';
import { cssUrl, fontIsAllowed, fontName, nearestWeight } from './fonts';
import { customStickyColors } from './palette';
import { cardRows, cardsCsvName, csvText } from './csv';
import { containerOf } from './containers';
import { listLabels } from './labels';
import { DEMO } from './demo';
import { checkYUpdate, ImportError } from './yupdate-check';
import { sha256Hex as sha256Text } from './sha256';
import { chunkEntries, chunkObjects, estimate, firstTableProblem, planChunks, sanitizeImportedState, type ImportedState } from './import-sanitize';

const DEMO_IMPORT_COMPRESSED_LIMIT = 20 * 1024 * 1024;
const DEMO_IMPORT_UNCOMPRESSED_LIMIT = 100 * 1024 * 1024;
const FONT_FETCH_TIMEOUT_MS = 8000;
const FONT_CSS_LIMIT_BYTES = 256 * 1024;
const EMBEDDED_FONT_LIMIT_BYTES = 1_500_000;

export interface BoardJson {
  format: 'driftboard';
  schemaVersion: number;
  exportedAt: string;
  meta: BoardMeta;
  objects: Obj[];
  flow: FlowState;
  comments?: Thread[];
  polls?: Poll[];
  pollAnswers?: PollAnswer[];
  /** Says what this file leaves out, when it leaves something out. */
  note?: string;
}

/** The object with `proposedBy` in its one clean shape or not at all: a file never carries what a collaborator wrote there (TAB-160). */
export function withCleanProposedBy<T extends Obj>(o: T): T {
  if (!('proposedBy' in o)) return o;
  const { proposedBy, ...rest } = o as T & { proposedBy?: unknown };
  const clean = cleanProposedBy(proposedBy);
  return (clean ? { ...rest, proposedBy: clean } : rest) as T;
}

/**
 * `leaveOutWithheld` (a file someone hands on) leaves out the notes private writing hides from this person, with the threads
 * and connectors that name them; the board's own backup keeps everything.
 */
export function toJson(app: BoardApp, ids?: Id[], comments: Thread[] = app.conn.comments.list(), opts: { leaveOutWithheld?: boolean } = {}): BoardJson {
  const all = ids ? gatherForSnapshot(app, ids) : app.store.ordered();
  const selectedIds = ids ? new Set(all.map((o) => o.id)) : null;
  // A container's lanes and cards have no positions of their own, so the copy carries the laid-out ones.
  const objs = (opts.leaveOutWithheld ? leaveOutWithheld(all, app.flow) : all)
    .map((o) => {
      const clean = withCleanProposedBy(o.type === 'group' ? o : app.store.placed(o));
      if (!selectedIds || !clean.parent || selectedIds.has(clean.parent)) return clean;
      const detached = { ...clean };
      delete detached.parent;
      return detached;
    });
  if (opts.leaveOutWithheld) comments = threadsWithoutWithheld(app, comments);
  const json: BoardJson = {
    format: 'driftboard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    meta: app.store.getMeta(),
    objects: objs,
    flow: app.store.getFlow(),
  };
  if (comments.length && !ids) json.comments = comments;
  // the readable snapshot names pictures by hash and does not carry them: a .drift file does (docs/images.md)
  if (objs.some((o) => o.type === 'image')) json.note = 'Images are referenced by their asset hash and their bytes are not included in this file. Export a .drift file to keep them.';
  if (!ids) {
    const { polls, answers } = app.flow.polls.snapshot();
    if (polls.length) json.polls = polls;
    if (answers.length) json.pollAnswers = answers;
  }
  return json;
}

/** The threads that are not about a note private writing hides from this person. */
function threadsWithoutWithheld(app: BoardApp, threads: Thread[]): Thread[] {
  return threads.filter((t) => threadVisible(t, (id) => app.store.get(id), (o) => app.flow.isHidden(o)));
}

/** The comments document with only `keep`'s threads: a file that leaves notes out does not carry what was said about them. */
function commentsWithout(app: BoardApp, keep: Thread[]): Uint8Array {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(app.conn.comments.doc));
    const kept = new Set(keep.map((t) => t.id));
    const threads = copy.getMap('threads');
    copy.transact(() => {
      for (const id of Array.from(threads.keys())) if (!kept.has(id)) threads.delete(id);
    });
    return Y.encodeStateAsUpdate(copy);
  } finally {
    copy.destroy();
  }
}

/** `.drift` = zip of a readable snapshot plus the full CRDT state (history preserved). */
export async function toDrift(app: BoardApp, opts: { leaveOutWithheld?: boolean } = {}): Promise<Uint8Array> {
  const leave = opts.leaveOutWithheld === true;
  const withheld = leave ? [...app.store.cache.values()].filter((o) => isWithheld(o, app.flow)).map((o) => o.id) : [];
  const files: Zippable = {
    // Comments travel in comments.yjs, not in the readable snapshot.
    'board.json': strToU8(JSON.stringify(toJson(app, undefined, [], { leaveOutWithheld: leave }), null, 2)),
    'doc.yjs': updateWithoutWithheld(app.store.doc, withheld),
  };
  const threads = leave ? threadsWithoutWithheld(app, app.conn.comments.list()) : app.conn.comments.list();
  if (threads.length > 0) files['comments.yjs'] = leave ? commentsWithout(app, threads) : Y.encodeStateAsUpdate(app.conn.comments.doc);
  // the pictures, beside the board (docs/images.md): the file is the one format that round-trips a board completely
  const mimes = new Map<string, string>();
  for (const o of app.store.cache.values()) {
    const b = o as BaseObj;
    if (b.type === 'image' && typeof b.asset === 'string') mimes.set(b.asset, b.mime ?? 'image/png');
  }
  const packed: PackedAsset[] = [];
  for (const [key, mime] of mimes) {
    const blob = await app.images.blobOf(key);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    packed.push({ key, mime, bytes, sha: await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) });
  }
  for (const [name, data] of Object.entries(packAssets(packed) ?? {})) files[name] = name.startsWith('assets/') ? [data, { level: 0 }] : data;
  return zipSync(files, { level: 6 });
}

export interface ImportedBoard { json: BoardJson; update?: Uint8Array; comments?: Uint8Array; /** The pictures of the file by the `asset` reference they stand for. */ assets?: Record<string, ImportedAsset> }

/**
 * What a board file may expand to. A real board is far smaller (the largest measured one is 20.6 MiB, docs/capacity.md); these
 * stop a file that is built to expand (a zip bomb, a Yjs update that declares a huge state) while it is read.
 */
export const IMPORT_LIMITS = Object.freeze({
  /** The file as it lies on disk. */
  compressed: 100 * 1024 * 1024,
  /** Everything in it once unzipped, counted as it is inflated. */
  expanded: 512 * 1024 * 1024,
  /**
   * The saved sync state (`doc.yjs`) and the snapshot (`board.json`), as bytes. A Yjs update cannot be inspected without decoding
   * it, and decoding allocates far more than the bytes (on the order of 100 bytes per struct), so this is the one bound on that
   * allocation: a board of 5,000 objects is a few MiB, and 32 MiB leaves a wide margin while keeping the worst case near 1.5 GB
   * of structs rather than 6 GB.
   */
  state: 32 * 1024 * 1024,
  /** Objects in the saved state, once decoded. */
  objects: 50_000,
  /** Writers (clients) and structs in a Yjs update, counted before it is applied (src/yupdate-check.ts). */
  clients: 10_000,
  structs: 1_500_000,
});

export type ImportLimits = { compressed: number; expanded: number; state: number; objects: number; clients: number; structs: number };

/**
 * The limits for this app's own backup copies (the desktop app's recovery after the webview's storage was lost, and merging a
 * backup into an opened board). They are the app's own output, so they must fit every board the app supports: a document of up
 * to 128 MiB (docs/capacity.md) and a long-lived board that has had thousands of writers. The streaming inflater and the
 * header checks still apply, so a damaged or swapped file is still stopped.
 */
export const OWN_BACKUP_LIMITS: ImportLimits = Object.freeze({
  compressed: 512 * 1024 * 1024,
  expanded: 1024 * 1024 * 1024,
  state: 256 * 1024 * 1024,
  objects: 200_000,
  clients: 200_000,
  structs: 12_000_000,
});

export { ImportError };

const mib = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`;

/** What the zip's central directory says the files add up to when inflated (NaN if the directory cannot be read). A lying header is caught by the count while inflating. */
function declaredExpandedSize(buf: Uint8Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return Number.NaN;
  let at = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  let total = 0;
  for (let n = 0; n < count && at + 46 <= buf.length && view.getUint32(at, true) === 0x02014b50; n++) {
    total += view.getUint32(at + 24, true);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return total;
}

/** What the streaming inflater did, for tests: the bytes it produced when it stopped and the largest piece it produced at once. */
export interface UnzipStats { total: number; maxChunk: number; /** Called after every piece (tests sample memory here). */ onChunk?: () => void }

/** The files whose size is the size of the board itself (not pictures): capped by `limits.state` while they inflate. */
const DATA_ENTRIES = new Set(['board.json', 'doc.yjs', 'comments.yjs']);
/**
 * The input is fed to the inflater in slices this small. Deflate cannot expand more than about 1,032 times, so one push produces at
 * most about 2 MiB, and the running total is checked after every push: the memory used past the cap is bounded by that, not by
 * the size of the file or by what a header claims.
 */
const INPUT_SLICE = 2048;

/** Unzips with the inflated size counted as it is produced: past `expanded` in all, or `state` in a data file, it stops. */
function unzipLimited(buf: Uint8Array, limits: ImportLimits, tooBig: string, tooBigState: string, stats?: UnzipStats): Record<string, Uint8Array> {
  const expanded = Math.min(limits.expanded, DEMO ? DEMO_IMPORT_UNCOMPRESSED_LIMIT : Infinity);
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  let failure: Error | null = null;
  const fail = (e: Error, file?: { terminate: () => void }) => { failure ??= e; file?.terminate(); };
  if (declaredExpandedSize(buf) > expanded) throw new ImportError(tooBig);
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    if (failure || file.name.endsWith('/')) return;
    if (typeof file.originalSize === 'number' && total + file.originalSize > expanded) {
      fail(new ImportError(tooBig), file);
      return;
    }
    const limit = DATA_ENTRIES.has(file.name) ? limits.state : Infinity;
    let parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) { fail(err); return; }
      total += chunk.length;
      size += chunk.length;
      if (stats) { stats.total = total; stats.maxChunk = Math.max(stats.maxChunk, chunk.length); stats.onChunk?.(); }
      if (total > expanded) { fail(new ImportError(tooBig), file); return; }
      if (size > limit) { fail(new ImportError(tooBigState), file); return; }
      parts.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let at = 0;
        for (const c of parts) { out.set(c, at); at += c.length; }
        parts = [];
        files[file.name] = out;
      }
    };
    file.start();
  };
  for (let at = 0; at < buf.length && !failure; at += INPUT_SLICE) {
    unzip.push(buf.subarray(at, Math.min(buf.length, at + INPUT_SLICE)), at + INPUT_SLICE >= buf.length);
  }
  if (failure) throw failure;
  return files;
}

/** Reads a file in pieces with a running total and stops (and cancels the read) the moment it passes `cap`. */
export async function readFileLimited(file: Blob, cap: number, message: string): Promise<Uint8Array> {
  if (file.size > cap) throw new ImportError(message);
  if (typeof file.stream !== 'function') return new Uint8Array(await file.arrayBuffer());
  const reader = file.stream().getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new ImportError(message);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function readBoardFile(file: File): Promise<ImportedBoard> {
  if (DEMO && file.size > DEMO_IMPORT_COMPRESSED_LIMIT) {
    throw new Error('This board file exceeds the 20 MiB demo import limit.');
  }
  // the size is checked before one byte is read, and again as the bytes arrive
  return readBoardBytes(await readFileLimited(file, IMPORT_LIMITS.compressed, tooLargeFile(IMPORT_LIMITS)), IMPORT_LIMITS);
}

const tooLargeFile = (limits: ImportLimits) => `This board file is larger than ${mib(limits.compressed)}, which is more than Tabula opens.`;
const tooLargeState = (limits: ImportLimits) => `The board data in this file is larger than ${mib(limits.state)}, which is more than Tabula opens.`;

/** A board file's bytes (a zip or a JSON file) as an ImportedBoard, within `limits`. Throws an ImportError with the reason. */
export function readBoardBytes(buf: Uint8Array, limits: ImportLimits = IMPORT_LIMITS, stats?: UnzipStats): ImportedBoard {
  if (buf.length > limits.compressed) throw new ImportError(tooLargeFile(limits));
  // zip magic: PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipLimited(buf, limits, DEMO
      ? 'This board archive expands beyond the 100 MiB demo import limit.'
      : `This board file expands to more than ${mib(limits.expanded)}, which is more than Tabula opens.`, tooLargeState(limits), stats);
    const assets = unpackAssets(files);
    if (!files['board.json']) throw new Error('This file is not a Tabula board (board.json is missing).');
    if (files['doc.yjs']) preflight(files['doc.yjs'], limits);
    if (files['comments.yjs']) preflight(files['comments.yjs'], limits);
    return {
      json: validate(JSON.parse(strFromU8(files['board.json']))),
      update: files['doc.yjs'],
      comments: files['comments.yjs'],
      ...(Object.keys(assets).length ? { assets } : {}),
    };
  }
  if (buf.length > limits.state) throw new ImportError(tooLargeState(limits));
  return { json: validate(JSON.parse(strFromU8(buf))) };
}

/** The name a board gets when it is imported from a file: the one it was saved with, else the file's name. */
export function importedBoardName(imported: ImportedBoard, fileName: string): string {
  return imported.json.meta?.name || fileName.replace(/\.\w+$/, '');
}

/** The maps an import writes into. */
export type ImportMap = 'objects' | 'meta' | 'flow' | 'labels' | 'polls' | 'pollAnswers' | 'pollState' | 'votes';
const IMPORT_MAPS: ImportMap[] = ['objects', 'meta', 'flow', 'labels', 'polls', 'pollAnswers', 'pollState', 'votes'];

/** One key an import wrote: a digest of the value as written, and what was there before (a setting that already had a value). */
export interface WrittenKey { digest: string; had: boolean; prev?: unknown }

/** A comment thread an import added: a digest of the thread as written (without its replies) and of each reply. */
export interface WrittenThread { digest: string; replies: Record<string, string> }

/**
 * What `importBoard` wrote, so that exactly that, and only what is still as it was written, can be taken away again
 * (`undoImport`).
 */
export interface ImportManifest {
  importer: string;
  written: Record<ImportMap, Record<string, WrittenKey>>;
  threads: Record<string, WrittenThread>;
}
const emptyManifest = (importer = ''): ImportManifest => ({
  importer,
  written: { objects: {}, meta: {}, flow: {}, labels: {}, polls: {}, pollAnswers: {}, pollState: {}, votes: {} },
  threads: {},
});

/** JSON with the keys of every object in order, so two equal values always give the same text. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (value instanceof Y.AbstractType) return canonicalJson(value.toJSON(), depth);
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (depth > 32) return '"~"';
  if (Array.isArray(value)) return `[${value.map((x) => canonicalJson(x, depth + 1)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
}

/**
 * A SHA-256 digest (hex) of a value's canonical JSON: a different value does not collide with it in any practical case. Plain
 * JavaScript and synchronous (src/sha256.ts): crypto.subtle is missing outside secure contexts (a self-hosted install on plain
 * http), and a check that compares and then deletes must not wait for anything between the two.
 */
export function digestOf(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export type FinalState = { state: 'confirmed' } | { state: 'refused'; missing: string[] } | { state: 'unconfirmed' };

export type ImportOutcome =
  /** Everything was written; `final` settles when the relay has been heard from about the last step (or the window ran out). */
  | { ok: true; manifest: ImportManifest; /** The relay could not be reached while writing: it is saved on this device and goes when online. */ pending: boolean; final: Promise<FinalState> }
  /** It stopped: the relay took `failed` back (`refused`), or could not be asked in time (`unconfirmed`, e.g. offline). */
  | { ok: false; failed: string; reason: 'refused'; manifest: ImportManifest };

type ImportTarget = { doc: Y.Doc; store: Store; comments: Comments };
type Step = { part: string; map: ImportMap; entries: [string, unknown][] };

/** Checks a Yjs update from a file before it is applied anywhere: every client's declared count, the totals, the bytes. */
function preflight(update: Uint8Array, limits: ImportLimits): void {
  if (update.length > limits.state) throw new ImportError(tooLargeState(limits));
  checkYUpdate(update, limits, tooLargeState(limits));
}

/** The maps of a file's saved sync state, as plain values. */
function stateFromUpdate(update: Uint8Array, limits: ImportLimits): ImportedState {
  preflight(update, limits);
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, update);
    if (scratch.getMap('objects').size > limits.objects) throw new ImportError(`This board has more than ${limits.objects.toLocaleString('en-US')} objects, which is more than Tabula opens.`);
    const objects: Obj[] = [];
    scratch.getMap('objects').forEach((m) => objects.push((m as Y.Map<unknown>).toJSON() as Obj));
    return {
      objects,
      meta: scratch.getMap('meta').toJSON(),
      flow: scratch.getMap('flow').toJSON(),
      votes: scratch.getMap('votes').toJSON() as ImportedState['votes'],
      polls: Object.values(scratch.getMap('polls').toJSON()) as Poll[],
      pollAnswers: Object.values(scratch.getMap('pollAnswers').toJSON()) as PollAnswer[],
      pollState: scratch.getMap('pollState').toJSON(),
      labels: scratch.getMap('labels').toJSON(),
    };
  } finally {
    scratch.destroy();
  }
}

function stateFromJson(json: BoardJson, limits: ImportLimits = IMPORT_LIMITS): ImportedState {
  if (json.objects.length > limits.objects) throw new ImportError(`This board has more than ${limits.objects.toLocaleString('en-US')} objects, which is more than Tabula opens.`);
  return { objects: json.objects as Obj[], meta: json.meta as unknown as Record<string, unknown>, flow: json.flow as unknown as Record<string, unknown>, polls: json.polls, pollAnswers: json.pollAnswers };
}

/** The writes of a state, in the order they are made, each within the message budget (src/import-sanitize.ts IMPORT_CHUNK). */
/** Refuses a state with a table the relay would take back (more rows, columns or text than a table may hold): see tableProblem. */
function refuseOversizedTables(state: ImportedState): void {
  const problem = firstTableProblem(state.objects);
  if (problem) throw new ImportError(`This board has ${problem}, which is more than Tabula opens.`);
}

function planWrites(state: ImportedState): Step[] {
  const steps: Step[] = [];
  const add = (part: string, map: ImportMap, entries: [string, unknown][]) => {
    const chunks = chunkEntries(entries);
    chunks.forEach((c, i) => steps.push({ part: chunks.length > 1 ? `${part} (${i + 1} of ${chunks.length})` : part, map, entries: c.items }));
  };
  add('board settings', 'meta', Object.entries(state.meta || {}).map(([k, v]) => [k, k === 'stickyColors' ? customStickyColors(v) : v]));
  add('session', 'flow', Object.entries(state.flow || {}));
  add('labels', 'labels', Object.entries(state.labels || {}));
  add('polls', 'polls', (state.polls ?? []).map((p) => [p.id, p]));
  add('poll state', 'pollState', Object.entries(state.pollState || {}));
  add('poll answers', 'pollAnswers', (state.pollAnswers ?? []).map((a) => [answerKey(a.pollId, a.userId), a]));
  add('votes', 'votes', Object.entries(state.votes || {}));
  const chunks = chunkObjects(state.objects);
  chunks.forEach((c, i) => steps.push({ part: chunks.length > 1 ? `objects (${i + 1} of ${chunks.length})` : 'objects', map: 'objects', entries: c.items.map((o) => [o.id, o]) }));
  return steps;
}

type Digests = Record<ImportMap, Record<string, string>>;
const emptyDigests = (): Digests => ({ objects: {}, meta: {}, flow: {}, labels: {}, polls: {}, pollAnswers: {}, pollState: {}, votes: {} });

/**
 * Writes one step. `undoable` writes it as an undo step; otherwise it is starting content, which Undo cannot take away
 * (Store.seed). With `digests` (worked out before anything was written, by `dryRun`) they go into the manifest; without, the
 * digest of what was stored is taken here (the dry run itself).
 */
function writeStep(store: Store, step: Step, manifest: ImportManifest, undoable: boolean, digests?: Digests): void {
  (undoable ? store.transact : store.seed).call(store, () => {
    const map = mapOf(store, step.map);
    for (const [key, value] of step.entries) {
      const had = step.map !== 'objects' && map.has(key);
      const prev = had ? (map.get(key) instanceof Y.AbstractType ? (map.get(key) as Y.AbstractType<unknown>).toJSON() : map.get(key)) : undefined;
      switch (step.map) {
        case 'objects': store.create(value as Obj); break;
        case 'meta': store.meta.set(key, value); break;
        case 'flow': store.flow.set(key, value); break;
        case 'labels': store.labels.set(key, value as never); break;
        case 'polls': store.polls.set(key, value as Poll); break;
        case 'pollAnswers': store.pollAnswers.set(key, value as PollAnswer); break;
        case 'pollState': store.pollState.set(key, value); break;
        case 'votes': store.votes.set(key, value as Vote); break;
      }
      manifest.written[step.map][key] = { digest: digests ? (digests[step.map][key] ?? digestOf(map.get(key))) : digestOf(map.get(key)), had, ...(had ? { prev } : {}) };
    }
  });
}

/** Gives the browser a turn: scheduler.yield() when it exists, else a macro-task (a message, then a timer), never a micro-task. */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
      channel.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** An import the person (or the page) stopped between slices of the preparation: nothing had been written. */
export class ImportAborted extends Error {
  constructor() { super('The import was cancelled.'); }
}

/** How the preparation of an import shares the main thread. */
export interface SliceOptions {
  /** Works for about this long (ms) before giving the event loop a turn. Default 30. */
  sliceMs?: number;
  clock?: () => number;
  /** Gives the event loop a turn. Default `yieldToEventLoop`. */
  yieldNow?: () => Promise<void>;
  /** Called before the first slice and after each: `done` of `total` values prepared (for an "Importing… n of m" line). */
  onProgress?: (done: number, total: number) => void;
  /** Stops the preparation at the next slice boundary: nothing is written. */
  signal?: AbortSignal;
}

/** Entries handled between two looks at the clock. */
const SLICE_ENTRIES = 25;

/**
 * Works out the digest of everything an import will write BEFORE the board is touched: the steps are written into a scratch
 * store (the same `store.create` and map writes, so the stored values are exactly what the board will hold) and thrown away. A
 * failure, or a cancel, here leaves nothing behind; the real writes below cannot fail on hashing.
 *
 * It is done in slices: about every `sliceMs` of work the event loop gets a turn, so a large import does not freeze the page. The
 * result is identical to doing it in one go.
 */
async function dryRun(steps: Step[], threads: Thread[], importedBy: string, slicing: SliceOptions = {}): Promise<{ digests: Digests; threads: Record<string, WrittenThread> }> {
  const clock = slicing.clock ?? (() => performance.now());
  const yieldNow = slicing.yieldNow ?? yieldToEventLoop;
  const sliceMs = slicing.sliceMs ?? 30;
  const total = steps.reduce((n, step) => n + step.entries.length, 0) + threads.length;
  let done = 0;
  let sliceStart = clock();
  /** Called between small batches: yields when the slice is used up, and stops if asked to. */
  const checkpoint = async () => {
    if (slicing.signal?.aborted) throw new ImportAborted();
    if (clock() - sliceStart < sliceMs) return;
    slicing.onProgress?.(done, total);
    await yieldNow();
    if (slicing.signal?.aborted) throw new ImportAborted();
    sliceStart = clock();
  };
  const scratch = new Store(new Y.Doc());
  const comments = new Comments(new Y.Doc());
  try {
    slicing.onProgress?.(0, total);
    // the sanitising and planning before this took a turn of their own: let the page show the state before the first slice
    await yieldNow();
    sliceStart = clock();
    const manifest = emptyManifest(importedBy);
    for (const step of steps) {
      for (let at = 0; at < step.entries.length; at += SLICE_ENTRIES) {
        const part = step.entries.slice(at, at + SLICE_ENTRIES);
        writeStep(scratch, { ...step, entries: part }, manifest, false);
        done += part.length;
        await checkpoint();
      }
    }
    const digests = emptyDigests();
    for (const name of IMPORT_MAPS) for (const [key, rec] of Object.entries(manifest.written[name])) digests[name][key] = rec.digest;
    for (let at = 0; at < threads.length; at += 10) {
      const part = threads.slice(at, at + 10);
      comments.importThreads(part, importedBy);
      done += part.length;
      await checkpoint();
    }
    const written: Record<string, WrittenThread> = {};
    comments.threads.forEach((_, id) => { written[id] = writtenThread(comments, id); });
    slicing.onProgress?.(total, total);
    return { digests, threads: written };
  } finally {
    scratch.doc.destroy();
    comments.doc.destroy();
  }
}

const mapOf = (store: Store, name: ImportMap): Y.Map<unknown> => ({
  objects: store.objects, meta: store.meta, flow: store.flow, labels: store.labels, polls: store.polls,
  pollAnswers: store.pollAnswers, pollState: store.pollState, votes: store.votes,
}[name] as unknown as Y.Map<unknown>);

/** Whether the keys of a step are all still there: a relay that refused the message takes them away again. */
function stepPresent(store: Store, step: Step): boolean {
  const map = mapOf(store, step.map);
  return step.entries.every(([key]) => map.has(key));
}

/** The maps of an import with keys that are no longer in the board (the relay refused them); empty when all arrived. */
export function missingFromImport(store: Store, manifest: ImportManifest): string[] {
  return IMPORT_MAPS.filter((name) => {
    const map = mapOf(store, name);
    return Object.keys(manifest.written[name]).some((key) => !map.has(key));
  });
}

export interface UndoImportResult { removed: number; restored: number; left: number; comments: number }

/**
 * Takes away what an import wrote, and only what is still exactly as the import wrote it (compared by SHA-256 of the canonical
 * content): an imported object, poll, vote, label or answer that somebody has changed since is left (and counted in `left`); a
 * setting that had a value before gets it back, but only if it still holds what the import wrote (so a board renamed since keeps
 * its new name); an imported comment thread goes only if its own text is untouched, and then only together with its imported
 * replies that are untouched. A thread, or a reply, that was edited stays, and so does a thread with a reply somebody added.
 *
 * Synchronous on purpose: each value is read, hashed and removed inside one transaction, with nothing awaited between the check
 * and the removal, so no edit can slip in between them.
 */
export function undoImport(store: Store, comments: Comments, manifest: ImportManifest): UndoImportResult {
  const result: UndoImportResult = { removed: 0, restored: 0, left: 0, comments: 0 };
  store.transact(() => {
    for (const name of IMPORT_MAPS) {
      const map = mapOf(store, name);
      for (const [key, rec] of Object.entries(manifest.written[name])) {
        if (!map.has(key)) continue;
        const current = map.get(key);
        const mine = name !== 'objects' || (current as Y.Map<unknown>).get('createdBy') === manifest.importer;
        if (!mine || rec.digest === '' || digestOf(current) !== rec.digest) { result.left++; continue; }
        if (rec.had) { map.set(key, rec.prev); result.restored++; } else { map.delete(key); result.removed++; }
      }
    }
  });
  comments.doc.transact(() => {
    for (const [id, written] of Object.entries(manifest.threads)) {
      const thread = comments.threads.get(id);
      if (!thread) continue;
      const { replies: current = {}, ...own } = thread.toJSON() as Record<string, unknown> & { replies?: Record<string, unknown> };
      const replies = thread.get('replies') as Y.Map<unknown> | undefined;
      for (const [rid, digest] of Object.entries(written.replies)) {
        if (!(rid in current)) continue;
        if (digestOf(current[rid]) !== digest) { result.left++; continue; }
        replies?.delete(rid);
      }
      if (digestOf(own) !== written.digest) { result.left++; continue; }
      if (replies && replies.size > 0) { result.left++; continue; } // somebody replied since, or a reply was edited
      comments.threads.delete(id);
      result.comments++;
    }
  }, COMMENTS_ORIGIN);
  return result;
}

export interface ImportOptions {
  /**
   * Asks a relay to answer: resolves true once it has been heard from after everything written so far to that room (so it has had
   * the chance to refuse and revert it), false when it cannot be reached within `timeoutMs` (offline, reconnecting). `room` is
   * the board room or the comments room. A board that does not sync has nobody to ask and leaves this out: a short pause stands in.
   */
  confirm?: (timeoutMs: number, room: 'board' | 'comments') => Promise<boolean>;
  /** How long the first step may wait to be confirmed (default 3 s: a relay that does not answer is taken as offline) and each later one (10 s). */
  firstWindowMs?: number;
  stepWindowMs?: number;
  /** How long the end of the import may wait (default 60 s). */
  finalWindowMs?: number;
  /** Pause between asks while the relay cannot be reached (default 1 s). */
  retryMs?: number;
  now?: () => number;
  limits?: ImportLimits;
  /** How the preparation shares the main thread, reports progress and can be cancelled (see SliceOptions). */
  slicing?: SliceOptions;
}

/**
 * Puts an imported board file into an empty board, for `importedBy`. Everything the file names (authors, owners, votes, poll
 * answers) is mapped to the importer (src/import-sanitize.ts), and it is written in messages that stay within the relay's
 * budget: board settings, session, labels, polls, answers, votes, the objects a family at a time (a parent with its children,
 * a connector with the objects it joins), then the comment threads in pieces of their own.
 *
 * While the relay can be reached, each step is confirmed before the next (`confirm`: the relay has answered after it, so it has
 * had the chance to refuse and revert it) and its keys are read back; a step that is gone stops the import (`refused`). The
 * board steps are confirmed through the board room and the comment pieces through the comments room. If the relay cannot be
 * reached (offline, reconnecting) the import does not stop: it finishes on this device (`pending: true`) and is confirmed in
 * the background, exactly like the last step, for up to the final window, re-asking while the relay is unreachable. `final`
 * settles `confirmed` only when both rooms confirmed and everything written is still there; `refused` (with what lost keys); or
 * `unconfirmed` when the window ran out.
 *
 * The whole import is one undo step (objects, settings and labels; the session, polls, votes and comments are not in the undo
 * history). The manifest records what was written so `undoImport` can take away exactly that.
 */
export async function importBoard(target: ImportTarget, imported: ImportedBoard, importedBy: string, options: ImportOptions = {}): Promise<ImportOutcome> {
  const limits = options.limits ?? IMPORT_LIMITS;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 1000;
  const confirm = options.confirm ?? (async () => { await new Promise<void>((resolve) => setTimeout(resolve, 300)); return true; });
  const { json, update, comments } = imported;
  const threads: Thread[] = comments ? Comments.threadsFromUpdate(comments, limits) : (json.comments ?? []);
  const state = sanitizeImportedState(update ? stateFromUpdate(update, limits) : stateFromJson(json, limits), importedBy);
  refuseOversizedTables(state);
  const steps = planWrites(state);
  const commentChunks = planChunks(threads, estimate, (t) => t.id);
  // every digest is worked out before the board is touched, so hashing can never leave a half-written import
  const planned = await dryRun(steps, threads, importedBy, options.slicing);
  const manifest = emptyManifest(importedBy);
  const undo = target.store.undo;
  const kept = undo.captureTimeout;

  /** Waits for a relay to answer, up to `windowMs`; true if it did. */
  const heard = async (windowMs: number, room: 'board' | 'comments'): Promise<boolean> => {
    const deadline = now() + windowMs;
    for (;;) {
      const left = deadline - now();
      if (left <= 0) return false;
      if (await confirm(Math.min(5000, left), room)) return true;
      if (deadline - now() <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  };

  let online = true;
  undo.stopCapturing();
  undo.captureTimeout = Infinity; // every board write below joins one undo step
  try {
    for (let i = 0; i < steps.length; i++) {
      writeStep(target.store, steps[i], manifest, true, planned.digests);
      if (!online) continue;
      const last = i === steps.length - 1 && commentChunks.length === 0;
      if (last) break; // the end is confirmed below, in the background
      if (!(await heard(i === 0 ? options.firstWindowMs ?? 3000 : options.stepWindowMs ?? 10_000, 'board'))) { online = false; continue; }
      if (!stepPresent(target.store, steps[i])) return { ok: false, failed: steps[i].part, reason: 'refused', manifest };
    }
  } finally {
    undo.captureTimeout = kept;
    undo.stopCapturing();
  }

  for (let i = 0; i < commentChunks.length; i++) {
    const before = new Set(target.comments.threads.keys());
    target.comments.importThreads(commentChunks[i].items, importedBy);
    const added: string[] = [];
    target.comments.threads.forEach((_, id) => { if (!before.has(id)) added.push(id); });
    for (const id of added) manifest.threads[id] = planned.threads[id] ?? writtenThread(target.comments, id);
    if (!online || i === commentChunks.length - 1) continue;
    if (!(await heard(options.stepWindowMs ?? 10_000, 'comments'))) { online = false; continue; }
    if (added.some((id) => !target.comments.threads.has(id))) return { ok: false, failed: `comments (${i + 1} of ${commentChunks.length})`, reason: 'refused', manifest };
  }

  const final = (async (): Promise<FinalState> => {
    const window = options.finalWindowMs ?? 60_000;
    if (!(await heard(window, 'board'))) return { state: 'unconfirmed' };
    if (commentChunks.length && !(await heard(window, 'comments'))) return { state: 'unconfirmed' };
    const missing = missingFromImport(target.store, manifest);
    if (Object.keys(manifest.threads).some((id) => !target.comments.threads.has(id))) missing.push('comments');
    return missing.length ? { state: 'refused', missing } : { state: 'confirmed' };
  })();
  return { ok: true, manifest, pending: !online, final };
}

/** The digests of a comment thread as stored: of the thread without its replies, and of each reply. */
function writtenThread(comments: Comments, id: string): WrittenThread {
  const json = comments.threads.get(id)!.toJSON() as Record<string, unknown> & { replies?: Record<string, unknown> };
  const { replies = {}, ...own } = json;
  const out: WrittenThread = { digest: digestOf(own), replies: {} };
  for (const [rid, reply] of Object.entries(replies)) out.replies[rid] = digestOf(reply);
  return out;
}

/**
 * Puts a board file into an empty board without waiting for anyone: this device's own backup copy (`importedBy` null: nothing is
 * mapped, nothing syncs, comments keep their authors) or a local board written before it is shared. For a board that syncs,
 * `importBoard` is the one to use.
 */
export function applyImported(target: ImportTarget, imported: ImportedBoard, importedBy: string | null) {
  const { json, update, comments } = imported;
  if (importedBy === null) {
    if (update) preflight(update, OWN_BACKUP_LIMITS);
    if (comments) preflight(comments, OWN_BACKUP_LIMITS);
    if (update) Y.applyUpdate(target.doc, update);
    else {
      const manifest = emptyManifest(importedBy ?? '');
      for (const step of planWrites(stateFromJson(json))) writeStep(target.store, step, manifest, false);
    }
    // toDrift keeps comments in comments.yjs only, so a backup has no readable comments to fall back to.
    if (comments) Y.applyUpdate(target.comments.doc, comments);
    return;
  }
  if (comments) preflight(comments, IMPORT_LIMITS);
  const state = sanitizeImportedState(update ? stateFromUpdate(update, IMPORT_LIMITS) : stateFromJson(json), importedBy);
  refuseOversizedTables(state);
  const manifest = emptyManifest(importedBy ?? '');
  for (const step of planWrites(state)) writeStep(target.store, step, manifest, false);
  if (comments) target.comments.importUpdate(comments, importedBy);
  else if (json.comments) target.comments.importThreads(json.comments, importedBy);
}

function validate(j: unknown): BoardJson {
  const b = j as BoardJson;
  if (!b || b.format !== 'driftboard' || !Array.isArray(b.objects)) throw new Error('This file is not a Tabula board.');
  if (b.comments && !Array.isArray(b.comments)) throw new Error('This file is not a Tabula board.');
  if ((b.polls && !Array.isArray(b.polls)) || (b.pollAnswers && !Array.isArray(b.pollAnswers))) throw new Error('This file is not a Tabula board.');
  if (b.schemaVersion > SCHEMA_VERSION) throw new Error('This board was made with a newer version of Tabula. Update the app to open it.');
  return b;
}

type SaveFile = (data: Blob | Uint8Array | string, name: string) => void;
let nativeSave: SaveFile | null = null;

/** The desktop app replaces the browser download with a native Save dialog (`desktop.ts`). */
export function setNativeSave(save: SaveFile | null) {
  nativeSave = save;
}

export function download(data: Blob | Uint8Array | string, name: string, type = 'application/octet-stream') {
  if (nativeSave) {
    nativeSave(data, name);
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeName = (s: string) => (s || 'board').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'board';

/**
 * The kanbans Cards as CSV takes (docs/kanban.md, Export and import): the ones given, else those of the selection (a
 * kanban, or the kanban of a selected lane or card), else every kanban on the board, in paint order.
 */
export function csvKanbans(app: BoardApp, ids?: readonly Id[]): Id[] {
  const all = app.store.shown().filter((o) => o.type === 'container' && app.store.containerLayout(o.id)).map((o) => o.id);
  const wanted = new Set((ids ?? app.selection).map((id) => containerOf(app.store, app.store.get(id))).filter((c): c is Id => !!c));
  const picked = all.filter((id) => wanted.has(id));
  return picked.length || ids ? picked : all;
}

/** Downloads the cards of kanbans as CSV. False (and nothing downloaded) when there is no kanban. */
export function downloadCardsCsv(app: BoardApp, ids?: readonly Id[]): boolean {
  const kanbans = csvKanbans(app, ids);
  if (!kanbans.length) return false;
  const rows = cardRows({
    get: (id) => app.store.get(id) as BaseObj | undefined,
    containerLayout: (id) => app.store.containerLayout(id),
    labels: listLabels(app.store),
    commentCount: (id) => app.r.commentCount(id),
  }, kanbans);
  const one = kanbans.length === 1 ? (app.store.get(kanbans[0]) as BaseObj).name ?? '' : null;
  download(csvText(rows), cardsCsvName(app.store.getMeta().name, one, safeName), 'text/csv;charset=utf-8');
  return true;
}

// ---------------------------------------------------------------- SVG / PNG

function usedFonts(objs: Obj[]): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>([['satoshi', new Set([500])]]);
  for (const o of objs) {
    const b = o as BaseObj;
    if (!b.font || b.font === 'system') continue;
    if (!fontIsAllowed(b.font)) continue;
    const s = m.get(b.font) ?? new Set<number>();
    s.add(nearestWeight(b.font, b.fontWeight || 400));
    if (o.type === 'uml-class') s.add(nearestWeight(b.font, 700));
    m.set(b.font, s);
  }
  return m;
}

/** Exports are drawn on white, so theme variables are replaced by their fallbacks. */
export function resolveCssVars(svg: string): string {
  return svg.replace(/var\(--[\w-]+,\s*([^)]+)\)/g, (_, fallback: string) => fallback.trim());
}

const HEX6 = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const rgbOf = (c: string): [number, number, number] | null => {
  if (!HEX6.test(c)) return null;
  const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const hexOf = (rgb: number[]) => '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * Replaces `color-mix(in srgb, A p%, B)` by a plain colour, for the editors and renderers that do not know color-mix
 * (Inkscape, Illustrator, librsvg draw it black). Run after resolveCssVars, when A and B are hex colours or
 * `transparent`. Mixed with `transparent` gives A at p% opacity: as `fill-opacity` or `stroke-opacity` where the mix is
 * a fill or a stroke in a style, else A alone. Nested mixes are resolved from the inside out.
 */
export function resolveColorMix(svg: string): string {
  const MIX = /color-mix\(in srgb,\s*(#[0-9a-f]{3,6}|transparent)\s+(\d+(?:\.\d+)?)%,\s*(#[0-9a-f]{3,6}|transparent)\s*\)/gi;
  let out = svg;
  for (let i = 0; i < 8 && /color-mix\(/i.test(out); i++) {
    out = out.replace(MIX, (all, a: string, pct: string, b: string) => {
      const p = Math.min(100, Math.max(0, Number(pct))) / 100;
      const ca = rgbOf(a), cb = rgbOf(b);
      if (ca && cb) return hexOf(ca.map((v, k) => v * p + cb[k] * (1 - p)));
      if (ca && b.toLowerCase() === 'transparent') return `${hexOf(ca)}@${Math.round(p * 1000) / 1000}`;
      if (cb && a.toLowerCase() === 'transparent') return `${hexOf(cb)}@${Math.round((1 - p) * 1000) / 1000}`;
      return all;
    });
  }
  return out
    .replace(/(fill|stroke):(#[0-9A-F]{6})@([\d.]+)/g, '$1:$2;$1-opacity:$3')
    .replace(/(#[0-9A-F]{6})@[\d.]+/g, '$1');
}

/** The pictures of the image objects among `objs`, as data URLs by object id: what an export draws in place of a live link. */
export async function imageDataUrls(app: BoardApp, objs: Obj[]): Promise<Map<Id, string>> {
  const out = new Map<Id, string>();
  for (const o of objs) {
    if (o.type === 'link') {
      // a link card's preview image and icon, under `<id>:image` and `<id>:icon`
      const l = o as BaseObj;
      for (const [part, hash] of [['image', l.image], ['icon', l.icon]] as const) {
        if (typeof hash !== 'string') continue;
        const url = await app.images.dataUrl({ ...l, asset: hash } as BaseObj);
        if (url) out.set(`${o.id}:${part}`, url);
      }
      continue;
    }
    if (o.type !== 'image') continue;
    const url = await app.images.dataUrl(o as BaseObj);
    if (url) out.set(o.id, url);
  }
  return out;
}

export function exportSvg(app: BoardApp, ids?: Id[], opts: { fontCss?: string; background?: boolean; images?: Map<Id, string> } = {}): { svg: string; w: number; h: number } {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.shown();
  const b = app.r.contentBounds(objs.map((o) => o.id)) ?? { x: 0, y: 0, w: 100, h: 100 };
  const pad = 40;
  const x = b.x - pad, y = b.y - pad - 10, w = b.w + pad * 2, h = b.h + pad * 2 + 10;
  // The ctx carries the canvas's own connector layout, whole-board even when only some objects are exported, so a
  // connector in the file ends where it does on the board, beside connectors that are not in it.
  const images = opts.images;
  const ctx = {
    ...app.r.ctx,
    editingId: null,
    tableSelection: null,
    // a file shows the board's content: full detail at any zoom, and nothing of a drag, an input or the editing chrome
    zoom: 1,
    dragging: undefined,
    dropLane: null,
    addingLane: null,
    editable: false,
    // a filter is a view, not content: dimmed cards export at full strength and the header has no Filter (docs/kanban.md)
    filterChips: undefined,
    dimmed: undefined,
    openControl: null,
    // an image is its data URL here, or a placeholder when its bytes were not found: never a link that only works on screen
    imageState: (o: BaseObj): ImageState => { const url = images?.get(o.id); return url ? { kind: 'ok', url } : { kind: 'failed', why: 'missing' }; },
    // a link card in a file: its picture and icon inlined like any image, no moving line, a pending preview drawn as one without an image
    linkAsset: (o: BaseObj, hash: string): ImageState => { const url = images?.get(`${o.id}:${hash === o.image ? 'image' : 'icon'}`); return url ? { kind: 'ok', url } : { kind: 'failed', why: 'missing' }; },
    still: true,
  };
  const body = objs.map((o) => objectMarkup(app.store.placed(o), ctx)).join('\n');
  const style = opts.fontCss ?? '';
  const bg = opts.background === false ? '' : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#FFFFFF"/>`;
  const svg = resolveColorMix(resolveCssVars(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x} ${y} ${w} ${h}"><defs>${SVG_DEFS}<style><![CDATA[
${style.replace(/]]>/g, '')}
]]></style></defs>${bg}${body}</svg>`));
  return { svg, w, h };
}

/** The SVG of the board (or of `ids`) with its pictures and available fonts inlined, so the file stands on its own. */
export async function exportSvgFile(app: BoardApp, ids?: Id[]): Promise<string> {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.shown();
  const fontCss = await inlineFontCss(objs);
  return exportSvg(app, ids, { fontCss, images: await imageDataUrls(app, objs) }).svg;
}

function gatherForExport(app: BoardApp, ids: Id[]): Obj[] {
  const set = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (app.store.get(id)?.type === 'frame' || app.store.get(id)?.type === 'group') {
      for (const c of app.store.childrenOf(id)) if (!set.has(c.id)) { set.add(c.id); stack.push(c.id); }
    }
    for (const cid of app.store.containerLayout(id)?.order ?? []) set.add(cid);
  }
  // include connectors between exported items
  for (const o of app.store.cache.values()) {
    if (o.type !== 'connector' || set.has(o.id)) continue;
    const c = o as Extract<Obj, { type: 'connector' }>;
    const a = c.from.kind === 'free' || set.has(c.from.id);
    const z = c.to.kind === 'free' || set.has(c.to.id);
    if (a && z && (c.from.kind === 'bound' || c.to.kind === 'bound')) set.add(o.id);
  }
  // Hidden objects (TAB-198) are left out of pictures, as on the canvas; whole-board JSON and .drift keep them.
  return app.store.shown().filter((o) => set.has(o.id));
}

/** A selected JSON snapshot carries shown objects in the selected subtree, except notes private writing hides from this person. */
function gatherForSnapshot(app: BoardApp, ids: Id[]): Obj[] {
  const visible = new Map(app.store.shown()
    .filter((o) => !isWithheld(o, app.flow))
    .map((o) => [o.id, o]));
  const set = new Set(ids.filter((id) => visible.has(id)));
  const stack = [...set];
  while (stack.length) {
    const id = stack.pop()!;
    const type = visible.get(id)?.type;
    if (type !== 'frame' && type !== 'group' && type !== 'container' && type !== 'lane') continue;
    for (const child of app.store.childrenOf(id)) {
      if (child.parent !== id || set.has(child.id) || !visible.has(child.id)) continue;
      set.add(child.id);
      stack.push(child.id);
    }
  }
  for (const id of set) {
    const o = visible.get(id);
    if (isConnector(o) && [o.from, o.to].some((end) => end.kind === 'bound' && !set.has(end.id))) set.delete(id);
  }
  for (const o of visible.values()) {
    if (!isConnector(o) || set.has(o.id)) continue;
    const c = o as Extract<Obj, { type: 'connector' }>;
    if (c.from.kind === 'bound' && c.to.kind === 'bound' && set.has(c.from.id) && set.has(c.to.id)) set.add(o.id);
  }
  return app.store.ordered().filter((o) => set.has(o.id));
}

/** Fetch and consume a response within `ms`, so a slow font never stalls an export. */
async function fetchWithin<T>(url: string, read: (res: Response) => Promise<T>, ms = FONT_FETCH_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort!: (error: Error) => void;
  const aborted = signal ? new Promise<T>((_, reject) => { rejectAbort = reject; }) : null;
  const onAbort = () => {
    ctrl.abort();
    rejectAbort(new Error(`Font fetch deadline exceeded: ${url}`));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timedOut = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Font fetch timed out: ${url}`));
    }, ms);
  });
  try {
    const request = (async () => {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Font fetch failed (${res.status}): ${url}`);
      return read(res);
    })();
    return await Promise.race([request, timedOut, ...(aborted ? [aborted] : [])]);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function responseBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = res.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    try { await res.body?.cancel(); } catch { /* the response may already be closed */ }
    throw new Error(`Font response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Font response exceeds ${maxBytes} bytes`);
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Font response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* the stream may already be closed */ }
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function toDataUrl(url: string, maxBytes: number, signal: AbortSignal): Promise<{ dataUrl: string; bytes: number }> {
  return fetchWithin(url, async (res) => {
    const bytes = await responseBytes(res, maxBytes);
    if (!bytes.byteLength) throw new Error('Font response was empty');
    return { dataUrl: `data:font/woff2;base64,${bytesToBase64(bytes)}`, bytes: bytes.byteLength };
  }, FONT_FETCH_TIMEOUT_MS, signal);
}

function faceUsesWeight(face: string, weights: Set<number>): boolean {
  const declaration = face.match(/\bfont-weight\s*:\s*([^;}]+)/i)?.[1];
  const range = declaration?.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (range.length === 1) return weights.has(range[0]);
  if (range.length === 2) return [...weights].some((weight) => weight >= range[0] && weight <= range[1]);
  return false;
}

/**
 * Fonts referenced by a board, inlined as data URLs. Fonts are fetched only
 * while exporting; the SVG and PNG then work without a Fontshare request.
 */
async function inlineFontCss(objs: Obj[]): Promise<string> {
  const parts: string[] = [];
  let embeddedBytes = 0;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), FONT_FETCH_TIMEOUT_MS);
  try {
    for (const [slug, ws] of usedFonts(objs)) {
      if (deadline.signal.aborted || embeddedBytes >= EMBEDDED_FONT_LIMIT_BYTES) break;
      const url = cssUrl(slug, [...ws]);
      if (!url) continue;
      let css: string;
      try {
        css = await fetchWithin(url, async (res) => new TextDecoder().decode(await responseBytes(res, FONT_CSS_LIMIT_BYTES)), FONT_FETCH_TIMEOUT_MS, deadline.signal);
      } catch {
        continue; // offline, blocked or malformed response: use the system fallback
      }

      const name = fontName(slug).toLowerCase();
      const faces = css.match(/@font-face\s*{[^}]*}/gi) ?? [];
      for (const face of faces) {
        if (deadline.signal.aborted || embeddedBytes >= EMBEDDED_FONT_LIMIT_BYTES) break;
        const family = face.match(/\bfont-family\s*:\s*([^;}]+)/i)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (family?.toLowerCase() !== name || !faceUsesWeight(face, ws)) continue;
        const woff2 = face.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)\s*format\(\s*(['"])woff2\3\s*\)/i);
        const src = face.match(/\bsrc\s*:[^;]*;?/i);
        if (!woff2 || !src) continue;
        let href: string;
        try {
          const parsed = new URL(woff2[2], url);
          if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.fontshare.com') continue;
          href = parsed.href;
        } catch {
          continue;
        }
        try {
          const font = await toDataUrl(href, EMBEDDED_FONT_LIMIT_BYTES - embeddedBytes, deadline.signal);
          embeddedBytes += font.bytes;
          parts.push(face.replace(src[0], `src: url("${font.dataUrl}") format("woff2");`));
        } catch {
          /* a failed or over-cap face uses the system fallback */
        }
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
  return parts.join('\n');
}

export async function exportPng(app: BoardApp, ids?: Id[], scale = 2): Promise<Blob> {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.shown();
  const fontCss = await inlineFontCss(objs);
  const { svg, w, h } = exportSvg(app, ids, { fontCss, images: await imageDataUrls(app, objs) });
  const max = 16000;
  const s = Math.min(scale, max / w, max / h);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the board image.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * s);
    canvas.height = Math.ceil(h * s);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Objects from an imported board, re-inserted into the current board with fresh ids. */
export function insertImported(app: BoardApp, json: BoardJson, assets?: Record<string, ImportedAsset>) {
  const objs = json.objects.filter((o) => o && typeof o.id === 'string' && typeof o.type === 'string');
  const boxes = objs.filter(isBox);
  if (!objs.length) return;
  const minX = Math.min(...boxes.map((o) => o.x)), minY = Math.min(...boxes.map((o) => o.y));
  const content = app.r.contentBounds();
  const target = content ? { x: content.x + content.w + 200, y: content.y } : app.r.viewport();
  const inserted = app.insertObjects(objs, { x: target.x - (isFinite(minX) ? minX : 0), y: target.y - (isFinite(minY) ? minY : 0) });
  if (assets && Object.keys(assets).length) void app.images.adopt(assets, new Set(inserted.map((o) => o.id)));
  const b = app.r.contentBounds(inserted.map((o) => o.id));
  if (b) app.r.flyTo(b);
}
