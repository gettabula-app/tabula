/**
 * Whether a key event began inside a live tracker. The path is read from the event, not from `target.closest('.trk')`: a row that
 * handles Backspace or Enter re-renders the list, so by the time the board's window listener runs the target is detached and
 * `closest` finds no tracker above it. The path is fixed when the event is dispatched, so it still names the tracker.
 */
export function keyInTracker(event: Event): boolean {
  const isTracker = (node: EventTarget | null) => node instanceof Element && node.classList.contains('trk');
  if (event.composedPath().some(isTracker)) return true;
  const target = event.target;
  return target instanceof Element && target.closest('.trk') !== null;
}
