import { describe, expect, it } from 'vitest';
import { CORNER_BUTTON_FINE, CORNER_BUTTON_TOUCH, CORNER_INSET, CORNER_MIN_FINE, CORNER_MIN_TOUCH, cornerTextInset, placeEditBar, type Rect } from '../src/ui/edit-bar-layout';

// Where the Add emoji button sits while a note's text is edited: in the note's bottom-left corner, 8 px from its edges, when the
// note is big enough on screen (160 px for a mouse, 180 for a finger); above or below the text otherwise.

const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height, right: left + width, bottom: top + height });
const edges = { left: 8, right: 1272, top: 72, bottom: 792 };
const tray = { width: 52, height: 52 };
const never = () => false;

describe('the Add emoji button on a note', () => {
  it('is 8 px from the note\'s left and bottom edges, measured from the note and not from the text box inside it', () => {
    const note = rect(400, 300, 300, 300);
    const text = rect(430, 330, 240, 120); // a sticky's text box sits inside its face
    for (const fine of [true, false]) {
      const p = placeEditBar({ box: text, note, ...tray, edges, fine, hits: never });
      const size = fine ? CORNER_BUTTON_FINE : CORNER_BUTTON_TOUCH;
      expect(p.side).toBe('corner');
      expect(p.size).toBe(size);
      expect(p.x - note.left).toBe(CORNER_INSET);
      expect(note.bottom - (p.y + size)).toBe(CORNER_INSET);
    }
  });

  it('needs 160 px a side for a mouse and 180 for a finger', () => {
    const at = (size: number, fine: boolean) => placeEditBar({ box: rect(500, 200, size, size), ...tray, edges, fine, hits: never }).side;
    expect(at(CORNER_MIN_FINE - 1, true)).not.toBe('corner');
    expect(at(CORNER_MIN_FINE, true)).toBe('corner');
    expect(at(CORNER_MIN_TOUCH - 1, false)).not.toBe('corner');
    expect(at(CORNER_MIN_TOUCH, false)).toBe('corner');
    expect(at(CORNER_MIN_TOUCH - 1, true)).toBe('corner'); // between the two limits: a mouse still gets it
  });

  it('keeps the corner button inside the note at every size from the smallest that holds it', () => {
    for (const size of [CORNER_MIN_TOUCH, 200, 300, 600]) {
      const note = rect(500, 200, size, size);
      const p = placeEditBar({ box: note, ...tray, edges, fine: false, hits: never });
      expect(p.x).toBeGreaterThanOrEqual(note.left);
      expect(p.x + p.size).toBeLessThanOrEqual(note.right);
      expect(p.y).toBeGreaterThanOrEqual(note.top);
      expect(p.y + p.size).toBeLessThanOrEqual(note.bottom);
    }
  });

  it('goes above or below the text on a note too small on screen, on the side with more room', () => {
    const small = rect(500, 100, 120, 200);
    const p = placeEditBar({ box: small, ...tray, edges, fine: true, hits: never });
    expect(p.side).toBe('below');
    expect(p.y).toBe(300 + 8);
    expect(p.x).toBe(500 + 60 - 26);
    const low = placeEditBar({ box: rect(500, 600, 100, 150), ...tray, edges, fine: true, hits: never });
    expect(low.side).toBe('above');
    expect(low.y).toBe(600 - 8 - 52);
  });

  it('keeps clear of the top bars when it has to go above or below', () => {
    const p = placeEditBar({ box: rect(500, 200, 100, 100), ...tray, edges, fine: true, hits: (_x, top) => top < 200 });
    expect(p.side).toBe('below');
  });

  it('stays on screen: a note at the left edge, low in the window, or above the soft keyboard', () => {
    const left = placeEditBar({ box: rect(-100, 300, 300, 300), ...tray, edges, fine: true, hits: never });
    expect(left.x).toBe(edges.left);
    const low = placeEditBar({ box: rect(400, 600, 300, 400), ...tray, edges, fine: false, hits: never });
    expect(low.y + low.size).toBeLessThanOrEqual(edges.bottom);
    const keyboard = placeEditBar({ box: rect(400, 300, 300, 300), ...tray, edges: { ...edges, bottom: 450 }, fine: true, hits: never });
    expect(keyboard.y + keyboard.size).toBeLessThanOrEqual(450);
  });

  it('keeps the text clear of the button: 44 px for a mouse, 56 px for a finger', () => {
    expect(cornerTextInset(true)).toBe(44);
    expect(cornerTextInset(false)).toBe(56);
  });
});
