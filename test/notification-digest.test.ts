import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  createDigest, DIGEST_FOOTER, digestLines, isDue, localParts, MAX_ATTEMPTS_PER_DAY, MAX_LINE_CHARS, parseDigestPatch, validTimeZone,
} from '../server/notification-digest.mjs';
import { sentenceFor } from '../server/notifications.mjs';
import { createNotificationRoutes } from '../server/notifications-routes.mjs';

// TAB-164 slice 4: the once-a-day email digest (docs/notifications.md, Digest). Opt-in, one mail a local day, names only (who,
// what and where), never the text of a message, comment, card or ticket.

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.useRealTimers();
});

const at = (iso: string) => Date.parse(iso);

type Item = { id: string; kind: string; at: number; read: boolean; actor: { id: string; name: string } | null; board: { id: string; title: string } | null; team: { id: string; name: string } | null; snippet: string | null; target: string | null };
const item = (fields: Partial<Item> & { kind: string; at: number }): Item => ({
  id: `n_${Math.random().toString(36).slice(2)}`, read: false, actor: { id: 'ana', name: 'Ana' }, board: { id: 'b1', title: 'Launch plan' },
  team: null, snippet: null, target: '#/b/b1', ...fields,
});

/** A directory with the users and prefs the digest reads, and a notification list that returns the given items. */
function setup(users: Array<{ id: string; email?: string; role?: string; disabled?: number }>, items: Item[] = []) {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec('CREATE TABLE user_prefs (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));');
  const rows = new Map(users.map((u) => [u.id, { id: u.id, email: u.email ?? `${u.id}@example.com`, name: u.id, role: u.role ?? 'member', disabled: u.disabled ?? 0 }]));
  const directory = {
    db,
    getUser: (id: string) => rows.get(id) ?? null,
    getPref: (userId: string, key: string) => (db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined)?.value ?? null,
    setPref: (userId: string, key: string, value: string) => {
      db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, String(value));
    },
  };
  const listCalls: unknown[] = [];
  const notifications = {
    list: ({ user, limit = 30, before = null }: { user: { id: string }; limit?: number; before?: string | null }) => {
      listCalls.push({ user: user.id, limit });
      const unread = items.filter((i) => !i.read && i.actor !== undefined).sort((a, b) => b.at - a.at);
      const start = before ? Number(before) : 0;
      const page = unread.slice(start, start + Math.min(limit, 50));
      const more = start + page.length < unread.length;
      return { items: page, nextCursor: more ? String(start + page.length) : null, unread: unread.length, unreadMentions: 0 };
    },
  };
  return { db, directory, notifications, listCalls };
}

/** A mailer that records what it is given, and fails when told to. */
function mailbox(fail: () => unknown = () => null) {
  const sent: any[] = [];
  const mailer = {
    send: vi.fn<(message: any) => Promise<void>>(async (message) => {
      const failure = fail();
      if (failure) throw failure;
      sent.push(message);
    }),
  };
  return { sent, mailer };
}

