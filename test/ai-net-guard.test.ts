import { describe, expect, it } from 'vitest';
import { assertPublicLiteral, guardedLookup, isPublicAddress } from '../server/ai/net-guard.mjs';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '169.254.1.2',
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.1',
    '192.0.2.25',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.20',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fdff:ffff::1',
    'fe80::1',
    'febf:ffff::1',
    'ff02::1',
    '::ffff:192.168.1.2',
    '64:ff9b::10.0.0.5',
    '2001:db8::1',
  ])('rejects non-public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::8.8.8.8',
  ])('accepts public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    ['an IPv4-compatible loopback', '::7f00:1'],
    ['an IPv4-compatible loopback in dotted form', '::127.0.0.1'],
    ['an IPv4-compatible public address, which is deprecated', '::8.8.8.8'],
    ['discard-only space', '100::1'],
    ['local-use NAT64', '64:ff9b:1::1'],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['6to4 for a loopback address', '2002:7f00:1::1'],
    ['6to4 for a private address', '2002:0a00:0001::1'],
    ['6to4 for the metadata address', '2002:a9fe:a9fe::1'],
    ['an address below 2000::/3', '1000::1'],
    ['ORCHIDv2, reserved by the IETF', '2001:20::1'],
    ['deprecated ORCHID', '2001:10::1'],
    ['benchmarking space', '2001:2::1'],
    ['the IETF space, its last address', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['3fff documentation space', '3fff:0:0:1::1'],
    ['a NAT64 address for a private target', '64:ff9b::10.0.0.1'],
    ['an IPv4-mapped metadata address', '::ffff:a9fe:a9fe'],
  ])('refuses %s (%s)', (_name, ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it('accepts 6to4 for a public address, and the unicast ranges of well-known providers', () => {
    expect(isPublicAddress('2002:0808:0808::1')).toBe(true);
    expect(isPublicAddress('2a00:1450:4001:81b::200e')).toBe(true);
    // the first real allocation after the IETF's own space
    expect(isPublicAddress('2001:200::1')).toBe(true);
    expect(isPublicAddress('2001:4860:4860::8844')).toBe(true);
  });

  it.each(['not an IP', '256.1.1.1', 'fe80::1%en0', '', '::ffff:999.1.1.1'])('rejects invalid IP text %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('guardedLookup', () => {
  it('checks every DNS answer even when the caller asks for one address', async () => {
    let calls = 0;
    let suppliedAll = false;
    const lookup = (hostname: string, options: any, callback: (error: Error | null, addresses?: any[]) => void) => {
      calls += 1;
      suppliedAll = options.all;
      callback(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    };
    const guarded = guardedLookup({ lookup });
    const result = await new Promise<any>((resolve) => guarded('llm.example', { all: false }, (error: Error | null, address: string, family: number) => {
      resolve({ error, address, family });
    }));

    expect(calls).toBe(1);
    expect(suppliedAll).toBe(true);
    expect(result.error.code).toBe('EBLOCKED');
    expect(result.address).toBeUndefined();
  });

  it('returns only the checked addresses and pins the selected answer', async () => {
    let calls = 0;
    const lookup = (_hostname: string, options: any, callback: (error: Error | null, addresses?: any[]) => void) => {
      calls += 1;
      expect(options.all).toBe(true);
      callback(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ]);
    };
    const guarded = guardedLookup({ lookup });
    const single = await new Promise<any>((resolve) => guarded('llm.example', { all: false }, (error: Error | null, address: string, family: number) => {
      resolve({ error, address, family });
    }));
    const all = await new Promise<any>((resolve) => guarded('llm.example', { all: true }, (error: Error | null, addresses: any[]) => {
      resolve({ error, addresses });
    }));

    expect(single).toEqual({ error: null, address: '8.8.8.8', family: 4 });
    expect(all.addresses).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    expect(calls).toBe(2);
  });

  it.each(['localhost', 'box.localhost', 'box.local', 'box.internal', 'BOX.LOCAL.', 'localhost.'])(
    'blocks local hostname %s before DNS',
    async (hostname) => {
      let calls = 0;
      const guarded = guardedLookup({
        lookup: (_name: string, _options: any, callback: (error: Error | null) => void) => {
          calls += 1;
          callback(null);
        },
      });
      const result = await new Promise<any>((resolve) => guarded(hostname, {}, (error: Error | null) => resolve(error)));
      expect(result.code).toBe('EBLOCKED');
      expect(calls).toBe(0);
    },
  );
});

describe('assertPublicLiteral', () => {
  it.each(['127.0.0.1', '[::1]', '169.254.169.254', '[::ffff:10.0.0.1]'])('blocks %s', (hostname) => {
    expect(() => assertPublicLiteral(hostname)).toThrow(expect.objectContaining({ code: 'EBLOCKED' }));
  });

  it.each(['8.8.8.8', '[2001:4860:4860::8888]', 'llm.example'])('allows %s', (hostname) => {
    expect(() => assertPublicLiteral(hostname)).not.toThrow();
  });
});
