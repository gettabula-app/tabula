import { describe, expect, it } from 'vitest';
import {
  findForbiddenPageText,
  findLegalPlaceholders,
  inspectEducationOffer,
  inspectFlatPricing,
  parseRobotsTxt,
  parseSitemapXml,
  requestFollowingRedirects,
  resolveInternalResources,
} from '../scripts/lib/prelaunch-smoke.mjs';

describe('pre-launch smoke pure checks', () => {
  it('finds forbidden public-page text and legal draft markers', () => {
    expect(findForbiddenPageText('localhost 127.0.0.1 example.com TODO')).toEqual(['localhost', '127.0.0.1', 'example.com', 'TODO']);
    expect(findForbiddenPageText('A clean launch page')).toEqual([]);
    expect(findLegalPlaceholders('TODO, lorem ipsum, [CONTACT], XXX')).toEqual(['TODO', 'lorem', '[', 'XXX']);
  });

  it('parses sitemap locations and robots directives', () => {
    expect(parseSitemapXml('<urlset><url><loc>https://gettabula.app/a?x=1&amp;y=2</loc></url></urlset>', 'https://gettabula.app/sitemap.xml'))
      .toEqual(['https://gettabula.app/a?x=1&y=2']);
    expect(parseRobotsTxt('User-agent: *\nAllow: /\nSitemap: https://gettabula.app/sitemap.xml'))
      .toEqual({ sitemapUrls: ['https://gettabula.app/sitemap.xml'], allowsRoot: true });
    expect(() => parseSitemapXml('<html>not XML sitemap</html>', 'https://gettabula.app/sitemap.xml')).toThrow(/not a sitemap/);
  });

  it('resolves same-origin links and images only', () => {
    expect(resolveInternalResources({
      links: ['/docs#one', 'https://gettabula.app/signup', 'https://github.com/tabula', 'mailto:team@gettabula.app', '#section'],
      images: ['/og.png', 'https://cdn.example.net/image.png'],
    }, 'https://gettabula.app/')).toEqual({
      links: ['https://gettabula.app/docs', 'https://gettabula.app/signup'],
      images: ['https://gettabula.app/og.png'],
    });
  });

  it('checks the flat plan and education offer wording', () => {
    expect(inspectFlatPricing('€29 per workspace per month or €290 per year. Founding €19/month for 12 months before 31 December 2026.'))
      .toMatchObject({ monthly: true, yearly: true, founding: true, flat: true });
    expect(inspectFlatPricing('€29 monthly or €290 yearly; founding €19 for 12 months before 31 Dec 2026.').founding).toBe(true);
    expect(inspectFlatPricing('€290 yearly and €19 for 12 months before 31 December 2026. €29 per person per month.').flat).toBe(false);
    expect(inspectEducationOffer('Half price. Start the 7-day trial, write to us, and we apply the discount before your first payment.'))
      .toEqual({ halfPrice: true, trialApplication: true });
  });

  it('follows fixture redirects and detects bad status, loops and fetch errors', async () => {
    const fixtureFetch = async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const { pathname } = new URL(rawUrl);
      if (pathname === '/redirect') return new Response(null, { status: 302, headers: { location: '/good' } });
      if (pathname === '/loop-a') return new Response(null, { status: 302, headers: { location: '/loop-b' } });
      if (pathname === '/loop-b') return new Response(null, { status: 302, headers: { location: '/loop-a' } });
      if (pathname === '/bad') return new Response('unavailable', { status: 503 });
      return new Response('<title>Fixture</title><p>Ready</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const baseUrl = 'http://smoke-fixture.test';
    const good = await requestFollowingRedirects(`${baseUrl}/redirect`, { fetchImpl: fixtureFetch });
    expect(good.response?.status).toBe(200);
    expect(good.redirects).toHaveLength(1);
    expect(await good.response?.text()).toContain('Fixture');

    const bad = await requestFollowingRedirects(`${baseUrl}/bad`, { fetchImpl: fixtureFetch });
    expect(bad.response?.status).toBe(503);

    const loop = await requestFollowingRedirects(`${baseUrl}/loop-a`, { fetchImpl: fixtureFetch });
    expect(loop.loop).toBe(true);
    expect(loop.error).toMatch(/redirect loop/);

    const failed = await requestFollowingRedirects(`${baseUrl}/unreachable`, { fetchImpl: async () => { throw new Error('fixture network error', { cause: new Error('connection refused') }); } });
    expect(failed.error).toBe('fixture network error; cause=connection refused');
  });
});
