import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { objectMarkup } from '../src/markup';
import { FAILED_LABEL } from '../src/image-loader';
import { fontCss, measure } from '../src/text';
import { imagesLeftOut, toTemplateContent, validateContent } from '../src/custom-templates';
import type { BaseObj, Obj } from '../src/types';

// docs/images.md, Object model, Rendering and Templates.

const HASH = 'ab'.repeat(32);
const image = (extra: Partial<BaseObj> = {}): BaseObj => ({ id: 'img', type: 'image', x: 10, y: 20, w: 200, h: 100, rotation: 0, z: 'a0', asset: HASH, mime: 'image/png', nw: 400, nh: 200, ...extra });
const ctx = (state?: Parameters<NonNullable<Parameters<typeof objectMarkup>[1]['imageState']>>[0] extends BaseObj ? ReturnType<NonNullable<Parameters<typeof objectMarkup>[1]['imageState']>> : never) => ({
  get: () => undefined as Obj | undefined,
  ...(state ? { imageState: () => state } : {}),
});

describe('the image object', () => {
  it('goes through the store with its fields', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => store.create(image({ alt: 'a cat' })));
    expect(store.get('img')).toMatchObject({ type: 'image', asset: HASH, mime: 'image/png', nw: 400, nh: 200, alt: 'a cat' });
    store.transact(() => store.update('img', { asset: 'cd'.repeat(32) }));
    expect((store.get('img') as BaseObj).asset).toBe('cd'.repeat(32));
  });
});

describe('image markup', () => {
  it('draws the pixels through <image>, never as markup, at the object size', () => {
    const svg = objectMarkup(image(), ctx({ kind: 'ok', url: 'blob:http://x/1' }));
    expect(svg).toContain('<image href="blob:http://x/1"');
    expect(svg).toContain('width="200" height="100"');
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('translate(10 20)');
  });

  it('escapes the URL and the alt text', () => {
    const svg = objectMarkup(image({ alt: '</title><script>alert(1)</script>' }), ctx({ kind: 'ok', url: 'blob:"><script>' }));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/title&gt;');
  });

  it('draws a placeholder that says why, with the pixel size', () => {
    const loading = objectMarkup(image(), ctx({ kind: 'loading' }));
    expect(loading).toContain('Loading');
    expect(loading).toContain('400 × 200');
    expect(loading).not.toContain('<image');
    expect(objectMarkup(image(), ctx({ kind: 'failed', why: 'not_uploaded' }))).toContain('Image not uploaded yet');
    expect(objectMarkup(image(), ctx({ kind: 'failed', why: 'denied' }))).toContain('No access to this image');
  });

  it('fits the lost-image label inside a 417 by 100 frame', () => {
    for (const width of [417, 80]) {
      const svg = objectMarkup(image({ w: width, h: 100 }), ctx({ kind: 'failed', why: 'lost' }));
      const lines = [...svg.matchAll(/<text\b[^>]*font-size="([^"]+)"[^>]*>(.*?)<\/text>/g)].map((match) => ({
        text: match[2], size: Number(match[1]),
      }));

      expect(lines.map((line) => line.text).join(' ')).toBe(`${FAILED_LABEL.lost} 400 × 200`);
      for (const line of lines) expect(measure(line.text, fontCss('satoshi', line.size, 400))).toBeLessThanOrEqual(width - 16);
    }
  });

  it('draws the placeholder without a loader, as an export does', () => {
    expect(objectMarkup(image(), ctx())).toContain('Loading');
  });

  it('leaves out the text of a placeholder too small to hold it', () => {
    expect(objectMarkup(image({ w: 40, h: 30 }), ctx({ kind: 'loading' }))).not.toContain('<text');
  });

  it('uses theme colours for the placeholder, with fallbacks', () => {
    const svg = objectMarkup(image(), ctx({ kind: 'loading' }));
    expect(svg).toContain('var(--graphite');
    expect(svg).toContain('var(--rule');
  });
});

describe('templates and images', () => {
  const sticky: BaseObj = { id: 's', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: 'a1', text: 'hi' };

  it('leaves images out of a saved template and counts them', () => {
    const objs: Obj[] = [sticky, image(), image({ id: 'img2' })];
    expect(imagesLeftOut(objs)).toBe(2);
    const content = toTemplateContent(objs, [], { includeSteps: false });
    expect(content.objects.map((o) => o.type)).toEqual(['sticky']);
  });

  it('refuses an image in template content, as the server does', () => {
    const content = toTemplateContent([sticky], [], { includeSteps: false });
    expect(() => validateContent(content)).not.toThrow();
    const bad = { ...content, objects: [...content.objects, { ...image(), id: 'o9', z: '9' }] };
    expect(() => validateContent(bad)).toThrow(/unknown type/);
  });
});
