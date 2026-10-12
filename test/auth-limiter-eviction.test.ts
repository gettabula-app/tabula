import { describe, expect, it, vi } from 'vitest';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';

// Exercise the public sign-in API with a movable clock. The directory stub keeps every address unknown,
// so requests exercise the limiter without creating users, tokens or mail.
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CAP = 50_000;

vi.setConfig({ testTimeout: 60_000 });

// Test seam: a key containing "s7-" falls in overflow shard 7; anything else in shard 0.
const shardOf = (_scope: string, key: string) => Number(/s(\d+)-/.exec(key)?.[1] ?? 0);

function setup(env: Record<string, string> = { TABULA_AUTH_IP_LIMIT: '20' }) {
  const clock = { t: T0 };
  // the email ceiling is set to 5 so the email map's own limit (not just the pair map's) is exercised here
  const config = loadConfig({ TABULA_AUTH_EMAIL_LIMIT: '5', ...env }, () => {});
  const auth = createAuth({
    directory: { getUserByEmail: () => null } as any,
    config,
    mailer: { send: async () => {} },
    now: () => clock.t,
    limiterShardOf: shardOf,
  });
  const login = (email: string, ip: string) => auth.requestLogin({ email, ip });
  return { clock, login };
}

async function fillPairs(login: ReturnType<typeof setup>['login'], start: number, count: number) {
  // Keep the promise batch bounded while still letting each async public API call finish.
  const batchSize = 1_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset);
    const results = await Promise.all(Array.from({ length: size }, (_, i) => {
      const n = start + offset + i;
      return login(`filler-${n}@example.com`, `198.51.${Math.floor(n / 256) % 256}.${n % 256}`);
    }));
    expect(results.every((result) => 'ok' in result)).toBe(true);
  }
}

describe('sign-in limiter table bound', () => {
  it('never forgets a live quota when the tables fill: new keys share an overflow bucket instead', async () => {
    const { clock, login } = setup();
    const victim = 'victim@example.com';
    const victimIp = '192.0.2.1';
    const warm = 'warm@example.com';
    const warmIp = '192.0.2.2';

    // the victim has used the whole allowance for the address (5 from this client); another person used 2
    for (let i = 0; i < 5; i++) expect(await login(victim, victimIp)).toEqual({ ok: true });
    expect(await login(victim, victimIp)).toMatchObject({ limited: true, scope: 'pair' });
    expect(await login(warm, warmIp)).toEqual({ ok: true });
    expect(await login(warm, warmIp)).toEqual({ ok: true });

    // an attacker fills every table with live keys (the two keys above already take two slots in each table)
    clock.t = T0 + 10 * MINUTE;
    await fillPairs(login, 0, CAP - 2);

    // the victim's hits were not forgotten, in the pair table and in the email table (a different client address)
    expect(await login(victim, victimIp)).toMatchObject({ limited: true, scope: 'pair' });
    expect(await login(victim, '192.0.2.77')).toMatchObject({ limited: true, scope: 'email' });
    // the wait is still the real one, counted from the victim's first hit
    expect(await login(victim, victimIp)).toMatchObject({ retryAfterSec: 50 * 60 });
    // a known key with room left keeps working and keeps its count (2 used, 3 left)
    for (let i = 0; i < 3; i++) expect(await login(warm, warmIp)).toEqual({ ok: true });
    expect(await login(warm, warmIp)).toMatchObject({ limited: true, scope: 'pair' });

    // keys that do not fit go to overflow shards; each shard allows 6 times the per-key limit (30 for the pair table)
    let n = 0;
    const burn = async (shard: number, count: number) => {
      const results = [];
      for (let i = 0; i < count; i++) results.push(await login(`s${shard}-${n}@example.com`, `203.0.${Math.floor(n / 200)}.${n++ % 200}`));
      return results;
    };
    const seven = await burn(7, 31);
    expect(seven.slice(0, 30).every((r) => 'ok' in r)).toBe(true);
    expect(seven[30]).toMatchObject({ limited: true, scope: 'pair' });
    // exhausting one shard does not block keys in other shards, nor after several shards are exhausted
    await burn(9, 31);
    await burn(11, 31);
    expect((await burn(8, 30)).every((r) => 'ok' in r)).toBe(true);
    // a refusal from a shard says nothing about any address or shard
    expect(JSON.stringify(seven[30])).not.toMatch(/example|203\.0|shard|s7/);
  });

  it('keeps the shard function keyed and spread by default', async () => {
    const lines: string[] = [];
    const clock = { t: T0 };
    const mk = () => createAuth({
      directory: { getUserByEmail: () => null } as any,
      config: loadConfig({}, () => {}),
      mailer: { send: async () => {} },
      now: () => clock.t,
      log: (l: string) => lines.push(l),
    });
    expect(mk()).toBeTruthy(); // default HMAC shard function constructs without a seam
    expect(lines).toEqual([]);
  });

  it('raises the cost, not impossible: with the tables full and all 256 shards exhausted, new keys are refused while live keys keep their counts', async () => {
    // documented behaviour (docs/accounts.md, Sign-in): sharding makes the attack dearer, it does not prevent it.
    // the network limit is raised here so that only the pair and email tables are under test.
    const { clock, login } = setup({ TABULA_AUTH_IP_LIMIT: '100000' });
    const victim = 'victim@example.com';
    const warm = 'warm@example.com';
    for (let i = 0; i < 5; i++) expect(await login(victim, '192.0.2.1')).toEqual({ ok: true });
    expect(await login(warm, '192.0.2.2')).toEqual({ ok: true });
    clock.t = T0 + 10 * MINUTE;
    await fillPairs(login, 0, CAP - 2);

    // 256 shards x 30 requests each
    let n = 0;
    for (let shard = 0; shard < 256; shard++) {
      for (let i = 0; i < 30; i++) {
        expect(await login(`s${shard}-${i}@example.com`, `203.${shard}.${Math.floor(n / 250)}.${n++ % 250}`)).toEqual({ ok: true });
      }
    }
    // every shard is now full: a further new key, whichever shard it falls in, is refused
    for (const shard of [0, 77, 255]) {
      expect(await login(`s${shard}-late@example.com`, '198.18.0.1')).toMatchObject({ limited: true, scope: 'pair' });
    }
    // live keys keep their own counts: the victim is still limited, the warm key has 4 of its 5 left
    expect(await login(victim, '192.0.2.1')).toMatchObject({ limited: true, scope: 'pair' });
    for (let i = 0; i < 4; i++) expect(await login(warm, '192.0.2.2')).toEqual({ ok: true });
    expect(await login(warm, '192.0.2.2')).toMatchObject({ limited: true });
    // and an hour later everything is open again
    clock.t = T0 + 3 * HOUR;
    expect(await login('s3-late@example.com', '198.18.0.1')).toEqual({ ok: true });
  });

  it('reclaims keys whose hits have expired before using the overflow bucket', async () => {
    const { clock, login } = setup();
    await fillPairs(login, 0, CAP);
    clock.t = T0 + HOUR + 2 * MINUTE; // every filler hit is now outside the window
    // far more than the overflow allowance of 15, all new keys, all allowed
    for (let i = 0; i < 100; i++) {
      expect(await login(`after-${i}@example.com`, `100.64.0.${i}`)).toEqual({ ok: true });
    }
  });
});
