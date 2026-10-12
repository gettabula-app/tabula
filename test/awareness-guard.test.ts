import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';
import { createAwarenessBucket, filterAwarenessUpdate, transferAwarenessOwnership, viewerAwarenessState, MAX_AWARENESS_UPDATE_BYTES } from '../server/awareness-guard.mjs';

const entry = (clientID: number, clock: number, state: unknown) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, clientID);
  encoding.writeVarUint(enc, clock);
  encoding.writeVarString(enc, JSON.stringify(state));
  return encoding.toUint8Array(enc);
};
const update = (...entries: Uint8Array[]) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const e of entries) encoding.writeUint8Array(enc, e);
  return encoding.toUint8Array(enc);
};
const decode = (u: Uint8Array) => {
  const a = new Awareness(new Y.Doc());
  const seen: Record<number, unknown> = {};
  a.on('update', ({ added, updated }: { added: number[]; updated: number[] }) => {
    for (const id of [...added, ...updated]) seen[id] = a.getStates().get(id);
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return import('y-protocols/awareness').then((m) => { m.applyAwarenessUpdate(a, u, 'test'); return seen; });
};

describe('takeover keeps the new owner state when the old socket closes', () => {
  it('moves ownership of an updated id and survives the old socket leaving', async () => {
    const { applyAwarenessUpdate, removeAwarenessStates } = await import('y-protocols/awareness');
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalState(null);
    const oldWs = {}, newWs = {};
    const conns = new Map<object, Set<number>>([[oldWs, new Set()], [newWs, new Set()]]);
    // same bookkeeping as Room: the 'update' listener registers only added ids
    awareness.on('update', ({ added, removed }: { added: number[]; removed: number[] }, conn: object) => {
      const ids = conns.get(conn);
      if (!ids) return;
      added.forEach((id) => ids.add(id));
      removed.forEach((id) => ids.delete(id));
    });
    const send = (ws: object, own: Set<number>, others: any[], clock: number, state: unknown) => {
      const v = filterAwarenessUpdate(update(entry(42, clock, state)), { own, others, self: { userId: 'u1', guest: false } });
      applyAwarenessUpdate(awareness, v.update as Uint8Array, ws);
      transferAwarenessOwnership(conns, ws, v.ids);
    };
    send(oldWs, conns.get(oldWs)!, [], 1, { user: { name: 'old' } });
    expect([...conns.get(oldWs)!]).toEqual([42]);
    // reconnect: the new socket takes over id 42 (an 'updated' id) while the old one lingers
    send(newWs, conns.get(newWs)!, [{ ids: conns.get(oldWs)!, userId: 'u1', guest: false }], 2, { user: { name: 'new' } });
    expect([...conns.get(newWs)!]).toEqual([42]);
    expect(conns.get(oldWs)!.size).toBe(0);
    // the old socket closes late: Room.leave removes its ids
    removeAwarenessStates(awareness, [...conns.get(oldWs)!], null);
    expect(awareness.getStates().get(42)).toEqual({ user: { name: 'new' } });
  });
});

describe('viewerAwarenessState', () => {
  const deps = { cleanValue: (v: unknown) => v, cleanName: (n: string) => n, fallbackColor: () => '#111111' };
  it('takes id and name from the socket, keeps cursor and a valid colour only', () => {
    const ws = { userId: 'u1', userName: 'Real' };
    const s = viewerAwarenessState({ cursor: { x: 1 }, user: { id: 'boss', name: 'Boss', color: '#AbCdEf', extra: 1 } }, ws, deps) as any;
    expect(s.cursor).toEqual({ x: 1 });
    expect(s.user).toEqual({ id: 'u1', name: 'Real', color: '#AbCdEf' });
    expect((viewerAwarenessState({ user: { color: 'red' } }, ws, deps) as any).user.color).toBe('#111111');
    expect((viewerAwarenessState({}, ws, deps) as any).user.id).toBe('u1');
    expect(viewerAwarenessState(null, ws, deps)).toBeNull();
  });
});

describe('createAwarenessBucket', () => {
  it('never limits a sustained 20 frames per second', () => {
    let t = 0;
    const b = createAwarenessBucket({ now: () => t });
    for (let i = 0; i < 2000; i++) { t += 50; expect(b.take()).toBe(true); }
  });
  it('limits a 200-frame burst to about the burst size and refills after idle', () => {
    let t = 0;
    const b = createAwarenessBucket({ now: () => t });
    let ok = 0;
    for (let i = 0; i < 200; i++) if (b.take()) ok++;
    expect(ok).toBe(40);
    t += 1000;
    ok = 0;
    for (let i = 0; i < 200; i++) if (b.take()) ok++;
    expect(ok).toBe(30);
    t += 60_000;
    ok = 0;
    for (let i = 0; i < 200; i++) if (b.take()) ok++;
    expect(ok).toBe(40);
  });
});

describe('filterAwarenessUpdate', () => {
  it('drops entries for client ids another socket controls and keeps own and new ones', async () => {
    const out = filterAwarenessUpdate(
      update(entry(1, 1, { user: { name: 'forged' } }), entry(2, 1, { user: { name: 'me' } }), entry(3, 1, { user: { name: 'new' } })),
      { own: new Set([2]), others: [{ ids: new Set([1]) }] },
    );
    expect(out.dropped).toBe(1);
    expect(await decode(out.update as Uint8Array)).toEqual({ 2: { user: { name: 'me' } }, 3: { user: { name: 'new' } } });
  });

  it('lets the same account take over an id from its lingering socket, but nobody else', () => {
    const u = update(entry(1, 5, { user: { name: 'me' } }));
    const held = (userId: string, guest = false) => [{ ids: new Set([1]), userId, guest }];
    expect(filterAwarenessUpdate(u, { own: new Set(), others: held('u1'), self: { userId: 'u1', guest: false } }).update).not.toBeNull();
    expect(filterAwarenessUpdate(u, { own: new Set(), others: held('u2'), self: { userId: 'u1', guest: false } }).update).toBeNull();
    expect(filterAwarenessUpdate(u, { own: new Set(), others: held('u1', true), self: { userId: 'u1', guest: false } }).update).toBeNull();
    expect(filterAwarenessUpdate(u, { own: new Set(), others: held('u1'), self: { userId: 'u1', guest: true } }).update).toBeNull();
    // the same guest session may reclaim its id; another guest or a member may not
    expect(filterAwarenessUpdate(u, { own: new Set(), others: held('g1', true), self: { userId: 'g1', guest: true } }).update).not.toBeNull();
    expect(filterAwarenessUpdate(u, { own: new Set(), others: held('g1', true), self: { userId: 'g2', guest: true } }).update).toBeNull();
    expect(filterAwarenessUpdate(u, { own: new Set(), others: held(''), self: { userId: '', guest: false } }).update).toBeNull();
  });

  it('drops a forged removal (null state) of a foreign client id', () => {
    const out = filterAwarenessUpdate(update(entry(1, 9, null)), { own: new Set(), others: [{ ids: new Set([1]) }] });
    expect(out.update).toBeNull();
    expect(out.dropped).toBe(1);
  });

  it('ignores an oversized update and caps ids per socket', () => {
    expect(filterAwarenessUpdate(new Uint8Array(MAX_AWARENESS_UPDATE_BYTES + 1), { own: new Set(), others: [] }).oversized).toBe(true);
    const many = update(...Array.from({ length: 12 }, (_, i) => entry(100 + i, 1, {})));
    const out = filterAwarenessUpdate(many, { own: new Set(), others: [] });
    expect(out.dropped).toBe(4);
  });

  it('sanitises accepted states with the clean callback (read-only viewer)', async () => {
    const out = filterAwarenessUpdate(update(entry(5, 1, { cursor: { x: 1 }, user: { name: 'v'.repeat(500), color: '#aabbcc' } })), {
      own: new Set(), others: [],
      clean: (s: any) => ({ ...s, user: { ...s.user, name: s.user.name.slice(0, 10) } }),
    });
    expect(await decode(out.update as Uint8Array)).toEqual({ 5: { cursor: { x: 1 }, user: { name: 'vvvvvvvvvv', color: '#aabbcc' } } });
  });
});

let PORT = 0;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-awareness-'));
let relay: ChildProcess;
const until = async (fn: () => boolean, ms = 15_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const client = (room: string) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/sync`, room, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
  return { doc, provider };
};

describe('relay awareness guard', () => {
  beforeAll(async () => {
    const started = await startRelayProcess({
      envFor: (port) => ({ ...(process.env as Record<string, string>), PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1' }),
    });
    PORT = started.port;
    relay = started.proc;
  });
  afterAll(async () => {
    if (relay && relay.exitCode === null) await new Promise<void>((r) => { relay.once('exit', () => r()); relay.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('propagates own presence but refuses a forged clientID and an oversized frame', async () => {
    const a = client('aw-room'), b = client('aw-room');
    await until(() => a.provider.wsconnected && b.provider.wsconnected);
    a.provider.awareness.setLocalStateField('user', { name: 'Ada' });
    await until(() => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === 'Ada');

    // A raw socket forges Ada's clientID (overwrite, then removal) and then sends a 100 KB frame.
    const evil = new WebSocket(`ws://127.0.0.1:${PORT}/sync/aw-room`);
    await new Promise((r) => evil.once('open', r));
    const frame = (body: Uint8Array) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint8Array(enc, body);
      return encoding.toUint8Array(enc);
    };
    evil.send(frame(update(entry(a.doc.clientID, 1_000_000, { user: { name: 'EVIL' } }))));
    evil.send(frame(update(entry(a.doc.clientID, 1_000_001, null))));
    evil.send(frame(update(entry(777, 1, { pad: 'x'.repeat(100_000) }))));
    evil.send(frame(update(entry(778, 1, { user: { name: 'Eve' } }))));
    await until(() => [...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Eve'));
    expect(b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name).toBe('Ada');
    expect(b.provider.awareness.getStates().has(777)).toBe(false);
    // the socket survived the oversized frame
    expect(evil.readyState).toBe(WebSocket.OPEN);

    // Ada's own later update still reaches B.
    a.provider.awareness.setLocalStateField('user', { name: 'Ada2' });
    await until(() => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === 'Ada2');
    evil.close(); a.provider.destroy(); b.provider.destroy();
  });
});
