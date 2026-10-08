/** Three result rows of about 53 px, the least list the poll card shows before it scrolls. */
export const POLL_LIST_MIN = 160;

/**
 * Where the poll card sits and how tall it may be. It docks above the session bar at its natural height,
 * or at the room above the bar when that is less. When that room is under `minimum` (the card's header and
 * the least list), it grows over the bar's top edge to `minimum`. Its top never rises above `top`, the bottom of the top bar.
 */
export function pollCardBox(b: { viewport: number; top: number; dock: number; natural: number; minimum: number }): { bottom: number; height: number } {
  const room = b.viewport - b.top - b.dock;
  const height = Math.max(0, Math.min(b.natural, Math.max(room, b.minimum), b.viewport - b.top));
  const bottom = Math.max(0, Math.min(b.dock, b.viewport - b.top - height));
  return { bottom, height };
}
