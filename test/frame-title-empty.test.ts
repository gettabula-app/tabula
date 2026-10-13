import { describe, expect, it } from 'vitest';
import { objectMarkup } from '../src/markup';
import { UNTITLED_FRAME, layerLabel } from '../src/layers';
import { rowName } from '../src/layers-ui-logic';
import type { BaseObj, Obj } from '../src/types';

const frame = (name?: string) => ({ id: 'fr', type: 'frame', x: 0, y: 0, w: 300, h: 200, rotation: 0, z: 'a', ...(name === undefined ? {} : { name }) }) as unknown as BaseObj;
const ctx = { get: (_id: string): Obj | undefined => undefined };

describe('a frame whose title was emptied', () => {
  it('draws no label, while a frame without a stored name still reads Frame', () => {
    expect(objectMarkup(frame(''), ctx)).not.toMatch(/<text/);
    expect(objectMarkup(frame(), ctx)).toMatch(/>Frame<\/text>/);
    expect(objectMarkup(frame('Roadmap'), ctx)).toMatch(/>Roadmap<\/text>/);
  });

  it('is named Untitled frame in the list and to a screen reader, never drawn on the board', () => {
    expect(layerLabel(frame(''))).toBe(UNTITLED_FRAME);
    expect(layerLabel(frame())).toBe('Frame');
    expect(rowName({ type: 'frame', label: UNTITLED_FRAME, hidden: false, locked: false })).toBe('Untitled frame');
    expect(objectMarkup(frame(''), ctx)).not.toContain(UNTITLED_FRAME);
  });
});
