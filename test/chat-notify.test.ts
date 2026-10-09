import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChat } from '../server/chat.mjs';
import { MAIL_AFTER_MS, PREF_EMAIL_MENTIONS, SNIPPET_CHARS, createChatNotifier, emailsMentions, linkFor, snippetOf } from '../server/chat-notify.mjs';

// docs/chat.md, Mentions: an in-app notice for people with the app open, an email for people without, once, later, only
// if the mention is still unread, and never real mail: the mailer here is a list.

type Mail = { to: string; subject: string; text: string; template?: string; params?: Record<string, string> };
const T0 = Date.UTC(2026, 9, 9, 12);
let clock = T0;
const stores: ReturnType<typeof openChat>[] = [];

function world(extra: { prefs?: Record<string, string>; sockets?: Record<string, 'sent' | 'looking' | 'offline'>; seen?: Record<string, number>; readable?: (id: string) => boolean } = {}) {
  const store = openChat(':memory:');
  stores.push(store);
  const mails: Mail[] = [];
  const notices: { userId: string; frame: any }[] = [];
  const people: Record<string, any> = {
    ana: { id: 'ana', name: 'Ana Lima', email: 'ana@example.test' },
    ben: { id: 'ben', name: 'Ben Okafor', email: 'ben@example.test' },
    cy: { id: 'cy', name: 'Cy Dahl', email: 'cy@example.test' },
    off: { id: 'off', name: 'Off', email: 'off@example.test', disabled: true },
  };
  const prefs: Record<string, string> = { ...extra.prefs };
  const directory = {
    getUser: (id: string) => people[id] ?? null,
    getBoard: (id: string) => (id === 'b1' ? { title: 'Roadmap 2026' } : null),
    getTeam: (id: string) => (id === 't1' ? { name: 'Design' } : null),
    getPref: (id: string, key: string) => prefs[`${id}/${key}`] ?? null,
  };
  const sockets = extra.sockets ?? {};
  const seen = extra.seen ?? {};
  const hub = {
    notice: (userId: string, _kind: string, _ref: string, frame: any) => {
      const state = sockets[userId] ?? 'offline';
      if (state === 'sent') notices.push({ userId, frame });
      return state;
    },
    activeSince: (userId: string, since: number) => (seen[userId] ?? 0) >= since,
  };
  const mailer = { send: async (m: Mail) => void mails.push(m) };
  const notifier = createChatNotifier({
    directory, store: () => store, hub, mailer, access: (user: { id: string }) => ({ read: extra.readable ? extra.readable(user.id) : true }),
    baseUrl: 'https://tabula.example/', now: () => clock, timers: false,
  });
  const say = (body: string, mentions: string[], extra2: { kind?: string; ref?: string; author?: string } = {}) =>
    store.insertMessage({ kind: extra2.kind ?? 'board', ref: extra2.ref ?? 'b1', authorId: extra2.author ?? 'ana', authorName: people[extra2.author ?? 'ana'].name, body, clientId: `c-${Math.random().toString(36).slice(2)}-x`, mentions, now: clock }).message;
  return { store, mails, notices, notifier, say, prefs, seen, directory, people };
}

