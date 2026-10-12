import { describe, expect, it } from 'vitest';
import { CORNER_INSET, CORNER_MIN, placeEditBar, type Rect } from '../src/ui/edit-bar-layout';

// Where the Add emoji button sits while a note's text is edited: in the note's bottom-left corner area, inset from its edges,
// when the note is big enough on screen; above or below it otherwise.

const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height, right: left + width, bottom: top + height });
const edges = { left: 8, right: 1272, top: 72, bottom: 792 };
const tray = { width: 52, height: 52 };
const never = () => false;

describe('the Add emoji button on a note', () => {
  it('uses the smaller tray in the corner on a mouse, so it is nearer the corner and clear of the text', () => {
    const box = rect(400, 300, 300, 300);
    const touch = placeEditBar({ box, ...tray, edges, hits: never });
    const mouse = placeEditBar({ box, ...tray, edges, hits: never, cornerTray: { width: 40, height: 40 } });
    expect(touch.y).toBe(600 - 52 - CORNER_INSET);
    expect(mouse.y).toBe(600 - 40 - CORNER_INSET);
    expect(mouse.y).toBeGreaterThan(touch.y);
  });

  it('sits inside the bottom-left corner, inset from the left and bottom edges', () => {
    const p = placeEditBar({ box: rect(400, 300, 300, 300), ...tray, edges, hits: never });
    expect(p.side).toBe('corner');
    expect(p.x).toBe(400 + CORNER_INSET);
    expect(p.y).toBe(600 - 52 - CORNER_INSET);
  });

  it('stays inside the note at every size from the smallest that holds it', () => {
    for (const size of [CORNER_MIN, 180, 300, 600]) {
      const box = rect(500, 200, size, size);
      const p = placeEditBar({ box, ...tray, edges, hits: never });
      expect(p.side).toBe('corner');
      expect(p.x).toBeGreaterThanOrEqual(box.left);
      expect(p.x + 52).toBeLessThanOrEqual(box.right);
      expect(p.y).toBeGreaterThanOrEqual(box.top);
      expect(p.y + 52).toBeLessThanOrEqual(box.bottom);
    }
  });

  it('goes above or below a note too small on screen to hold it, on the side with more room', () => {
    const small = rect(500, 100, CORNER_MIN - 1, 200);
    const p = placeEditBar({ box: small, ...tray, edges, hits: never });
    expect(p.side).toBe('below');
    expect(p.y).toBe(300 + 8);
    expect(p.x).toBe(500 + (CORNER_MIN - 1) / 2 - 26);
    const low = placeEditBar({ box: rect(500, 600, 100, 150), ...tray, edges, hits: never });
    expect(low.side).toBe('above');
    expect(low.y).toBe(600 - 8 - 52);
  });

  it('keeps clear of the top bars when it has to go above or below', () => {
    const p = placeEditBar({ box: rect(500, 200, 100, 100), ...tray, edges, hits: (_x, top) => top < 200 });
    expect(p.side).toBe('below');
  });

  it('stays on screen: a note at the left edge or low in the window', () => {
    const left = placeEditBar({ box: rect(-100, 300, 300, 300), ...tray, edges, hits: never });
    expect(left.x).toBe(edges.left);
    const low = placeEditBar({ box: rect(400, 600, 300, 400), ...tray, edges, hits: never });
    expect(low.y + 52).toBeLessThanOrEqual(edges.bottom);
    const keyboard = placeEditBar({ box: rect(400, 300, 300, 300), ...tray, edges: { ...edges, bottom: 450 }, hits: never });
    expect(keyboard.y + 52).toBeLessThanOrEqual(450);
  });
});
