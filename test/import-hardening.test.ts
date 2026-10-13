import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { applyImported, canonicalJson, digestOf, ImportAborted, importBoard, yieldToEventLoop, IMPORT_LIMITS, OWN_BACKUP_LIMITS, readBoardBytes, toDrift, undoImport, type ImportedBoard } from '../src/exporters';
import { Comments } from '../src/comments';
import { Store } from '../src/store';
import { checkYUpdate, ImportError } from '../src/yupdate-check';
import { runRecovery, showRecoveryFailure, type RecoveryNoticeDeps } from '../src/desktop-logic';
import type { BoardApp } from '../src/app';
import type { Obj } from '../src/types';

const board = strToU8(JSON.stringify({ format: 'driftboard', schemaVersion: 1, meta: {}, objects: [], flow: {} }));
const target = () => {
  const doc = new Y.Doc();
  return { doc, store: new Store(doc), comments: new Comments(new Y.Doc()) };
};
const instant = { confirm: async () => true };
const limits = { clients: 10_000, structs: 1_500_000 };

/** A one-struct-per-client update, built by hand: a string item in the root map `m`, then (optionally) a client that lies. */
function crafted(lie?: { count: number }): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, lie ? 2 : 1);
  // client 1: one string item with a root parent
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, 0);
  encoding.writeUint8(enc, 4); // string content, no origins
  encoding.writeVarUint(enc, 1); // parent is a root name
  encoding.writeVarString(enc, 'm');
  encoding.writeVarString(enc, 'a');
  if (lie) {
    encoding.writeVarUint(enc, lie.count);
    encoding.writeVarUint(enc, 2);
    encoding.writeVarUint(enc, 0);
  } else {
    encoding.writeVarUint(enc, 0); // an empty delete set
  }
  return encoding.toUint8Array(enc);
}

function appWith(objects: Obj[], comments?: (c: Comments) => void): BoardApp {
  const store = new Store(new Y.Doc());
  const c = new Comments(new Y.Doc());
  store.transact(() => objects.forEach((o) => store.create(o)));
  comments?.(c);
  return {
    store,
    flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [], answers: [] }) } },
    conn: { comments: c },
    images: { blobOf: async () => null },
  } as unknown as BoardApp;
}
const sticky = (id: string, text: string): Obj => ({ id, type: 'sticky', x: 1, y: 2, w: 10, h: 10, rotation: 0, z: `z${id}`, text, createdBy: 'u1' }) as unknown as Obj;
/** Text that does not compress away, so the file is as big as the data. */
const noise = (n: number, seed: number) => {
  let x = seed;
  let out = '';
  while (out.length < n) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out += x.toString(36); }
  return out.slice(0, n);
};