describe('time zones and the local day', () => {
  it('reads the local date and hour in Stockholm, New York, Auckland and UTC, across the DST edges', () => {
    // Stockholm springs forward at 01:00 UTC on 2026-03-29: 00:59Z is 01:59 CET, 01:00Z is 03:00 CEST.
    expect(localParts(at('2026-03-29T00:59:00Z'), 'Europe/Stockholm')).toEqual({ date: '2026-03-29', hour: 1 });
    expect(localParts(at('2026-03-29T01:00:00Z'), 'Europe/Stockholm')).toEqual({ date: '2026-03-29', hour: 3 });
    // New York springs forward at 07:00 UTC on 2026-03-08: 06:59Z is 01:59 EST, 07:00Z is 03:00 EDT.
    expect(localParts(at('2026-03-08T06:59:00Z'), 'America/New_York')).toEqual({ date: '2026-03-08', hour: 1 });
    expect(localParts(at('2026-03-08T07:00:00Z'), 'America/New_York')).toEqual({ date: '2026-03-08', hour: 3 });
    // Auckland moves to daylight time at 02:00 local on 2026-09-27, which is 14:00Z on the 26th.
    expect(localParts(at('2026-09-26T13:59:00Z'), 'Pacific/Auckland')).toEqual({ date: '2026-09-27', hour: 1 });
    expect(localParts(at('2026-09-26T14:00:00Z'), 'Pacific/Auckland')).toEqual({ date: '2026-09-27', hour: 3 });
    expect(localParts(at('2026-10-13T23:30:00Z'), 'UTC')).toEqual({ date: '2026-10-13', hour: 23 });
  });

  it('is due from the chosen local hour, once per local date, in each zone', () => {
    const stockholm = { on: true, hour: 8, tz: 'Europe/Stockholm', day: null };
    expect(isDue(stockholm, at('2026-01-13T06:59:00Z'))).toBe(false); // 07:59 CET
    expect(isDue(stockholm, at('2026-01-13T07:00:00Z'))).toBe(true); // 08:00 CET
    expect(isDue({ ...stockholm, day: '2026-01-13' }, at('2026-01-13T09:00:00Z'))).toBe(false);
    expect(isDue({ ...stockholm, day: '2026-01-12' }, at('2026-01-13T09:00:00Z'))).toBe(true);
    // New York on the spring-forward day: 08:00 EDT is 12:00Z.
    expect(isDue({ on: true, hour: 8, tz: 'America/New_York', day: null }, at('2026-03-08T11:59:00Z'))).toBe(false);
    expect(isDue({ on: true, hour: 8, tz: 'America/New_York', day: null }, at('2026-03-08T12:00:00Z'))).toBe(true);
    expect(isDue({ on: true, hour: 0, tz: 'Pacific/Auckland', day: null }, at('2026-09-26T12:00:00Z'))).toBe(true);
    expect(isDue({ on: false, hour: 0, tz: 'UTC', day: null }, at('2026-09-26T12:00:00Z'))).toBe(false);
  });

  it('validates zones: IANA names up to 64 characters, nothing else', () => {
    expect(validTimeZone('Europe/Stockholm')).toBe('Europe/Stockholm');
    expect(validTimeZone('Mars/Olympus')).toBeNull();
    expect(validTimeZone('')).toBeNull();
    expect(validTimeZone(`Europe/${'x'.repeat(60)}`)).toBeNull();
    expect(validTimeZone(42)).toBeNull();
  });
});

