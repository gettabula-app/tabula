import { describe, expect, it } from 'vitest';
import { ELEMENT_PEEK_MIN_WIDTH, trackerPeekAllowed } from '../src/tracker/ui/peek-rule';

describe('tracker element side panel rule', () => {
  it('opens a ticket beside the list only in an element wider than 720 board units, on All and My', () => {
    const element = { element: true, fullScreen: false };
    expect(ELEMENT_PEEK_MIN_WIDTH).toBe(720);
    expect(trackerPeekAllowed({ ...element, tab: 'all', width: 900 })).toBe(true);
    expect(trackerPeekAllowed({ ...element, tab: 'my', width: 721 })).toBe(true);
    expect(trackerPeekAllowed({ ...element, tab: 'all', width: 720 })).toBe(false);
    expect(trackerPeekAllowed({ ...element, tab: 'all', width: 600 })).toBe(false);
    expect(trackerPeekAllowed({ ...element, tab: 'board', width: 900 })).toBe(false);
    expect(trackerPeekAllowed({ ...element, tab: 'inbox', width: 900 })).toBe(false);
  });

  it('keeps the full-screen rule: a side panel only from 1100 wide', () => {
    expect(trackerPeekAllowed({ element: false, fullScreen: true, tab: 'all', width: 1200 })).toBe(true);
    expect(trackerPeekAllowed({ element: false, fullScreen: true, tab: 'all', width: 1100 })).toBe(false);
    expect(trackerPeekAllowed({ element: false, fullScreen: false, tab: 'all', width: 1200 })).toBe(false);
  });
});
