import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicLinkAddress, resolveAndCheck, validateLinkUrl } from '../server/link-guard.mjs';

function expectBlocked(run: () => unknown) {
  expect(run).toThrowError(expect.objectContaining({ name: 'LinkGuardError', code: 'blocked' }));
}

async function expectBlockedAsync(run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({ code: 'blocked' });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('link preview address policy', () => {
  it.each([
    ['0.0.0.0/8', '0.12.34.56'],
    ['10.0.0.0/8', '10.1.2.3'],
    ['100.64.0.0/10', '100.100.0.1'],
    ['127.0.0.0/8', '127.0.0.1'],
    ['169.254.0.0/16', '169.254.169.254'],
    ['172.16.0.0/12', '172.31.255.255'],
    ['192.0.0.0/24', '192.0.0.9'],
    ['192.0.2.0/24', '192.0.2.1'],
    ['192.88.99.0/24', '192.88.99.2'],
    ['192.168.0.0/16', '192.168.2.1'],
    ['198.18.0.0/15', '198.19.1.1'],
    ['198.51.100.0/24', '198.51.100.2'],
    ['203.0.113.0/24', '203.0.113.9'],
    ['224.0.0.0/4', '239.255.0.1'],
    ['240.0.0.0/4', '240.0.0.1'],
    ['255.255.255.255', '255.255.255.255'],
  ])('refuses IPv4 %s', (_range, address) => {
    expect(isPublicLinkAddress(address)).toBe(false);
  });

  it.each([
    ['::', '::'],
    ['::1', '::1'],
    ['fc00::/7', 'fc00::1'],
    ['fc00::/7 upper edge', 'fdff:ffff::1'],
    ['fe80::/10', 'fe80::1'],
    ['ff00::/8', 'ff02::1'],
    ['2001:db8::/32', '2001:db8::1'],
    ['100::/64', '100::1'],
    ['fec0::/10', 'fec3::1'],
    ['IPv4-mapped private', '::ffff:10.1.2.3'],
    ['IPv4-compatible private', '::10.1.2.3'],
    ['NAT64 private', '64:ff9b::10.1.2.3'],
    ['6to4 private', '2002:0a01:0203::1'],
    ['Teredo', '2001::1'],
  ])('refuses IPv6 %s', (_range, address) => {
    expect(isPublicLinkAddress(address)).toBe(false);
  });

  it('checks the embedded IPv4 address in each supported carrying form', () => {
    expect(isPublicLinkAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicLinkAddress('::8.8.8.8')).toBe(true);
    expect(isPublicLinkAddress('64:ff9b::8.8.8.8')).toBe(true);
    expect(isPublicLinkAddress('2002:0808:0808::1')).toBe(true);
  });

  it('allows ordinary public IPv4 and IPv6 addresses', () => {
    expect(isPublicLinkAddress('8.8.8.8')).toBe(true);
    expect(isPublicLinkAddress('1.1.1.1')).toBe(true);
    expect(isPublicLinkAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicLinkAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicLinkAddress('not-an-ip')).toBe(false);
  });

  it.each([
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0x7f000001/',
    'http://1.2.3.4294967296/',
  ])('blocks nonstandard numeric host form %s when normalized by URL', (url) => {
    expect.assertions(1);
    expectBlocked(() => validateLinkUrl(url));
  });

  it('normalizes a public decimal IPv4 form before checking it', () => {
    expect(validateLinkUrl('http://134744072/').hostname).toBe('8.8.8.8');
  });

  it('accepts bracketed public IPv6 literals and refuses scoped or private IPv6 literals', () => {
    expect(validateLinkUrl('https://[2606:4700:4700::1111]/').family).toBe(6);
    expectBlocked(() => validateLinkUrl('http://[fe80::1]/'));
    expectBlocked(() => validateLinkUrl('http://[fe80::1%25eth0]/'));
  });

  it.each([
    'http://example.com:8080/',
    'https://example.com:80/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:pass@example.com/',
    'http://@example.com/',
    `http://${'a'.repeat(254)}.test/`,
  ])('refuses invalid scheme, port, user info or host length: %s', (url) => {
    expect.assertions(1);
    expectBlocked(() => validateLinkUrl(url));
  });

  it('allows only the default HTTP and HTTPS ports', () => {
    expect(validateLinkUrl('http://example.com/').port).toBe(80);
    expect(validateLinkUrl('http://example.com:80/').port).toBe(80);
    expect(validateLinkUrl('https://example.com/').port).toBe(443);
    expect(validateLinkUrl('https://example.com:443/').port).toBe(443);
  });

  it.each(['http://localhost/', 'https://localhost./', 'http://a.localhost/', 'http://a.b.localhost/'])('blocks localhost name %s', (url) => {
    expect.assertions(1);
    expectBlocked(() => validateLinkUrl(url));
  });

  it('applies operator host and CIDR deny entries', async () => {
    expect.assertions(4);
    await expectBlockedAsync(() => resolveAndCheck('https://private-looking.example/', {
      denyList: 'private-looking.example',
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }));
    await expectBlockedAsync(() => resolveAndCheck('https://public.example/', {
      denyList: '8.8.8.0/24',
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }));
    await expectBlockedAsync(() => resolveAndCheck('https://ipv6.example/', {
      denyList: '2606:4700::/32',
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
    }));
    await expectBlockedAsync(() => resolveAndCheck('https://sub.corp.example/', {
      denyList: '*.corp.example',
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }));
  });

  it('canonicalizes IDNA deny-list names in both Unicode and punycode directions', async () => {
    expect.assertions(2);
    await expectBlockedAsync(() => resolveAndCheck('https://bücher.example/', {
      denyList: 'XN--BCHER-KVA.EXAMPLE.',
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }));
    await expectBlockedAsync(() => resolveAndCheck('https://xn--bcher-kva.example/', {
      denyList: 'BÜCHER.EXAMPLE.',
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }));
  });

  it('reads host names and CIDRs from TABULA_LINK_PREVIEW_DENY', async () => {
    expect.assertions(2);
    vi.stubEnv('TABULA_LINK_PREVIEW_DENY', 'denied.example,8.8.8.0/24');
    await expectBlockedAsync(() => resolveAndCheck('https://denied.example/', {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    }));
    await expectBlockedAsync(() => resolveAndCheck('https://allowed-name.example/', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }));
  });

  it('limits each DNS lookup to at most two seconds', async () => {
    vi.useFakeTimers();
    const pending = resolveAndCheck('https://slow.example/', {
      lookup: () => new Promise(() => {}),
      lookupTimeoutMs: 5000,
    });
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await settled).toMatchObject({ code: 'timeout' });
  });

  it('refuses a hostname with any private DNS answer and pins the first safe answer', async () => {
    const publicPredicate = (address: string) => address === '127.0.0.1' || isPublicLinkAddress(address);
    await expectBlockedAsync(() => resolveAndCheck('https://mixed.example/', {
      isPublicAddress: publicPredicate,
      lookup: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    }));
    await expect(resolveAndCheck('https://all-public.example/', {
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ],
    })).resolves.toMatchObject({ address: '8.8.8.8', family: 4 });
  });
});
