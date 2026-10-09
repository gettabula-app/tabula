const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isLocalTargetHost(host) {
  return LOCAL_HOSTS.has(String(host).toLowerCase());
}

export function validateTargetHost(host, allowHostPattern) {
  const normalized = String(host).toLowerCase();
  if (isLocalTargetHost(normalized)) return normalized;
  if (/^[a-z0-9-]+\.gettabula\.app$/.test(normalized)) return normalized;
  if (allowHostPattern !== undefined && allowHostPattern !== '') {
    let allowed;
    try {
      allowed = new RegExp(`^(?:${allowHostPattern})$`, 'i');
    } catch {
      throw new Error('TARGET_ALLOW_HOST must be a valid regular expression');
    }
    if (allowed.test(normalized)) return normalized;
  }
  throw new Error('TARGET_URL host is not allowed; use a <name>.gettabula.app host or TARGET_ALLOW_HOST');
}

function listValues(value, label) {
  if (value === undefined || value === '') return [];
  const values = String(value).split(',').map((item) => item.trim());
  if (values.some((item) => !item)) throw new Error(`${label} must be a comma-separated list without empty entries`);
  return values;
}

function targetOrigin(targetUrl, allowHostPattern) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error('TARGET_URL must be a valid HTTP or HTTPS origin');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TARGET_URL must be an origin without credentials, a path, a query, or a fragment');
  }
  const host = validateTargetHost(url.hostname, allowHostPattern);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalTargetHost(host))) {
    throw new Error('TARGET_URL must use HTTPS except for localhost or 127.0.0.1');
  }
  return { host, origin: url.origin };
}

export function parseTargetOptions(env = process.env) {
  if (env.TARGET_URL === undefined) return { remote: false };

  const { host, origin } = targetOrigin(env.TARGET_URL, env.TARGET_ALLOW_HOST);
  const cookies = listValues(env.TARGET_COOKIES, 'TARGET_COOKIES');
  const tokens = listValues(env.TARGET_LOGIN_TOKENS, 'TARGET_LOGIN_TOKENS');
  if (cookies.some((cookie) => !/^[^=;,\s]+=[^;,\s]+(?:;\s*[^=;,\s]+=[^;,\s]+)*$/.test(cookie))) {
    throw new Error('TARGET_COOKIES entries must be name=value cookie strings');
  }
  if (tokens.some((token) => !token)) throw new Error('TARGET_LOGIN_TOKENS entries must not be empty');
  const credentials = [
    ...cookies.map((value) => ({ kind: 'cookie', value })),
    ...tokens.map((value) => ({ kind: 'token', value })),
  ];
  if (credentials.length === 0) throw new Error('Remote mode requires TARGET_COOKIES or TARGET_LOGIN_TOKENS');

  return {
    remote: true,
    host,
    origin,
    credentials,
    accountCount: credentials.length,
    confirmation: env.TARGET_CONFIRM ?? '',
    dryRun: env.TARGET_DRY_RUN === '1',
  };
}

export function validateTargetOptions(target, users) {
  if (!target?.remote) return target;
  if (!Array.isArray(users) || users.some((count) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error('USERS must be a comma-separated list of positive whole numbers');
  }
  if (!isLocalTargetHost(target.host) && users.some((count) => count > 150)) {
    throw new Error('Remote TARGET_URL runs are limited to 150 users per step');
  }
  return target;
}

export function targetPlanText(target, users, seconds) {
  const boards = users.length;
  const lines = [
    'REMOTE LOAD PLAN',
    `Host: ${target.host}`,
    `Steps: ${users.join(', ')} users`,
    `Activity: ${seconds} seconds per step after a 10 second join burst`,
    `Accounts: ${target.accountCount}`,
    `Will create: ${boards} personal board${boards === 1 ? '' : 's'}, each seeded with 150 sticky objects; share each board with the other supplied accounts as editors; then try to delete the boards.`,
  ];
  if (users.some((count) => count > target.accountCount)) {
    lines.push('Account reuse: simulated users will reuse the supplied accounts round-robin; this represents one person with many tabs, and per-person limits are not multiplied.');
  }
  return lines.join('\n');
}

export function targetRunDecision(target) {
  if (target.dryRun) return { run: false, exitCode: 0, reason: 'dry-run' };
  if (target.confirmation !== target.host) {
    return { run: false, exitCode: 2, reason: 'confirmation', confirmationLine: `TARGET_CONFIRM=${target.host}` };
  }
  return { run: true, exitCode: 0, reason: 'confirmed' };
}

export function redactTargetSecrets(value, secrets = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  const values = Array.isArray(secrets)
    ? secrets.map((item) => (typeof item === 'string' ? item : item?.value))
    : (secrets?.credentials ?? []).map((item) => item?.value);
  for (const secret of [...new Set(values.filter((item) => typeof item === 'string' && item))].sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  return text;
}

export function assignAccountsToUsers(accounts, userCount) {
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('At least one validated account is required');
  if (!Number.isSafeInteger(userCount) || userCount < 1) throw new Error('User count must be a positive whole number');
  return Array.from({ length: userCount }, (_, index) => accounts[index % accounts.length]);
}
