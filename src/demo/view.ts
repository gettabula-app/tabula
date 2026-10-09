export interface ViewportSize {
  w: number;
  h: number;
}

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DemoCamera {
  x: number;
  y: number;
  zoom: number;
}

const PAD = 12;
/** The least zoom the intro may use: 50% where it fits, down to 40% on a small phone so the whole intro stays above the vote bar. */
const MIN_ZOOM = 0.4;

/** Returns a camera that fits the demo intro inside the viewport, clear of its bars and toolbars. */
export function initialDemoView(viewport: ViewportSize, bounds: ViewRect, insets: ViewInsets): DemoCamera {
  const width = Math.max(1, viewport.w - insets.left - insets.right - PAD * 2);
  const height = Math.max(1, viewport.h - insets.top - insets.bottom - PAD * 2);
  const zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min(width / Math.max(1, bounds.w), height / Math.max(1, bounds.h))));
  const centerX = insets.left + PAD + width / 2;
  const centerY = insets.top + PAD + height / 2;
  return {
    zoom,
    x: bounds.x + bounds.w / 2 - centerX / zoom,
    y: bounds.y + bounds.h / 2 - centerY / zoom,
  };
}

/** Safe canvas area for the demo intro; the phone vote bar wraps to multiple rows above the zoom control. */
export function demoViewInsets(viewport: ViewportSize, flowbarTop?: number): ViewInsets {
  const base = viewport.w <= 500
    ? { top: 142, right: 12, bottom: 148, left: 72 }
    : { top: 112, right: 16, bottom: 80, left: 80 };
  return flowbarTop === undefined ? base : { ...base, bottom: Math.max(0, viewport.h - flowbarTop) };
}
