import { afterEach, describe, expect, it, vi } from 'vitest';
import * as images from '../src/ui/dev-board-images';
import { devBoardImage, previewSrc } from '../src/ui/dev-board-images';

// The picture of a board card in the development build (src/ui/dev-board-images.ts): the picture the board has stored, at its last edit, and
// nothing else. No template sketch, no seeded picture: a board with no stored picture gets no image, so its card shows the quiet tile.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('previewSrc (pure)', () => {
  it('is the board\'s picture at its version: an edit is a new address', () => {
    expect(previewSrc('q4-roadmap', 1700000000123.7)).toBe('/api/boards/q4-roadmap/preview?v=1700000000123');
    expect(previewSrc('q4-roadmap', 5)).not.toBe(previewSrc('q4-roadmap', 6));
  });

  it('encodes the board id, and a version that is not a number is zero', () => {
    expect(previewSrc('a b/c', 1)).toBe('/api/boards/a%20b%2Fc/preview?v=1');
    expect(previewSrc('x', Number.NaN)).toBe('/api/boards/x/preview?v=0');
  });
});

describe('devBoardImage in the development build', () => {
  it('gives the stored picture of the board, and nothing to fall back on', () => {
    vi.stubEnv('DEV', true);
    expect(devBoardImage('maja-weekly-plan', 42)).toEqual({ kind: 'url', src: '/api/boards/maja-weekly-plan/preview?v=42' });
  });
});

describe('no template picture', () => {
  it('the module offers only the stored picture: there is no manifest, no template sketch and no lookup', () => {
    expect(Object.keys(images).sort()).toEqual(['devBoardImage', 'previewSrc']);
  });
});

describe('the production build', () => {
  it('gives the card no picture at all', () => {
    vi.stubEnv('DEV', false);
    expect(devBoardImage('maja-weekly-plan', 42)).toBeUndefined();
  });
});
