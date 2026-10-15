import { describe, expect, it } from 'vitest';
import { createWindowLimiter } from '../server/limiter.mjs';

describe('shared window limiter', () => {
  it('prunes keys idle for more than two windows on an amortized sweep', () => {
    let time = 0;
    const limiter = createWindowLimiter(10, () => time);
    for (let index = 0; index < 1001; index++) limiter.hit(`idle-${index}`);
    expect(limiter.size).toBe(1001);

    time = 120_001;
    limiter.hit('active');
    for (let index = 0; index < 998; index++) limiter.hit('active');

    expect(limiter.size).toBe(1);
    expect(limiter.hit('idle-0')).toBe(0);
  });

  it('counts a bulk of hits only when all of them fit, and counts none when they do not (TAB-369)', () => {
    let time = 0;
    const limiter = createWindowLimiter(3, () => time);
    expect(limiter.remaining('k')).toBe(3);
    expect(limiter.hitMany('k', 2)).toBe(0);
    expect(limiter.remaining('k')).toBe(1);

    // two more would not fit: the refusal says how long to wait and counts nothing
    expect(limiter.wait('k', 2)).toBeGreaterThan(0);
    expect(limiter.hitMany('k', 2)).toBeGreaterThan(0);
    expect(limiter.remaining('k')).toBe(1);

    expect(limiter.hitMany('k', 1)).toBe(0);
    expect(limiter.remaining('k')).toBe(0);
    expect(limiter.hit('k')).toBe(60);
  });

  it('frees the oldest hits of a bulk first as the window passes the injected clock', () => {
    let time = 0;
    const limiter = createWindowLimiter(3, () => time);
    expect(limiter.hitMany('k', 2)).toBe(0);
    time = 30_000;
    expect(limiter.hit('k')).toBe(0);
    expect(limiter.remaining('k')).toBe(0);

    // at 60s the two hits from 0s have expired and the one from 30s has not: two fit, three do not
    time = 60_000;
    expect(limiter.remaining('k')).toBe(2);
    expect(limiter.wait('k', 2)).toBe(0);
    expect(limiter.wait('k', 3)).toBe(30);
    expect(limiter.hitMany('k', 3)).toBe(30);
    expect(limiter.remaining('k')).toBe(2);
    expect(limiter.hitMany('k', 2)).toBe(0);
    expect(limiter.remaining('k')).toBe(0);
  });

  it('never fits a bulk above the cap, and says to wait a whole window', () => {
    const limiter = createWindowLimiter(3, () => 0);
    expect(limiter.remaining('empty')).toBe(3);
    expect(limiter.wait('empty', 4)).toBe(60);
    expect(limiter.hitMany('empty', 4)).toBe(60);
    expect(limiter.remaining('empty')).toBe(3);
  });
});
