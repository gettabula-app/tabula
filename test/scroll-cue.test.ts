import { describe, expect, it } from 'vitest';
import { centredScroll, moreCue } from '../src/ui/scroll-cue';

describe('moreCue (TAB-239, TAB-245)', () => {
  it('is empty when everything fits', () => {
    expect(moreCue(0, 300, 300)).toBe('');
    expect(moreCue(0, 300, 300.5)).toBe('');
  });
  it('names the edge that has more behind it', () => {
    expect(moreCue(0, 300, 500)).toBe('right');
    expect(moreCue(200, 300, 500)).toBe('left');
    expect(moreCue(80, 300, 500)).toBe('both');
  });
});

describe('centredScroll', () => {
  it('puts the tab in the middle of the row', () => {
    expect(centredScroll(400, 100, 300, 900)).toBe(300);
  });
  it('stays inside what can be scrolled', () => {
    expect(centredScroll(10, 60, 300, 900)).toBe(0);
    expect(centredScroll(850, 100, 300, 900)).toBe(600);
    expect(centredScroll(0, 100, 300, 250)).toBe(0);
  });
});
