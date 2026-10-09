// Feature flags for work that is merged before it is finished. A flag is on with `?<name>` in the URL or localStorage
// `driftboard:flag:<name>` set to `1`; storage that cannot be read counts as off.

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Whether a flag is on: `?<name>` in the URL, or localStorage `driftboard:flag:<name>` = `1`. */
export function flagOn(name: string): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has(name)) return true;
  } catch { /* no usable location */ }
  return stored(`driftboard:flag:${name}`) === '1';
}

/**
 * Making kanbans (docs/kanban.md) is behind a flag until slices 3 to 5 are done: `?kanban` or `driftboard:flag:kanban`.
 * Without it there is no Kanban tool and no Make kanban from selection, no sticky becomes a loose card, and a paste, an
 * import into a board or a template leaves out kanbans and cards unless they are copies of ones on this board (so a
 * kanban here can still be copied and duplicated). Kanbans already on a board draw and edit as always, and a sticky can
 * still become a card in one of their lanes. Opening a whole board file into a new board keeps what the file has.
 */
export const kanbanFlag = (): boolean => flagOn('kanban');
