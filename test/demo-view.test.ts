import { describe, expect, it } from 'vitest';
import { demoViewInsets, initialDemoView, type ViewRect, type ViewportSize } from '../src/demo/view';

const PAD = 12;

function expectFits(viewport: ViewportSize, bounds: ViewRect, flowbarTop: number, minimumZoom = 0.5) {
  const insets = demoViewInsets(viewport, flowbarTop);
  const view = initialDemoView(viewport, bounds, insets);
  const left = (bounds.x - view.x) * view.zoom;
  const top = (bounds.y - view.y) * view.zoom;
  const right = left + bounds.w * view.zoom;
  const bottom = top + bounds.h * view.zoom;
  expect(view.zoom).toBeGreaterThanOrEqual(minimumZoom);
  expect(view.zoom).toBeLessThanOrEqual(1);
  expect(left).toBeGreaterThanOrEqual(insets.left + PAD - 0.01);
  expect(top).toBeGreaterThanOrEqual(insets.top + PAD - 0.01);
  expect(right).toBeLessThanOrEqual(viewport.w - insets.right - PAD + 0.01);
  expect(bottom).toBeLessThanOrEqual(viewport.h - insets.bottom - PAD + 0.01);
  return view;
}

describe('demo initial camera', () => {
  it.each([
    [{ w: 1280, h: 800 }, { x: 40, y: 25, w: 1110, h: 525 }, 698, 0.5],
    [{ w: 900, h: 560 }, { x: 40, y: 25, w: 1110, h: 525 }, 416, 0.5],
    [{ w: 390, h: 844 }, { x: 40, y: 25, w: 530, h: 650 }, 541, 0.5],
    [{ w: 360, h: 740 }, { x: 40, y: 25, w: 530, h: 650 }, 426, 0.4],
  ] as const)('fits the intro frames and flowchart at %s', (viewport, bounds, flowbarTop, minimumZoom) => {
    const view = expectFits(viewport, bounds, flowbarTop, minimumZoom);
    expect(view.zoom).toBeGreaterThanOrEqual(minimumZoom);
  });

  it('centres the intro within the area clear of the phone vote bar', () => {
    const viewport = { w: 390, h: 844 };
    const bounds = { x: 40, y: 25, w: 530, h: 650 };
    const insets = demoViewInsets(viewport, 541);
    const view = initialDemoView(viewport, bounds, insets);
    const screenCenterX = ((bounds.x + bounds.w / 2) - view.x) * view.zoom;
    const screenCenterY = ((bounds.y + bounds.h / 2) - view.y) * view.zoom;
    expect(screenCenterX).toBeCloseTo(insets.left + PAD + (viewport.w - insets.left - insets.right - PAD * 2) / 2);
    expect(screenCenterY).toBeCloseTo(insets.top + PAD + (viewport.h - insets.top - insets.bottom - PAD * 2) / 2);
  });
});

describe('a small phone', () => {
  it('keeps the intro frames and flowchart above the vote bar at 40% zoom or more', () => {
    const viewport = { w: 360, h: 740 };
    const insets = demoViewInsets(viewport, 426);
    const bounds = { x: 40, y: 25, w: 530, h: 650 };
    const view = initialDemoView(viewport, bounds, insets);
    expect(view.zoom).toBeGreaterThanOrEqual(0.4);
    const top = (bounds.y - view.y) * view.zoom;
    const bottom = (bounds.y + bounds.h - view.y) * view.zoom;
    expect(top).toBeGreaterThanOrEqual(insets.top + PAD - 0.01);
    expect(bottom).toBeLessThanOrEqual(viewport.h - insets.bottom - PAD + 0.01);
  });
});
