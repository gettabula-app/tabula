import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { createCloud, validateRestartNotice } from '../server/cloud.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';

// docs/cloud.md, "Restart notice": PUT /api/internal/restart-notice, the countdown in /api/me, and the audit row. Runs in process,
// like the internal-route tests in test/cloud.test.ts (the same request and response stand-ins); the clock is faked where a countdown
// is read. The hint on the socket is checked against a real relay in test/cloud-relay.test.ts.

type Dir = ReturnType<typeof openDirectory>;
type Res = { status: number; body: any; headers: Headers };
type Opts = { method?: string; cookie?: string; token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> };

const OWNER = 'owner@example.com';
const TOKEN = 'k'.repeat(40);
const CLOUD_ENV = {
  TABULA_CLOUD_TOKEN: TOKEN,
  TABULA_CLOUD_URL: 'https://cloud.example.com/',
  TABULA_CLOUD_WORKSPACE_ID: 'ws_123',
};
const AUTH_ENV = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: OWNER };
const PATH = '/api/internal/restart-notice';
const START = Date.parse('2026-10-16T10:00:00.000Z');
const TWO_MINUTES = 120_000;

const opened: Dir[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of opened.splice(0)) d.close();
});

function serve(env: Record<string, string> = {}) {
  const config = loadConfig({ PORT: '8787', ...AUTH_ENV, ...CLOUD_ENV, ...env });
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const events = new EventEmitter();
  const cloud = createCloud({ config: config.cloud, directory, events, log: () => {} });
  const mailer = { send: async () => {} };
  const auth = createAuth({ directory, config, mailer, seatsAvailable: cloud?.seatsAvailable });
  const api = createApi({ directory, auth, config, roomExists: () => false, events, cloud: cloud as never, mailer });

  async function call(path: string, opts: Opts = {}): Promise<Res> {
    const { method = 'GET', cookie, token, body, raw, headers = {} } = opts;
    const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
    const req = Readable.from(payload === null ? [] : [Buffer.from(payload)]) as Readable & { url: string; method: string; headers: Record<string, string> };
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

  const login = (userId: string) => `${config.cookieName}=${directory.createSession(userId, { ttlMs: 3_600_000 }).token}`;
  const person = (email: string, role: 'owner' | 'admin' | 'member' | 'guest') => {
    const user = directory.createUser({ email, role })!;
    return { user, cookie: login(user.id) };
  };
  // the bearer-token signal, as the control plane sends it
  const put = (seconds: unknown) => call(PATH, { method: 'PUT', token: TOKEN, body: { seconds } });
  // what a signed-in person's /api/me says about the notice
  const me = async (cookie: string) => (await call('/api/me', { cookie })).body.workspace.restart;
  const audited = () => directory.listAudit().filter((row) => row.action === 'cloud.restart_notice');

  return { config, directory, events, cloud, auth, call, person, put, me, audited };
}

describe('PUT /api/internal/restart-notice: who may call it', () => {
  it('answers 401 without a bearer token, with a wrong one, or with a signed-in cookie alone', async () => {
    const s = serve();
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
    const answers: { headers: Record<string, string>; status: number; error: unknown }[] = [];
    for (const headers of bad) {
      const res = await s.call(PATH, { method: 'PUT', headers, body: { seconds: 60 } });
      answers.push({ headers, status: res.status, error: res.body?.error });
    }
    expect(answers).toEqual(bad.map((headers) => ({ headers, status: 401, error: 'unauthenticated' })));
    expect(s.cloud!.restartView()).toBeNull();
    expect(s.audited()).toEqual([]);
  });

  it('refuses a guest session (join-code guest) without a bearer token', async () => {
    const s = serve({ TABULA_JOIN_CODES: 'on' });
    const owner = s.person(OWNER, 'owner');
    const board = s.directory.createBoard({ id: 'restart-board', ownerId: owner.user.id })!;
    const code = s.directory.createJoinCode({
      boardId: board.id, createdBy: owner.user.id, codeHash: 'a'.repeat(64), role: 'editor',
      createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, maxUses: 10,
    })!;
    const guestToken = 'guest-restart-token';
    s.directory.createGuestSession(code.id, { tokenHash: createHash('sha256').update(guestToken).digest('hex'), name: 'Guest' });
    const guest = `${s.config.cookieName}=${guestToken}`;
    expect(s.auth.authenticate(guest)?.guest).toBe(true);

    const res = await s.call(PATH, { method: 'PUT', cookie: guest, headers: { 'x-tabula': '1' }, body: { seconds: 60 } });
    // a guest is stopped before the bearer is looked at: refused, and nothing is set
    expect(res.status).toBe(403);
    expect(s.cloud!.restartView()).toBeNull();
  });

  it('judges a request with both a cookie and a bearer token by the bearer token alone', async () => {
    const s = serve();
    const owner = s.person(OWNER, 'owner');
    const ok = await s.call(PATH, { method: 'PUT', cookie: owner.cookie, token: TOKEN, body: { seconds: 60 } });
    expect(ok.status).toBe(200);
    const wrong = await s.call(PATH, { method: 'PUT', cookie: owner.cookie, token: 'z'.repeat(40), body: { seconds: 60 } });
    expect(wrong.status).toBe(401);
  });

  it('refuses an access token of the MCP server as the bearer token', async () => {
    const s = serve();
    const owner = s.person(OWNER, 'owner');
    const access = s.directory.createAccessToken({ userId: owner.user.id, name: 'Agent', scope: 'write', ttlMs: 86_400_000 });
    const res = await s.call(PATH, { method: 'PUT', headers: { authorization: `Bearer ${access.token}` }, body: { seconds: 60 } });
    expect(res.status).toBe(401);
    expect(s.cloud!.restartView()).toBeNull();
    expect(s.audited()).toEqual([]);
  });

  it('answers 405 to GET, POST and DELETE on the path', async () => {
    const s = serve();
    const answers: unknown[][] = [];
    for (const method of ['GET', 'POST', 'DELETE']) {
      answers.push([method, (await s.call(PATH, { method, token: TOKEN })).status]);
    }
    expect(answers).toEqual([['GET', 405], ['POST', 405], ['DELETE', 405]]);
  });

  it('answers 404 when cloud mode is off', async () => {
    const s = serve({ TABULA_CLOUD_TOKEN: '', TABULA_CLOUD_URL: '', TABULA_CLOUD_WORKSPACE_ID: '' });
    expect((await s.put(60)).status).toBe(404);
  });

  it('stays open while the workspace is read-only', async () => {
    const s = serve();
    s.cloud!.setLimits({ readOnly: true });
    expect((await s.put(60)).status).toBe(200);
  });
});

describe('PUT /api/internal/restart-notice: the body', () => {
  it('refuses anything but exactly one whole number of seconds, with 400, and changes nothing', async () => {
    const s = serve();
    const bodies: unknown[] = [
      { seconds: 1.5 },
      { seconds: '60' },
      { seconds: NaN },
      { seconds: [] },
      { seconds: null },
      { seconds: 60, x: 1 },
      {},
      { seconds: -5 },
      { seconds: 1e300 },
      { seconds: 2 ** 53 },
      [],
      null,
    ];
    const answers: unknown[][] = [];
    for (const body of bodies) {
      answers.push([JSON.stringify(body), (await s.call(PATH, { method: 'PUT', token: TOKEN, body })).status]);
    }
    expect(answers).toEqual(bodies.map((body) => [JSON.stringify(body), 400]));
    expect((await s.call(PATH, { method: 'PUT', token: TOKEN, raw: '{"seconds": NaN}' })).status).toBe(400);
    expect(s.cloud!.restartView()).toBeNull();
    expect(s.audited()).toEqual([]);
  });

  it('clamps a whole number above 900 to 900 and one from 1 to 29 to 30; 0 clears', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const s = serve();
    const owner = s.person(OWNER, 'owner');
    const pairs = [[5000, 900], [Number.MAX_SAFE_INTEGER, 900], [900, 900], [30, 30], [10, 30], [1, 30]] as const;
    const answers: unknown[][] = [];
    for (const [sent] of pairs) {
      const res = await s.put(sent);
      answers.push([sent, res.status, res.body.restart?.secondsLeft]);
    }
    expect(answers).toEqual(pairs.map(([sent, kept]) => [sent, 200, kept]));
    expect((await s.put(0)).body).toEqual({ restart: null });
    expect(await s.me(owner.cookie)).toBeNull();
  });

  it('is validated before the rate limit: a malformed body is 400 even when the limit is used up', async () => {
    const s = serve();
    for (let i = 0; i < 20; i++) expect((await s.put(60)).status).toBe(200);
    expect((await s.put(1.5)).status).toBe(400);
  });
});