describe('the Yjs preflight reads every client', () => {
  it('counts clients and structs the way Yjs decodes them', () => {
    const doc = new Y.Doc();
    const other = new Y.Doc();
    doc.getMap('objects').set('a', new Y.Map([['type', 'sticky'], ['xs', [1, 2, 3]]]));
    other.getMap('objects').set('b', new Y.Map([['type', 'sticky']]));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    doc.getText('t').insert(0, 'hello');
    doc.getMap('objects').delete('a');
    const update = Y.encodeStateAsUpdate(doc);
    const shape = checkYUpdate(update, limits, 'too big');
    expect(shape.clients).toBe(2);
    expect(shape.structs).toBe(Y.decodeUpdate(update).structs.length);
  });

  it('refuses a SECOND client that declares a billion structs, and a client count over the limit, before anything is applied', () => {
    expect(checkYUpdate(crafted(), limits, 'x')).toEqual({ clients: 1, structs: 1 });
    expect(() => checkYUpdate(crafted({ count: 900_000_000 }), limits, 'too big')).toThrow('too big');
    expect(() => checkYUpdate(crafted({ count: 5 }), limits, 'too big')).toThrow(ImportError); // 5 declared, none present
    const many = encoding.createEncoder();
    encoding.writeVarUint(many, 1_000_000);
    expect(() => checkYUpdate(encoding.toUint8Array(many), limits, 'too big')).toThrow('too big');
    expect(() => checkYUpdate(new Uint8Array([0xff, 0xff]), limits, 'x')).toThrow(/cannot be read/);
  });

  it('refuses a total struct count over the limit', () => {
    const doc = new Y.Doc();
    doc.transact(() => { for (let i = 0; i < 50; i++) doc.getMap('m').set(`k${i}`, i); });
    const update = Y.encodeStateAsUpdate(doc);
    expect(() => checkYUpdate(update, { clients: 10, structs: 10 }, 'too many')).toThrow('too many');
    expect(checkYUpdate(update, { clients: 10, structs: 50 }, 'x').structs).toBe(50);
  });

  it('applies to the board file and to its comments update, and a lying file never reaches Y.applyUpdate', () => {
    const lying = zipSync({ 'board.json': board, 'doc.yjs': crafted({ count: 900_000_000 }) });
    expect(() => readBoardBytes(lying)).toThrow(/board data in this file is larger/);
    const lyingComments = zipSync({ 'board.json': board, 'doc.yjs': Y.encodeStateAsUpdate(new Y.Doc()), 'comments.yjs': crafted({ count: 900_000_000 }) });
    expect(() => readBoardBytes(lyingComments)).toThrow(/board data in this file is larger/);
    expect(() => Comments.threadsFromUpdate(crafted({ count: 900_000_000 }))).toThrow(/comments in this file are larger/);
    const t = target();
    expect(() => t.comments.importUpdate(crafted({ count: 900_000_000 }), 'me')).toThrow(ImportError);
  });

  it('passes a legitimate large board: 5,000 objects, 20 MiB', async () => {
    const objects = Array.from({ length: 5000 }, (_, i) => sticky(`s${i}`, noise(4096, i + 1)));
    const bytes = await toDrift(appWith(objects));
    expect(bytes.length).toBeGreaterThan(20 * 1024 * 1024);
    // as the app's own backup
    const own = target();
    applyImported(own, readBoardBytes(bytes, OWN_BACKUP_LIMITS), null);
    expect(own.store.objects.size).toBe(5000);
    // and as somebody else's file: within the foreign limits, written in many messages each under the relay's budget
    const imported = readBoardBytes(bytes, IMPORT_LIMITS);
    const t = target();
    const sizes: number[] = [];
    t.doc.on('update', (u: Uint8Array) => sizes.push(u.length));
    const outcome = await importBoard(t, imported, 'me', instant);
    expect(outcome.ok).toBe(true);
    expect(t.store.objects.size).toBe(5000);
    expect(Math.max(...sizes)).toBeLessThan(2 * 1024 * 1024);
    expect(sizes.length).toBeGreaterThan(15);
  }, 120_000);
});

describe('the delete set, trailing bytes and the V2 format', () => {
  it('a zero-struct update with a huge delete set is refused before Yjs builds its ranges', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0); // no clients
    encoding.writeVarUint(enc, 1); // one delete-set client
    encoding.writeVarUint(enc, 7);
    encoding.writeVarUint(enc, 900_000_000); // ranges
    expect(() => checkYUpdate(encoding.toUint8Array(enc), limits, 'too big')).toThrow('too big');
    const many = encoding.createEncoder();
    encoding.writeVarUint(many, 0);
    encoding.writeVarUint(many, 1_000_000); // delete-set clients
    expect(() => checkYUpdate(encoding.toUint8Array(many), limits, 'too big')).toThrow('too big');
    // ranges under the byte check but over the total limit
    const doc = new Y.Doc();
    doc.transact(() => { for (let i = 0; i < 40; i++) doc.getMap('m').set(`k${i}`, i); });
    doc.transact(() => { for (let i = 0; i < 40; i += 2) doc.getMap('m').delete(`k${i}`); });
    expect(() => checkYUpdate(Y.encodeStateAsUpdate(doc), { clients: 10, structs: 30 }, 'too big')).toThrow('too big');
  });

  it('refuses trailing bytes, and a V2 update with a clear message instead of importing it as empty', () => {
    const update = Y.encodeStateAsUpdate(new Y.Doc());
    expect(checkYUpdate(update, limits, 'x')).toEqual({ clients: 0, structs: 0 });
    const withContent = new Y.Doc();
    withContent.getMap('objects').set('a', 1);
    expect(() => checkYUpdate(new Uint8Array([...Y.encodeStateAsUpdate(withContent), 9, 9, 9]), limits, 'x')).toThrow(/cannot be read/);
    const doc = new Y.Doc();
    doc.getMap('objects').set('a', new Y.Map([['type', 'sticky']]));
    doc.getMap('objects').set('b', 'x');
    expect(() => checkYUpdate(Y.encodeStateAsUpdateV2(doc), limits, 'x')).toThrow('This board file uses a format Tabula cannot open.');
    expect(() => readBoardBytes(zipSync({ 'board.json': board, 'doc.yjs': Y.encodeStateAsUpdateV2(doc) }))).toThrow(/format Tabula cannot open/);
  });

  it('a legitimate update with deletes and several writers passes and counts them', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getMap('objects').set('x', new Y.Map([['type', 'sticky']]));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getMap('objects').set('y', new Y.Map([['type', 'sticky']]));
    b.getMap('objects').delete('x');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const update = Y.encodeStateAsUpdate(a);
    const shape = checkYUpdate(update, limits, 'x');
    expect(shape.structs).toBe(Y.decodeUpdate(update).structs.length);
    expect(shape.clients).toBe(2);
  });
});

