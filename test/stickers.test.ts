import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { CURATED_SETS, PINNED, buildIcons } from '../scripts/build-icons.mjs';
import { POPULAR_SETS } from '../src/icons';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';
import { REACTIONS, STICKER_SETS, isSticker, scopeSvgIds, stickerSize } from '../src/stickers';

const sticker = (id: string): BaseObj => ({
  id, type: 'icon', x: 0, y: 0, w: 120, h: 120, rotation: 0, z: 'a0',
  ref: 'twemoji:rocket', body: '<path fill="#55ACEE" d="M0 0h36v36H0z"/>', viewBox: [0, 0, 36, 36], sticker: true,
});

describe('scopeSvgIds', () => {
  it('never lets a crafted object id break out of the attribute', () => {
    const out = scopeSvgIds('<linearGradient id="g"/><path fill="url(#g)"/>', 'x"><script>alert(1)</script><a b="');
    expect(out).not.toMatch(/<script|<a /);
    expect(out).toContain('id="ix___script_alert_1___script__a_b__-g"');
  });

  it('rewrites defined ids and every reference to them, with double quotes', () => {
    const body = '<defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0"/><use href="#g"/><use xlink:href="#g"/>';
    const out = scopeSvgIds(body, 'o1');
    expect(out).toContain('<linearGradient id="io1-g"/>');
    expect(out).toContain('fill="url(#io1-g)"');
    expect(out).toContain('<use href="#io1-g"/>');
    expect(out).toContain('<use xlink:href="#io1-g"/>');
    expect(out).not.toContain('#g"');
  });

  it('handles single quotes and quoted url() references', () => {
    const body = "<defs><radialGradient id='r'/></defs><path style=\"fill:url('#r')\" d='M0 0'/><path fill='url(#r)'/><use href='#r'/>";
    const out = scopeSvgIds(body, 'o2');
    expect(out).toContain("<radialGradient id='io2-r'/>");
    expect(out).toContain("fill:url('#io2-r')");
    expect(out).toContain("fill='url(#io2-r)'");
    expect(out).toContain("<use href='#io2-r'/>");
  });

  it('leaves references to ids the body does not define alone', () => {
    const body = '<path id="a" fill="url(#missing)"/><use href="#other"/>';
    const out = scopeSvgIds(body, 'o3');
    expect(out).toContain('id="io3-a"');
    expect(out).toContain('url(#missing)');
    expect(out).toContain('href="#other"');
  });

  it('returns a body without ids unchanged', () => {
    const body = '<path d="M0 0h24v24H0z" data-id="x" fill="url(#gone)"/>';
    expect(scopeSvgIds(body, 'o4')).toBe(body);
  });
});

describe('sticker rules', () => {
  it('offers unique sets and exactly 16 unique reactions', () => {
    const prefixes = STICKER_SETS.map((s) => s.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).not.toContain('fluent-emoji-high-contrast');
    expect(prefixes).not.toContain('fluent-emoji');
    expect(STICKER_SETS.filter((s) => s.default)).toHaveLength(1);
    expect(REACTIONS).toHaveLength(16);
    expect(new Set(REACTIONS).size).toBe(16);
  });

  it('keeps aspect ratio with the longest side at the requested size', () => {
    expect(stickerSize(36, 36)).toEqual({ w: 120, h: 120 });
    expect(stickerSize(32, 16)).toEqual({ w: 120, h: 60 });
    expect(stickerSize(16, 32)).toEqual({ w: 60, h: 120 });
    expect(stickerSize(36, 36, 40)).toEqual({ w: 40, h: 40 });
    expect(stickerSize(0, 0)).toEqual({ w: 120, h: 120 });
  });

  it('is a sticker only when the icon carries the flag', () => {
    expect(isSticker(sticker('s'))).toBe(true);
    expect(isSticker({ ...sticker('i'), sticker: undefined })).toBe(false);
    expect(isSticker({ ...sticker('n'), type: 'shape', kind: 'rect' })).toBe(false);
  });

  it('round-trips a sticker through the board document', () => {
    const d1 = new Y.Doc(), d2 = new Y.Doc();
    const s1 = new Store(d1), s2 = new Store(d2);
    s1.transact(() => s1.create(sticker('st')));
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const o = s2.get('st') as BaseObj;
    expect(o.sticker).toBe(true);
    expect(o.body).toBe('<path fill="#55ACEE" d="M0 0h36v36H0z"/>');
    expect(o.viewBox).toEqual([0, 0, 36, 36]);
    expect(o.ref).toBe('twemoji:rocket');
  });

  it('creates no sticker while the store is read-only', () => {
    const s = new Store(new Y.Doc());
    s.setReadOnly(true);
    s.transact(() => s.create(sticker('ro')));
    expect(s.objects.size).toBe(0);
  });
});

describe('hosted icon sets', () => {
  const GZIP_BUDGET = 20 * 1024 * 1024;
  let out: string;
  let manifest: { sets: { p: string }[]; pin: { f: string; names: string[] } };

  const read = (file: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(out, `${file}.gz`))).toString());
  const sizeOf = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? sizeOf(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);

  beforeAll(async () => {
    out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-curated-')), 'icons');
    await buildIcons({ sets: CURATED_SETS, out });
    manifest = read('manifest.json');
  }, 60_000);

  afterAll(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));

  it('hosts every sticker set and every popular set', () => {
    const hosted = manifest.sets.map((x) => x.p);
    expect(STICKER_SETS.filter((s) => !hosted.includes(s.prefix))).toEqual([]);
    expect(POPULAR_SETS.filter((p) => !hosted.includes(p))).toEqual([]);
  });

  it('puts the 16 reactions in the pin file, in the order of REACTIONS', () => {
    expect(PINNED).toEqual(REACTIONS);
    expect(manifest.pin.names).toEqual(REACTIONS);
    const pins = read(`pin.${manifest.pin.f}.json`);
    expect(Object.keys(pins).sort()).toEqual([...REACTIONS].sort());
    expect(REACTIONS.filter((name) => !pins[name].b.startsWith('<'))).toEqual([]);
  });

  it('stays under the size budget', () => {
    expect(sizeOf(out)).toBeLessThan(GZIP_BUDGET);
  });
});
