import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// Room files are saved a second after the last update, but never later than 30 seconds after the first unsaved
// change: a room that is edited without a pause still gets written. The relay runs as a child process.

const PORT = await freePort();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-save-'));
let relay: ChildProcess;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  relay = await new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ['server/relay.mjs'], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, HOST: '127.0.0.1', MIRA_AUTH: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout!.on('data', (d) => /relay on http/.test(String(d)) && resolve(p));
    p.stderr!.on('data', () => {});
    p.on('error', reject);
    setTimeout(() => reject(new Error('relay did not start')), RELAY_START_MS);
  });
});

afterAll(async () => {
  if (relay.exitCode === null && relay.signalCode === null) {
    await new Promise<void>((r) => {
      relay.once('exit', () => r());
      relay.kill('SIGTERM');
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('room saves under continuous editing', { timeout: 60_000 }, () => {
  it('writes the room file within about 30 seconds even though the room never goes quiet for a second', async () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/sync`, 'busy-room', doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    try {
      const t0 = Date.now();
      while (!(provider.wsconnected && provider.synced)) {
        if (Date.now() - t0 > 5000) throw new Error('could not connect');
        await sleep(20);
      }
      const file = path.join(dir, 'busy-room.yjs');
      const started = Date.now();
      let writtenAt: number | null = null;
      for (let i = 0; Date.now() - started < 40_000; i++) {
        doc.getMap('objects').set(`o${i % 20}`, i);
        await sleep(300);
        if (fs.existsSync(file)) {
          writtenAt = Date.now() - started;
          break;
        }
      }
      expect(writtenAt).not.toBeNull();
      // 30 seconds of waiting plus the interval of the last update; the old debounce would never have fired
      expect(writtenAt as number).toBeGreaterThan(20_000);
      expect(writtenAt as number).toBeLessThan(33_000);
    } finally {
      provider.destroy();
    }
  });
});
