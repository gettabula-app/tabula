import { describe, expect, it } from 'vitest';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';

// The sign-in limiter counts an IPv6 client by its /64, so rotating through addresses of one prefix does not reset the limit.
function setup(env: Record<string, string> = { TABULA_AUTH_IP_LIMIT: '20' }) {
  const auth = createAuth({
    directory: { getUserByEmail: () => null } as any,
    config: loadConfig(env, () => {}),
    mailer: { send: async () => {} },
    now: () => 1_700_000_000_000,
  });
  return (n: number, ip: string) => auth.requestLogin({ email: `u${n}@example.com`, ip });
}

function setupEmail() {
  const auth = createAuth({
    directory: { getUserByEmail: () => null } as any,
    config: loadConfig({}, () => {}),
    mailer: { send: async () => {} },
    now: () => 1_700_000_000_000,
  });
  return (email: string, ip: string) => auth.requestLogin({ email, ip }) as Promise<any>;
}

describe('sign-in limiter and IPv6', () => {
  it('rotating within one /64 does not reset the per-address limit', async () => {
    const login = setup();
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r: any = await login(i, `2001:db8:1:2:${i.toString(16)}::${i + 1}`);
      if (r.limited) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    expect(await login(99, '2001:db8:1:2:ffff::1')).toMatchObject({ limited: true, scope: 'ip' });
    expect(await login(100, '2001:db8:1:3::1')).toEqual({ ok: true }); // another /64 is a different client
  });

  it('rotating within one /64 shares one pair bucket for an email; another /64 has its own', async () => {
    const login = setupEmail();
    for (let i = 0; i < 5; i++) expect(await login('victim@example.com', `2001:db8:a:b:${i.toString(16)}::1`)).toEqual({ ok: true });
    expect(await login('victim@example.com', '2001:db8:a:b:ffff::9')).toMatchObject({ limited: true, scope: 'pair' });
    expect(await login('victim@example.com', '2001:db8:a:c::1')).toEqual({ ok: true });
  });

  it('keys the pair bucket on the prefix even when handed a full address (idempotent)', async () => {
    const login = setupEmail();
    for (let i = 0; i < 5; i++) await login('x@example.com', `2001:db8:5:6:${i}::1`);
    expect(await login('x@example.com', '2001:db8:5:6::77')).toMatchObject({ limited: true, scope: 'pair' });
  });
});
