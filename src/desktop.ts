// The desktop app's side of the page (docs/desktop.md). `main.ts` imports this only when `isDesktop()` is true, so
// browsers never load it, and it loads `@tauri-apps/api` only here, with dynamic imports.
import { cacheImportedAssets } from './board-images';
import * as Y from 'yjs';
import type { BoardApp } from './app';
import { applyImported, importedBoardName, readBoardFile, setNativeSave, toDrift } from './exporters';
import { getUser, listBoards, onBoardDeleted, touchBoard, writeLocalBoard, type BoardConn } from './sync';
import { authState } from './auth';
import { newId } from './store';
import { toast } from './ui/common';
import { importBoardFile, type HomeNav } from './ui/home';
import {
  createBackupWriter,
  createDebouncer,
  createOpenedFiles,
  fileNameOf,
  mergeBackup,
  restoreMissing,
  saveExport,
  worthBackingUp,
  type Invoke,
} from './desktop-logic';

/** Backups follow edits after this much quiet, and at the latest this long after the first unsaved edit. */
const BACKUP_WAIT_MS = 3000;
const BACKUP_MAX_WAIT_MS = 30000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Desktop {
  /** Adds anything the board's backup has and the opened board lacks, before the board is shown. */
  mergeBackup: (conn: BoardConn) => Promise<void>;
  /** Keeps a backup copy of the open board in the app's data folder until the board is closed. */
  watchBoard: (app: BoardApp) => void;
}

/**
 * Starts everything the desktop shell needs and resolves once the boards lost from storage are restored and the files
 * the system asked us to open are imported, so the first screen already shows them. The caller handles a rejection by
 * carrying on as a plain web page.
 */
export async function startDesktop(nav: HomeNav): Promise<Desktop> {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  const call: Invoke = invoke;
  const readBackup = async (id: string) => new Uint8Array(await call<ArrayBuffer>('read_backup', { id }));
  const parseBackup = (id: string, bytes: Uint8Array) => readBoardFile(new File([bytes as BlobPart], `${id}.drift`));

  // Asks the webview not to evict this origin's storage. Whether WKWebView honours it is recorded in docs/desktop.md.
  void navigator.storage?.persist?.().catch(() => undefined);

  setNativeSave((data, name) => {
    saveExport(call, data, name).then(
      (path) => path && toast(`Saved ${fileNameOf(path)}`),
      (e) => toast(`Could not save ${name}: ${messageOf(e)}`),
    );
  });

  // A deleted board must not come back from its backup at the next start.
  onBoardDeleted((id) => call('delete_backup', { id }));

  try {
    const restored = await restoreMissing({
      listBackups: () => call<string[]>('list_backups'),
      readBackup,
      localIds: () => new Set(listBoards().map((b) => b.id)),
      parse: parseBackup,
      store: async (id, imported) => {
        // The board's own copy: its comments keep their authors rather than being marked imported.
        await writeLocalBoard(id, (target) => applyImported(target, imported, null));
        await cacheImportedAssets(imported.assets);
        const savedAt = Date.parse(imported.json.exportedAt);
        touchBoard(id, { name: importedBoardName(imported, id), ...(Number.isFinite(savedAt) ? { createdAt: savedAt, updatedAt: savedAt } : {}) });
      },
      onError: (e, id) => console.warn(`could not restore board ${id} from its backup`, e),
    });
    if (restored.length) toast(restored.length === 1 ? 'Restored 1 board from its backup copy' : `Restored ${restored.length} boards from their backup copies`);
  } catch (e) {
    console.warn('could not look for backups', e);
  }

  const opened = createOpenedFiles({
    invoke: call,
    importFile: async (file, last) => {
      if (last) return importBoardFile(file, nav);
      const imported = await readBoardFile(file);
      const id = newId();
      const auth = authState();
      const importer = auth.mode === 'signed-in' ? auth.me.user.id : getUser().id;
      await writeLocalBoard(id, (target) => applyImported(target, imported, importer));
      await cacheImportedAssets(imported.assets);
      touchBoard(id, { name: importedBoardName(imported, file.name) });
    },
    onError: (e, path) => toast(path ? `Could not open ${fileNameOf(path)}: ${messageOf(e)}` : `Could not open the file: ${messageOf(e)}`),
  });
  // Listen first, then collect: a file that arrives in between is then seen by one of the two.
  await listen('opened-file', () => void opened.check());
  await opened.check();

  let backupFailed = false;
  return {
    async mergeBackup(conn) {
      await mergeBackup(conn.id, {
        readBackup,
        parse: parseBackup,
        apply: ({ update, comments, assets }) => {
          if (update) Y.applyUpdate(conn.doc, update);
          if (comments) Y.applyUpdate(conn.comments.doc, comments);
          void cacheImportedAssets(assets);
        },
        onError: (e, id) => console.warn(`could not merge the backup of board ${id}`, e),
      });
    },
    watchBoard(app) {
      const writer = createBackupWriter({
        invoke: call,
        id: app.conn.id,
        onError: (e) => {
          console.warn('board backup failed', e);
          if (!backupFailed) toast('Could not write the backup copy of this board.');
          backupFailed = true;
        },
      });
      const backup = () => {
        if (worthBackingUp(app.store.cache.size, listBoards().some((b) => b.id === app.conn.id))) void toDrift(app).then((bytes) => writer.write(bytes), (e) => console.warn('board backup failed', e));
      };
      const pending = createDebouncer(backup, BACKUP_WAIT_MS, BACKUP_MAX_WAIT_MS);
      const poke = () => pending.poke();
      const flushWhenHidden = () => {
        if (document.visibilityState === 'hidden') pending.flush();
      };
      const flush = () => pending.flush();
      app.conn.doc.on('update', poke);
      app.conn.comments.doc.on('update', poke);
      document.addEventListener('visibilitychange', flushWhenHidden);
      window.addEventListener('pagehide', flush);
      // A board that was imported or edited before it opened here has no backup yet.
      poke();
      app.onDestroy(() => {
        app.conn.doc.off('update', poke);
        app.conn.comments.doc.off('update', poke);
        document.removeEventListener('visibilitychange', flushWhenHidden);
        window.removeEventListener('pagehide', flush);
        pending.flush();
      });
    },
  };
}
