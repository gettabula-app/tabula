// The desktop app's side of the page (docs/desktop.md). `main.ts` imports this only when `isDesktop()` is true, so
// browsers never load it, and it loads `@tauri-apps/api` only here, with dynamic imports.
import { cacheImportedAssets } from './board-images';
import * as Y from 'yjs';
import type { BoardApp } from './app';
import { applyImported, importedBoardName, OWN_BACKUP_LIMITS, readBoardBytes, readBoardFile, setNativeSave, toDrift } from './exporters';
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
  runRecovery,
  saveExport,
  showRecoveryFailure,
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
  // the app's own backup copies have their own, larger limits (OWN_BACKUP_LIMITS): they must fit every board the app supports
  const parseBackup = async (_id: string, bytes: Uint8Array) => readBoardBytes(bytes, OWN_BACKUP_LIMITS);

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

  const storeBackup = async (id: string, imported: Awaited<ReturnType<typeof parseBackup>>) => {
    // The board's own copy: its comments keep their authors rather than being marked imported.
    await writeLocalBoard(id, (target) => applyImported(target, imported, null));
    await cacheImportedAssets(imported.assets);
    const savedAt = Date.parse(imported.json.exportedAt);
    touchBoard(id, { name: importedBoardName(imported, id), ...(Number.isFinite(savedAt) ? { createdAt: savedAt, updatedAt: savedAt } : {}) });
  };
  const restoreOne = async (id: string) => storeBackup(id, await parseBackup(id, await readBackup(id)));
  const notice = {
    toast,
    retry: restoreOne,
    saveCopy: async (id: string) => { await saveExport(call, await readBackup(id), `${id}.drift`); },
    describe: messageOf,
  };
  await runRecovery({
    listBackups: () => call<string[]>('list_backups'),
    readBackup,
    localIds: () => new Set(listBoards().map((b) => b.id)),
    parse: parseBackup,
    store: storeBackup,
  }, notice, restoreOne);

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
      const apply = ({ update, comments, assets }: Awaited<ReturnType<typeof parseBackup>>) => {
        // already checked against OWN_BACKUP_LIMITS when the file was read (header, counts, sizes)
        if (update) Y.applyUpdate(conn.doc, update);
        if (comments) Y.applyUpdate(conn.comments.doc, comments);
        void cacheImportedAssets(assets);
      };
      await mergeBackup(conn.id, {
        readBackup,
        parse: parseBackup,
        apply,
        // a damaged or oversized backup is told, not only logged: the board may open without what it held
        onError: (e, id) => showRecoveryFailure({ ...notice, retry: async () => { apply(await parseBackup(id, await readBackup(id))); } }, id, e),
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