beforeEach(() => {
  clock = T0;
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe('snippetOf', () => {
  it('shows mention tokens as names, on one line, cut at 140 characters', () => {
    expect(snippetOf('Thanks @{ben},\n can you  check?', (id) => (id === 'ben' ? 'Ben' : null))).toBe('Thanks @Ben, can you check?');
    expect(snippetOf('hi @{gone}', () => null)).toBe('hi @someone');
    const long = snippetOf('x'.repeat(300), () => null);
    expect(long).toHaveLength(SNIPPET_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('links to the board or to the channel on the Chat page', () => {
    expect(linkFor('https://t.example/', 'board', 'b1')).toBe('https://t.example/#/b/b1');
    expect(linkFor('https://t.example', 'team', 't1')).toBe('https://t.example/#/chat/team/t1');
    expect(linkFor('https://t.example', 'workspace', 'main')).toBe('https://t.example/#/chat/workspace/main');
  });
});

describe('who is told how', () => {
  it('sends the in-app notice to a person with the app open and no email', async () => {
    const w = world({ sockets: { ben: 'sent' } });
    const m = w.say('@{ben} look', ['ben']);
    expect(w.notifier.mentioned({ message: m, added: ['ben'] })).toEqual({ notified: ['ben'], queued: [] });
    expect(w.notices[0].frame).toMatchObject({ t: 'mention', kind: 'board', ref: 'b1', id: m.id, from: { id: 'ana', name: 'Ana Lima' }, channel: 'Roadmap 2026', text: '@Ben Okafor look' });
    expect(w.notifier.size()).toBe(0);
    clock += MAIL_AFTER_MS * 2;
    expect(await w.notifier.flush()).toEqual([]);
    expect(w.mails).toEqual([]);
  });

  it('says nothing more to a person who is looking at the channel', () => {
    const w = world({ sockets: { ben: 'looking' } });
    const m = w.say('@{ben}', ['ben']);
    expect(w.notifier.mentioned({ message: m, added: ['ben'] })).toEqual({ notified: [], queued: [] });
    expect(w.notices).toEqual([]);
    expect(w.notifier.size()).toBe(0);
  });

  it('queues an email for a person with no socket, and sends nothing before its time', async () => {
    const w = world();
    const m = w.say('@{ben} look', ['ben']);
    expect(w.notifier.mentioned({ message: m, added: ['ben'] }).queued).toEqual(['ben']);
    clock += MAIL_AFTER_MS - 1;
    expect(await w.notifier.flush()).toEqual([]);
    expect(w.mails).toEqual([]);
    clock += 1;
    expect(await w.notifier.flush()).toEqual(['sent']);
    expect(w.mails).toHaveLength(1);
  });

  it('writes a generic subject, the sender and the first 140 characters, and a link, with the template for a mail relay', async () => {
    const w = world();
    const m = w.say(`@{ben} ${'long '.repeat(60)}`, ['ben']);
    w.notifier.mentioned({ message: m, added: ['ben'] });
    await w.notifier.flush({ all: true });
    const mail = w.mails[0];
    expect(mail.to).toBe('ben@example.test');
    expect(mail.subject).toBe('You were mentioned in Roadmap 2026');
    expect(mail.text).toContain('Ana Lima mentioned you in Roadmap 2026');
    expect(mail.text).toContain('https://tabula.example/#/b/b1');
    expect(mail.text).toContain('@Ben Okafor long long');
    expect(mail.text).not.toContain('long '.repeat(60));
    expect(mail.template).toBe('chat-mention');
    expect(mail.params).toMatchObject({ channel: 'Roadmap 2026', sender: 'Ana Lima', link: 'https://tabula.example/#/b/b1' });
  });

  it('names a team channel and links it on the Chat page', async () => {
    const w = world();
    const m = w.say('@{ben} hi', ['ben'], { kind: 'team', ref: 't1' });
    w.notifier.mentioned({ message: m, added: ['ben'] });
    await w.notifier.flush({ all: true });
    expect(w.mails[0].subject).toBe('You were mentioned in Design');
    expect(w.mails[0].text).toContain('https://tabula.example/#/chat/team/t1');
  });

  it('never tells the author, a disabled person, or a person who cannot read the channel', () => {
    const w = world({ readable: (id) => id !== 'cy' });
    const m = w.say('@{ana} @{off} @{cy} @{nobody}', ['ana', 'off', 'cy', 'nobody']);
    expect(w.notifier.mentioned({ message: m, added: ['ana', 'off', 'cy', 'nobody'] })).toEqual({ notified: [], queued: [] });
    expect(w.notifier.size()).toBe(0);
  });
});

describe('when the email does not go', () => {
  const queued = (w: ReturnType<typeof world>, who = 'ben') => {
    const m = w.say(`@{${who}} look`, [who]);
    w.notifier.mentioned({ message: m, added: [who] });
    return m;
  };

  it('stays unsent when the person turned mentions off, before or after the mention', async () => {
    const before = world({ prefs: { [`ben/${PREF_EMAIL_MENTIONS}`]: '0' } });
    queued(before);
    expect(before.notifier.size()).toBe(0);
    const after = world();
    queued(after);
    after.prefs[`ben/${PREF_EMAIL_MENTIONS}`] = '0';
    expect(await after.notifier.flush({ all: true })).toEqual(['opted-out']);
    expect(after.mails).toEqual([]);
  });

  it('stays unsent when the person opened the app in the meantime, even if they left again', async () => {
    const w = world();
    queued(w);
    clock += 60_000;
    w.seen.ben = clock;
    expect(await w.notifier.flush({ all: true })).toEqual(['seen']);
    expect(w.mails).toEqual([]);
  });

  it('stays unsent when they read it, or it was edited away or deleted', async () => {
    const read = world();
    const m1 = queued(read);
    read.store.markRead('ben', 'board', 'b1', m1.id);
    expect(await read.notifier.flush({ all: true })).toEqual(['read']);

    const edited = world();
    const m2 = queued(edited);
    edited.store.editMessage(m2.id, 'no mention now', []);
    expect(await edited.notifier.flush({ all: true })).toEqual(['withdrawn']);

    const deleted = world();
    const m3 = queued(deleted);
    deleted.store.deleteMessage(m3.id, 'ana');
    expect(await deleted.notifier.flush({ all: true })).toEqual(['withdrawn']);
    expect([...read.mails, ...edited.mails, ...deleted.mails]).toEqual([]);
  });

  it('forgets a queued email when the mention is withdrawn', async () => {
    const w = world();
    const m = queued(w);
    w.notifier.withdraw(m.id, ['ben']);
    expect(w.notifier.size()).toBe(0);
    expect(await w.notifier.flush({ all: true })).toEqual([]);
  });

  it('stays unsent when the person lost access, or is disabled', async () => {
    let allowed = true;
    const w = world({ readable: () => allowed });
    queued(w);
    allowed = false;
    expect(await w.notifier.flush({ all: true })).toEqual(['no-access']);
    const d = world();
    queued(d);
    d.people.ben.disabled = true;
    expect(await d.notifier.flush({ all: true })).toEqual(['no-person']);
  });
});

describe('how often', () => {
  it('queues one email per channel per person, whatever is said meanwhile', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) w.notifier.mentioned({ message: w.say(`@{ben} ${i}`, ['ben']), added: ['ben'] });
    expect(w.notifier.size()).toBe(1);
    await w.notifier.flush({ all: true });
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0].text).toContain('@Ben Okafor 0');
  });

  it('sends nothing a second time for the same message, for instance after an edit', async () => {
    const w = world();
    const m = w.say('@{ben} one', ['ben']);
    w.notifier.mentioned({ message: m, added: ['ben'] });
    await w.notifier.flush({ all: true });
    w.notifier.mentioned({ message: m, added: ['ben'] });
    expect(w.notifier.size()).toBe(0);
    expect(w.mails).toHaveLength(1);
  });

  it('allows one email per person per channel in ten minutes', async () => {
    const w = world();
    w.notifier.mentioned({ message: w.say('@{ben} one', ['ben']), added: ['ben'] });
    await w.notifier.flush({ all: true });
    clock += 5 * 60_000;
    w.notifier.mentioned({ message: w.say('@{ben} two', ['ben']), added: ['ben'] });
    expect(await w.notifier.flush({ all: true })).toEqual(['limited']);
    clock += 6 * 60_000;
    w.notifier.mentioned({ message: w.say('@{ben} three', ['ben']), added: ['ben'] });
    expect(await w.notifier.flush({ all: true })).toEqual(['sent']);
    expect(w.mails).toHaveLength(2);
  });

  it('allows twenty emails a day per person, across channels', async () => {
    const w = world();
    for (let i = 0; i < 22; i++) {
      w.notifier.mentioned({ message: w.say(`@{ben} ${i}`, ['ben'], { ref: `board${i}` }), added: ['ben'] });
      await w.notifier.flush({ all: true });
    }
    expect(w.mails).toHaveLength(20);
    clock += 24 * 60 * 60_000 + 1;
    w.notifier.mentioned({ message: w.say('@{ben} next day', ['ben'], { ref: 'boardX' }), added: ['ben'] });
    await w.notifier.flush({ all: true });
    expect(w.mails).toHaveLength(21);
  });

  it('keeps going when the mailer fails', async () => {
    const w = world();
    const m = w.say('@{ben} x', ['ben']);
    w.notifier.mentioned({ message: m, added: ['ben'] });
    const failing = createChatNotifier({
      directory: w.directory, store: () => w.store, hub: null, mailer: { send: async () => { throw new Error('smtp down'); } },
      access: () => ({ read: true }), baseUrl: 'https://t.example', now: () => clock, timers: false,
    });
    failing.mentioned({ message: m, added: ['ben'] });
    expect(await failing.flush({ all: true })).toEqual(['failed']);
  });
});

describe('the preference', () => {
  it('is on until a person turns it off', () => {
    const dir = (value: string | null) => ({ getPref: () => value });
    expect(emailsMentions(dir(null), 'u')).toBe(true);
    expect(emailsMentions(dir('1'), 'u')).toBe(true);
    expect(emailsMentions(dir('0'), 'u')).toBe(false);
  });
});
