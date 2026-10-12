import { describe, expect, it } from 'vitest';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';

// The sign-in limiter counts an IPv6 client by its /64, so rotating through addresses of one prefix does not reset the limit.
function setup() {
  const auth = createAuth({
    directory: { getUserByEmail: () => null } as any,
    config: loadConfig({}, () => {}),
    mailer: { send: async () => {} },
    now: () => 1_700_000_000_000,
  });
  return (n: number, ip: string) => auth.requestLogin({ email: `u${n}@example.com`, ip });
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
    expect(await login(99, '2001:db8:1:2:ffff::1')).toEqual({ limited: true });
    expect(await login(100, '2001:db8:1:3::1')).toEqual({ ok: true }); // another /64 is a different client
  });
});
