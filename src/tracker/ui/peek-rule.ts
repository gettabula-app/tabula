import type { TrackerView } from '../../tracker-types';

/** The element's side panel opens a ticket beside its list when the element is wider than this many board units (All and My only). */
export const ELEMENT_PEEK_MIN_WIDTH = 720;

/** Whether a ticket opens as a side panel beside the list. The full-screen route keeps its own rule (1100 and wider). */
export function trackerPeekAllowed(input: { element: boolean; fullScreen: boolean; tab: TrackerView; width: number }): boolean {
  if (input.tab !== 'all' && input.tab !== 'my') return false;
  return input.element ? input.width > ELEMENT_PEEK_MIN_WIDTH : input.fullScreen && input.width > 1100;
}
