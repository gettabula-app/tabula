import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { createMailer } from '../server/mailer.mjs';

type Mail = { to: string; subject: string; text: string };
type Ctx = ReturnType<typeof setup>;

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OWNER = 'owner@example.com';

const opened: { close(): void }[] = [];
const tmpDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of opened.splice(0)) d.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ MIRA_AUTH: 'on', MIRA_OWNER_EMAIL: OWNER, PORT: '8787', ...env });
  const d = openDirectory(':memory:');
  opened.push(d);
  const sent: Mail[] = [];
  const mailer = {
    send: async (m: Mail) => {
      sent.push(m);
    },
  };
  const clock = { t: T0 };
  const auth = createAuth({ directory: d, config, mailer, now: () => clock.t });
  return { d, auth, sent, config, clock };
}

const tokenIn = (m: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(m.text)![1]);
const lastToken = (c: Ctx) => tokenIn(c.sent[c.sent.length - 1]);

async function signIn(c: Ctx, email: string, invite?: string) {
  const before = c.sent.length;
  await c.auth.requestLogin({ email, invite, ip: '1.1.1.1' });
  expect(c.sent.length).toBe(before + 1);
  return c.auth.verifyLogin(lastToken(c))!;
}

const cookie = (c: Ctx, token: string) => `${c.config.cookieName}=${token}`;

function team(c: Ctx, name = 'Crew') {
  const owner = c.d.getUserByEmail(OWNER)!;
  return { owner, team: c.d.createTeam({ name, creatorId: owner.id })! };
}

