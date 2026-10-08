import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/ai.md. The relay as `npm start` runs it: how the environment turns AI on in open mode, and what it refuses to start with.
// The environment of the children is built here and never read from a .env file: the working directory is an empty one.

const RELAY = fileURLToPath(new URL('../server/relay.mjs', import.meta.url));
const BASE_PORT = 26000 + Math.floor(Math.random() * 800);
const KEY = `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;
const SECRET = crypto.randomBytes(32).toString('base64');

type Relay = { port: number; proc: ChildProcess; output: () => string };
const launched: { proc: ChildProcess; dir: string }[] = [];
let count = 0;

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TABULA|MIRA)_|^ANTHROPIC_|^DATA_DIR$|^PORT$/.test(name)));

function spawnRelay(env: Record<string, string>) {
  const port = BASE_PORT + count++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-'));
  let out = '';
  const proc = spawn(process.execPath, [RELAY], {
    cwd: dir,
    env: { ...cleanEnv(), PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  launched.push({ proc, dir });
  return { port, proc, dir, output: () => out };
}

const launch = (env: Record<string, string> = {}) =>
  new Promise<Relay>((resolve, reject) => {
    const relay = spawnRelay(env);
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${relay.output()}`)), 15_000);
    relay.proc.stdout!.on('data', (d) => {
      if (String(d).includes('Tabula relay')) {
        clearTimeout(timer);
        resolve(relay);
      }
    });
    relay.proc.on('error', reject);
    relay.proc.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`relay exited before it was listening: ${relay.output()}`));
    });
  });

const exitOf = (proc: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(proc.exitCode);
    proc.once('exit', (code) => resolve(code));
  });

const stop = (proc: ChildProcess) =>
  new Promise<void>((r) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return r();
    proc.once('exit', () => r());
    proc.kill('SIGTERM');
  });