describe('the sweep', () => {
  const day1 = at('2026-10-13T07:00:00Z'); // 08:00 in Stockholm
  const users = [{ id: 'ana' }];

  it('sends one mail a day with the bell sentences, and never a second mail the same local day', async () => {
    let now = at('2026-10-13T04:00:00Z'); // 06:00 in Stockholm: the 08:00 mail is still to come today
    const { directory, notifications } = setup(users, [item({ kind: 'comment_reply', at: at('2026-10-13T03:00:00Z'), actor: { id: 'ben', name: 'Ben' } })]);
    const { sent, mailer } = mailbox();
    const digest = createDigest({ directory, notifications, mailer, baseUrl: 'https://tabula.example/', now: () => now });
    digest.set('ana', { on: true, hour: 8, tz: 'Europe/Stockholm' });
    now = day1 + 3600_000; // 09:00 local: due, and the row from before the switch-on is not a backlog
    expect(await digest.sweep()).toEqual({ sent: 0, empty: 1, failed: 0, skipped: 0 });
    // The day is handled by the empty sweep, so a row that arrives later today waits for tomorrow's mail.
    now = day1 + 2 * 3600_000;
    notifications.list = (() => ({ items: [item({ kind: 'card_due_soon', at: now - 1000, actor: null, board: { id: 'b2', title: 'Sprint board' } })], nextCursor: null })) as any;
    expect((await digest.sweep()).sent).toBe(0);
    now = day1 + 24 * 3600_000 + 3600_000; // the next local day, 09:00
    expect((await digest.sweep()).sent).toBe(1);
    expect((await digest.sweep()).sent).toBe(0);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({
      to: 'ana@example.com',
      subject: 'Your Tabula notifications',
      template: 'notification-digest',
      params: { link: 'https://tabula.example/#/', count: 1, lines: ['A card is due soon on Sprint board'], more: 0 },
    });
    expect(sent[0].text).toContain('You have 1 new notification');
    expect(sent[0].text).toContain(DIGEST_FOOTER);
    // The day after that, a new row is listed on its own.
    now = day1 + 48 * 3600_000;
    notifications.list = (() => ({ items: [item({ kind: 'board_shared', at: now - 1000, actor: { id: 'ben', name: 'Ben' } })], nextCursor: null })) as any;
    expect((await digest.sweep()).sent).toBe(1);
    expect(sent[1].params.lines).toEqual(['Ben shared Launch plan with you']);
  });

  it('sends nothing when nothing is unread, and still marks the day handled', async () => {
    let now = at('2026-10-13T04:00:00Z');
    const { directory, notifications, listCalls } = setup(users, []);
    const { mailer } = mailbox();
    const digest = createDigest({ directory, notifications, mailer, baseUrl: 'https://t.example', now: () => now });
    digest.set('ana', { on: true, hour: 8, tz: 'Europe/Stockholm' });
    now = day1 + 60_000;
    expect(await digest.sweep()).toEqual({ sent: 0, empty: 1, failed: 0, skipped: 0 });
    expect(mailer.send).not.toHaveBeenCalled();
    const calls = listCalls.length;
    expect(await digest.sweep()).toEqual({ sent: 0, empty: 0, failed: 0, skipped: 0 });
    expect(listCalls.length).toBe(calls);
  });

  it('sends nothing while the digest is off, and skips disabled, guest and email-less people', async () => {
    const { directory, notifications } = setup([{ id: 'ana' }, { id: 'ben', disabled: 1 }, { id: 'gus', role: 'guest' }, { id: 'cy', email: '' }], [
      item({ kind: 'board_shared', at: day1 + 1 }),
    ]);
    const { mailer } = mailbox();
    const digest = createDigest({ directory, notifications, mailer, baseUrl: 'https://t.example', now: () => day1 + 2 * 3600_000 });
    expect((await digest.sweep()).sent).toBe(0);
    for (const id of ['ben', 'gus', 'cy']) directory.setPref(id, 'notify.digest', '1');
    directory.setPref('ana', 'notify.digest', '0');
    expect((await digest.sweep()).sent).toBe(0);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('retries a failed mail at the next sweep, at most three times a day, and logs the error name only', async () => {
    let now = at('2026-10-13T04:00:00Z');
    const { directory, notifications } = setup(users, []);
    let failing = true;
    const log = vi.fn<(...args: unknown[]) => void>();
    const { mailer } = mailbox(() => (failing ? Object.assign(new Error('relay said: secret body text'), { name: 'RelayError' }) : null));
    const digest = createDigest({ directory, notifications, mailer, baseUrl: 'https://t.example', log, now: () => now });
    digest.set('ana', { on: true, hour: 8, tz: 'Europe/Stockholm' });
    now = day1 + 2 * 3600_000;
    notifications.list = (() => ({ items: [item({ kind: 'board_shared', at: now - 1 })], nextCursor: null })) as any;
    for (let i = 0; i < MAX_ATTEMPTS_PER_DAY + 2; i += 1) {
      now += 60_000;
      await digest.sweep();
    }
    expect(mailer.send).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_DAY);
    expect(log).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_DAY);
    for (const call of log.mock.calls) {
      expect(String(call.join(' '))).not.toContain('secret body text');
      expect(String(call.join(' '))).toContain('RelayError');
    }
    // The next local day tries again: the same row is still newer than the cutoff, so it is sent once and the day is handled.
    failing = false;
    now = day1 + 24 * 3600_000;
    expect((await digest.sweep()).sent).toBe(1);
    expect(mailer.send).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_DAY + 1);
    expect((await digest.sweep()).sent).toBe(0);
  });

  it('caps a mail at ten lines and says how many more there are, with the count of all of them', async () => {
    const now = day1 + 2 * 3600_000;
    const many = Array.from({ length: 12 }, (_u, i) => item({ kind: 'comment_reply', at: now - 1000 - i, actor: { id: `p${i}`, name: `Person ${i}` } }));
    const { directory, notifications } = setup(users, many);
    const { sent, mailer } = mailbox();
    const digest = createDigest({ directory, notifications, mailer, baseUrl: 'https://t.example', now: () => now });
    directory.setPref('ana', 'notify.digest', '1');
    directory.setPref('ana', 'notify.tz', 'UTC');
    directory.setPref('ana', 'notify.digestHour', '8');
    directory.setPref('ana', 'notify.digestLastAt', String(now - 10 * 3600_000));
    expect((await digest.sweep()).sent).toBe(1);
    expect(sent[0].params.lines).toHaveLength(10);
    expect(sent[0].params.more).toBe(2);
    expect(sent[0].params.count).toBe(12);
    expect(sent[0].text).toContain('and 2 more');
  });

  it('first mail after switching on is never a backlog: rows from before the switch-on are not listed', async () => {
    let now = day1;
    const { directory, notifications } = setup(users, [item({ kind: 'board_shared', at: day1 - 5 * 24 * 3600_000 })]);
    const { mailer } = mailbox();
    const digest = createDigest({ directory, notifications, mailer, baseUrl: 'https://t.example', now: () => now });
    // Switched on at 10:00 in Stockholm, after the chosen 08:00: today is not sent, and nothing older is listed tomorrow.
    now = at('2026-10-13T08:00:00Z');
    digest.set('ana', { on: true, hour: 8, tz: 'Europe/Stockholm' });
    now = at('2026-10-14T06:30:00Z');
    expect((await digest.sweep()).sent).toBe(0);
    expect(mailer.send).not.toHaveBeenCalled();
    now = at('2026-10-14T07:30:00Z');
    expect((await digest.sweep()).sent).toBe(0);
    expect(mailer.send).not.toHaveBeenCalled();
  });
});