describe('requestLogin', () => {
  it('mails the owner address while there is no owner, with a fragment link', async () => {
    const c = setup();
    expect(await c.auth.requestLogin({ email: ' Owner@Example.COM ', ip: '1.1.1.1' })).toEqual({ ok: true });
    expect(c.sent).toHaveLength(1);
    const [mail] = c.sent;
    expect(mail.to).toBe(OWNER);
    expect(mail.subject).toBe('Your Mira sign-in link');
    expect(mail.text).toContain('http://localhost:8787/#/signin/verify?token=');
    expect(tokenIn(mail)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mail.text).toContain('expires in 15 minutes');
    expect(mail.text).toContain('If you did not ask for it, you can ignore this email');
    expect(c.d.countOwners()).toBe(0);
  });

  it('answers identically for known and unknown addresses and mails only the allowed ones', async () => {
    const c = setup();
    c.d.createUser({ email: 'known@example.com', role: 'member' });
    c.d.createUser({ email: 'off@example.com', role: 'member' });
    c.d.updateUser(c.d.getUserByEmail('off@example.com')!.id, { disabled: true });

    const known = await c.auth.requestLogin({ email: 'Known@Example.com', ip: '1.1.1.1' });
    const unknown = await c.auth.requestLogin({ email: 'stranger@example.com', ip: '1.1.1.1' });
    const disabled = await c.auth.requestLogin({ email: 'off@example.com', ip: '1.1.1.1' });
    expect(known).toStrictEqual({ ok: true });
    expect(unknown).toStrictEqual(known);
    expect(disabled).toStrictEqual(known);
    expect(c.sent.map((m) => m.to)).toEqual(['known@example.com']);
  });

  it('ignores malformed addresses without mailing, counting or throwing', async () => {
    const c = setup();
    const malformed = ['', 'nope', 'a b@example.com', 'a@b@c', 'a@x.com,b@y.com', 'x'.repeat(300) + '@example.com', undefined, null, 42, { a: 1 }];
    for (let round = 0; round < 3; round++) {
      for (const email of malformed) {
        expect(await c.auth.requestLogin({ email: email as string, ip: '9.9.9.9' })).toEqual({ ok: true });
      }
    }
    expect(c.sent).toHaveLength(0);
    for (let i = 0; i < 5; i++) {
      expect(await c.auth.requestLogin({ email: OWNER, ip: '9.9.9.9' })).toEqual({ ok: true });
    }
    expect(c.sent).toHaveLength(5);
  });

  it('only bootstraps the owner address while no owner exists', async () => {
    const c = setup();
    c.d.createUser({ email: 'first@example.com', role: 'owner' });
    expect(await c.auth.requestLogin({ email: OWNER, ip: '1.1.1.1' })).toEqual({ ok: true });
    expect(c.sent).toHaveLength(0);

    const forged = c.d.createLoginToken({ email: OWNER, ttlMs: 15 * MIN, now: T0 });
    expect(c.auth.verifyLogin(forged)).toBeNull();
    expect(c.d.getUserByEmail(OWNER)).toBeNull();
  });

  it('never mails when the owner address is not configured', async () => {
    const c = setup();
    await c.auth.requestLogin({ email: 'someone@example.com', ip: '1.1.1.1' });
    expect(c.sent).toHaveLength(0);
  });

  it('uses the configured base URL and token lifetime in the mail', async () => {
    const c = setup({ MIRA_BASE_URL: 'https://mira.example.com/' });
    await c.auth.requestLogin({ email: OWNER, ip: '1.1.1.1' });
    expect(c.sent[0].text).toContain('https://mira.example.com/#/signin/verify?token=');
    expect(c.sent[0].text).not.toContain('com//');
  });

  it('does not let a mail failure, sync or async, show through', async () => {
    const config = loadConfig({ MIRA_AUTH: 'on', MIRA_OWNER_EMAIL: OWNER });
    const d = openDirectory(':memory:');
    opened.push(d);
    d.createUser({ email: 'known@example.com', role: 'member' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failing = createAuth({ directory: d, config, mailer: { send: () => Promise.reject(new Error('smtp down')) }, now: () => T0 });
    const throwing = createAuth({
      directory: d,
      config,
      mailer: {
        send: () => {
          throw new Error('bad config');
        },
      },
      now: () => T0,
    });

    expect(await failing.requestLogin({ email: 'known@example.com', ip: '1.1.1.1' })).toEqual({ ok: true });
    expect(await failing.requestLogin({ email: 'unknown@example.com', ip: '1.1.1.1' })).toEqual({ ok: true });
    expect(await throwing.requestLogin({ email: 'known@example.com', ip: '1.1.1.2' })).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveBeenCalledTimes(2);
  });
});

describe('verifyLogin', () => {
  it('signs the owner in as owner, creating the user and a session', async () => {
    const c = setup();
    const result = await signIn(c, OWNER);
    expect(result.user).toMatchObject({ email: OWNER, role: 'owner', disabled: false });
    expect(result.maxAgeMs).toBe(30 * DAY);
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.d.countOwners()).toBe(1);

    const authed = c.auth.authenticate(cookie(c, result.sessionToken))!;
    expect(authed.user.id).toBe(result.user.id);
  });

  it('lets a token be used exactly once', async () => {
    const c = setup();
    await c.auth.requestLogin({ email: OWNER, ip: '1.1.1.1' });
    const token = lastToken(c);
    expect(c.auth.verifyLogin(token)).not.toBeNull();
    expect(c.auth.verifyLogin(token)).toBeNull();
    expect(c.d.listUsers()).toHaveLength(1);
  });

  it('expires tokens after 15 minutes', async () => {
    const c = setup();
    await c.auth.requestLogin({ email: OWNER, ip: '1.1.1.1' });
    const token = lastToken(c);
    c.clock.t = T0 + 15 * MIN;
    expect(c.auth.verifyLogin(token)).toBeNull();
    expect(c.d.listUsers()).toHaveLength(0);

    await c.auth.requestLogin({ email: OWNER, ip: '1.1.1.1' });
    c.clock.t = T0 + 15 * MIN + 14 * MIN;
    expect(c.auth.verifyLogin(lastToken(c))).not.toBeNull();
  });

  it('rejects garbage and tokens of other kinds', async () => {
    const c = setup();
    await signIn(c, OWNER);
    const { team: crew, owner } = team(c);
    const invite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: DAY, now: T0 });
    const session = c.d.createSession(owner.id, { ttlMs: DAY, now: T0 });
    for (const bad of ['', 'nope', 'x'.repeat(1000), invite.token, session.token, undefined, null, 7]) {
      expect(c.auth.verifyLogin(bad as string)).toBeNull();
    }
  });

  it('refuses a disabled user even with a token requested earlier', async () => {
    const c = setup();
    const owner = await signIn(c, OWNER);
    const member = c.d.createUser({ email: 'm@example.com', role: 'member' })!;
    await c.auth.requestLogin({ email: 'm@example.com', ip: '1.1.1.1' });
    c.d.updateUser(member.id, { disabled: true });
    expect(c.auth.verifyLogin(lastToken(c))).toBeNull();
    expect(owner.user.role).toBe('owner');
    expect(c.d.listUsers().filter((u) => u.disabled)).toHaveLength(1);
  });

  it('is all or nothing: a failure after consuming the token leaves it usable', async () => {
    const c = setup();
    await c.auth.requestLogin({ email: OWNER, ip: '1.1.1.1' });
    const token = lastToken(c);
    const broken = createAuth({
      directory: {
        ...c.d,
        createSession: () => {
          throw new Error('disk full');
        },
      },
      config: c.config,
      mailer: { send: async () => undefined },
      now: () => c.clock.t,
    });
    expect(() => broken.verifyLogin(token)).toThrow('disk full');
    expect(c.d.listUsers()).toHaveLength(0);
    expect(c.auth.verifyLogin(token)).not.toBeNull();
    expect(c.d.listUsers()).toHaveLength(1);
  });

  it('does not create a user for an address that was never allowed', () => {
    const c = setup();
    const token = c.d.createLoginToken({ email: 'stranger@example.com', ttlMs: 15 * MIN, now: T0 });
    expect(c.auth.verifyLogin(token)).toBeNull();
    expect(c.d.getUserByEmail('stranger@example.com')).toBeNull();
  });
});

