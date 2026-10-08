import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-relay-'));
let relay: ChildProcess;

const startRelay = () =>
  new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ['server/relay.mjs'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout!.on('data', (d) => String(d).includes('Mira relay') && resolve(p));
    p.on('error', reject);
    setTimeout(() => reject(new Error('relay did not start')), 8000);
  });

const stopRelay = (p: ChildProcess) => new Promise<void>((r) => { p.once('exit', () => r()); p.kill('SIGTERM'); });

const client = (room: string) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/sync`, room, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
  return { doc, provider };
};

const until = async (fn: () => boolean, ms = 5000) => {
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
    if (relay && relay.exitCode === null) await stopRelay(relay);
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
    await new Promise((r) => setTimeout(r, 1300)); // debounce window
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
