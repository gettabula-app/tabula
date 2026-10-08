import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

// docs/comment-authz.md over real sockets, in accounts mode: the relay corrects what a person's rules forbid, tells
// only that person (message type 5), and every client converges on the corrected threads.

const ACCOUNTS_PORT = 25000 + Math.floor(Math.random() * 900);
const OWNER = 'owner@example.com';
const COMMENTS = '~comments';
const MSG_COMMENT_NOTICE = 5;

type Body = any;
type Res = { status: number; body: Body; headers: Headers };
type Account = { cookie: string; user: Body; email: string };

const startRelay = (port: number, dir: string, env: Record<string, string>) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ['server/relay.mjs'], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout!.on('data', (d) => String(d).includes('Tabula relay') && resolve(p));
    p.stderr!.on('data', () => {});
    p.on('error', reject);
    setTimeout(() => reject(new Error('relay did not start')), 15_000);
  });

const stopRelay = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGTERM');
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
};

describe('comment authorship over the relay (accounts mode)', { timeout: 30_000 }, () => {
  const baseUrl = `http://127.0.0.1:${ACCOUNTS_PORT}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-comment-authz-'));
  const outbox = path.join(dataDir, 'outbox.jsonl');
  let relay: ChildProcess;
  let owner: Account;

  let seq = 0;
  const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;
  const emailOf = (tag: string) => `${unique(tag)}@example.com`;
  let ipSeq = 0;
  const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.7`;

  async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        'x-tabula': '1',
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  type Mail = { to: string; subject: string; text: string };
  const mailCount = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0);
  const mailsSince = (n: number): Mail[] =>
    fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
  const tokenOf = (mail: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);

  async function signIn(email: string, invite?: string): Promise<Account> {
    const before = mailCount();
    const res = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': nextIp() });
    const mails = mailCount() > before ? mailsSince(before) : [];
    if (res.status !== 200 || mails.length !== 1) throw new Error(`no sign-in mail for ${email} (status ${res.status})`);
    const verify = await api(undefined, 'POST', '/api/auth/verify', { token: tokenOf(mails[0]) });
    if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
    const cookie = /tabula_session=[^;]+/.exec(verify.headers.getSetCookie()[0])![0];
    return { cookie, user: verify.body.user, email };
  }

  async function newTeam(cookie: string) {
    const res = await api(cookie, 'POST', '/api/teams', { name: unique('Team') });
    if (res.status !== 201) throw new Error(`could not create a team (${res.status})`);
    return res.body as Body;
  }

  /** Joins a team by invite; `role` is the team role the invite grants ('member' or 'admin'). */
  async function joinTeam(adminCookie: string, teamId: string, role: 'member' | 'admin' = 'member') {
    const invite = await api(adminCookie, 'POST', `/api/teams/${teamId}/invites`, { role });
    if (invite.status !== 201) throw new Error(`could not create an invite (${invite.status})`);
    return signIn(emailOf('user'), invite.body.token);
  }

  async function newBoard(cookie: string, extra: Record<string, unknown> = {}) {
    const id = unique('board');
    const res = await api(cookie, 'POST', '/api/boards', { id, ...extra });
    if (res.status !== 201) throw new Error(`could not create a board (${res.status} ${JSON.stringify(res.body)})`);
    return id;
  }

  const share = (cookie: string, board: string, userId: string, role: string) =>
    api(cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: userId, role });

  // ------------------------------------------------------------ websocket helpers

  const sockets = new Set<WebSocket>();
  const providers = new Set<WebsocketProvider>();

  afterEach(() => {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    for (const p of providers) p.destroy();
    providers.clear();
  });

  const wsFor = (cookie: string) =>
    class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, { headers: { Origin: baseUrl, Cookie: cookie } });
      }
    };

  type Conn = { doc: Y.Doc; provider: WebsocketProvider; notes: Array<{ undone: string[] }> };

  /**
   * Opens a room as `cookie`. The notes list collects the relay's notices to this socket (message type 5). Pass `doc`
   * to reuse a document that already has changes (an offline batch sent on reconnect).
   */
  function open(room: string, cookie: string, doc = new Y.Doc()): Conn {
    const provider = new WebsocketProvider(`ws://127.0.0.1:${ACCOUNTS_PORT}/sync`, room, doc, {
      WebSocketPolyfill: wsFor(cookie) as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    providers.add(provider);
    const notes: Conn['notes'] = [];
    provider.messageHandlers[MSG_COMMENT_NOTICE] = (_encoder, decoder) => {
      notes.push(JSON.parse(decoding.readVarString(decoder)));
    };
    return { doc, provider, notes };
  }
  const synced = (c: Conn) => until(() => c.provider.wsconnected && c.provider.synced);
  const close = (c: Conn) => {
    c.provider.destroy();
    providers.delete(c.provider);
  };

  /** A comment thread as a client writes it. `author` is whoever the client says wrote it. */
  const thread = (id: string, author: Body, text = 'Hello', extra: Record<string, unknown> = {}) => {
    const m = new Y.Map<unknown>([
      ['id', id], ['createdAt', 1], ['authorId', author.id], ['authorName', author.name], ['authorColor', '#123'],
      ['text', text], ['anchor', { x: 0, y: 0 }], ['resolved', false], ...Object.entries(extra),
    ]);
    m.set('replies', new Y.Map());
    return m;
  };
  const threadsOf = (c: Conn) => c.doc.getMap('threads');
  const commentsRoom = (board: string) => `${board}${COMMENTS}`;

  // ------------------------------------------------------------ setup

  /** A personal board owned by `creator`; `person(role)` makes a new user and shares the board with them in that role. */
  async function setup() {
    const team = await newTeam(owner.cookie);
    const creator = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(creator.cookie);
    const person = async (role: 'editor' | 'commenter' | 'viewer') => {
      const who = await joinTeam(owner.cookie, team.id);
      const res = await share(creator.cookie, board, who.user.id, role);
      if (res.status !== 201) throw new Error(`could not share (${res.status})`);
      return who;
    };
    return { team, creator, board, person };
  }

  beforeAll(async () => {
    relay = await startRelay(ACCOUNTS_PORT, dataDir, {
      TABULA_AUTH: 'on',
      TABULA_OWNER_EMAIL: OWNER,
      TABULA_MAIL: 'file',
      TABULA_BASE_URL: baseUrl,
      TABULA_TRUST_PROXY: '1',
    });
    owner = await signIn(OWNER);
  });

  afterAll(async () => {
    if (relay && relay.exitCode === null && relay.signalCode === null) await stopRelay(relay);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ the rules

  it('stamps a forged author, tells only the sender, and every client ends up with the corrected thread', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    const room = commentsRoom(board);
    const owners = open(room, creator.cookie);
    await synced(owners);
    const anas = open(room, ana.cookie, (() => {
      const doc = new Y.Doc();
      doc.getMap('threads').set('forged', thread('forged', ben, 'Posted as Ben'));
      return doc;
    })());
    await synced(anas);
    await until(() => threadsOf(owners).has('forged'));

    expect(threadsOf(owners).get('forged')!.toJSON()).toMatchObject({ authorId: ana.user.id, authorName: ana.user.name, text: 'Posted as Ben' });
    expect(threadsOf(anas).get('forged')!.toJSON()).toMatchObject({ authorId: ana.user.id, authorName: ana.user.name });
    await until(() => anas.notes.length === 1);
    expect(anas.notes).toEqual([{ undone: ['author'] }]);
    expect(owners.notes).toEqual([]);

    // a client that joins later gets the corrected thread, not the forged one
    const bens = open(room, ben.cookie);
    await synced(bens);
    await until(() => threadsOf(bens).has('forged'));
    expect(threadsOf(bens).get('forged')!.toJSON()).toMatchObject({ authorId: ana.user.id, authorName: ana.user.name });
    expect(bens.notes).toEqual([]);
  });

  it('lets a team admin, who is not the board owner, delete a member\'s comment but not edit it', async () => {
    const team = await newTeam(owner.cookie);
    const admin = await joinTeam(owner.cookie, team.id, 'admin');
    const member = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(member.cookie, { teamId: team.id });
    const room = commentsRoom(board);
    const members = open(room, member.cookie, (() => {
      const doc = new Y.Doc();
      doc.getMap('threads').set('t1', thread('t1', member, 'Mine'));
      return doc;
    })());
    await synced(members);
    const admins = open(room, admin.cookie);
    await synced(admins);
    await until(() => threadsOf(admins).has('t1'));

    admins.doc.transact(() => threadsOf(admins).get('t1')!.set('text', 'Moderated'));
    await until(() => admins.notes.length === 1);
    expect(admins.notes).toEqual([{ undone: ['edit'] }]);
    expect(threadsOf(members).get('t1')!.get('text')).toBe('Mine');

    admins.doc.transact(() => threadsOf(admins).delete('t1'));
    await until(() => !threadsOf(members).has('t1'));
    expect(admins.notes).toHaveLength(1); // a moderator's delete is allowed, so nothing is undone
    expect(threadsOf(admins).has('t1')).toBe(false);
  });

  it('checks an offline batch against the role at sync time', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const ed = await person('editor');
    const room = commentsRoom(board);
    const asked = open(room, ana.cookie, (() => {
      const doc = new Y.Doc();
      doc.getMap('threads').set('t1', thread('t1', ana, 'Ana asks a question'));
      return doc;
    })());
    await synced(asked);
    close(asked);
    const owners = open(room, creator.cookie);
    await synced(owners);
    await until(() => threadsOf(owners).has('t1'));

    // Ed syncs, goes offline, resolves the thread (as an editor may), and comes back after being made a commenter
    const edDoc = new Y.Doc();
    const first = open(room, ed.cookie, edDoc);
    await synced(first);
    await until(() => threadsOf(first).has('t1'));
    close(first);
    edDoc.transact(() => {
      threadsOf(first).get('t1')!.set('resolved', true);
      threadsOf(first).get('t1')!.set('resolvedBy', ed.user.id);
    });
    expect((await share(creator.cookie, board, ed.user.id, 'commenter')).status).toBe(201);

    const back = open(room, ed.cookie, edDoc);
    await synced(back);
    await until(() => back.notes.length === 1);
    expect(back.notes).toEqual([{ undone: ['resolve'] }]);
    await until(() => threadsOf(owners).get('t1')!.get('resolved') === false);
    expect(threadsOf(back).get('t1')!.get('resolved')).toBe(false);
    expect(owners.notes).toEqual([]);
  });

  it('lets a reply and a stranger\'s edit to the same thread from two sockets land together, and undoes the edit for both', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    const room = commentsRoom(board);
    const owners = open(room, creator.cookie, (() => {
      const doc = new Y.Doc();
      doc.getMap('threads').set('t1', thread('t1', ana, 'Original'));
      return doc;
    })());
    await synced(owners);
    const anas = open(room, ana.cookie);
    const bens = open(room, ben.cookie);
    await Promise.all([synced(anas), synced(bens)]);
    await until(() => threadsOf(bens).has('t1'));

    // both are sent at once, from two sockets that have not seen each other's change
    anas.doc.transact(() => (threadsOf(anas).get('t1')!.get('replies') as Y.Map<unknown>).set('r1', { id: 'r1', authorId: ana.user.id, authorName: ana.user.name, authorColor: '#123', text: 'Thanks', createdAt: 2 }));
    bens.doc.transact(() => threadsOf(bens).get('t1')!.set('text', 'Ben was here'));

    await until(() => bens.notes.length === 1 && (threadsOf(owners).get('t1')!.get('replies') as Y.Map<unknown>).has('r1'));
    await until(() => (threadsOf(anas).get('t1')!.get('replies') as Y.Map<unknown>).has('r1'));
    expect(bens.notes).toEqual([{ undone: ['edit'] }]);
    expect(anas.notes).toEqual([]);
    for (const c of [owners, anas, bens]) {
      expect(threadsOf(c).get('t1')!.get('text')).toBe('Original');
      expect((threadsOf(c).get('t1')!.get('replies') as Y.Map<unknown>).get('r1')).toMatchObject({ text: 'Thanks' });
    }
  });

  it('keeps the authors of an owner\'s import and marks them imported, and renames a commenter\'s forged import to the commenter', async () => {
    const { creator, board, person } = await setup();
    const ben = await person('commenter');
    const room = commentsRoom(board);
    const importer = open(room, creator.cookie, (() => {
      const doc = new Y.Doc();
      doc.getMap('threads').set('imp', thread('imp', { id: 'someone-from-another-board', name: 'Zed' }, 'From the file', { imported: true, importedBy: creator.user.id }));
      const m = doc.getMap('threads').get('imp') as Y.Map<unknown>;
      (m.get('replies') as Y.Map<unknown>).set('r1', { id: 'r1', authorId: 'someone-else', authorName: 'Yan', authorColor: '#123', text: 'Reply', createdAt: 2, imported: true, importedBy: creator.user.id });
      return doc;
    })());
    await synced(importer);
    const bens = open(room, ben.cookie, (() => {
      const doc = new Y.Doc();
      doc.getMap('threads').set('forged', thread('forged', { id: 'someone-from-another-board', name: 'Zed' }, 'Forged', { imported: true, importedBy: ben.user.id }));
      return doc;
    })());
    await synced(bens);
    await until(() => threadsOf(importer).has('forged'));

    expect(threadsOf(importer).get('imp')!.toJSON()).toMatchObject({ authorId: 'someone-from-another-board', authorName: 'Zed', imported: true, importedBy: creator.user.id });
    expect(threadsOf(importer).get('imp')!.toJSON().replies.r1).toMatchObject({ authorId: 'someone-else', imported: true });
    expect(threadsOf(importer).get('forged')!.toJSON()).toMatchObject({ authorId: ben.user.id, authorName: ben.user.name });
    expect(threadsOf(importer).get('forged')!.toJSON().imported).toBeUndefined();
    await until(() => bens.notes.length === 1);
    expect(bens.notes).toEqual([{ undone: ['author'] }]);
    expect(importer.notes).toEqual([]);
  });

  it('marks comments from before accounts as legacy when the room loads: nobody edits them, and only a moderator deletes them', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const room = commentsRoom(board);
    // what the room held before accounts were turned on: a comment whose author is a device id
    const seed = new Y.Doc();
    seed.getMap('threads').set('old', thread('old', { id: '3b241101-e2bb-4255-8caf-4136c566a962', name: 'Clever Otter' }, 'From before accounts'));
    fs.writeFileSync(path.join(dataDir, `${room}.yjs`), Y.encodeStateAsUpdate(seed));

    const anas = open(room, ana.cookie);
    await synced(anas);
    await until(() => threadsOf(anas).has('old'));
    expect(threadsOf(anas).get('old')!.get('legacy')).toBe(true);
    anas.doc.transact(() => threadsOf(anas).get('old')!.set('text', 'Changed'));
    await until(() => anas.notes.length === 1);
    expect(anas.notes).toEqual([{ undone: ['edit'] }]);
    expect(threadsOf(anas).get('old')!.get('text')).toBe('From before accounts');

    const owners = open(room, creator.cookie);
    await synced(owners);
    await until(() => threadsOf(owners).has('old'));
    owners.doc.transact(() => threadsOf(owners).delete('old'));
    await until(() => !threadsOf(anas).has('old'));
    expect(owners.notes).toEqual([]);
  });
});