describe('the app\'s own backups', () => {
  it('a 40 MiB backup restores through the recovery (it would be refused as a foreign file)', async () => {
    const objects = Array.from({ length: 400 }, (_, i) => sticky(`s${i}`, noise(100_000, i + 7)));
    const bytes = await toDrift(appWith(objects));
    expect(bytes.length).toBeGreaterThan(40 * 1024 * 1024);
    expect(() => readBoardBytes(bytes, IMPORT_LIMITS)).toThrow(/larger than 32 MiB/);
    const t = target();
    const toast = vi.fn<RecoveryNoticeDeps['toast']>();
    const restored = await runRecovery({
      listBackups: async () => ['b1'],
      readBackup: async () => bytes,
      localIds: () => new Set<string>(),
      parse: async (_id, b) => readBoardBytes(b, OWN_BACKUP_LIMITS),
      store: async (_id, imported) => { applyImported(t, imported, null); },
    }, { toast, retry: async () => undefined, saveCopy: async () => undefined, describe: String }, async () => undefined);
    expect(restored).toEqual(['b1']);
    expect(t.store.objects.size).toBe(400);
    expect(toast).toHaveBeenCalledWith('Restored 1 board from its backup copy');
  }, 60_000);

  const failing = (parse: () => Promise<ImportedBoard>, over: Partial<RecoveryNoticeDeps> = {}) => {
    const toast = vi.fn<RecoveryNoticeDeps['toast']>();
    const kept: Uint8Array[] = [new Uint8Array([1, 2, 3])];
    const saveCopy = vi.fn<RecoveryNoticeDeps['saveCopy']>(async () => undefined);
    const notice: RecoveryNoticeDeps = { toast, retry: async () => { await parse(); }, saveCopy, describe: (e) => (e instanceof Error ? e.message : String(e)), ...over };
    return { toast, kept, saveCopy, notice, run: () => runRecovery({
      listBackups: async () => ['b1'], readBackup: async () => kept[0], localIds: () => new Set<string>(), parse: parse as never, store: async () => undefined,
    }, notice, async () => { await parse(); }) };
  };

  it('a backup over its limit shows a message with Try again, keeps the file, and then offers a copy of it', async () => {
    const parse = async () => { throw new ImportError('The board data in this file is larger than 256 MiB, which is more than Tabula opens.'); };
    const f = failing(parse);
    expect(await f.run()).toEqual([]);
    expect(f.toast).toHaveBeenCalledTimes(1);
    const [message, , action] = f.toast.mock.calls[0];
    expect(message).toMatch(/Could not restore a board from its backup copy: The board data in this file is larger than 256 MiB/);
    expect(message).toMatch(/files are kept/);
    expect(action?.label).toBe('Try again');
    action!.onClick();
    await new Promise((r) => setTimeout(r, 0));
    const second = f.toast.mock.calls[1];
    expect(second[2]?.label).toBe('Save a copy of the backup');
    second[2]!.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.saveCopy).toHaveBeenCalledWith('b1');
    expect(f.kept[0]).toEqual(new Uint8Array([1, 2, 3])); // nothing deleted
  });

  it('a retry that works says so', async () => {
    let calls = 0;
    const f = failing(async () => { if (calls++ === 0) throw new Error('disk busy'); return {} as ImportedBoard; });
    await f.run();
    f.toast.mock.calls[0][2]!.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.toast).toHaveBeenLastCalledWith('The backup was restored.');
  });

  it('an unreadable backup folder is told too, never only logged', async () => {
    const toast = vi.fn<RecoveryNoticeDeps['toast']>();
    await runRecovery({
      listBackups: async () => { throw new Error('permission denied'); }, readBackup: async () => new Uint8Array(), localIds: () => new Set<string>(),
      parse: async () => ({}) as ImportedBoard, store: async () => undefined,
    }, { toast, retry: async () => undefined, saveCopy: async () => undefined, describe: (e) => (e as Error).message }, async () => undefined);
    expect(toast.mock.calls[0][0]).toMatch(/Could not look for the backup copies of your boards: permission denied/);
    expect(toast.mock.calls[0][2]?.label).toBe('Try again');
    showRecoveryFailure({ toast, retry: async () => undefined, saveCopy: async () => undefined, describe: String }, null, new Error('x'), 2);
    expect(toast.mock.calls[1][0]).toMatch(/Restart the app/);
  });
});

