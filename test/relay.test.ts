import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';

let PORT = 0;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-relay-'));
let relay: ChildProcess;

const startRelay = async () => {
  const started = await startRelayProcess({
    envFor: (port) => ({ ...(process.env as Record<string, string>), PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1' }),
  });
  PORT = started.port;
  return started.proc;
};

const stopRelay = (p: ChildProcess) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(); p.once('exit', () => r()); p.kill('SIGTERM'); });

const client = (room: string) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/sync`, room, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
  return { doc, provider };
};

const until = async (fn: () => boolean, ms = 15_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('relay', () => {
  beforeAll(async () => {
    relay = await startRelay();
  });
  afterAll(async () => {
    if (relay && relay.exitCode === null && relay.signalCode === null) await stopRelay(relay);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('syncs edits between two clients in real time', async () => {
    const a = client('room-a'), b = client('room-a');
    await until(() => a.provider.wsconnected && b.provider.wsconnected);
    a.doc.getMap('objects').set('x', new Y.Map([['text', 'hello']]));
    await until(() => !!b.doc.getMap('objects').get('x'));
    expect((b.doc.getMap('objects').get('x') as Y.Map<string>).get('text')).toBe('hello');
    // presence travels too
    a.provider.awareness.setLocalStateField('user', { name: 'Ada' });
    await until(() => [...b.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Ada'));
    a.provider.destroy();
    b.provider.destroy();
  });

  it('merges offline edits from a client that reconnects', async () => {
    const a = client('room-b'), b = client('room-b');
    await until(() => a.provider.wsconnected && b.provider.wsconnected);
    a.provider.disconnect();
    a.doc.getMap('objects').set('offline', new Y.Map([['x', 1]]));
    b.doc.getMap('objects').set('online', new Y.Map([['x', 2]]));
    a.provider.connect();
    await until(() => !!a.doc.getMap('objects').get('online') && !!b.doc.getMap('objects').get('offline'));
    expect([...a.doc.getMap('objects').keys()].sort()).toEqual(['offline', 'online']);
    a.provider.destroy();
    b.provider.destroy();
  });

  it('keeps room state on disk across restarts', async () => {
    const a = client('room-c');
    await until(() => a.provider.wsconnected);
    a.doc.getMap('meta').set('name', 'Persisted');
    // Windows cannot ask the relay to save on the way out, so the debounced save has to have happened before it stops.
    await until(() => fs.existsSync(path.join(dataDir, 'room-c.yjs')));
    a.provider.destroy();
    await stopRelay(relay);
    expect(fs.existsSync(path.join(dataDir, 'room-c.yjs'))).toBe(true);
    relay = await startRelay();
    const b = client('room-c');
    await until(() => b.doc.getMap('meta').get('name') === 'Persisted');
    b.provider.destroy();
  });

  it('rejects invalid room names', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync/..%2Fetc`);
    const result = await new Promise<string>((r) => {
      ws.on('open', () => r('open'));
      ws.on('error', () => r('error'));
      ws.on('unexpected-response', () => r('rejected'));
    });
    expect(result).not.toBe('open');
  });
});
