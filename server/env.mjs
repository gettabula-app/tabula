const LEGACY_PREFIX = 'MIRA_';
const PREFIX = 'TABULA_';

// The product used to be called Mira. Every MIRA_<X> variable is still honoured as TABULA_<X> (the TABULA_ name wins when
// both are set); a single warning names the legacy variables that were used. The input is left untouched, and the legacy
// keys stay in the copy, so running the result through this function again changes and says nothing.
export function withLegacyEnv(env = process.env, warn = console.warn) {
  const out = { ...env };
  const used = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY_PREFIX) || env[name] === undefined) continue;
    const canonical = PREFIX + name.slice(LEGACY_PREFIX.length);
    if (out[canonical] !== undefined) continue;
    out[canonical] = env[name];
    used.push(`${name} (use ${canonical})`);
  }
  if (used.length) {
    warn(`Deprecated environment variables, rename them: ${used.join(', ')}`);
  }
  return out;
}
