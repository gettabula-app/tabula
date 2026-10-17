import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEMPLATES } from '../src/templates';
import { templateObjects } from '../src/template-thumb';
import { buildPictureSvg, embedImages, exportPictureSvg, fitPicture, pictureObject, PICTURE_MAX_OBJECTS } from '../src/preview-render';
import { whitelistProblems } from '../src/preview-svg-safe';
import type { Obj } from '../src/types';

// The picture of a board (src/preview-render.ts): the app's export drawn from a detached board, through the whitelist. These tests run the
// real export (no DOM: text is measured by estimate) and stub every request, so a request outside this origin would fail the test.

const BOARD = 'board-under-test';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

const sticky = (id: string, text: string, extra: Record<string, unknown> = {}): Obj => ({
  id, type: 'sticky', text, fill: '#FFE16B', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: id, ...extra,
} as Obj);
const image = (id: string, asset: string, mime = 'image/png', extra: Record<string, unknown> = {}): Obj => ({
  id, type: 'image', asset, mime, nw: 8, nh: 8, x: 300, y: 0, w: 120, h: 90, rotation: 0, z: id, ...extra,
} as Obj);

const HOSTILE_TEXT = [
  '<script>alert("pwned")</script>',
  '</text><foreignObject><div>x</div></foreignObject><text>',
  ']]> <![CDATA[ still text',
  'url(http://evil.example/a.css) @import "http://evil.example/b.css";',
  '&amp; &lt;b&gt; &#60;img src=x&#62;',
  'مرحبا بالعالم  ‮flip‬',
  'ctrl\u0000\u0001\u0007\u001bchars',
  'z'.repeat(6000),
].join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a hostile board through the export', () => {
  it('stays whitelisted: no script, no foreign markup, no external reference, text escaped and capped', () => {
    const objects: Obj[] = [
      sticky('s1', HOSTILE_TEXT),
      { id: 'sh', type: 'shape', kind: 'rect', text: HOSTILE_TEXT, fill: '#FFFFFF', x: 0, y: 260, w: 260, h: 120, rotation: 0, z: 'sh' } as unknown as Obj,
      { id: 'fr', type: 'frame', name: HOSTILE_TEXT.slice(0, 200), fill: '#E4EFFF', x: -40, y: -60, w: 400, h: 500, rotation: 0, z: 'fr' } as unknown as Obj,
      { id: 'cn', type: 'connector', label: HOSTILE_TEXT.slice(0, 80), from: { kind: 'bound', id: 's1', anchor: 'auto' }, to: { kind: 'free', x: 500, y: 500 }, route: 'straight', startHead: 'none', endHead: 'arrow', stroke: '#18212B', z: 'cn' } as unknown as Obj,
      image('im', 'https://evil.example/pixel.png'),
      image('im2', HASH, 'image/svg+xml'),
      { id: 'lk', type: 'link', url: 'https://evil.example/track?x=1', title: HOSTILE_TEXT, x: 0, y: 500, w: 200, h: 100, rotation: 0, z: 'lk' } as unknown as Obj,
    ];
    const svg = exportPictureSvg(objects, new Map());
    expect(whitelistProblems(svg)).toEqual([]);
    // the hostile words are drawn as escaped text (what the person typed), never as markup or as a live reference
    expect(svg).not.toMatch(/<(script|foreignObject|style|a|use|animate|set|iframe|object|embed|filter|title|image)\b/);
    expect(svg).not.toMatch(/<!\[CDATA|<\?xml|<!DOCTYPE/);
    expect(svg).not.toMatch(/\s(href|src|xlink:href|style|onload|onclick)="/);
    expect(svg).not.toMatch(/(fill|stroke)="url\((?!#)/);
    expect(svg).not.toMatch(/data:image\/svg/);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp;amp; &amp;lt;b&amp;gt;');
    expect(svg).toContain(']]&gt; &lt;![CDATA[ still text');
    expect(svg.length).toBeLessThan(120_000);
  });

  it('an image object whose asset is an address draws a placeholder, and the address stays out of the picture', () => {
    const svg = exportPictureSvg([image('im', 'https://evil.example/pixel.png')], new Map());
    expect(svg).not.toContain('evil.example');
    expect(svg).not.toContain('<image');
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('a picture of its own image is embedded as data, and only as a bitmap', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    const svg = exportPictureSvg([image('im', HASH)], new Map([['im', data]]));
    expect(svg).toContain(`href="${data}"`);
    expect(whitelistProblems(svg)).toEqual([]);
  });
});

describe('the drawn objects and the view', () => {
  it('a card, tracker, table, code block and link are drawn as plain blocks: their words never reach the picture', () => {
    const objects: Obj[] = [
      { id: 'c', type: 'card', text: 'CARD-SECRET-WORDS', ownerName: 'Pia Larsen', fill: '#FFFFFF', x: 0, y: 0, w: 200, h: 100, rotation: 0, z: 'c' } as unknown as Obj,
      { id: 't', type: 'table', text: 'TABLE-WORDS', x: 220, y: 0, w: 200, h: 100, rotation: 0, z: 't' } as unknown as Obj,
      { id: 'k', type: 'code', text: 'CODE-WORDS', x: 0, y: 120, w: 200, h: 100, rotation: 0, z: 'k' } as unknown as Obj,
      { id: 'l', type: 'link', title: 'LINK-WORDS', url: 'https://x.example/', x: 220, y: 120, w: 200, h: 100, rotation: 0, z: 'l' } as unknown as Obj,
    ];
    const svg = exportPictureSvg(objects, new Map());
    for (const words of ['CARD-SECRET-WORDS', 'Pia Larsen', 'TABLE-WORDS', 'CODE-WORDS', 'LINK-WORDS', 'x.example']) expect(svg).not.toContain(words);
    expect(pictureObject(objects[0]!).type).toBe('shape');
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('a kanban is drawn as blocks: no placeholder words of the app (Container, Lane, Needs a newer Tabula) in the picture', () => {
    const objects: Obj[] = [
      { id: 'kc', type: 'container', x: 0, y: 0, w: 400, h: 300, rotation: 0, z: 'kc', fill: '#FFFFFF' } as unknown as Obj,
      { id: 'kl', type: 'lane', parent: 'kc', x: 10, y: 40, w: 180, h: 240, rotation: 0, z: 'kl', fill: '#F3F5F7' } as unknown as Obj,
      { id: 'kk', type: 'card', parent: 'kl', text: 'CARD-WORDS', x: 20, y: 60, w: 160, h: 60, rotation: 0, z: 'kk' } as unknown as Obj,
    ];
    const res = buildPictureSvg(objects, {});
    expect(res.mode).toBe('export');
    for (const word of ['Container', 'Lane', 'Needs a newer Tabula', 'CARD-WORDS']) expect(res.svg).not.toContain(word);
    expect(whitelistProblems(res.svg)).toEqual([]);
  });

  it('the view is letterboxed to 16:10 around the board, never cropped', () => {
    const [x, y, w, h] = fitPicture({ x: 0, y: 0, w: 1000, h: 100 });
    expect(w / h).toBeCloseTo(480 / 300, 6);
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
    expect(w).toBeGreaterThan(1000);
  });

  it('every built-in template draws a whitelisted picture in the export', () => {
    for (const def of TEMPLATES) {
      const res = buildPictureSvg(templateObjects(def), {});
      expect([def.id, res.mode, whitelistProblems(res.svg)]).toEqual([def.id, 'export', []]);
    }
  });

  it('falls back to the blocks for an empty board, a large one, or when asked; the blocks are whitelisted too', () => {
    expect(buildPictureSvg([], {})).toMatchObject({ mode: 'blocks', reason: 'empty' });
    const many = Array.from({ length: PICTURE_MAX_OBJECTS + 1 }, (_, i) => sticky(`n${i}`, `note ${i}`, { x: i, y: i }));
    expect(buildPictureSvg(many, {})).toMatchObject({ mode: 'blocks', reason: 'large' });
    const chosen = buildPictureSvg([sticky('a', 'hi')], { mode: 'blocks' });
    expect(chosen).toMatchObject({ mode: 'blocks', reason: 'the blocks are chosen' });
    expect(whitelistProblems(chosen.svg)).toEqual([]);
    expect(whitelistProblems(buildPictureSvg(many, {}).svg)).toEqual([]);
  });
});

describe('the image loader: the same origin, the cookie, and nothing else', () => {
  /** A fetch stub that answers every request with `make(url)`, and fails the test on a request that leaves this origin. */
  function sameOriginFetch(make: (url: string) => Response | Promise<Response>) {
    const calls: string[] = [];
    const fn = vi.fn<(input: unknown) => Promise<Response>>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (!url.startsWith('/') || url.startsWith('//')) throw new Error(`a request left this origin: ${url}`);
      return make(url);
    });
    return { fn, calls };
  }
  const png = (length = 40) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: Math.max(0, length - 4) }, () => 1)]);
  const response = (bytes: Uint8Array, type = 'image/png', extra: Record<string, string> = {}) =>
    new Response(bytes.slice(), { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length), ...extra } });

  /** The shrink of these tests returns the image as it came: the loader's own checks are what is under test here. */
  const KEEP = { shrink: async (bytes: Uint8Array, type: string) => ({ bytes, type }) };
  /** A body that never ends: each pull adds `chunk` bytes, and cancel() is counted. */
  function endlessBody(chunk = 100) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(chunk).fill(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, pulls: () => pulls, cancelled: () => cancelled };
  }

  it('a body that lies about its length is stopped at the cap: the declared size is not the limit', async () => {
    const big = new Response(new Blob([new Uint8Array(3000)]), { headers: { 'content-type': 'image/png', 'content-length': '40' } });
    const { fn } = sameOriginFetch(() => big);
    const out = await embedImages([image('a', HASH)], BOARD, fn, { maxBytes: 1000, ...KEEP });
    expect(out.size).toBe(0);
  });

  it('an endless stream is cancelled once it passes the cap, and nothing is read past it', async () => {
    const endless = endlessBody(100);
    const { fn } = sameOriginFetch(() => new Response(endless.body, { headers: { 'content-type': 'image/png' } }));
    const out = await embedImages([image('a', HASH)], BOARD, fn, { maxBytes: 1000, ...KEEP });
    expect(out.size).toBe(0);
    expect(endless.cancelled()).toBe(true);
    expect(endless.pulls()).toBeLessThanOrEqual(12);
  });

  it('readCappedBody returns the whole body under the cap, and null for a missing body or one over it', async () => {
    const { readCappedBody } = await import('../src/preview-render');
    const bytes = png(60);
    expect(await readCappedBody(response(bytes), 1000)).toEqual(bytes);
    expect(await readCappedBody(new Response(null), 1000)).toBeNull();
    expect(await readCappedBody(new Response(new Uint8Array(2000)), 1000)).toBeNull();
  });

  it('every image is handed to the shrink as the bytes the server sent, and an image the shrink cannot make is left out', async () => {
    const seen: string[] = [];
    const { fn } = sameOriginFetch(() => response(png()));
    const out = await embedImages([image('a', HASH)], BOARD, fn, {
      shrink: async (bytes, type) => { seen.push(`${type}:${bytes.length}`); return null; },
    });
    expect(seen).toEqual(['image/png:40']);
    expect(out.size).toBe(0);
  });

  it('a shrunk image over the shrunk cap, or in a type the picture does not take, is left out', async () => {
    const { fn } = sameOriginFetch(() => response(png()));
    const jpegOverCap = new Uint8Array(200_000);
    jpegOverCap[0] = 0xff;
    jpegOverCap[1] = 0xd8;
    const huge = await embedImages([image('a', HASH)], BOARD, fn, {
      shrink: async () => ({ bytes: jpegOverCap, type: 'image/jpeg' }),
    });
    const wrongType = await embedImages([image('a', HASH)], BOARD, fn, { shrink: async (bytes) => ({ bytes, type: 'image/svg+xml' }) });
    expect([huge.size, wrongType.size]).toEqual([0, 0]);
  });

  it('the default shrink needs a canvas: with none (node, or a browser without one) the image is left out, not embedded as sent', async () => {
    const { fn } = sameOriginFetch(() => response(png()));
    const out = await embedImages([image('a', HASH)], BOARD, fn);
    expect(out.size).toBe(0);
  });

  it('fetches each board image once, from its own asset address, and maps every object that uses it', async () => {
    const { fn, calls } = sameOriginFetch(() => response(png()));
    const objects = [image('a', HASH), image('b', HASH), image('c', OTHER_HASH)];
    const out = await embedImages(objects, BOARD, fn, KEEP);
    expect(calls).toEqual([`/api/boards/${BOARD}/assets/${HASH}`, `/api/boards/${BOARD}/assets/${OTHER_HASH}`]);
    expect(out.get('a')).toMatch(/^data:image\/png;base64,/);
    expect(out.get('b')).toBe(out.get('a'));
    expect(out.size).toBe(3);
  });

  it('never fetches a user SVG, an address in place of a hash, a link preview or an icon', async () => {
    const { fn, calls } = sameOriginFetch(() => response(png()));
    const objects: Obj[] = [
      image('svg', HASH, 'image/svg+xml'),
      image('addr', 'https://evil.example/p.png'),
      image('none', 'pending:1234', 'image/png'),
      { id: 'link', type: 'link', image: HASH, icon: OTHER_HASH, url: 'https://evil.example/', x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 'l' } as unknown as Obj,
    ];
    const out = await embedImages(objects, BOARD, fn, KEEP);
    expect(calls).toEqual([]);
    expect(out.size).toBe(0);
  });

  it('refuses a redirect, a different content type, an oversized body and bytes that are not the type they claim', async () => {
    const cases: [string, () => Response][] = [
      ['a redirect', () => Object.assign(response(png()), { redirected: true })],
      ['the wrong type', () => response(png(), 'text/html')],
      ['a declared size over the cap', () => response(png(), 'image/png', { 'content-length': '2000000' })],
      ['a body over the cap', () => new Response(new Blob([new Uint8Array(3000)]), { headers: { 'content-type': 'image/png' } })],
      ['bytes that are not a PNG', () => response(new Uint8Array(40), 'image/png')],
      ['a server error', () => new Response('no', { status: 500 })],
    ];
    for (const [label, make] of cases) {
      const { fn } = sameOriginFetch(make);
      const out = await embedImages([image('a', HASH)], BOARD, fn, { maxBytes: 1000, ...KEEP });
      expect([label, out.size]).toEqual([label, 0]);
    }
  });

  it('draws at most ten images, and stops when the time for all of them is spent', async () => {
    const { fn, calls } = sameOriginFetch(() => response(png()));
    const many = Array.from({ length: 12 }, (_, i) => image(`i${i}`, String(i).padStart(64, 'c')));
    const out = await embedImages(many, BOARD, fn, KEEP);
    expect(calls).toHaveLength(10);
    expect(out.size).toBe(10);

    let clock = 0;
    const slow = sameOriginFetch(async () => { clock += 3000; return response(png()); });
    const timed = await embedImages(many, BOARD, slow.fn, { budgetMs: 5000, now: () => clock, ...KEEP });
    expect(slow.calls.length).toBeLessThan(10);
    expect(timed.size).toBe(slow.calls.length);
  });

  it('a network failure of one image leaves its objects as placeholders and does not stop the others', async () => {
    const { fn } = sameOriginFetch((url) => {
      if (url.includes(HASH)) throw new TypeError('down');
      return response(png());
    });
    const out = await embedImages([image('a', HASH), image('b', OTHER_HASH)], BOARD, fn, KEEP);
    expect(out.has('a')).toBe(false);
    expect(out.has('b')).toBe(true);
  });

  it('the picture is made without any request: nothing leaves the page while it is drawn', () => {
    vi.stubGlobal('fetch', vi.fn<() => never>(() => { throw new Error('a request during render'); }));
    expect(() => buildPictureSvg(templateObjects(TEMPLATES[0]!), { images: new Map([['x', 'data:image/png;base64,AAAA']]) })).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
