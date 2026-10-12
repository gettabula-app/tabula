import { describe, expect, it, vi } from 'vitest';
import {
  LETTER_COLOURS, LINK_SIZES, domainOf, layoutOf, letterColour, letterOf, linkLabel, linkTooltip, linkView, loneUrl, maskSecrets, normaliseUrl,
  markdownLink, openLink, secretLooking, urlsFromList,
} from '../src/link-cards';
import { luminance } from '../src/palette';
import { THEMES } from '../src/themes';

// The pure rules of link cards (docs/link-cards.md, proto/designer-preview/link-cards/SPEC.md).

describe('layout from size', () => {
  it('is compact under 72 high, large when tall for its width, else card, and each default lands on its own layout', () => {
    expect([layoutOf(320, 48), layoutOf(320, 71), layoutOf(320, 72), layoutOf(320, 128), layoutOf(320, 255), layoutOf(320, 256), layoutOf(320, 280)]).toEqual(['compact', 'compact', 'card', 'card', 'card', 'large', 'large']);
    for (const [name, size] of Object.entries(LINK_SIZES)) expect([name, layoutOf(size.w, size.h)]).toEqual([name, name]);
    expect(layoutOf(0, 200)).toBe('card');
  });
});

describe('addresses', () => {
  it('keeps the URL parser form with the fragment, and turns away what is not a web address', () => {
    expect(normaliseUrl(' HTTPS://Example.COM/a b?x=1#frag ')).toEqual({ ok: true, url: 'https://example.com/a%20b?x=1#frag' });
    const bad: [string, string][] = [['', 'empty'], ['   ', 'empty'], ['example.com', 'invalid'], ['javascript:alert(1)', 'scheme'], ['data:text/html,x', 'scheme'], ['file:///etc/passwd', 'scheme'], ['mailto:a@b.c', 'scheme'], ['https://user:pw@example.com/', 'credentials'], ['https://user@example.com/', 'credentials'], [`https://x.test/${'a'.repeat(2100)}`, 'too_long']];
    for (const [input, reason] of bad) expect([input.slice(0, 30), normaliseUrl(input)]).toEqual([input.slice(0, 30), { ok: false, reason }]);
  });

  it('takes a lone address from the clipboard and nothing else', () => {
    expect(loneUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(loneUrl('  http://example.com \n')).toBe('http://example.com/');
    for (const text of ['see https://example.com', 'https://a.test https://b.test', 'https://a.test\nhttps://b.test', 'example.com', 'ftp://a.test', '', 'https://u:p@a.test/', 'hello']) expect([text, loneUrl(text)]).toEqual([text, null]);
  });

  it('reads a dropped uri-list: comments skipped, bad lines dropped, repeats merged, at most ten', () => {
    const list = ['# a comment', 'https://a.test/', 'javascript:x', 'https://a.test/', 'https://b.test/', ...Array.from({ length: 20 }, (_, i) => `https://c${i}.test/`)].join('\r\n');
    const urls = urlsFromList(list);
    expect(urls).toHaveLength(10);
    expect(urls.slice(0, 2)).toEqual(['https://a.test/', 'https://b.test/']);
  });

  it('names the site without www', () => {
    expect([domainOf('https://www.Example.com/x'), domainOf('https://sub.example.org'), domainOf('nonsense')]).toEqual(['example.com', 'sub.example.org', '']);
  });
});

describe('secrets in an address', () => {
  it('warns on keys that usually hold one, and cuts the value for display', () => {
    for (const url of ['https://a.test/?token=abc', 'https://a.test/?x=1&api_key=k', 'https://a.test/cb?code=1', 'https://a.test/?Signature=zz', 'https://a.test/?X-Amz-Signature=q']) expect([url, secretLooking(url)]).toEqual([url, true]);
    for (const url of ['https://a.test/', 'https://a.test/?q=search&page=2', 'https://a.test/token/abc', 'nonsense']) expect([url, secretLooking(url)]).toEqual([url, false]);
    expect(maskSecrets('https://a.test/p?token=abc123&q=hi')).toBe('https://a.test/p?token=…&q=hi');
  });
});

describe('the letter icon', () => {
  it('is the first letter of the domain, in one stable colour per domain', () => {
    expect([letterOf('example.com'), letterOf('www.zeta.io'), letterOf(''), letterOf('élan.fr')]).toEqual(['E', 'Z', '?', 'É']);
    expect(letterColour('example.com')).toBe(letterColour('EXAMPLE.com'));
    expect(LETTER_COLOURS).toContain(letterColour('anything.test'));
    expect(new Set(['a.test', 'b.test', 'c.test', 'd.test', 'e.test', 'f.test', 'g.test', 'h.test'].map(letterColour)).size).toBeGreaterThan(2);
  });

  it.each([...LETTER_COLOURS])('%s carries a white letter at 4.5:1 or more', (c) => {
    expect((luminance('#FFFFFF') + 0.05) / (luminance(c) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('what the card says', () => {
  const ok = { url: 'https://www.example.com/a', title: ' A  title ', description: 'About', siteName: 'Example', unfurl: 'ok' };

  it('shows the title and the site once the preview is in, and the address and domain before', () => {
    expect(linkView(ok)).toMatchObject({ heading: 'A title', siteName: 'Example', domain: 'example.com', state: 'ok' });
    expect(linkView({ url: ok.url, unfurl: 'pending' })).toMatchObject({ heading: 'https://www.example.com/a', siteName: 'example.com', title: '', state: 'pending' });
    expect(linkView({ url: ok.url, unfurl: 'ok' })).toMatchObject({ heading: 'https://www.example.com/a', siteName: 'example.com' });
    expect(linkView({ url: ok.url }).state).toBe('pending');
  });

  it('survives an object that holds anything', () => {
    const v = linkView({ url: 42, title: { x: 1 }, unfurl: 'weird', finalUrl: 'javascript:1' });
    expect([v.url, v.state, v.title, v.finalUrl]).toEqual(['', 'pending', '', '']);
    expect(linkView({ url: 'javascript:alert(1)' }).url).toBe('');
  });

  it('words the accessible name and the tooltip', () => {
    expect(linkLabel(ok)).toBe('Link card: A title, example.com. Press Enter to open.');
    expect(linkLabel({ url: ok.url, unfurl: 'pending' })).toBe('Link card: https://www.example.com/a, example.com, loading preview. Press Enter to open.');
    expect(linkLabel({ url: ok.url, unfurl: 'failed', unfurlError: 'timeout' })).toBe('Link card: https://www.example.com/a, example.com, no preview. Press Enter to open.');
    expect(linkTooltip({ ...ok, finalUrl: 'https://example.com/b' })).toBe('https://www.example.com/a\nRedirects to https://example.com/b');
    expect(linkTooltip({ url: ok.url, unfurl: 'failed', unfurlError: 'timeout' })).toBe('https://www.example.com/a\nThe site did not answer in time.');
  });
});

describe('opening', () => {
  it('opens an http(s) address in a new tab without opener or referrer, and nothing else', () => {
    const open = vi.fn<(url: string, target: string, features: string) => unknown>();
    expect(openLink('https://example.com/x', open)).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', '', 7, null]) expect(openLink(bad, open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('card colours in the five themes', () => {
  it.each(THEMES.map((t) => [t.name, t.vars] as const))('%s: title, description and the selection outline read', (_name, vars) => {
    const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    expect(ratio(vars['--ink'], vars['--paper'])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(vars['--graphite'], vars['--paper'])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(vars['--selection-handle-stroke'], vars['--canvas'])).toBeGreaterThanOrEqual(3);
    expect(ratio(vars['--selection-handle-stroke'], vars['--paper'])).toBeGreaterThanOrEqual(3);
    expect(ratio(vars['--ink'], vars['--canvas'])).toBeGreaterThanOrEqual(3);
  });
});

describe('the Markdown summary', () => {
  const esc = (t: string) => t.replace(/[\\`*_[\]<>|~&]/g, '\\$&');
  it('is [Title](address), or the address alone, with the title escaped and the address safe in a link', () => {
    expect(markdownLink({ url: 'https://example.com/a', title: 'A *page* [x]', unfurl: 'ok' }, esc)).toBe('[A \\*page\\* \\[x\\]](https://example.com/a)');
    expect(markdownLink({ url: 'https://example.com/a', unfurl: 'ok' }, esc)).toBe('https://example.com/a');
    expect(markdownLink({ url: 'https://example.com/a', title: 'Not yet', unfurl: 'pending' }, esc)).toBe('https://example.com/a');
    expect(markdownLink({ url: 'https://example.com/a_(b)[c]', title: 'T', unfurl: 'ok' }, esc)).toBe('[T](https://example.com/a_%28b%29%5Bc%5D)');
    expect(markdownLink({ url: 'javascript:alert(1)', title: 'T', unfurl: 'ok' }, esc)).toBe('');
  });
});
