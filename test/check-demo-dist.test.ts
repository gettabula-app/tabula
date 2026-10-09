import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDemoDist } from '../scripts/check-demo-dist.mjs';

let root: string;

function write(relative: string, value: string | Buffer) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function hashed(value: string) {
  const bytes = Buffer.from(value);
  return { bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8) };
}

function validFixture() {
  const shard = hashed(JSON.stringify({ icons: { a: { body: '<path d="M0 0"/>' } } }));
  const index = hashed(JSON.stringify({ n: ['a'], a: [], sh: [[shard.hash, 1]] }));
  write('index.html', '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><link rel="stylesheet" href="/demo/assets/main.css"><script type="module" src="/demo/assets/main.js"></script></head><body><main>Demo</main></body></html>');
  write('assets/main.js', 'document.body.dataset.ready = "yes";');
  write('assets/main.css', 'body { color: black; }');
  write('demo.json', JSON.stringify({ base: '/demo/', ephemeral: true }));
  write('icons/manifest.json', JSON.stringify({ v: 1, sets: [{ p: 'lucide', idx: index.hash }] }));
  write(`icons/i/lucide.${index.hash}.json`, index.bytes);
  write(`icons/s/lucide.0.${shard.hash}.json`, shard.bytes);
  write('icons/LICENSES.txt', 'Lucide Contributors — ISC');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-demo-dist-'));
  validFixture();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('check-demo-dist', () => {
  it('accepts a valid static demo and its hashed plain JSON icons', () => {
    expect(checkDemoDist(root)).toMatchObject({ files: 8 });
  });

  it('rejects an inline script', () => {
    fs.appendFileSync(path.join(root, 'index.html'), '<script>run()</script>');
    expect(() => checkDemoDist(root)).toThrow(/inline <script>/);
  });

  it('rejects an inline event-handler attribute', () => {
    fs.appendFileSync(path.join(root, 'index.html'), '<button onclick="run()">Run</button>');
    expect(() => checkDemoDist(root)).toThrow(/inline event handler attribute onclick/);
  });

  it('requires the CSP meta tag', () => {
    fs.writeFileSync(path.join(root, 'index.html'), fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<meta[^>]*>/, ''));
    expect(() => checkDemoDist(root)).toThrow(/Content-Security-Policy meta tag is missing/);
  });

  it('rejects a manifest link', () => {
    fs.appendFileSync(path.join(root, 'index.html'), '<link rel="manifest" href="/demo/manifest.webmanifest">');
    expect(() => checkDemoDist(root)).toThrow(/<link rel="manifest"> is forbidden/);
  });

  it('rejects local URLs outside /demo/', () => {
    fs.appendFileSync(path.join(root, 'index.html'), '<a href="/outside/">Outside</a>');
    expect(() => checkDemoDist(root)).toThrow(/local URL \/outside\/ is outside \/demo\//);
  });

  it('rejects a service worker file', () => {
    write('assets/sw.js', '');
    expect(() => checkDemoDist(root)).toThrow(/service worker is forbidden/);
  });

  it('rejects a web app manifest file', () => {
    write('manifest.webmanifest', '{}');
    expect(() => checkDemoDist(root)).toThrow(/web app manifest is forbidden/);
  });

  it('rejects source maps', () => {
    write('assets/main.js.map', '{}');
    expect(() => checkDemoDist(root)).toThrow(/source maps and gzip files are forbidden/);
  });

  it('rejects gzip files', () => {
    write('icons/manifest.json.gz', Buffer.from([0x1f, 0x8b]));
    expect(() => checkDemoDist(root)).toThrow(/source maps and gzip files are forbidden/);
  });

  it('rejects a docs directory', () => {
    write('docs/index.html', '<h1>Docs</h1>');
    expect(() => checkDemoDist(root)).toThrow(/docs\/ directory is forbidden/);
  });

  it('requires the exact ephemeral demo metadata', () => {
    write('demo.json', JSON.stringify({ base: '/', ephemeral: false }));
    expect(() => checkDemoDist(root)).toThrow(/demo.json must equal/);
  });

  it('requires icon files to be plain JSON', () => {
    write('icons/readme.txt', 'not json');
    expect(() => checkDemoDist(root)).toThrow(/must be plain \.json/);
  });

  it('rejects a missing manifest-referenced icon index', () => {
    fs.rmSync(path.join(root, 'icons/i'), { recursive: true });
    expect(() => checkDemoDist(root)).toThrow(/manifest references missing file icons\/i\//);
  });

  it('rejects icon content whose hash does not match its filename', () => {
    const shard = fs.readdirSync(path.join(root, 'icons/s'))[0];
    write(`icons/s/${shard}`, '{}');
    expect(() => checkDemoDist(root)).toThrow(/content hash is .* expected filename hash/);
  });

  it('rejects entry HTML, JavaScript and CSS above 1.5 MiB gzip', () => {
    const randomA = crypto.randomBytes(850 * 1024);
    const randomB = crypto.randomBytes(850 * 1024);
    write('assets/extra-a.js', randomA);
    write('assets/extra-b.js', randomB);
    fs.appendFileSync(path.join(root, 'index.html'), '<script src="/demo/assets/extra-a.js"></script><script src="/demo/assets/extra-b.js"></script>');
    expect(() => checkDemoDist(root)).toThrow(/entry HTML, JavaScript and CSS gzip to .* limit is 1.5 MiB/);
  });

  it('rejects a file above 1 MiB raw', () => {
    write('oversized.bin', Buffer.alloc(1024 * 1024 + 1));
    expect(() => checkDemoDist(root)).toThrow(/file limit is 1 MiB/);
  });

  it('rejects a distribution above 6 MiB raw', () => {
    for (let i = 0; i < 7; i++) write(`extra-${i}.bin`, Buffer.alloc(900 * 1024, i));
    expect(() => checkDemoDist(root)).toThrow(/total limit is 6 MiB/);
  });
});
