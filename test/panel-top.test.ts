import { describe, expect, it } from 'vitest';
import { PANEL_GAP, PANEL_TOP_MIN, panelTop } from '../src/ui/panel-top';

describe('panelTop', () => {
  it('keeps the minimum when the bars are short, as on a wide screen', () => {
    expect(panelTop([60, 60], 0)).toBe(PANEL_TOP_MIN);
  });

  it('starts below the lowest bar plus the gap', () => {
    // at narrow widths the right bar drops below the left one
    expect(panelTop([60, 112], 0)).toBe(112 + PANEL_GAP);
    // and when it wraps onto a second line it is taller still
    expect(panelTop([60, 160], 0)).toBe(160 + PANEL_GAP);
  });

  it('measures from the top of the chrome and rounds up', () => {
    expect(panelTop([150.2], 30)).toBe(Math.ceil(150.2 - 30 + PANEL_GAP));
  });

  it('falls back to the minimum with no bars laid out', () => {
    expect(panelTop([], 0)).toBe(PANEL_TOP_MIN);
  });
});