afterAll(async () => {
  for (const { proc, dir } of launched) {
    await stop(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const get = async (relay: Relay, urlPath: string, init: RequestInit = {}) => {
  const res = await fetch(`http://127.0.0.1:${relay.port}${urlPath}`, init);
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
};

describe('open mode', () => {
  it('has AI off by default', async () => {
    const relay = await launch();
    const res = await get(relay, '/api/ai/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      features: ['generate', 'summarise', 'cluster'],
      keySource: null,
      model: 'claude-opus-5-5',
      personalKeys: false,
      hasSecret: false,
    });
  });

  it('stays off with a key alone, and the log says why without printing the key', async () => {
    const relay = await launch({ TABULA_AI_API_KEY: KEY });
    expect((await get(relay, '/api/ai/config')).body).toMatchObject({ enabled: false, keySource: null });
    expect(relay.output()).toContain('TABULA_AI_OPEN');
    expect(relay.output()).not.toContain(KEY);
  });

  it('stays off with the switch alone', async () => {
    const relay = await launch({ TABULA_AI_OPEN: '1' });
    expect((await get(relay, '/api/ai/config')).body.enabled).toBe(false);
    expect(relay.output()).toContain('does nothing without TABULA_AI_API_KEY');
    const zero = await launch({ TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '0' });
    expect((await get(zero, '/api/ai/config')).body.enabled).toBe(false);
  });

  it('is on only with the key and TABULA_AI_OPEN=1, and then names the key and model but never shows the key', async () => {
    const relay = await launch({ TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1', TABULA_AI_MODEL: 'claude-sonnet-5-5' });
    const res = await get(relay, '/api/ai/config');
    expect(res.body).toEqual({
      enabled: true,
      features: ['generate', 'summarise', 'cluster'],
      keySource: 'workspace',
      model: 'claude-sonnet-5-5',
      personalKeys: false,
      hasSecret: false,
    });
    expect(res.text).not.toContain(KEY);
    expect(relay.output()).not.toContain(KEY);
    // no session and no CSRF header needed to ask: it is open mode
    expect((await get(relay, '/api/ai/config', { headers: { cookie: 'x=y' } })).status).toBe(200);
  });

  it('reads the old MIRA_ names too', async () => {
    const relay = await launch({ MIRA_AI_API_KEY: KEY, MIRA_AI_OPEN: '1' });
    expect((await get(relay, '/api/ai/config')).body).toMatchObject({ enabled: true, model: 'claude-opus-5-5' });
    expect(relay.output()).toContain('MIRA_AI_API_KEY (use TABULA_AI_API_KEY)');
    expect(relay.output()).not.toContain(KEY);
  });

  it('has no other AI endpoint', async () => {
    const relay = await launch({ TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1', TABULA_AI_SECRET: SECRET });
    const csrf = { 'x-tabula': '1', 'content-type': 'application/json' };
    for (const [method, urlPath] of [['PUT', '/api/ai/keys/me'], ['DELETE', '/api/ai/keys/me'], ['GET', '/api/admin/ai'], ['PUT', '/api/admin/ai'], ['DELETE', '/api/admin/ai/key'], ['POST', '/api/ai/config'], ['POST', '/api/ai/run']]) {
      const res = await get(relay, urlPath, { method, headers: csrf, body: method === 'PUT' || method === 'POST' ? JSON.stringify({ apiKey: KEY }) : undefined });
      expect([method, urlPath, res.status, res.body]).toEqual([method, urlPath, 404, { error: 'not_found' }]);
    }
  });
});

describe('accounts mode', () => {
  const accounts = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', TABULA_MAIL: 'file' };

  it('answers the AI routes only to a signed-in person', async () => {
    const relay = await launch({ ...accounts, TABULA_AI_SECRET: SECRET, TABULA_BASE_URL: 'http://127.0.0.1:1' });
    const csrf = { 'x-tabula': '1', 'content-type': 'application/json' };
    expect((await get(relay, '/api/ai/config')).status).toBe(401);
    expect((await get(relay, '/api/admin/ai')).status).toBe(401);
    expect((await get(relay, '/api/ai/keys/me', { method: 'PUT', headers: csrf, body: JSON.stringify({ apiKey: KEY }) })).status).toBe(401);
    expect(relay.output()).not.toContain(KEY);
  });

  it('ignores the operator key, and says so', async () => {
    const relay = await launch({ ...accounts, TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1' });
    expect(relay.output()).toContain('ignored in accounts mode');
    expect(relay.output()).not.toContain(KEY);
  });
});

describe('a malformed secret', () => {
  it.each([
    ['open mode', {}],
    ['accounts mode', { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com' }],
  ])('stops the relay from starting in %s, and the message does not print it', async (_name, base) => {
    for (const [name, value] of [['TABULA_AI_SECRET', 'definitely-not-base64-secret'], ['TABULA_AI_SECRET', crypto.randomBytes(16).toString('base64')]]) {
      const relay = spawnRelay({ ...base, [name]: value });
      expect(await exitOf(relay.proc)).not.toBe(0);
      expect(relay.output()).toContain(`${name} must be 32 random bytes encoded as base64`);
      expect(relay.output()).not.toContain(value);
      expect(relay.output()).not.toContain('Tabula relay on');
    }
  });

  it('also stops it for a malformed previous secret, or a previous one alone', async () => {
    const bad = spawnRelay({ TABULA_AI_SECRET: SECRET, TABULA_AI_SECRET_PREVIOUS: 'nope-nope-nope' });
    expect(await exitOf(bad.proc)).not.toBe(0);
    expect(bad.output()).toContain('TABULA_AI_SECRET_PREVIOUS must be 32 random bytes');
    expect(bad.output()).not.toContain('nope-nope-nope');
    const alone = spawnRelay({ TABULA_AI_SECRET_PREVIOUS: SECRET });
    expect(await exitOf(alone.proc)).not.toBe(0);
    expect(alone.output()).toContain('TABULA_AI_SECRET_PREVIOUS needs TABULA_AI_SECRET');
    expect(alone.output()).not.toContain(SECRET);
  });
});
