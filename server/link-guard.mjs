// Address policy for link previews (docs/link-cards.md). Keep this independent of the AI guard: the link-card spec
// names an exact set of refused ranges, while the AI guard intentionally has a broader IPv6 policy.
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export class LinkGuardError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'LinkGuardError';
    this.code = code;
  }
}

const blocked = () => new LinkGuardError('blocked', 'Address is not allowed');
const timeout = () => new LinkGuardError('timeout', 'Address lookup timed out');

function ipv4Number(value) {
  if (/^0x[\da-f]*$/i.test(value)) return BigInt(`0x${value.slice(2) || '0'}`);
  if (value.length > 1 && value[0] === '0' && /^[0-7]+$/.test(value.slice(1))) return BigInt(`0o${value.slice(1)}`);
  if (/^\d+$/.test(value)) return BigInt(value);
  return null;
}

function ipv4Value(address) {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Value(address) {
  if (isIP(address) !== 6 || address.includes('%')) return null;
  let input = address.toLowerCase();
  if (input.includes('.')) {
    const at = input.lastIndexOf(':');
    const v4 = ipv4Value(input.slice(at + 1));
    if (at < 0 || v4 === null) return null;
    input = `${input.slice(0, at + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

const v4In = (value, start, bits) => value >> BigInt(32 - bits) === start >> BigInt(32 - bits);

function isPublicIpv4(address) {
  const value = ipv4Value(address);
  if (value === null) return false;
  return !(
    v4In(value, 0x00000000n, 8) ||
    v4In(value, 0x0a000000n, 8) ||
    v4In(value, 0x64400000n, 10) ||
    v4In(value, 0x7f000000n, 8) ||
    v4In(value, 0xa9fe0000n, 16) ||
    v4In(value, 0xac100000n, 12) ||
    v4In(value, 0xc0000000n, 24) ||
    v4In(value, 0xc0000200n, 24) ||
    v4In(value, 0xc0586300n, 24) ||
    v4In(value, 0xc0a80000n, 16) ||
    v4In(value, 0xc6120000n, 15) ||
    v4In(value, 0xc6336400n, 24) ||
    v4In(value, 0xcb007100n, 24) ||
    v4In(value, 0xe0000000n, 4) ||
    v4In(value, 0xf0000000n, 4)
  );
}

const v6HasPrefix = (value, prefix, bits) => value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits);
const embeddedV4 = (value) => [
  Number((value >> 24n) & 255n), Number((value >> 16n) & 255n), Number((value >> 8n) & 255n), Number(value & 255n),
].join('.');

/** Pure implementation of the refused IPv4/IPv6 ranges in docs/link-cards.md. */
export function isPublicLinkAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const value = ipv6Value(address);
  if (value === null || value === 0n || value === 1n) return false; // :: and ::1

  // IPv4-carrying forms are judged by the IPv4 range list, except Teredo which is refused as a whole.
  if (v6HasPrefix(value, 0x20010000000000000000000000000000n, 32)) return false; // 2001::/32 (Teredo)
  if (v6HasPrefix(value, 0x00000000000000000000ffff00000000n, 96)) return isPublicIpv4(embeddedV4(value)); // mapped
  if (v6HasPrefix(value, 0n, 96)) return isPublicIpv4(embeddedV4(value)); // compatible
  if (v6HasPrefix(value, 0x0064ff9b000000000000000000000000n, 96)) return isPublicIpv4(embeddedV4(value)); // NAT64
  if (v6HasPrefix(value, 0x20020000000000000000000000000000n, 16)) {
    return isPublicIpv4(embeddedV4((value >> 80n) & 0xffffffffn)); // 6to4
  }

  return !(
    v6HasPrefix(value, 0xfc000000000000000000000000000000n, 7) || // fc00::/7
    v6HasPrefix(value, 0xfe800000000000000000000000000000n, 10) || // fe80::/10
    v6HasPrefix(value, 0xff000000000000000000000000000000n, 8) || // ff00::/8
    v6HasPrefix(value, 0x20010db8000000000000000000000000n, 32) || // 2001:db8::/32
    v6HasPrefix(value, 0x01000000000000000000000000000000n, 64) || // 100::/64
    v6HasPrefix(value, 0xfec00000000000000000000000000000n, 10) // fec0::/10
  );
}

function hostOnly(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function looksLikeUnnormalisedNumericHost(hostname) {
  if (isIP(hostname)) return false;
  const labels = hostname.replace(/\.$/, '').split('.');
  if (labels.length < 1 || labels.length > 4) return false;
  return labels.every((part) => {
    const n = ipv4Number(part);
    return n !== null && n <= 0xffffffffn;
  });
}

function isLocalhostName(hostname) {
  const name = hostname.toLowerCase().replace(/\.+$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

function parseCidr(value) {
  const [rawAddress, rawBits, ...extra] = value.split('/');
  if (extra.length) return null;
  const address = hostOnly(rawAddress);
  const family = isIP(address);
  if (!family) return null;
  const width = family === 4 ? 32 : 128;
  const bits = rawBits === undefined ? width : Number(rawBits);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const valueInt = family === 4 ? ipv4Value(address) : ipv6Value(address);
  return valueInt === null ? null : { family, bits, value: valueInt };
}

function addressInCidr(address, cidr) {
  const family = isIP(address);
  if (family !== cidr.family) return false;
  const value = family === 4 ? ipv4Value(address) : ipv6Value(address);
  return value !== null && value >> BigInt((family === 4 ? 32 : 128) - cidr.bits) === cidr.value >> BigInt((family === 4 ? 32 : 128) - cidr.bits);
}

function canonicalDenyHostname(raw) {
  const wildcard = raw.startsWith('*.');
  const candidate = wildcard ? raw.slice(2) : raw;
  const literal = hostOnly(candidate);
  if (isIP(literal)) return `${wildcard ? '*.' : ''}${literal.toLowerCase()}`;
  try {
    // URL.hostname applies the same IDNA, case and trailing-dot normalization as input URLs.
    const url = new URL(`http://${candidate}/`);
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null;
    const hostname = hostOnly(url.hostname).toLowerCase().replace(/\.+$/, '');
    return hostname ? `${wildcard ? '*.' : ''}${hostname}` : null;
  } catch {
    return null;
  }
}

function denyEntries(raw) {
  return String(raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const cidr = parseCidr(entry);
    return { entry: cidr ? entry.toLowerCase() : canonicalDenyHostname(entry), cidr };
  }).filter(({ entry, cidr }) => entry || cidr);
}

