import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, type Account } from './mcp-harness';
import { TEMPLATES } from '../src/templates';
import { templateObjects } from '../src/template-thumb';
import { previewSvgFor } from '../src/preview-render';
import { DEV_PREVIEW_MAX_BYTES, previewProblem } from '../server/dev-previews.mjs';

// DEV ONLY (TABULA_DEV_PREVIEWS=1): the stored picture of a board for the Boards cards. The relay runs as a child process.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#FFE066"/></svg>';
const SVG_HEADERS = {
  'content-type': 'image/svg+xml',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'x-content-type-options': 'nosniff',
};

/** A raw PUT as the client sends it. `csrf: false` leaves out x-tabula; no `who` sends no cookie. */
async function putPicture(
  h: { base: string },
  who: Account | undefined,
  board: string,
  body: string | Buffer,
  { csrf = true, type = 'image/svg+xml' }: { csrf?: boolean; type?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': type };
  if (csrf) headers['x-tabula'] = '1';
  if (who) headers.cookie = who.cookie;
  const res = await fetch(`${h.base}/api/dev/board-preview/${board}`, { method: 'PUT', headers, body: typeof body === 'string' ? body : new Uint8Array(body) });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined, text, headers: res.headers };
}

async function getPicture(h: { base: string }, who: Account | undefined, board: string) {
  const res = await fetch(`${h.base}/api/dev/board-preview/${board}`, { headers: who ? { cookie: who.cookie } : {} });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe('dev previews, switched on (TABULA_DEV_PREVIEWS=1)', () => {
  const h = createHarness({ accounts: true, settings: { DEV_PREVIEWS: '1' } });
  let owner: Account;
  let editor: Account;
  let viewer: Account;
  let commenter: Account;
  let stranger: Account;

  beforeAll(async () => {
    await h.start();
    owner = await h.signInOwner();
    const team = (await h.newTeam(owner.cookie, 'Previews')).id;
    editor = await h.joinTeam(owner.cookie, team);
    viewer = await h.joinTeam(owner.cookie, team);
    commenter = await h.joinTeam(owner.cookie, team);
    stranger = await h.joinTeam(owner.cookie, team);
  });

  afterAll(() => h.cleanup());

  /** A board the editor, viewer and commenter may open; the stranger may not. */
  async function sharedBoard() {
    const board = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, board, editor.user.id, 'editor');
    await h.share(owner.cookie, board, viewer.user.id, 'viewer');
    await h.share(owner.cookie, board, commenter.user.id, 'commenter');
    return board;
  }

  it('an editor stores a picture, and everyone who can open the board gets it as an image', async () => {
    const board = await sharedBoard();
    const saved = await putPicture(h, editor, board, SVG);
    expect(saved.status).toBe(204);

    for (const who of [editor, viewer, commenter, owner]) {
      const got = await getPicture(h, who, board);
      expect(got.status).toBe(200);
      expect(got.text).toBe(SVG);
      for (const [name, value] of Object.entries(SVG_HEADERS)) expect([name, got.headers.get(name)]).toEqual([name, value]);
    }
  });

  it('the owner may store a picture too, and a second picture replaces the first', async () => {
    const board = await sharedBoard();
    expect((await putPicture(h, editor, board, SVG)).status).toBe(204);
    const second = SVG.replace('#FFE066', '#B0E0C0');
    expect((await putPicture(h, owner, board, second)).status).toBe(204);
    expect((await getPicture(h, viewer, board)).text).toBe(second);
  });

  it('a viewer or a commenter cannot store a picture, and the stored one stays', async () => {
    const board = await sharedBoard();
    expect((await putPicture(h, editor, board, SVG)).status).toBe(204);
    const viewerTry = await putPicture(h, viewer, board, SVG.replace('#FFE066', '#000000'));
    const commenterTry = await putPicture(h, commenter, board, SVG.replace('#FFE066', '#000000'));
    expect(viewerTry).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(commenterTry).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await getPicture(h, viewer, board)).text).toBe(SVG);
  });

  it('a person who cannot open the board gets 404 for its picture, and cannot store one', async () => {
    const board = await sharedBoard();
    expect((await putPicture(h, editor, board, SVG)).status).toBe(204);
    expect((await getPicture(h, stranger, board)).status).toBe(404);
    expect((await putPicture(h, stranger, board, SVG)).status).toBe(404);
  });

  it('a request without a session is refused', async () => {
    const board = await sharedBoard();
    expect((await getPicture(h, undefined, board)).status).toBe(401);
    expect((await putPicture(h, undefined, board, SVG)).status).toBe(401);
  });

  it('a store without the CSRF header is refused', async () => {
    const board = await sharedBoard();
    const res = await putPicture(h, editor, board, SVG, { csrf: false });
    expect(res).toMatchObject({ status: 403, body: { error: 'csrf' } });
  });

  it('a body over the cap is 413, and nothing is stored', async () => {
    const board = await sharedBoard();
    const big = Buffer.alloc(DEV_PREVIEW_MAX_BYTES + 1, 'a');
    big.write('<svg ', 0);
    const res = await putPicture(h, editor, board, big);
    expect(res.status).toBe(413);
    expect((await getPicture(h, editor, board)).status).toBe(404);
  });

  it('a body of another type is 415', async () => {
    const board = await sharedBoard();
    expect((await putPicture(h, editor, board, SVG, { type: 'text/plain' })).status).toBe(415);
    expect((await putPicture(h, editor, board, SVG, { type: 'application/json' })).status).toBe(415);
  });

  it('a body that is not an SVG, or that carries script or a link, is 400 and nothing is stored', async () => {
    const board = await sharedBoard();
    const refused = [
      '<html><body>hi</body></html>',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><rect width="1" height="1"/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>',
      '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ];
    for (const body of refused) expect([body, (await putPicture(h, editor, board, body)).status]).toEqual([body, 400]);
    expect((await getPicture(h, editor, board)).status).toBe(404);
  });

  it('a board id that is not a valid id is not found, whatever the path', async () => {
    for (const id of ['bad%20id', '..%2F..%2Fetc%2Fpasswd', '%2e%2e', 'x.svg']) {
      const got = await getPicture(h, owner, id);
      expect([id, got.status]).toEqual([id, 404]);
      expect([id, (await putPicture(h, owner, id, SVG)).status]).toEqual([id, 404]);
    }
  });

  it('a board with no picture is 404, and the list leaves it out', async () => {
    const board = await sharedBoard();
    expect((await getPicture(h, viewer, board)).status).toBe(404);
    const list = await fetch(`${h.base}/api/dev/board-previews`, { headers: { cookie: viewer.cookie } });
    expect(await list.json()).not.toHaveProperty([board]);
  });

  it('the list names the pictures of the boards the caller can open, with a version, and only those', async () => {
    const shown = await sharedBoard();
    const hidden = await h.newBoard(owner.cookie);
    expect((await putPicture(h, editor, shown, SVG)).status).toBe(204);
    expect((await putPicture(h, owner, hidden, SVG)).status).toBe(204);

    const forViewer = await (await fetch(`${h.base}/api/dev/board-previews`, { headers: { cookie: viewer.cookie } })).json();
    expect(forViewer[shown]).toEqual(expect.any(Number));
    expect(forViewer).not.toHaveProperty([hidden]);

    const forStranger = await (await fetch(`${h.base}/api/dev/board-previews`, { headers: { cookie: stranger.cookie } })).json();
    expect(forStranger).not.toHaveProperty([shown]);
    expect(forStranger).not.toHaveProperty([hidden]);

    const forOwner = await (await fetch(`${h.base}/api/dev/board-previews`, { headers: { cookie: owner.cookie } })).json();
    expect(forOwner).toHaveProperty([hidden]);
  });

  it('the list needs a session', async () => {
    expect((await fetch(`${h.base}/api/dev/board-previews`)).status).toBe(401);
  });

  it('the picture is written as one file under the data dir, with no temporary file left behind', async () => {
    const board = await sharedBoard();
    expect((await putPicture(h, editor, board, SVG)).status).toBe(204);
    const dir = path.join(h.dir, 'dev-previews');
    expect(fs.readFileSync(path.join(dir, `${board}.svg`), 'utf8')).toBe(SVG);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('dev previews, switched off (no TABULA_DEV_PREVIEWS)', () => {
  const h = createHarness({ accounts: true });
  let owner: Account;

  beforeAll(async () => {
    await h.start();
    owner = await h.signInOwner();
  });

  afterAll(() => h.cleanup());

  it('the routes do not exist: 404 for a signed-in person, and for no one', async () => {
    const board = await h.newBoard(owner.cookie);
    expect((await fetch(`${h.base}/api/dev/board-previews`, { headers: { cookie: owner.cookie } })).status).toBe(404);
    expect((await getPicture(h, owner, board)).status).toBe(404);
    expect((await putPicture(h, owner, board, SVG)).status).toBe(404);
    expect((await getPicture(h, undefined, board)).status).toBe(404);
    expect(fs.existsSync(path.join(h.dir, 'dev-previews'))).toBe(false);
  });
});

describe('the built-in templates draw pictures the server accepts', () => {
  it.each(TEMPLATES.map((t) => [t.id]))('%s', (id) => {
    const def = TEMPLATES.find((t) => t.id === id)!;
    const svg = previewSvgFor(templateObjects(def), { reveal: false });
    expect(previewProblem(svg)).toBeNull();
    expect(svg.length).toBeLessThan(DEV_PREVIEW_MAX_BYTES);
  });
});
