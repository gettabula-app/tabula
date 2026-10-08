import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBackupWriter,
  createDebouncer,
  createOpenedFiles,
  fileNameOf,
  headerSafeName,
  mergeBackup,
  restoreMissing,
  saveExport,
  worthBackingUp,
  type Invoke,
} from '../src/desktop-logic';
import type { ImportedBoard } from '../src/exporters';

const bytesOf = (...n: number[]) => new Uint8Array(n);
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

describe('files the system opened', () => {
  /** A fake shell: `queued` is what `take_opened_files` hands out, `files` the content by path. */
  function shell(files: Record<string, number[] | Error>) {
    const queued: string[] = [];
    const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async (cmd, args) => {
      if (cmd === 'take_opened_files') return queued.splice(0);
      const path = (args as { path: string }).path;
      const content = files[path];
      if (content instanceof Error) throw content;
      return bytesOf(...content).buffer;
    });
    return { queued, invoke: invoke as unknown as Invoke, calls: invoke };
  }

  it('imports each file with its name and marks only the last one to open', async () => {
    const { queued, invoke } = shell({ '/b/a.drift': [1, 2], 'C:\\Users\\ann\\retro board.drift': [3] });
    const seen: { name: string; size: number; last: boolean }[] = [];
    const opened = createOpenedFiles({
      invoke,
      importFile: async (file, last) => void seen.push({ name: file.name, size: file.size, last }),
      onError: () => expect.unreachable(),
    });
    queued.push('/b/a.drift', 'C:\\Users\\ann\\retro board.drift');
    await opened.check();
    expect(seen).toEqual([
      { name: 'a.drift', size: 2, last: false },
      { name: 'retro board.drift', size: 1, last: true },
    ]);
  });

  it('does nothing when nothing is waiting', async () => {
    const { invoke, calls } = shell({});
    const importFile = vi.fn<(file: File, last: boolean) => Promise<void>>();
    await createOpenedFiles({ invoke, importFile, onError: vi.fn<() => void>() }).check();
    expect(importFile).not.toHaveBeenCalled();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('reports a file that cannot be read or imported and carries on with the others', async () => {
    const { queued, invoke } = shell({ '/b/gone.drift': new Error('not a file the system asked this app to open'), '/b/bad.drift': [9], '/b/ok.drift': [1] });
    const imported: string[] = [];
    const errors: [string, string | null][] = [];
    const opened = createOpenedFiles({
      invoke,
      importFile: async (file) => {
        if (file.name === 'bad.drift') throw new Error('This file is not a Tabula board.');
        imported.push(file.name);
      },
      onError: (e, path) => errors.push([(e as Error).message, path]),
    });
    queued.push('/b/gone.drift', '/b/bad.drift', '/b/ok.drift');
    await opened.check();
    expect(imported).toEqual(['ok.drift']);
    expect(errors).toEqual([
      ['not a file the system asked this app to open', '/b/gone.drift'],
      ['This file is not a Tabula board.', '/b/bad.drift'],
    ]);
  });

  it('reports a failure to ask the shell, and a later check still works', async () => {
    const invoke = vi.fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('shell is gone'))
      .mockResolvedValueOnce([]) as unknown as Invoke;
    const errors: unknown[] = [];
    const opened = createOpenedFiles({ invoke, importFile: vi.fn<() => Promise<void>>(), onError: (e, path) => errors.push([(e as Error).message, path]) });
    await opened.check();
    await opened.check();
    expect(errors).toEqual([['shell is gone', null]]);
  });

  it('never imports two batches at the same time (the event fires while the startup batch runs)', async () => {
    const { queued, invoke } = shell({ '/b/1.drift': [1], '/b/2.drift': [2] });
    let active = 0;
    let most = 0;
    const names: string[] = [];
    const opened = createOpenedFiles({
      invoke,
      importFile: async (file) => {
        most = Math.max(most, ++active);
        await pause();
        names.push(file.name);
        active--;
      },
      onError: () => expect.unreachable(),
    });
    queued.push('/b/1.drift');
    const first = opened.check();
    queued.push('/b/2.drift');
    const second = opened.check();
    await Promise.all([first, second]);
    expect(most).toBe(1);
    expect(names).toEqual(['1.drift', '2.drift']);
  });

  it('names a file from either kind of path', () => {
    expect(fileNameOf('/Users/ann/My Board.drift')).toBe('My Board.drift');
    expect(fileNameOf('C:\\Users\\ann\\a.drift')).toBe('a.drift');
    expect(fileNameOf('')).toBe('board.drift');
  });
});

