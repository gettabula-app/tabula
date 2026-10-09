import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// The relay forbids framing with the CSP directive frame-ancestors 'none'. TABULA_DEV_ALLOW_FRAMING=1 is the opt-in for
// scripts/visual-check.mjs --frameable (docs/visual-check.md): the directive goes, the rest of the policy stays.

const relayFile = path.resolve('server/relay.mjs');
let root = '';
const running: Relay[] = [];

interface Relay {
  port: number;
  stderr: () => string;
  stop: () => Promise<void>;
}

async function startRelay(name: string, framing?: string): Promise<Relay> {
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DIST_DIR: path.join(root, 'dist'),
    DATA_DIR: path.join(root, `data-${name}`),
    TABULA_DEV_ALLOW_FRAMING: framing,
  };
  if (framing === undefined) delete env.TABULA_DEV_ALLOW_FRAMING;
  const child: ChildProcess = spawn(process.execPath, [relayFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += String(d)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), RELAY_START_MS);
    child.stdout!.on('data', (d) => {
      if (String(d).includes('Tabula relay')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`relay exited with ${code}`)));
  });
  const relay: Relay = {
    port,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    },
  };
  running.push(relay);
  return relay;
}

const headersOf = (port: number, rawPath: string) =>
  new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      })
      .on('error', reject);
  });

const directives = (csp: string | string[] | undefined) => String(csp).split(';').map((d) => d.trim());

/**
 * TAB-203: a stored value that reached CSS as `url(…)` (an image, a filter, a font) must not be able to fetch from any
 * host. Every directive that governs such a fetch names its hosts one by one (no `*`, no bare `https:` or `http:`; `data:`
 * and `blob:` are local), and the default is 'self'.
 */
function openFetchSources(csp: string[]): string[] {
  const out: string[] = [];
  const sources = (name: string) => csp.find((d) => d.split(/\s+/)[0] === name)?.split(/\s+/).slice(1);
  if (sources('default-src')?.join(' ') !== "'self'") out.push(`default-src ${sources('default-src')?.join(' ')}`);
  for (const name of ['img-src', 'style-src', 'font-src', 'connect-src', 'default-src']) {
    const list = sources(name);
    if (!list) out.push(`${name} missing`);
    for (const src of list ?? []) {
      const open = /^\*$|^https?:$|^https?:\/\/\*/.test(src);
      // named https hosts, and the desktop app's own IPC origin
      const named = !src.includes('://') || /^https:\/\/[a-z0-9.-]+\.[a-z]+$|^http:\/\/ipc\.localhost$/.test(src);
      if (open || !named) out.push(`${name} ${src}`);
    }
  }
  return out;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-framing-'));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<!doctype html><title>APP SHELL</title>');
});

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('relay: framing', () => {
  it('forbids framing by default', async () => {
    const relay = await startRelay('default');
    const headers = await headersOf(relay.port, '/');
    expect(directives(headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBeUndefined();
    expect(relay.stderr()).not.toContain('TABULA_DEV_ALLOW_FRAMING');
    expect(openFetchSources(directives(headers['content-security-policy']))).toEqual([]);
  });

  it('the fetch check itself finds an open source', () => {
    const base = ["default-src 'self'", "style-src 'self'", "font-src 'self'", "connect-src 'self'"];
    expect(openFetchSources([...base, "img-src 'self'"])).toEqual([]);
    expect(openFetchSources([...base, "img-src 'self' https:"])).toEqual(['img-src https:']);
    expect(openFetchSources([...base, 'img-src *'])).toEqual(['img-src *']);
    expect(openFetchSources([...base, 'img-src https://*.evil.example'])).toEqual(['img-src https://*.evil.example']);
    expect(openFetchSources(base)).toEqual(['img-src missing']);
  });

  it('the desktop app limits fetches the same way (its CSP lives in tauri.conf.json)', () => {
    const conf = JSON.parse(fs.readFileSync(path.resolve('desktop/src-tauri/tauri.conf.json'), 'utf8'));
    expect(openFetchSources(directives(conf.app.security.csp))).toEqual([]);
  });

  it('drops only frame-ancestors with TABULA_DEV_ALLOW_FRAMING=1, and says so on stderr', async () => {
    const relay = await startRelay('on', '1');
    const headers = await headersOf(relay.port, '/');
    const csp = directives(headers['content-security-policy']);
    expect(csp.some((d) => d.startsWith('frame-ancestors'))).toBe(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(headers['x-frame-options']).toBeUndefined();
    expect(relay.stderr()).toContain('TABULA_DEV_ALLOW_FRAMING=1');
  });

  it('turns on only for the value 1', async () => {
    for (const value of ['true', '0', '']) {
      const relay = await startRelay(`value-${value || 'empty'}`, value);
      const headers = await headersOf(relay.port, '/');
      expect(directives(headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      await relay.stop();
    }
  });
});
