import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';

// The validator on a real relay (open mode): TABULA_SYNC_VALIDATE=report never rejects, =enforce reverts.

const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(mode: string | undefined) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-syncval-'));
  let relay: ChildProcess;
  let port = 0;
  const clients: WebsocketProvider[] = [];
  const start = async () => {
    const started = await startRelayProcess({
      envFor: (p) => ({
        ...(process.env as Record<string, string>), PORT: String(p), DATA_DIR: dataDir, HOST: '127.0.0.1',
        ...(mode ? { TABULA_SYNC_VALIDATE: mode } : {}),
      }),
    });
    relay = started.proc;
    port = started.port;
    return started;
  };
  const stop = async () => {
    clients.forEach((c) => c.destroy());
    if (relay && relay.exitCode === null && relay.signalCode === null) await new Promise<void>((r) => { relay.once('exit', () => r()); relay.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  const client = (room: string) => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/sync`, room, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
    clients.push(provider);
    return { doc, provider, objects: doc.getMap('objects') as Y.Map<Y.Map<unknown>> };
  };
  const health = async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as Promise<{ syncValidate?: { mode: string; violations: number; rejected: number; byCode: Record<string, number>; byKind: Record<string, number> } }>;
  return { start, stop, client, health, output: () => '' };
}

const sticky = (extra: Record<string, unknown> = {}) => new Y.Map<unknown>(Object.entries({ id: 'x', type: 'sticky', x: 1, y: 2, w: 192, h: 192, rotation: 0, z: 'a0', text: 'hi', ...extra }));

describe('sync validator on a relay: report mode', () => {
  const h = harness('report');
  beforeAll(async () => { await h.start(); });
  afterAll(h.stop);

  it('lets a malformed object through, counts it, and shows it to the other client', async () => {
    const a = h.client('sv-report');
    const b = h.client('sv-report');
    await until(() => a.provider.wsconnected && b.provider.wsconnected);
    a.objects.set('bad1', sticky({ id: 'bad1', x: 'not a number', evil: 'field' }));
    await until(() => b.objects.has('bad1'));
    expect(b.objects.get('bad1')!.get('x')).toBe('not a number');
    a.objects.set('ok1', sticky({ id: 'ok1' }));
    await until(() => b.objects.has('ok1'));
    await until(async () => ((await h.health()).syncValidate?.violations ?? 0) >= 2);
    const stats = (await h.health()).syncValidate!;
    expect(stats.mode).toBe('report');
    expect(stats.rejected).toBe(0);
    expect(stats.byCode).toMatchObject({ bad_type: 1, unknown_field: 1 });
    expect(stats.byKind).toMatchObject({ object: 2 });
    // the object stays on the server for a client that joins later
    const c = h.client('sv-report');
    await until(() => c.objects.has('bad1'));
  });
});

describe('sync validator on a relay: enforce mode', () => {
  const h = harness('enforce');
  beforeAll(async () => { await h.start(); });
  afterAll(h.stop);

  it('reverts a malformed object for everybody, keeps a good one, and counts the rejection', async () => {
    const a = h.client('sv-enforce');
    const b = h.client('sv-enforce');
    await until(() => a.provider.wsconnected && b.provider.wsconnected);
    a.objects.set('good1', sticky({ id: 'good1' }));
    await until(() => b.objects.has('good1'));
    a.objects.set('bad1', sticky({ id: 'bad1', w: Number.NaN, type: 'sticky' }));
    await until(async () => ((await h.health()).syncValidate?.rejected ?? 0) >= 1);
    await until(() => !b.objects.has('bad1') && !a.objects.has('bad1'));
    expect(b.objects.has('good1')).toBe(true);
    // a field edit that breaks an existing object is reverted too, to the value from before
    a.objects.get('good1')!.set('fill', 'red;filter:url(//evil/x)');
    await until(() => a.objects.get('good1')!.get('fill') === undefined && b.objects.get('good1')!.get('fill') === undefined);
    expect(b.objects.get('good1')!.get('text')).toBe('hi');
    // and a late joiner sees only the good state
    const c = h.client('sv-enforce');
    await until(() => c.objects.has('good1'));
    await sleep(200);
    expect(c.objects.has('bad1')).toBe(false);
    expect((await h.health()).syncValidate!.rejected).toBeGreaterThanOrEqual(2);
  });

  it('closes a socket after 20 violations within a minute', async () => {
    const a = h.client('sv-strikes');
    await until(() => a.provider.wsconnected);
    let closed = false;
    a.provider.on('connection-close', () => { closed = true; });
    for (let i = 0; i < 30 && !closed; i++) {
      a.objects.set(`bad${i}`, sticky({ id: `bad${i}`, x: 'no' }));
      await sleep(30);
    }
    await until(() => closed);
    expect(closed).toBe(true);
  });
});

describe('sync validator: unset means report', () => {
  const h = harness(undefined);
  beforeAll(async () => { await h.start(); });
  afterAll(h.stop);

  it('counts what it would flag, never rejects, never reverts and never closes a socket', async () => {
    const a = h.client('sv-default');
    const b = h.client('sv-default');
    await until(() => a.provider.wsconnected && b.provider.wsconnected);
    // hard-looking violations too: an unknown field, a wrong type, a forbidden key name, a value that is not a number
    a.objects.set('bad1', sticky({ id: 'bad1', x: 'no', evil: 'field' }));
    a.objects.set('bad2', sticky({ id: 'bad2', w: Number.NaN, fill: 'red;filter:url(//evil/x)' }));
    await until(() => b.objects.has('bad1') && b.objects.has('bad2'));
    await until(async () => ((await h.health()).syncValidate?.violations ?? 0) >= 2);
    const stats = (await h.health()).syncValidate!;
    expect(stats.mode).toBe('report');
    expect(stats.rejected).toBe(0);
    expect((stats as { closed?: number }).closed ?? 0).toBe(0);
    expect(b.objects.get('bad1')!.get('x')).toBe('no');
    expect(a.provider.wsconnected && b.provider.wsconnected).toBe(true);
    // 25 violations in quick succession (enforce would close the socket at 20): the socket stays open
    for (let i = 0; i < 25; i++) a.objects.set(`flood${i}`, sticky({ id: `flood${i}`, x: 'no' }));
    await until(() => b.objects.has('flood24'));
    expect(a.provider.wsconnected).toBe(true);
    expect((await h.health()).syncValidate!.rejected).toBe(0);
  });
});

describe('sync validator: off is the explicit switch', () => {
  const h = harness('off');
  beforeAll(async () => { await h.start(); });
  afterAll(h.stop);

  it('does nothing and reports nothing', async () => {
    const a = h.client('sv-off');
    const b = h.client('sv-off');
    await until(() => a.provider.wsconnected && b.provider.wsconnected);
    a.objects.set('bad1', sticky({ id: 'bad1', x: 'no' }));
    await until(() => b.objects.has('bad1'));
    expect((await h.health()).syncValidate).toBeUndefined();
  });
});

describe('sync validator: a bad mode stops the server', () => {
  it('exits at startup with a clear message', async () => {
    await expect(startRelayProcess({
      envFor: (port) => ({ ...(process.env as Record<string, string>), PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-syncval-')), HOST: '127.0.0.1', TABULA_SYNC_VALIDATE: 'sometimes' }),
      attempts: 1,
    })).rejects.toThrow(/TABULA_SYNC_VALIDATE must be one of off, report, enforce/);
  });
});
