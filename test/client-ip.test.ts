import { describe, expect, it } from 'vitest';
import { clientIpOf } from '../server/client-ip.mjs';
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
