import { describe, expect, it } from 'vitest';
import { pollCardBox } from '../src/ui/poll-layout';

describe('pollCardBox', () => {
  it('docks above the bar at its natural height when it fits', () => {
    expect(pollCardBox({ viewport: 800, top: 72, dock: 100, natural: 300, minimum: 200 })).toEqual({ bottom: 100, height: 300 });
  });

  it('is capped at the room above the bar when it is taller', () => {
    expect(pollCardBox({ viewport: 800, top: 72, dock: 100, natural: 900, minimum: 200 })).toEqual({ bottom: 100, height: 628 });
  });

  it('grows over the bar edge to its minimum rather than shrinking below it', () => {
    // 500x657 phone with a tall session bar: room above the bar is 333 px, the minimum is 368 px.
    expect(pollCardBox({ viewport: 657, top: 120, dock: 204, natural: 825, minimum: 368 })).toEqual({ bottom: 169, height: 368 });
  });

  it('overlaps the bar for short content that does not fit above it', () => {
    expect(pollCardBox({ viewport: 657, top: 120, dock: 204, natural: 350, minimum: 368 })).toEqual({ bottom: 187, height: 350 });
  });

  it('never rises above the top bar', () => {
    const box = pollCardBox({ viewport: 500, top: 120, dock: 300, natural: 900, minimum: 400 });
    expect(box.height).toBe(380);
    expect(box.bottom).toBe(0);
    expect(500 - box.bottom - box.height).toBe(120);
  });

  it('keeps the card docked when the minimum is small', () => {
    expect(pollCardBox({ viewport: 657, top: 120, dock: 204, natural: 100, minimum: 100 })).toEqual({ bottom: 204, height: 100 });
  });
});