describe('PUT /api/internal/restart-notice: the audit row and the event', () => {
  it('audits each signal with only its seconds, with no actor, and headers change nothing', async () => {
    const s = serve();
    expect((await s.put(60)).status).toBe(200);
    const forwarded = await s.call(PATH, {
      method: 'PUT',
      token: TOKEN,
      body: { seconds: 300 },
      headers: { host: 'evil.example', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body.restart).toMatchObject({ id: expect.any(String) });
    expect((await s.put(0)).status).toBe(200);
    const rows = s.audited();
    // newest first; the clamp and the clear are what was stored
    expect(rows.map((row) => row.detail)).toEqual([{ seconds: 0 }, { seconds: 300 }, { seconds: 60 }]);
    for (const row of rows) expect(row.actorId).toBeNull();
  });

  it('audits the clamped value, not the value sent', async () => {
    const s = serve();
    await s.put(5000);
    await s.put(10);
    expect(s.audited().map((row) => row.detail)).toEqual([{ seconds: 30 }, { seconds: 900 }]);
  });

  it('emits restart-notice-changed for every signal and every clear, and not for a refused one', async () => {
    const s = serve();
    const spy = vi.fn<() => void>();
    s.events.on('restart-notice-changed', spy);
    await s.put(60);
    await s.put(0);
    await s.call(PATH, { method: 'PUT', token: TOKEN, body: { seconds: 1.5 } });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('PUT /api/internal/restart-notice: the rate limit', () => {
  it('allows 20 non-zero signals an hour, refuses the 21st with 429, and still lets 0 clear', async () => {
    const s = serve();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await s.put(60 + i)).status);
    expect(statuses).toEqual(Array.from({ length: 20 }, () => 200));
    const refused = await s.put(60);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(s.cloud!.restartView()).not.toBeNull();

    // a clear is never counted, so it works at the limit and the notice goes
    expect((await s.put(0)).body).toEqual({ restart: null });
    expect(s.cloud!.restartView()).toBeNull();
    expect((await s.put(60)).status).toBe(429);
  });
});

describe('the countdown in /api/me', () => {
  it('counts down to the restart, stays at 0 for two minutes after it, then is gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const s = serve();
    const owner = s.person(OWNER, 'owner');
    const member = s.person('m@example.com', 'member');
    expect(await s.me(owner.cookie)).toBeNull();

    const set = await s.put(60);
    expect(set.body).toEqual({ restart: { secondsLeft: 60, id: expect.stringMatching(/^[0-9a-f]{12}$/) } });
    const { id } = set.body.restart;
    const at = (ms: number) => vi.setSystemTime(START + ms);

    at(15_000);
    expect(await s.me(owner.cookie)).toEqual({ secondsLeft: 45, id });
    expect(await s.me(member.cookie)).toEqual({ secondsLeft: 45, id });
    at(59_500);
    expect(await s.me(owner.cookie)).toEqual({ secondsLeft: 1, id });
    at(60_000);
    expect(await s.me(owner.cookie)).toEqual({ secondsLeft: 0, id });
    at(60_000 + TWO_MINUTES);
    expect(await s.me(owner.cookie)).toEqual({ secondsLeft: 0, id });
    at(60_000 + TWO_MINUTES + 1);
    expect(await s.me(owner.cookie)).toBeNull();
    expect(s.cloud!.restartView()).toBeNull();
  });

  it('is replaced by a later signal, with a new id, and removed at once by a clear', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const s = serve();
    const owner = s.person(OWNER, 'owner');
    const first = (await s.put(300)).body.restart;
    const second = (await s.put(120)).body.restart;
    expect(second).toEqual({ secondsLeft: 120, id: expect.any(String) });
    expect(second.id).not.toBe(first.id);
    expect(await s.me(owner.cookie)).toEqual(second);
    expect((await s.put(0)).body).toEqual({ restart: null });
    expect(await s.me(owner.cookie)).toBeNull();
  });

  it('starts with no notice after the server restarts (a new createCloud)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const s = serve();
    await s.put(60);
    expect(s.cloud!.restartView()).not.toBeNull();
    const restarted = createCloud({ config: s.config.cloud, directory: s.directory, events: new EventEmitter(), log: () => {} });
    expect(restarted!.restartView()).toBeNull();
  });
});

describe('validateRestartNotice', () => {
  it('passes a safe whole number, 0 included', () => {
    expect(validateRestartNotice({ seconds: 0 })).toEqual({ seconds: 0 });
    // the clamp belongs to setRestartNotice, so the route can count a non-zero signal before it
    expect(validateRestartNotice({ seconds: 5000 })).toEqual({ seconds: 5000 });
  });

  it('refuses everything else', () => {
    const bodies: unknown[] = [null, [], 'x', {}, { seconds: 1.5 }, { seconds: '60' }, { seconds: NaN }, { seconds: -1 }, { seconds: 60, x: 1 }, { seconds: 1e300 }];
    expect(bodies.map((body) => 'error' in validateRestartNotice(body))).toEqual(bodies.map(() => true));
  });
});
