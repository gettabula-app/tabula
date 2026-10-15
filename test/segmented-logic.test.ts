import { describe, expect, it } from 'vitest';
import { nearestCentre, projectTarget, releaseVelocity, resumeFrom } from '../src/ui/segmented-logic';

// centres of three buttons of unequal widths in a 300px row: 4px padding, 4px gaps -> boxes 4..64, 68..188, 192..296
const C = [34, 128, 244];

describe('nearestCentre', () => {
  it('picks the button whose centre is nearest, whatever the widths', () => {
    expect(nearestCentre(10, C)).toBe(0);
    expect(nearestCentre(70, C)).toBe(0);
    expect(nearestCentre(90, C)).toBe(1);
    expect(nearestCentre(190, C)).toBe(2);
  });
  it('clamps pointers outside the row to the first and last', () => {
    expect(nearestCentre(-100, C)).toBe(0);
    expect(nearestCentre(10000, C)).toBe(2);
  });
  it('returns 0 for one button, none, or a non-finite pointer', () => {
    expect(nearestCentre(50, [30])).toBe(0);
    expect(nearestCentre(50, [])).toBe(0);
    expect(nearestCentre(Number.NaN, C)).toBe(0);
  });
  it('works for a mirrored (rtl) row, where the first button is at the right', () => {
    expect(nearestCentre(260, [260, 160, 40])).toBe(0);
    expect(nearestCentre(50, [260, 160, 40])).toBe(2);
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
  it('lands on the nearest button to the release point when the pointer is still', () => {
    expect(projectTarget(40, 0, C)).toBe(0);
    expect(projectTarget(120, 0, C)).toBe(1);
  });
  it('carries a rightward fling into the next button', () => {
    expect(projectTarget(60, 0.5, C)).toBe(1);
  });
  it('carries a leftward fling back', () => {
    expect(projectTarget(140, -0.5, C)).toBe(0);
  });
  it('clamps the projection to the first and last centre', () => {
    expect(projectTarget(290, 2, C)).toBe(2);
    expect(projectTarget(5, -2, C)).toBe(0);
  });
  it('is 0 with no buttons', () => {
    expect(projectTarget(50, 1, [])).toBe(0);
  });
});

describe('resumeFrom', () => {
  // A pointer pick that moved the marker from segment 0 to segment 1 at t = 1000ms.
  const pick = { from: 0, to: 1, at: 1000, kbd: false };

  it('resumes from the old segment when a rebuilt control reads the pick in time', () => {
    expect(resumeFrom(pick, 1200, 1)).toBe(0);
  });

  it('resumes right up to the end of the window and no further', () => {
    expect(resumeFrom(pick, 1400, 1)).toBe(0);
    expect(resumeFrom(pick, 1401, 1)).toBeNull();
  });

  it('honours a custom window', () => {
    expect(resumeFrom(pick, 1050, 1, 50)).toBe(0);
    expect(resumeFrom(pick, 1051, 1, 50)).toBeNull();
  });

  it('does not resume after a keyboard pick', () => {
    expect(resumeFrom({ ...pick, kbd: true }, 1200, 1)).toBeNull();
  });

  it('does not resume when the pick did not move the marker', () => {
    expect(resumeFrom({ from: 1, to: 1, at: 1000, kbd: false }, 1200, 1)).toBeNull();
  });

  it('does not resume when the rebuilt control is not on the chosen segment', () => {
    expect(resumeFrom(pick, 1200, 2)).toBeNull();
  });

  it('does not resume without a recorded pick or with an invalid old index', () => {
    expect(resumeFrom(undefined, 1200, 1)).toBeNull();
    expect(resumeFrom({ from: -1, to: 1, at: 1000, kbd: false }, 1200, 1)).toBeNull();
  });
});
