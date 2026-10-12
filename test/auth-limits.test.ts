import { describe, expect, it } from 'vitest';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';

// A class behind one school address must not lock itself out (jensen, October 2026).

const fakeDirectory = { getUserByEmail: () => null, findInvite: () => null, countOwners: () => 0 };
const mailer = { send: async () => {} };

function auth(config: Record<string, unknown>, now: () => number, log: (line: string) => void = () => {}) {
  return createAuth({ directory: fakeDirectory as never, config: config as never, mailer: mailer as never, now, log });
}

describe('sign-in request limits', () => {
  it('allows a whole class from one address by default and reports the real wait when the limit is hit', async () => {
    const cfg = loadConfig({} as never);
    expect(cfg.authIpLimit).toBe(300);
    let t = 1_000_000;
    const lines: string[] = [];
    const a = auth({ ...cfg, ownerEmail: null }, () => t, (l) => lines.push(l));
    for (let i = 0; i < 100; i++) expect(await a.requestLogin({ email: `pupil${i}@school.test`, ip: '10.0.0.1' })).toEqual({ ok: true });
    // the same address asks again and again: five an hour, then the real wait
    for (let i = 0; i < 5; i++) await a.requestLogin({ email: 'one@school.test', ip: '10.0.0.2' });
    t += 10 * 60 * 1000;
    const blocked = (await a.requestLogin({ email: 'one@school.test', ip: '10.0.0.2' })) as { limited?: boolean; scope?: string; retryAfterSec?: number };
    expect(blocked).toMatchObject({ limited: true, scope: 'email' });
    expect(blocked.retryAfterSec).toBe(50 * 60);
    expect(lines).toEqual(['auth request rate_limited scope=email']);
  });

  it('limits one network address at the configured number and says so', async () => {
    const a = auth({ ...loadConfig({ TABULA_AUTH_IP_LIMIT: '3' } as never), ownerEmail: null }, () => 5_000);
    for (let i = 0; i < 3; i++) expect(await a.requestLogin({ email: `p${i}@school.test`, ip: '10.0.0.3' })).toEqual({ ok: true });
    expect(await a.requestLogin({ email: 'p9@school.test', ip: '10.0.0.3' })).toMatchObject({ limited: true, scope: 'ip', retryAfterSec: 3600 });
  });

  it('refuses a nonsense TABULA_AUTH_IP_LIMIT at startup', () => {
    for (const bad of ['0', '-1', 'many', '1.5', '100001']) {
      expect(() => loadConfig({ TABULA_AUTH_IP_LIMIT: bad } as never)).toThrow(/TABULA_AUTH_IP_LIMIT/);
    }
  });
});
