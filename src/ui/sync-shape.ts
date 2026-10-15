/** The shape of the sync status at the top left of a board. The shape tells the state; the words are in the tooltip and the accessible name. */
export type SyncShape = 'dot' | 'ring' | 'ringdot' | 'bar' | 'tri';

/**
 * Which shape the sync status shows. `status` is app.conn.status: 'live', 'connecting', 'denied', or anything else for local only.
 * A guest whose join link has ended is a triangle whatever the connection says.
 */
export function syncShape(input: { status: string; denied: string | null | undefined; guestEnded: boolean }): SyncShape {
  if (input.guestEnded) return 'tri';
  if (input.status === 'live') return 'dot';
  if (input.status === 'connecting') return 'ring';
  if (input.status === 'denied') return input.denied === 'restoring' ? 'ringdot' : 'tri';
  return 'bar';
}