describe('invites', () => {
  async function invited() {
    const c = setup();
    await signIn(c, OWNER);
    return { c, ...team(c) };
  }

  it('let a new person sign in and join the team with the invite role', async () => {
    const { c, team: crew, owner } = await invited();
    const invite = c.d.createInvite({ teamId: crew.id, role: 'admin', createdBy: owner.id, ttlMs: DAY, now: T0 });
    const result = await signIn(c, 'new@example.com', invite.token);
    expect(result.user).toMatchObject({ email: 'new@example.com', role: 'member' });
    expect(c.d.getTeamRole(crew.id, result.user.id)).toBe('admin');
    expect(c.d.findInvite(invite.token, T0)).toMatchObject({ uses: 1 });
    expect(c.auth.authenticate(cookie(c, result.sessionToken))).not.toBeNull();
  });

  it('send no mail for a new address without a usable invite', async () => {
    const { c, team: crew, owner } = await invited();
    const sentBefore = c.sent.length;
    const base = { teamId: crew.id, role: 'member' as const, createdBy: owner.id, now: T0 };
    const revoked = c.d.createInvite({ ...base, ttlMs: DAY });
    c.d.revokeInvite(revoked.id);
    const expired = c.d.createInvite({ ...base, ttlMs: MIN });
    const usedUp = c.d.createInvite({ ...base, ttlMs: DAY, maxUses: 1 });
    c.d.recordInviteUse(usedUp.id);
    c.clock.t = T0 + 2 * MIN;

    let ip = 0;
    for (const invite of [revoked.token, expired.token, usedUp.token, 'garbage', '', undefined, c.d.createSession(owner.id, { ttlMs: DAY, now: T0 }).token]) {
      const res = await c.auth.requestLogin({ email: `new${ip}@example.com`, invite, ip: `10.0.0.${ip++}` });
      expect(res).toEqual({ ok: true });
    }
    expect(c.sent).toHaveLength(sentBefore);
  });

  it('send no mail for a disabled user, invite or not', async () => {
    const { c, team: crew, owner } = await invited();
    const person = c.d.createUser({ email: 'p@example.com', role: 'member' })!;
    c.d.updateUser(person.id, { disabled: true });
    const invite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: DAY, now: T0 });
    const before = c.sent.length;
    await c.auth.requestLogin({ email: 'p@example.com', invite: invite.token, ip: '1.1.1.1' });
    expect(c.sent).toHaveLength(before);
  });

  it('add an existing user to the team and keep their workspace role', async () => {
    const { c, team: crew, owner } = await invited();
    const admin = c.d.createUser({ email: 'adm@example.com', role: 'admin' })!;
    const invite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: DAY, now: T0 });
    const result = await signIn(c, 'adm@example.com', invite.token);
    expect(result.user).toMatchObject({ id: admin.id, role: 'admin' });
    expect(c.d.getTeamRole(crew.id, admin.id)).toBe('member');
  });

  it('never downgrade a team admin, and upgrade a member through an admin invite', async () => {
    const { c, team: crew, owner } = await invited();
    const member = c.d.createUser({ email: 'm@example.com', role: 'member' })!;
    c.d.addTeamMember(crew.id, member.id, 'member');
    const memberInvite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: DAY, now: T0 });
    const adminInvite = c.d.createInvite({ teamId: crew.id, role: 'admin', createdBy: owner.id, ttlMs: DAY, now: T0 });

    await signIn(c, OWNER, memberInvite.token);
    expect(c.d.getTeamRole(crew.id, owner.id)).toBe('admin');

    await signIn(c, 'm@example.com', adminInvite.token);
    expect(c.d.getTeamRole(crew.id, member.id)).toBe('admin');
  });

  it('stop working at verify time when revoked after the request', async () => {
    const { c, team: crew, owner } = await invited();
    const invite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: DAY, now: T0 });
    const existing = c.d.createUser({ email: 'old@example.com', role: 'member' })!;
    await c.auth.requestLogin({ email: 'new@example.com', invite: invite.token, ip: '1.1.1.1' });
    const newToken = lastToken(c);
    await c.auth.requestLogin({ email: 'old@example.com', invite: invite.token, ip: '1.1.1.2' });
    const oldToken = lastToken(c);

    c.d.revokeInvite(invite.id);

    expect(c.auth.verifyLogin(newToken)).toBeNull();
    expect(c.d.getUserByEmail('new@example.com')).toBeNull();

    const result = c.auth.verifyLogin(oldToken)!;
    expect(result.user.id).toBe(existing.id);
    expect(c.d.getTeamRole(crew.id, existing.id)).toBeNull();
    expect(c.d.listInvites(crew.id, T0)).toEqual([]);
  });

  it('stop working at verify time when expired after the request', async () => {
    const { c, team: crew, owner } = await invited();
    const invite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: 5 * MIN, now: T0 });
    const existing = c.d.createUser({ email: 'old@example.com', role: 'member' })!;
    await c.auth.requestLogin({ email: 'new@example.com', invite: invite.token, ip: '1.1.1.1' });
    const newToken = lastToken(c);
    await c.auth.requestLogin({ email: 'old@example.com', invite: invite.token, ip: '1.1.1.2' });
    const oldToken = lastToken(c);

    c.clock.t = T0 + 10 * MIN;

    expect(c.auth.verifyLogin(newToken)).toBeNull();
    expect(c.d.getUserByEmail('new@example.com')).toBeNull();
    expect(c.auth.verifyLogin(oldToken)).not.toBeNull();
    expect(c.d.getTeamRole(crew.id, existing.id)).toBeNull();
  });

  it('stop working at verify time when used up after the request', async () => {
    const { c, team: crew, owner } = await invited();
    const invite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: DAY, maxUses: 1, now: T0 });
    await c.auth.requestLogin({ email: 'first@example.com', invite: invite.token, ip: '1.1.1.1' });
    const firstToken = lastToken(c);
    await c.auth.requestLogin({ email: 'second@example.com', invite: invite.token, ip: '1.1.1.2' });
    const secondToken = lastToken(c);

    const first = c.auth.verifyLogin(firstToken)!;
    expect(c.d.getTeamRole(crew.id, first.user.id)).toBe('member');
    expect(c.auth.verifyLogin(secondToken)).toBeNull();
    expect(c.d.getUserByEmail('second@example.com')).toBeNull();
    expect(c.d.findInvite(invite.token, T0)).toBeNull();
    expect(c.d.listTeamMembers(crew.id).map((m) => m.email).sort()).toEqual(['first@example.com', OWNER]);
  });

  it('count one use per sign-in and never past the maximum', async () => {
    const { c, team: crew, owner } = await invited();
    const invite = c.d.createInvite({ teamId: crew.id, role: 'member', createdBy: owner.id, ttlMs: DAY, maxUses: 2, now: T0 });
    await signIn(c, 'a@example.com', invite.token);
    expect(c.d.findInvite(invite.token, T0)).toMatchObject({ uses: 1 });
    await signIn(c, 'b@example.com', invite.token);
    expect(c.d.findInvite(invite.token, T0)).toBeNull();
    await c.auth.requestLogin({ email: 'c@example.com', invite: invite.token, ip: '1.1.1.1' });
    expect(c.d.getUserByEmail('c@example.com')).toBeNull();
  });
});

