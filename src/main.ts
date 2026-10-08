import './styles.css';
import * as Y from 'yjs';
import { BoardApp } from './app';
import { getUser, openBoard } from './sync';
import { mountBoardUi } from './ui/board';
import { renderHome, type HomeNav } from './ui/home';
import { loadCatalogue } from './fonts';
import { TEMPLATES, insertTemplate } from './templates';
import type { ImportedBoard } from './exporters';
import { toast } from './ui/common';
import type { Obj } from './types';
import { applyTheme, getStoredTheme } from './themes';

applyTheme(getStoredTheme());

const root = document.getElementById('app')!;
let current: BoardApp | null = null;
let pending: { id: string; template?: string; imported?: ImportedBoard } | null = null;
let routeSeq = 0;

const nav: HomeNav = {
  open: (id, opts) => {
    pending = { id, ...opts };
    location.hash = `#/b/${id}`;
  },
};

async function route() {
  const seq = ++routeSeq;
  const m = location.hash.match(/^#\/b\/([A-Za-z0-9_-]{1,64})$/);
  current?.destroy();
  current = null;
  if (!m) {
    root.className = 'home-root';
    renderHome(root, nav);
    return;
  }
  const id = m[1];
  root.className = 'board-root';
  root.replaceChildren(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'Opening board…' }));
  const user = getUser();
  const conn = await openBoard(id, user);
  if (seq !== routeSeq) {
    conn.destroy();
    return;
  }
  const job = pending?.id === id ? pending : null;
  pending = null;

  if (job?.imported) {
    const { json, update } = job.imported;
    if (update) Y.applyUpdate(conn.doc, update);
    else {
      conn.doc.transact(() => {
        for (const [k, v] of Object.entries(json.meta || {})) conn.store.meta.set(k, v);
        for (const o of json.objects as Obj[]) conn.store.create(o);
        for (const [k, v] of Object.entries(json.flow || {})) conn.store.flow.set(k, v);
      });
    }
  }

  root.replaceChildren();
  const app = new BoardApp(conn, user, root);
  current = app;
  // Inspection handle for automated tests and debugging (?debug in the URL).
  if (location.search.includes('debug')) (window as unknown as { __board: BoardApp }).__board = app;
  mountBoardUi(app, root, { home: () => (location.hash = '#/') });

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

window.addEventListener('hashchange', route);
route();
loadCatalogue();

if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
