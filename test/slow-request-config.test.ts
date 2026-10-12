import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';

const slow = (value?: string) => loadConfig((value === undefined ? {} : { TABULA_SLOW_REQUEST_MS: value }) as never).slowRequestMs;

describe('TABULA_SLOW_REQUEST_MS', () => {
  it('defaults to 300 ms, accepts 0 to switch off and ignores nonsense', () => {
    expect(slow()).toBe(300);
    expect(slow('150')).toBe(150);
    expect(slow('0')).toBe(0);
    expect(slow('-5')).toBe(300);
    expect(slow('fast')).toBe(300);
    expect(slow('1.5')).toBe(300);
  });
});
