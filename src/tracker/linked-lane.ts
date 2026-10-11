import type { Store } from '../store';
import type { Id } from '../types';

export const LINKED_LANE_DELETE_MESSAGE = 'Unlink the kanban from the tracker before deleting this lane';

/** A mapped lane belongs to the tracker until its kanban is unlinked or the mapping is removed. */
export function isMappedTrackerLane(store: Pick<Store, 'get'>, laneId: Id): boolean {
  const lane = store.get(laneId);
  if (lane?.type !== 'lane' || !lane.parent) return false;
  const container = store.get(lane.parent);
  const map = container?.type === 'container' && container.ext?.provider === 'tabula' ? container.ext.map : null;
  return !!map && Object.hasOwn(map, laneId) && map[laneId] != null;
}
