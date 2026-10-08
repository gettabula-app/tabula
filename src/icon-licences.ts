// Which icon licences Tabula offers. The same rule as scripts/lib/icons-build.mjs (test/icons-client.test.ts runs both over one
// table), used here to filter the online sets Iconify lists. Matched on the SPDX id exactly: a compound id is unknown.

export type LicenceTier = 'public' | 'notice' | 'attribution';

const TIERS: Record<string, LicenceTier> = {
  'CC0-1.0': 'public', Unlicense: 'public', '0BSD': 'public',
  MIT: 'notice', ISC: 'notice', 'Apache-2.0': 'notice', 'BSD-2-Clause': 'notice', 'BSD-3-Clause': 'notice', 'OFL-1.1': 'notice',
  'CC-BY-3.0': 'attribution', 'CC-BY-4.0': 'attribution',
};

/** The class of an allowed licence, or null for NonCommercial, ShareAlike, copyleft, compound, unknown and missing ones. */
export function licenceTier(spdx: string | undefined, title?: string): LicenceTier | null {
  if (typeof spdx !== 'string' || !spdx) return null;
  if (/-NC/i.test(spdx) || /non-?commercial|[\s-]NC\b/i.test(typeof title === 'string' ? title : '')) return null;
  return Object.hasOwn(TIERS, spdx) ? TIERS[spdx] : null;
}
