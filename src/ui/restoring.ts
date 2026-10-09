import './backups.css';
import { h } from './dom';
import { mayReload, watchServer, type WatchDeps } from './backups-logic';

// The screen that takes over while a restore replaces the workspace (docs/backups.md, "In the app"). It asks
// /api/health with growing waits and reloads when the server is back and does not say it is restoring.

const RELOAD_KEY = 'driftboard:restore-reload';
const PROBE_TIMEOUT_MS = 5000;

const WAITING = 'The server is restarting. This page asks every few seconds and reloads when it is back.';
const SLOW = 'This is taking longer than expected. The restore may still be running. Check again in a minute, or reload the page.';
const READY = 'The server is back. Reloading…';
const GUARDED = 'The server is back, but this page has just reloaded once already. Reload it yourself when you are ready.';

function readReloadMark(): number | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function writeReloadMark(at: number): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(at));
  } catch {
    /* storage is unavailable: the guard then only works within this page's life */
  }
}

/** Reloads, unless the page did so a moment ago (no reload loop). Returns whether it reloaded. */
export function reloadAfterRestore(now: number = Date.now()): boolean {
  if (!mayReload(readReloadMark(), now)) return false;
  writeReloadMark(now);
  location.reload();
  return true;
}

/** One question to the server. `/api/health` is not behind the restore's 503, so the plain answer says what is going on. */
export async function probeHealth(): Promise<{ status: number | null; data: unknown }> {
  const init: RequestInit = { cache: 'no-store', credentials: 'same-origin' };
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) init.signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const res = await fetch('/api/health', init);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON: a gateway page, so the server is not answering yet */
  }
  return { status: res.status, data };
}

let shown: { el: HTMLElement; stop: () => void; restore: () => void } | null = null;

export type RestoringOverrides = Partial<Pick<WatchDeps, 'probe' | 'setTimeout' | 'clearTimeout' | 'now'>> & { reload?: () => boolean };

/** Whether the restoring screen is up. */
export const restoringShown = (): boolean => shown !== null;

/** Takes the whole window over with "Restoring…" and watches for the server to come back. Does nothing when it is already up. */
export function showRestoring(overrides: RestoringOverrides = {}): void {
  if (shown) return;
  const reload = overrides.reload ?? (() => reloadAfterRestore());
  const title = h('h1', { class: 'admin-heading', id: 'restoring-title', tabindex: -1 }, 'Restoring…');
  const status = h('p', { class: 'restoring-status', role: 'status', 'aria-live': 'polite' }, WAITING);
  const checkAgain = h('button', { class: 'btn', onclick: () => begin() }, 'Check again');
  const reloadNow = h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload the page');
  const actions = h('div', { class: 'btn-row restoring-actions' }, checkAgain, reloadNow);
  actions.hidden = true;

  const say = (text: string, withButtons: boolean) => {
    if (status.textContent !== text) status.textContent = text;
    actions.hidden = !withButtons;
  };

  const watcher = watchServer({
    probe: overrides.probe ?? probeHealth,
    setTimeout: overrides.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms)),
    clearTimeout: overrides.clearTimeout ?? ((handle) => window.clearTimeout(handle as number)),
    now: overrides.now ?? (() => Date.now()),
    onReady: () => {
      if (reload()) say(READY, false);
      else say(GUARDED, true);
    },
    onSlow: () => say(SLOW, true),
  });

  function begin() {
    say(WAITING, false);
    watcher.start();
  }

  const el = h('div', { class: 'admin restoring', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'restoring-title' },
    h('div', { class: 'restoring-inner' },
      h('p', { class: 'admin-kicker' }, 'Backups'),
      title,
      h('div', { class: 'restoring-body' },
        h('p', { class: 'restoring-text' }, 'The workspace is being restored from a backup. It is unavailable for a minute or less, and everybody signs in again afterwards.'),
        status,
        actions)));

  const app = document.getElementById('app');
  if (app) app.inert = true;
  document.body.appendChild(el);
  title.focus();
  shown = {
    el,
    stop: () => watcher.stop(),
    restore: () => {
      if (app) app.inert = false;
    },
  };
  begin();
}

/** Takes the screen down again. The app never needs this (the page reloads); tests do. */
export function hideRestoring(): void {
  if (!shown) return;
  shown.stop();
  shown.restore();
  shown.el.remove();
  shown = null;
}
