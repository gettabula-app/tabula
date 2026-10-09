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

/**
 * What the relay saw for one request, for GET /api/internal/client-ip (docs/cloud.md, "Client addresses"): the address
 * the limits use and where it came from, so whoever deploys can compare it with their own public address. Raw header
 * values are cut short; nothing else of the request is returned.
 */
export function clientIpReport(req, config) {
  const cut = (v, n) => (v === undefined ? null : one(v).slice(0, n));
  return {
    address: clientIpOf(req, config),
    trustProxy: Boolean(config.trustProxy),
    header: config.trustProxy ? (config.clientIpHeader ?? 'x-forwarded-for') : null,
    seen: {
      connection: req.socket?.remoteAddress ?? null,
      xForwardedFor: cut(req.headers['x-forwarded-for'], 300),
      flyClientIp: cut(req.headers['fly-client-ip'], 64),
    },
  };
}
