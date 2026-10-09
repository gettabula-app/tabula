import { describe, expect, it } from 'vitest';
import {
  assignAccountsToUsers,
  parseTargetOptions,
  redactTargetSecrets,
  targetPlanText,
  targetRunDecision,
  validateTargetHost,
  validateTargetOptions,
} from '../scripts/lib/load-class-target.mjs';

describe('class load target options', () => {
  it('allows the supported workspace hosts and local test hosts', () => {
    expect(validateTargetHost('team-a.gettabula.app')).toBe('team-a.gettabula.app');
    expect(validateTargetHost('localhost')).toBe('localhost');
    expect(validateTargetHost('127.0.0.1')).toBe('127.0.0.1');
    expect(validateTargetHost('load.example.test', 'load\\.example\\.test')).toBe('load.example.test');
    const local = parseTargetOptions({ TARGET_URL: 'http://localhost:8787', TARGET_COOKIES: 'session=fake' });
    expect(validateTargetOptions(local, [151])).toBe(local);
  });

  it('refuses unapproved hosts, non-HTTPS remote targets, and remote steps above 150 users', () => {
    expect(() => validateTargetHost('example.test')).toThrow(/host is not allowed/);
    expect(() => validateTargetHost('not-load.example.test', 'load\\.example\\.test')).toThrow(/host is not allowed/);
    expect(() => parseTargetOptions({ TARGET_URL: 'http://team-a.gettabula.app', TARGET_COOKIES: 'session=fake' })).toThrow(/must use HTTPS/);
    const target = parseTargetOptions({ TARGET_URL: 'https://team-a.gettabula.app', TARGET_COOKIES: 'session=fake' });
    expect(() => validateTargetOptions(target, [150, 151])).toThrow(/limited to 150 users/);
    expect(validateTargetOptions(target, [150])).toBe(target);
    expect(() => validateTargetHost('example.test', '[')).toThrow(/valid regular expression/);
  });

  it('requires one credential source, orders cookies before tokens, and keeps parse errors secret-free', () => {
    expect(() => parseTargetOptions({ TARGET_URL: 'https://team-a.gettabula.app' })).toThrow(/requires TARGET_COOKIES or TARGET_LOGIN_TOKENS/);
    const target = parseTargetOptions({
      TARGET_URL: 'https://team-a.gettabula.app',
      TARGET_COOKIES: 'session=fake-cookie,other=fake-cookie-2',
      TARGET_LOGIN_TOKENS: 'fake-token',
    });
    expect(target.credentials!.map(({ kind }) => kind)).toEqual(['cookie', 'cookie', 'token']);
    expect(target.accountCount).toBe(3);
    const messages = [
      targetPlanText(target, [3], 5),
      ...[
        () => parseTargetOptions({ TARGET_URL: 'not a URL fake-cookie fake-token', TARGET_COOKIES: 'session=fake-cookie' }),
        () => parseTargetOptions({ TARGET_URL: 'https://team-a.gettabula.app', TARGET_COOKIES: 'fake-cookie' }),
      ].map((run) => {
        try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
        return '';
      }),
    ];
    for (const message of messages) {
      expect(message).not.toContain('fake-cookie');
      expect(message).not.toContain('fake-token');
    }
  });

  it('prints a plan without credentials and applies dry-run and typed confirmation rules', () => {
    const cookie = 'session=obviously-fake-cookie';
    const token = 'obviously-fake-login-token';
    const target = parseTargetOptions({
      TARGET_URL: 'https://team-a.gettabula.app',
      TARGET_COOKIES: cookie,
      TARGET_LOGIN_TOKENS: token,
    });
    const plan = targetPlanText(target, [3, 5], 5);
    expect(plan).toContain('Host: team-a.gettabula.app');
    expect(plan).toContain('Accounts: 2');
    expect(plan).toContain('personal boards');
    expect(plan).toContain('reuse the supplied accounts round-robin');
    expect(plan).not.toContain(cookie);
    expect(plan).not.toContain(token);
    expect(targetRunDecision(target)).toEqual({
      run: false,
      exitCode: 2,
      reason: 'confirmation',
      confirmationLine: 'TARGET_CONFIRM=team-a.gettabula.app',
    });

    const confirmed = parseTargetOptions({ TARGET_URL: 'https://team-a.gettabula.app', TARGET_COOKIES: cookie, TARGET_CONFIRM: 'team-a.gettabula.app' });
    expect(targetRunDecision(confirmed)).toEqual({ run: true, exitCode: 0, reason: 'confirmed' });
    const dryRun = parseTargetOptions({ TARGET_URL: 'https://team-a.gettabula.app', TARGET_COOKIES: cookie, TARGET_DRY_RUN: '1' });
    expect(targetRunDecision(dryRun)).toEqual({ run: false, exitCode: 0, reason: 'dry-run' });
  });

  it('redacts supplied credentials from arbitrary error text', () => {
    const cookie = 'session=obviously-fake-cookie';
    const token = 'obviously-fake-login-token';
    expect(redactTargetSecrets(`failed with ${cookie} and ${token}`, [cookie, token])).toBe('failed with [REDACTED] and [REDACTED]');
  });

  it('assigns simulated users round-robin', () => {
    const accounts = ['owner', 'member-a'];
    expect(assignAccountsToUsers(accounts, 5)).toEqual(['owner', 'member-a', 'owner', 'member-a', 'owner']);
    expect(assignAccountsToUsers(accounts, 2)).toEqual(['owner', 'member-a']);
  });
});
