// The switch in the board menu that keeps a board's picture off its card (docs/board-previews.md). Only the board's owner and a workspace admin
// may read or change it: the server answers anyone else 403, and the row stays hidden for them. The wording lives in one block below, so the
// final text drops in there and nowhere else.
import { api } from '../api';
import { h } from './dom';
import { toast } from './common';
import { switchRow } from './controls';

/** The wording of the switch. One place: change the text here, not in the menu. */
export const PREVIEW_TOGGLE_TEXT = {
  label: 'Show a picture on the card',
  help: 'When off, the card shows a plain tile and any saved picture of this board is deleted.',
  failed: 'The picture on the card could not be changed. Try again.',
} as const;

export interface PreviewToggleDeps {
  read: (boardId: string) => Promise<{ off: boolean }>;
  write: (boardId: string, off: boolean) => Promise<{ off: boolean }>;
  notify: (message: string) => void;
}

const defaultDeps = (): PreviewToggleDeps => ({
  read: (boardId) => api.boardPreviewOff(boardId),
  write: (boardId, off) => api.setBoardPreviewOff(boardId, off),
  notify: (message) => toast(message),
});

export interface PreviewToggle {
  /** The row for the menu. Hidden until the server has answered, and for anyone it refuses. */
  el: HTMLElement;
  /** Asks the server for the current setting and shows the row when it answers. */
  load(): Promise<void>;
  /** Whether a menu search for `query` keeps this row. */
  matches(query: string): boolean;
}

/**
 * The menu row for a board. The switch is on when the picture is shown (the server keeps the opposite, `off`). A change is sent at once; a
 * refusal or a failed request puts the switch back where it was and says so in a quiet toast.
 */
export function previewToggle(boardId: string, deps: PreviewToggleDeps = defaultDeps(), opts: { readOnly?: boolean } = {}): PreviewToggle {
  const row = switchRow(PREVIEW_TOGGLE_TEXT.label, false, (on) => void change(on));
  const input = row.querySelector<HTMLInputElement>('input');
  const el = h('div', { class: 'board-preview-toggle', hidden: true }, row, h('p', { class: 'board-preview-help' }, PREVIEW_TOGGLE_TEXT.help));
  const idle = () => { if (input) input.disabled = opts.readOnly === true; };
  idle();

  async function change(on: boolean): Promise<void> {
    if (!input) return;
    input.disabled = true;
    try {
      const answer = await deps.write(boardId, !on);
      input.checked = !answer.off;
    } catch {
      input.checked = !on;
      deps.notify(PREVIEW_TOGGLE_TEXT.failed);
    } finally {
      idle();
    }
  }

  return {
    el,
    async load() {
      try {
        const answer = await deps.read(boardId);
        if (input) input.checked = !answer.off;
        el.hidden = false;
      } catch {
        el.hidden = true;
      }
    },
    matches: (query) => PREVIEW_TOGGLE_TEXT.label.toLocaleLowerCase().includes(query),
  };
}

/**
 * Whether the menu offers the switch: a signed-in person who owns the board or is a workspace owner or admin (the server's rule), and only
 * while the server has board previews on for this session.
 */
export function mayToggleBoardPreview(input: { signedIn: boolean; boardRole: string | null; workspaceRole: string | null | undefined; serverOn: boolean }): boolean {
  if (!input.signedIn || !input.serverOn) return false;
  return input.boardRole === 'owner' || input.workspaceRole === 'owner' || input.workspaceRole === 'admin';
}
