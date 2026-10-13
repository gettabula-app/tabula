import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, until, type Account } from './mcp-harness';
import { budget } from './wait-budget';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// The email digest over the real server (docs/notifications.md, Digest; TAB-164 slice 4). The sweep runs every 400 ms here
// (TABULA_TEST_DIGEST_SWEEP_MS, honoured only under NODE_ENV=test). Mail goes to the file outbox, so the test reads what would
// have been sent.

const h = createHarness({ accounts: true });
let owner: Account;
let ana: Account;
let ben: Account;

// The file mode keeps to, subject and text only; the template and params go to a webhook (mailer.mjs).
type Outbox = { to: string; subject: string; text: string };
const outbox = (): Outbox[] => {
  const file = path.join(h.dir, 'outbox.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const digestMailsTo = (email: string) => outbox().filter((mail) => mail.subject === 'Your Tabula notifications' && mail.to === email);

/** Writes the digest prefs straight into the directory file: the hour is the current UTC hour, so the sweep finds it due. */
function prefsDirectly(userId: string, values: Record<string, string>) {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try {
    for (const [key, value] of Object.entries(values)) {
      db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, value);
    }
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  await h.start({ NODE_ENV: 'test', TABULA_TEST_DIGEST_SWEEP_MS: '400' });
  owner = await h.signInOwner();
  const team = await h.newTeam(owner.cookie);
  ana = await h.joinTeam(owner.cookie, team.id);
  ben = await h.joinTeam(owner.cookie, team.id);
});

afterEach(() => h.closeProviders());

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('the email digest over the relay', () => {
  it('starts off, and turning it on sends nothing at once', async () => {
    const off = await h.api(ana.cookie, 'GET', '/api/notifications/digest');
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ digest: { on: false, hour: 8, tz: 'UTC' } });
    expect((await h.api(ana.cookie, 'PUT', '/api/notifications/digest', { on: 'yes' })).status).toBe(400);
    expect((await h.api(undefined, 'GET', '/api/notifications/digest')).status).toBe(401);
    const on = await h.api(ana.cookie, 'PUT', '/api/notifications/digest', { on: true, hour: 0, tz: 'UTC' });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ digest: { on: true, hour: 0, tz: 'UTC' } });
    const board = await h.newBoard(owner.cookie, { title: 'Launch plan' });
    await h.share(owner.cookie, board, ana.user.id, 'viewer');
    await new Promise((resolve) => setTimeout(resolve, budget(1500)));
    expect(digestMailsTo(ana.email)).toHaveLength(0);
  });

  it('sends one mail with who and where for what is new, and no second one that day', async () => {
    // Ben never switched it on through the API, so nothing from the first test holds the day. The share comes first: the sweep
    // runs every 400 ms, so the prefs (with a cutoff an hour back and the due hour now) are written after the row exists.
    const board = await h.newBoard(owner.cookie, { title: 'Sprint board' });
    await h.share(owner.cookie, board, ben.user.id, 'viewer');
    const hour = new Date().getUTCHours();
    prefsDirectly(ben.user.id, {
      'notify.digest': '1',
      'notify.digestHour': String(hour),
      'notify.tz': 'UTC',
      'notify.digestLastAt': String(Date.now() - 60 * 60 * 1000),
    });
    await until(async () => digestMailsTo(ben.email).length >= 1, budget(20_000));
    await new Promise((resolve) => setTimeout(resolve, budget(1500)));
    const mails = digestMailsTo(ben.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain('You have 1 new notification:');
    expect(mails[0].text).toContain('- owner shared Sprint board with you');
    expect(mails[0].text).toContain('You get this email because the daily digest is turned on in Notification settings.');
  });
});
