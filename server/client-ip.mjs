// The client address every rate limit counts by (docs/accounts.md, docs/cloud.md "Client addresses", TAB-71). One rule
// for the API, MCP, the AI routes and the open-mode asset routes.
//
// Without TABULA_TRUST_PROXY=1 it is the connection's address: nothing a client sends is believed. Behind a proxy it is
// the header the proxy sets (TABULA_CLIENT_IP_HEADER):
// - `x-forwarded-for` (the default): the rightmost entry, the one the proxy in front of the relay appended; whatever a
//   client put to its left is ignored.
// - `fly-client-ip`: the address Fly's edge saw. Fly sets it itself (a client's own value does not survive the edge),
//   and it stays the visitor's address through `fly-replay`, where the rightmost X-Forwarded-For entry may not be.
// A value that is not an IP address falls back to the connection's address, so a broken proxy setup shares one limit
// instead of handing out a fresh one per request.
import net from 'node:net';

export const CLIENT_IP_HEADERS = ['x-forwarded-for', 'fly-client-ip'];

const one = (v) => (Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : '');

/** `::ffff:203.0.113.5` and `203.0.113.5` are one client. */
function normalise(ip) {
  const v = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  return mapped ? mapped[1] : v;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{ trustProxy?: boolean, clientIpHeader?: string }} config
 * @returns {string}
 */
export function clientIpOf(req, config) {
  const socket = normalise(req.socket?.remoteAddress ?? '') || 'unknown';
  if (!config.trustProxy) return socket;
  let candidate = '';
  if (config.clientIpHeader === 'fly-client-ip') {
    // one address; when a header is repeated, the last one is the edge's
    const values = one(req.headers['fly-client-ip']).split(',').map((s) => s.trim()).filter(Boolean);
    candidate = values.at(-1) ?? '';
  } else {
    const entries = one(req.headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    candidate = entries.at(-1) ?? '';
  }
  const ip = normalise(candidate);
  return net.isIP(ip) ? ip : socket;
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, an embedded IPv4 tail turned into two groups), or null. */
function ipv6Groups(address) {
  let v = address.split('%')[0].toLowerCase();
  if (!net.isIPv6(v)) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    v = v.slice(0, tail.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, rest, extra] = v.split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  const groups = [...left, ...fill, ...right];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}

/**
 * The key a rate limit counts by (rate-limit keys only; never displayed, logged or compared by the source policy). IPv4 and
 * IPv4-mapped addresses stay as they are; any other IPv6 address becomes its /64 prefix (`2001:db8:0:1::/64`, canonical,
 * lower-case, zone id dropped), because one client owns at least a /64 and could otherwise rotate through 2^64 addresses.
 * Anything that is not an IP address is returned unchanged.
 */
export function rateKeyOf(ip) {
  const v = normalise(String(ip ?? ''));
  const groups = ipv6Groups(v);
  if (!groups) return v;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** The client address as a rate-limit key (`clientIpOf`, collapsed to the /64 for IPv6). */
export function clientRateKeyOf(req, config) {
  return rateKeyOf(clientIpOf(req, config));
}

const PLATFORM_ADDRESSES = new net.BlockList();
for (const [address, prefix, family] of [
  ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['::1', 128, 'ipv6'],
]) PLATFORM_ADDRESSES.addSubnet(address, prefix, family);

/** Private, loopback and link-local addresses: the platform's own hops (Fly's proxy range, 6PN), not a visitor's. */
function isPlatformAddress(value) {
  const ip = normalise(value);
  const family = net.isIP(ip);
  return family !== 0 && PLATFORM_ADDRESSES.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{ trustProxy?: boolean, clientIpHeader?: string }} config
 * @param {{ admin?: boolean }} [options] `admin`: the variant a workspace admin may read through the public edge. It leaves out the
 *   connection's address and every X-Forwarded-For hop that is a platform address (it only counts them in `internalHops`), so
 *   Fly's internals do not go to a tenant. The internal variant (control plane and operators) keeps everything.
 */
export function clientIpReport(req, config, { admin = false } = {}) {
  const cut = (v, n) => (v === undefined ? null : one(v).slice(0, n));
  const base = {
    address: clientIpOf(req, config),
    trustProxy: Boolean(config.trustProxy),
    header: config.trustProxy ? (config.clientIpHeader ?? 'x-forwarded-for') : null,
  };
  if (!admin) {
    return {
      ...base,
      seen: {
        connection: req.socket?.remoteAddress ?? null,
        xForwardedFor: cut(req.headers['x-forwarded-for'], 300),
        flyClientIp: cut(req.headers['fly-client-ip'], 64),
      },
    };
  }
  const hops = one(req.headers['x-forwarded-for']).split(',').map((h) => h.trim()).filter(Boolean);
  const visible = hops.filter((hop) => !isPlatformAddress(hop));
  return {
    ...base,
    seen: {
      xForwardedFor: hops.length ? visible.join(', ').slice(0, 300) : null,
      flyClientIp: cut(req.headers['fly-client-ip'], 64),
      internalHops: hops.length - visible.length,
    },
  };
}
