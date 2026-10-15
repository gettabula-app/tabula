import './restart-note.css';
import type { Workspace } from '../api';
import type { RestartNotice } from '../restart-notice';
import { h } from './dom';

/** While a notice shows, its countdown text is recomputed this often from the page's own clock. No server call is made. */
const TICK_MS = 30_000;

export interface RestartNoteHandle {
  /** Each /api/me answer, or null when there is no workspace answer. */
  update(workspace: Workspace | null | undefined): void;
  /** Removes the note and stops its timer. */
  dispose(): void;
}

/**
 * Where keyboard focus goes when Dismiss takes the button away: the board's tab stop, else the page's main region or heading.
 * Nothing is focused when none of them is on the page, and the browser then keeps focus where it puts it.
 */
function focusAfterDismiss(): void {
  const target = document.querySelector<HTMLElement>('.canvas-focus') ?? document.querySelector<HTMLElement>('main, [role="main"], h1');
  if (!target) return;
  // a main region or heading is not focusable as it is: tabindex -1 lets script focus it without putting it in the Tab order
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/**
 * The one global note for a planned server restart (docs/cloud.md, Restart). The element is mounted once and kept in the
 * page: it is hidden when there is nothing to say, so a screen reader's live region already exists when the text arrives.
 * Text is only ever set as text; the server's words never reach the page (src/restart-notice.ts writes the sentences).
 */
export function mountRestartNote(root: HTMLElement, notice: RestartNotice): RestartNoteHandle {
  let shownId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const text = h('span', { class: 'restart-note-text' });
  const dismiss = h('button', {
    class: 'restart-note-dismiss',
    type: 'button',
    'aria-label': 'Dismiss',
    onclick: () => {
      // a browser drops focus from a control the moment it is hidden, so it is read before the note goes away
      const hadFocus = document.activeElement === dismiss;
      if (shownId !== null) notice.dismiss(shownId);
      paint();
      // only Dismiss moves focus: a note that hides by itself never takes focus from wherever it is
      if (hadFocus && note.hidden) focusAfterDismiss();
    },
  }, '×');
  const note = h('div', { class: 'restart-note', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true }, text, dismiss);
  root.appendChild(note);

  function stopTimer() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function paint() {
    if (disposed) return;
    const view = notice.view();
    if (!view) {
      shownId = null;
      stopTimer();
      note.hidden = true;
      return;
    }
    shownId = view.id;
    // only a changed sentence is written: an unchanged one is not announced again
    if (text.textContent !== view.text) text.textContent = view.text;
    note.hidden = false;
    timer ??= setInterval(paint, TICK_MS);
  }

  return {
    update(workspace) {
      if (disposed) return;
      notice.update(workspace);
      paint();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      note.remove();
    },
  };
}
