import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

function blockedError() {
  const error = new Error('Address is not allowed');
  error.code = 'EBLOCKED';
  return error;
}

function ipv4Value(address) {
  const octets = address.split('.');
  if (octets.length !== 4) return null;
  let value = 0n;
  for (const octet of octets) {
    if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return null;
    const part = Number(octet);
    if (part > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function publicIpv4(address) {
  if (ipv4Value(address) === null) return false;
  const octets = address.split('.').map(Number);
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Value(address) {
  let input = address.toLowerCase();
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    if (lastColon < 0) return null;
    const embedded = ipv4Value(input.slice(lastColon + 1));
    if (embedded === null) return null;
    input = input.slice(0, lastColon + 1) +
      (embedded >> 16n).toString(16) + ':' + (embedded & 0xffffn).toString(16);
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt('0x' + group), 0n);
}

/** True only for addresses outside the non-public ranges used by the AI network guard. */
export function isPublicAddress(ip) {
  if (typeof ip !== 'string' || ip.includes('%')) return false;
  const version = isIP(ip);
  if (version === 4) return publicIpv4(ip);
  if (version !== 6) return false;

  const value = ipv6Value(ip);
  if (value === null || value === 0n || value === 1n) return false;
  const upper96 = value >> 32n;
  const embeddedIpv4 = [
    Number((value >> 24n) & 255n),
    Number((value >> 16n) & 255n),
    Number((value >> 8n) & 255n),
    Number(value & 255n),
  ].join('.');

  // IPv4-mapped and the well-known NAT64 prefix carry an IPv4 destination in their low 32 bits.
  if (upper96 === 0xffffn) return publicIpv4(embeddedIpv4);
  if (upper96 === ((0x64n << 80n) | (0xff9bn << 64n))) return publicIpv4(embeddedIpv4);
  // Only global unicast, 2000::/3, can be a public address. That leaves out in one rule the unspecified and loopback
  // addresses, the IPv4-compatible ::a.b.c.d, unique local fc00::/7, link local fe80::/10, multicast and discard 100::/64.
  if (value >> 125n !== 1n) return false;
  if (value >> 96n === 0x20010db8n) return false; // documentation, 2001:db8::/32
  if (value >> 96n === 0x20010000n) return false; // Teredo, 2001::/32, which carries an IPv4 relay and client
  // 6to4, 2002::/16, carries the IPv4 address it stands for in the next 32 bits
  if (value >> 112n === 0x2002n) {
    const v4 = (value >> 80n) & 0xffffffffn;
    return publicIpv4([Number(v4 >> 24n), Number((v4 >> 16n) & 255n), Number((v4 >> 8n) & 255n), Number(v4 & 255n)].join('.'));
  }
  return true;
}

function isBlockedHostname(hostname) {
  const name = String(hostname).toLowerCase().replace(/\.+$/, '');
  return name === 'localhost' || ['.localhost', '.local', '.internal'].some((suffix) => name.endsWith(suffix));
}

/**
 * Wraps DNS lookup so the socket receives only the address list that was checked.
 * DNS is always asked for all answers, even when the caller wants only one.
 * @param {{ lookup?: Function }} [options]
 */
export function guardedLookup({ lookup = dnsLookup } = {}) {
  return (hostname, rawOptions, rawCallback) => {
    const callback = typeof rawOptions === 'function' ? rawOptions : rawCallback;
    const options = typeof rawOptions === 'function' ? {} : (typeof rawOptions === 'number' ? { family: rawOptions } : rawOptions ?? {});
    if (isBlockedHostname(hostname)) {
      callback(blockedError());
      return;
    }

    lookup(hostname, { ...options, all: true }, (error, result, family) => {
      if (error) {
        callback(error);
        return;
      }
      const addresses = Array.isArray(result) ? result : [{ address: result, family }];
      if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry?.address))) {
        callback(blockedError());
        return;
      }
      const checked = addresses.map(({ address, family: addressFamily }) => ({ address, family: addressFamily || isIP(address) }));
      if (options.all) callback(null, checked);
      else callback(null, checked[0].address, checked[0].family);
    });
  };
}

/** Blocks private IP literals because Node skips the lookup hook for them. */
export function assertPublicLiteral(hostname) {
  const value = typeof hostname === 'string' && hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (typeof value === 'string' && (isIP(value) || (value.includes(':') && value.includes('%'))) && !isPublicAddress(value)) {
    throw blockedError();
  }
}