describe('rate limits', () => {
  it('allow five requests per email per hour, known or not', async () => {
    const c = setup();
    c.d.createUser({ email: 'known@example.com', role: 'member' });
    for (const email of ['known@example.com', 'unknown@example.com']) {
      for (let i = 0; i < 5; i++) {
        expect(await c.auth.requestLogin({ email, ip: `10.0.${email.length}.${i}` })).toEqual({ ok: true });
      }
      expect(await c.auth.requestLogin({ email, ip: '10.9.9.9' })).toEqual({ limited: true });
    }
    expect(await c.auth.requestLogin({ email: 'other@example.com', ip: '10.9.9.9' })).toEqual({ ok: true });
    expect(c.sent).toHaveLength(5);
  });

  it('is case-insensitive about the address', async () => {
    const c = setup();
    for (let i = 0; i < 5; i++) await c.auth.requestLogin({ email: `Same@Example.com${' '.repeat(i)}`, ip: `10.0.0.${i}` });
    expect(await c.auth.requestLogin({ email: 'same@example.com', ip: '10.0.0.9' })).toEqual({ limited: true });
  });

  it('allows twenty requests per IP per hour', async () => {
    const c = setup();
    for (let i = 0; i < 20; i++) {
      expect(await c.auth.requestLogin({ email: `u${i}@example.com`, ip: '2.2.2.2' })).toEqual({ ok: true });
    }
    expect(await c.auth.requestLogin({ email: 'u21@example.com', ip: '2.2.2.2' })).toEqual({ limited: true });
    expect(await c.auth.requestLogin({ email: 'u21@example.com', ip: '3.3.3.3' })).toEqual({ ok: true });
  });

  it('shares one bucket between requests without an IP', async () => {
    const c = setup();
    for (let i = 0; i < 20; i++) await c.auth.requestLogin({ email: `u${i}@example.com` });
    expect(await c.auth.requestLogin({ email: 'late@example.com', ip: undefined })).toEqual({ limited: true });
  });

  it('use a rolling hour and reset after it', async () => {
    const c = setup();
    const ask = () => c.auth.requestLogin({ email: 'a@example.com', ip: '1.1.1.1' });
    for (let i = 0; i < 3; i++) await ask();
    c.clock.t = T0 + 40 * MIN;
    await ask();
    await ask();
    c.clock.t = T0 + 50 * MIN;
    expect(await ask()).toEqual({ limited: true });
    expect(await ask()).toEqual({ limited: true });

    c.clock.t = T0 + HOUR - 1;
    expect(await ask()).toEqual({ limited: true });
    c.clock.t = T0 + HOUR;
    expect(await ask()).toEqual({ ok: true });
    expect(await ask()).toEqual({ ok: true });
    expect(await ask()).toEqual({ ok: true });
    expect(await ask()).toEqual({ limited: true });

    c.clock.t = T0 + 3 * HOUR;
    expect(await ask()).toEqual({ ok: true });
  });

  it('does not extend the window with rejected requests', async () => {
    const c = setup();
    const ask = () => c.auth.requestLogin({ email: 'a@example.com', ip: '1.1.1.1' });
    for (let i = 0; i < 5; i++) await ask();
    for (let m = 1; m < 60; m += 5) {
      c.clock.t = T0 + m * MIN;
      expect(await ask()).toEqual({ limited: true });
    }
    c.clock.t = T0 + HOUR + 1;
    expect(await ask()).toEqual({ ok: true });
  });

  it('does not count a limited email against the IP', async () => {
    const c = setup();
    for (let i = 0; i < 5; i++) await c.auth.requestLogin({ email: 'a@example.com', ip: '1.1.1.1' });
    for (let i = 0; i < 30; i++) await c.auth.requestLogin({ email: 'a@example.com', ip: '1.1.1.1' });
    expect(await c.auth.requestLogin({ email: 'b@example.com', ip: '1.1.1.1' })).toEqual({ ok: true });
  });
});

