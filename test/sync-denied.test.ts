import { describe, expect, it, vi } from 'vitest';
import { deniedReason, denyOnce, type DeniedReason } from '../src/sync';

describe('deniedReason', () => {
  it.each([
    [4401, 'unauthenticated'],
    [4403, 'no_access'],
    [4404, 'not_found'],
    [4410, 'access_removed'],
    [4503, 'restoring'],
  ])('maps close code %i', (code, reason) => {
    expect(deniedReason(code)).toBe(reason);
  });

  it.each([1000, 1006, 4000, 4411, 4502, 4504, 0])('returns null for close code %i', (code) => {
    expect(deniedReason(code)).toBeNull();
  });
});

describe('denyOnce and the restoring close code', () => {
  const rooms = () => [{ disconnect: vi.fn<() => void>(), shouldConnect: true }, { disconnect: vi.fn<() => void>(), shouldConnect: true }];

  it('stops both rooms and reports restoring once, so they do not keep reconnecting', () => {
    const conn: { denied: DeniedReason | null } = { denied: null };
    const both = rooms();
    const seen: DeniedReason[] = [];
    denyOnce(conn, both, 4503, (r) => seen.push(r));
    denyOnce(conn, both, 4503, (r) => seen.push(r));
    expect(seen).toEqual(['restoring']);
    expect(conn.denied).toBe('restoring');
    for (const room of both) {
      expect(room.disconnect).toHaveBeenCalledTimes(1);
      expect(room.shouldConnect).toBe(false);
    }
  });

  it('leaves the other reasons as they were', () => {
    for (const [code, reason] of [[4401, 'unauthenticated'], [4403, 'no_access'], [4404, 'not_found'], [4410, 'access_removed']] as const) {
      const conn: { denied: DeniedReason | null } = { denied: null };
      const seen: DeniedReason[] = [];
      denyOnce(conn, rooms(), code, (r) => seen.push(r));
      expect(seen).toEqual([reason]);
    }
  });

  it('ignores an ordinary close', () => {
    const conn: { denied: DeniedReason | null } = { denied: null };
    const both = rooms();
    denyOnce(conn, both, 1006, () => {
      throw new Error('not a denial');
    });
    denyOnce(conn, both, undefined, () => {
      throw new Error('not a denial');
    });
    expect(conn.denied).toBeNull();
    expect(both[0].disconnect).not.toHaveBeenCalled();
  });
});
