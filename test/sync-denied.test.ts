import { describe, expect, it } from 'vitest';
import { deniedReason } from '../src/sync';

describe('deniedReason', () => {
  it.each([
    [4401, 'unauthenticated'],
    [4403, 'no_access'],
    [4404, 'not_found'],
    [4410, 'access_removed'],
  ])('maps close code %i', (code, reason) => {
    expect(deniedReason(code)).toBe(reason);
  });

  it.each([1000, 1006, 4000, 4411, 0])('returns null for close code %i', (code) => {
    expect(deniedReason(code)).toBeNull();
  });
});
