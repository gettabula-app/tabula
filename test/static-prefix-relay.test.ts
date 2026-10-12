import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRelayProcess } from './start-relay';

let PORT = 0;
let root = '';
let relay: ChildProcess;

type Res = { status: number; body: string; headers: http.IncomingHttpHeaders };

// http.request sends the path exactly as given, unlike fetch, which normalises dot segments first.
const get = (rawPath: string) =>
  new Promise<Res>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-static-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(dist, 'assets', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist-old'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>APP SHELL</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'deep', 'a.js'), 'NESTED OK');
  fs.writeFileSync(path.join(dist, 'assets', 'app.abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'dist-old', 'x.txt'), 'SIBLING SECRET');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"OUTSIDE SECRET"}');
  const started = await startRelayProcess({
    envFor: (port) => ({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      HOST: '127.0.0.1',
      DIST_DIR: dist,
      DATA_DIR: path.join(root, 'data'),
    }),
  });
  PORT = started.port;
  relay = started.proc;
});

afterAll(async () => {
  if (relay && relay.exitCode === null) {
    const exited = new Promise((r) => relay.once('exit', r));
    relay.kill();
    await exited;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('relay: static files stay inside dist', () => {
  it('serves a normal nested file', async () => {
    const r = await get('/assets/deep/a.js');
    expect(r.status).toBe(200);
    expect(r.body).toBe('NESTED OK');
  });

  it('refuses a sibling directory that shares the dist name as a prefix', async () => {
    for (const p of ['/..%2fdist-old/x.txt', '/%2e%2e%2fdist-old%2fx.txt', '/..%2Fdist-old/x.txt']) {
      const r = await get(p);
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('SIBLING SECRET');
    }
  });

  it('refuses dot-dot escapes, plain and encoded', async () => {
    for (const p of ['/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/assets/..%2f..%2fpackage.json']) {
      const r = await get(p);
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('OUTSIDE SECRET');
    }
  });

  it('lets the URL parser fold %2e%2e segments into app paths without leaking', async () => {
    const r = await get('/%2e%2e/package.json');
    expect(r.body).not.toContain('OUTSIDE SECRET');
  });

  it('never leaks a file for NUL bytes, backslashes or malformed escapes', async () => {
    for (const p of ['/%00', '/assets%00/../../package.json', '/..%5cpackage.json', '/..%5cdist-old%5cx.txt', '/%E0%A4%A']) {
      const r = await get(p);
      expect(r.body).not.toContain('OUTSIDE SECRET');
      expect(r.body).not.toContain('SIBLING SECRET');
    }
  });

  it('answers a malformed percent escape with 400 instead of crashing', async () => {
    for (const p of ['/%E0%A4%A', '/docs/%E0%A4%A', '/icons/%E0%A4%A', '/%00']) {
      expect((await get(p)).status).toBe(400);
    }
    // the relay is still up
    expect((await get('/assets/deep/a.js')).status).toBe(200);
  });
});

describe('relay: the SPA fallback is for navigations only', () => {
  it('answers a missing file under /assets/ with a 404 that is not html and is never stored', async () => {
    for (const p of ['/assets/foo.abc123.js', '/assets/missing.css', '/assets/deep/nope.woff2', '/other.png']) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(r.body).not.toContain('APP SHELL');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(String(r.headers['content-type'])).toMatch(/^text\/plain/);
    }
  });

  it('serves an existing asset as itself with the immutable header', async () => {
    const r = await get('/assets/app.abc123.js');
    expect(r.status).toBe(200);
    expect(r.body).toBe('console.log(1)');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html with no-cache for app routes and extensionless paths', async () => {
    for (const p of ['/b/some-board', '/t/x', '/unknown-route', '/', '/assets/', '/assets']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.body).toContain('APP SHELL');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
  });

  it('keeps index.html itself no-cache', async () => {
    const r = await get('/index.html');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-cache');
  });
});
