import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// The IndexedDB side is replaced by a recorder: Node has no IndexedDB, and what matters here is the order of events
// (open, wait for the stored state, fill, close) and the database names.
const log = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    whenSynced: Promise<unknown>;
    constructor(readonly name: string) {
      log.events.push(`open ${name}`);
      this.whenSynced = Promise.resolve().then(() => void log.events.push(`synced ${name}`));
    }
    async destroy() {
      log.events.push(`close ${this.name}`);
    }
    async clearData() {
      log.events.push(`clear ${this.name}`);
    }
  },
}));

import { Comments } from '../src/comments';
import { applyImported, download, readBoardFile, setNativeSave, toDrift, type BoardJson, type ImportedBoard } from '../src/exporters';
import { Store } from '../src/store';
import { deleteBoard, listBoards, onBoardDeleted, touchBoard, writeLocalBoard } from '../src/sync';
import type { BaseObj } from '../src/types';
import type { BoardApp } from '../src/app';

const box = (id: string, text: string): BaseObj => ({ id, type: 'shape', kind: 'rect', x: 10, y: 20, w: 100, h: 60, rotation: 0, z: 'a0', text });

/** The parts of BoardApp that `toDrift` reads. */
function fakeBoard(objects: BaseObj[], name = 'Retro') {
  const doc = new Y.Doc();
  const store = new Store(doc);
  const comments = new Comments(new Y.Doc());
  store.setMeta({ name });
  store.transact(() => objects.forEach((o) => store.create(o)));
  const app = { store, conn: { comments }, flow: { polls: { snapshot: () => ({ polls: [], answers: [] }) } } };
  return { app: app as unknown as BoardApp, store, comments };
}

const freshTarget = () => {
  const doc = new Y.Doc();
  return { doc, store: new Store(doc), comments: new Comments(new Y.Doc()) };
};

describe('a backup is a .drift file that restores the board', () => {
  it('round-trips objects, name and comments through toDrift, readBoardFile and applyImported', async () => {
    const { app, comments } = fakeBoard([box('a', 'first'), box('b', 'second')], 'Sprint retro');
    comments.addThread({ id: 'u1', name: 'Ann', color: '#112233' }, { x: 5, y: 6 }, 'Check this');

    const bytes = toDrift(app);
    const imported = await readBoardFile(new File([bytes as BlobPart], 'abc.drift'));
    expect(imported.update).toBeDefined();

    const target = freshTarget();
    applyImported(target, imported, null);
    expect(target.store.getMeta().name).toBe('Sprint retro');
    expect([...target.store.cache.keys()].sort()).toEqual(['a', 'b']);
    expect((target.store.get('b') as BaseObj).text).toBe('second');
    expect(target.comments.list().map((t) => t.text)).toEqual(['Check this']);
    // Restoring the board's own copy keeps its comments as they were: they are not someone else's import.
    expect(target.comments.list()[0]).toMatchObject({ authorId: 'u1' });
    expect(target.comments.list()[0].imported).toBeFalsy();
  });

  it('marks the comments of an imported file as imported by the person who opens it', async () => {
    const { app, comments } = fakeBoard([box('a', 'first')], 'Shared file');
    comments.addThread({ id: 'u1', name: 'Ann', color: '#112233' }, { x: 5, y: 6 }, 'Check this');
    const imported = await readBoardFile(new File([toDrift(app) as BlobPart], 'shared.drift'));
    const target = freshTarget();
    applyImported(target, imported, 'bob');
    expect(target.comments.list()[0]).toMatchObject({ authorId: 'u1', imported: true, importedBy: 'bob' });
  });

  it('applies a plain JSON snapshot the same way when the file has no sync state', () => {
    const json: BoardJson = {
      format: 'driftboard', schemaVersion: 1, exportedAt: '2026-10-08T10:00:00.000Z',
      meta: { name: 'From JSON' } as BoardJson['meta'], objects: [box('x', 'only')], flow: {} as BoardJson['flow'],
    };
    const target = freshTarget();
    applyImported(target, { json } as ImportedBoard, 'importer');
    expect(target.store.getMeta().name).toBe('From JSON');
    expect([...target.store.cache.keys()]).toEqual(['x']);
  });
});