describe('authenticate', () => {
  async function signedIn(env: Record<string, string> = {}) {
    const c = setup(env);
    const result = await signIn(c, OWNER);
    return { c, result, header: cookie(c, result.sessionToken) };
  }

  it('accepts the session cookie among other cookies', async () => {
    const { c, result, header } = await signedIn();
    const authed = c.auth.authenticate(`theme=dark; ${header}; other=1`)!;
    expect(authed.user.id).toBe(result.user.id);
    expect(typeof authed.sessionId).toBe('string');
    expect(authed.expiresAt).toBe(T0 + 30 * DAY);
    expect(authed.setCookie).toBeUndefined();
  });

  it('rejects missing, empty, garbage and foreign cookies', async () => {
    const { c, result } = await signedIn();
    const name = c.config.cookieName;
    for (const header of [
      undefined,
      '',
      ';',
      '=',
      name,
      `${name}=`,
      `${name}=garbage`,
      `${name}=${'x'.repeat(5000)}`,
      `other=${result.sessionToken}`,
      `${name}x=${result.sessionToken}`,
      `x${name}=${result.sessionToken}`,
      `__Host-mira_session=${result.sessionToken}`,
      result.sessionToken,
    ]) {
      expect(c.auth.authenticate(header)).toBeNull();
    }
    expect(c.auth.authenticate(123 as unknown as string)).toBeNull();
  });

  it('skips an invalid duplicate cookie and takes the valid one', async () => {
    const { c, result, header } = await signedIn();
    expect(c.auth.authenticate(`${c.config.cookieName}=junk; ${header}`)?.user.id).toBe(result.user.id);
  });

  it('rejects revoked sessions, logged-out sessions and disabled users', async () => {
    const { c, result, header } = await signedIn();
    const second = await signIn(c, OWNER);
    const authed = c.auth.authenticate(header)!;

    c.auth.logout(authed.sessionId);
    expect(c.auth.authenticate(header)).toBeNull();
    expect(c.auth.authenticate(cookie(c, second.sessionToken))).not.toBeNull();

    const member = c.d.createUser({ email: 'm@example.com', role: 'member' })!;
    const memberSession = c.d.createSession(member.id, { ttlMs: DAY, now: T0 });
    c.d.updateUser(member.id, { disabled: true });
    expect(c.auth.authenticate(cookie(c, memberSession.token))).toBeNull();
    expect(result.user.role).toBe('owner');
  });

  it('expires sessions and slides them with a fresh cookie', async () => {
    const { c, header } = await signedIn({ MIRA_SESSION_DAYS: '10' });
    c.clock.t = T0 + 4 * DAY;
    expect(c.auth.authenticate(header)!.setCookie).toBeUndefined();

    c.clock.t = T0 + 6 * DAY;
    const slid = c.auth.authenticate(header)!;
    expect(slid.expiresAt).toBe(T0 + 16 * DAY);
    expect(slid.setCookie).toBe(`${header}; Max-Age=${10 * 86400}; Path=/; HttpOnly; SameSite=Lax`);

    c.clock.t = T0 + 15 * DAY;
    expect(c.auth.authenticate(header)!.expiresAt).toBe(T0 + 25 * DAY);
    c.clock.t = T0 + 25 * DAY;
    expect(c.auth.authenticate(header)).toBeNull();
  });
});