function deniedHost(hostname, entries) {
  const name = hostOnly(hostname).toLowerCase().replace(/\.+$/, '');
  return entries.some(({ entry, cidr }) => {
    if (cidr || !entry) return false;
    const blockedName = entry;
    if (blockedName.startsWith('*.')) return name.endsWith(blockedName.slice(1)) && name !== blockedName.slice(2);
    return name === blockedName;
  });
}

function deniedAddress(address, entries) {
  return entries.some(({ cidr }) => cidr && addressInCidr(address, cidr));
}

function authorityHasUserInfo(raw) {
  const match = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw);
  return Boolean(match && match[1].includes('@'));
}

/** Parse and enforce the scheme, port, user-info, host-length and literal/numeric-host rules without DNS. */
/** @param {string} input @param {{ allowedPorts?: { http?: number[], https?: number[] }, denyList?: string }} [options] */
export function validateLinkUrl(input, { allowedPorts = { http: [80], https: [443] }, denyList = process.env.TABULA_LINK_PREVIEW_DENY } = {}) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) throw blocked();
  let url;
  try {
    url = new URL(input);
  } catch {
    throw blocked();
  }
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') throw blocked();
  if (url.username || url.password || authorityHasUserInfo(input)) throw blocked();
  const ports = allowedPorts[protocol] ?? [];
  const port = url.port ? Number(url.port) : (protocol === 'http' ? 80 : 443);
  if (!ports.includes(port)) throw blocked();

  const hostname = hostOnly(url.hostname);
  if (!hostname || hostname.length > 253 || isLocalhostName(hostname) || looksLikeUnnormalisedNumericHost(hostname)) throw blocked();
  const entries = denyEntries(denyList);
  if (deniedHost(hostname, entries)) throw blocked();

  const family = isIP(hostname);
  if (family && (!isPublicLinkAddress(hostname) || deniedAddress(hostname, entries))) throw blocked();
  return { url, hostname, family, port, deniedCidrs: entries.filter(({ cidr }) => cidr).map(({ cidr }) => cidr) };
}

function waitForLookup(promise, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(timeout());
      return;
    }
    let timer;
    const finish = (fn, value) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, timeout());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(reject, timeout()), timeoutMs);
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

/** Resolve once with all answers, refuse if any answer is unsafe, and return the first checked address to pin. */
/** @param {string} input @param {{ lookup?: (hostname: string, options: { all: true, verbatim: true }) => Promise<Array<{ address: string, family: number }>>, isPublicAddress?: (address: string) => boolean, denyList?: string, allowedPorts?: { http?: number[], https?: number[] }, lookupTimeoutMs?: number, signal?: AbortSignal }} [options] */
export async function resolveAndCheck(input, {
  lookup = dnsLookup,
  isPublicAddress = isPublicLinkAddress,
  denyList = process.env.TABULA_LINK_PREVIEW_DENY,
  allowedPorts = { http: [80], https: [443] },
  lookupTimeoutMs = 2000,
  signal,
} = {}) {
  const checked = validateLinkUrl(input, { allowedPorts, denyList });
  if (signal?.aborted) throw timeout();
  if (checked.family) {
    if (!isPublicAddress(checked.hostname) || deniedAddress(checked.hostname, denyEntries(denyList))) throw blocked();
    return { ...checked, address: checked.hostname, family: checked.family };
  }

  const entries = denyEntries(denyList);
  let answers;
  try {
    answers = await waitForLookup(lookup(checked.hostname, { all: true, verbatim: true }), {
      timeoutMs: Math.min(lookupTimeoutMs, 2000), signal,
    });
  } catch (error) {
    if (error instanceof LinkGuardError) throw error;
    if (signal?.aborted) throw timeout();
    throw new LinkGuardError('unreachable', 'Address lookup failed');
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new LinkGuardError('unreachable', 'Address lookup returned no addresses');
  const normalized = answers.map((answer) => {
    const address = answer?.address;
    const actualFamily = typeof address === 'string' ? isIP(address) : 0;
    return { address, family: answer?.family || actualFamily, actualFamily };
  });
  if (normalized.some(({ address, family, actualFamily }) =>
    !address || !family || family !== actualFamily || !isPublicAddress(address) || deniedAddress(address, entries))) throw blocked();
  return { ...checked, address: normalized[0].address, family: normalized[0].family };
}
