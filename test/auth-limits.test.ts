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
    expect(blocked).toMatchObject({ limited: true, scope: 'pair' });
    expect(blocked.retryAfterSec).toBe(50 * 60);
    expect(lines).toEqual(['auth request rate_limited scope=pair']);
  });

  it('limits one network address at the configured number and says so', async () => {
    const a = auth({ ...loadConfig({ TABULA_AUTH_IP_LIMIT: '3' } as never), ownerEmail: null }, () => 5_000);
    for (let i = 0; i < 3; i++) expect(await a.requestLogin({ email: `p${i}@school.test`, ip: '10.0.0.3' })).toEqual({ ok: true });
    expect(await a.requestLogin({ email: 'p9@school.test', ip: '10.0.0.3' })).toMatchObject({ limited: true, scope: 'ip', retryAfterSec: 3600 });
  });

  it.each(['TABULA_AUTH_IP_LIMIT', 'TABULA_AUTH_EMAIL_LIMIT'])('refuses a nonsense %s at startup', (name) => {
    for (const bad of ['0', '-1', 'many', '1.5', '100001']) {
      expect(() => loadConfig({ [name]: bad } as never)).toThrow(new RegExp(name));
    }
  });

  it('defaults the email ceiling to 30 and reads TABULA_AUTH_EMAIL_LIMIT', () => {
    expect(loadConfig({} as never).authEmailLimit).toBe(30);
    expect(loadConfig({ TABULA_AUTH_EMAIL_LIMIT: '7' } as never).authEmailLimit).toBe(7);
  });

  describe('per-email limits', () => {
    const victim = 'victim@school.test';
    const cfg = { ...loadConfig({} as never), ownerEmail: null };
    const ask = (a: ReturnType<typeof auth>, email: string, ip: string) => a.requestLogin({ email, ip }) as Promise<{ ok?: boolean; limited?: boolean; scope?: string; retryAfterSec?: number }>;

    it('an attacker on another address cannot use up the victim pair', async () => {
      const sent: string[] = [];
      const a = createAuth({
        directory: { ...fakeDirectory, getUserByEmail: (e: string) => ({ email: e, disabled: false }), createLoginToken: () => 'tok' } as never,
        config: cfg as never,
        mailer: { send: async (m: { to: string }) => void sent.push(m.to) } as never,
        now: () => 1_000_000,
      });
      for (let i = 0; i < 5; i++) expect(await ask(a, victim, '6.6.6.6')).toEqual({ ok: true });
      expect(await ask(a, victim, '6.6.6.6')).toMatchObject({ limited: true, scope: 'pair', retryAfterSec: 3600 });
      // the victim, from their own address, still gets mail
      expect(await ask(a, victim, '10.1.1.1')).toEqual({ ok: true });
      expect(sent.length).toBe(6);
    });

    it('stops at the ceiling across many addresses and then blocks everyone, with the real wait', async () => {
      let t = 1_000_000;
      const a = auth(cfg, () => t);
      for (let i = 0; i < 30; i++) {
        expect(await ask(a, victim, `7.7.7.${i}`)).toEqual({ ok: true });
        t += 1000;
      }
      const blocked = await ask(a, victim, '10.1.1.1');
      expect(blocked).toMatchObject({ limited: true, scope: 'email' });
      expect(blocked.retryAfterSec).toBe(3600 - 30);
      // another mailbox is untouched
      expect(await ask(a, 'other@school.test', '7.7.7.0')).toEqual({ ok: true });
    });

    it('honours TABULA_AUTH_EMAIL_LIMIT', async () => {
      const a = auth({ ...loadConfig({ TABULA_AUTH_EMAIL_LIMIT: '2' } as never), ownerEmail: null }, () => 9_000);
      await ask(a, victim, '1.1.1.1');
      await ask(a, victim, '1.1.1.2');
      expect(await ask(a, victim, '1.1.1.3')).toMatchObject({ limited: true, scope: 'email', retryAfterSec: 3600 });
    });

    it('reports the longest wait when several limits are hit', async () => {
      let t = 0;
      const a = auth({ ...loadConfig({ TABULA_AUTH_IP_LIMIT: '6' } as never), ownerEmail: null }, () => t);
      for (let i = 0; i < 5; i++) await ask(a, victim, '2.2.2.2'); // pair full at t=0
      t = 30 * 60 * 1000;
      await ask(a, 'x@school.test', '2.2.2.2'); // ip now 6 of 6, oldest hit at t=0
      t = 40 * 60 * 1000;
      const blocked = await ask(a, victim, '2.2.2.2');
      expect(blocked.limited).toBe(true);
      expect(blocked.retryAfterSec).toBe(20 * 60);
    });

    it('answers identically for a known and an unknown address, and never logs an address', async () => {
      const lines: string[] = [];
      const known = createAuth({
        directory: { ...fakeDirectory, getUserByEmail: () => ({ disabled: false }), createLoginToken: () => 'tok' } as never,
        config: cfg as never, mailer: mailer as never, now: () => 5_000, log: (l) => lines.push(l),
      });
      const unknown = auth(cfg, () => 5_000, (l) => lines.push(l));
      const outcomes = [];
      for (const a of [known, unknown]) {
        const seen = [];
        for (let i = 0; i < 6; i++) seen.push(await ask(a, victim, '3.3.3.3'));
        outcomes.push(seen);
      }
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(lines).toEqual(['auth request rate_limited scope=pair', 'auth request rate_limited scope=pair']);
      expect(lines.join('\n')).not.toMatch(/victim|3\.3\.3\.3/);
    });
  });

  describe('a classroom at the default limits', () => {
    it.each([
      ['one IPv4 address', (_pupil: number) => '10.20.30.40'],
      ['one IPv6 /64', (pupil: number) => `2001:db8:77:88:${(pupil + 1).toString(16)}::${pupil + 1}`],
    ])('30 pupils on %s ask 5 times each and nobody is refused', async (_name, ipOf) => {
      const lines: string[] = [];
      const a = auth({ ...loadConfig({} as never), ownerEmail: null }, () => 4_000_000, (l) => lines.push(l));
      let refused = 0;
      for (let round = 0; round < 5; round++) {
        for (let pupil = 0; pupil < 30; pupil++) {
          const r = (await a.requestLogin({ email: `pupil${pupil}@school.test`, ip: ipOf(pupil) })) as { limited?: boolean };
          if (r.limited) refused++;
        }
      }
      expect(refused).toBe(0);
      expect(lines).toEqual([]);
    });
  });
});
