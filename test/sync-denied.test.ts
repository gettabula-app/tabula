import { describe, expect, it, vi } from 'vitest';
import { deniedReason, denyOnce, retryableReason, retryDelayMs, handshakeBackoffMs, HANDSHAKE_BACKOFF_MAX_MS, RETRY_BASE_MS, RETRY_MAX_MS, type DeniedReason } from '../src/sync';

describe('deniedReason', () => {
  it.each([
    [4401, 'unauthenticated'],
    [4403, 'no_access'],
    [4404, 'not_found'],
    [4410, 'access_removed'],
    [4503, 'restoring'],
    [1009, 'too_large'],
    [4413, 'too_large'],
    [4429, 'rate_limited'],
    [4430, 'too_many_connections'],
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

describe('the relay sync limits on the client', () => {
  it('stops both rooms on 4413, 4429 and 4430 instead of reconnecting at once', () => {
    for (const code of [1009, 4413, 4429, 4430]) {
      const conn: { denied: DeniedReason | null } = { denied: null };
      const both = [{ disconnect: vi.fn<() => void>(), shouldConnect: true }, { disconnect: vi.fn<() => void>(), shouldConnect: true }];
      const seen: DeniedReason[] = [];
      denyOnce(conn, both, code, (r) => seen.push(r));
      expect(seen).toHaveLength(1);
      for (const room of both) expect(room.shouldConnect).toBe(false);
    }
  });
  it('retries only the limits that pass, from 30 s doubling to 5 minutes', () => {
    expect(retryableReason('rate_limited')).toBe(true);
    expect(retryableReason('too_many_connections')).toBe(true);
    expect(retryableReason('too_large')).toBe(false);
    expect(retryableReason('access_removed')).toBe(false);
    expect([0, 1, 2, 3, 4, 10].map(retryDelayMs)).toEqual([RETRY_BASE_MS, 60_000, 120_000, 240_000, RETRY_MAX_MS, RETRY_MAX_MS]);
  });
});

describe('handshakeBackoffMs', () => {
  it('starts at 2 s, doubles to 60 s and spreads each wait over up to 50% more', () => {
    expect(handshakeBackoffMs(0, () => 0)).toBe(2000);
    expect(handshakeBackoffMs(0, () => 1)).toBe(3000);
    expect(handshakeBackoffMs(1, () => 0)).toBe(4000);
    expect(handshakeBackoffMs(3, () => 0)).toBe(16000);
    for (const n of [5, 6, 10, 50]) {
      expect(handshakeBackoffMs(n, () => 0)).toBeLessThanOrEqual(HANDSHAKE_BACKOFF_MAX_MS);
      expect(handshakeBackoffMs(n, () => 1)).toBe(HANDSHAKE_BACKOFF_MAX_MS);
    }
    expect(new Set(Array.from({ length: 20 }, () => handshakeBackoffMs(2))).size).toBeGreaterThan(5);
  });
});
