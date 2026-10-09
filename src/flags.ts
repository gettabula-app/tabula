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
 * Without it nothing creates a kanban (the Kanban tool, Make kanban from selection) and no loose card is made; kanbans
 * already on a board draw and edit as always, and a sticky can still become a card in one of their lanes.
 */
export const kanbanFlag = (): boolean => flagOn('kanban');
