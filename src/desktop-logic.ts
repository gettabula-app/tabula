// The decisions of the desktop glue (`desktop.ts`), kept free of Tauri, the DOM and IndexedDB so they run in the
// tests with the Rust side replaced by a fake `invoke`.
import type { ImportedBoard } from './exporters';

/** The shape of `invoke` from `@tauri-apps/api/core`. A `Uint8Array` as `args` is sent as a raw body, headers alongside. */
export type Invoke = <T = unknown>(cmd: string, args?: Uint8Array | Record<string, unknown>, options?: { headers: Record<string, string> }) => Promise<T>;

// ---------------------------------------------------------------- files the system opened

export const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || 'board.drift';

export interface OpenedFilesDeps {
  invoke: Invoke;
  /** Brings one file in as a new board. `last` marks the final file of a batch: the one to open on screen. */
  importFile: (file: File, last: boolean) => Promise<void>;
  onError: (error: unknown, path: string | null) => void;
}

/**
 * Collects the `.drift` files the shell was asked to open (`take_opened_files`, then `read_opened_file` for each) and
 * imports them one at a time. Calls queue up, so the `opened-file` event firing while a batch is being imported does
 * not run two imports at once. Resolves when the queue is empty; never rejects.
 */
export function createOpenedFiles(deps: OpenedFilesDeps): { check: () => Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  const drain = async () => {
    let paths: string[];
    try {
      paths = await deps.invoke<string[]>('take_opened_files');
    } catch (e) {
      deps.onError(e, null);
      return;
    }
    for (const [i, path] of paths.entries()) {
      try {
        const bytes = new Uint8Array(await deps.invoke<ArrayBuffer>('read_opened_file', { path }));
        await deps.importFile(new File([bytes], fileNameOf(path)), i === paths.length - 1);
      } catch (e) {
        deps.onError(e, path);
      }
    }
  };
  return { check: () => (queue = queue.then(drain)) };
}

// ---------------------------------------------------------------- backups

/**
 * Runs `fn` once things have been quiet for `wait` ms, and at the latest `maxWait` ms after the first call, so steady
 * editing still produces backups. `flush` runs it now if a call is waiting; `cancel` drops the wait.
 */
export function createDebouncer(fn: () => void, wait: number, maxWait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt = 0;
  const run = () => {
    clearTimeout(timer);
    timer = undefined;
    fn();
  };
  return {
    poke() {
      const now = Date.now();
      if (timer === undefined) firstAt = now;
      else clearTimeout(timer);
      timer = setTimeout(run, Math.max(0, Math.min(wait, firstAt + maxWait - now)));
    },
    flush() {
      if (timer !== undefined) run();
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Whether a board's snapshot should be written as its backup. A board with nothing on it never is, so an empty board
 * that opened in place of lost storage cannot replace a fuller backup. A board that is no longer in the board list was
 * deleted (the delete removed its backup), so a write still waiting from before must not bring the backup back.
 */
export const worthBackingUp = (objectCount: number, listed: boolean) => objectCount > 0 && listed;

export interface BackupWriterDeps {
  invoke: Invoke;
  id: string;
  onError: (error: unknown) => void;
}

/**
 * Sends board snapshots to `backup_board`, one at a time. A snapshot that arrives while another is being written
 * replaces any snapshot already waiting, so a slow disk never builds a queue of old boards. `done()` resolves when
 * nothing is in flight.
 */
export function createBackupWriter({ invoke, id, onError }: BackupWriterDeps) {
  let running: Promise<void> | null = null;
  let waiting: Uint8Array | null = null;
  const loop = async (first: Uint8Array) => {
    let bytes: Uint8Array | null = first;
    while (bytes) {
      try {
        await invoke('backup_board', bytes, { headers: { 'x-board-id': id } });
      } catch (e) {
        onError(e);
      }
      bytes = waiting;
      waiting = null;
    }
    running = null;
  };
  return {
    write(bytes: Uint8Array) {
      if (running) waiting = bytes;
      else running = loop(bytes);
    },
    done: () => running ?? Promise.resolve(),
  };
}

export interface RestoreDeps {
  listBackups: () => Promise<string[]>;
  readBackup: (id: string) => Promise<Uint8Array>;
  /** Ids of the boards in this device's storage. */
  localIds: () => Set<string>;
  parse: (id: string, bytes: Uint8Array) => Promise<ImportedBoard>;
  /** Writes the board into this device's storage under its original id and lists it. */
  store: (id: string, imported: ImportedBoard) => Promise<void>;
  onError: (error: unknown, id: string) => void;
}

/**
 * Brings back every backed-up board that this device's storage no longer has (the webview's storage was cleared or
 * purged). Boards that are still there are left alone, and one bad backup does not stop the others. Returns the ids
 * that were restored.
 */
export async function restoreMissing(deps: RestoreDeps): Promise<string[]> {
  const known = deps.localIds();
  const restored: string[] = [];
  for (const id of await deps.listBackups()) {
    if (known.has(id)) continue;
    try {
      await deps.store(id, await deps.parse(id, await deps.readBackup(id)));
      restored.push(id);
    } catch (e) {
      deps.onError(e, id);
    }
  }
  return restored;
}

export interface MergeBackupDeps {
  /** Rejects when the board has no backup. */
  readBackup: (id: string) => Promise<Uint8Array>;
  parse: (id: string, bytes: Uint8Array) => Promise<ImportedBoard>;
  /** Merges the saved sync state into the board that is being opened. */
  apply: (imported: ImportedBoard) => void;
  onError: (error: unknown, id: string) => void;
}

/**
 * Merges a board's backup into the board being opened. The sync state is a CRDT, so this adds what the backup has and
 * the board lacks (storage that WebKit cleared while the app was running leaves a listed board with nothing in it) and
 * changes nothing else: edits made since the backup stay, and an object deleted since stays deleted. A board without a
 * backup, or whose backup is damaged, opens as it is. Resolves to whether a backup was merged.
 */
export async function mergeBackup(id: string, deps: MergeBackupDeps): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.readBackup(id);
  } catch {
    return false;
  }
  try {
    deps.apply(await deps.parse(id, bytes));
    return true;
  } catch (e) {
    deps.onError(e, id);
    return false;
  }
}

// ---------------------------------------------------------------- native save

/** A suggested file name the shell accepts as a header value: printable ASCII, no path separators or reserved characters. */
export const headerSafeName = (name: string) => name.replace(/[^\x20-\x7e]|[\\/:*?"<>|]/g, '_');

export async function toBytes(data: Blob | Uint8Array | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return data;
}

/** Asks the shell to show a Save dialog and write the bytes. Resolves to the saved path, or null if the person cancelled. */
export async function saveExport(invoke: Invoke, data: Blob | Uint8Array | string, name: string): Promise<string | null> {
  return invoke<string | null>('save_export', await toBytes(data), { headers: { 'x-file-name': headerSafeName(name) } });
}
