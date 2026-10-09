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

// A room file the relay cannot decode is set aside (`<room>.yjs.corrupt-<time>`) before the room starts empty, so no
// save replaces it; a save that fails (here a directory where the temporary file goes) is logged and tried again, and
// does not end the process. The relay runs as a child process with short timers.

const PORT = await freePort();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-save-errors-'));
let relay: ChildProcess;
let output = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}\n${output}`);
    await sleep(25);
  }
}

function connect(room: string, doc = new Y.Doc()) {
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/sync`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  return { doc, provider };
}

const running = () => relay.exitCode === null && relay.signalCode === null;

beforeAll(async () => {
  relay = await new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ['server/relay.mjs'], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, HOST: '127.0.0.1', TABULA_AUTH: 'off', MIRA_AUTH: 'off', SAVE_DEBOUNCE_MS: '50', SAVE_RETRY_MS: '200', ROOM_UNLOAD_MS: '300' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout!.on('data', (d) => {
      output += String(d);
      if (/relay on http/.test(String(d))) resolve(p);
    });
    p.stderr!.on('data', (d) => (output += String(d)));
    p.on('error', reject);
    setTimeout(() => reject(new Error(`relay did not start\n${output}`)), RELAY_START_MS);
  });
});

afterAll(async () => {
  if (running()) {
    await new Promise<void>((r) => {
      relay.once('exit', () => r());
      relay.kill('SIGTERM');
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('room files the relay cannot read or write', { timeout: 30_000 }, () => {
  it('sets an undecodable room file aside instead of saving an empty board over it', async () => {
    const original = new Y.Doc();
    original.getMap('meta').set('name', 'Roadmap');
    for (let i = 0; i < 5; i++) original.getMap('objects').set(`o${i}`, { text: `note ${i}` });
    const whole = Y.encodeStateAsUpdate(original);
    const cut = whole.slice(0, whole.length - 5);
    expect(() => Y.applyUpdate(new Y.Doc(), cut)).toThrow('Unexpected end of array');
    const file = path.join(dir, 'cut-room.yjs');
    fs.writeFileSync(file, cut);

    const { provider } = connect('cut-room');
    try {
      await until('the sync', () => provider.wsconnected && provider.synced);
    } finally {
      provider.destroy();
    }
    const asideFile = () => fs.readdirSync(dir).find((f) => f.startsWith('cut-room.yjs.corrupt-'));
    await until('the file to be set aside', () => asideFile() !== undefined);
    expect(Buffer.from(fs.readFileSync(path.join(dir, asideFile()!)))).toEqual(Buffer.from(cut));
    await until('the unload', () => output.includes('room cut-room: unloaded'));
    expect(running()).toBe(true);
  });

  it('keeps running when a save fails, and saves once the disk lets it', async () => {
    const blocker = path.join(dir, 'stuck-room.yjs.tmp');
    fs.mkdirSync(blocker);
    const { doc, provider } = connect('stuck-room');
    try {
      await until('the sync', () => provider.wsconnected && provider.synced);
      doc.getMap('objects').set('a', 'kept');
      await until('a failed save', () => output.includes('room stuck-room: could not save'));
      await sleep(400);
      expect(running()).toBe(true);
      expect(fs.existsSync(path.join(dir, 'stuck-room.yjs'))).toBe(false);

      fs.rmdirSync(blocker);
      const file = path.join(dir, 'stuck-room.yjs');
      await until('the retried save', () => fs.existsSync(file));
      const saved = new Y.Doc();
      Y.applyUpdate(saved, fs.readFileSync(file));
      expect(saved.getMap('objects').get('a')).toBe('kept');
    } finally {
      provider.destroy();
    }
    expect(running()).toBe(true);
  });
});