describe('logout', () => {
  it('logout ends one session, logoutAll ends them all and counts', async () => {
    const c = setup();
    const a = await signIn(c, OWNER);
    const b = await signIn(c, OWNER);
    const third = await signIn(c, OWNER);
    const other = c.d.createUser({ email: 'o@example.com', role: 'member' })!;
    const otherSession = c.d.createSession(other.id, { ttlMs: DAY, now: T0 });

    c.auth.logout(c.auth.authenticate(cookie(c, a.sessionToken))!.sessionId);
    expect(c.auth.authenticate(cookie(c, a.sessionToken))).toBeNull();
    expect(c.auth.authenticate(cookie(c, b.sessionToken))).not.toBeNull();

    expect(c.auth.logoutAll(a.user.id)).toBe(2);
    expect(c.auth.logoutAll(a.user.id)).toBe(0);
    expect(c.auth.authenticate(cookie(c, b.sessionToken))).toBeNull();
    expect(c.auth.authenticate(cookie(c, third.sessionToken))).toBeNull();
    expect(c.auth.authenticate(cookie(c, otherSession.token))).not.toBeNull();
  });
});

describe('cookies', () => {
  const token = 'abc_DEF-123';

  it('are host-only, HttpOnly and SameSite=Lax over http', () => {
    const c = setup();
    expect(c.config.cookieName).toBe('mira_session');
    expect(c.auth.sessionCookie(token, 30 * DAY)).toBe(`mira_session=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`);
    expect(c.auth.sessionCookie(token, 1999)).toContain('Max-Age=1;');
    expect(c.auth.sessionCookie(token, -5)).toContain('Max-Age=0;');
    expect(c.auth.clearCookie()).toBe('mira_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax');
    expect(c.auth.sessionCookie(token, DAY)).not.toMatch(/Domain|Secure/i);
  });

  it('are __Host- prefixed and Secure over https, still without a Domain', () => {
    const c = setup({ MIRA_BASE_URL: 'https://mira.example.com' });
    expect(c.config.cookieName).toBe('__Host-mira_session');
    expect(c.auth.sessionCookie(token, 30 * DAY)).toBe(`__Host-mira_session=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure`);
    expect(c.auth.clearCookie()).toBe('__Host-mira_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax; Secure');
    expect(c.auth.sessionCookie(token, DAY)).not.toMatch(/Domain/i);
  });

  it('are read under the right name for each scheme', async () => {
    const https = setup({ MIRA_BASE_URL: 'https://mira.example.com' });
    const result = await signIn(https, OWNER);
    expect(https.auth.authenticate(`__Host-mira_session=${result.sessionToken}`)).not.toBeNull();
    expect(https.auth.authenticate(`mira_session=${result.sessionToken}`)).toBeNull();
  });

  it('refuse a token that could smuggle attributes or headers', () => {
    const c = setup();
    for (const bad of ['a; Domain=evil.com', 'a\r\nSet-Cookie: x=1', 'a b', '', 'a=b', 'é']) {
      expect(() => c.auth.sessionCookie(bad, DAY)).toThrow('invalid session token');
    }
  });
});