describe('comments are written in pieces and confirmed through the comments room', () => {
  const author = { id: 'u2', name: 'Ula', color: '#326DD3' };
  const withThreads = (n: number, textLen = 3000) => appWith([sticky('a', 'x')], (c) => {
    for (let i = 0; i < n; i++) c.addThread(author, { x: i, y: 1, obj: 'a' }, noise(textLen, i + 3).slice(0, 3000));
  });

  it('splits many threads over several messages and asks the comments room, not only the board room', async () => {
    const app = withThreads(800);
    const imported = readBoardBytes(await toDrift(app), IMPORT_LIMITS);
    const t = target();
    const sizes: number[] = [];
    t.comments.doc.on('update', (u: Uint8Array) => sizes.push(u.length));
    const rooms: string[] = [];
    const outcome = await importBoard(t, imported, 'me', { confirm: async (_ms, room) => { rooms.push(room); return true; } });
    expect(outcome.ok).toBe(true);
    expect(t.comments.list()).toHaveLength(800);
    expect(sizes.length).toBeGreaterThan(2);
    expect(Math.max(...sizes)).toBeLessThan(2 * 1024 * 1024);
    expect(rooms).toContain('comments');
    expect(outcome.ok && (await outcome.final)).toEqual({ state: 'confirmed' });
  });

  it('is not confirmed while the comments room is silent, and is refused when it takes comments back', async () => {
    const imported = readBoardBytes(await toDrift(withThreads(5, 100)), IMPORT_LIMITS);
    let clock = 0;
    const silent = target();
    const a = await importBoard(silent, imported, 'me', { confirm: async (_ms, room) => room === 'board', finalWindowMs: 2000, retryMs: 1, now: () => (clock += 400), stepWindowMs: 1000 });
    expect(a.ok && (await a.final)).toEqual({ state: 'unconfirmed' });
    const t = target();
    const b = await importBoard(t, imported, 'me', {
      confirm: async (_ms, room) => { if (room === 'comments') t.comments.threads.forEach((_, id) => t.comments.threads.delete(id)); return true; },
    });
    expect(b.ok && (await b.final)).toEqual({ state: 'refused', missing: ['comments'] });
  });

  it('a hostile comments file cannot add fields or forbidden keys to a reply', () => {
    const t = target();
    const hostile = [{
      id: 't1', createdAt: 1, authorId: 'x', authorName: 'X', authorColor: 'red', text: 'hi', anchor: { x: 1, y: 2 }, resolved: false,
      replies: [JSON.parse('{"id":"r1","authorId":"x","authorName":"X","authorColor":"#112233","text":"re","createdAt":2,"__proto__":{"a":1},"evil":"yes"}')],
    }];
    t.comments.importThreads(hostile as never, 'me');
    const reply = Object.values((t.comments.threads.get('t1') as Y.Map<unknown>).toJSON().replies as Record<string, Record<string, unknown>>)[0];
    expect(Object.keys(reply).sort()).toEqual(['authorColor', 'authorId', 'authorName', 'createdAt', 'id', 'imported', 'importedBy', 'text']);
    expect((t.comments.threads.get('t1') as Y.Map<unknown>).get('authorColor')).toBe('#5B6672');
  });
});

describe('removal compares collision-resistant digests', () => {
  it('uses SHA-256 over a canonical serialisation', async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    const d = await digestOf({ a: 1, b: 2 });
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestOf({ b: 2, a: 1 })).toBe(d);
    expect(await digestOf({ a: 1, b: 3 })).not.toBe(d);
  });

  it('leaves an edited imported reply, an edited thread, and a thread somebody replied to', async () => {
    const author = { id: 'u2', name: 'Ula', color: '#326DD3' };
    const app = appWith([sticky('a', 'x')], (c) => {
      const t1 = c.addThread(author, { x: 1, y: 1 }, 'first')!;
      c.reply(t1, author, 'reply to first');
      const t2 = c.addThread(author, { x: 2, y: 2 }, 'second')!;
      c.reply(t2, author, 'reply to second');
      c.addThread(author, { x: 3, y: 3 }, 'third, untouched');
    });
    const t = target();
    const outcome = await importBoard(t, readBoardBytes(await toDrift(app), IMPORT_LIMITS), 'me', instant);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byText = (text: string) => t.comments.list().find((th) => th.text === text)!;
    // 1: the person edits an imported reply; 2: edits the thread's own text; 3: nothing
    const first = byText('first');
    t.comments.threads.get(first.id)!.set('text', 'first, edited by me');
    const second = byText('second');
    (t.comments.threads.get(second.id)!.get('replies') as Y.Map<unknown>).set(second.replies[0].id, { ...second.replies[0], text: 'edited reply' });
    const r = await undoImport(t.store, t.comments, outcome.manifest);
    const left = t.comments.list().map((th) => th.text).sort();
    expect(left).toEqual(['first, edited by me', 'second']); // 'third, untouched' went; both edited threads stayed
    expect(t.comments.list().find((th) => th.text === 'second')!.replies.map((x) => x.text)).toEqual(['edited reply']);
    expect(t.comments.list().find((th) => th.text === 'first, edited by me')!.replies).toHaveLength(0); // its untouched reply went
    expect(r.comments).toBe(1);
    expect(r.left).toBeGreaterThanOrEqual(2);
  });
});

