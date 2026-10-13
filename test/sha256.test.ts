import { describe, expect, it } from 'vitest';
import { sha256, sha256Hex } from '../src/sha256';

const subtle = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');

describe('sha256 (plain JavaScript)', () => {
  it('matches the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with crypto.subtle on empty, short, block-edge, long and multibyte input', async () => {
    const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'x'.repeat(100_000), 'héllo wörld ✓ 日本語 😀'.repeat(50), JSON.stringify({ a: [1, 2, { b: 'c' }] })];
    for (const text of inputs) expect(sha256Hex(text)).toBe(await subtle(text));
  });

  it('gives 32 bytes and does not change its input', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(sha256(data)).toHaveLength(32);
    expect([...data]).toEqual([1, 2, 3]);
  });
});