describe('csrfOk', () => {
  const { auth } = setup();
  const req = (method: string, headers: Record<string, string | undefined> = {}) => ({ method, headers });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'head'])('always allows %s', (method) => {
    expect(auth.csrfOk(req(method))).toBe(true);
    expect(auth.csrfOk(req(method, { origin: 'https://evil.example', host: 'mira.example.com' }))).toBe(true);
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE', 'post', 'TRACE', 'PROPFIND'])('needs the header on %s', (method) => {
    expect(auth.csrfOk(req(method))).toBe(false);
    expect(auth.csrfOk(req(method, { host: 'mira.example.com' }))).toBe(false);
    expect(auth.csrfOk(req(method, { 'x-mira': '0', host: 'mira.example.com' }))).toBe(false);
    expect(auth.csrfOk(req(method, { 'x-mira': 'true' }))).toBe(false);
    expect(auth.csrfOk(req(method, { 'x-mira': '' }))).toBe(false);
  });

  it('accepts a request with the header and no Origin (not a browser)', () => {
    expect(auth.csrfOk(req('POST', { 'x-mira': '1' }))).toBe(true);
    expect(auth.csrfOk(req('POST', { 'x-mira': '1', host: 'mira.example.com' }))).toBe(true);
  });

  const originCases: [string, string, boolean][] = [
    ['https://mira.example.com', 'mira.example.com', true],
    ['http://mira.example.com', 'mira.example.com', true],
    ['https://MIRA.example.com', 'mira.example.com', true],
    ['http://localhost:8787', 'localhost:8787', true],
    ['https://evil.example', 'mira.example.com', false],
    ['https://mira.example.com.evil.example', 'mira.example.com', false],
    ['https://evil.example/mira.example.com', 'mira.example.com', false],
    ['https://sub.mira.example.com', 'mira.example.com', false],
    ['http://localhost:9999', 'localhost:8787', false],
    ['http://localhost', 'localhost:8787', false],
    ['null', 'mira.example.com', false],
    ['not a url', 'mira.example.com', false],
    ['', 'mira.example.com', false],
    ['file:///etc/passwd', 'mira.example.com', false],
    ['https://mira.example.com', '', false],
  ];

  it.each(originCases)('compares Origin %s with Host %s -> %s', (origin, host, expected) => {
    expect(auth.csrfOk(req('POST', { 'x-mira': '1', origin, host }))).toBe(expected);
  });

  it('rejects an Origin when the Host header is missing', () => {
    expect(auth.csrfOk(req('DELETE', { 'x-mira': '1', origin: 'https://mira.example.com' }))).toBe(false);
  });

  it('treats a missing method as unsafe', () => {
    expect(auth.csrfOk({ headers: {} } as never)).toBe(false);
  });
});

describe('loadConfig', () => {
  it('has sensible defaults', () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual({
      authEnabled: false,
      ownerEmail: null,
      baseUrl: 'http://localhost:8787',
      origin: 'http://localhost:8787',
      secureCookies: false,
      cookieName: 'mira_session',
      sessionMs: 30 * DAY,
      loginTokenMs: 15 * MIN,
      dataDir: path.resolve(import.meta.dirname, '..', 'data'),
      port: 8787,
      mail: { mode: 'log', webhookUrl: null, from: 'Mira <no-reply@localhost>' },
    });
  });

  it('turns accounts on only for the exact value "on"', () => {
    for (const value of ['off', 'true', '1', 'ON', '']) {
      expect(loadConfig({ MIRA_AUTH: value }).authEnabled).toBe(false);
    }
    expect(loadConfig({ MIRA_AUTH: 'on', MIRA_OWNER_EMAIL: OWNER }).authEnabled).toBe(true);
  });

  it('requires a valid owner email when accounts are on, and lower-cases it', () => {
    expect(() => loadConfig({ MIRA_AUTH: 'on' })).toThrow('MIRA_OWNER_EMAIL is required');
    expect(() => loadConfig({ MIRA_AUTH: 'on', MIRA_OWNER_EMAIL: '  ' })).toThrow('MIRA_OWNER_EMAIL is required');
    expect(() => loadConfig({ MIRA_AUTH: 'on', MIRA_OWNER_EMAIL: 'not-an-email' })).toThrow('not a valid email');
    expect(() => loadConfig({ MIRA_OWNER_EMAIL: 'a b@c.d' })).toThrow('not a valid email');
    expect(loadConfig({ MIRA_AUTH: 'on', MIRA_OWNER_EMAIL: '  Boss@Example.COM ' }).ownerEmail).toBe('boss@example.com');
    expect(loadConfig({ MIRA_OWNER_EMAIL: 'Boss@Example.COM' }).ownerEmail).toBe('boss@example.com');
  });

  it('derives the base URL, origin and cookie settings', () => {
    expect(loadConfig({ PORT: '9000' })).toMatchObject({ port: 9000, baseUrl: 'http://localhost:9000', origin: 'http://localhost:9000' });
    expect(loadConfig({ PORT: 'junk' }).port).toBe(8787);

    const http1 = loadConfig({ MIRA_BASE_URL: 'http://mira.lan:8080//' });
    expect(http1).toMatchObject({ baseUrl: 'http://mira.lan:8080', origin: 'http://mira.lan:8080', secureCookies: false, cookieName: 'mira_session' });

    const https1 = loadConfig({ MIRA_BASE_URL: ' https://Mira.Example.com:8443/app/ ' });
    expect(https1).toMatchObject({
      baseUrl: 'https://Mira.Example.com:8443/app',
      origin: 'https://mira.example.com:8443',
      secureCookies: true,
      cookieName: '__Host-mira_session',
    });

    expect(() => loadConfig({ MIRA_BASE_URL: 'not a url' })).toThrow('not a valid URL');
    expect(() => loadConfig({ MIRA_BASE_URL: 'ftp://mira.example.com' })).toThrow('http:// or https://');
    expect(() => loadConfig({ MIRA_BASE_URL: 'javascript:alert(1)' })).toThrow('http:// or https://');
  });

  it('reads the session lifetime, data dir and mail settings', () => {
    expect(loadConfig({ MIRA_SESSION_DAYS: '7' }).sessionMs).toBe(7 * DAY);
    for (const value of ['0', '-3', 'abc', '', 'Infinity']) {
      expect(loadConfig({ MIRA_SESSION_DAYS: value }).sessionMs).toBe(30 * DAY);
    }
    expect(loadConfig({ DATA_DIR: '/var/lib/mira' }).dataDir).toBe(path.resolve('/var/lib/mira'));

    expect(loadConfig({ MIRA_MAIL: 'file', MIRA_MAIL_FROM: 'Me <me@x.io>' }).mail).toEqual({ mode: 'file', webhookUrl: null, from: 'Me <me@x.io>' });
    expect(loadConfig({ MIRA_MAIL: 'webhook', MIRA_MAIL_WEBHOOK_URL: 'https://hooks.example.com/mail' }).mail).toMatchObject({
      mode: 'webhook',
      webhookUrl: 'https://hooks.example.com/mail',
    });
    expect(() => loadConfig({ MIRA_MAIL: 'smtp' })).toThrow('MIRA_MAIL must be one of');
    expect(() => loadConfig({ MIRA_MAIL: 'webhook' })).toThrow('MIRA_MAIL_WEBHOOK_URL is required');
  });
});

