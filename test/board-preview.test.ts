import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';
import {
  PREVIEW_MAX_SHAPES, PREVIEW_NAME_MAX, drawPreview, paletteFill, previewViewBox, quietPreview, sanitizeShapes, type PreviewShape,
} from '../src/ui/board-preview';

// TAB-375 slice 2: the schematic preview (spec 14, section 4). The model is numbers and palette keys; the drawing creates SVG
// elements only, names go in as text, and a hostile model draws nothing it should not.

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

const shape = (t: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) =>
  ({ t, x, y, w, h, ...extra }) as unknown as PreviewShape;
const asEl = (node: unknown) => node as FakeElement;

describe('previewViewBox', () => {
  it('frames the shapes with 6% padding', () => {
    const [x, y, w, h] = previewViewBox([shape('card', 0, 0, 100, 50), shape('card', 100, 50, 100, 50)]);
    expect(x).toBeCloseTo(-12);
    expect(y).toBeCloseTo(-12);
    expect(w).toBeCloseTo(224);
    expect(h).toBeCloseTo(124);
  });

  it('gives a usable box for no shapes and for a single point', () => {
    const empty = previewViewBox([]);
    expect(empty).toEqual([0, 0, 160, 100]);
    const point = previewViewBox([shape('sticky', 5, 5, 0, 0)]);
    expect(point.every((n) => Number.isFinite(n))).toBe(true);
    expect(point[2]).toBeGreaterThan(0);
    expect(point[3]).toBeGreaterThan(0);
  });

  it('frames nothing from shapes that would not be drawn', () => {
    const bad = [shape('card', Number.NaN, 0, 10, 10), shape('video', 0, 0, 10, 10)];
    expect(previewViewBox(bad)).toEqual(previewViewBox([]));
  });
});

describe('sanitizeShapes', () => {
  it('ignores unknown types and non-finite numbers', () => {
    const kept = sanitizeShapes({
      shapes: [
        shape('video', 0, 0, 10, 10),
        shape('card', Number.POSITIVE_INFINITY, 0, 10, 10),
        shape('card', 0, 0, Number.NaN, 10),
        shape('sticky', 1, 2, 3, 4, { fill: 'pink' }),
      ],
    });
    expect(kept).toEqual([{ t: 'sticky', x: 1, y: 2, w: 3, h: 4, fill: 'pink' }]);
  });

  it('clamps names to 40 characters and strips control characters', () => {
    const [long] = sanitizeShapes({ shapes: [shape('frame', 0, 0, 1, 1, { name: 'x'.repeat(100) })] });
    expect(long.name?.length).toBe(PREVIEW_NAME_MAX);
    const [odd] = sanitizeShapes({ shapes: [shape('frame', 0, 0, 1, 1, { name: 'a\u0007b' })] });
    expect(odd.name).toBe('ab');
  });

  it('caps the drawing at 60 shapes', () => {
    const many = Array.from({ length: 100 }, (_, i) => shape('card', i, 0, 1, 1));
    expect(sanitizeShapes({ shapes: many })).toHaveLength(PREVIEW_MAX_SHAPES);
  });

  it('treats anything that is not a model as empty', () => {
    expect(sanitizeShapes(null)).toEqual([]);
    expect(sanitizeShapes('shapes')).toEqual([]);
    expect(sanitizeShapes({ shapes: 'nope' })).toEqual([]);
  });
});

describe('drawPreview', () => {
  it('sets the viewBox from the bounding box, with the accessibility attributes', () => {
    const model = { shapes: [shape('frame', 0, 0, 100, 50, { name: 'Intro' })] };
    const svg = drawPreview(model, 'tint');
    expect(svg.getAttribute('viewBox')).toBe(previewViewBox(model.shapes).join(' '));
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
  });

  it('ignores unknown types and non-finite numbers', () => {
    const svg = asEl(drawPreview({ shapes: [shape('video', 0, 0, 10, 10), shape('card', Number.NaN, 0, 10, 10)] }, 'outline'));
    expect(svg.children).toHaveLength(0);
  });

  it('puts names in as text and creates no script element', () => {
    const svg = asEl(drawPreview({ shapes: [shape('frame', 0, 0, 200, 100, { name: '<script>alert(1)</script>' })] }, 'outline'));
    expect(svg.querySelectorAll('script')).toHaveLength(0);
    expect(textOf(svg)).toContain('<script>alert(1)</script>');
  });

  it('draws names only in outline and tint, and no text in dots', () => {
    const model = { shapes: [shape('frame', 0, 0, 200, 100, { name: 'Intro' })] };
    expect(asEl(drawPreview(model, 'outline')).querySelectorAll('text')).toHaveLength(1);
    expect(asEl(drawPreview(model, 'tint')).querySelectorAll('text')).toHaveLength(1);
    expect(asEl(drawPreview(model, 'dots')).querySelectorAll('text')).toHaveLength(0);
  });

  it('tints frames with the theme variables in the tint style only', () => {
    const model = { shapes: [shape('frame', 0, 0, 200, 100)] };
    const tinted = asEl(drawPreview(model, 'tint')).querySelector('rect');
    const plain = asEl(drawPreview(model, 'outline')).querySelector('rect');
    expect(tinted?.getAttribute('style')).toContain('color-mix(in srgb, var(--ink) 4%, var(--paper))');
    expect(plain?.getAttribute('style')).not.toContain('4%');
  });
});

describe('palette keys and the quiet tile', () => {
  it('maps a sticky key to its palette colour, case-insensitively, and unknown keys to grey', () => {
    expect(paletteFill('PINK')).toBe('#FFA3C4');
    expect(paletteFill('nope')).toBe('#E2E6EB');
    expect(paletteFill(undefined)).toBe('#E2E6EB');
  });

  it('shows the first letter of the title, or a plus for a blank board', () => {
    const tile = quietPreview('tasks');
    expect(tile.className).toBe('bc-quiet');
    expect(tile.textContent).toBe('T');
    expect(quietPreview('Blank', { plus: true }).textContent).toBe('+');
  });
});
