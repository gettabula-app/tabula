import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { createApi } from '../server/api.mjs';
import { createKeyRing } from '../server/ai/keys.mjs';
import { createLiveRuns } from '../server/ai/live.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';

// Shared by the POST /api/ai/run tests (docs/ai.md, "Running a feature"). The API runs in this process behind a real
// HTTP server. A fake provider takes the place of the network, the rooms are plain Y.Docs, and the clock of the limits
// is the test's own: nothing here leaves the machine or holds a real key.

export const SECRET = crypto.randomBytes(32).toString('base64');
export const newKey = () => `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;
export const KEY = newKey();
export const canary = (tag: string) => `CANARY-${tag}-${crypto.randomBytes(6).toString('hex')}`;

export type Script = (req: any) => AsyncGenerator<any, void, unknown>;
export type Sse = { event: string; data: any };
export type RunRes = { status: number; headers: Headers; text: string; json: any; events: Sse[] };

/** A provider that fails as soon as it is asked to run. */
export const failing = (err: unknown): Script =>
  async function* () {
    yield* [];
    throw err;
  };

export const parseEvents = (text: string): Sse[] =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({ event: /^event: (.+)$/m.exec(block)![1], data: JSON.parse(/^data: (.+)$/m.exec(block)![1]) }));

export const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const stack: (() => Promise<void>)[] = [];
export const closeWorlds = async () => {
  for (const close of stack.splice(0).reverse()) await close();
};

/** Puts a sticky into a board document. */
export function sticky(doc: Y.Doc, id: string, text: string, extra: Record<string, unknown> = {}) {
  doc.getMap('objects').set(id, new Y.Map(Object.entries({ type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: id, fill: '#FFE16B', text, ...extra })));
}

export function put(doc: Y.Doc, id: string, fields: Record<string, unknown>) {
  doc.getMap('objects').set(id, new Y.Map(Object.entries({ x: 0, y: 0, w: 192, h: 192, rotation: 0, z: id, ...fields })));
}

export type Role = 'owner' | 'admin' | 'member' | 'guest';

export async function setup(options: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-run-'));
  const config = loadConfig(
    { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', DATA_DIR: dir, TABULA_MAIL: 'file', TABULA_AI_SECRET: SECRET, ...options.env },
    () => {},
  );
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} } });
  const ring = createKeyRing({ secret: config.ai.secret });

  const state = {
    readOnly: false,
    t: 1_000_000,
    script: null as Script | null,
    // by default: one note, and a frame when the feature asks for one
    answer: ((req: any) => (req.schema?.required?.includes('frame') ? { objects: [{ text: 'A risk' }], frame: { title: 'Summary' } } : { objects: [{ text: 'A risk' }] })) as unknown,
    verify: async (): Promise<void> => {},
  };
  const calls: any[] = [];
  const made: { kind: string; apiKey: string }[] = [];
  const logged: unknown[][] = [];
  const docs = new Map<string, Y.Doc>();
  const reads: string[] = [];
  const docOf = (name: string) => {
    if (!docs.has(name)) docs.set(name, new Y.Doc());
    return docs.get(name)!;
  };

  const canWriteRoom = (role: string, kind: string) =>
    !state.readOnly && (kind === 'board' ? role === 'owner' || role === 'editor' : ['owner', 'editor', 'commenter'].includes(role));
  const answerFor = (req: any) => (typeof state.answer === 'function' ? (state.answer as (r: any) => unknown)(req) : state.answer);
  const standard: Script = async function* (req) {
    yield { type: 'progress' };
    yield { type: 'result', value: answerFor(req), usage: { model: req.model, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 1000, cacheWriteTokens: 0 } };
  };
  const createProvider = ({ kind, apiKey }: { kind: string; apiKey: string }) => {
    made.push({ kind, apiKey });
    return {
      kind,
      models: () => [],
      verify: () => state.verify(),
      run: (req: any) => {
        calls.push(req);
        return (state.script ?? standard)(req);
      },
    };
  };
  const live = createLiveRuns({ now: () => state.t });
  const cloud = { limits: () => ({ readOnly: state.readOnly, seatLimit: null, banner: null }), workspaceView: () => ({}), seatsAvailable: () => true, tokenOk: () => false };

  const api = createApi({
    directory,
    auth,
    config,
    roomExists: () => false,
    events: new EventEmitter(),
    mailer: { send: async () => {} },
    cloud: cloud as any,
    ai: {
      createProvider,
      log: (...args: unknown[]) => logged.push(args),
      canWriteRoom,
      readRoom: (name: string, fn: (doc: Y.Doc) => unknown) => {
        reads.push(name);
        return fn(docOf(name));
      },
      now: () => state.t,
      live,
      timeoutMs: options.timeoutMs,
    },
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  stack.push(async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    directory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;
  const person = (role: Role, name = role) => {
    const user = directory.createUser({ email: `${name}${++n}-${crypto.randomBytes(3).toString('hex')}@example.com`, role })!;
    const session = directory.createSession(user.id, { ttlMs: 3_600_000 });
    return { user, cookie: `${config.cookieName}=${session.token}` };
  };
  type Who = ReturnType<typeof person>;

  /** A board in the directory (owned by `owner`) with an empty room document. */
  const board = (owner: Who, title = 'Roadmap') => {
    const id = `board${++n}x${crypto.randomBytes(3).toString('hex')}`;
    directory.createBoard({ id, title, ownerId: owner.user.id });
    return id;
  };
  const share = (boardId: string, who: Who, role: 'editor' | 'commenter' | 'viewer') =>
    directory.shareBoard(boardId, { principalType: 'user', principalId: who.user.id, role });

  /** AI on, a workspace key stored. `extra` are ai.* settings (without the prefix). */
  const enable = (extra: Record<string, string> = {}, key = KEY) => {
    directory.setSetting('ai.enabled', '1');
    directory.saveAiKey({ ring, scope: 'workspace', provider: 'anthropic', apiKey: key });
    for (const [name, value] of Object.entries(extra)) directory.setSetting(`ai.${name}`, value);
  };

  const run = async (who: Who | null, body: unknown, options: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<RunRes> => {
    const res = await fetch(`${base}/api/ai/run`, {
      method: 'POST',
      headers: { 'x-tabula': '1', 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}), ...options.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: options.signal,
    });
    const text = await res.text();
    const stream = (res.headers.get('content-type') ?? '').startsWith('text/event-stream');
    return { status: res.status, headers: res.headers, text, json: stream || !text ? undefined : JSON.parse(text), events: stream ? parseEvents(text) : [] };
  };

  const call = async (who: Who | null, method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(base + urlPath, {
      method,
      headers: { 'x-tabula': '1', ...(who ? { cookie: who.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined, text };
  };

  const audits = () =>
    (directory.listAudit(200) as unknown as { action: string; detail: any; actorId: string | null }[]).filter(
      (a) => a.action.startsWith('ai.') && !['ai.settings', 'ai.key.set', 'ai.key.delete'].includes(a.action),
    );

  return { dir, config, directory, ring, live, state, calls, made, logged, docs, docOf, reads, person, board, share, enable, run, call, audits, base };
}

export type World = Awaited<ReturnType<typeof setup>>;
export type Who = ReturnType<World['person']>;

const FENCE = /\[board-content nonce=([0-9a-f]{16})\]\n([\s\S]*)\n\[\/board-content nonce=\1\]/;
/** The parts of the content a run sent: the fenced JSON, what came before it and what came after it. */
export function fenced(content: string) {
  const m = FENCE.exec(content);
  if (!m) throw new Error('no fenced board content');
  return { nonce: m[1], payload: JSON.parse(m[2]), before: content.slice(0, m.index), after: content.slice(m.index + m[0].length), text: m[2] };
}
