import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRelayProcess } from './start-relay';
import { ogKind, withOgTags } from '../server/og-tags.mjs';

// Link previews: a crawler runs no JavaScript and never sees a #fragment, so the server sends the tags with the shell.

const SHELL = '<!doctype html><html><head><meta charset="utf-8" /><meta name="description" content="old" /><title>Tabula</title></head><body></body></html>';
const relayFile = path.resolve('server/relay.mjs');
let root = '';
const stops: Array<() => void> = [];

async function start(name: string, baseUrl?: string) {
  const started = await startRelayProcess({
    entry: relayFile,
    cwd: root,
    envFor: (port) => ({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      HOST: '127.0.0.1',
      DIST_DIR: path.join(root, 'dist'),
      DATA_DIR: path.join(root, `data-${name}`),
      ...(baseUrl ? { TABULA_BASE_URL: baseUrl } : {}),
    }),
  });
  stops.push(() => started.proc.kill());
  return started.port;
}

const get = async (port: number, p: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: Buffer.from(await res.arrayBuffer()) };
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
  fs.mkdirSync(path.join(root, 'dist', 'og'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), SHELL);
  fs.copyFileSync(path.resolve('public/og/invite.png'), path.join(root, 'dist', 'og', 'invite.png'));
});

afterAll(() => {
  for (const stop of stops) stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('link preview tags', () => {
  it('classifies the link shapes', () => {
    const kind = (url: string) => { const u = new URL(url, 'http://x'); return ogKind(u.pathname, u.searchParams); };
    expect(kind('/join?c=ABCD2345')).toBe('board');
    expect(kind('/b/some-board')).toBe('root');
    expect(kind('/?invite=1')).toBe('team');
    expect(kind('/')).toBe('root');
    expect(kind('/t/team-id')).toBe('root');
  });

  it('uses the sign-in sentence in accounts mode and the open-mode one otherwise', () => {
    expect(withOgTags(SHELL, 'team', null, true)).toContain('You sign in with your email, no password.');
    expect(withOgTags(SHELL, 'board', null, false)).toContain('Open the link to join. No account needed.');
    expect(withOgTags(SHELL, 'team', null, true)).toContain('<title>Join a team on Tabula</title>');
  });

  it('writes absolute, generic tags for every invite shape and serves the image without sign-in', async () => {
    const port = await start('a', 'https://boards.example.org/');
    for (const [p, title] of [['/join?c=ABCD2345', 'Join a board on Tabula'], ['/?invite=1', 'Join a team on Tabula']] as const) {
      const html = (await get(port, p)).body.toString();
      expect(html).toContain(`<meta property="og:title" content="${title}" />`);
      expect(html).toContain('content="https://boards.example.org/og/invite.png"');
      expect(html).toContain('name="twitter:card" content="summary_large_image"');
      expect(html).not.toMatch(/ABCD2345|some-board-id|secret-token/);
    }
    const page = (await get(port, '/')).body.toString();
    expect(page).toContain('<meta property="og:title" content="Tabula" />');
    const image = await get(port, '/og/invite.png');
    expect(image.status).toBe(200);
    expect(image.type).toBe('image/png');
    expect(image.cache).toContain('max-age=86400');
    expect(image.body.subarray(1, 4).toString()).toBe('PNG');
    expect(image.body.readUInt32BE(16)).toBe(1200);
    expect(image.body.readUInt32BE(20)).toBe(630);
  });

  it('writes no absolute URL when no public address is configured', async () => {
    const port = await start('b');
    const html = (await get(port, '/join?c=X')).body.toString();
    expect(html).toContain('og:title');
    expect(html).not.toContain('og:image');
    expect(html).toContain('name="twitter:card" content="summary"');
  });
});
