import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';
import { REACTIONS, STICKER_SETS, isSticker, scopeSvgIds, stickerSize } from '../src/stickers';

const sticker = (id: string): BaseObj => ({
  id, type: 'icon', x: 0, y: 0, w: 120, h: 120, rotation: 0, z: 'a0',
  ref: 'twemoji:rocket', body: '<path fill="#55ACEE" d="M0 0h36v36H0z"/>', viewBox: [0, 0, 36, 36], sticker: true,
});

describe('scopeSvgIds', () => {
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
