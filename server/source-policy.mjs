// Who may open a connection to this instance (TAB-103, docs/cloud.md "Source policy"). On Fly every app of an organisation
// shares one private network (6PN), so another customer's machine can connect to this one directly and skip the edge.
// Traffic that arrives through Fly's proxy (visitors, `fly-replay`, Flycast calls of the control plane) comes from the
// proxy's private IPv4 range, 172.16.0.0/12; direct 6PN traffic comes from an `fdaa:` address, and the Machines API's
// exec path runs on loopback. So a hosted instance accepts loopback and the proxy range and refuses everything else.
//
// TABULA_SOURCE_POLICY=off (the default, for self-hosters) checks nothing; `proxy` enforces the list below.
// TABULA_ALLOW_SOURCES is a comma list of addresses and CIDRs that replaces the default list; it is read only with `proxy`.
import { BlockList, isIP } from 'node:net';

export const DEFAULT_ALLOWED_SOURCES = ['127.0.0.0/8', '::1/128', '172.16.0.0/12'];
const MAX_TRACKED = 1000;

/** @param {string} raw */
export function parseSources(raw) {
  const entries = String(raw ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  return entries.map((entry) => {
    const slash = entry.lastIndexOf('/');
    const address = slash < 0 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    const max = family === 4 ? 32 : 128;
    const prefixText = slash < 0 ? String(max) : entry.slice(slash + 1);
    const prefix = Number(prefixText);
    if (!family || address.includes('%') || !/^\d+$/.test(prefixText) || prefix > max) {
      throw new Error(`TABULA_ALLOW_SOURCES entry is not a valid IPv4 or IPv6 address or CIDR: ${entry.slice(0, 60)}`);
    }
    return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
  });
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: 'off' | 'proxy', sources: { address: string, prefix: number, family: 'ipv4' | 'ipv6' }[] }}
 */
export function loadSourcePolicy(env) {
  const raw = (env.TABULA_SOURCE_POLICY ?? '').trim().toLowerCase();
  if (raw && raw !== 'off' && raw !== 'proxy') throw new Error(`TABULA_SOURCE_POLICY must be off or proxy (got "${raw.slice(0, 40)}")`);
  const mode = raw === 'proxy' ? 'proxy' : 'off';
  if (mode === 'off') return { mode, sources: [] };
  const listed = parseSources(env.TABULA_ALLOW_SOURCES);
  return { mode, sources: listed.length ? listed : parseSources(DEFAULT_ALLOWED_SOURCES.join(',')) };
}

/**
 * The gate. `allows(address)` answers for one peer address; `refused(address)` records a refusal (a log line for the first
 * one of each source, counted in memory, at most MAX_TRACKED sources) and returns nothing.
 * @param {{ mode: 'off' | 'proxy', sources: { address: string, prefix: number, family: 'ipv4' | 'ipv6' }[] }} policy
 * @param {{ log?: (line: string) => void }} [deps]
 */
export function createSourceGate(policy, { log = () => {} } = {}) {
  const list = new BlockList();
  for (const s of policy.sources) list.addSubnet(s.address, s.prefix, s.family);
  const seen = new Map();
  return {
    enforcing: policy.mode === 'proxy',
    /** BlockList treats an IPv4-mapped IPv6 peer (::ffff:a.b.c.d) as the IPv4 address. */
    allows(address) {
      if (policy.mode !== 'proxy') return true;
      const family = isIP(address ?? '');
      if (!family) return false;
      return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
    },
    refused(address) {
      const key = String(address ?? 'unknown');
      const count = (seen.get(key) ?? 0) + 1;
      if (!seen.has(key) && seen.size >= MAX_TRACKED) seen.delete(seen.keys().next().value);
      seen.set(key, count);
      if (count === 1) log(`source policy: refused a connection from ${key.slice(0, 60)}`);
    },
    get refusedSources() {
      return seen.size;
    },
  };
}
