import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

const PORT = await freePort();
let root = '';
let relay: ChildProcess;

type Res = { status: number; body: string; headers: http.IncomingHttpHeaders };

// http.request sends the path exactly as given, unlike fetch, which normalises dot segments first.
const get = (rawPath: string) =>
  new Promise<Res>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-docs-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(dist, 'docs', 'boards'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'docs', 'images'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>APP SHELL</title>');
  fs.writeFileSync(path.join(dist, 'docs', 'index.html'), '<!doctype html><title>DOCS HOME</title>');
  fs.writeFileSync(path.join(dist, 'docs', 'boards', 'index.html'), '<!doctype html><title>DOCS BOARDS</title>');
  fs.writeFileSync(path.join(dist, 'docs', '404.html'), '<!doctype html><title>DOCS NOT FOUND</title>');
  fs.writeFileSync(path.join(dist, 'docs', 'search.json'), '[{"url":"/docs/","title":"Home","headings":[],"text":""}]');
  fs.writeFileSync(path.join(dist, 'docs', 'images', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"OUTSIDE SECRET"}');
  fs.writeFileSync(path.join(dist, 'secret.txt'), 'OUTSIDE DOCS');
  await new Promise<void>((resolve, reject) => {
    relay = spawn(process.execPath, ['server/relay.mjs'], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DIST_DIR: dist, DATA_DIR: path.join(root, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('relay did not start')), RELAY_START_MS);
    relay.stdout!.on('data', (d) => {
      if (String(d).includes('Tabula relay')) {
        clearTimeout(timer);
        resolve();
      }
    });
    relay.stderr!.on('data', () => {});
    relay.on('error', reject);
  });
});

afterAll(async () => {
  if (relay && relay.exitCode === null) {
    const exited = new Promise((r) => relay.once('exit', r));
    relay.kill();
    await exited;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('relay: user guide', () => {
  it('serves the guide home and pages, with and without a trailing slash', async () => {
    for (const p of ['/docs', '/docs/', '/docs/index.html']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.body).toContain('DOCS HOME');
    }
    for (const p of ['/docs/boards', '/docs/boards/']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.body).toContain('DOCS BOARDS');
    }
  });

  it('keeps the CSP on guide HTML', async () => {
    const r = await get('/docs/');
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('serves search.json and images directly', async () => {
    const s = await get('/docs/search.json');
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toContain('application/json');
    expect(JSON.parse(s.body)[0].title).toBe('Home');
    const i = await get('/docs/images/a.svg');
    expect(i.status).toBe(200);
    expect(i.headers['content-type']).toBe('image/svg+xml');
  });

  it('answers unknown guide pages with the guide 404 page, never the app shell', async () => {
    for (const p of ['/docs/nope', '/docs/nope/', '/docs/boards/nope', '/docs/404.html']) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(r.body).toContain('DOCS NOT FOUND');
      expect(r.body).not.toContain('APP SHELL');
    }
    expect((await get('/docs/missing.png')).status).toBe(404);
  });

  it('still serves the app shell outside /docs', async () => {
    expect((await get('/some/board')).body).toContain('APP SHELL');
  });

  it('never serves files outside dist/docs', async () => {
    // fetch-style normalisation by the URL parser turns these (a backslash counts as a slash) into app paths outside /docs; the rest stay under /docs and must be refused.
    for (const p of ['/docs/../index.html', '/docs/%2e%2e/%2e%2e/package.json', '/docs/..\\..\\package.json']) {
      const r = await get(p);
      expect(r.body).not.toContain('OUTSIDE SECRET');
      expect(r.body).not.toContain('DOCS');
    }
    const refused = [
      '/docs/..%2f..%2fpackage.json',
      '/docs/..%2fsecret.txt',
      '/docs/%2e%2e%2f%2e%2e%2fpackage.json',
      '/docs/..%5c..%5cpackage.json',
      '/docs/images/..%2f..%2fsecret.txt',
      '/docs/%00',
      '/docs/boards%00.html',
    ];
    for (const p of refused) {
      const r = await get(p);
      expect([400, 403, 404]).toContain(r.status);
      expect(r.body).not.toContain('OUTSIDE');
    }
  });
});
