import './styles.css';
import * as Y from 'yjs';
import { BoardApp } from './app';
import { deleteBoard, getUser, openBoard } from './sync';
import { mountBoardUi } from './ui/board';
import { mountAccessBanner } from './ui/access';
import { renderHome, type HomeNav } from './ui/home';
import { renderTemplates } from './ui/templates-page';
import { renderInvite, renderSignIn, renderVerify } from './ui/signin';
import { renderAdmin } from './ui/admin';
import { loadCatalogue } from './fonts';
import { TEMPLATES, insertTemplate } from './templates';
import { answerKey } from './polls';
import type { ImportedBoard } from './exporters';
import { toast } from './ui/common';
import { commentNoticeText } from './comments';
import type { Obj } from './types';
import { applyTheme, getStoredTheme } from './themes';
import { ApiError, api, type ServerBoard } from './api';
import { authState, cacheServerBoards, cachedServerBoards, initAuth, onAuth, refreshMeSoon, startMeRefresh, type AuthState } from './auth';
import { boardAccess, createUnlockWatcher, workspaceOf } from './cloud-logic';
import { createWorkspaceBanner } from './ui/workspace';
import { needsSignIn, parseRoute, resolveRoute, returnHash } from './route';

applyTheme(getStoredTheme());

const RETURN_KEY = 'driftboard:return';

const root = document.getElementById('app')!;
let current: BoardApp | null = null;
let releaseBanner: (() => void) | null = null;
let releaseWorkspace: (() => void) | null = null;
let pending: { id: string; template?: string; imported?: ImportedBoard } | null = null;
let registering = false;
let routeSeq = 0;

function saveReturn(hash: string) {
  const target = returnHash(hash);
  if (!target) return;
  try {
    sessionStorage.setItem(RETURN_KEY, target);
  } catch {
    /* storage is unavailable: sign-in then lands on the home screen */
  }
}

function takeReturn(): string {
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* storage is unavailable */
  }
  return (saved && returnHash(saved)) || '#/';
}

/** Leaves the sign-in screens: drops the emailed token from the address bar and goes where the user was headed. */
function finishSignIn() {
  history.replaceState(null, '', location.pathname + location.search);
  location.hash = takeReturn();
}

async function refreshBoardCache() {
  try {
    cacheServerBoards(await api.boards());
  } catch {
    /* the cached list stays as it was */
  }
}

const isNewBoard = (id: string, opts: { template?: string; imported?: ImportedBoard; teamId?: string }) =>
  Boolean(opts.teamId || opts.template || opts.imported) || !cachedServerBoards().some((b) => b.id === id);

const nav: HomeNav = {
  open: async (id, opts = {}) => {
    if (registering) return;
    if (authState().mode === 'signed-in' && isNewBoard(id, opts)) {
      registering = true;
      try {
        await api.createBoard({
          id,
          title: TEMPLATES.find((t) => t.id === opts.template)?.name ?? 'Untitled board',
          teamId: opts.teamId,
        });
      } catch (err) {
        toast(err instanceof ApiError && err.status !== 0 ? err.message : 'Could not reach the server. Try again.');
        return;
      } finally {
        registering = false;
      }
      refreshBoardCache();
    }
    pending = { id, ...opts };
    location.hash = `#/b/${id}`;
  },
};

/** The user's role on a board in accounts mode; the last known list decides when the server cannot be reached. */
async function boardRole(id: string, auth: AuthState): Promise<ServerBoard['role'] | undefined> {
  if (auth.mode !== 'signed-in' && auth.mode !== 'offline') return undefined;
  let list = cachedServerBoards();
  if (auth.mode === 'signed-in') {
    try {
      list = await api.boards();
      cacheServerBoards(list);
    } catch {
      /* offline or session ended: the cached list decides, the relay will say if access is gone */
    }
  }
  return list.find((b) => b.id === id)?.role;
}

/**
 * Whether a board missing from the person's list is a deleted one. Only workspace admins can open those, and only
 * while online; the relay refuses their writes either way, so the board opens read-only instead of silently
 * dropping edits.
 */
async function isDeletedBoard(id: string, auth: AuthState, role: ServerBoard['role'] | undefined): Promise<boolean> {
  if (role !== undefined || auth.mode !== 'signed-in') return false;
  if (auth.me.user.role !== 'owner' && auth.me.user.role !== 'admin') return false;
  try {
    return (await api.adminBoard(id)).deletedAt !== null;
  } catch {
    return false;
  }
}

