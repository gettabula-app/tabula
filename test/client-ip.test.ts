import { describe, expect, it } from 'vitest';
import { clientIpOf, clientIpReport, clientRateKeyOf, rateKeyOf } from '../server/client-ip.mjs';
import { loadConfig } from '../server/config.mjs';

// TAB-71: the client address every rate limit counts by. Without TABULA_TRUST_PROXY=1 nothing a client sends is believed;
// behind a proxy it is the header TABULA_CLIENT_IP_HEADER names: the rightmost X-Forwarded-For entry (the default) or
// Fly-Client-IP. A value that is not an IP address falls back to the connection's address.

const req = (headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9') => ({ headers, socket: { remoteAddress } }) as never;
const xff = { trustProxy: true, clientIpHeader: 'x-forwarded-for' };
const fly = { trustProxy: true, clientIpHeader: 'fly-client-ip' };

describe('clientIpOf', () => {
  it('believes no header without TABULA_TRUST_PROXY', () => {
    const r = req({ 'x-forwarded-for': '1.1.1.1', 'fly-client-ip': '2.2.2.2' });
    expect(clientIpOf(r, { trustProxy: false, clientIpHeader: 'fly-client-ip' })).toBe('10.0.0.9');
    expect(clientIpOf(r, { trustProxy: false })).toBe('10.0.0.9');
  });

  it('takes the rightmost X-Forwarded-For entry by default, whatever a client put to its left', () => {
    expect(clientIpOf(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }), xff)).toBe('203.0.113.7');
    expect(clientIpOf(req({ 'x-forwarded-for': ['6.6.6.6', '203.0.113.7'] }), xff)).toBe('203.0.113.7');
    expect(clientIpOf(req({ 'x-forwarded-for': '203.0.113.7', 'fly-client-ip': '2.2.2.2' }), { trustProxy: true })).toBe('203.0.113.7');
  });

  it('takes Fly-Client-IP when told to, and ignores X-Forwarded-For then', () => {
    expect(clientIpOf(req({ 'fly-client-ip': '198.51.100.4', 'x-forwarded-for': '198.51.100.4, 172.16.5.5' }), fly)).toBe('198.51.100.4');
    expect(clientIpOf(req({ 'fly-client-ip': '2001:db8::7' }), fly)).toBe('2001:db8::7');
    expect(clientIpOf(req({ 'fly-client-ip': ['6.6.6.6', '198.51.100.4'] }), fly)).toBe('198.51.100.4');
  });

  it('falls back to the connection address when the header is missing or not an address', () => {
    for (const value of [undefined, '', ' , ,', 'unknown', '198.51.100.4:1234', '<script>', '999.1.1.1']) {
      const headers: Record<string, string> = value === undefined ? {} : { 'fly-client-ip': value, 'x-forwarded-for': value };
      expect(clientIpOf(req(headers), fly)).toBe('10.0.0.9');
      expect(clientIpOf(req(headers), xff)).toBe('10.0.0.9');
    }
    expect(clientIpOf({ headers: {}, socket: {} } as never, xff)).toBe('unknown');
  });

  it('counts an IPv4-mapped address as the IPv4 address', () => {
    expect(clientIpOf(req({}, '::ffff:203.0.113.9'), { trustProxy: false })).toBe('203.0.113.9');
    expect(clientIpOf(req({ 'fly-client-ip': '::ffff:198.51.100.4' }), fly)).toBe('198.51.100.4');
  });
});

describe('TABULA_CLIENT_IP_HEADER', () => {
  const load = (env: Record<string, string>) => {
    const warnings: string[] = [];
    const config = loadConfig({ ...env }, (w: string) => warnings.push(w));
    return { config, warnings };
  };

  it('defaults to x-forwarded-for and takes fly-client-ip in any case', () => {
    expect(load({}).config.clientIpHeader).toBe('x-forwarded-for');
    expect(load({ TABULA_TRUST_PROXY: '1', TABULA_CLIENT_IP_HEADER: 'Fly-Client-IP' }).config.clientIpHeader).toBe('fly-client-ip');
    expect(load({ TABULA_TRUST_PROXY: '1', TABULA_CLIENT_IP_HEADER: ' x-forwarded-for ' }).config.clientIpHeader).toBe('x-forwarded-for');
  });

  it('refuses to start with any other header', () => {
    expect(() => load({ TABULA_TRUST_PROXY: '1', TABULA_CLIENT_IP_HEADER: 'x-real-ip' })).toThrow(/TABULA_CLIENT_IP_HEADER must be one of x-forwarded-for, fly-client-ip/);
  });

  it('warns that it does nothing without TABULA_TRUST_PROXY=1', () => {
    const { config, warnings } = load({ TABULA_CLIENT_IP_HEADER: 'fly-client-ip' });
    expect(config.trustProxy).toBe(false);
    expect(warnings.join('\n')).toContain('TABULA_CLIENT_IP_HEADER is ignored without TABULA_TRUST_PROXY=1');
  });
});

