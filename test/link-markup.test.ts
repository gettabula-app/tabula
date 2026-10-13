import { describe, expect, it } from 'vitest';
import { clampLines, linkMarkup } from '../src/link-markup';
import { objectMarkup } from '../src/markup';
import type { BaseObj } from '../src/types';
import { LINK_SIZES } from '../src/link-cards';

// The card as SVG (proto/designer-preview/link-cards/SPEC.md): the layouts, the states, what is escaped and what is never drawn.

const link = (over: Partial<BaseObj> = {}): BaseObj => ({
  id: 'l1', type: 'link', x: 10, y: 20, ...LINK_SIZES.card, rotation: 0, z: 'a0', url: 'https://www.example.com/page?x=1', title: 'A page about <b>things</b>', description: 'What it says.',
  siteName: 'Example', unfurl: 'ok', ...over,
} as BaseObj);
const HASH = 'a'.repeat(64);
const ok = (url = 'blob:http://x/1') => ({ kind: 'ok' as const, url });
const textsOf = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe('the card as markup', () => {
  it('is real, escaped text with the title and the domain, and a link name for assistive tech', () => {
    const svg = linkMarkup(link());
    const t = textsOf(svg);
    expect(t).toContain('EXAMPLE'); // the site row
    expect(t.some((x) => x.includes('A page about &lt;b&gt;things&lt;/b&gt;'))).toBe(true);
    expect(t).toContain('example.com');
    expect(svg).toContain('role="link"');
    expect(svg).toContain('aria-label="Link card: A page about &lt;b&gt;things&lt;/b&gt;, example.com');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('<title>https://www.example.com/page?x=1</title>');
  });

  it.each(['compact', 'card', 'large'] as const)('draws the %s layout at its default size without leaving the box', (name) => {
    const o = link({ ...LINK_SIZES[name] });
    const svg = linkMarkup(o, { assetState: () => ok() });
    const { w, h } = LINK_SIZES[name];
    for (const m of svg.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      expect(Number(m[1])).toBeLessThanOrEqual(w);
      expect(Number(m[2])).toBeGreaterThan(0);
      expect(Number(m[2])).toBeLessThanOrEqual(h);
    }
  });

  it('puts the picture beside the text on a card and across the top when large, and never a remote address', () => {
    const withImage = link({ image: HASH, imageW: 1200, imageH: 630 });
    const card = linkMarkup(withImage, { assetState: () => ok('blob:http://x/img') });
    expect(card).toMatch(/<image href="blob:http:\/\/x\/img" x="210" y="0" width="110" height="128"/);
    const large = linkMarkup({ ...withImage, ...LINK_SIZES.large }, { assetState: () => ok('blob:http://x/img') });
    expect(large).toMatch(/<image href="blob:http:\/\/x\/img" x="0" y="0" width="320"/);
    for (const svg of [card, large]) expect(svg).not.toMatch(/href="https?:/);
    // while the picture loads its place is kept; when it failed the text spans the width
    const loading = linkMarkup(withImage, { assetState: () => ({ kind: 'loading' }) });
    expect(loading).toContain('fill="var(--canvas, #EEF1F4)"');
    expect(loading).not.toContain('<image');
    const failed = linkMarkup(withImage, { assetState: () => ({ kind: 'failed', why: 'missing' }) });
    expect(failed).not.toContain('<image');
    expect(failed).not.toContain('fill="var(--canvas, #EEF1F4)"');
  });

  it('draws the letter icon without an icon asset and the icon image with one', () => {
    expect(linkMarkup(link())).toMatch(/>E<\/text>/);
    const withIcon = linkMarkup(link({ icon: HASH }), { assetState: () => ok('blob:http://x/icon') });
    expect(withIcon).toContain('href="blob:http://x/icon"');
    expect(withIcon).not.toMatch(/>E<\/text>/);
  });

  it('shows the address and "Loading preview…" with a moving line while pending, and stills it for an export', () => {
    const pending = link({ unfurl: 'pending', title: undefined });
    const svg = linkMarkup(pending);
    expect(textsOf(svg)).toContain('Loading preview…');
    expect(textsOf(svg).some((x) => x.startsWith('https://www.example.com/page'))).toBe(true);
    expect(svg).toContain('class="link-seg"');
    const still = linkMarkup(pending, { still: true });
    expect(still).not.toContain('link-seg');
    expect(textsOf(still)).not.toContain('Loading preview…');
  });

  it('says "No preview" when it failed, and nothing extra when previews are off', () => {
    expect(textsOf(linkMarkup(link({ unfurl: 'failed', unfurlError: 'timeout' })))).toContain('No preview');
    const off = textsOf(linkMarkup(link({ unfurl: 'off' })));
    expect(off).not.toContain('No preview');
    expect(off).not.toContain('Loading preview…');
  });

  it('survives an object that holds anything', () => {
    const svg = linkMarkup({ ...link(), url: 'javascript:alert(1)', title: 42, image: '"><script>', unfurl: 'ok' } as unknown as BaseObj);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('javascript:');
  });

  it('cuts a long title with an ellipsis and keeps a long word inside the box', () => {
    const font = '700 14px sans-serif';
    const lines = clampLines(`${'word '.repeat(60)}`, font, 200, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(clampLines('x'.repeat(300), font, 200, 2).every((l) => l.length > 0)).toBe(true);
  });

  it('is drawn by objectMarkup for the link type, translated to its place', () => {
    const svg = objectMarkup(link(), { get: () => undefined });
    expect(svg.startsWith('<g transform="translate(10 20)"')).toBe(true);
    expect(svg).toContain('class="link-card"');
  });

  it('is a real link in an export: an anchor with the address, a new tab, no opener or referrer, and the picture inlined', () => {
    const svg = linkMarkup(link({ image: HASH, icon: HASH, imageW: 10, imageH: 10 }), { still: true, assetState: () => ok('data:image/png;base64,AAAA') });
    expect(svg).toMatch(/^<a class="link-card" href="https:\/\/www\.example\.com\/page\?x=1" target="_blank" rel="noopener noreferrer"/);
    expect(svg).toContain('<title>https://www.example.com/page?x=1</title>');
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(svg).not.toContain('link-seg');
    expect(linkMarkup({ ...link(), url: 'javascript:alert(1)' } as BaseObj, { still: true })).not.toContain('<a ');
  });
});
