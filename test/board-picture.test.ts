import { describe, expect, it, vi } from 'vitest';
import { boardPicture, previewSrc } from '../src/ui/board-picture';

// The picture a board card asks for (src/ui/board-picture.ts): only while this session has board previews on, cache-busted by the board's
// last edit or by a picture this page stored, and never with a foreign address.

const session = vi.hoisted(() => ({ on: true }));
vi.mock('../src/auth', () => ({ boardPreviewsAvailable: () => session.on }));

describe('the address of a stored picture', () => {
  it('is the board route with the version, and the id is encoded', () => {
    expect(previewSrc('board-1', 1234.9)).toBe('/api/boards/board-1/preview?v=1234');
    expect(previewSrc('a/b c', Number.NaN)).toBe('/api/boards/a%2Fb%20c/preview?v=0');
  });
});

describe('the picture of a card', () => {
  it('is asked for only while board previews are on for this session', () => {
    session.on = false;
    expect(boardPicture('board-2', 10)).toBeUndefined();
    session.on = true;
    expect(boardPicture('board-2', 10)).toEqual({ kind: 'url', src: '/api/boards/board-2/preview?v=10' });
  });
});