describe('merging a backup into a board that lost its storage', () => {
  const backupOf = async (objects: BaseObj[]) => {
    const { app } = fakeBoard(objects);
    return readBoardFile(new File([toDrift(app) as BlobPart], 'a.drift'));
  };

  it('brings the content back into the empty board that was opened in its place', async () => {
    const backup = await backupOf([box('a', 'first'), box('b', 'second')]);
    const opened = freshTarget();
    Y.applyUpdate(opened.doc, backup.update!);
    expect([...opened.store.cache.keys()].sort()).toEqual(['a', 'b']);
  });

  it('keeps what was edited since the backup and does not bring back what was deleted since', async () => {
    const backup = await backupOf([box('a', 'first'), box('b', 'second')]);
    const opened = freshTarget();
    applyImported(opened, backup, null);
    opened.store.transact(() => {
      opened.store.remove(['a']);
      opened.store.create(box('c', 'newer'));
      opened.store.update('b', { text: 'edited later' });
    });
    Y.applyUpdate(opened.doc, backup.update!);
    expect([...opened.store.cache.keys()].sort()).toEqual(['b', 'c']);
    expect((opened.store.get('b') as BaseObj).text).toBe('edited later');
  });

  it('is a no-op for a board that is already complete: no update is emitted, so nothing is written to storage', async () => {
    const backup = await backupOf([box('a', 'first')]);
    const opened = freshTarget();
    applyImported(opened, backup, null);
    const updates: number[] = [];
    opened.doc.on('update', () => updates.push(1));
    Y.applyUpdate(opened.doc, backup.update!);
    expect(updates).toEqual([]);
  });
});

describe('writing a board into local storage without opening it', () => {
  beforeEach(() => {
    log.events.length = 0;
  });

  it('opens both databases under the board id, waits for them, fills, then closes them', async () => {
    await writeLocalBoard('abc123', () => void log.events.push('fill'));
    const i = (e: string) => log.events.indexOf(e);
    expect(log.events.filter((e) => e.startsWith('open')).sort()).toEqual(['open driftboard:abc123', 'open driftboard:abc123~comments']);
    expect(i('fill')).toBeGreaterThan(i('synced driftboard:abc123'));
    expect(i('fill')).toBeGreaterThan(i('synced driftboard:abc123~comments'));
    expect(i('close driftboard:abc123')).toBeGreaterThan(i('fill'));
    expect(i('close driftboard:abc123~comments')).toBeGreaterThan(i('fill'));
  });

  it('hands the fill step documents that take the import', async () => {
    const { app } = fakeBoard([box('a', 'kept')]);
    const imported = await readBoardFile(new File([toDrift(app) as BlobPart], 'a.drift'));
    let seen: string[] = [];
    await writeLocalBoard('abc123', (target) => {
      applyImported(target, imported, null);
      seen = [...target.store.cache.keys()];
    });
    expect(seen).toEqual(['a']);
  });
});

describe('deleting a board runs the after-delete hooks', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    log.events.length = 0;
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('removes the board from the list, clears its storage, then calls the hooks', async () => {
    touchBoard('keep', { name: 'Keep' });
    touchBoard('gone', { name: 'Gone' });
    const seen: string[] = [];
    const off = onBoardDeleted((id) => {
      seen.push(`${id} after clear=${log.events.includes('clear driftboard:gone~comments')}`);
    });
    await deleteBoard('gone');
    off();
    expect(listBoards().map((b) => b.id)).toEqual(['keep']);
    expect(seen).toEqual(['gone after clear=true']);
  });

  it('a hook that fails does not stop the others or the delete, and a removed hook is not called', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    touchBoard('gone', { name: 'Gone' });
    const second = vi.fn<(id: string) => void>();
    const removed = vi.fn<(id: string) => void>();
    const offs = [
      onBoardDeleted(async () => { throw new Error('backup folder is locked'); }),
      onBoardDeleted(second),
      onBoardDeleted(removed),
    ];
    offs[2]();
    await expect(deleteBoard('gone')).resolves.toBeUndefined();
    offs.forEach((off) => off());
    expect(second).toHaveBeenCalledWith('gone');
    expect(removed).not.toHaveBeenCalled();
    expect(listBoards()).toEqual([]);
  });
});

describe('export downloads', () => {
  afterEach(() => {
    setNativeSave(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('go to the native save when the desktop app installed one, and never touch the page', () => {
    const save = vi.fn<(data: Blob | Uint8Array | string, name: string) => void>();
    setNativeSave(save);
    const bytes = new Uint8Array([1]);
    download(bytes, 'board.drift', 'application/zip');
    download('# Summary', 'board-summary.md', 'text/markdown');
    expect(save.mock.calls).toEqual([[bytes, 'board.drift'], ['# Summary', 'board-summary.md']]);
  });

  it('are an <a download> click on a blob URL in a browser, as before', () => {
    vi.useFakeTimers();
    const anchor = { href: '', download: '', click: vi.fn<() => void>(), remove: vi.fn<() => void>() };
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn<() => void>() } });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    download('{}', 'board.json', 'application/json');
    expect(anchor).toMatchObject({ href: 'blob:x', download: 'board.json' });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    create.mockRestore();
    revoke.mockRestore();
  });
});