describe('backup debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once, after things have been quiet', () => {
    const fn = vi.fn<() => void>();
    const d = createDebouncer(fn, 3000, 30000);
    d.poke();
    vi.advanceTimersByTime(2000);
    d.poke();
    vi.advanceTimersByTime(2999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still runs during steady editing, at the longest wait', () => {
    const fn = vi.fn<() => void>();
    const d = createDebouncer(fn, 3000, 10000);
    for (let t = 0; t < 10000; t += 1000) {
      d.poke();
      vi.advanceTimersByTime(1000);
    }
    expect(fn).toHaveBeenCalledTimes(1);
    d.poke();
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('flush runs a waiting call now, once, and does nothing when nothing waits', () => {
    const fn = vi.fn<() => void>();
    const d = createDebouncer(fn, 3000, 30000);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
    d.poke();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    d.flush();
    vi.advanceTimersByTime(60000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the wait', () => {
    const fn = vi.fn<() => void>();
    const d = createDebouncer(fn, 3000, 30000);
    d.poke();
    d.cancel();
    vi.advanceTimersByTime(60000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('which boards are backed up', () => {
  it('skips a board with nothing on it, so it cannot replace a fuller backup', () => {
    expect(worthBackingUp(0, true)).toBe(false);
    expect(worthBackingUp(3, true)).toBe(true);
  });

  it('skips a board that is no longer in the list: it was deleted, and its backup was removed with it', () => {
    expect(worthBackingUp(3, false)).toBe(false);
  });
});

describe('backup writer', () => {
  it('sends the snapshot as the raw body with the board id in a header', async () => {
    const invoke = vi.fn<() => Promise<void>>(async () => undefined);
    const writer = createBackupWriter({ invoke: invoke as unknown as Invoke, id: 'abc_123-X', onError: () => expect.unreachable() });
    const snapshot = bytesOf(1, 2, 3);
    writer.write(snapshot);
    await writer.done();
    expect(invoke).toHaveBeenCalledWith('backup_board', snapshot, { headers: { 'x-board-id': 'abc_123-X' } });
  });

  it('writes one at a time, and only the newest of the snapshots that arrive meanwhile', async () => {
    const written: number[] = [];
    let active = 0;
    let most = 0;
    const invoke = (async (_cmd: string, bytes: Uint8Array) => {
      most = Math.max(most, ++active);
      await pause();
      written.push(bytes[0]);
      active--;
    }) as unknown as Invoke;
    const writer = createBackupWriter({ invoke, id: 'b', onError: () => expect.unreachable() });
    writer.write(bytesOf(1));
    writer.write(bytesOf(2));
    writer.write(bytesOf(3));
    await writer.done();
    expect(written).toEqual([1, 3]);
    expect(most).toBe(1);
    writer.write(bytesOf(4));
    await writer.done();
    expect(written).toEqual([1, 3, 4]);
  });

  it('reports a failed write and keeps going', async () => {
    const invoke = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined) as unknown as Invoke;
    const errors: string[] = [];
    const writer = createBackupWriter({ invoke, id: 'b', onError: (e) => errors.push((e as Error).message) });
    writer.write(bytesOf(1));
    writer.write(bytesOf(2));
    await writer.done();
    writer.write(bytesOf(3));
    await writer.done();
    expect(errors).toEqual(['disk full']);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe('restoring boards the storage lost', () => {
  const board = (name: string) => ({ json: { meta: { name } } }) as unknown as ImportedBoard;

  function deps(over: Partial<Parameters<typeof restoreMissing>[0]> = {}) {
    const stored: [string, string][] = [];
    return {
      stored,
      deps: {
        listBackups: async () => ['one', 'two', 'three'],
        readBackup: async (id: string) => new TextEncoder().encode(id),
        localIds: () => new Set<string>(),
        parse: async (id: string, bytes: Uint8Array) => {
          expect(new TextDecoder().decode(bytes)).toBe(id);
          return board(`board ${id}`);
        },
        store: async (id: string, imported: ImportedBoard) => void stored.push([id, imported.json.meta.name]),
        onError: () => expect.unreachable(),
        ...over,
      },
    };
  }

  it('restores a backup whose board is missing, under its own id', async () => {
    const { deps: d, stored } = deps({ listBackups: async () => ['one'] });
    expect(await restoreMissing(d)).toEqual(['one']);
    expect(stored).toEqual([['one', 'board one']]);
  });

  it('leaves boards that are still in storage alone', async () => {
    const { deps: d, stored } = deps({ localIds: () => new Set(['one', 'three']) });
    expect(await restoreMissing(d)).toEqual(['two']);
    expect(stored).toEqual([['two', 'board two']]);
  });

  it('restores nothing when every board is there or there are no backups', async () => {
    const all = deps({ localIds: () => new Set(['one', 'two', 'three']) });
    expect(await restoreMissing(all.deps)).toEqual([]);
    const none = deps({ listBackups: async () => [] });
    expect(await restoreMissing(none.deps)).toEqual([]);
    expect(all.stored.length + none.stored.length).toBe(0);
  });

  it('skips a damaged backup, says which, and restores the rest', async () => {
    const errors: [string, string][] = [];
    const { deps: d, stored } = deps({
      parse: async (id: string) => {
        if (id === 'two') throw new Error('This file is not a Tabula board.');
        return board(`board ${id}`);
      },
      onError: (e, id) => errors.push([(e as Error).message, id]),
    });
    expect(await restoreMissing(d)).toEqual(['one', 'three']);
    expect(errors).toEqual([['This file is not a Tabula board.', 'two']]);
    expect(stored.map(([id]) => id)).toEqual(['one', 'three']);
  });

  it('a board that failed to store is not reported as restored', async () => {
    const errors: string[] = [];
    const { deps: d } = deps({
      store: async (id: string) => {
        if (id === 'one') throw new Error('quota');
      },
      onError: (_e, id) => errors.push(id),
    });
    expect(await restoreMissing(d)).toEqual(['two', 'three']);
    expect(errors).toEqual(['one']);
  });
});

describe('merging a backup into the board being opened', () => {
  const board = { json: { meta: { name: 'Retro' } } } as unknown as ImportedBoard;

  it('applies the backup that was read for this board', async () => {
    const applied: ImportedBoard[] = [];
    const ok = await mergeBackup('abc', {
      readBackup: async (id) => new TextEncoder().encode(id),
      parse: async (id, bytes) => {
        expect(new TextDecoder().decode(bytes)).toBe(id);
        return board;
      },
      apply: (imported) => void applied.push(imported),
      onError: () => expect.unreachable(),
    });
    expect(ok).toBe(true);
    expect(applied).toEqual([board]);
  });

  it('opens the board as it is when there is no backup, without reporting an error', async () => {
    const apply = vi.fn<(imported: ImportedBoard) => void>();
    const ok = await mergeBackup('abc', {
      readBackup: async () => {
        throw new Error('No such file or directory');
      },
      parse: async () => board,
      apply,
      onError: () => expect.unreachable(),
    });
    expect(ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('reports a damaged backup and applies nothing', async () => {
    const apply = vi.fn<(imported: ImportedBoard) => void>();
    const errors: [string, string][] = [];
    const ok = await mergeBackup('abc', {
      readBackup: async () => bytesOf(1),
      parse: async () => {
        throw new Error('This file is not a Tabula board.');
      },
      apply,
      onError: (e, id) => errors.push([(e as Error).message, id]),
    });
    expect(ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(errors).toEqual([['This file is not a Tabula board.', 'abc']]);
  });
});

describe('native save', () => {
  it('sends text, blobs and bytes as a raw body with a header-safe name, and returns the saved path', async () => {
    const calls: { cmd: string; body: Uint8Array; headers: Record<string, string> }[] = [];
    const invoke = (async (cmd: string, body: Uint8Array, options: { headers: Record<string, string> }) => {
      calls.push({ cmd, body, headers: options.headers });
      return '/Users/ann/Desktop/plan.svg';
    }) as unknown as Invoke;

    expect(await saveExport(invoke, '<svg/>', 'plan.svg')).toBe('/Users/ann/Desktop/plan.svg');
    await saveExport(invoke, new Blob([bytesOf(7, 8)]), 'plan.png');
    await saveExport(invoke, bytesOf(1), 'plan.drift');

    expect(calls.map((c) => c.cmd)).toEqual(['save_export', 'save_export', 'save_export']);
    expect(new TextDecoder().decode(calls[0].body)).toBe('<svg/>');
    expect([...calls[1].body]).toEqual([7, 8]);
    expect([...calls[2].body]).toEqual([1]);
    expect(calls.map((c) => c.headers['x-file-name'])).toEqual(['plan.svg', 'plan.png', 'plan.drift']);
  });

  it('is null when the person cancels the dialog, and passes a failure on', async () => {
    expect(await saveExport((async () => null) as unknown as Invoke, 'x', 'a.txt')).toBeNull();
    await expect(saveExport((async () => { throw new Error('denied'); }) as unknown as Invoke, 'x', 'a.txt')).rejects.toThrow('denied');
  });

  it('keeps file names to printable ASCII without path or reserved characters', () => {
    expect(headerSafeName('retro-board.drift')).toBe('retro-board.drift');
    expect(headerSafeName('café/plan: v2?.drift')).toBe('caf__plan_ v2_.drift');
    expect(headerSafeName('a\\b"c<d>e|f\nline')).toBe('a_b_c_d_e_f_line');
  });
});