describe('what the mail says', () => {
  const CANARY = 'CANARY-7f3a';
  it('names who, what and where, and never the text of a message, comment, card or ticket', async () => {
    const now = at('2026-10-13T09:00:00Z');
    const rows = [
      item({ kind: 'chat_mention', at: now - 1, actor: { id: 'ana', name: 'Ana' }, board: null, team: { id: 't1', name: 'Retro team' }, snippet: `${CANARY} message body` }),
      item({ kind: 'comment_mention', at: now - 2, actor: { id: 'ben', name: 'Ben' }, snippet: `${CANARY} comment text` }),
      item({ kind: 'comment_reply', at: now - 3, snippet: `${CANARY} reply` }),
      item({ kind: 'card_assigned', at: now - 4, actor: { id: 'ben', name: 'Ben' }, snippet: `${CANARY} card title` }),
      item({ kind: 'ticket_status', at: now - 5, actor: null, board: null, snippet: `${CANARY} ticket title`, target: '/t/TAB-12' }),
      item({ kind: 'team_joined', at: now - 6, board: null, team: { id: 't2', name: 'Design' } }),
    ];
    const { directory, notifications } = setup([{ id: 'ana' }], rows);
    directory.setPref('ana', 'notify.digest', '1');
    directory.setPref('ana', 'notify.digestHour', '0');
    directory.setPref('ana', 'notify.tz', 'UTC');
    directory.setPref('ana', 'notify.digestLastAt', String(now - 3600_000));
    const { sent, mailer } = mailbox();
    const digest = createDigest({ directory, notifications, mailer, baseUrl: 'https://t.example', now: () => now });
    expect((await digest.sweep()).sent).toBe(1);
    expect(sent[0].params.lines).toEqual([
      'Ana mentioned you in Retro team chat',
      'Ben mentioned you in a comment on Launch plan',
      'Ana replied to your comment on Launch plan',
      'Ben assigned you a card on Launch plan',
      'Your ticket TAB-12 changed',
      'Ana joined Design',
    ]);
    const shown = JSON.stringify({ subject: sent[0].subject, text: sent[0].text, params: sent[0].params });
    expect(shown).not.toContain(CANARY);
  });

  it('keeps each line to 120 characters and free of control characters', () => {
    const long = item({ kind: 'board_shared', at: 1, actor: { id: 'x', name: `A\u0000\n${'n'.repeat(200)}` }, board: { id: 'b', title: 'T​\u0007' } });
    const [line] = digestLines([long]).lines;
    expect(Array.from(line).length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(/[\p{Cc}\p{Cf}]/u.test(line)).toBe(false);
  });

  it('gives each kind its sentence, and a tracker row only its key', () => {
    expect(sentenceFor({ kind: 'card_overdue', actor: null, board: { title: 'Ops' } })).toBe('A card is overdue on Ops');
    expect(sentenceFor({ kind: 'chat_mention', actor: { name: 'Ana' }, board: { title: 'Ops' }, team: null })).toBe('Ana mentioned you in Ops chat');
    expect(sentenceFor({ kind: 'chat_mention', actor: null, board: null, team: null })).toBe('Someone mentioned you in the workspace chat');
    expect(sentenceFor({ kind: 'ticket_commented', actor: { name: 'Ana' }, target: '/t/TAB-9' })).toBe('Your ticket TAB-9 changed');
    expect(sentenceFor({ kind: 'ticket_assigned', actor: null, target: '/t/x%20y' })).toBe('Your ticket changed');
  });
});

describe('the digest settings', () => {
  it('is off by default, with hour 8 and UTC', () => {
    const { directory, notifications } = setup([{ id: 'ana' }]);
    const digest = createDigest({ directory, notifications, mailer: mailbox().mailer, baseUrl: 'https://t.example' });
    expect(digest.get('ana')).toEqual({ on: false, hour: 8, tz: 'UTC' });
  });

  it('parses a strict body: booleans, whole hours 0-23, zones, at least one field, nothing else', () => {
    expect(parseDigestPatch({ on: true, hour: 0, tz: 'UTC' })).toEqual({ on: true, hour: 0, tz: 'UTC' });
    for (const bad of [null, [], {}, { on: 'yes' }, { hour: 24 }, { hour: 8.5 }, { hour: '8' }, { tz: 'Nowhere/Land' }, { quiet: true }]) {
      expect(() => parseDigestPatch(bad)).toThrow(TypeError);
    }
  });
});

describe('the digest routes', () => {
  const thrownCode = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'nothing thrown';
  };
  /** The routes with a compile stub that keeps the handler per method and path, and the errors as thrown objects. */
  function routes(now = () => at('2026-10-13T04:00:00Z')) {
    const { directory, notifications } = setup([{ id: 'ana' }, { id: 'gus', role: 'guest' }]);
    const digest = createDigest({ directory, notifications, mailer: mailbox().mailer, baseUrl: 'https://t.example', now });
    const table = createNotificationRoutes({
      notifications: { prefs: { get: () => ({}), set: () => ({}) }, list: () => ({}), unread: () => ({}), markRead: () => ({}) },
      digest,
      compile: (method: string, path: string, _opts: unknown, handler: (ctx: any) => unknown) => ({ key: `${method} ${path}`, handler }),
      errors: {
        badRequest: (m: string) => Object.assign(new Error(m), { status: 400, code: 'bad_request' }),
        forbidden: (m: string) => Object.assign(new Error(m), { status: 403, code: 'forbidden' }),
        invalidInput: (m: string) => Object.assign(new Error(m), { status: 400, code: 'invalid_input' }),
      },
    }) as Array<{ key: string; handler: (ctx: any) => [number, unknown] }>;
    const call = (key: string, ctx: unknown) => table.find((r) => r.key === key)!.handler(ctx);
    return { call, directory };
  }
  const ana = { id: 'ana', role: 'member' };
  const guest = { id: 'gus', role: 'guest', guest: true };

  it('answers the shape, and round-trips a valid PUT', () => {
    const { call } = routes();
    expect(call('GET notifications/digest', { user: ana })).toEqual([200, { digest: { on: false, hour: 8, tz: 'UTC' } }]);
    expect(call('PUT notifications/digest', { user: ana, body: { on: true, hour: 7, tz: 'Europe/Stockholm' } })).toEqual([200, { digest: { on: true, hour: 7, tz: 'Europe/Stockholm' } }]);
    expect(call('GET notifications/digest', { user: ana })[1]).toEqual({ digest: { on: true, hour: 7, tz: 'Europe/Stockholm' } });
    expect(call('PUT notifications/digest', { user: ana, body: { hour: 23 } })[1]).toEqual({ digest: { on: true, hour: 23, tz: 'Europe/Stockholm' } });
  });

  it('refuses bad bodies with invalid_input, and guests with forbidden', () => {
    const { call } = routes();
    for (const body of [{}, { on: 1 }, { hour: 24 }, { hour: -1 }, { tz: 'Mars/Base' }, { on: true, extra: 1 }, [], null]) {
      expect(thrownCode(() => call('PUT notifications/digest', { user: ana, body }))).toBe('invalid_input');
    }
    expect(thrownCode(() => call('GET notifications/digest', { user: guest }))).toBe('forbidden');
    expect(thrownCode(() => call('PUT notifications/digest', { user: guest, body: { on: true } }))).toBe('forbidden');
  });

  it('turning on does not send anything at once', () => {
    const { call, directory } = routes(() => at('2026-10-13T04:00:00Z'));
    call('PUT notifications/digest', { user: ana, body: { on: true, hour: 8, tz: 'Europe/Stockholm' } });
    expect(directory.getPref('ana', 'notify.digestLastAt')).toBe(String(at('2026-10-13T04:00:00Z')));
    expect(directory.getPref('ana', 'notify.digestDay')).toBeNull();
  });
});
