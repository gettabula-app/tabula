import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createApi } from '../server/api.mjs';
import { SeatLimitError, createAuth } from '../server/auth.mjs';
import { CloudError, addsSeat, createCloud, validateLimits, validateNotify } from '../server/cloud.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';

// docs/cloud.md. Everything here runs in-process: the control plane is a fake fetch and the timers are fake.

type Dir = ReturnType<typeof openDirectory>;
type Role = 'owner' | 'admin' | 'member' | 'guest';
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Mail = { to: string; text: string; subject?: string; template?: string; params?: Record<string, unknown> };

const OWNER = 'owner@example.com';
const TOKEN = 'k'.repeat(40);
const CLOUD_ENV = {
  TABULA_CLOUD_TOKEN: TOKEN,
  TABULA_CLOUD_URL: 'https://cloud.example.com/',
  TABULA_CLOUD_WORKSPACE_ID: 'ws_123',
};
const AUTH_ENV = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: OWNER };
const PORTAL = 'https://billing.example.com/session/abc';
const DATE = '7 Nov 2026';

const opened: Dir[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of opened.splice(0)) d.close();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A scheduler the test drives by hand, so nothing waits for real time. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number): any => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      pending.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && pending.delete(id)) t.fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(env: Record<string, string> = {}, fetchImpl?: Fetch) {
  const config = loadConfig({ PORT: '8787', ...AUTH_ENV, ...CLOUD_ENV, ...env });
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const events = new EventEmitter();
  const timers = fakeTimers();
  const fetchFn = vi.fn<Fetch>(fetchImpl ?? (async () => new Response(null, { status: 204 })));
  const logs: string[] = [];
  const cloud = createCloud({
    config: config.cloud,
    directory,
    events,
    fetch: fetchFn,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    log: (message: string) => logs.push(message),
  });
  return { config, directory, events, timers, fetchFn, logs, cloud };
}

const seed = (d: Dir, email: string, role: Role, disabled = false) => {
  const user = d.createUser({ email, role })!;
  return (disabled ? d.updateUser(user.id, { disabled: true }) : user)!;
};

describe('configuration', () => {
  it('has no cloud settings when none of the variables is set', () => {
    expect(loadConfig({ ...AUTH_ENV }).cloud).toBeUndefined();
    expect(loadConfig({ ...AUTH_ENV, TABULA_CLOUD_TOKEN: '  ', TABULA_CLOUD_URL: '' }).cloud).toBeUndefined();
    expect(loadConfig({}).cloud).toBeUndefined();
  });

  it('turns cloud mode on when all three are set in accounts mode, dropping trailing slashes and padding', () => {
    expect(loadConfig({ ...AUTH_ENV, ...CLOUD_ENV }).cloud).toEqual({
      token: TOKEN,
      url: 'https://cloud.example.com',
      workspaceId: 'ws_123',
    });
    const padded = loadConfig({
      ...AUTH_ENV,
      TABULA_CLOUD_TOKEN: ` ${TOKEN} `,
      TABULA_CLOUD_URL: ' https://cloud.example.com/api/// ',
      TABULA_CLOUD_WORKSPACE_ID: ' ws-1 ',
    });
    expect(padded.cloud).toEqual({ token: TOKEN, url: 'https://cloud.example.com/api', workspaceId: 'ws-1' });
  });

  it.each([
    ['TABULA_CLOUD_TOKEN'],
    ['TABULA_CLOUD_URL'],
    ['TABULA_CLOUD_WORKSPACE_ID'],
  ])('refuses to start without %s when the others are set', (missing) => {
    const env: Record<string, string> = { ...AUTH_ENV, ...CLOUD_ENV };
    delete env[missing];
    expect(() => loadConfig(env)).toThrow(new RegExp(`must be set together \\(missing ${missing}\\)`));
  });

  it('names every missing variable', () => {
    expect(() => loadConfig({ ...AUTH_ENV, TABULA_CLOUD_URL: 'https://cloud.example.com' })).toThrow(
      'missing TABULA_CLOUD_TOKEN, TABULA_CLOUD_WORKSPACE_ID',
    );
  });

  it('requires a token of at least 32 characters without spaces', () => {
    const withToken = (TABULA_CLOUD_TOKEN: string) => loadConfig({ ...AUTH_ENV, ...CLOUD_ENV, TABULA_CLOUD_TOKEN });
    expect(() => withToken('k'.repeat(31))).toThrow('TABULA_CLOUD_TOKEN must be at least 32 characters');
    expect(() => withToken(`${'k'.repeat(20)} ${'k'.repeat(20)}`)).toThrow('TABULA_CLOUD_TOKEN');
    expect(withToken('k'.repeat(32)).cloud?.token).toBe('k'.repeat(32));
  });

  it.each([
    ['https://cloud.example.com'],
    ['http://localhost:8080'],
    ['http://127.0.0.1:9000/'],
    ['http://[::1]:9000'],
  ])('accepts %s as the control plane URL', (TABULA_CLOUD_URL) => {
    expect(loadConfig({ ...AUTH_ENV, ...CLOUD_ENV, TABULA_CLOUD_URL }).cloud?.url).toBe(TABULA_CLOUD_URL.replace(/\/$/, ''));
  });

  it.each([
    ['http://cloud.example.com'],
    ['http://10.0.0.5:8080'],
    ['ftp://cloud.example.com'],
    ['cloud.example.com'],
    ['https://user:pass@cloud.example.com'],
    ['https://cloud.example.com/?a=1'],
    ['https://cloud.example.com/#x'],
  ])('refuses %s as the control plane URL', (TABULA_CLOUD_URL) => {
    expect(() => loadConfig({ ...AUTH_ENV, ...CLOUD_ENV, TABULA_CLOUD_URL })).toThrow('TABULA_CLOUD_URL');
  });

  it.each([['has space'], ['a/b'], ['x'.repeat(129)], ['é']])('refuses %j as the workspace id', (TABULA_CLOUD_WORKSPACE_ID) => {
    expect(() => loadConfig({ ...AUTH_ENV, ...CLOUD_ENV, TABULA_CLOUD_WORKSPACE_ID })).toThrow('TABULA_CLOUD_WORKSPACE_ID');
  });

  it('stays off without accounts mode, but still refuses a half-set or malformed configuration', () => {
    expect(loadConfig({ ...CLOUD_ENV }).cloud).toBeUndefined();
    expect(() => loadConfig({ TABULA_CLOUD_TOKEN: TOKEN })).toThrow('must be set together');
    expect(() => loadConfig({ ...CLOUD_ENV, TABULA_CLOUD_TOKEN: 'short' })).toThrow('TABULA_CLOUD_TOKEN');
  });
});

describe('validateLimits', () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['a seat limit', { seatLimit: 5 }, { seatLimit: 5 }],
    ['the smallest seat limit', { seatLimit: 1 }, { seatLimit: 1 }],
    ['the largest seat limit', { seatLimit: 100000 }, { seatLimit: 100000 }],
    ['no seat limit', { seatLimit: null }, { seatLimit: null }],
    ['read-only on', { readOnly: true }, { readOnly: true }],
    ['read-only off', { readOnly: false }, { readOnly: false }],
    ['a banner', { banner: ' Payment failed ' }, { banner: 'Payment failed' }],
    ['a banner of 300 characters', { banner: 'b'.repeat(300) }, { banner: 'b'.repeat(300) }],
    ['no banner', { banner: null }, { banner: null }],
    ['a blank banner as no banner', { banner: '   ' }, { banner: null }],
    ['all three at once', { seatLimit: 3, readOnly: true, banner: 'Pay up' }, { seatLimit: 3, readOnly: true, banner: 'Pay up' }],
  ])('accepts %s', (_name, body, patch) => {
    expect(validateLimits(body)).toEqual({ patch });
  });

  it.each<[string, unknown, string]>([
    ['an empty body', {}, 'Nothing to change'],
    ['an array', [], 'JSON object'],
    ['a string', 'x', 'JSON object'],
    ['null', null, 'JSON object'],
    ['an unknown field', { seatLimit: 3, plan: 'pro' }, 'Unknown field: plan'],
    ['a prototype key', JSON.parse('{"__proto__": {"readOnly": true}}'), 'Unknown field: __proto__'],
    ['a seat limit of 0', { seatLimit: 0 }, 'seatLimit'],
    ['a negative seat limit', { seatLimit: -1 }, 'seatLimit'],
    ['a seat limit above 100000', { seatLimit: 100001 }, 'seatLimit'],
    ['a fractional seat limit', { seatLimit: 2.5 }, 'seatLimit'],
    ['a string seat limit', { seatLimit: '3' }, 'seatLimit'],
    ['an infinite seat limit', { seatLimit: Infinity }, 'seatLimit'],
    ['a string readOnly', { readOnly: 'true' }, 'readOnly'],
    ['a null readOnly', { readOnly: null }, 'readOnly'],
    ['a numeric banner', { banner: 5 }, 'banner'],
    ['a banner of 301 characters', { banner: 'b'.repeat(301) }, 'banner'],
    ['a banner with a newline', { banner: 'two\nlines' }, 'single line'],
    ['a banner with a tab', { banner: 'a\tb' }, 'single line'],
    ['a banner with a line separator', { banner: 'a b' }, 'single line'],
  ])('refuses %s', (_name, body, message) => {
    const result = validateLimits(body);
    expect(result).toEqual({ error: expect.stringContaining(message) });
  });
});