describe('clientIpReport', () => {
  const headers = { 'x-forwarded-for': '203.0.113.7, 172.19.4.2, fdaa:0:1::5', 'fly-client-ip': '203.0.113.7' };

  it('keeps the connection and every hop in the internal variant', () => {
    const report = clientIpReport(req(headers, 'fdaa:0:1::9'), fly);
    expect(report.seen).toEqual({ connection: 'fdaa:0:1::9', xForwardedFor: '203.0.113.7, 172.19.4.2, fdaa:0:1::5', flyClientIp: '203.0.113.7' });
  });

  it('leaves the connection and platform hops out of the admin variant and counts them', () => {
    const report = clientIpReport(req(headers, 'fdaa:0:1::9'), fly, { admin: true });
    expect(report).toEqual({
      address: '203.0.113.7', trustProxy: true, header: 'fly-client-ip',
      seen: { xForwardedFor: '203.0.113.7', flyClientIp: '203.0.113.7', internalHops: 2 },
    });
    expect(JSON.stringify(report)).not.toMatch(/fdaa|172\.19|connection/);
  });

  it('reports nothing invented when there is no X-Forwarded-For', () => {
    const report = clientIpReport(req({}, '198.51.100.4'), { trustProxy: false }, { admin: true });
    expect(report).toEqual({ address: '198.51.100.4', trustProxy: false, header: null, seen: { xForwardedFor: null, flyClientIp: null, internalHops: 0 } });
  });
});

describe('rateKeyOf', () => {
  it('leaves IPv4 and IPv4-mapped addresses as they are', () => {
    expect(rateKeyOf('203.0.113.7')).toBe('203.0.113.7');
    expect(rateKeyOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateKeyOf('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });

  it('maps every address of one /64 to one key, and different /64s to different keys', () => {
    const key = rateKeyOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(rateKeyOf('2001:db8:1:2::1')).toBe(key);
    expect(rateKeyOf('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(rateKeyOf('2001:db8:1:3::1')).not.toBe(key);
    expect(rateKeyOf('2001:db9:1:2::1')).not.toBe(key);
  });

  it('is canonical: compressed, expanded, upper-case and zone-id forms agree', () => {
    const key = rateKeyOf('2001:db8::7');
    expect(key).toBe('2001:db8:0:0::/64');
    expect(rateKeyOf('2001:0DB8:0000:0000:0000:0000:0000:0007')).toBe(key);
    expect(rateKeyOf('2001:db8:0:0::1')).toBe(key);
    expect(rateKeyOf('2001:db8::7%eth0')).toBe(key);
    expect(rateKeyOf('::1')).toBe('0:0:0:0::/64');
    expect(rateKeyOf('::')).toBe('0:0:0:0::/64');
    expect(rateKeyOf('64:ff9b::198.51.100.4')).toBe('64:ff9b:0:0::/64');
  });

  it('returns anything that is not an address unchanged, and never throws', () => {
    for (const v of ['unknown', '', '<script>', '2001:db8::1::2', '1:2:3:4:5:6:7:8:9']) expect(rateKeyOf(v)).toBe(v);
    expect(rateKeyOf(undefined as never)).toBe('');
  });

  it('clientRateKeyOf collapses the same address clientIpOf reports', () => {
    const r = req({ 'fly-client-ip': '2001:db8:1:2::9' });
    expect(clientIpOf(r, fly)).toBe('2001:db8:1:2::9');
    expect(clientRateKeyOf(r, fly)).toBe('2001:db8:1:2::/64');
    expect(clientRateKeyOf(req({}, '198.51.100.4'), { trustProxy: false })).toBe('198.51.100.4');
  });
});