describe('the preparation of an import shares the main thread', () => {
  const objects = Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}`, type: 'sticky', x: i, y: 2, w: 10, h: 10, rotation: 0, z: `z${i}`, text: `note ${i}` }));
  const file = { json: { format: 'driftboard', schemaVersion: 1, exportedAt: '', meta: { name: 'Theirs' }, objects, flow: {} } } as unknown as ImportedBoard;
  /** A clock that moves 10 ms every time it is read, and a yield that only counts. */
  const fake = () => {
    let t = 0;
    const state = { yields: 0, progress: [] as number[] };
    return {
      state,
      slicing: { sliceMs: 30, clock: () => (t += 10), yieldNow: async () => { state.yields++; }, onProgress: (done: number) => { state.progress.push(done); } },
    };
  };

  it('yields many times on a large input, reports progress from 0 to the total, and ends with the same result as without slicing', async () => {
    const f = fake();
    const sliced = target();
    const a = await importBoard(sliced, file, 'me', { ...instant, slicing: f.slicing });
    const whole = target();
    const b = await importBoard(whole, file, 'me', { ...instant, slicing: { sliceMs: 1e12 } });
    expect(a.ok && b.ok).toBe(true);
    expect(f.state.yields).toBeGreaterThan(20);
    expect(f.state.progress[0]).toBe(0);
    expect(f.state.progress.at(-1)).toBe(3001 + 0); // 3000 objects and the one setting
    expect([...f.state.progress]).toEqual([...f.state.progress].sort((x, y) => x - y));
    expect(a.ok && b.ok && a.manifest).toEqual(b.ok && b.manifest);
    expect(sliced.store.objects.size).toBe(3000);
  });

  it('a failure in a later slice leaves the board untouched', async () => {
    let calls = 0;
    const t = target();
    const f = fake();
    await expect(importBoard(t, file, 'me', { ...instant, slicing: { ...f.slicing, yieldNow: async () => { if (++calls === 5) throw new Error('later slice failed'); } } })).rejects.toThrow('later slice failed');
    expect(t.store.objects.size + t.store.meta.size + t.comments.threads.size).toBe(0);
    expect(t.store.undo.undoStack.length).toBe(0);
  });

  it('an abort between slices stops it and nothing is written', async () => {
    const controller = new AbortController();
    const t = target();
    const f = fake();
    const outcome = importBoard(t, file, 'me', { ...instant, slicing: { ...f.slicing, signal: controller.signal, yieldNow: async () => { f.state.yields++; if (f.state.yields === 3) controller.abort(); } } });
    await expect(outcome).rejects.toThrow(ImportAborted);
    expect(f.state.yields).toBe(3);
    expect(t.store.objects.size + t.store.meta.size).toBe(0);
    expect(t.store.undo.undoStack.length).toBe(0);
  });

  it('a signal that is already aborted writes nothing at all', async () => {
    const t = target();
    await expect(importBoard(t, file, 'me', { ...instant, slicing: { signal: AbortSignal.abort() } })).rejects.toThrow(ImportAborted);
    expect(t.store.objects.size).toBe(0);
  });

  it('uses scheduler.yield when the browser has it, else a macro-task', async () => {
    const scheduler = { yield: vi.fn<() => Promise<void>>(async () => undefined) };
    vi.stubGlobal('scheduler', scheduler);
    await yieldToEventLoop();
    expect(scheduler.yield).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    let ran = false;
    const pending = yieldToEventLoop().then(() => { ran = true; });
    await Promise.resolve();
    expect(ran).toBe(false); // not a micro-task
    await pending;
    expect(ran).toBe(true);
  });
});