describe('validateNotify', () => {
  it.each<[string, string]>([
    ['a one digit day', '7 Nov 2026'],
    ['a two digit day', '31 Dec 2026'],
    ['a day with a leading zero', '07 Jan 2027'],
  ])('accepts %s', (_name, date) => {
    expect(validateNotify({ template: 'trial-ending', date })).toEqual({ notice: { template: 'trial-ending', date } });
  });

  it.each<[string, unknown, string]>([
    ['an array', [], 'JSON object'],
    ['a string', 'x', 'JSON object'],
    ['null', null, 'JSON object'],
    ['an empty object', {}, 'template'],
    ['a missing date', { template: 'trial-ending' }, 'date'],
    ['a missing template', { date: '7 Nov 2026' }, 'template'],
    ['an unknown template', { template: 'welcome', date: '7 Nov 2026' }, 'template must be one of trial-ending'],
    ['a template in another case', { template: 'Trial-Ending', date: '7 Nov 2026' }, 'template'],
    ['a template with padding', { template: 'trial-ending ', date: '7 Nov 2026' }, 'template'],
    ['a numeric template', { template: 1, date: '7 Nov 2026' }, 'template'],
    ['a null template', { template: null, date: '7 Nov 2026' }, 'template'],
    ['an inherited property as the template', { template: 'constructor', date: '7 Nov 2026' }, 'template'],
    ['another inherited property as the template', { template: '__proto__', date: '7 Nov 2026' }, 'template'],
    ['an unknown field', { template: 'trial-ending', date: '7 Nov 2026', to: 'a@example.com' }, 'Unknown field: to'],
    ['a prototype key', JSON.parse('{"__proto__": {"template": "trial-ending"}, "template": "trial-ending", "date": "7 Nov 2026"}'), 'Unknown field: __proto__'],
    ['an ISO date', { template: 'trial-ending', date: '2026-11-07' }, 'date'],
    ['a long month name', { template: 'trial-ending', date: '7 November 2026' }, 'date'],
    ['a lower case month', { template: 'trial-ending', date: '7 nov 2026' }, 'date'],
    ['a two digit year', { template: 'trial-ending', date: '7 Nov 26' }, 'date'],
    ['a three digit day', { template: 'trial-ending', date: '107 Nov 2026' }, 'date'],
    ['padding', { template: 'trial-ending', date: ' 7 Nov 2026' }, 'date'],
    ['a trailing newline', { template: 'trial-ending', date: '7 Nov 2026\n' }, 'date'],
    ['two spaces', { template: 'trial-ending', date: '7  Nov 2026' }, 'date'],
    ['non-ASCII digits', { template: 'trial-ending', date: '٧ Nov 2026' }, 'date'],
    ['a number', { template: 'trial-ending', date: 20261107 }, 'date'],
    ['null', { template: 'trial-ending', date: null }, 'date'],
    ['a date of 41 characters', { template: 'trial-ending', date: `7 Nov 2026${' '.repeat(30)}` }, 'date'],
    ['a long text', { template: 'trial-ending', date: 'x'.repeat(5000) }, 'date'],
  ])('refuses %s', (_name, body, message) => {
    expect(validateNotify(body)).toEqual({ error: expect.stringContaining(message) });
  });
});

describe('addsSeat', () => {
  const user = (role: Role, disabled = false) => ({ role, disabled });
  it.each<[string, ReturnType<typeof user>, Record<string, unknown>, boolean]>([
    ['guest to member', user('guest'), { role: 'member' }, true],
    ['guest to admin', user('guest'), { role: 'admin' }, true],
    ['guest to owner', user('guest'), { role: 'owner' }, true],
    ['guest to guest', user('guest'), { role: 'guest' }, false],
    ['member to admin', user('member'), { role: 'admin' }, false],
    ['member to guest', user('member'), { role: 'guest' }, false],
    ['disabled member enabled', user('member', true), { disabled: false }, true],
    ['disabled guest enabled', user('guest', true), { disabled: false }, false],
    ['disabled guest enabled as member', user('guest', true), { disabled: false, role: 'member' }, true],
    ['disabled member made admin but kept disabled', user('member', true), { role: 'admin' }, false],
    ['member disabled', user('member'), { disabled: true }, false],
    ['nothing changes', user('member'), {}, false],
  ])('%s', (_name, before, patch, expected) => {
    expect(addsSeat(before, patch)).toBe(expected);
  });
});

describe('directory support', () => {
  it('counts seats, guests and members, leaving disabled people out of the first two', () => {
    const { directory } = setup();
    expect(directory.seatUsage()).toEqual({ seats: 0, guests: 0, members: 0 });
    seed(directory, OWNER, 'owner');
    seed(directory, 'admin@example.com', 'admin');
    seed(directory, 'm1@example.com', 'member');
    seed(directory, 'm2@example.com', 'member', true);
    seed(directory, 'g1@example.com', 'guest');
    seed(directory, 'g2@example.com', 'guest');
    seed(directory, 'g3@example.com', 'guest', true);
    expect(directory.seatUsage()).toEqual({ seats: 3, guests: 2, members: 7 });
  });

  it('keeps settings', () => {
    const { directory } = setup();
    expect(directory.getSetting('a')).toBeNull();
    directory.setSetting('a', 'one');
    directory.setSetting('a', 'two');
    directory.setSetting('b', 'x');
    expect(directory.getSetting('a')).toBe('two');
    expect(directory.getSetting('b')).toBe('x');
  });
});

