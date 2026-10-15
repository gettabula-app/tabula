import { describe, expect, it } from 'vitest';
import { nearestSegment, projectTarget, releaseVelocity, segmentOffset, segmentWidth } from '../src/ui/segmented-logic';

// A 300px row with three segments: 4px padding, 4px gaps, so each segment is 94.67px wide.
// Segment centres sit at 51.33, 150 and 248.67px from the left edge.
const W3 = 300;

describe('segmentWidth', () => {
  it('splits the padded row evenly between the segments and the gaps', () => {
    expect(segmentWidth(300, 3, 4, 4)).toBeCloseTo(94.667, 2);
    expect(segmentWidth(200, 2, 4, 4)).toBe(94);
  });
});

describe('nearestSegment (ltr)', () => {
  it('picks the segment under each centre', () => {
    expect(nearestSegment(40, W3, 3, 4, 4, false)).toBe(0);
    expect(nearestSegment(150, W3, 3, 4, 4, false)).toBe(1);
    expect(nearestSegment(260, W3, 3, 4, 4, false)).toBe(2);
  });

  it('switches at the middle of each gap', () => {
    expect(nearestSegment(100, W3, 3, 4, 4, false)).toBe(0);
    expect(nearestSegment(101, W3, 3, 4, 4, false)).toBe(1);
    expect(nearestSegment(199, W3, 3, 4, 4, false)).toBe(1);
    expect(nearestSegment(200, W3, 3, 4, 4, false)).toBe(2);
  });

  it('clamps pointers outside the row to the first and last segment', () => {
    expect(nearestSegment(-100, W3, 3, 4, 4, false)).toBe(0);
    expect(nearestSegment(10000, W3, 3, 4, 4, false)).toBe(2);
  });

  it('handles two segments', () => {
    expect(nearestSegment(60, 200, 2, 4, 4, false)).toBe(0);
    expect(nearestSegment(140, 200, 2, 4, 4, false)).toBe(1);
  });

  it('handles five segments', () => {
    // 400px row: 75.2px segments, centres at 41.6, 120.8, 200, 279.2 and 358.4px.
    expect(nearestSegment(0, 400, 5, 4, 4, false)).toBe(0);
    expect(nearestSegment(130, 400, 5, 4, 4, false)).toBe(1);
    expect(nearestSegment(200, 400, 5, 4, 4, false)).toBe(2);
    expect(nearestSegment(370, 400, 5, 4, 4, false)).toBe(4);
    expect(nearestSegment(399, 400, 5, 4, 4, false)).toBe(4);
  });

  it('returns 0 for a single segment, an empty row or a non-finite pointer', () => {
    expect(nearestSegment(250, W3, 1, 4, 4, false)).toBe(0);
    expect(nearestSegment(50, 0, 3, 4, 4, false)).toBe(0);
    expect(nearestSegment(Number.NaN, W3, 3, 4, 4, false)).toBe(0);
  });
});

describe('nearestSegment (rtl)', () => {
  it('mirrors the row so segment 0 sits at the right edge', () => {
    expect(nearestSegment(260, W3, 3, 4, 4, true)).toBe(0);
    expect(nearestSegment(150, W3, 3, 4, 4, true)).toBe(1);
    expect(nearestSegment(40, W3, 3, 4, 4, true)).toBe(2);
  });

  it('clamps outside the row', () => {
    expect(nearestSegment(-50, W3, 3, 4, 4, true)).toBe(2);
    expect(nearestSegment(400, W3, 3, 4, 4, true)).toBe(0);
  });
});

describe('segmentOffset', () => {
  it('moves right in ltr and left in rtl, one step per segment', () => {
    expect(segmentOffset(2, 90, 4, false)).toBe(188);
    expect(segmentOffset(2, 90, 4, true)).toBe(-188);
  });

  it('is zero for the first segment in both directions', () => {
    expect(segmentOffset(0, 90, 4, false)).toBe(0);
    expect(segmentOffset(0, 90, 4, true)).toBe(0);
  });
});

describe('releaseVelocity', () => {
  it('averages the samples inside the window before release', () => {
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 40, x: 20 }, { t: 80, x: 40 }], 80)).toBe(0.5);
  });

  it('ignores samples older than the window and samples after release', () => {
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 40, x: 40 }, { t: 80, x: 40 }, { t: 120, x: 200 }], 80)).toBe(0.5);
  });

  it('is zero when the pointer stopped before release', () => {
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 10, x: 50 }, { t: 100, x: 60 }], 100)).toBe(0);
  });

  it('is zero with fewer than two samples or no elapsed time', () => {
    expect(releaseVelocity([], 50)).toBe(0);
    expect(releaseVelocity([{ t: 50, x: 3 }], 50)).toBe(0);
    expect(releaseVelocity([{ t: 50, x: 0 }, { t: 50, x: 10 }], 50)).toBe(0);
  });

  it('is negative for a leftward fling', () => {
    expect(releaseVelocity([{ t: 0, x: 100 }, { t: 20, x: 80 }], 20)).toBe(-1);
  });
});

describe('projectTarget', () => {
  it('lands on the nearest segment to the release point when the pointer is still', () => {
    expect(projectTarget(60, 0, W3, 3, 4, 4, false)).toBe(0);
  });

  it('carries a rightward fling into the next segment', () => {
    // 60px + 0.5px/ms * 120ms = 120px, which is past the middle of the gap at 100.67px.
    expect(projectTarget(60, 0.5, W3, 3, 4, 4, false)).toBe(1);
  });

  it('carries a leftward fling back past the nearest segment to the release point', () => {
    // Released at 140px (nearest is segment 1); the fling projects to 80px, which is segment 0.
    expect(projectTarget(140, -0.5, W3, 3, 4, 4, false)).toBe(0);
  });

  it('clamps the projection to the row', () => {
    expect(projectTarget(290, 2, W3, 3, 4, 4, false)).toBe(2);
    expect(projectTarget(5, -2, W3, 3, 4, 4, false)).toBe(0);
  });

  it('mirrors the projection in rtl', () => {
    expect(projectTarget(260, 0, W3, 3, 4, 4, true)).toBe(0);
    // 260px - 1px/ms * 120ms = 140px, which is segment 1 in rtl.
    expect(projectTarget(260, -1, W3, 3, 4, 4, true)).toBe(1);
  });
});