async function route() {
  const seq = ++routeSeq;
  releaseBanner?.();
  releaseBanner = null;
  releaseWorkspace?.();
  releaseWorkspace = null;
  current?.destroy();
  current = null;

  const auth = authState();
  const r = resolveRoute(location.hash, auth.mode);
  if (needsSignIn(r, auth.mode)) {
    saveReturn(location.hash);
    location.replace('#/signin');
    return;
  }

  if (r.name === 'admin') {
    const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
    if (!me || (me.user.role !== 'owner' && me.user.role !== 'admin')) {
      location.replace('#/');
      return;
    }
    root.className = 'admin-root';
    renderAdmin(root, r.tab, me);
    return;
  }

  if (r.name !== 'board') {
    root.className = 'home-root';
    const view = document.createElement('div');
    view.style.display = 'contents';
    root.replaceChildren(view);
    const finish = () => {
      if (seq === routeSeq) finishSignIn();
    };
    if (r.name === 'signin') renderSignIn(view);
    else if (r.name === 'verify') renderVerify(view, r.token, finish);
    else if (r.name === 'invite') renderInvite(view, r.token, auth, finish);
    else if (r.name === 'templates') renderTemplates(view, nav, auth);
    else renderHome(view, nav, auth);
    return;
  }

  const id = r.id;
  root.className = 'board-root';
  root.replaceChildren(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'Opening board…' }));
  const accounts = auth.mode === 'signed-in' || auth.mode === 'offline';
  const me = accounts ? auth.me : null;
  const user = me ? { ...getUser(), name: me.user.name } : getUser();
  const [conn, role] = await Promise.all([openBoard(id, user), boardRole(id, auth)]);
  const deleted = await isDeletedBoard(id, auth, role);
  if (seq !== routeSeq) {
    conn.destroy();
    return;
  }
  // When a locked workspace becomes writable again the board reconnects, so what was typed while the relay dropped it is sent.
  const watchUnlock = createUnlockWatcher(() => conn.resync());
  // The role and, on a hosted workspace, the workspace's read-only switch decide together; a new /api/me re-decides.
  const applyAccess = () => {
    const workspace = workspaceOf(authState());
    const access = boardAccess(role, workspace, deleted);
    conn.store.setReadOnly(access.storeReadOnly);
    conn.comments.setReadOnly(access.commentsReadOnly);
    watchUnlock(workspace);
  };
  applyAccess();
  const job = pending?.id === id ? pending : null;
  pending = null;

  if (job?.imported) {
    const { json, update, comments } = job.imported;
    if (update) Y.applyUpdate(conn.doc, update);
    else {
      conn.doc.transact(() => {
        for (const [k, v] of Object.entries(json.meta || {})) conn.store.meta.set(k, v);
        for (const o of json.objects as Obj[]) conn.store.create(o);
        for (const [k, v] of Object.entries(json.flow || {})) conn.store.flow.set(k, v);
        for (const p of json.polls ?? []) conn.store.polls.set(p.id, p);
        for (const a of json.pollAnswers ?? []) conn.store.pollAnswers.set(answerKey(a.pollId, a.userId), a);
      });
    }
    // The importer owns the new board, so the comments in the file are marked imported by the account (or device) that opens it.
    const importer = auth.mode === 'signed-in' ? auth.me.user.id : user.id;
    if (comments) conn.comments.importUpdate(comments, importer);
    else if (json.comments) conn.comments.importThreads(json.comments, importer);
  }

  root.replaceChildren();
  const app = new BoardApp(conn, user, root);
  app.role = role ?? null;
  app.deleted = deleted;
  current = app;
  // Inspection handle for automated tests and debugging (?debug in the URL).
  if (location.search.includes('debug')) (window as unknown as { __board: BoardApp }).__board = app;
  mountBoardUi(app, root, { home: () => (location.hash = '#/') });
  const banner = createWorkspaceBanner((visible) => root.classList.toggle('has-banner', visible));
  root.appendChild(banner.el);
  const unsubscribe = onAuth(applyAccess);
  // The relay says the read-only switch flipped: ask /api/me now instead of at the next five minute refresh.
  const unhint = conn.onWorkspaceHint(refreshMeSoon);
  // The relay undid one of this person's changes to the comments: say so, once per notice.
  const unnotice = conn.onCommentNotice((undone) => toast(commentNoticeText(undone)));
  releaseWorkspace = () => {
    unsubscribe();
    unhint();
    unnotice();
    banner.dispose();
  };
  if (accounts) {
    releaseBanner = mountAccessBanner(conn, root, {
      onSignIn: () => {
        saveReturn(`#/b/${id}`);
        location.hash = '#/signin';
      },
      onRemoveLocal: async () => {
        await deleteBoard(id);
        location.hash = '#/';
      },
      onHome: () => {
        location.hash = '#/';
      },
    });
  }

  if (job?.template) {
    const t = TEMPLATES.find((x) => x.id === job.template);
    if (t) {
      conn.store.setMeta({ name: t.name });
      requestAnimationFrame(() => insertTemplate(app, t));
    }
  }
  if (job?.imported) {
    requestAnimationFrame(() => app.zoomToFit());
    toast('Board opened from file');
  }
}

async function boot() {
  // Open mode (no accounts, or no server to ask) resolves at once and routes exactly as before.
  await initAuth();
  startMeRefresh();
  onAuth((s) => {
    if (needsSignIn(parseRoute(location.hash), s.mode)) location.replace('#/signin');
  });
  window.addEventListener('hashchange', route);
  route();
}

loadCatalogue();
boot();

if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