describe('createCloud', () => {
  it('is null without cloud settings', () => {
    const c = setup({ TABULA_CLOUD_TOKEN: '', TABULA_CLOUD_URL: '', TABULA_CLOUD_WORKSPACE_ID: '' });
    expect(c.cloud).toBeNull();
  });

  it.each<[string, string | undefined, boolean]>([
    ['the token', `Bearer ${TOKEN}`, true],
    ['any case of the scheme', `bearer ${TOKEN}`, true],
    ['no header', undefined, false],
    ['an empty header', '', false],
    ['the bare token', TOKEN, false],
    ['a Basic header', `Basic ${TOKEN}`, false],
    ['a wrong token of the same length', `Bearer ${'x'.repeat(40)}`, false],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, 39)}`, false],
    ['the token with more appended', `Bearer ${TOKEN}x`, false],
    ['two tokens', `Bearer ${TOKEN} ${TOKEN}`, false],
    ['an empty token', 'Bearer ', false],
  ])('checks the bearer token: %s', (_name, header, ok) => {
    expect(setup().cloud!.tokenOk(header)).toBe(ok);
  });

  it('starts without limits', () => {
    const c = setup();
    expect(c.cloud!.limits()).toEqual({ seatLimit: null, readOnly: false, banner: null, billing: true });
    expect(c.cloud!.seatsAvailable()).toBe(true);
  });

  it('merges updates, keeps them across restarts, writes an audit row without an actor and emits an event', () => {
    const c = setup();
    seed(c.directory, OWNER, 'owner');
    const changed = vi.fn<(limits: unknown) => void>();
    c.events.on('limits-changed', changed);

    expect(c.cloud!.setLimits({ seatLimit: 3, banner: 'Hello' })).toEqual({ seatLimit: 3, readOnly: false, banner: 'Hello', billing: true });
    expect(c.cloud!.setLimits({ readOnly: true })).toEqual({ seatLimit: 3, readOnly: true, banner: 'Hello', billing: true });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith({ seatLimit: 3, readOnly: true, banner: 'Hello', billing: true });

    const [latest, first] = c.directory.listAudit(2);
    expect(latest).toMatchObject({ actorId: null, action: 'cloud.limits', detail: { seatLimit: 3, readOnly: true, banner: 'Hello' } });
    expect(first).toMatchObject({ actorId: null, action: 'cloud.limits', detail: { seatLimit: 3, readOnly: false } });

    const again = createCloud({ config: c.config.cloud, directory: c.directory, events: new EventEmitter() });
    expect(again!.limits()).toEqual({ seatLimit: 3, readOnly: true, banner: 'Hello', billing: true });
    expect(again!.setLimits({ seatLimit: null, banner: null })).toEqual({ seatLimit: null, readOnly: true, banner: null, billing: true });
  });

  it('takes billing as a boolean, defaults it to true, and keeps it across restarts and old stored limits (TAB-226)', () => {
    const c = setup();
    expect(c.cloud!.limits().billing).toBe(true);
    expect(c.cloud!.setLimits({ billing: false })).toMatchObject({ billing: false });
    expect(c.cloud!.workspaceView()).toMatchObject({ billing: false });
    const again = createCloud({ config: c.config.cloud, directory: c.directory, events: new EventEmitter() });
    expect(again!.limits().billing).toBe(false);
    // limits stored before the field existed read as billing on
    c.directory.setSetting('cloud.limits', JSON.stringify({ seatLimit: 5, readOnly: false, banner: null }));
    expect(createCloud({ config: c.config.cloud, directory: c.directory, events: new EventEmitter() })!.limits()).toEqual({ seatLimit: 5, readOnly: false, banner: null, billing: true });
    expect(validateLimits({ billing: false })).toEqual({ patch: { billing: false } });
    for (const bad of ['no', 0, null, 'false']) expect(validateLimits({ billing: bad })).toEqual({ error: 'billing must be a boolean' });
  });

  it('falls back to no limits when the stored value is damaged', () => {
    const c = setup();
    for (const value of ['{not json', '[1]', '"x"', '{"seatLimit": 0}', '{"plan": 1}']) {
      c.directory.setSetting('cloud.limits', value);
      const again = createCloud({ config: c.config.cloud, directory: c.directory, events: new EventEmitter() });
      expect(again!.limits()).toEqual({ seatLimit: null, readOnly: false, banner: null, billing: true });
    }
  });

  it('does not change anything when persisting fails', () => {
    const c = setup();
    vi.spyOn(c.directory, 'setSetting').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => c.cloud!.setLimits({ readOnly: true })).toThrow('disk full');
    expect(c.cloud!.limits().readOnly).toBe(false);
    expect(c.directory.listAudit()).toEqual([]);
  });

  it('reports a free seat while usage is below the limit', () => {
    const c = setup();
    seed(c.directory, OWNER, 'owner');
    seed(c.directory, 'm@example.com', 'member');
    seed(c.directory, 'g@example.com', 'guest');
    c.cloud!.setLimits({ seatLimit: 3 });
    expect(c.cloud!.seatsAvailable()).toBe(true);
    seed(c.directory, 'm2@example.com', 'member');
    expect(c.cloud!.seatsAvailable()).toBe(false);
    c.cloud!.setLimits({ seatLimit: 4 });
    expect(c.cloud!.seatsAvailable()).toBe(true);
    c.cloud!.setLimits({ seatLimit: null });
    seed(c.directory, 'm3@example.com', 'member');
    seed(c.directory, 'm4@example.com', 'member');
    expect(c.cloud!.seatsAvailable()).toBe(true);
  });

  describe('portal', () => {
    it('asks the control plane with the bearer token and returns the https URL', async () => {
      const c = setup({}, async () => json({ url: PORTAL }));
      expect(await c.cloud!.portalUrl()).toBe(PORTAL);
      expect(c.fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = c.fetchFn.mock.calls[0];
      expect(url).toBe('https://cloud.example.com/v1/workspaces/ws_123/portal');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(init.redirect).toBe('error');
      expect(c.timers.size).toBe(0);
    });

    it.each<[string, () => Promise<Response>]>([
      ['an http URL', async () => json({ url: 'http://billing.example.com/x' })],
      ['a javascript URL', async () => json({ url: 'javascript:alert(1)' })],
      ['a relative URL', async () => json({ url: '/portal' })],
      ['no URL', async () => json({})],
      ['a numeric URL', async () => json({ url: 5 })],
      ['a body that is not JSON', async () => new Response('<html>', { status: 200 })],
      ['an error status', async () => json({ url: PORTAL }, 500)],
      ['an unauthorised status', async () => json({ error: 'nope' }, 401)],
      ['a network failure', async () => Promise.reject(new TypeError('fetch failed'))],
    ])('refuses %s without leaking details', async (_name, reply) => {
      const c = setup({}, reply);
      const failure = await c.cloud!.portalUrl().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(CloudError);
      expect((failure as Error).message).toBe('Billing is not available right now. Try again in a minute.');
      expect(c.logs.join('\n')).not.toContain(TOKEN);
    });

    it('gives up after 10 seconds', async () => {
      const c = setup({}, (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
      const pending = c.cloud!.portalUrl();
      const outcome = pending.catch((e: unknown) => e);
      c.timers.advance(9_999);
      await settle();
      expect(c.fetchFn.mock.calls[0][1].signal!.aborted).toBe(false);
      c.timers.advance(1);
      expect(await outcome).toBeInstanceOf(CloudError);
      expect(c.logs).toEqual(['cloud: portal request failed: timed out']);
    });
  });

  describe('usage push', () => {
    const changed = (c: ReturnType<typeof setup>) => c.events.emit('usage-changed');

    it('sends the counts once, 30 seconds after the last change', async () => {
      const c = setup();
      seed(c.directory, OWNER, 'owner');
      seed(c.directory, 'm@example.com', 'member');
      seed(c.directory, 'g@example.com', 'guest');
      changed(c);
      c.timers.advance(20_000);
      changed(c);
      c.timers.advance(29_999);
      expect(c.fetchFn).not.toHaveBeenCalled();
      c.timers.advance(1);
      expect(c.fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = c.fetchFn.mock.calls[0];
      expect(url).toBe('https://cloud.example.com/v1/workspaces/ws_123/usage');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
      expect(JSON.parse(init.body as string)).toEqual({ seats: 2, guests: 1 });
      await settle();
      expect(c.logs).toEqual([]);
      expect(c.timers.size).toBe(0);
    });

    it('reads the counts when the timer fires, not when the change happened', () => {
      const c = setup();
      seed(c.directory, OWNER, 'owner');
      changed(c);
      seed(c.directory, 'late@example.com', 'member');
      c.timers.advance(30_000);
      expect(JSON.parse(c.fetchFn.mock.calls[0][1].body as string)).toEqual({ seats: 2, guests: 0 });
    });

    it('pushes again only when the counts differ from the last successful push', async () => {
      const c = setup();
      seed(c.directory, OWNER, 'owner');
      changed(c);
      c.timers.advance(30_000);
      await settle();
      expect(c.fetchFn).toHaveBeenCalledTimes(1);

      changed(c);
      c.timers.advance(30_000);
      await settle();
      expect(c.fetchFn).toHaveBeenCalledTimes(1);

      seed(c.directory, 'g@example.com', 'guest');
      changed(c);
      c.timers.advance(30_000);
      await settle();
      expect(c.fetchFn).toHaveBeenCalledTimes(2);
      expect(JSON.parse(c.fetchFn.mock.calls[1][1].body as string)).toEqual({ seats: 1, guests: 1 });
    });

    it('includes an explicitly set update value and re-pushes when only that value changes', async () => {
      const c = setup();
      seed(c.directory, OWNER, 'owner');
      c.directory.setSetting('updates.auto', '0');
      changed(c);
      c.timers.advance(30_000);
      await settle();
      expect(JSON.parse(c.fetchFn.mock.calls[0][1].body as string)).toEqual({ seats: 1, guests: 0, autoUpgrade: false });

      c.directory.setSetting('updates.auto', '1');
      changed(c);
      c.timers.advance(30_000);
      await settle();
      expect(c.fetchFn).toHaveBeenCalledTimes(2);
      expect(JSON.parse(c.fetchFn.mock.calls[1][1].body as string)).toEqual({ seats: 1, guests: 0, autoUpgrade: true });
    });

    it('logs a failure, never throws, and tries again at the next change', async () => {
      let healthy = false;
      const c = setup({}, async () => (healthy ? new Response(null, { status: 204 }) : Promise.reject(new TypeError('fetch failed'))));
      seed(c.directory, OWNER, 'owner');
      changed(c);
      expect(() => c.timers.advance(30_000)).not.toThrow();
      await settle();
      expect(c.logs).toEqual(['cloud: could not push usage: fetch failed']);

      healthy = true;
      changed(c);
      c.timers.advance(30_000);
      await settle();
      expect(c.fetchFn).toHaveBeenCalledTimes(2);
      expect(c.logs).toHaveLength(1);
    });

    it('logs an error status without the token or the body', async () => {
      const c = setup({}, async () => new Response(`secret ${TOKEN}`, { status: 503 }));
      changed(c);
      c.timers.advance(30_000);
      await settle();
      expect(c.logs).toEqual(['cloud: could not push usage: answered 503']);
    });

    it('also gives up after 10 seconds', async () => {
      const c = setup({}, (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
      changed(c);
      c.timers.advance(30_000);
      c.timers.advance(10_000);
      await settle();
      expect(c.logs).toEqual(['cloud: could not push usage: timed out']);
    });

    it('stops listening once closed', () => {
      const c = setup();
      c.cloud!.close();
      changed(c);
      expect(c.timers.size).toBe(0);
    });

    it('uses the real timers by default, so vitest fake timers drive it too', async () => {
      vi.useFakeTimers();
      const directory = openDirectory(':memory:');
      opened.push(directory);
      const events = new EventEmitter();
      const fetchFn = vi.fn<Fetch>(async () => new Response(null, { status: 204 }));
      createCloud({ config: loadConfig({ ...AUTH_ENV, ...CLOUD_ENV }).cloud, directory, events, fetch: fetchFn });
      events.emit('usage-changed');
      events.emit('usage-changed');
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('automatic update sync at boot', () => {
    it('does not push the default, and re-pushes an explicit value after five seconds', async () => {
      const c = setup();
      c.timers.advance(5_000);
      expect(c.fetchFn).not.toHaveBeenCalled();

      c.cloud!.close();
      c.directory.setSetting('updates.auto', '0');
      const fetchFn = vi.fn<Fetch>(async (_url, init) => {
        const { autoUpgrade } = JSON.parse(init.body as string) as { autoUpgrade: boolean };
        return json({ autoUpgrade, securityAlwaysApplied: true });
      });
      const cloud = createCloud({
        config: c.config.cloud,
        directory: c.directory,
        events: c.events,
        fetch: fetchFn,
        setTimeout: c.timers.setTimeout,
        clearTimeout: c.timers.clearTimeout,
      });
      c.timers.advance(4_999);
      expect(fetchFn).not.toHaveBeenCalled();
      c.timers.advance(1);
      await settle();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[0][0]).toBe('https://cloud.example.com/v1/workspaces/ws_123/settings');
      expect(JSON.parse(fetchFn.mock.calls[0][1].body as string)).toEqual({ autoUpgrade: false });
      expect(cloud!.updates()).toEqual({ auto: false, synced: true, securityAlwaysApplied: true });
      cloud!.close();
    });

    it('cancels the boot re-push when closed', () => {
      const c = setup();
      c.cloud!.close();
      c.directory.setSetting('updates.auto', '1');
      const fetchFn = vi.fn<Fetch>(async () => json({ autoUpgrade: true, securityAlwaysApplied: true }));
      const cloud = createCloud({
        config: c.config.cloud,
        directory: c.directory,
        events: c.events,
        fetch: fetchFn,
        setTimeout: c.timers.setTimeout,
        clearTimeout: c.timers.clearTimeout,
      });
      cloud!.close();
      c.timers.advance(5_000);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});

describe('sign-in with a seat limit', () => {
  function withInvite(seatsAvailable: () => boolean) {
    const c = setup();
    const config = loadConfig({ PORT: '8787', ...AUTH_ENV });
    const sent: Mail[] = [];
    const auth = createAuth({ directory: c.directory, config, mailer: { send: async (m: Mail) => void sent.push(m) }, seatsAvailable });
    const owner = seed(c.directory, OWNER, 'owner');
    const team = c.directory.createTeam({ name: 'Crew', creatorId: owner.id })!;
    const invite = c.directory.createInvite({ teamId: team.id, role: 'member', createdBy: owner.id, ttlMs: 86_400_000 });
    return { ...c, auth, sent, owner, team, invite };
  }

  const tokenOf = (m: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(m.text)![1]);

  it('fails without creating the person and without using the login link or the invite, then works once a seat is free', async () => {
    let free = false;
    const c = withInvite(() => free);
    await c.auth.requestLogin({ email: 'new@example.com', invite: c.invite.token, ip: '1.1.1.1' });
    expect(c.sent).toHaveLength(1);
    const token = tokenOf(c.sent[0]);

    expect(() => c.auth.verifyLogin(token)).toThrow(SeatLimitError);
    expect(c.directory.getUserByEmail('new@example.com')).toBeNull();
    expect(c.directory.listInvites(c.team.id)[0].uses).toBe(0);
    expect(c.directory.getTeamRole(c.team.id, 'nobody')).toBeNull();

    free = true;
    const result = c.auth.verifyLogin(token)!;
    expect(result.user.email).toBe('new@example.com');
    expect(c.directory.getTeamRole(c.team.id, result.user.id)).toBe('member');
    expect(c.directory.listInvites(c.team.id)[0].uses).toBe(1);
  });

  it('still sends the link, so a full workspace is not revealed by the sign-in request', async () => {
    const c = withInvite(() => false);
    const known = await c.auth.requestLogin({ email: OWNER, ip: '1.1.1.1' });
    const stranger = await c.auth.requestLogin({ email: 'stranger@example.com', ip: '1.1.1.1' });
    const invited = await c.auth.requestLogin({ email: 'new@example.com', invite: c.invite.token, ip: '1.1.1.1' });
    expect(stranger).toEqual(known);
    expect(invited).toEqual(known);
    expect(c.sent.map((m) => m.to)).toEqual([OWNER, 'new@example.com']);
  });

  it('lets people who already have an account sign in, and lets the owner be created', async () => {
    const c = withInvite(() => false);
    seed(c.directory, 'old@example.com', 'member');
    await c.auth.requestLogin({ email: 'old@example.com', invite: c.invite.token, ip: '1.1.1.1' });
    const result = c.auth.verifyLogin(tokenOf(c.sent[0]))!;
    expect(result.user.email).toBe('old@example.com');
    expect(c.directory.getTeamRole(c.team.id, result.user.id)).toBe('member');

    const fresh = setup();
    const auth = createAuth({
      directory: fresh.directory,
      config: loadConfig({ PORT: '8787', ...AUTH_ENV }),
      mailer: { send: async (m: Mail) => void c.sent.push(m) },
      seatsAvailable: () => false,
    });
    await auth.requestLogin({ email: OWNER, ip: '1.1.1.1' });
    expect(auth.verifyLogin(tokenOf(c.sent[c.sent.length - 1]))!.user.role).toBe('owner');
  });
});

describe('API in cloud mode', () => {
  type Res = { status: number; body: any; headers: Headers };
  type Opts = { method?: string; cookie?: string; token?: string | null; body?: unknown; headers?: Record<string, string> };

  function directApi(c: ReturnType<typeof setup>) {
    const mailer = { send: async () => {} };
    const auth = createAuth({ directory: c.directory, config: c.config, mailer, seatsAvailable: c.cloud?.seatsAvailable });
    const api = createApi({ directory: c.directory, auth, config: c.config, roomExists: () => false, events: c.events, cloud: c.cloud as never, mailer });
    const login = (userId: string) => `${c.config.cookieName}=${c.directory.createSession(userId, { ttlMs: 3_600_000 }).token}`;
    const person = (email: string, role: Role) => {
      const user = seed(c.directory, email, role);
      return { user, cookie: login(user.id) };
    };
    async function call(path: string, opts: Opts = {}): Promise<Res> {
      const { method = 'GET', cookie, token, body, headers = {} } = opts;
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as Readable & { url: string; method: string; headers: Record<string, string> };
      req.url = path;
      req.method = method;
      req.headers = {
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === 'GET' ? {} : { 'x-tabula': '1' }),
        ...headers,
      };
      const response = {
        headersSent: false,
        status: 0,
        body: '',
        values: new Map<string, string>(),
        setHeader(name: string, value: string) { this.values.set(name.toLowerCase(), value); },
        writeHead(status: number, more?: Record<string, string>) {
          this.status = status;
          this.headersSent = true;
          for (const [name, value] of Object.entries(more ?? {})) this.values.set(name.toLowerCase(), value);
        },
        end(text?: string) { this.body = text ?? ''; },
      };
      await api.handle(req as never, response as never);
      return { status: response.status, body: response.body ? JSON.parse(response.body) : undefined, headers: new Headers(Object.fromEntries(response.values)) };
    }
    return { call, person };
  }

  const tokenOf = (m: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(m.text)![1]);

  async function serve(env: Record<string, string> = {}, fetchImpl?: Fetch) {
    const c = setup(env, fetchImpl);
    const sent: Mail[] = [];
    // Addresses the fake mailer fails for: `reject` answers with a rejected promise, `throw` throws before it returns one.
    const failing = new Map<string, 'reject' | 'throw'>();
    const gate: { open: Promise<void> | null } = { open: null };
    const mailer = {
      async send(m: Mail) {
        await gate.open;
        const how = failing.get(m.to);
        if (how === 'throw') throw new Error(`mailer broke for <${m.to}>`);
        if (how === 'reject') throw new Error(`550 5.1.1 <${m.to}> rejected`);
        sent.push(m);
      },
    };
    const auth = createAuth({ directory: c.directory, config: c.config, mailer, seatsAvailable: c.cloud?.seatsAvailable });
    const api = createApi({ directory: c.directory, auth, config: c.config, roomExists: () => false, events: c.events, cloud: c.cloud as never, mailer });
    const server = http.createServer((req, res) => {
      void api.handle(req, res).then((handled: boolean) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    async function call(path: string, opts: Opts = {}): Promise<Res> {
      const { method = 'GET', cookie, token, body, headers = {} } = opts;
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(method === 'GET' ? {} : { 'x-tabula': '1' }),
          ...(cookie ? { cookie } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
    }

    const login = (userId: string) => `${c.config.cookieName}=${c.directory.createSession(userId, { ttlMs: 3_600_000 }).token}`;
    const person = (email: string, role: Role, disabled = false) => {
      const user = seed(c.directory, email, role, disabled);
      return { user, cookie: login(user.id) };
    };
    const put = (body: unknown) => call('/api/internal/limits', { method: 'PUT', token: TOKEN, body });
    const patchMember = (cookie: string, id: string, body: unknown) => call(`/api/members/${id}`, { method: 'PATCH', cookie, body });

    // The full email flow: ask for a link (optionally with an invite), then use it.
    async function signIn(email: string, invite?: string) {
      const before = sent.length;
      const asked = await call('/api/auth/request', { method: 'POST', body: { email, invite } });
      const mail = sent[before];
      const token = mail ? tokenOf(mail) : '';
      const verified = await call('/api/auth/verify', { method: 'POST', body: { token } });
      return { asked, verified, token, mails: sent.length - before };
    }

    function invitation(owner: { id: string }) {
      const team = c.directory.createTeam({ name: 'Crew', creatorId: owner.id })!;
      const invite = c.directory.createInvite({ teamId: team.id, role: 'member', createdBy: owner.id, ttlMs: 86_400_000 });
      return { team, invite };
    }

    const notify = (body: unknown = { template: 'trial-ending', date: DATE }, token: string | null = TOKEN) =>
      call('/api/internal/notify', { method: 'POST', token, body });
    const notices = () => sent.filter((m) => m.template === 'trial-ending');

    return { ...c, base, call, person, put, patchMember, signIn, invitation, sent, failing, gate, notify, notices };
  }

  describe('internal endpoints', () => {
    it('answer 404 together with the billing portal when cloud mode is off', async () => {
      const s = await serve({ TABULA_CLOUD_TOKEN: '', TABULA_CLOUD_URL: '', TABULA_CLOUD_WORKSPACE_ID: '' });
      const owner = s.person(OWNER, 'owner');
      expect((await s.call('/api/internal/usage', { token: TOKEN })).status).toBe(404);
      expect((await s.call('/api/internal/limits', { method: 'PUT', token: TOKEN, body: { readOnly: true } })).status).toBe(404);
      expect((await s.call('/api/billing/portal', { method: 'POST', cookie: owner.cookie })).status).toBe(404);
      expect((await s.notify()).status).toBe(404);
      expect((await s.call('/api/admin/updates', { cookie: owner.cookie })).status).toBe(404);
      expect((await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: false } })).status).toBe(404);
      expect(s.sent).toEqual([]);
      expect((await s.call('/api/me', { cookie: owner.cookie })).body).not.toHaveProperty('workspace');
    });

    it('need the exact bearer token, and refuse cookies, other schemes and every wrong token', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const bad: Record<string, string>[] = [
        {},
        { authorization: `Bearer ${'z'.repeat(40)}` },
        { authorization: 'Bearer abc' },
        { authorization: `Basic ${TOKEN}` },
        { authorization: TOKEN },
        { cookie: owner.cookie },
        { cookie: owner.cookie, 'x-tabula': '1' },
      ];
      for (const headers of bad) {
        const usage = await s.call('/api/internal/usage', { headers });
        expect(usage.status).toBe(401);
        expect(usage.body).toMatchObject({ error: 'unauthenticated' });
        expect(usage.headers.get('www-authenticate')).toBe('Bearer');
        expect((await s.call('/api/internal/limits', { method: 'PUT', headers, body: { readOnly: true } })).status).toBe(401);
        expect((await s.call('/api/internal/notify', { method: 'POST', headers, body: { template: 'trial-ending', date: DATE } })).status).toBe(401);
      }
      expect(s.cloud!.limits().readOnly).toBe(false);
      expect(s.directory.listAudit()).toEqual([]);
      expect(s.directory.getSetting('cloud.trialEndingNotified')).toBeNull();
      expect(s.sent).toEqual([]);
    });

    it('take the right token with no cookie and no CSRF header, and ignore a cookie that comes along', async () => {
      const s = await serve();
      const usage = await fetch(`${s.base}/api/internal/usage`, {
        headers: { authorization: `Bearer ${TOKEN}`, cookie: 'tabula_session=junk' },
      });
      expect(usage.status).toBe(200);
      const limits = await fetch(`${s.base}/api/internal/limits`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ seatLimit: 9 }),
      });
      expect(limits.status).toBe(200);
      expect(s.cloud!.limits().seatLimit).toBe(9);
    });

    it('report seats, guests and members', async () => {
      const s = await serve();
      expect((await s.call('/api/internal/usage', { token: TOKEN })).body).toEqual({ seats: 0, guests: 0, members: 0, updates: { auto: true } });
      seed(s.directory, OWNER, 'owner');
      seed(s.directory, 'a@example.com', 'admin');
      seed(s.directory, 'm@example.com', 'member');
      seed(s.directory, 'off@example.com', 'member', true);
      seed(s.directory, 'g@example.com', 'guest');
      seed(s.directory, 'goff@example.com', 'guest', true);
      expect((await s.call('/api/internal/usage', { token: TOKEN })).body).toEqual({ seats: 3, guests: 1, members: 6, updates: { auto: true } });
    });

    it('only allow GET on usage and PUT on limits', async () => {
      const s = await serve();
      expect((await s.call('/api/internal/usage', { method: 'POST', token: TOKEN, body: {} })).status).toBe(405);
      expect((await s.call('/api/internal/limits', { method: 'GET', token: TOKEN })).status).toBe(405);
      expect((await s.call('/api/internal/notify', { method: 'GET', token: TOKEN })).status).toBe(405);
      expect((await s.call('/api/internal/notify', { method: 'PUT', token: TOKEN, body: {} })).status).toBe(405);
      expect((await s.call('/api/internal/nothing', { token: TOKEN })).status).toBe(404);
    });

    it('store limits, merge partial updates, return what is stored and write an audit row without an actor', async () => {
      const s = await serve();
      const first = await s.put({ seatLimit: 5, readOnly: false, banner: ' Trial ends soon ' });
      expect(first).toMatchObject({ status: 200, body: { seatLimit: 5, readOnly: false, banner: 'Trial ends soon' } });
      expect((await s.put({ readOnly: true })).body).toEqual({ seatLimit: 5, readOnly: true, banner: 'Trial ends soon', billing: true });
      expect((await s.put({ seatLimit: null, banner: null })).body).toEqual({ seatLimit: null, readOnly: true, banner: null, billing: true });
      const rows = s.directory.listAudit().filter((r) => r.action === 'cloud.limits');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ actorId: null, detail: { seatLimit: null, readOnly: true, banner: null } });
    });

    it.each<[string, unknown]>([
      ['an empty object', {}],
      ['an unknown field', { seatLimit: 3, plan: 'x' }],
      ['a zero seat limit', { seatLimit: 0 }],
      ['a huge seat limit', { seatLimit: 100001 }],
      ['a fractional seat limit', { seatLimit: 1.5 }],
      ['a string seat limit', { seatLimit: '3' }],
      ['a string readOnly', { readOnly: 'yes' }],
      ['a long banner', { banner: 'b'.repeat(301) }],
      ['a multi-line banner', { banner: 'a\nb' }],
      ['a numeric banner', { banner: 1 }],
    ])('refuse %s and change nothing', async (_name, body) => {
      const s = await serve();
      await s.put({ seatLimit: 4, banner: 'Keep' });
      const before = s.directory.listAudit().length;
      const res = await s.put(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'bad_request' });
      expect(s.cloud!.limits()).toEqual({ seatLimit: 4, readOnly: false, banner: 'Keep', billing: true });
      expect(s.directory.listAudit()).toHaveLength(before);
    });

    it('refuse a body that is not a JSON object', async () => {
      const s = await serve();
      for (const raw of ['[1]', '"x"', 'nope{']) {
        const res = await fetch(`${s.base}/api/internal/limits`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: raw,
        });
        expect(res.status).toBe(400);
      }
      expect(s.cloud!.limits().readOnly).toBe(false);
    });

    it('tell the relay the limits changed', async () => {
      const s = await serve();
      const changed = vi.fn<(limits: unknown) => void>();
      s.events.on('limits-changed', changed);
      await s.put({ readOnly: true });
      expect(changed).toHaveBeenCalledWith({ seatLimit: null, readOnly: true, banner: null, billing: true });
    });
  });

  describe('POST /api/internal/notify', () => {
    const body = { template: 'trial-ending', date: DATE };
    const audit = (s: { directory: Dir }) => s.directory.listAudit().filter((r) => r.action === 'cloud.notify');

    it('mails every enabled owner and nobody else, with the template, the link and the date', async () => {
      const s = await serve();
      seed(s.directory, 'first@example.com', 'owner');
      seed(s.directory, 'second@example.com', 'owner');
      seed(s.directory, 'gone@example.com', 'owner', true);
      seed(s.directory, 'admin@example.com', 'admin');
      seed(s.directory, 'member@example.com', 'member');
      seed(s.directory, 'guest@example.com', 'guest');
      seed(s.directory, 'off@example.com', 'member', true);

      const res = await s.notify();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: 2 });
      expect(s.notices().map((m) => m.to)).toEqual(['first@example.com', 'second@example.com']);
      expect(s.sent).toHaveLength(2);
      const link = `${s.config.baseUrl}/`;
      for (const mail of s.notices()) {
        expect(mail).toMatchObject({ template: 'trial-ending', params: { link, date: DATE }, subject: 'Your Tabula trial ends on 7 Nov 2026' });
        expect(Object.keys(mail.params!).sort()).toEqual(['date', 'link']);
        expect(mail.text).toContain('The free trial of this Tabula workspace ends on 7 Nov 2026.');
        expect(mail.text).toContain('starts automatically with the card on file');
        expect(mail.text).toContain('Admin, Overview, Manage billing');
        expect(mail.text.split('\n')).toContain(link);
      }
    });

    it('takes the bearer token alone: no cookie, no CSRF header', async () => {
      const s = await serve();
      seed(s.directory, OWNER, 'owner');
      const res = await fetch(`${s.base}/api/internal/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1 });
    });

    it('is open while the workspace is read-only', async () => {
      const s = await serve();
      seed(s.directory, OWNER, 'owner');
      await s.put({ readOnly: true });
      expect((await s.notify()).body).toEqual({ sent: 1 });
    });

    it.each<[string, unknown]>([
      ['an empty body', undefined],
      ['an empty object', {}],
      ['an unknown template', { template: 'welcome', date: DATE }],
      ['an unknown field', { ...body, to: 'someone@example.com' }],
      ['a date in another format', { template: 'trial-ending', date: '2026-11-07' }],
      ['a body that is not an object', ['trial-ending']],
    ])('refuses %s and sends and stores nothing', async (_name, payload) => {
      const s = await serve();
      seed(s.directory, OWNER, 'owner');
      const res = await s.call('/api/internal/notify', { method: 'POST', token: TOKEN, body: payload });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'bad_request' });
      expect(s.sent).toEqual([]);
      expect(s.directory.getSetting('cloud.trialEndingNotified')).toBeNull();
      expect(audit(s)).toEqual([]);
    });

    it('refuses a body that is not valid JSON', async () => {
      const s = await serve();
      seed(s.directory, OWNER, 'owner');
      const res = await fetch(`${s.base}/api/internal/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: 'nope{',
      });
      expect(res.status).toBe(400);
      expect(s.sent).toEqual([]);
    });

    it('answers a repeat of the same date without mailing again, and mails again for a new date', async () => {
      const s = await serve();
      seed(s.directory, OWNER, 'owner');
      expect((await s.notify()).body).toEqual({ sent: 1 });
      expect(s.directory.getSetting('cloud.trialEndingNotified')).toBe(DATE);

      const repeat = await s.notify();
      expect(repeat.status).toBe(200);
      expect(repeat.body).toEqual({ sent: 0, duplicate: true });
      expect(s.sent).toHaveLength(1);
      expect(audit(s)).toHaveLength(1);

      expect((await s.notify({ template: 'trial-ending', date: '21 Nov 2026' })).body).toEqual({ sent: 1 });
      expect(s.directory.getSetting('cloud.trialEndingNotified')).toBe('21 Nov 2026');
      expect(s.sent).toHaveLength(2);
      expect(s.sent[1].subject).toBe('Your Tabula trial ends on 21 Nov 2026');
    });

    it('answers a call that arrives while the same date is being mailed as a repeat', async () => {
      const s = await serve();
      seed(s.directory, OWNER, 'owner');
      let release!: () => void;
      s.gate.open = new Promise<void>((resolve) => (release = resolve));
      const first = s.notify();
      await settle();
      expect((await s.notify()).body).toEqual({ sent: 0, duplicate: true });
      release();
      expect((await first).body).toEqual({ sent: 1 });
      expect(s.notices()).toHaveLength(1);
      expect((await s.notify()).body).toEqual({ sent: 0, duplicate: true });
    });

    it('answers 200 with sent: 0 when there is no enabled owner, and remembers nothing', async () => {
      const s = await serve();
      seed(s.directory, 'admin@example.com', 'admin');
      seed(s.directory, 'gone@example.com', 'owner', true);
      const none = await s.notify();
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ sent: 0 });
      expect(s.sent).toEqual([]);
      expect(s.directory.getSetting('cloud.trialEndingNotified')).toBeNull();
      expect(audit(s)).toEqual([]);

      seed(s.directory, OWNER, 'owner');
      expect((await s.notify()).body).toEqual({ sent: 1 });
    });

    it.each<['reject' | 'throw']>([['reject'], ['throw']])('still answers 200 when a mail fails (%s), logs it without the address and remembers the date', async (how) => {
      const s = await serve();
      seed(s.directory, 'works@example.com', 'owner');
      seed(s.directory, 'fails@example.com', 'owner');
      s.failing.set('fails@example.com', how);

      const res = await s.notify();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: 1 });
      expect(s.notices().map((m) => m.to)).toEqual(['works@example.com']);
      expect(s.directory.getSetting('cloud.trialEndingNotified')).toBe(DATE);
      expect(audit(s)).toHaveLength(1);
      expect(audit(s)[0].detail).toEqual({ template: 'trial-ending', count: 1 });
      expect(s.logs).toHaveLength(1);
      expect(s.logs[0]).toContain('1 of 2 trial-ending mails could not be sent');
      expect(s.logs.join('\n')).not.toMatch(/@|fails|works/);
    });

    it('answers 502 when every mail fails, so the control plane retries, and nothing is remembered', async () => {
      const s = await serve();
      seed(s.directory, 'one@example.com', 'owner');
      seed(s.directory, 'two@example.com', 'owner');
      s.failing.set('one@example.com', 'reject');
      s.failing.set('two@example.com', 'throw');

      const res = await s.notify();
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ error: 'bad_gateway' });
      expect(JSON.stringify(res.body)).not.toContain('@');
      expect(s.sent).toEqual([]);
      expect(s.directory.getSetting('cloud.trialEndingNotified')).toBeNull();
      expect(audit(s)).toEqual([]);
      expect(s.logs).toHaveLength(1);
      expect(s.logs[0]).toContain('2 of 2 trial-ending mails could not be sent');
      expect(s.logs.join('\n')).not.toMatch(/@|one|two/);

      s.failing.clear();
      const retry = await s.notify();
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ sent: 2 });
    });

    it('writes an audit row with no actor, the template and the count, and no address', async () => {
      const s = await serve();
      seed(s.directory, 'one@example.com', 'owner');
      seed(s.directory, 'two@example.com', 'owner');
      await s.notify();
      const rows = audit(s);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: null, action: 'cloud.notify', detail: { template: 'trial-ending', count: 2 } });
      expect(Object.keys(rows[0].detail).sort()).toEqual(['count', 'template']);
      expect(JSON.stringify(s.directory.listAudit())).not.toMatch(/@|one|two/);
    });
  });

  describe('GET /api/me', () => {
    it('describes the workspace, in cloud mode only', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      s.person('m@example.com', 'member');
      s.person('g@example.com', 'guest');
      expect((await s.call('/api/me', { cookie: owner.cookie })).body.workspace).toEqual({ readOnly: false, banner: null, seatLimit: null, seatsUsed: 2, billing: true });
      await s.put({ seatLimit: 4, readOnly: true, banner: 'Pay up' });
      const me = await s.call('/api/me', { cookie: owner.cookie });
      expect(me.body.workspace).toEqual({ readOnly: true, banner: 'Pay up', seatLimit: 4, seatsUsed: 2, billing: true });
      expect(me.body.user.email).toBe(OWNER);
    });
  });

  describe('read-only workspaces', () => {
    it('refuse writes with 402 and leave sign-in, sign-out, reading and the limits endpoint working', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const member = s.person('m@example.com', 'member');
      await s.put({ readOnly: true });

      const refused = [
        await s.call('/api/teams', { method: 'POST', cookie: owner.cookie, body: { name: 'Crew' } }),
        await s.call('/api/me', { method: 'PATCH', cookie: owner.cookie, body: { name: 'Boss' } }),
        await s.call('/api/boards', { method: 'POST', cookie: member.cookie, body: { id: 'b1' } }),
        await s.patchMember(owner.cookie, member.user.id, { role: 'admin' }),
        await s.call(`/api/members/${member.user.id}`, { method: 'DELETE', cookie: owner.cookie }),
      ];
      for (const res of refused) {
        expect(res.status).toBe(402);
        expect(res.body).toMatchObject({ error: 'read_only', message: expect.stringContaining('read-only') });
      }
      expect(s.directory.listTeamsFor(owner.user.id)).toEqual([]);
      expect(s.directory.getUser(member.user.id)!.role).toBe('member');

      expect((await s.call('/api/me', { cookie: owner.cookie })).status).toBe(200);
      expect((await s.call('/api/teams', { cookie: owner.cookie })).status).toBe(200);
      expect((await s.call('/api/boards', { cookie: member.cookie })).status).toBe(200);
      expect((await s.call('/api/admin/overview', { cookie: owner.cookie })).status).toBe(200);
      expect((await s.put({ banner: 'Locked' })).status).toBe(200);

      const again = await s.signIn('m@example.com');
      expect(again.asked.status).toBe(200);
      expect(again.verified.status).toBe(200);
      expect((await s.call('/api/auth/logout', { method: 'POST', cookie: owner.cookie })).status).toBe(204);
      const other = s.person('o2@example.com', 'owner');
      expect((await s.call('/api/auth/logout-all', { method: 'POST', cookie: other.cookie })).status).toBe(204);
    });

    it('answer 401 to a signed-out writer, as always', async () => {
      const s = await serve();
      await s.put({ readOnly: true });
      expect((await s.call('/api/teams', { method: 'POST', body: { name: 'x' } })).status).toBe(401);
    });

    it('allow writes again as soon as the flag is cleared', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      await s.put({ readOnly: true });
      expect((await s.call('/api/teams', { method: 'POST', cookie: owner.cookie, body: { name: 'Crew' } })).status).toBe(402);
      await s.put({ readOnly: false });
      expect((await s.call('/api/teams', { method: 'POST', cookie: owner.cookie, body: { name: 'Crew' } })).status).toBe(201);
    });

    it('do not touch the CSRF rule: a write without the header is still 403', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      await s.put({ readOnly: false });
      const res = await s.call('/api/teams', { method: 'POST', cookie: owner.cookie, body: { name: 'x' }, headers: { 'x-tabula': '0' } });
      expect(res.status).toBe(403);
    });
  });

  describe('seat limit', () => {
    it('refuses new invite links once every seat is used', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const member = s.person('m@example.com', 'member');
      const { team } = s.invitation(owner.user);
      s.directory.addTeamMember(team.id, member.user.id, 'member');
      const make = (cookie: string) => s.call(`/api/teams/${team.id}/invites`, { method: 'POST', cookie, body: {} });

      await s.put({ seatLimit: 3 });
      expect((await make(owner.cookie)).status).toBe(201);

      await s.put({ seatLimit: 2 });
      const invitesBefore = s.directory.listInvites(team.id).length;
      const full = await make(owner.cookie);
      expect(full.status).toBe(409);
      expect(full.body).toMatchObject({ error: 'seat_limit', message: expect.stringContaining('All 2 seats are in use') });
      expect(s.directory.listInvites(team.id)).toHaveLength(invitesBefore);

      expect((await make(member.cookie)).status).toBe(403);

      await s.put({ seatLimit: null });
      expect((await make(owner.cookie)).status).toBe(201);
    });

    it('counts disabled people and guests as free', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      s.person('g@example.com', 'guest');
      s.person('off@example.com', 'member', true);
      const { team } = s.invitation(owner.user);
      await s.put({ seatLimit: 2 });
      expect((await s.call(`/api/teams/${team.id}/invites`, { method: 'POST', cookie: owner.cookie, body: {} })).status).toBe(201);
    });

    it('fails sign-in with an invite without creating the person or using the invite, and the same link works after the limit is raised', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const { team, invite } = s.invitation(owner.user);
      await s.put({ seatLimit: 1 });

      const blocked = await s.signIn('new@example.com', invite.token);
      expect(blocked.asked.status).toBe(200);
      expect(blocked.mails).toBe(1);
      expect(blocked.verified.status).toBe(409);
      expect(blocked.verified.body).toMatchObject({ error: 'seat_limit', message: expect.stringContaining('no free seat') });
      expect(blocked.verified.headers.get('set-cookie')).toBeNull();
      expect(s.directory.getUserByEmail('new@example.com')).toBeNull();
      expect(s.directory.listInvites(team.id)[0].uses).toBe(0);

      await s.put({ seatLimit: 2 });
      const retry = await s.call('/api/auth/verify', { method: 'POST', body: { token: blocked.token } });
      expect(retry.status).toBe(200);
      expect(retry.body.user.email).toBe('new@example.com');
      expect(s.directory.listInvites(team.id)[0].uses).toBe(1);
      expect(s.directory.seatUsage().seats).toBe(2);
    });

    it('keeps answering sign-in requests the same way for everyone', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const { invite } = s.invitation(owner.user);
      await s.put({ seatLimit: 1 });
      const known = await s.call('/api/auth/request', { method: 'POST', body: { email: OWNER } });
      const stranger = await s.call('/api/auth/request', { method: 'POST', body: { email: 'nobody@example.com' } });
      const invited = await s.call('/api/auth/request', { method: 'POST', body: { email: 'new@example.com', invite: invite.token } });
      expect(known).toMatchObject({ status: 200, body: { ok: true } });
      expect(stranger.status).toBe(known.status);
      expect(stranger.body).toEqual(known.body);
      expect(invited.status).toBe(known.status);
      expect(invited.body).toEqual(known.body);
    });

    it('lets people with an account sign in even when the workspace is full', async () => {
      const s = await serve();
      s.person(OWNER, 'owner');
      s.person('m@example.com', 'member');
      await s.put({ seatLimit: 1 });
      expect((await s.signIn('m@example.com')).verified.status).toBe(200);
    });

    it('refuses to enable a disabled member, or to turn a guest into a member, admin or owner, when it would pass the limit', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const member = s.person('m@example.com', 'member');
      const off = s.person('off@example.com', 'member', true);
      const guest = s.person('g@example.com', 'guest');
      await s.put({ seatLimit: 2 });

      const enable = await s.patchMember(owner.cookie, off.user.id, { disabled: false });
      expect(enable.status).toBe(409);
      expect(enable.body).toMatchObject({ error: 'seat_limit', message: expect.stringContaining('All 2 seats are in use') });
      for (const role of ['member', 'admin', 'owner']) {
        const res = await s.patchMember(owner.cookie, guest.user.id, { role });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('seat_limit');
      }
      expect((await s.patchMember(owner.cookie, off.user.id, { disabled: false, role: 'guest' })).status).toBe(200);
      expect(s.directory.getUser(off.user.id)).toMatchObject({ disabled: false, role: 'guest' });
      expect(s.directory.getUser(guest.user.id)!.role).toBe('guest');
      expect(s.directory.seatUsage().seats).toBe(2);

      expect((await s.patchMember(owner.cookie, member.user.id, { role: 'admin' })).status).toBe(200);
      expect((await s.patchMember(owner.cookie, guest.user.id, { role: 'guest' })).status).toBe(200);
      expect((await s.patchMember(owner.cookie, guest.user.id, { disabled: true })).status).toBe(200);
      expect((await s.patchMember(owner.cookie, guest.user.id, { disabled: false })).status).toBe(200);
      expect((await s.patchMember(owner.cookie, member.user.id, { disabled: true })).status).toBe(200);

      await s.put({ seatLimit: 2 });
      expect((await s.patchMember(owner.cookie, guest.user.id, { role: 'member' })).status).toBe(200);
      expect((await s.patchMember(owner.cookie, member.user.id, { disabled: false })).status).toBe(409);
    });

    it('lets everything through without a limit, and after a limit is lifted', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const guest = s.person('g@example.com', 'guest');
      await s.put({ seatLimit: 1 });
      expect((await s.patchMember(owner.cookie, guest.user.id, { role: 'member' })).status).toBe(409);
      await s.put({ seatLimit: null });
      expect((await s.patchMember(owner.cookie, guest.user.id, { role: 'member' })).status).toBe(200);
    });

    it('keeps the other permission checks first', async () => {
      const s = await serve();
      s.person(OWNER, 'owner');
      const admin = s.person('a@example.com', 'admin');
      const guest = s.person('g@example.com', 'guest');
      await s.put({ seatLimit: 1 });
      const res = await s.patchMember(admin.cookie, guest.user.id, { role: 'owner' });
      expect(res.status).toBe(403);
    });
  });

  describe('automatic updates', () => {
    const settingsCalls = (s: { fetchFn: ReturnType<typeof setup>['fetchFn'] }) => s.fetchFn.mock.calls.filter(([url]) => url.endsWith('/settings'));

    it('has no update routes without hosted cloud mode', async () => {
      const c = setup({ TABULA_CLOUD_TOKEN: '', TABULA_CLOUD_URL: '', TABULA_CLOUD_WORKSPACE_ID: '' });
      const s = { ...c, ...directApi(c) };
      const owner = s.person(OWNER, 'owner');
      expect((await s.call('/api/admin/updates', { cookie: owner.cookie })).status).toBe(404);
      expect((await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: false } })).status).toBe(404);
      expect(s.directory.getSetting('updates.auto')).toBeNull();
      expect(s.fetchFn).not.toHaveBeenCalled();
    });

    it('lets owners change the setting, pushes only autoUpgrade and audits the actor', async () => {
      const c = setup({}, async (_url, init) => {
        const { autoUpgrade } = JSON.parse(init.body as string) as { autoUpgrade: boolean };
        return json({ autoUpgrade, securityAlwaysApplied: true });
      });
      const s = { ...c, ...directApi(c) };
      const owner = s.person(OWNER, 'owner');
      const admin = s.person('admin@example.com', 'admin');
      expect((await s.call('/api/admin/updates', { cookie: admin.cookie })).body).toEqual({ auto: true, synced: true, securityAlwaysApplied: true });

      const off = await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: false } });
      expect(off).toMatchObject({ status: 200, body: { auto: false, synced: true, securityAlwaysApplied: true } });
      expect(s.directory.getSetting('updates.auto')).toBe('0');
      const [url, init] = settingsCalls(s)[0];
      expect(url).toBe('https://cloud.example.com/v1/workspaces/ws_123/settings');
      expect(init).toMatchObject({
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json' },
        redirect: 'error',
      });
      expect(JSON.parse(init.body as string)).toEqual({ autoUpgrade: false });
      expect(s.directory.listAudit()[0]).toMatchObject({ actorId: owner.user.id, action: 'updates.auto', detail: { from: true, to: false } });

      expect((await s.call('/api/admin/updates', { cookie: admin.cookie })).body).toEqual({ auto: false, synced: true, securityAlwaysApplied: true });
      const on = await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: true } });
      expect(on.body).toEqual({ auto: true, synced: true, securityAlwaysApplied: true });
      expect(s.directory.getSetting('updates.auto')).toBe('1');
      expect(settingsCalls(s)).toHaveLength(2);
      expect(s.directory.listAudit()[0]).toMatchObject({ actorId: owner.user.id, action: 'updates.auto', detail: { from: false, to: true } });
    });

    it('refuses admin changes and invalid bodies before saving or pushing', async () => {
      const c = setup();
      const s = { ...c, ...directApi(c) };
      const owner = s.person(OWNER, 'owner');
      const admin = s.person('admin@example.com', 'admin');
      expect((await s.call('/api/admin/updates', { method: 'PUT', cookie: admin.cookie, body: { auto: false } })).status).toBe(403);
      for (const body of [{ auto: 'false' }, { auto: null }, { auto: false, extra: true }, {}]) {
        expect((await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body })).status).toBe(400);
      }
      expect(s.directory.getSetting('updates.auto')).toBeNull();
      expect(settingsCalls(s)).toHaveLength(0);
      expect(s.directory.listAudit()).toEqual([]);
    });

    it('keeps the saved value after failed pushes and retries at 30 seconds, 2 minutes, 10 minutes, then 30 minutes', async () => {
      let settingsAttempt = 0;
      const c = setup({}, async (url) => {
        if (!url.endsWith('/settings')) return new Response(null, { status: 204 });
        settingsAttempt++;
        if (settingsAttempt === 1) throw new TypeError('fetch failed');
        if (settingsAttempt === 2 || settingsAttempt === 4) return json({}, 500);
        if (settingsAttempt === 3) return json({ autoUpgrade: false, securityAlwaysApplied: 'true' });
        return json({ autoUpgrade: false, securityAlwaysApplied: true });
      });
      const s = { ...c, ...directApi(c) };
      const owner = s.person(OWNER, 'owner');
      const saved = await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: false } });
      expect(saved.body).toEqual({ auto: false, synced: false, securityAlwaysApplied: true });
      expect(s.directory.getSetting('updates.auto')).toBe('0');

      s.timers.advance(29_999);
      await settle();
      expect(settingsCalls(s)).toHaveLength(1);
      s.timers.advance(1);
      await settle();
      expect(settingsCalls(s)).toHaveLength(2);

      s.timers.advance(119_999);
      await settle();
      expect(settingsCalls(s)).toHaveLength(2);
      s.timers.advance(1);
      await settle();
      expect(settingsCalls(s)).toHaveLength(3);

      s.timers.advance(599_999);
      await settle();
      expect(settingsCalls(s)).toHaveLength(3);
      s.timers.advance(1);
      await settle();
      expect(settingsCalls(s)).toHaveLength(4);

      s.timers.advance(1_799_999);
      await settle();
      expect(settingsCalls(s)).toHaveLength(4);
      s.timers.advance(1);
      await settle();
      expect(settingsCalls(s)).toHaveLength(5);
      expect((await s.call('/api/admin/updates', { cookie: owner.cookie })).body).toEqual({ auto: false, synced: true, securityAlwaysApplied: true });
    });

    it('replaces a pending retry when the owner changes the value again', async () => {
      let settingsAttempt = 0;
      const c = setup({}, async (url, init) => {
        if (!url.endsWith('/settings')) return new Response(null, { status: 204 });
        settingsAttempt++;
        if (settingsAttempt === 1) throw new TypeError('fetch failed');
        const { autoUpgrade } = JSON.parse(init.body as string) as { autoUpgrade: boolean };
        return json({ autoUpgrade, securityAlwaysApplied: true });
      });
      const s = { ...c, ...directApi(c) };
      const owner = s.person(OWNER, 'owner');
      await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: false } });
      await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: true } });
      expect(settingsCalls(s)).toHaveLength(2);
      s.timers.advance(30_000);
      await settle();
      expect(settingsCalls(s)).toHaveLength(2);
      expect(settingsCalls(s).map(([, init]) => JSON.parse(init.body as string))).toEqual([{ autoUpgrade: false }, { autoUpgrade: true }]);
      expect((await s.call('/api/admin/updates', { cookie: owner.cookie })).body).toEqual({ auto: true, synced: true, securityAlwaysApplied: true });
    });

    it('refuses updates while read-only but keeps the setting readable', async () => {
      const c = setup();
      const s = { ...c, ...directApi(c) };
      const owner = s.person(OWNER, 'owner');
      await s.call('/api/internal/limits', { method: 'PUT', token: TOKEN, body: { readOnly: true } });
      expect((await s.call('/api/admin/updates', { cookie: owner.cookie })).body).toEqual({ auto: true, synced: true, securityAlwaysApplied: true });
      expect((await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: false } })).status).toBe(402);
      expect(s.directory.getSetting('updates.auto')).toBeNull();
    });

    it('echoes the setting in internal usage and version reports', async () => {
      const c = setup({}, async (_url, init) => {
        const { autoUpgrade } = JSON.parse(init.body as string) as { autoUpgrade: boolean };
        return json({ autoUpgrade, securityAlwaysApplied: true });
      });
      const s = { ...c, ...directApi(c) };
      const owner = s.person(OWNER, 'owner');
      await s.call('/api/admin/updates', { method: 'PUT', cookie: owner.cookie, body: { auto: false } });
      expect((await s.call('/api/internal/usage', { token: TOKEN })).body).toMatchObject({ updates: { auto: false } });
      expect((await s.call('/api/internal/version', { token: TOKEN })).body).toMatchObject({ updates: { auto: false } });
    });
  });

  describe('billing portal', () => {
    const portal = (cookie?: string) => ({ method: 'POST', cookie, body: undefined as unknown });

    it('lets the owner open the customer portal and returns the URL', async () => {
      const s = await serve({}, async () => json({ url: PORTAL }));
      const owner = s.person(OWNER, 'owner');
      const res = await s.call('/api/billing/portal', portal(owner.cookie));
      expect(res).toMatchObject({ status: 200, body: { url: PORTAL } });
      expect(s.fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = s.fetchFn.mock.calls[0];
      expect(url).toBe('https://cloud.example.com/v1/workspaces/ws_123/portal');
      expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it('is for the owner only', async () => {
      const s = await serve({}, async () => json({ url: PORTAL }));
      s.person(OWNER, 'owner');
      for (const role of ['admin', 'member', 'guest'] as const) {
        const who = s.person(`${role}@example.com`, role);
        const res = await s.call('/api/billing/portal', portal(who.cookie));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('forbidden');
      }
      expect((await s.call('/api/billing/portal', portal())).status).toBe(401);
      expect(s.fetchFn).not.toHaveBeenCalled();
    });

    it('needs the CSRF header like any write', async () => {
      const s = await serve({}, async () => json({ url: PORTAL }));
      const owner = s.person(OWNER, 'owner');
      const res = await s.call('/api/billing/portal', { method: 'POST', cookie: owner.cookie, headers: { 'x-tabula': '0' } });
      expect(res.status).toBe(403);
      expect(s.fetchFn).not.toHaveBeenCalled();
    });

    it.each<[string, () => Promise<Response>]>([
      ['an http URL', async () => json({ url: 'http://billing.example.com/x' })],
      ['a non-URL', async () => json({ url: 'not a url' })],
      ['a missing URL', async () => json({ ok: true })],
      ['an error status', async () => json({ error: 'boom' }, 500)],
      ['a network failure', async () => Promise.reject(new TypeError('fetch failed'))],
    ])('answers 502 for %s', async (_name, reply) => {
      const s = await serve({}, reply);
      const owner = s.person(OWNER, 'owner');
      const res = await s.call('/api/billing/portal', portal(owner.cookie));
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ error: 'bad_gateway' });
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    });

    it('still works while the workspace is read-only', async () => {
      const s = await serve({}, async () => json({ url: PORTAL }));
      const owner = s.person(OWNER, 'owner');
      await s.put({ readOnly: true });
      expect((await s.call('/api/billing/portal', portal(owner.cookie))).status).toBe(200);
    });
  });

  describe('usage reports', () => {
    const sentUsage = (s: Awaited<ReturnType<typeof serve>>) => s.fetchFn.mock.calls.map(([url, init]) => [url, JSON.parse(init.body as string)]);

    it('go out once, 30 seconds after the members change', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const member = s.person('m@example.com', 'member');
      const guest = s.person('g@example.com', 'guest');
      await s.patchMember(owner.cookie, guest.user.id, { role: 'member' });
      await s.patchMember(owner.cookie, member.user.id, { disabled: true });
      s.timers.advance(29_999);
      expect(s.fetchFn).not.toHaveBeenCalled();
      s.timers.advance(1);
      await settle();
      expect(sentUsage(s)).toEqual([['https://cloud.example.com/v1/workspaces/ws_123/usage', { seats: 2, guests: 0 }]]);
    });

    it('follow a removal', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const member = s.person('m@example.com', 'member');
      expect((await s.call(`/api/members/${member.user.id}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204);
      s.timers.advance(30_000);
      await settle();
      expect(sentUsage(s)[0][1]).toEqual({ seats: 1, guests: 0 });
    });

    it('follow someone joining through an invite', async () => {
      const s = await serve();
      const owner = s.person(OWNER, 'owner');
      const { invite } = s.invitation(owner.user);
      expect((await s.signIn('new@example.com', invite.token)).verified.status).toBe(200);
      s.timers.advance(30_000);
      await settle();
      expect(sentUsage(s)[0][1]).toEqual({ seats: 2, guests: 0 });
    });

    it('never fail or slow down the request they follow', async () => {
      const s = await serve({}, async () => Promise.reject(new TypeError('fetch failed')));
      const owner = s.person(OWNER, 'owner');
      const guest = s.person('g@example.com', 'guest');
      const res = await s.patchMember(owner.cookie, guest.user.id, { role: 'member' });
      expect(res.status).toBe(200);
      s.timers.advance(30_000);
      await settle();
      expect(s.logs).toEqual(['cloud: could not push usage: fetch failed']);
      expect((await s.call('/api/me', { cookie: owner.cookie })).status).toBe(200);
    });
  });
});

describe('open mode and plain accounts mode', () => {
  it('create no cloud object and no settings changes', () => {
    const config = loadConfig({ ...AUTH_ENV });
    const directory = openDirectory(':memory:');
    opened.push(directory);
    expect(createCloud({ config: config.cloud, directory, events: new EventEmitter() })).toBeNull();
    expect(directory.getSetting('cloud.limits')).toBeNull();
  });
});
