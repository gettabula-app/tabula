import { describe, expect, it } from 'vitest';
import { createWindowLimiter } from '../server/window-limiter.mjs';

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
});
