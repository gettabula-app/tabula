import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';

// Room files are saved a second after the last update, but never later than 30 seconds after the first unsaved
// change: a room that is edited without a pause still gets written. The relay runs as a child process.
const SAVE_DEBOUNCE_MS = 1000;
const SAVE_MAX_WAIT_MS = 2000;

let PORT = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-save-'));
let relay: ChildProcess;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const started = await startRelayProcess({
    envFor: (port) => ({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      MIRA_AUTH: 'off',
      SAVE_DEBOUNCE_MS: String(SAVE_DEBOUNCE_MS),
      TABULA_TEST_SAVE_MAX_WAIT_MS: String(SAVE_MAX_WAIT_MS),
    }),
  });
  PORT = started.port;
  relay = started.proc;
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
      const deadline = started + 20_000;
      for (let i = 0; !fs.existsSync(file) && Date.now() < deadline; i++) {
        doc.getMap('objects').set(`o${i % 20}`, i);
        await sleep(300);
      }
      expect(fs.existsSync(file)).toBe(true);
      const writtenAt = Date.now() - started;
      // The debounce cannot save before its quiet period; max-wait must also not fire immediately.
      expect(writtenAt).toBeGreaterThanOrEqual(SAVE_DEBOUNCE_MS);
      expect(writtenAt).toBeGreaterThanOrEqual(SAVE_MAX_WAIT_MS * 0.5);
    } finally {
      provider.destroy();
    }
  });
});
