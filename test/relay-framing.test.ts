import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

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
    const timer = setTimeout(() => reject(new Error('relay did not start')), 8000);
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