describe('mailer', () => {
  const msg = { to: 'a@example.com', subject: 'Hello', text: 'Line one\nLine two' };
  const configFor = (mail: Record<string, unknown>, dataDir = os.tmpdir()) => ({ dataDir, mail: { mode: 'log', webhookUrl: null, from: 'Mira <no-reply@localhost>', ...mail } });

  it('logs a block to stdout in log mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createMailer(configFor({ mode: 'log' })).send(msg);
    expect(log).toHaveBeenCalledTimes(1);
    const out = String(log.mock.calls[0][0]);
    expect(out).toContain('a@example.com');
    expect(out).toContain('Hello');
    expect(out).toContain('Line one\nLine two');
  });

  it('appends JSON lines to outbox.jsonl in file mode, creating the directory', async () => {
    const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mira-mail-')), 'nested', 'data');
    tmpDirs.push(path.dirname(path.dirname(dataDir)));
    const mailer = createMailer(configFor({ mode: 'file', from: 'Mira <m@x.io>' }, dataDir));
    await mailer.send(msg);
    await mailer.send({ ...msg, to: 'b@example.com' });

    const lines = fs.readFileSync(path.join(dataDir, 'outbox.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({ ...msg, from: 'Mira <m@x.io>', ts: expect.any(Number) });
    expect(JSON.parse(lines[1]).to).toBe('b@example.com');
  });

  async function hook(status: number) {
    const received: { method?: string; type?: string; body: unknown }[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        received.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(raw) });
        res.statusCode = status;
        res.end('{}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mail` };
  }

  it('POSTs the message as JSON in webhook mode', async () => {
    const { received, url } = await hook(200);
    await createMailer(configFor({ mode: 'webhook', webhookUrl: url, from: 'Mira <m@x.io>' })).send(msg);
    expect(received).toEqual([{ method: 'POST', type: 'application/json', body: { ...msg, from: 'Mira <m@x.io>' } }]);
  });

  it('throws when the webhook answers with an error status', async () => {
    const { received, url } = await hook(500);
    await expect(createMailer(configFor({ mode: 'webhook', webhookUrl: url })).send(msg)).rejects.toThrow('500');
    expect(received).toHaveLength(1);
  });

  it('throws when the webhook is unreachable or unconfigured', async () => {
    const { url } = await hook(200);
    const dead = url.replace(/:\d+/, ':1');
    await expect(createMailer(configFor({ mode: 'webhook', webhookUrl: dead })).send(msg)).rejects.toThrow('fetch failed');
    await expect(createMailer(configFor({ mode: 'webhook', webhookUrl: null })).send(msg)).rejects.toThrow('not configured');
  });

  it('refuses an unknown mode', async () => {
    await expect(createMailer(configFor({ mode: 'pigeon' })).send(msg)).rejects.toThrow('unknown mail mode');
  });
});
