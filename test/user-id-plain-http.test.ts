import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUser } from '../src/sync';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const real = globalThis.crypto;

afterEach(() => vi.unstubAllGlobals());

// crypto.randomUUID exists only in secure contexts: over plain http on a local network address it is missing
function openOverPlainHttp() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a) });
  return store;
}

describe('the person id without crypto.randomUUID', () => {
  it('is a version 4 uuid', () => {
    openOverPlainHttp();
    expect(getUser().id).toMatch(V4);
  });

  it('differs from one new person to the next', () => {
    openOverPlainHttp();
    const first = getUser().id;
    openOverPlainHttp();
    expect(getUser().id).not.toBe(first);
  });

  it('is kept for the next visit', () => {
    openOverPlainHttp();
    expect(getUser().id).toBe(getUser().id);
  });
});
