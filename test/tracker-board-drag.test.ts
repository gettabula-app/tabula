import { describe, expect, it } from 'vitest';
import {
  autoScrollDelta, AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_PX, clipRect, columnsFor, laneAtPoint, laneWidthFor, scaleOf,
} from '../src/tracker/ui/board-drag';

// The pure parts of the tracker element's board drag: where a pointer is over a lane, how far the strip scrolls at its edge, the
// element's scale on the board, and how many lanes fit at the element's width (three at 720, two at 480).

const lanes = [
  { key: 'todo', rect: { left: 12, top: 10, right: 236, bottom: 300 } },
  { key: 'in_progress', rect: { left: 248, top: 10, right: 472, bottom: 300 } },
  { key: 'done', rect: { left: 484, top: 10, right: 708, bottom: 300 } },
];

describe('laneAtPoint', () => {
  it('returns the lane the point is inside, edges included', () => {
    expect(laneAtPoint({ x: 100, y: 100 }, lanes)).toBe('todo');
    expect(laneAtPoint({ x: 248, y: 10 }, lanes)).toBe('in_progress');
    expect(laneAtPoint({ x: 708, y: 300 }, lanes)).toBe('done');
  });

  it('returns null in the gap between lanes, above, below, or with no lanes', () => {
    expect(laneAtPoint({ x: 240, y: 100 }, lanes)).toBeNull();
    expect(laneAtPoint({ x: 100, y: 5 }, lanes)).toBeNull();
    expect(laneAtPoint({ x: 100, y: 301 }, lanes)).toBeNull();
    expect(laneAtPoint({ x: 100, y: 100 }, [])).toBeNull();
  });
});

describe('clipRect', () => {
  it('clips a lane to the strip that shows it, and reports an empty overlap as inverted', () => {
    expect(clipRect({ left: -50, top: 0, right: 150, bottom: 40 }, { left: 0, top: 10, right: 300, bottom: 30 }))
      .toEqual({ left: 0, top: 10, right: 150, bottom: 30 });
    const none = clipRect({ left: 400, top: 0, right: 500, bottom: 40 }, { left: 0, top: 0, right: 300, bottom: 40 });
    expect(none.left > none.right).toBe(true);
  });
});

describe('autoScrollDelta', () => {
  const rect = { left: 100, right: 500 };

  it('scrolls nothing in the middle of the strip', () => {
    expect(autoScrollDelta(300, rect)).toBe(0);
    expect(autoScrollDelta(100 + AUTO_SCROLL_EDGE_PX, rect)).toBe(0);
    expect(autoScrollDelta(500 - AUTO_SCROLL_EDGE_PX, rect)).toBe(0);
  });

  it('scrolls left near the left edge and right near the right edge, faster the closer the pointer is', () => {
    expect(autoScrollDelta(100 + 16, rect)).toBeCloseTo(-AUTO_SCROLL_MAX_PX / 2);
    expect(autoScrollDelta(100, rect)).toBeCloseTo(-AUTO_SCROLL_MAX_PX);
    expect(autoScrollDelta(500 - 16, rect)).toBeCloseTo(AUTO_SCROLL_MAX_PX / 2);
    expect(autoScrollDelta(500, rect)).toBeCloseTo(AUTO_SCROLL_MAX_PX);
  });

  it('caps the step at the maximum when the pointer is past the edge, and uses a 32px band by default', () => {
    expect(AUTO_SCROLL_EDGE_PX).toBe(32);
    expect(autoScrollDelta(40, rect)).toBe(-AUTO_SCROLL_MAX_PX);
    expect(autoScrollDelta(600, rect)).toBe(AUTO_SCROLL_MAX_PX);
    expect(autoScrollDelta(100 + 31, rect)).toBeLessThan(0);
    expect(autoScrollDelta(100 + 33, rect)).toBe(0);
  });

  it('takes its own band width', () => {
    expect(autoScrollDelta(100 + 10, rect, 10)).toBe(0);
    expect(autoScrollDelta(100 + 5, rect, 10)).toBeLessThan(0);
  });
});

describe('scaleOf', () => {
  it('is the on-screen width over the layout width', () => {
    expect(scaleOf({ width: 432 }, 720)).toBeCloseTo(0.6);
    expect(scaleOf({ width: 720 }, 720)).toBe(1);
  });

  it('falls back to 1 when a width is unknown', () => {
    expect(scaleOf({ width: 300 }, 0)).toBe(1);
    expect(scaleOf({ width: 0 }, 720)).toBe(1);
    expect(scaleOf({ width: 300 }, Number.NaN)).toBe(1);
  });

  it('turns a screen delta into layout units', () => {
    const scale = scaleOf({ width: 432 }, 720);
    expect(60 / scale).toBeCloseTo(100);
  });
});

describe('columnsFor and laneWidthFor', () => {
  it('shows three lanes at 720 and two at 480, one below that', () => {
    expect(columnsFor(720)).toBe(3);
    expect(columnsFor(900)).toBe(3);
    expect(columnsFor(719)).toBe(2);
    expect(columnsFor(480)).toBe(2);
    expect(columnsFor(479)).toBe(1);
    expect(columnsFor(360)).toBe(1);
  });

  it('splits the strip room (less the paddings and gaps) across the columns', () => {
    expect(laneWidthFor(720)).toBe(224); // (720 - 24 - 2 * 12) / 3
    expect(laneWidthFor(480)).toBe(222); // (480 - 24 - 12) / 2
  });

  it('never makes a lane narrower than 200px', () => {
    expect(laneWidthFor(400)).toBe(376); // one column
    expect(laneWidthFor(300)).toBe(276);
    expect(Math.min(...[240, 300, 360, 420, 479, 480, 600, 719, 720].map(laneWidthFor))).toBeGreaterThanOrEqual(200);
  });

  it('keeps three lanes inside 720 and two inside 480 (no lane is cut short by its own math)', () => {
    expect(3 * laneWidthFor(720) + 2 * 12 + 24).toBeLessThanOrEqual(720);
    expect(2 * laneWidthFor(480) + 12 + 24).toBeLessThanOrEqual(480);
  });
});
