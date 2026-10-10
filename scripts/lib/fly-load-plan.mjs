const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const FLY_LOAD_SIZES = Object.freeze([
  Object.freeze({ id: 'shared-cpu-1x', machineSize: 'shared-cpu-1x', memoryMb: 512 }),
  Object.freeze({ id: 'performance-1x', machineSize: 'performance-1x', memoryMb: 1024 }),
  Object.freeze({ id: 'performance-2x', machineSize: 'performance-2x', memoryMb: 2048 }),
]);

export const FLY_LOAD_USERS = Object.freeze([30, 60, 100]);
export const FLY_LOAD_SECONDS_PER_STEP = 60;
export const FLY_LOAD_JOIN_BURST_SECONDS = 10;
export const FLY_LOAD_MAX_TOTAL_MINUTES = 180;
export const FLY_LOAD_WORKSPACE_EXPIRY_MS = 3 * HOUR_MS;
export const FLY_LOAD_METRICS = Object.freeze([
  Object.freeze({ name: 'sync p50 / p95 / max', source: 'load-class report JSON' }),
  Object.freeze({ name: 'join p95', source: 'load-class report JSON' }),
  Object.freeze({ name: 'errors and verdict', source: 'load-class report JSON' }),
  Object.freeze({ name: 'Fly machine CPU sustained %', source: 'Fly metrics dashboard, recorded manually per user step' }),
  Object.freeze({ name: 'Fly machine memory used MB', source: 'Fly metrics dashboard, recorded manually per user step' }),
  Object.freeze({ name: 'relay process CPU sustained %', source: 'machine process view, recorded manually per user step' }),
  Object.freeze({ name: 'relay process RSS peak MB', source: 'machine process view, recorded manually per user step' }),
]);

export const FLY_LOAD_PASS_RULE = Object.freeze({
  userCount: 100,
  loadClassVerdict: 'OK',
  maxCpuSustainedPctExclusive: 70,
  maxRelayRssFractionExclusive: 0.7,
});

export function defaultFlyLoadSlug(now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
  return `tab227-load-${date}`;
}

export function makeFlyLoadGoPhrase(slug) {
  return `run the fly load test ${slug}`;
}

export function hasFlyLoadGoPhrase(value, slug) {
  return value === makeFlyLoadGoPhrase(slug);
}

export function makeFlyLoadPlan({ now = Date.now(), slug = defaultFlyLoadSlug(now), domain = 'gettabula.app', region = 'eu' } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a non-negative whole number of milliseconds');
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(slug)) throw new Error('FLY_LOAD_SLUG must be 3 to 32 lowercase letters, numbers, or hyphens and start with a letter');
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    throw new Error('FLY_LOAD_DOMAIN must be a DNS name without a scheme or path');
  }
  if (!['eu', 'us'].includes(region)) throw new Error('FLY_LOAD_REGION must be eu or us');

  const userActivitySeconds = FLY_LOAD_SIZES.length * FLY_LOAD_USERS.length * FLY_LOAD_SECONDS_PER_STEP;
  const joinBurstSeconds = FLY_LOAD_SIZES.length * FLY_LOAD_USERS.length * FLY_LOAD_JOIN_BURST_SECONDS;
  return {
    slug,
    domain,
    targetHost: `${slug}.${domain}`,
    targetUrl: `https://${slug}.${domain}/`,
    workspaceName: `TAB-227 load test ${slug}`,
    region,
    seats: 100,
    userSteps: [...FLY_LOAD_USERS],
    secondsPerStep: FLY_LOAD_SECONDS_PER_STEP,
    joinBurstSecondsPerStep: FLY_LOAD_JOIN_BURST_SECONDS,
    sizes: FLY_LOAD_SIZES.map((size) => ({ ...size })),
    metrics: FLY_LOAD_METRICS.map((metric) => ({ ...metric })),
    passRule: { ...FLY_LOAD_PASS_RULE },
    createdAt: now,
    workspaceExpiresAt: now + FLY_LOAD_WORKSPACE_EXPIRY_MS,
    maxTotalMinutes: FLY_LOAD_MAX_TOTAL_MINUTES,
    postExpiryDeletionDaysIfNotDeleted: 30,
    estimated: {
      loadActivitySeconds: userActivitySeconds,
      joinBurstSeconds,
      measuredSeconds: userActivitySeconds + joinBurstSeconds,
      measuredMinutes: (userActivitySeconds + joinBurstSeconds) / 60,
      maxMachineMinutes: FLY_LOAD_MAX_TOTAL_MINUTES,
    },
  };
}

/**
 * Select the smallest machine whose 100-user step is healthy and has the required manual machine metrics.
 * Missing metrics fail closed.
 * @param {Array<{ sizeId: string, users: number, loadClassVerdict?: string, cpuSustainedPct?: number|null, relayRssMb?: number|null }>} rows
 */
export function evaluateFlyLoadPassRule(rows) {
  const checks = FLY_LOAD_SIZES.map((size) => {
    const row = rows.find((candidate) => candidate.sizeId === size.id && candidate.users === FLY_LOAD_PASS_RULE.userCount);
    const cpu = row?.flyCpuSustainedPct ?? row?.cpuSustainedPct;
    const rss = row?.relayRssMb;
    const cpuOk = Number.isFinite(cpu) && cpu < FLY_LOAD_PASS_RULE.maxCpuSustainedPctExclusive;
    const rssLimitMb = size.memoryMb * FLY_LOAD_PASS_RULE.maxRelayRssFractionExclusive;
    const rssOk = Number.isFinite(rss) && rss < rssLimitMb;
    return {
      sizeId: size.id,
      users: FLY_LOAD_PASS_RULE.userCount,
      loadClassVerdict: row?.loadClassVerdict ?? null,
      cpuSustainedPct: Number.isFinite(cpu) ? cpu : null,
      relayRssMb: Number.isFinite(rss) ? rss : null,
      rssLimitMb,
      passed: row?.loadClassVerdict === FLY_LOAD_PASS_RULE.loadClassVerdict && cpuOk && rssOk,
    };
  });
  return {
    recommendation: checks.find((check) => check.passed)?.sizeId ?? null,
    checks,
  };
}
